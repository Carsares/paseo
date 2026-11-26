import { act, useCallback, useMemo, useState } from "react";
import { PortalProvider } from "@gorhom/portal";
import { NavigationContext } from "expo-router/react-navigation";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { MenuRoot, MenuSurface, MenuTrigger } from "@/components/ui/menu";
import { ComposerTrackRow } from "@/composer/tracks";
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import { GraphSheet } from "@/git/graph/sheet";
import { MobilePanelsProvider } from "@/mobile-panels/provider";
import { PaneProvider, type PaneContextValue } from "@/panels/pane-context";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { WorkspaceSheetBackToMain } from "@/screens/workspace/workspace-tab-presentation";
import type { SheetTab } from "@/stores/workspace-layout-store";
import { SheetTabs } from "../sheet-tabs";
import {
  SheetPaneHostProvider,
  useActiveWorkspaceSheetOpener,
  useSheetPanePage,
  useWorkspaceSheetPages,
  type SheetPaneHost,
  type WorkspaceSheetPage,
} from ".";
import { i18n } from "@/i18n/i18next";
void i18n;

vi.mock("@gorhom/bottom-sheet", async (importOriginal) => {
  const [
    actual,
    { Portal },
    { createElement, forwardRef, useImperativeHandle, useState: useReactState },
  ] = await Promise.all([
    importOriginal<typeof import("@gorhom/bottom-sheet")>(),
    import("@gorhom/portal"),
    import("react"),
  ]);
  const noop = () => {};
  return {
    ...actual,
    BottomSheetModal: forwardRef(
      (
        {
          children,
          containerStyle,
          onDismiss,
        }: {
          children: React.ReactNode;
          containerStyle?: React.CSSProperties;
          onDismiss?: () => void;
        },
        ref,
      ) => {
        const [presented, setPresented] = useReactState(false);
        useImperativeHandle(
          ref,
          () => ({
            present: () => setPresented(true),
            dismiss: () => {
              setPresented(false);
              onDismiss?.();
            },
          }),
          [onDismiss, setPresented],
        );
        if (!presented) return null;
        return createElement(
          Portal,
          null,
          createElement(
            "div",
            { "data-testid": "workspace-sheet-modal", style: containerStyle },
            children,
          ),
        );
      },
    ),
    useBottomSheetGestureHandlers: () => ({
      handlePanGestureHandler: {
        handleOnStart: noop,
        handleOnChange: noop,
        handleOnEnd: noop,
        handleOnFinalize: noop,
      },
    }),
  };
});

vi.mock("@/components/ui/isolated-bottom-sheet-modal/visible-frame", () => ({
  SheetVisibleFrame: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/constants/layout", async (original) => ({
  ...(await original<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => true,
}));

const host: SheetPaneHost = {
  workspaceKey: "test:retained-pages",
  serverId: "test",
  workspaceId: "retained-pages",
  isWorkspaceFocused: true,
  buildContent: () => {
    throw new Error("This test opens workspace pages only");
  },
};

type Navigation = NonNullable<React.ContextType<typeof NavigationContext>>;

// The sheet host only reads focus and subscribes to navigation events.
const focusedNavigation = {
  isFocused: () => true,
  addListener: () => () => {},
} satisfies Pick<Navigation, "isFocused" | "addListener">;
const navigation = focusedNavigation as unknown as Navigation;

const layout = { width: "100%" as const, height: "100%" as const };
const scrollStyle = { height: 100, overflowY: "scroll" as const };
const rowStyle = { height: 300 };

function PageBody() {
  const active = useRetainedPanelActive();
  return (
    <div style={scrollStyle} data-testid="retained-scroll" data-active={active}>
      <input aria-label="Draft" />
      <div style={rowStyle} />
    </div>
  );
}

async function closeTab() {}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

function createAppRenderer() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.style.cssText = "position: fixed; inset: 0;";
  document.body.appendChild(container);
  root = createRoot(container);

  return (children: React.ReactNode) =>
    act(async () =>
      root?.render(
        <GestureHandlerRootView style={layout}>
          <SafeAreaProvider>
            <MobilePanelsProvider>
              <PortalProvider>{children}</PortalProvider>
            </MobilePanelsProvider>
          </SafeAreaProvider>
        </GestureHandlerRootView>,
      ),
    );
}

