import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { PortalProvider } from "@gorhom/portal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CheckoutGitRepo } from "@getpaseo/protocol/messages";
import { CompactWorkspaceRebaseConflictAction } from "@/screens/workspace/topic-header/compact-rebase-conflict-action";
import { createGitGraphNavigationIntentStore } from "@/screens/workspace/topic-header/git-graph-intent";
import { useSessionStore } from "@/stores/session-store";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import {
  WorkspaceSheetStackProvider,
  useWorkspaceSheetPages,
} from "@/screens/workspace/sheet-pane/stack-provider";
import { WindowLayoutContext } from "@/window-layout/context";
import { WindowLayoutActionsHost } from "@/window-layout";
import { usePanelStore } from "@/stores/panel-store";
import { CompactWorkspaceHeader } from ".";
import { i18n } from "@/i18n/i18next";
import type { WindowLayout } from "@/window-layout";
void i18n;

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const initialPanel = usePanelStore.getState();
afterEach(async () => {
  await act(async () => root.render(null));
  usePanelStore.setState(initialPanel, true);
});
const geometry: WindowLayout = {
  bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  verticalBarEdge: "trailing",
  verticalBar: { x: 20, y: 20, width: 44, height: 400 },
  divisions: [],
};

it("updates compact header actions on panel changes without rendering the workspace owner", async () => {
  let ownerRenders = 0;
  function WorkspaceOwner({ focused = true, compact = true }) {
    ownerRenders++;
    return (
      <CompactWorkspaceHeader
        isRouteFocused={focused}
        isCompact={compact}
        serverId="test"
        isLoading={false}
        title="Workspace"
        subtitle="Project"
        isSubtitleDistinct
        explorerAction={null}
        inDesktopTitlebar={false}
        tabSwitcher={null}
        headerVariant="full"
      >
        <button type="button">Workspace menu</button>
      </CompactWorkspaceHeader>
    );
  }
  async function renderWorkspace(focused = true, compact = true) {
    await act(async () =>
      root.render(
        <PortalProvider>
          <WindowLayoutContext.Provider value={geometry}>
            <WindowLayoutActionsHost />
            <WorkspaceOwner focused={focused} compact={compact} />
          </WindowLayoutContext.Provider>
        </PortalProvider>,
      ),
    );
  }
  async function showPanel(target: "agent" | "agent-list" | "file-explorer") {
    await act(async () =>
      usePanelStore.setState((state) => ({
        mobilePanel: { ...state.mobilePanel, target, revision: state.mobilePanel.revision + 1 },
      })),
    );
  }
  const menu = page.getByRole("button", {
    name: "Workspace menu",
    exact: true,
    includeHidden: true,
  });
  await showPanel("agent");
  await renderWorkspace();
  await expect.element(menu).toBeVisible();
  const rendersBeforePanelChanges = ownerRenders;
  await showPanel("agent-list");
  await expect.element(menu).not.toBeVisible();
  await showPanel("agent");
  await expect.element(menu).toBeVisible();
  await showPanel("file-explorer");
  await expect.element(menu).not.toBeVisible();
  expect(ownerRenders).toBe(rendersBeforePanelChanges);
  await renderWorkspace(true, false);
  await expect.element(menu).toBeVisible();
  await renderWorkspace(false, false);
  await expect.element(menu).not.toBeVisible();
});

function renderDirectory() {
  return <div>Team directory</div>;
}

it("opens Team from compact workspace actions in the shared sheet stack", async () => {
  let stack: ReturnType<typeof useWorkspaceSheetPages>;
  function Harness({ compact }: { compact: boolean }) {
    stack = useWorkspaceSheetPages();
    return (
      <CompactWorkspaceHeader
        isRouteFocused
        isCompact={compact}
        serverId="test"
        isLoading={false}
        title="Workspace"
        subtitle="Project"
        isSubtitleDistinct
        explorerAction={null}
        inDesktopTitlebar={false}
        tabSwitcher={null}
        compactTeamDirectory={renderDirectory}
        headerVariant="full"
      >
        {null}
      </CompactWorkspaceHeader>
    );
  }
  async function render(compact: boolean) {
    await act(async () =>
      root.render(
        <PortalProvider>
          <WorkspaceSheetStackProvider workspaceKey="test:compact-team">
            <WindowLayoutContext.Provider value={geometry}>
              <WindowLayoutActionsHost />
              <Harness compact={compact} />
            </WindowLayoutContext.Provider>
          </WorkspaceSheetStackProvider>
        </PortalProvider>,
      ),
    );
  }
  await act(async () => usePanelStore.getState().showMobileAgent());
  await render(false);
  const team = page.getByTestId("workspace-header-team");
  await expect.element(team).not.toBeInTheDocument();
  await render(true);
  await act(async () => team.click());
  expect(stack!.getSnapshot().map(({ key }) => key)).toEqual(["page:team"]);
});

