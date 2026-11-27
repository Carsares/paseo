import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { i18n } from "@/i18n/i18next";
import { useSessionStore } from "@/stores/session-store";
import { AddProjectFlow } from "./add-project-flow";

const { hosts, clients } = vi.hoisted(() => ({
  hosts: [
    { serverId: "first", label: "First host" },
    { serverId: "second", label: "Second host" },
  ],
  clients: new Map<string, Pick<DaemonClient, "addProject" | "getDirectorySuggestions">>(),
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({}),
  useHosts: () => hosts,
  useHostRuntimeClient: (id: string) => clients.get(id) ?? null,
  useHostRuntimeIsConnected: (id: string) => clients.has(id),
  useHostRuntimeConnectionStatuses: () => connectionStatuses,
}));
vi.mock("@/hooks/use-is-local-daemon", () => ({
  useLocalDaemonServerId: () => null,
  useIsLocalDaemon: () => false,
}));
vi.mock("@/hosts/add-host", () => ({ useAddHost: () => () => {} }));

const connectionStatuses = new Map(hosts.map(({ serverId }) => [serverId, "online"]));
const queryClient = new QueryClient();
const flowRequest = { id: 1 };
const onClose = () => {};
const input = page.getByTestId("add-project-flow-input");
const queryError = page.getByTestId("add-project-flow-query-error");
let unmount: (() => void) | undefined;

function suggestions(error: string | null = null, path?: string) {
  return {
    requestId: "test",
    directories: path ? [path] : [],
    entries: path ? [{ kind: "directory" as const, path }] : [],
    error,
  };
}

function stubClient(id: string) {
  const client = {
    addProject: vi.fn<DaemonClient["addProject"]>(),
    getDirectorySuggestions: vi
      .fn<DaemonClient["getDirectorySuggestions"]>()
      .mockResolvedValue(suggestions()),
  };
  clients.set(id, client);
  return client;
}

beforeEach(async () => {
  vi.stubGlobal("React", React);
  const store = useSessionStore.getState();
  for (const { serverId } of hosts) {
    store.initializeSession(serverId, null);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: null,
      features: { projectAdd: true, stableProjectIdentity: true },
    });
  }
  await i18n.changeLanguage("zh-CN");
});

afterEach(async () => {
  unmount?.();
  unmount = undefined;
  queryClient.clear();
  clients.clear();
  useSessionStore.setState({ sessions: {} });
  await i18n.changeLanguage("en");
  vi.unstubAllGlobals();
});

function mount() {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AddProjectFlow request={flowRequest} onClose={onClose} />
      </QueryClientProvider>,
    );
  });
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
}

async function openSearch(host: string) {
  await page.getByTestId(`add-project-flow-host-${host}`).click();
  await page.getByTestId("add-project-flow-method-directory-search").click();
}

it("keeps the daemon's resolved path in project-add errors and translates missing messages", async () => {
  const first = stubClient("first");
  stubClient("second");
  first.addProject
    .mockResolvedValueOnce({
      requestId: "test",
      project: null,
      error: "Access denied: /dev/project",
    })
    .mockResolvedValueOnce({
      requestId: "test",
      project: null,
      errorCode: "directory_not_found",
      error: "Directory not found: /home/remote-user/project",
    })
    .mockResolvedValueOnce({
      requestId: "test",
      project: null,
      errorCode: "directory_not_found",
      error: null,
    })
    .mockResolvedValueOnce({ requestId: "test", project: null, error: null });
  mount();
  await openSearch("first");
  await input.fill("~/project");
  const pathRow = page.getByText("打开此路径", { exact: true });
  const error = page.getByTestId("add-project-flow-error");
  await pathRow.click();
  await expect.element(error).toHaveTextContent(/^Access denied: \/dev\/project$/);
  await pathRow.click();
  await expect
    .element(error)
    .toHaveTextContent(/^Directory not found: \/home\/remote-user\/project$/);
  await pathRow.click();
  await expect.element(error).toHaveTextContent("找不到目录。");
  await pathRow.click();
  await expect.element(error).toHaveTextContent("无法添加项目");
  expect(first.addProject).toHaveBeenCalledWith("~/project");
});

it("opens an explicit path by click or Enter after directory suggestions fail", async () => {
  const first = stubClient("first");
  stubClient("second");
  first.getDirectorySuggestions.mockImplementation(({ query }) =>
    Promise.resolve(query ? suggestions("Directory suggestions are unavailable") : suggestions()),
  );
  first.addProject.mockResolvedValue({ requestId: "test", project: null, error: "Open failed" });
  mount();
  await openSearch("first");

  const pathRow = page.getByText("打开此路径", { exact: true });
  const retry = page.getByRole("button", { name: "重试" });
  await input.fill("/dev/project");
  await expect.element(queryError).toHaveTextContent("Directory suggestions are unavailable");
  await expect.element(pathRow).toBeVisible();
  await pathRow.click();
  await expect.poll(() => first.addProject.mock.lastCall?.[0]).toBe("/dev/project");

  await input.fill("~/project");
  await expect.element(queryError).toHaveTextContent("Directory suggestions are unavailable");
  await expect.element(pathRow).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => first.addProject.mock.lastCall?.[0]).toBe("~/project");

  await expect.element(retry).toBeVisible();
  (retry.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(
      () =>
        first.getDirectorySuggestions.mock.calls.filter(
          ([request]) => request.query === "~/project",
        ).length,
    )
    .toBe(2);
  expect(first.addProject).toHaveBeenCalledTimes(2);
});

it("shows directory response errors, hides stale errors, and retries the same query", async () => {
  const first = stubClient("first");
  const second = stubClient("second");
  const pending =
    Promise.withResolvers<Awaited<ReturnType<DaemonClient["getDirectorySuggestions"]>>>();
  first.getDirectorySuggestions.mockImplementation(({ query }) => {
    if (query === "old") return Promise.resolve(suggestions("Old query was denied"));
    if (query === "new") return pending.promise;
    return Promise.resolve(suggestions());
  });
  let failSecondSearch = true;
  second.getDirectorySuggestions.mockImplementation(({ query }) => {
    if (query !== "recovered") return Promise.resolve(suggestions());
    if (!failSecondSearch) return Promise.resolve(suggestions(null, "/second/recovered"));
    failSecondSearch = false;
    return Promise.resolve(suggestions(""));
  });
  mount();
  await openSearch("first");
  await input.fill("old");
  await expect.element(queryError).toHaveTextContent("Old query was denied");
  await input.fill("new");
  await expect.element(queryError).not.toBeInTheDocument();
  await expect.poll(() => first.getDirectorySuggestions.mock.lastCall?.[0].query).toBe("new");
  const back = page.getByTestId("add-project-flow-back");
  // The icon stub has no layout, so activate the actual back button directly.
  act(() => (back.element() as HTMLButtonElement).click());
  act(() => (back.element() as HTMLButtonElement).click());
  await openSearch("second");
  await input.fill("recovered");
  await expect.element(queryError).toHaveTextContent("无法搜索目录");
  pending.resolve(suggestions("First host returned late"));
  await expect
    .poll(() => queryClient.getQueryState(["add-project-flow-directories", "first", "new"])?.status)
    .toBe("error");
  await expect.element(queryError).toHaveTextContent("无法搜索目录");
  await page.getByRole("button", { name: "重试" }).click();
  await expect.element(page.getByText("/second/recovered", { exact: true })).toBeVisible();
  await expect.element(queryError).not.toBeInTheDocument();
  expect(
    second.getDirectorySuggestions.mock.calls.filter(([request]) => request.query === "recovered"),
  ).toHaveLength(2);
});
