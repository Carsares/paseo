import type { WorkspaceTaskSummary } from "@getpaseo/protocol/messages";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { i18n } from "@/i18n/i18next";
import { WorkspaceTaskLedger } from "./index";

const hosts = vi.hoisted(() => ({
  capabilities: new Set<string>(),
  clients: new Map<
    string,
    { listWorkspaceTasks: (workspaceId: string) => Promise<WorkspaceTaskSummary[]> }
  >(),
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (serverId: string, name: string) =>
    name === "workspaceTaskLedger" && hosts.capabilities.has(serverId),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: (serverId: string) => hosts.clients.get(serverId) ?? null,
  useHostRuntimeIsConnected: (serverId: string) => hosts.clients.has(serverId),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: () => 1,
}));

const task = (title: string): WorkspaceTaskSummary => ({
  taskId: title,
  title,
  status: "awaiting_decision",
  tier: "T2",
  participants: [],
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
});

function mount() {
  vi.stubGlobal("React", React);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const query = new QueryClient();
  onTestFinished(async () => {
    await act(async () => root.unmount());
    container.remove();
    query.clear();
    hosts.capabilities.clear();
    hosts.clients.clear();
    vi.unstubAllGlobals();
    await i18n.changeLanguage("en");
  });
  return async (serverId: string, workspaceId: string, active = true) => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={query}>
          <RetainedPanelActivity active={active}>
            <WorkspaceTaskLedger serverId={serverId} workspaceId={workspaceId} />
          </RetainedPanelActivity>
        </QueryClientProvider>,
      ),
    );
  };
}

const trigger = () => page.getByTestId("workspace-task-ledger");

