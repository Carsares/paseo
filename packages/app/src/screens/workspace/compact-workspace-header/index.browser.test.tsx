import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Dimensions } from "react-native";
import { PortalProvider } from "@gorhom/portal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CheckoutGitRepo } from "@getpaseo/protocol/messages";
import { CompactWorkspaceRebaseConflictAction } from "@/screens/workspace/topic-header/compact-rebase-conflict-action";
import { createGitGraphNavigationIntentStore } from "@/screens/workspace/topic-header/git-graph-intent";
import { useSessionStore } from "@/stores/session-store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import {
  WorkspaceSheetStackProvider,
  useWorkspaceSheetPages,
} from "@/screens/workspace/sheet-pane/stack-provider";
import { WindowLayoutContext } from "@/window-layout/context";
import { WindowLayoutActionsHost } from "@/window-layout";
import { usePanelStore } from "@/stores/panel-store";
import { CompactWorkspaceHeader, TopicWorkspaceExplorerActions } from ".";
import { i18n } from "@/i18n/i18next";
import type { WindowLayout } from "@/window-layout";
import { SplitContainer } from "@/components/split-container";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { useWorkspaceExplorerControls } from "../workspace-explorer-toggle";
import { ToastProvider } from "@/contexts/toast-context";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import { NewTabLauncherProvider, type NewTabLauncher } from "@/workspace-tabs/launcher";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import {
  WorkspaceHeaderMenuMobile,
  type WorkspaceHeaderMenuMobileProps,
} from "../workspace-header-menu";
void i18n;

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
let container: HTMLDivElement;
let root: Root;
const initialPanel = usePanelStore.getState();
beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  usePanelStore.setState(initialPanel, true);
});
const geometry: WindowLayout = {
  bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  verticalBarEdge: "trailing",
  verticalBar: { x: 20, y: 20, width: 44, height: 400 },
  divisions: [],
};
const trailingBar = { ...geometry, verticalBar: { x: 720, y: 120, width: 44, height: 400 } };
const noop = () => {};
const noLauncher: NewTabLauncher = {
  showChanges: false,
  showPullRequest: false,
  showBrowser: false,
  terminalDisabled: true,
  launch: noop,
};
const emptyList: never[] = [];
const closingTabIds = new Set<string>();
const splitStyle = { width: 1100, height: 450, display: "flex" };
const noPaneContent = () => {
  throw new Error("No tabs in this split");
};
const renderNoHeader = () => null;
const modeAction = (
  <ToolbarButton compact label="Topics" onPress={noop}>
    <span>T</span>
  </ToolbarButton>
);
const noScripts: WorkspaceHeaderMenuMobileProps["scripts"] = {
  scripts: [],
  liveTerminalIds: [],
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
  onViewTerminal: noop,
  onOpenUrlInBrowserTab: noop,
};
const terminalTabs: WorkspaceHeaderMenuMobileProps["tabs"] = [
  {
    key: "terminal-one",
    tabId: "terminal-one",
    kind: "terminal",
    target: { kind: "terminal", terminalId: "one" },
  },
];
const noopTabMenuActions: NonNullable<WorkspaceHeaderMenuMobileProps["tabMenuActions"]> = {
  onCopyResumeCommand: noop,
  onCopyAgentId: noop,
  onCopyTerminalId: noop,
  onCopyFilePath: noop,
  onReloadAgent: noop,
  onRenameTab: noop,
  onCloseTab: noop,
  onCloseTabsAbove: noop,
  onCloseTabsBelow: noop,
  onCloseOtherTabs: noop,
};