function WorkspaceRoute({
  children,
  value = host,
  routeNavigation = navigation,
}: {
  children: React.ReactNode;
  value?: SheetPaneHost;
  routeNavigation?: Navigation;
}) {
  return (
    <NavigationContext.Provider value={routeNavigation}>
      <DiffDocumentWorkspaceCacheProvider>
        <SheetPaneHostProvider value={value}>
          {children}
          <SheetTabs onCloseTab={closeTab} />
        </SheetPaneHostProvider>
      </DiffDocumentWorkspaceCacheProvider>
    </NavigationContext.Provider>
  );
}

async function renderWorkspace(children: React.ReactNode) {
  await createAppRenderer()(<WorkspaceRoute>{children}</WorkspaceRoute>);
}

it("keeps the previous page and its scroll position when the sheet covers it", async () => {
  let stack: ReturnType<typeof useWorkspaceSheetPages>;
  function Capture() {
    stack = useWorkspaceSheetPages();
    return null;
  }
  await renderWorkspace(<Capture />);
  await act(async () =>
    stack!.push({ key: "team", title: "Team test", render: () => <PageBody /> }),
  );
  const team = page.getByRole("dialog", { name: "Team test", includeHidden: true });
  await expect.element(team).toBeVisible();
  await act(async () => page.getByRole("textbox", { name: "Draft" }).fill("Unsent"));
  const scroller = page.getByTestId("retained-scroll").element();
  scroller.scrollTop = 80;
  await act(async () =>
    stack!.push({ key: "evidence", title: "Evidence test", render: () => <div>Evidence</div> }),
  );
  await expect.element(team).not.toBeVisible();
  await expect.element(page.getByRole("dialog", { name: "Evidence test" })).toBeVisible();
  await act(async () => page.getByRole("button", { name: "Back", exact: true }).click());
  await expect.element(team).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Draft" })).toHaveValue("Unsent");
  expect(page.getByTestId("retained-scroll").element()).toBe(scroller);
  expect(scroller.scrollTop).toBe(80);
});

const sidebarEvidence: WorkspaceSheetPage = {
  key: "another-host:another-workspace:evidence",
  title: "Cross-host evidence",
  render: () => <div>Evidence from another host and workspace</div>,
};
const teamPage: WorkspaceSheetPage = {
  key: "team",
  title: "Team test",
  render: () => <PageBody />,
};
const otherHost = { ...host, workspaceKey: "other:workspace", serverId: "other" };
const unfocusedNavigation = {
  ...focusedNavigation,
  isFocused: () => false,
} as unknown as Navigation;

