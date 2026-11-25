import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ToastApiProvider } from "@/contexts/toast-context";
import { MessageRewindMenu } from "@/components/rewind/message-rewind-menu";
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import { i18n } from "@/i18n/i18next";
import { changesTreePanelRegistration } from "@/panels/diff-panel";
import { PaneProvider, type PaneContextValue } from "@/panels/pane-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { usePanelStore } from "@/stores/panel-store";
import { type Agent, useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { ChangesSurface } from "./diff-pane";
import { checkoutDiffQueryKey, checkoutStatusQueryKey } from "./query-keys";
import {
  resetWorkingDiffComparisons,
  selectCheckpointDiff,
  selectWorkingDiffComparison,
} from "./working-diff-comparison";

vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
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

test.each([true, false])(
  "compact message menu opens checkpoint Changes (staging supported: %s)",
  async (staging) => {
    await page.viewport(390, 720);
    const { serverId, workspaceId, cwd } = scope;
    const workspaceKey = `${serverId}:${workspaceId}`;
    const client = createCompactCheckpointClient(serverId, cwd);
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
    const panel = usePanelStore.getState();
    const layout = useWorkspaceLayoutStore.getState();
    layout.setLayoutMode("compact");
    useSessionStore.getState().initializeSession(serverId, client);
    useSessionStore.getState().updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: null,
      features: { rewindCheckpoints: true, checkoutGitStagingV1: staging },
    });
    useSessionStore.getState().setWorkspaces(
      serverId,
      new Map([
        [
          workspaceId,
          {
            id: workspaceId,
            workspaceDirectory: cwd,
            name: workspaceId,
            projectId: "project",
            projectDisplayName: "Test",
            projectRootPath: cwd,
            projectKind: "git",
            workspaceKind: "worktree",
            status: "done",
            createdAt: null,
            lastUserMessageAt: null,
            statusEnteredAt: null,
            archivingAt: null,
            diffStat: null,
            scripts: [],
          },
        ],
      ]),
    );
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [serverId]: {
          ...state.sessions[serverId]!,
          agents: new Map([[target.agentId, { id: target.agentId, workspaceId } as Agent]]),
        },
      },
    }));
    const query = new QueryClient();
    selectWorkingDiffComparison({ ...scope, comparison: "uncommitted" });
    query.setQueryData(checkoutStatusQueryKey(serverId, cwd), {
      isGit: true,
      isDirty: true,
      currentBranch: "topic",
      baseRef: "main",
    });
    query.setQueryData(checkoutDiffQueryKey(serverId, cwd, "uncommitted"), {
      requestId: "live",
      cwd,
      error: null,
      files: [file("old-host-live.txt")],
    });
    const ChangesPanel = changesTreePanelRegistration.component;
    const container = document.createElement("div");
    Object.assign(container.style, { width: "390px", height: "600px", display: "flex" });
    document.body.appendChild(container);
    const root = createRoot(container);
    dispose = () => {
      act(() => root.unmount());
      container.remove();
      query.clear();
      host.mockRestore();
      useWorkspaceLayoutStore.setState(layout, true);
      usePanelStore.setState(panel, true);
    };
    act(() =>
      root.render(
        <QueryClientProvider client={query}>
          <ToastApiProvider api={toast}>
            <SafeAreaInsetsContext.Provider value={insets}>
              <DiffDocumentWorkspaceCacheProvider>
                <MessageRewindMenu
                  serverId={serverId}
                  {...target}
                  capabilities={capabilities}
                  client={client}
                  rewoundText="Original"
                />
                <PaneProvider value={compactPane}>
                  <ChangesPanel />
                </PaneProvider>
              </DiffDocumentWorkspaceCacheProvider>
            </SafeAreaInsetsContext.Provider>
          </ToastApiProvider>
        </QueryClientProvider>,
      ),
    );
    const liveStaging = page.getByText("current.txt", { exact: true });
    const diffHeader = (path: string) =>
      document.querySelector(`[data-diff-header-path="${path}"]`);
    const expectLive = async () => {
      if (staging) await expect.element(liveStaging).toBeVisible();
      else await expect.poll(() => diffHeader("old-host-live.txt")).not.toBeNull();
    };
    await expectLive();
    await userEvent.click(page.getByTestId("rewind-menu-trigger"));
    await userEvent.click(page.getByTestId("rewind-menu-view-changes"));
    await expect.poll(() => diffHeader("historical.txt")).not.toBeNull();
    await expect.element(page.getByTestId("changes-checkpoint-attribution")).toBeVisible();
    if (staging) await expect.element(liveStaging).not.toBeVisible();
    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    const changesTab = layout
      .getWorkspaceTabs(workspaceKey)
      .find(({ target }) => target.kind === "changes_tree");
    expect(layout.getTabDestination(workspaceKey, changesTab!.tabId)).toMatchObject({
      kind: "pane",
      host: "explorer",
    });
    await userEvent.click(page.getByTestId("changes-diff-status-trigger"));
    await userEvent.click(page.getByTestId("changes-diff-mode-uncommitted"));
    await expectLive();
    await expect
      .element(page.getByTestId("changes-checkpoint-attribution"))
      .not.toBeInTheDocument();
    if (!staging) expect(client.checkoutGitWorkingTreeGet).not.toHaveBeenCalled();
  },
);