it("keeps exactly one topic Explorer toggle in its wide system bar", async () => {
  const onToggle = vi.fn();
  const queryClient = new QueryClient();
  function Harness() {
    const explorer = useWorkspaceExplorerControls({
      hasWorkspace: true,
      compact: false,
      focusMode: false,
      expanded: false,
      onToggle,
    });
    return (
      <>
        <CompactWorkspaceHeader
          topicHeader
          isRouteFocused
          isCompact={false}
          serverId="test"
          isLoading={false}
          title="Topic"
          subtitle="Project"
          isSubtitleDistinct
          explorerAction={explorer.compactAction}
          inDesktopTitlebar={false}
          tabSwitcher={null}
          headerVariant="compact"
        >
          <button type="button">Workspace menu</button>
        </CompactWorkspaceHeader>
        <TopicWorkspaceExplorerActions
          topicHeader
          isRouteFocused
          isCompact={false}
          explorerAction={explorer.compactAction}
        />
      </>
    );
  }
  const renderHeader = (bar: boolean) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <PortalProvider>
            <WindowLayoutContext.Provider value={bar ? trailingBar : null}>
              <WindowLayoutActionsHost />
              <Harness />
            </WindowLayoutContext.Provider>
          </PortalProvider>
        </QueryClientProvider>,
      ),
    );
  const header = page.getByTestId("workspace-topic-header");
  const bar = page.getByTestId("workspace-vertical-actions");
  const explorer = page.getByTestId("workspace-explorer-toggle");
  await renderHeader(true);
  await expect.element(bar.getByTestId("workspace-explorer-toggle")).toBeVisible();
  await expect.element(header.getByTestId("workspace-explorer-toggle")).not.toBeInTheDocument();
  await act(async () => explorer.click());
  expect(onToggle).toHaveBeenCalledOnce();
  await renderHeader(false);
  await expect.element(header.getByTestId("workspace-explorer-toggle")).toBeVisible();
  await expect.element(bar).not.toBeInTheDocument();
});

const mockTabSwitcher = (
  <button type="button" data-testid="workspace-tab-switcher-trigger">
    2
  </button>
);
const mockExplorerToggle = (
  <button type="button" data-testid="workspace-explorer-toggle">
    E
  </button>
);

it("keeps desktopTeamAction, topicStatus, and tabSwitcher aligned for a non-topic workspace with Main", async () => {
  const onToggleTeam = vi.fn();
  const onOpenPending = vi.fn(() => false);
  const queryClient = new QueryClient();
  function Harness() {
    const desktopTeam = React.useMemo(
      () => (
        <ToolbarButton
          compact
          label="Team"
          onPress={onToggleTeam}
          testID="topic-header-toggle-directory"
        >
          <span>Team</span>
        </ToolbarButton>
      ),
      [],
    );
    const status = React.useMemo<WorkspaceHeaderMenuMobileProps["topicStatus"]>(
      () => ({
        direction: null,
        hideFromModel: false,
        gitLabel: "main",
        envLabel: "Ready",
        teamLabel: "2 members",
        pendingLabel: "0 pending",
        needsAttention: false,
        onOpenPending,
      }),
      [],
    );
    return (
      <>
        <CompactWorkspaceHeader
          topicHeader
          isRouteFocused
          isCompact={false}
          serverId="test"
          isLoading={false}
          title="Main workspace"
          subtitle="Project"
          isSubtitleDistinct
          explorerAction={mockExplorerToggle}
          inDesktopTitlebar={false}
          tabSwitcher={mockTabSwitcher}
          desktopTeamAction={desktopTeam}
          headerVariant="compact"
        >
          <WorkspaceHeaderMenuMobile
            currentBranchName="main"
            showWorkspaceSetup={false}
            importAgentDisabled
            copyPathDisabled
            onOpenImportSheet={noop}
            onCopyWorkspacePath={noop}
            onCopyBranchName={noop}
            onOpenSetupTab={noop}
            normalizedServerId="test"
            normalizedWorkspaceId="workspace"
            scripts={noScripts}
            showCreateBrowserTab={false}
            createTerminalDisabled={false}
            onCreateTerminalWithProfile={noop}
            onCreateBrowser={noop}
            topicStatus={status}
          />
        </CompactWorkspaceHeader>
        <TopicWorkspaceExplorerActions
          topicHeader
          isRouteFocused
          isCompact={false}
          explorerAction={mockExplorerToggle}
        />
      </>
    );
  }
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <PortalProvider>
          <ToastProvider>
            <WindowLayoutContext.Provider value={trailingBar}>
              <WindowLayoutActionsHost />
              <Harness />
            </WindowLayoutContext.Provider>
          </ToastProvider>
        </PortalProvider>
      </QueryClientProvider>,
    ),
  );
  const header = page.getByTestId("workspace-topic-header");
  const bar = page.getByTestId("workspace-vertical-actions");
  // Wide system bar carries only the single Explorer toggle; no duplicate overflow button is portaled.
  await expect.element(bar.getByTestId("workspace-explorer-toggle")).toBeVisible();
  await expect.element(bar.getByTestId("workspace-header-menu-trigger")).not.toBeInTheDocument();
  await expect.element(header.getByTestId("topic-header-toggle-directory")).toBeVisible();
  await expect.element(header.getByTestId("workspace-tab-switcher-trigger")).toBeVisible();
  await act(async () => header.getByTestId("topic-header-toggle-directory").click());
  expect(onToggleTeam).toHaveBeenCalledOnce();
  await act(async () => header.getByTestId("workspace-header-menu-trigger").click());
  await expect.element(page.getByText("2 members")).toBeVisible();
});