it("lets a sibling sidebar push into the focused workspace modal and rejects obsolete openers", async () => {
  let opener: ReturnType<typeof useActiveWorkspaceSheetOpener>;
  let stack: ReturnType<typeof useWorkspaceSheetPages>;
  function Sidebar() {
    opener = useActiveWorkspaceSheetOpener();
    const open = useCallback(() => opener?.(sidebarEvidence), []);
    return (
      <>
        <div style={scrollStyle} data-testid="sidebar-scroll">
          <input aria-label="Sidebar filter" />
          <div style={rowStyle} />
        </div>
        <button type="button" disabled={!opener} onClick={open}>
          Open sidebar evidence
        </button>
      </>
    );
  }
  function Capture() {
    stack = useWorkspaceSheetPages();
    return null;
  }
  const renderApp = createAppRenderer();
  async function renderRoute(value: SheetPaneHost, routeNavigation = navigation) {
    await renderApp(
      <>
        <Sidebar />
        <WorkspaceRoute value={value} routeNavigation={routeNavigation}>
          <Capture />
        </WorkspaceRoute>
      </>,
    );
  }
  await renderRoute(host);
  const firstOpen = opener!;
  const firstStack = stack!;
  await act(async () => firstStack.push(teamPage));
  const modal = page.getByTestId("workspace-sheet-modal");
  const firstModal = modal.element();
  const sidebar = page.getByTestId("sidebar-scroll").element();
  const draft = page.getByRole("textbox", { name: "Draft" });
  const sidebarFilter = page.getByRole("textbox", { name: "Sidebar filter" });
  await act(async () => {
    await draft.fill("Team draft");
    await sidebarFilter.fill("Keep filter");
  });
  sidebar.scrollTop = 60;
  await act(async () => page.getByRole("button", { name: "Open sidebar evidence" }).click());
  await expect.element(page.getByRole("dialog", { name: sidebarEvidence.title })).toBeVisible();
  expect(modal.all().length).toBe(1);
  expect(modal.element()).toBe(firstModal);
  expect(firstOpen(sidebarEvidence)).toBe(false);

  await act(async () => page.getByRole("button", { name: "Back", exact: true }).click());
  await expect.element(draft).toHaveValue("Team draft");
  await expect.element(sidebarFilter).toHaveValue("Keep filter");
  expect(page.getByTestId("sidebar-scroll").element()).toBe(sidebar);
  expect(sidebar.scrollTop).toBe(60);

  await renderRoute(host, unfocusedNavigation);
  await expect.element(modal).not.toBeVisible();
  expect(opener!).toBeNull();
  expect(firstOpen(sidebarEvidence)).toBe(false);
  expect(firstStack.getSnapshot().map(({ key }) => key)).toEqual(["page:team"]);

  await renderRoute(otherHost);
  const secondOpen = opener!;
  expect(firstOpen(sidebarEvidence)).toBe(false);
  await act(async () => expect(secondOpen(sidebarEvidence)).toBe(true));
  await expect.element(page.getByRole("dialog", { name: sidebarEvidence.title })).toBeVisible();
  expect(modal.all().length).toBe(1);
  expect(firstStack.getSnapshot().map(({ key }) => key)).toEqual(["page:team"]);

  await renderApp(<Sidebar />);
  expect(opener!).toBeNull();
  expect(secondOpen(sidebarEvidence)).toBe(false);
});

const noop = () => {};
const graphPane: PaneContextValue = {
  serverId: host.serverId,
  workspaceId: host.workspaceId,
  host: "main",
  tabId: "git-graph-test",
  target: { kind: "git_graph" },
  openTab: noop,
  openPreferredTarget: noop,
  closeCurrentTab: noop,
  retargetCurrentTab: noop,
  setCurrentTabState: noop,
  openFileInWorkspace: noop,
  openImportSheet: noop,
};

const commitHeader = { title: "Commit detail" };
const fileHeader = { title: "File diff" };

function GraphPages() {
  const [showFile, setShowFile] = useState(false);
  const openFile = useCallback(() => setShowFile(true), []);
  const closeFile = useCallback(() => setShowFile(false), []);
  return (
    <PaneProvider value={graphPane}>
      <GraphSheet visible header={commitHeader} workspacePageKey="commit" onClose={noop}>
        <PageBody />
        <button type="button" onClick={openFile}>
          Open file
        </button>
      </GraphSheet>
      <GraphSheet
        visible={showFile}
        header={fileHeader}
        workspacePageKey="file"
        onClose={closeFile}
      >
        <div>Changed file contents</div>
      </GraphSheet>
    </PaneProvider>
  );
}

it("places compact Git surfaces in the shared sheet and reactivates the retained commit page after Back", async () => {
  await renderWorkspace(<GraphPages />);
  const detail = page.getByRole("dialog", { name: "Commit detail", includeHidden: true });
  const body = page.getByTestId("retained-scroll");
  await expect.element(detail).toBeVisible();
  await expect.element(body).toHaveAttribute("data-active", "true");
  const element = body.element();
  element.scrollTop = 80;

  await act(async () => page.getByRole("button", { name: "Open file" }).click());
  await expect.element(page.getByRole("dialog", { name: "File diff" })).toBeVisible();
  await expect.element(detail).not.toBeVisible();
  await expect.element(body).toHaveAttribute("data-active", "false");

  await act(async () => page.getByRole("button", { name: "Back", exact: true }).click());
  await expect.element(detail).toBeVisible();
  await expect.element(body).toHaveAttribute("data-active", "true");
  expect(body.element()).toBe(element);
  expect(element.scrollTop).toBe(80);
});

function SpecialistSheetBody() {
  return <div data-testid="specialist-sheet-body">Specialist sheet</div>;
}

