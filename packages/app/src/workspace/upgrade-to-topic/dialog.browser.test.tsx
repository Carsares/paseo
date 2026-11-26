import { within } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  WorkspaceHeaderMenuDesktop,
  WorkspaceHeaderMenuMobile,
  type WorkspaceHeaderMenuMobileProps,
} from "@/screens/workspace/workspace-header-menu";
import { WorkspaceTopicUpgradeDialog } from "./dialog";
import type { TopicUpgradeClient, WorkspaceTopic } from "./model";

vi.mock("@/plugins", () => ({ usePluginWorkspaceMenu: () => ({ pages: [], rows: [] }) }));
vi.mock("@/hooks/use-daemon-config", () => ({ useDaemonConfig: () => ({ config: null }) }));
vi.mock("@/hooks/use-active-workspace-archive", () => ({
  useActiveWorkspaceArchive: () => ({ canArchive: false, archive: () => false }),
}));
vi.mock("expo-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("expo-router")>()),
  useRouter: () => ({ push: vi.fn() }),
}));

const workspaceId = "archived-tabs-workspace";
const noop = () => undefined;
const emptyScripts: WorkspaceHeaderMenuMobileProps["scripts"] = {
  actions: {
    start: noop,
    stop: noop,
    restart: noop,
    copyUrl: noop,
    selectRoute: noop,
    resolveLinks: () => ({ selected: null, targets: [] }),
    isStartPending: false,
    isStopPending: false,
  },
  scripts: [],
  liveTerminalIds: [],
  onViewTerminal: noop,
  onOpenUrlInBrowserTab: noop,
};
const topic: WorkspaceTopic = {
  mainAgentId: "second",
  summary: null,
  hideFromModel: false,
  revision: 1,
};

test("opens from the workspace menu and shows host update and reconnect states", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  const updateWorkspaceTopic = vi.fn();
  const client = {
    ...createClient(updateWorkspaceTopic),
    getLastServerInfoMessage: () => ({ features: {} }),
  } as TopicUpgradeClient;
  function Harness({ connected }: { connected: boolean }) {
    const [open, setOpen] = useState(false);
    const openUpgrade = useCallback(() => setOpen(true), []);
    const closeUpgrade = useCallback(() => setOpen(false), []);
    return (
      <>
        <WorkspaceHeaderMenuDesktop
          currentBranchName="main"
          showWorkspaceSetup={false}
          importAgentDisabled={false}
          copyPathDisabled={false}
          onOpenImportSheet={noop}
          onCopyWorkspacePath={noop}
          onCopyBranchName={noop}
          onOpenSetupTab={noop}
          onUpgradeToTopic={openUpgrade}
        />
        {open && (
          <WorkspaceTopicUpgradeDialog
            client={connected ? client : null}
            workspaceId={workspaceId}
            onClose={closeUpgrade}
            onUpgraded={noop}
          />
        )}
      </>
    );
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient();
  const view = within(document.body);
  try {
    const render = (connected: boolean) =>
      act(async () =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <Harness connected={connected} />
          </QueryClientProvider>,
        ),
      );
    await render(true);
    await act(async () => view.getByRole("button", { name: "Workspace actions" }).click());
    const upgrade = await view.findByRole("menuitem", { name: "Upgrade to topic" });
    await act(async () => upgrade.click());
    expect(view.getByText("Update the host to upgrade this workspace.")).toBeTruthy();

    await render(false);
    expect(view.getByText("Reconnect to the host to upgrade this workspace.")).toBeTruthy();
    expect(updateWorkspaceTopic).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

test("selects the translated upgrade action from the mobile workspace menu", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("zh-CN");
  const onUpgradeToTopic = vi.fn();
  const queryClient = new QueryClient();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const view = within(document.body);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <WorkspaceHeaderMenuMobile
            normalizedServerId="test-host"
            normalizedWorkspaceId={workspaceId}
            scripts={emptyScripts}
            currentBranchName="main"
            showWorkspaceSetup={false}
            importAgentDisabled={false}
            copyPathDisabled={false}
            showCreateBrowserTab={false}
            createTerminalDisabled
            onCreateTerminalWithProfile={noop}
            onCreateBrowser={noop}
            onOpenImportSheet={noop}
            onCopyWorkspacePath={noop}
            onCopyBranchName={noop}
            onOpenSetupTab={noop}
            onUpgradeToTopic={onUpgradeToTopic}
          />
        </QueryClientProvider>,
      ),
    );
    await act(async () => view.getByTestId("workspace-header-menu-trigger").click());
    const upgrade = await view.findByRole("menuitem", { name: "升级为专题" });
    await act(async () => upgrade.click());
    expect(onUpgradeToTopic).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
    vi.unstubAllGlobals();
  }
});

test("lets the user explicitly select one session and retry a rejected upgrade", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  const updateWorkspaceTopic = vi
    .fn()
    .mockResolvedValueOnce({ error: "Workspace is busy", topic: null })
    .mockResolvedValueOnce({ error: null, topic });
  const client = createClient(updateWorkspaceTopic);
  const onClose = vi.fn();
  const onUpgraded = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const view = within(document.body);
  try {
    await act(async () =>
      root.render(
        <WorkspaceTopicUpgradeDialog
          client={client}
          workspaceId={workspaceId}
          onClose={onClose}
          onUpgraded={onUpgraded}
        />,
      ),
    );
    const confirm = view.getByRole("button", { name: "Upgrade workspace" });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(updateWorkspaceTopic).not.toHaveBeenCalled();

    const pick = view.getByRole("radio", { name: /Startup trace/ });
    act(() => pick.click());
    expect(pick.getAttribute("aria-checked")).toBe("true");
    await act(async () => confirm.click());
    expect(view.getByText("Workspace is busy")).toBeTruthy();
    expect(onUpgraded).not.toHaveBeenCalled();
    expect(view.getByRole("radio", { name: /Startup trace/ }).getAttribute("aria-checked")).toBe(
      "true",
    );

    await act(async () => view.getByRole("button", { name: "Upgrade workspace" }).click());
    expect(updateWorkspaceTopic).toHaveBeenLastCalledWith({
      workspaceId,
      mainAgentId: "second",
      upgradeToTopic: true,
    });
    expect(onUpgraded).toHaveBeenCalledExactlyOnceWith(topic);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

function createClient(
  updateWorkspaceTopic: TopicUpgradeClient["updateWorkspaceTopic"],
): TopicUpgradeClient {
  return {
    getLastServerInfoMessage: () => ({
      features: { topicWorkbenchV1: true },
      permissions: ["workspace.read", "workspace.manage"],
    }),
    findWorkspace: async () => ({ id: workspaceId }),
    fetchAgentHistory: async () => ({
      entries: [
        { id: "first", title: "Earlier analysis" },
        { id: "second", title: "Startup trace" },
      ].map((agent) => ({
        agent: {
          ...agent,
          workspaceId,
          provider: "codex",
          createdAt: "2026-11-24T00:00:00.000Z",
          labels: {},
        },
      })),
      pageInfo: { nextCursor: null },
    }),
    updateWorkspaceTopic,
  } as unknown as TopicUpgradeClient;
}
