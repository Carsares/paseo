/**
 * @vitest-environment jsdom
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings/storage";
import { act, fireEvent } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  WorkspaceHeaderMenuMobile,
  type WorkspaceHeaderMenuMobileProps,
} from "@/screens/workspace/workspace-header-menu";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { MenuPageDefinition } from "@/components/ui/menu";

void i18n;

interface MockMenuState {
  open: boolean;
  path: string[];
  setOpen: (open: boolean) => void;
  openSub: (sub: { id: string; depth: number }) => void;
  goBack: () => boolean;
}

const MockMenuContext = createContext<MockMenuState | null>(null);
const MockDepthContext = createContext(0);

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({ config: null }),
}));

vi.mock("@/hooks/use-active-workspace-archive", () => ({
  useActiveWorkspaceArchive: () => ({ canArchive: false, archive: vi.fn() }),
}));

vi.mock("@/git/use-actions", () => ({
  useGitActions: () => ({ gitActions: { primary: null, secondary: [], menu: [] } }),
  useGitActionRunner: () => vi.fn(),
}));

vi.mock("@/plugins", () => ({
  usePluginWorkspaceMenu: () => ({ pages: [], rows: [] }),
}));

vi.mock("@/screens/workspace/scripts", () => ({
  useWorkspaceScriptsMenuPages: () => ({ trigger: null, pages: [], needsAttention: false }),
}));

vi.mock("@/subagents/team-directory", () => ({
  useTeamDirectoryShell: () => ({ openDirectory: vi.fn() }),
}));

vi.mock("@/subagents/use-move-subagent-to-workspace", () => ({
  useCanMoveSubagentToWorkspace: () => false,
  useMoveSubagentToWorkspace: () => vi.fn(),
}));

vi.mock("@/subagents/resident-dialog", () => ({
  useResidentActions: () => [],
}));

vi.mock("@/file-panels", () => ({
  useFilePanelOpenWithMenu: () => ({ trigger: null, pages: [] }),
}));

vi.mock("@/screens/workspace/workspace-tab-presentation", () => ({
  WorkspaceTabIcon: () => null,
  WorkspaceTabPresentationResolver: ({
    tab,
    children,
  }: {
    tab: WorkspaceTabDescriptor;
    children: (presentation: {
      key: string;
      kind: WorkspaceTabDescriptor["kind"];
      label: string;
      subtitle: string;
      tooltip: string;
      modified: boolean;
      showCloseButton: boolean;
      titleState: "ready";
      icon: () => null;
      statusBucket: null;
    }) => ReactNode;
  }) => {
    let label = tab.tabId;
    if (tab.target.kind === "terminal") {
      label = `Terminal ${tab.target.terminalId}`;
    } else if (tab.target.kind === "file") {
      label = tab.target.path;
    }
    return (
      <>
        {children({
          key: tab.key,
          kind: tab.kind,
          label,
          subtitle: label,
          tooltip: label,
          modified: false,
          showCloseButton: true,
          titleState: "ready",
          icon: () => null,
          statusBucket: null,
        })}
      </>
    );
  },
}));

vi.mock("@/components/ui/menu", () => {
  function useMenuContext() {
    const ctx = useContext(MockMenuContext);
    if (!ctx) throw new Error("Missing MockMenuContext");
    return ctx;
  }
  return {
    useMenuContext,
    useMenuDepth: () => useContext(MockDepthContext),
    useMenuSurface: () => ({
      registerSubAnchor: vi.fn(),
      hoverOpen: vi.fn(),
      hoverClose: vi.fn(),
      cancelHoverClose: vi.fn(),
    }),
    isSubPageOpen: (path: readonly string[], sub: { id: string; depth: number }) =>
      path[sub.depth] === sub.id,
  };
});

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => {
    const [open, setOpenState] = useState(false);
    const [path, setPath] = useState<string[]>([]);
    const value = useMemo<MockMenuState>(
      () => ({
        open,
        path,
        setOpen: (next) => {
          setOpenState(next);
          if (!next) setPath([]);
        },
        openSub: ({ id, depth }) => setPath((current) => [...current.slice(0, depth), id]),
        goBack: () => {
          if (path.length === 0) return false;
          setPath((current) => current.slice(0, -1));
          return true;
        },
      }),
      [open, path],
    );
    return <MockMenuContext.Provider value={value}>{children}</MockMenuContext.Provider>;
  },
  DropdownMenuTrigger: ({ children, testID }: { children: ReactNode; testID?: string }) => {
    const menu = useContext(MockMenuContext)!;
    const handleClick = useCallback(() => menu.setOpen(!menu.open), [menu]);
    return (
      <button type="button" data-testid={testID} onClick={handleClick}>
        {children}
      </button>
    );
  },
  DropdownMenuContent: ({
    children,
    pages = [],
    testID,
  }: {
    children: ReactNode;
    pages?: readonly MenuPageDefinition[];
    testID?: string;
  }) => {
    const menu = useContext(MockMenuContext)!;
    if (!menu.open) return null;
    const currentId = menu.path[menu.path.length - 1];
    const activePage = currentId ? pages.find((page) => page.id === currentId) : null;
    return (
      <div data-testid={testID}>
        {activePage && !activePage.fill ? (
          <MockDepthContext.Provider value={menu.path.length}>
            <div data-testid="mock-menu-sheet-title">{activePage.title}</div>
            {activePage.content}
          </MockDepthContext.Provider>
        ) : (
          <MockDepthContext.Provider value={0}>{children}</MockDepthContext.Provider>
        )}
      </div>
    );
  },
  DropdownMenuSubTrigger: ({
    id,
    children,
    testID,
  }: {
    id: string;
    children: ReactNode;
    testID?: string;
  }) => {
    const menu = useContext(MockMenuContext)!;
    const depth = useContext(MockDepthContext);
    const handleClick = useCallback(() => menu.openSub({ id, depth }), [depth, id, menu]);
    return (
      <button type="button" data-testid={testID} onClick={handleClick}>
        {children}
      </button>
    );
  },
  DropdownMenuItem: ({
    children,
    disabled,
    selected,
    onSelect,
    testID,
  }: {
    children: ReactNode;
    disabled?: boolean;
    selected?: boolean;
    onSelect?: () => void;
    testID?: string;
  }) => {
    const menu = useContext(MockMenuContext)!;
    const handleClick = useCallback(() => {
      if (disabled) return;
      menu.setOpen(false);
      onSelect?.();
    }, [disabled, menu, onSelect]);
    return (
      <button
        type="button"
        data-testid={testID}
        aria-checked={selected}
        disabled={disabled}
        onClick={handleClick}
      >
        {children}
      </button>
    );
  },
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <div role="separator" />,
}));

const noop = () => {};
const emptyScripts: WorkspaceHeaderMenuMobileProps["scripts"] = {
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

function createTerminalTab(id: string): WorkspaceTabDescriptor {
  return {
    key: `terminal_${id}`,
    tabId: `terminal_${id}`,
    kind: "terminal",
    target: { kind: "terminal", terminalId: id },
  };
}

describe("WorkspaceHeaderMenuMobile per-tab actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    queryClient = new QueryClient();
    queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function renderMenu(props: Partial<WorkspaceHeaderMenuMobileProps>) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <WorkspaceHeaderMenuMobile
            currentBranchName={null}
            showWorkspaceSetup={false}
            importAgentDisabled
            copyPathDisabled
            onOpenImportSheet={noop}
            onCopyWorkspacePath={noop}
            onCopyBranchName={noop}
            onOpenSetupTab={noop}
            normalizedServerId="server-1"
            normalizedWorkspaceId="workspace-1"
            scripts={emptyScripts}
            showCreateBrowserTab={false}
            createTerminalDisabled={false}
            onCreateTerminalWithProfile={noop}
            onCreateBrowser={noop}
            {...props}
          />
        </QueryClientProvider>,
      );
    });
  }

  function clickTestId(testId: string) {
    const element = document.querySelector(`[data-testid="${testId}"]`);
    expect(element, `Expected element with data-testid="${testId}"`).not.toBeNull();
    act(() => {
      fireEvent.click(element as HTMLElement);
    });
  }

  it("toggles the global user message alignment through the compact menu", () => {
    renderMenu({});
    clickTestId("workspace-header-menu-trigger");
    const testId = "workspace-header-user-message-alignment";
    const action = () => container.querySelector(`[data-testid="${testId}"]`);
    expect(action()?.textContent).toBe("Align my messages left");
    clickTestId(testId);
    expect(queryClient.getQueryData(APP_SETTINGS_QUERY_KEY)).toMatchObject({
      userMessageAlignment: "left",
    });
    clickTestId("workspace-header-menu-trigger");
    expect(action()?.textContent).toBe("Align my messages right");
  });

  it("copies ID, renames, and closes an unselected background terminal without selecting it", () => {
    const terminal = createTerminalTab("bg-1");
    const onSelectTab = vi.fn();
    const onCopyTerminalId = vi.fn();
    const onRenameTab = vi.fn();
    const onCloseTab = vi.fn();
    const tabMenuActions: NonNullable<WorkspaceHeaderMenuMobileProps["tabMenuActions"]> = {
      onCopyResumeCommand: vi.fn(),
      onCopyAgentId: vi.fn(),
      onCopyTerminalId,
      onCopyFilePath: vi.fn(),
      onReloadAgent: vi.fn(),
      onRenameTab,
      onCloseTab,
      onCloseTabsAbove: vi.fn(),
      onCloseTabsBelow: vi.fn(),
      onCloseOtherTabs: vi.fn(),
    };

    renderMenu({
      tabs: [terminal],
      activeTabKey: "agent_main",
      onSelectTab,
      tabMenuActions,
    });

    const openBackgroundTerminalActions = () => {
      clickTestId("workspace-header-menu-trigger");
      clickTestId("workspace-header-tabs");
      const tabButton = document.querySelector(
        '[data-testid="workspace-header-tab-terminal_bg-1"]',
      );
      expect(tabButton?.getAttribute("aria-checked")).toBe("false");
      clickTestId("workspace-header-tab-actions-terminal_bg-1");
      expect(document.querySelector('[data-testid="mock-menu-sheet-title"]')?.textContent).toBe(
        "Terminal bg-1",
      );
    };

    openBackgroundTerminalActions();
    clickTestId("workspace-tab-menu-terminal_bg-1-copy-terminal-id");
    expect(onCopyTerminalId).toHaveBeenCalledExactlyOnceWith("bg-1");
    expect(onSelectTab).not.toHaveBeenCalled();

    openBackgroundTerminalActions();
    clickTestId("workspace-tab-menu-terminal_bg-1-rename");
    expect(onRenameTab).toHaveBeenCalledExactlyOnceWith(terminal);
    expect(onSelectTab).not.toHaveBeenCalled();

    openBackgroundTerminalActions();
    clickTestId("workspace-tab-menu-terminal_bg-1-close");
    expect(onCloseTab).toHaveBeenCalledExactlyOnceWith("terminal_bg-1");
    expect(onSelectTab).not.toHaveBeenCalled();

    renderMenu({
      tabs: [],
      activeTabKey: "agent_main",
      onSelectTab,
      tabMenuActions: undefined,
    });
    clickTestId("workspace-header-menu-trigger");
    expect(document.querySelector('[data-testid="workspace-header-tabs"]')).toBeNull();
  });

  it("scopes bulk close enablement and callbacks to the visible Workspace tabs list", () => {
    const first = createTerminalTab("first");
    const second = createTerminalTab("second");
    const onCloseTabsAbove = vi.fn();
    const onCloseTabsBelow = vi.fn();
    const onCloseOtherTabs = vi.fn();
    const tabMenuActions: NonNullable<WorkspaceHeaderMenuMobileProps["tabMenuActions"]> = {
      onCopyResumeCommand: vi.fn(),
      onCopyAgentId: vi.fn(),
      onCopyTerminalId: vi.fn(),
      onCopyFilePath: vi.fn(),
      onReloadAgent: vi.fn(),
      onRenameTab: vi.fn(),
      onCloseTab: vi.fn(),
      onCloseTabsAbove,
      onCloseTabsBelow,
      onCloseOtherTabs,
    };

    renderMenu({
      tabs: [first, second],
      activeTabKey: "agent_main",
      onSelectTab: vi.fn(),
      tabMenuActions,
    });

    clickTestId("workspace-header-menu-trigger");
    clickTestId("workspace-header-tabs");
    clickTestId("workspace-header-tab-actions-terminal_second");

    const closeAbove = document.querySelector(
      '[data-testid="workspace-tab-menu-terminal_second-close-above"]',
    ) as HTMLButtonElement | null;
    const closeBelow = document.querySelector(
      '[data-testid="workspace-tab-menu-terminal_second-close-below"]',
    ) as HTMLButtonElement | null;
    const closeOthers = document.querySelector(
      '[data-testid="workspace-tab-menu-terminal_second-close-others"]',
    ) as HTMLButtonElement | null;

    expect(closeAbove?.disabled).toBe(false);
    expect(closeBelow?.disabled).toBe(true);
    expect(closeOthers?.disabled).toBe(false);

    clickTestId("workspace-tab-menu-terminal_second-close-above");
    expect(onCloseTabsAbove).toHaveBeenCalledExactlyOnceWith("terminal_second", [first, second]);
    expect(onCloseTabsBelow).not.toHaveBeenCalled();

    clickTestId("workspace-header-menu-trigger");
    clickTestId("workspace-header-tabs");
    clickTestId("workspace-header-tab-actions-terminal_first");
    clickTestId("workspace-tab-menu-terminal_first-close-below");
    expect(onCloseTabsBelow).toHaveBeenCalledExactlyOnceWith("terminal_first", [first, second]);

    clickTestId("workspace-header-menu-trigger");
    clickTestId("workspace-header-tabs");
    clickTestId("workspace-header-tab-actions-terminal_first");
    clickTestId("workspace-tab-menu-terminal_first-close-others");
    expect(onCloseOtherTabs).toHaveBeenCalledExactlyOnceWith("terminal_first", [first, second]);
  });
});