describe("workspace task ledger", () => {
  it("waits for host support and an active panel before fetching", async () => {
    const render = mount();
    const listWorkspaceTasks = vi.fn(async () => []);
    hosts.clients.set("host", { listWorkspaceTasks });

    await render("host", "workspace");
    await expect.element(trigger()).not.toBeInTheDocument();
    expect(listWorkspaceTasks).not.toHaveBeenCalled();

    hosts.capabilities.add("host");
    await render("host", "workspace", false);
    expect(listWorkspaceTasks).not.toHaveBeenCalled();

    await render("host", "workspace");
    await expect.element(trigger()).toHaveTextContent("Workspace tasks · 0");
    await trigger().click();
    await expect.element(page.getByText("No workspace tasks yet")).toBeVisible();
    expect(listWorkspaceTasks).toHaveBeenCalledExactlyOnceWith("workspace");
  });

  it("isolates cached and pending ledger results across host and workspace changes", async () => {
    const render = mount();
    const pending = Promise.withResolvers<WorkspaceTaskSummary[]>();
    const listFirst = vi
      .fn<(workspaceId: string) => Promise<WorkspaceTaskSummary[]>>()
      .mockResolvedValueOnce([task("Alpha task")])
      .mockReturnValueOnce(pending.promise);
    const listSecond = vi.fn(async () => [task("Gamma task"), task("Another task")]);
    hosts.capabilities.add("first");
    hosts.capabilities.add("second");
    hosts.clients.set("first", { listWorkspaceTasks: listFirst });
    hosts.clients.set("second", { listWorkspaceTasks: listSecond });

    await render("first", "alpha");
    await expect.element(trigger()).toHaveTextContent("Workspace tasks · 1");
    await trigger().click();
    await expect.element(page.getByText("Alpha task")).toBeVisible();

    await render("first", "beta");
    await expect.element(trigger()).toHaveTextContent(/^Workspace tasks$/);
    await expect.element(page.getByText("Alpha task")).not.toBeInTheDocument();
    expect(listFirst).toHaveBeenNthCalledWith(2, "beta");

    await render("second", "beta");
    await expect.element(trigger()).toHaveTextContent("Workspace tasks · 2");
    await act(async () => pending.resolve([task("Late task")]));
    await trigger().click();
    await expect.element(page.getByText("Gamma task")).toBeVisible();
    await expect.element(page.getByText("Late task")).not.toBeInTheDocument();
    expect(listSecond).toHaveBeenCalledExactlyOnceWith("beta");
  });

  it("shows an explicit completion report ahead of older cross-host session state", async () => {
    const render = mount();
    const sharedAgentId = "shared-agent-id";
    const listWorkspaceTasks = vi.fn(
      async (): Promise<WorkspaceTaskSummary[]> => [
        {
          ...task("Cross-host task"),
          participants: [
            { agentId: sharedAgentId, serverId: "host" },
            { agentId: sharedAgentId, serverId: "another-host" },
          ],
          latestProgress: {
            agentId: sharedAgentId,
            kind: "reported_completed",
            at: "2026-11-24T00:01:00.000Z",
          },
          recentAgentStates: [
            {
              agentId: sharedAgentId,
              kind: "dispatched",
              at: "2026-11-24T00:00:00.000Z",
              lifecycle: "running",
            },
          ],
        },
        task("Task without progress"),
        {
          ...task("Task with a new event kind"),
          latestProgress: {
            agentId: "new-agent",
            kind: "future_kind",
            at: "2026-11-24T00:00:00.000Z",
          },
        },
      ],
    );
    hosts.capabilities.add("host");
    hosts.clients.set("host", { listWorkspaceTasks });

    await render("host", "workspace");
    await expect.element(trigger()).toHaveTextContent("Workspace tasks · 3");
    await trigger().click();
    const panel = page.getByTestId("workspace-task-ledger-panel");
    await expect
      .element(panel.getByText("Awaiting decision · T2 · Bound subagent sessions: 2"))
      .toBeVisible();
    await expect.element(panel.getByText("Recent progress: Completion reported")).toBeVisible();
    await expect.element(panel.getByText("Recent progress: Status updated")).toBeVisible();
    await expect.poll(() => panel.getByText(/^Recent progress:/).elements().length).toBe(2);
    await expect.element(panel.getByText("Task without progress")).toBeVisible();
    await expect
      .element(panel)
      .not.toHaveTextContent(/shared-agent-id|another-host|Work dispatched/);
  });

  it("retries a failed load in the open panel and localizes task details", async () => {
    const render = mount();
    const listWorkspaceTasks = vi
      .fn<(workspaceId: string) => Promise<WorkspaceTaskSummary[]>>()
      .mockRejectedValueOnce(new Error("ledger unavailable"))
      .mockResolvedValueOnce([
        {
          ...task("联调任务"),
          participants: [{ agentId: "reviewer" }],
          latestProgress: {
            agentId: "reviewer",
            kind: "reported_blocked",
            at: "2026-11-24T00:01:00.000Z",
          },
          recentAgentStates: [
            {
              agentId: "reviewer",
              kind: "dispatched",
              at: "2026-11-24T00:00:00.000Z",
              lifecycle: "running",
            },
          ],
          verificationState: "blocked",
          blockingQuestion: "在哪个环境验证？",
          handoffSummary: "接口已就绪",
        },
      ]);
    hosts.capabilities.add("host");
    hosts.clients.set("host", { listWorkspaceTasks });
    await i18n.changeLanguage("zh-CN");

    await render("host", "workspace");
    await trigger().click();
    await expect.element(page.getByText("无法加载工作区任务")).toBeVisible();
    await page.getByRole("menuitem", { name: "重试" }).click();
    await expect.element(page.getByText("联调任务")).toBeVisible();
    await expect.element(page.getByText("待决定 · T2 · 已绑定子会话：1")).toBeVisible();
    await expect.element(page.getByText("近期进度：已报告受阻")).toBeVisible();
    await expect.element(page.getByText("验证：受阻")).toBeVisible();
    await expect.element(page.getByText("待决定：在哪个环境验证？")).toBeVisible();
    await expect.element(page.getByText("接口已就绪")).toBeVisible();
    expect(listWorkspaceTasks).toHaveBeenCalledTimes(2);
  });
});