it("keeps the topic title width when a terminal can be selected from Workspace tabs", async () => {
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  ensurePanelsRegistered();
  const selected = vi.fn();
  const queryClient = new QueryClient();
  function Harness({ hasTerminal }: { hasTerminal: boolean }) {
    const explorer = useWorkspaceExplorerControls({
      hasWorkspace: true,
      compact: true,
      focusMode: false,
      expanded: false,
      onToggle: noop,
    });
    return (
      <CompactWorkspaceHeader
        topicHeader
        isRouteFocused
        isCompact
        serverId="test"
        isLoading={false}
        title="A workspace title that must have room"
        subtitle="Project"
        isSubtitleDistinct
        explorerAction={explorer.compactAction}
        inDesktopTitlebar={false}
        tabSwitcher={null}
        headerVariant="compact"
        compactTeamDirectory={renderDirectory}
        modeControl={modeAction}
      >
        <WorkspaceHeaderMenuMobile
          currentBranchName={null}
          showWorkspaceSetup={false}
          importAgentDisabled
          copyPathDisabled
          onOpenImportSheet={noop}
          onCopyWorkspacePath={noop}
          onCopyBranchName={noop}
          onOpenSetupTab={noop}
          normalizedServerId="test"
          normalizedWorkspaceId="workspace"
          scripts={noScripts}
          showCreateBrowserTab={false}
          createTerminalDisabled={false}
          onCreateTerminalWithProfile={noop}
          onCreateBrowser={noop}
          tabs={hasTerminal ? terminalTabs : undefined}
          activeTabKey="terminal-one"
          onSelectTab={selected}
          tabMenuActions={hasTerminal ? noopTabMenuActions : undefined}
        />
      </CompactWorkspaceHeader>
    );
  }
  const renderHeader = (hasTerminal: boolean) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <PortalProvider>
            <ToastProvider>
              <WorkspaceSheetStackProvider workspaceKey="test:terminal">
                <Harness hasTerminal={hasTerminal} />
              </WorkspaceSheetStackProvider>
            </ToastProvider>
          </PortalProvider>
        </QueryClientProvider>,
      ),
    );
  try {
    await page.viewport(320, 844);
    const title = page.getByTestId("workspace-header-title");
    await renderHeader(false);
    const baseline = title.element().getBoundingClientRect().width;
    expect(baseline).toBeGreaterThanOrEqual(60);
    await renderHeader(true);
    expect(title.element().getBoundingClientRect().width).toBeCloseTo(baseline);
    const overflow = page.getByTestId("workspace-header-menu-trigger");
    expect(overflow.element().getBoundingClientRect().width).toBe(44);
    await act(async () => overflow.click());
    await act(async () => page.getByTestId("workspace-header-tabs").click());
    const terminal = page.getByTestId("workspace-header-tab-terminal-one");
    await expect.element(terminal).toHaveAttribute("aria-checked", "true");
    await act(async () => terminal.click());
    expect(selected).toHaveBeenCalledWith("terminal-one");
  } finally {
    await page.viewport(originalViewport.width, originalViewport.height);
    await expect.poll(() => Dimensions.get("window")).toMatchObject(originalViewport);
  }
});

