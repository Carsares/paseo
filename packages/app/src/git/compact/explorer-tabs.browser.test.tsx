import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import { ToastApiProvider } from "@/contexts/toast-context";
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import { i18n } from "@/i18n/i18next";
import { StagingPanel } from "@/panels/changes/staging-panel";
import { PaneProvider, type PaneContextValue } from "@/panels/pane-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import { FOCUSED_PANE_PLACEMENT, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { CompactGitExplorerTabs, type CompactGitExplorerView } from "./explorer-tabs";

vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  // The Vitest Unistyles double reports no breakpoint to hooks.
  useIsCompactFormFactor: () => window.innerWidth < 600,
}));

vi.mock("lucide-react-native", async (importOriginal) => {
  const icons = await importOriginal<typeof import("lucide-react-native")>();
  const icon = icons.FileText;
  return {
    ...icons,
    AlignJustify: icon,
    CopyPlus: icon,
    Diff: icon,
    FilePlus: icon,
    FileWarning: icon,
    FolderMinus: icon,
    ListChevronsDownUp: icon,
    ListChevronsUpDown: icon,
    Minus: icon,
    Pilcrow: icon,
    Send: icon,
    SquareDot: icon,
    SquareMinus: icon,
    SquarePlus: icon,
    WrapText: icon,
  };
});

void i18n;