function createConflictClient(cwd: string, linked: CheckoutGitRepo) {
  const primary: CheckoutGitRepo = {
    ...linked,
    repoId: "primary",
    repoRoot: cwd,
    displayName: "Primary",
    operationState: "idle",
  };
  return {
    checkoutGitReposDiscover: vi.fn<DaemonClient["checkoutGitReposDiscover"]>(
      async ({ includeWorktrees }) => ({
        requestId: "repos",
        cwd,
        error: null,
        mode: includeWorktrees ? "multi" : "single",
        repos: includeWorktrees ? [primary, { ...linked }] : [primary],
      }),
    ),
  };
}

it("finds a newly paused linked worktree while the compact header stays open", async () => {
  const serverId = "compact-conflict-host";
  const cwd = "/work";
  const repo: CheckoutGitRepo = {
    repoId: "linked",
    repoRoot: "/work/linked",
    displayName: "Linked worktree",
    headSha: "abc123",
    currentBranch: "feature",
    operationState: "idle",
  };
  const client = createConflictClient(cwd, repo);
  const intentStore = createGitGraphNavigationIntentStore();
  const onOpenGitGraph = (repoRoot: string) =>
    intentStore.submitConflictIntent({ tabId: "git-graph", repoRoot });
  const queryClient = new QueryClient();
  const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

  function setCapabilities(checkoutGitRebaseV1: boolean) {
    useSessionStore.getState().updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: null,
      features: {
        checkoutGitGraphV1: true,
        checkoutGitMultiRepoV1: true,
        checkoutGitStagingV1: true,
        checkoutGitRebaseV1,
      },
    });
  }

  async function renderHeader({
    isCompact = true,
    isConnected = true,
    isRouteFocused = true,
  } = {}) {
    const compactConflictAction = React.createElement(CompactWorkspaceRebaseConflictAction, {
      serverId,
      client,
      isConnected,
      isRouteFocused,
      workspaceDirectory: cwd,
      onOpenGitGraph,
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <PortalProvider>
            <WindowLayoutContext.Provider value={geometry}>
              <WindowLayoutActionsHost />
              <CompactWorkspaceHeader
                isRouteFocused={isRouteFocused}
                isCompact={isCompact}
                serverId={serverId}
                isLoading={false}
                title="Workspace"
                subtitle="Project"
                isSubtitleDistinct
                explorerAction={null}
                inDesktopTitlebar={false}
                tabSwitcher={null}
                headerVariant="full"
                compactConflictAction={compactConflictAction}
              >
                {null}
              </CompactWorkspaceHeader>
            </WindowLayoutContext.Provider>
          </PortalProvider>
        </QueryClientProvider>,
      ),
    );
  }

  async function expectNoRefresh() {
    const count = client.checkoutGitReposDiscover.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(client.checkoutGitReposDiscover).toHaveBeenCalledTimes(count);
  }

  useSessionStore.getState().initializeSession(serverId, null, 0);
  setCapabilities(false);
  try {
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      usePanelStore.getState().showMobileAgent();
    });
    await renderHeader();
    const conflict = page.getByTestId("workspace-header-rebase-conflict");
    await expectNoRefresh();
    expect(client.checkoutGitReposDiscover).not.toHaveBeenCalled();
    await act(async () => setCapabilities(true));
    expect(client.checkoutGitReposDiscover).toHaveBeenCalledExactlyOnceWith({
      cwd,
      maxDepth: 2,
      includeWorktrees: true,
    });
    await expect.element(conflict).not.toBeInTheDocument();

    repo.operationState = "rebase_paused";
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await expect.element(conflict).toBeVisible();
    await act(async () => conflict.click());
    expect(intentStore.getIntent()).toMatchObject({
      tabId: "git-graph",
      repoRoot: repo.repoRoot,
      surface: "conflicts",
    });

    await act(async () => {
      hasFocus.mockReturnValue(false);
      window.dispatchEvent(new Event("blur"));
    });
    await expectNoRefresh();

    repo.operationState = "idle";
    await act(async () => {
      hasFocus.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));
    });
    await expect.element(conflict).not.toBeInTheDocument();

    await act(async () => usePanelStore.getState().showMobileFileExplorer());
    await expectNoRefresh();
    await renderHeader({ isRouteFocused: false });
    await act(async () => usePanelStore.getState().showMobileAgent());
    await expectNoRefresh();
    await renderHeader({ isConnected: false });
    await expectNoRefresh();
    await renderHeader({ isCompact: false });
    await expectNoRefresh();
  } finally {
    await act(async () => root.render(null));
    queryClient.clear();
    useSessionStore.getState().clearSession(serverId);
    vi.useRealTimers();
    hasFocus.mockRestore();
    window.dispatchEvent(new Event("focus"));
  }
});