void i18n;
const scope = { serverId: "history-host", workspaceId: "worktree", cwd: "/repo" };
const target = { agentId: "agent", messageId: "message" };
const noop = () => {};
const capabilities = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
};
const compactPane: PaneContextValue = {
  serverId: scope.serverId,
  workspaceId: scope.workspaceId,
  host: "explorer",
  tabId: "changes",
  target: { kind: "changes_tree" },
  openTab: noop,
  openPreferredTarget: noop,
  closeCurrentTab: noop,
  retargetCurrentTab: noop,
  setCurrentTabState: noop,
  openFileInWorkspace: noop,
  openImportSheet: noop,
};
function createCompactCheckpointClient(serverId: string, cwd: string) {
  return Object.assign(new DaemonClient({ url: "ws://unused.test", clientId: serverId }), {
    getAgentRewindCheckpoint: async () => ({
      requestId: "checkpoint",
      agentId: target.agentId,
      ok: true,
      error: null,
      target: { checkpointId: "checkpoint", messageId: target.messageId },
    }),
    getAgentRewindCheckpointDiff: vi.fn<DaemonClient["getAgentRewindCheckpointDiff"]>(
      async ({ agentId }) => ({
        requestId: "diff",
        agentId,
        ok: true,
        error: null,
        result: {
          kind: "ready",
          files: [file("historical.txt")],
          diffTooLarge: false,
          attribution: "unknown",
        },
      }),
    ),
    checkoutGitWorkingTreeGet: vi.fn<DaemonClient["checkoutGitWorkingTreeGet"]>(async () => ({
      requestId: "tree",
      cwd,
      error: null,
      workingTree: {
        repoRoot: cwd,
        headSha: "head",
        currentBranch: "topic",
        operationState: "idle",
        staged: [],
        unstaged: [{ path: "current.txt", status: "modified" }],
        untracked: [],
        conflicts: [],
        activeAgents: [],
      },
    })),
  });
}
const insets = { top: 0, bottom: 0, left: 0, right: 0 };
const toast = { show: () => () => {}, error: () => {}, copied: () => {} };
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  useSessionStore.getState().clearSession(scope.serverId);
  resetWorkingDiffComparisons();
  vi.unstubAllGlobals();
});

function file(path: string): ParsedDiffFile {
  return { path, isNew: true, isDeleted: false, additions: 1, deletions: 0, hunks: [] };
}