it("acts on an unselected background terminal from Workspace tabs without selecting it", async () => {
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  ensurePanelsRegistered();
  const onSelectTab = vi.fn();
  const onCopyTerminalId = vi.fn();
  const onRenameTab = vi.fn();
  const onCloseTab = vi.fn();
  const tabMenuActions: NonNullable<WorkspaceHeaderMenuMobileProps["tabMenuActions"]> = {
    ...noopTabMenuActions,
    onCopyTerminalId,
    onRenameTab,
    onCloseTab,
  };
  const queryClient = new QueryClient();
  const renderMenu = (tabs: WorkspaceHeaderMenuMobileProps["tabs"]) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <PortalProvider>
            <ToastProvider>
              <WorkspaceSheetStackProvider workspaceKey="test:background-terminal">
                <CompactWorkspaceHeader
                  topicHeader
                  isRouteFocused
                  isCompact
                  serverId="test"
                  isLoading={false}
                  title="Topic workspace"
                  subtitle="Project"
                  isSubtitleDistinct
                  explorerAction={null}
                  inDesktopTitlebar={false}
                  tabSwitcher={null}
                  headerVariant="compact"
                  compactTeamDirectory={renderDirectory}
                  modeControl={modeAction}
                >
                  <WorkspaceHeaderMenuMobile
                    currentBranchName={null}
                    showWorkspaceSetup={false}
                    importAgentDisabled
                    copyPathDisabled
                    onOpenImportSheet={noop}
                    onCopyWorkspacePath={noop}
                    onCopyBranchName={noop}
                    onOpenSetupTab={noop}
                    normalizedServerId="test"
                    normalizedWorkspaceId="workspace"
                    scripts={noScripts}
                    showCreateBrowserTab={false}
                    createTerminalDisabled={false}
                    onCreateTerminalWithProfile={noop}
                    onCreateBrowser={noop}
                    tabs={tabs}
                    activeTabKey="agent_main"
                    onSelectTab={onSelectTab}
                    tabMenuActions={tabs?.length ? tabMenuActions : undefined}
                  />
                </CompactWorkspaceHeader>
              </WorkspaceSheetStackProvider>
            </ToastProvider>
          </PortalProvider>
        </QueryClientProvider>,
      ),
    );
  const openTerminalActions = async () => {
    await act(async () => page.getByTestId("workspace-header-menu-trigger").click());
    await act(async () => page.getByTestId("workspace-header-tabs").click());
    await expect
      .element(page.getByTestId("workspace-header-tab-terminal-one"))
      .toHaveAttribute("aria-checked", "false");
    await act(async () => page.getByTestId("workspace-header-tab-actions-terminal-one").click());
  };
  try {
    await page.viewport(320, 844);
    await renderMenu(terminalTabs);
    await openTerminalActions();
    await act(async () =>
      page.getByTestId("workspace-tab-menu-terminal-one-copy-terminal-id").click(),
    );
    expect(onCopyTerminalId).toHaveBeenCalledExactlyOnceWith("one");
    expect(onSelectTab).not.toHaveBeenCalled();

    await openTerminalActions();
    await act(async () => page.getByTestId("workspace-tab-menu-terminal-one-rename").click());
    expect(onRenameTab).toHaveBeenCalledExactlyOnceWith(terminalTabs[0]);
    expect(onSelectTab).not.toHaveBeenCalled();

    await openTerminalActions();
    await act(async () => page.getByTestId("workspace-tab-menu-terminal-one-close").click());
    expect(onCloseTab).toHaveBeenCalledExactlyOnceWith("terminal-one");
    expect(onSelectTab).not.toHaveBeenCalled();

    await renderMenu([]);
    await act(async () => page.getByTestId("workspace-header-menu-trigger").click());
    await expect.element(page.getByTestId("workspace-header-tabs")).not.toBeInTheDocument();
  } finally {
    await page.viewport(originalViewport.width, originalViewport.height);
    await expect.poll(() => Dimensions.get("window")).toMatchObject(originalViewport);
  }
});

