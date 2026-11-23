/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React, { type ReactElement } from "react";
import { act, fireEvent } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkspaceTabMenuEntries } from "@/screens/workspace/workspace-tab-menu";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { MobileTabTrailingAccessory } from "@/screens/workspace/workspace-tab-trailing-accessory";

void testI18n;

/**
 * Records the props the accessory hands to the menu engine, so the test can assert the
 * compact presentation without rendering the real gorhom sheet in jsdom.
 */
const capturedRootProps: { compactMode?: string }[] = [];
const capturedContentProps: { sheetTitle?: string; testID?: string }[] = [];
const capturedItemLeading = new Map<string, React.ReactNode>();

const { mockTheme } = vi.hoisted(() => ({
  mockTheme: {
    colors: { foregroundMuted: "#aaa", surface2: "#222" },
    borderRadius: { md: 6 },
    fontSize: { sm: 12, xs: 11 },
  },
}));

vi.mock("lucide-react-native", () => {
  const StubIcon = () => null;
  return {
    ArrowLeftToLine: StubIcon,
    ArrowRightToLine: StubIcon,
    Copy: StubIcon,
    CopyX: StubIcon,
    Crown: StubIcon,
    Ellipsis: StubIcon,
    ExternalLink: StubIcon,
    GitMerge: StubIcon,
    Pencil: StubIcon,
    Plus: StubIcon,
    RotateCw: StubIcon,
    Unlink: StubIcon,
    X: StubIcon,
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (theme: unknown) => unknown)(mockTheme) : factory,
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({
      uniProps,
      ...rest
    }: { uniProps?: (theme: unknown) => Record<string, unknown> } & Record<string, unknown>) => {
      const themed = uniProps ? uniProps(mockTheme) : {};
      return React.createElement(Component, { ...rest, ...themed });
    },
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({
    children,
    compactMode,
  }: {
    children: React.ReactNode;
    compactMode?: string;
  }) => {
    capturedRootProps.push({ compactMode });
    return <div>{children}</div>;
  },
  DropdownMenuTrigger: ({
    children,
    testID,
  }: {
    children:
      | React.ReactNode
      | ((state: { hovered: boolean; pressed: boolean; open: boolean }) => React.ReactNode);
    testID?: string;
  }) => (
    <button type="button" data-testid={testID}>
      {typeof children === "function"
        ? children({ hovered: false, pressed: false, open: false })
        : children}
    </button>
  ),
  DropdownMenuContent: ({
    children,
    sheetTitle,
    testID,
  }: {
    children: React.ReactNode;
    sheetTitle?: string;
    testID?: string;
  }) => {
    capturedContentProps.push({ sheetTitle, testID });
    return <div data-testid={testID}>{children}</div>;
  },
  DropdownMenuSeparator: () => <div role="separator" />,
  DropdownMenuItem: ({
    children,
    leading,
    onSelect,
    testID,
  }: {
    children: React.ReactNode;
    leading?: React.ReactNode;
    onSelect?: () => void;
    testID?: string;
  }) => {
    if (testID) capturedItemLeading.set(testID, leading);
    return (
      <button type="button" data-testid={testID} onClick={onSelect}>
        {leading}
        {children}
      </button>
    );
  },
}));

function agentTab(): WorkspaceTabDescriptor {
  return {
    key: "agent_123",
    tabId: "agent_123",
    kind: "agent",
    target: { kind: "agent", agentId: "agent-123" },
  };
}

function terminalTab(): WorkspaceTabDescriptor {
  return {
    key: "terminal_abc",
    tabId: "terminal_abc",
    kind: "terminal",
    target: { kind: "terminal", terminalId: "terminal-abc" },
  };
}