test("compares the selected turn and frozen baseline, then returns to live changes", async () => {
  await page.viewport(1024, 768);
  const getAgentRewindCheckpointDiff = vi.fn<DaemonClient["getAgentRewindCheckpointDiff"]>(
    async ({ agentId, range }) => ({
      agentId,
      requestId: range,
      ok: true,
      error: null,
      result:
        range === "turn"
          ? {
              kind: "ready",
              files: [file("turn.txt"), file("external.txt")],
              stagedFiles: [file("staging-only.txt")],
              diffTooLarge: false,
              attribution: "unknown",
            }
          : { kind: "unavailable", reason: "missing" },
    }),
  );
  const client = Object.assign(
    new DaemonClient({ url: "ws://unused.test", clientId: scope.serverId }),
    { getAgentRewindCheckpointDiff },
  );
  useSessionStore.getState().initializeSession(scope.serverId, client);
  useSessionStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [scope.serverId]: {
        ...state.sessions[scope.serverId],
        serverInfo: {
          serverId: scope.serverId,
          hostname: null,
          version: null,
          features: { rewindCheckpoints: true, checkoutDiscardChanges: true },
        },
      },
    },
  }));
  const query = new QueryClient();
  query.setQueryData(checkoutStatusQueryKey(scope.serverId, scope.cwd), {
    isGit: true,
    isDirty: true,
    currentBranch: "feature",
    baseRef: "main",
  });
  query.setQueryData(checkoutDiffQueryKey(scope.serverId, scope.cwd, "uncommitted"), {
    requestId: "live",
    cwd: scope.cwd,
    error: null,
    files: [file("live.txt")],
  });
  selectCheckpointDiff({ ...scope, selection: { target, range: "turn" } });
  const container = document.createElement("div");
  Object.assign(container.style, { width: "800px", height: "600px", display: "flex" });
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <QueryClientProvider client={query}>
        <ToastApiProvider api={toast}>
          <SafeAreaInsetsContext.Provider value={insets}>
            <ChangesSurface {...scope} presentation="tree" />
          </SafeAreaInsetsContext.Provider>
        </ToastApiProvider>
      </QueryClientProvider>,
    ),
  );
  dispose = () => {
    act(() => root.unmount());
    container.remove();
    query.clear();
  };

  await expect.element(page.getByTestId("changes-checkpoint-attribution")).toBeVisible();
  await expect.element(page.getByText("external.txt", { exact: true })).toBeVisible();
  expect(getAgentRewindCheckpointDiff).toHaveBeenCalledWith({ ...target, range: "turn" });
  await userEvent.click(page.getByTestId("changes-checkpoint-layer-staged"));
  await expect.element(page.getByText("staging-only.txt", { exact: true })).toBeVisible();
  await expect.element(page.getByText("external.txt", { exact: true })).not.toBeInTheDocument();
  await userEvent.click(page.getByTestId("changes-checkpoint-layer-worktree"));
  await expect.element(page.getByText("external.txt", { exact: true })).toBeVisible();
  await userEvent.click(page.getByTestId("changes-diff-status-trigger"));
  await userEvent.click(page.getByTestId("changes-diff-mode-baseline"));
  await expect
    .element(page.getByText("This comparison is unavailable because a checkpoint is missing."))
    .toBeVisible();
  expect(getAgentRewindCheckpointDiff).toHaveBeenCalledWith({ ...target, range: "baseline" });
  await userEvent.click(page.getByTestId("changes-diff-status-trigger"));
  await userEvent.click(page.getByTestId("changes-diff-mode-uncommitted"));
  const liveFile = page.getByText("live.txt", { exact: true });
  await expect.element(liveFile).toBeVisible();
  await expect.element(page.getByTestId("changes-checkpoint-attribution")).not.toBeInTheDocument();
  await userEvent.click(liveFile, { button: "right" });
  await expect.element(page.getByText("Discard changes", { exact: true })).toBeVisible();
});