it("restores the split when focus leaves a maximized pane", async () => {
  ensurePanelsRegistered();
  const queryClient = new QueryClient();
  function Harness() {
    const [focus, setFocus] = React.useState("left");
    const focusLeft = React.useCallback(() => setFocus("left"), []);
    const layout = React.useMemo(
      (): NonNullable<React.ComponentProps<typeof SplitContainer>["layout"]> => ({
        focusedPaneId: focus,
        root: {
          kind: "group",
          group: {
            id: "split",
            direction: "horizontal",
            sizes: [0.5, 0.5],
            children: ["left", "right"].map((id) => ({
              kind: "pane",
              pane: { id, tabIds: [], focusedTabId: null },
            })),
          },
        },
      }),
      [focus],
    );
    return (
      <div style={splitStyle}>
        <button type="button" onClick={focusLeft}>
          Focus left pane
        </button>
        <SplitContainer
          layout={layout}
          workspaceKey="test:split-maximize"
          normalizedServerId="test"
          normalizedWorkspaceId="split-maximize"
          isWorkspaceFocused
          uiTabs={emptyList}
          hoveredCloseTabKey={null}
          setHoveredCloseTabKey={noop}
          closingTabIds={closingTabIds}
          onNavigateTab={noop}
          onCloseTab={noop}
          onCopyResumeCommand={noop}
          onCopyAgentId={noop}
          onCopyTerminalId={noop}
          onCopyFilePath={noop}
          onReloadAgent={noop}
          onRenameTab={noop}
          onCloseTabsToLeft={noop}
          onCloseTabsToRight={noop}
          onCloseOtherTabs={noop}
          onCreateNewTab={noop}
          buildPaneContentModel={noPaneContent}
          onFocusPane={setFocus}
          onSplitPane={noop}
          onSplitPaneEmpty={noop}
          onResizeSplit={noop}
          onMoveTabToPane={noop}
          onSelectTabInPane={noop}
          onExitFocusMode={noop}
          onReorderTabsInPane={noop}
          renderCompactHeader={renderNoHeader}
        />
      </div>
    );
  }
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <KeyboardActionDispatcherProvider>
          <NewTabLauncherProvider value={noLauncher}>
            <Harness />
          </NewTabLauncherProvider>
        </KeyboardActionDispatcherProvider>
      </QueryClientProvider>,
    ),
  );
  const left = page.getByTestId("workspace-pane-left");
  const right = page.getByTestId("workspace-pane-right");
  const maximize = right.getByTestId("workspace-maximize-pane");
  const restore = right.getByTestId("workspace-restore-pane");
  await act(async () => maximize.click());
  await expect.element(left).not.toBeVisible();
  await act(async () => restore.click());
  await expect.element(left).toBeVisible();
  await act(async () => maximize.click());
  await expect.element(left).not.toBeVisible();
  await act(async () => page.getByRole("button", { name: "Focus left pane" }).click());
  await expect.element(left).toBeVisible();
  await expect.element(maximize).toBeVisible();
  await expect.element(restore).not.toBeInTheDocument();
});

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