it("selects each Explorer view through a 44pt touch target", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  function Explorer() {
    const [view, setView] = useState<CompactGitExplorerView>("changes");
    return <CompactGitExplorerTabs value={view} onChange={setView} />;
  }
  try {
    await act(async () => root.render(<Explorer />));
    let previous = page.getByTestId("compact-git-changes");
    await expect.element(previous).toHaveAttribute("aria-selected", "true");
    for (const id of ["history", "stash", "changes"] as const) {
      const tab = page.getByTestId(`compact-git-${id}`);
      expect(tab.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      await act(async () => tab.click());
      await expect.element(tab).toHaveAttribute("aria-selected", "true");
      await expect.element(previous).toHaveAttribute("aria-selected", "false");
      previous = tab;
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

const serverId = "compact-explorer-test";
const workspaceId = "worktree";
const workspaceKey = `${serverId}:${workspaceId}`;
const cwd = "/worktree";
const noop = () => {};
const insets = { top: 0, bottom: 0, left: 0, right: 0 };
const toast = { show: () => noop, error: noop, copied: noop };

function mountCompactStaging() {
  vi.stubGlobal("React", React);
  const methods: Partial<DaemonClient> = {
    checkoutGitWorkingTreeGet: async () => ({
      requestId: "tree",
      cwd,
      error: null,
      workingTree: {
        repoRoot: cwd,
        headSha: "abc",
        currentBranch: "topic",
        operationState: "idle",
        staged: [],
        unstaged: [{ path: "changed.txt", status: "modified" }],
        untracked: [],
        conflicts: [],
        activeAgents: [],
      },
    }),
    checkoutGitStashList: async () => ({
      requestId: "stash",
      cwd,
      repoRoot: cwd,
      error: null,
      entries: [],
    }),
    checkoutGitRefsList: async () => ({
      requestId: "refs",
      cwd,
      error: null,
      refs: [{ repoRoot: cwd, localBranches: [], remotes: [], tags: [], backups: [] }],
    }),
  };
  const client = methods as DaemonClient;
  const sessions = useSessionStore.getState().sessions;
  const initialPanel = usePanelStore.getState();
  const layout = useWorkspaceLayoutStore.getState();
  const host = vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockReturnValue({
    serverId,
    client,
    connectionStatus: "online",
    activeConnectionId: null,
    activeConnection: null,
    lastError: null,
    lastOnlineAt: null,
    agentDirectoryStatus: "ready",
    agentDirectoryError: null,
    hasEverLoadedAgentDirectory: true,
    probeByConnectionId: new Map(),
    clientGeneration: 0,
    connectionEpoch: 0,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient();
  onTestFinished(async () => {
    await act(async () => root.unmount());
    container.remove();
    queryClient.clear();
    host.mockRestore();
    useSessionStore.setState({ sessions });
    useWorkspaceLayoutStore.setState(layout, true);
    usePanelStore.setState(initialPanel, true);
    vi.unstubAllGlobals();
  });
  useSessionStore.getState().initializeSession(serverId, client);
  setGraphCapability(true);
  layout.setLayoutMode("compact");
  const target = { kind: "changes_tree" } as const;
  layout.showExplorerSidebar(workspaceKey);
  const tabId = layout.openTab({ workspaceKey, target, intent: "reveal" });
  if (!tabId) throw new Error("Could not open Explorer Changes");
  usePanelStore.getState().showMobileFileExplorer();
  const openTab = (nextTarget: WorkspaceTabTarget) => {
    const opened = layout.openTab({
      workspaceKey,
      target: nextTarget,
      intent: "reveal",
      parentTabId: tabId,
      placement: FOCUSED_PANE_PLACEMENT,
    });
    revealWorkspaceTab(workspaceKey, opened);
  };
  const pane: PaneContextValue = {
    serverId,
    workspaceId,
    host: "explorer",
    tabId,
    target,
    openTab,
    openPreferredTarget: noop,
    closeCurrentTab: noop,
    retargetCurrentTab: noop,
    setCurrentTabState: noop,
    openFileInWorkspace: noop,
    openImportSheet: noop,
  };
  return act(async () => root.render(stagingView(queryClient, pane)));
}

function stagingView(queryClient: QueryClient, pane: PaneContextValue) {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastApiProvider api={toast}>
        <SafeAreaInsetsContext.Provider value={insets}>
          <DiffDocumentWorkspaceCacheProvider>
            <PaneProvider value={pane}>
              <StagingPanel
                serverId={serverId}
                workspaceId={workspaceId}
                cwd={cwd}
                active
                onOpenComparison={noop}
              />
            </PaneProvider>
          </DiffDocumentWorkspaceCacheProvider>
        </SafeAreaInsetsContext.Provider>
      </ToastApiProvider>
    </QueryClientProvider>
  );
}

function setGraphCapability(enabled: boolean) {
  useSessionStore.getState().updateSessionServerInfo(serverId, {
    serverId,
    hostname: null,
    version: null,
    features: { checkoutGitP2V1: true, checkoutGitGraphV1: enabled },
  });
}

function historyTabs() {
  return useWorkspaceLayoutStore
    .getState()
    .getWorkspaceTabs(workspaceKey)
    .filter((tab) => tab.target.kind === "git_graph");
}

it("opens the main history singleton from the real staging toolbar and returns Explorer to Changes or Stash", async () => {
  await page.viewport(390, 720);
  await mountCompactStaging();
  const changes = page.getByTestId("compact-git-changes");
  const history = page.getByTestId("compact-git-history");
  const stash = page.getByTestId("compact-git-stash");
  const localTags = page.getByRole("button", { name: "Local tags", exact: true });
  const changedFile = page.getByRole("button", { name: "changed.txt", exact: true });
  await expect.element(changes).toHaveAttribute("aria-selected", "true");
  await expect.element(changedFile).toBeVisible();
  await expect.element(page.getByTestId("git-force-push")).toBeVisible();
  await stash.click();
  await expect.element(stash).toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByText("No stashes", { exact: true })).toBeVisible();
  await localTags.click();
  await expect.element(stash).toHaveAttribute("aria-selected", "false");
  await expect.element(page.getByRole("button", { name: "Create tag", exact: true })).toBeVisible();
  await changes.click();
  await expect.element(changedFile).toBeVisible();
  await stash.click();
  expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
  await history.click();
  const [graph] = historyTabs();
  expect(
    useWorkspaceLayoutStore.getState().getTabDestination(workspaceKey, graph!.tabId),
  ).toMatchObject({ kind: "pane", host: "main" });
  expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
  usePanelStore.getState().showMobileFileExplorer();
  await expect.element(stash).toHaveAttribute("aria-selected", "true");
  await history.click();
  expect(historyTabs().map((tab) => tab.tabId)).toEqual([graph!.tabId]);
  expect(usePanelStore.getState().mobilePanel.target).toBe("agent");

  usePanelStore.getState().showMobileFileExplorer();
  await act(async () => setGraphCapability(false));
  await expect.element(history).toBeDisabled();
  await expect.element(localTags).not.toBeInTheDocument();
  await expect.element(page.getByTestId("git-force-push")).toBeVisible();
  expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
});