const specialistSheetTab: SheetTab = {
  tab: {
    tabId: "agent_specialist-1",
    target: { kind: "agent", agentId: "specialist-1" },
    createdAt: 0,
  },
  policy: { openAsTab: true },
  parentTabId: null,
};

function TrackSheetMenu({ openerAgentId }: { openerAgentId: string }) {
  const openerPane = useMemo<PaneContextValue>(
    () => ({
      ...graphPane,
      tabId: `agent_${openerAgentId}`,
      target: { kind: "agent", agentId: openerAgentId },
    }),
    [openerAgentId],
  );
  return (
    <PaneProvider value={openerPane}>
      <TrackSheetMenuInner />
    </PaneProvider>
  );
}

function TrackSheetMenuInner() {
  const buildSheetPage = useSheetPanePage();
  const pages = useMemo(() => [buildSheetPage(specialistSheetTab)], [buildSheetPage]);
  return (
    <MenuRoot compactMode="sheet">
      <MenuTrigger testID="open-track-menu">
        <span>Subagents</span>
      </MenuTrigger>
      <MenuSurface pages={pages} sheetTitle="Subagents" testID="track-sheet-menu">
        <ComposerTrackRow opensPage={specialistSheetTab.tab.tabId} testID="open-specialist-sheet">
          <span>Specialist</span>
        </ComposerTrackRow>
      </MenuSurface>
    </MenuRoot>
  );
}

function SpecialistRouteHarness({
  openerAgentId,
  onBackToMain,
}: {
  openerAgentId: string;
  onBackToMain: () => void;
}) {
  const specialistHost = useMemo<SheetPaneHost>(
    () => ({
      ...host,
      buildContent: (tab, closeCurrentTab) => ({
        key: tab.key,
        Component: SpecialistSheetBody,
        navigation: (
          <WorkspaceSheetBackToMain
            tab={tab}
            serverId={host.serverId}
            workspaceId={host.workspaceId}
            mainAgentId="main-agent"
            onBackToMain={onBackToMain}
          />
        ),
        paneContextValue: {
          ...graphPane,
          host: "sheet",
          tabId: tab.tabId,
          target: tab.target,
          closeCurrentTab,
        },
      }),
    }),
    [onBackToMain],
  );
  return (
    <WorkspaceRoute value={specialistHost}>
      <TrackSheetMenu openerAgentId={openerAgentId} />
    </WorkspaceRoute>
  );
}

it("closes MenuSheetPane when returning to Main from a subagent opened off Main, and falls back otherwise", async () => {
  ensurePanelsRegistered();
  const onBackToMain = vi.fn();

  const renderApp = createAppRenderer();
  const renderWithOpener = (openerAgentId: string) =>
    renderApp(<SpecialistRouteHarness openerAgentId={openerAgentId} onBackToMain={onBackToMain} />);

  // Opened from Main: leaving the sheet lands directly back on Main without redundant reveal.
  await renderWithOpener("main-agent");
  await act(async () => page.getByTestId("open-track-menu").click());
  await act(async () => page.getByTestId("open-specialist-sheet").click());
  await expect.element(page.getByTestId("specialist-sheet-body")).toBeVisible();
  const backToMain = page.getByTestId("workspace-header-back-to-main");
  await expect.element(backToMain).toBeVisible();
  await act(async () => backToMain.click());
  await expect.element(page.getByTestId("specialist-sheet-body")).not.toBeInTheDocument();
  await expect.element(backToMain).not.toBeInTheDocument();
  expect(onBackToMain).not.toHaveBeenCalled();

  // Opened from another specialist: closes MenuSheetPane and falls back to onBackToMain.
  await renderWithOpener("other-specialist");
  await act(async () => page.getByTestId("open-track-menu").click());
  await act(async () => page.getByTestId("open-specialist-sheet").click());
  await expect.element(page.getByTestId("specialist-sheet-body")).toBeVisible();
  await act(async () => page.getByTestId("workspace-header-back-to-main").click());
  await expect.element(page.getByTestId("specialist-sheet-body")).not.toBeInTheDocument();
  expect(onBackToMain).toHaveBeenCalledOnce();
});