function renderAccessory(
  tab: WorkspaceTabDescriptor,
  onRenameTab: (tab: WorkspaceTabDescriptor) => void,
): { base: string; unmount: () => void } {
  const base = `workspace-tab-menu-${tab.tabId}`;
  const menuEntries = buildWorkspaceTabMenuEntries({
    surface: "mobile",
    tab,
    index: 0,
    tabCount: 2,
    menuTestIDBase: base,
    onCopyResumeCommand: vi.fn(),
    onCopyAgentId: vi.fn(),
    onCopyTerminalId: vi.fn(),
    onCopyFilePath: vi.fn(),
    onReloadAgent: vi.fn(),
    onRenameTab,
    onCloseTab: vi.fn(),
    onCloseTabsBefore: vi.fn(),
    onCloseTabsAfter: vi.fn(),
    onCloseOtherTabs: vi.fn(),
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const element: ReactElement = (
    <MobileTabTrailingAccessory
      menuTestIDBase={base}
      presentationLabel="My session"
      menuEntries={menuEntries}
    />
  );
  act(() => {
    root.render(element);
  });
  return {
    base,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("MobileTabTrailingAccessory", () => {
  let current: { unmount: () => void } | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
    capturedRootProps.length = 0;
    capturedContentProps.length = 0;
    capturedItemLeading.clear();
  });

  afterEach(() => {
    current?.unmount();
    current = null;
    vi.unstubAllGlobals();
  });

  it("renders leading icons for set-main, unset-main, and attach-to-main items", () => {
    const tab = agentTab();
    const base = `workspace-tab-menu-${tab.tabId}`;
    const sharedInput = {
      surface: "mobile" as const,
      tab,
      index: 1,
      tabCount: 2,
      mainTabIndex: 0,
      menuTestIDBase: base,
      onCopyResumeCommand: vi.fn(),
      onCopyAgentId: vi.fn(),
      onCopyTerminalId: vi.fn(),
      onCopyFilePath: vi.fn(),
      onReloadAgent: vi.fn(),
      onRenameTab: vi.fn(),
      onCloseTab: vi.fn(),
      onCloseTabsBefore: vi.fn(),
      onCloseTabsAfter: vi.fn(),
      onCloseOtherTabs: vi.fn(),
    };

    const nonMainEntries = buildWorkspaceTabMenuEntries({
      ...sharedInput,
      hierarchyActions: {
        isMain: false,
        pending: false,
        setMain: vi.fn(),
        attachToMain: vi.fn(),
      },
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <MobileTabTrailingAccessory
          menuTestIDBase={base}
          presentationLabel="My session"
          menuEntries={nonMainEntries}
        />,
      );
    });
    current = {
      unmount: () => {
        act(() => root.unmount());
        container.remove();
      },
    };

    expect(capturedItemLeading.get(`${base}-toggle-main-tab`)).toBeTruthy();
    expect(capturedItemLeading.get(`${base}-attach-to-main-tab`)).toBeTruthy();

    capturedItemLeading.clear();
    const mainEntries = buildWorkspaceTabMenuEntries({
      ...sharedInput,
      index: 0,
      hierarchyActions: {
        isMain: true,
        pending: false,
        setMain: vi.fn(),
      },
    });
    act(() => {
      root.render(
        <MobileTabTrailingAccessory
          menuTestIDBase={base}
          presentationLabel="My session"
          menuEntries={mainEntries}
        />,
      );
    });

    expect(capturedItemLeading.get(`${base}-toggle-main-tab`)).toBeTruthy();
  });

  it("renders the per-session actions as a bottom sheet on compact (so it is reachable over the sessions sheet)", () => {
    const onRenameTab = vi.fn();
    current = renderAccessory(agentTab(), onRenameTab);

    // The fix: the menu must open as a sheet, not the default popover that stacks a
    // fragile second native Modal over the sessions bottom sheet.
    expect(capturedRootProps).toContainEqual({ compactMode: "sheet" });
    expect(capturedContentProps[0]?.sheetTitle).toBe("My session");
    expect(capturedContentProps[0]?.testID).toBe("workspace-tab-menu-agent_123");
  });

  it("reaches Rename for an agent session", () => {
    const onRenameTab = vi.fn();
    const rendered = renderAccessory(agentTab(), onRenameTab);
    current = rendered;

    expect(document.querySelector(`[data-testid="${rendered.base}-trigger"]`)).not.toBeNull();
    const renameButton = document.querySelector(`[data-testid="${rendered.base}-rename"]`);
    expect(renameButton).not.toBeNull();
    fireEvent.click(renameButton as HTMLElement);

    expect(onRenameTab).toHaveBeenCalledTimes(1);
    expect(onRenameTab).toHaveBeenCalledWith(agentTab());
  });

  it("reaches Rename for a terminal session", () => {
    const onRenameTab = vi.fn();
    const rendered = renderAccessory(terminalTab(), onRenameTab);
    current = rendered;

    const renameButton = document.querySelector(`[data-testid="${rendered.base}-rename"]`);
    expect(renameButton).not.toBeNull();
    fireEvent.click(renameButton as HTMLElement);

    expect(onRenameTab).toHaveBeenCalledWith(terminalTab());
  });
});
