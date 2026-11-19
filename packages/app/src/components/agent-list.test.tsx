/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import type { FlatListProps } from "react-native";
import { parentAddressLabels } from "@getpaseo/protocol/agent-labels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHistoryResult } from "@/hooks/use-agent-history";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { i18n } from "@/i18n/i18next";
import { SessionsScreen } from "@/screens/sessions-screen";
import { AgentList } from "./agent-list";

const { archiveAgent, navigateToAgent, useAgentHistory } = vi.hoisted(() => ({
  archiveAgent: vi.fn(async () => {}),
  navigateToAgent: vi.fn(),
  useAgentHistory: vi.fn<typeof import("@/hooks/use-agent-history").useAgentHistory>(),
}));

vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent }));
vi.mock("@/hooks/use-agent-history", () => ({ useAgentHistory }));
vi.mock("@/hooks/use-archive-agent", () => ({ useArchiveAgent: () => ({ archiveAgent }) }));
vi.mock("@/hooks/use-import-session", () => ({
  useImportSession: () => ({ open: vi.fn(), sheet: null }),
}));
vi.mock("@/runtime/host-runtime", () => ({ useHosts: () => [] }));
vi.mock("expo-router/react-navigation", () => ({ useIsFocused: () => true }));
vi.mock("expo-router", () => ({ router: { navigate: vi.fn() } }));
vi.mock("@/components/headers/menu-header", () => ({ MenuHeader: () => null }));
vi.mock("@/components/hosts/host-filter", () => ({ HostFilter: () => null }));
vi.mock("@/components/hosts/host-picker", () => ({ ALL_HOSTS_OPTION_ID: "all" }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: Object.assign(
    (select: (state: { sessions: object }) => unknown) => select({ sessions: {} }),
    {
      getState: () => ({ sessions: { host: { client: {} } } }),
    },
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("@/components/ui/modal", () => ({ Modal: () => null }));
vi.mock("@/components/provider-icons", () => ({
  useProviderIcon: () => () => null,
}));
vi.mock("react-native-unistyles", async () => {
  const { darkTheme } = await import("@/styles/theme");
  return {
    StyleSheet: {
      create: (factory: (theme: typeof darkTheme) => unknown) => factory(darkTheme),
    },
    withUnistyles: <Component,>(component: Component) => component,
  };
});
vi.mock("lucide-react-native", () => ({
  Archive: () => null,
  ChevronDown: () => null,
  ChevronLeft: () => null,
  ChevronRight: () => null,
  Import: () => null,
  Search: () => null,
  X: () => null,
}));
vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>();
  return {
    ...actual,
    FlatList: <Item,>({
      data,
      keyExtractor,
      renderItem,
      ListFooterComponent,
    }: FlatListProps<Item>) =>
      React.createElement(
        "div",
        null,
        Array.from(data ?? [], (item, index) =>
          React.createElement(
            React.Fragment,
            { key: keyExtractor?.(item, index) },
            renderItem?.({
              item,
              index,
              separators: { highlight() {}, unhighlight() {}, updateProps() {} },
            }),
          ),
        ),
        React.isValidElement(ListFooterComponent) ? ListFooterComponent : null,
      ),
  };
});

const workspaceId = "workspace-id";
const date = new Date("2026-04-02T10:00:00.000Z");
const activeWorkspaceIdsByServer = new Map([["host", new Set([workspaceId])]]);

function agent(id: string, overrides: Partial<AggregatedAgent> = {}): AggregatedAgent {
  return {
    id,
    serverId: "host",
    serverLabel: "MacBook",
    title: "Main session",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    provider: "codex",
    cwd: "/repos/atlas",
    workspaceId,
    labels: {},
    createdAt: date,
    lastActivityAt: date,
    projectPlacement: {
      projectKey: "atlas",
      projectName: "Atlas",
      workspaceName: "Spring work",
      checkout: {
        cwd: "/repos/atlas",
        isGit: true,
        currentBranch: "feature/spring",
        remoteUrl: null,
        worktreeRoot: "/repos/atlas",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
    ...overrides,
  };
}

const root = agent("root");
const parent = parentAddressLabels({ agentId: root.id, serverId: root.serverId });
const child = agent("child", { title: "Quartz investigation", labels: parent, archivedAt: date });
const otherChild = agent("other", { title: "Follow-up session", labels: parent });

function historyResult(overrides: Partial<AgentHistoryResult>): AgentHistoryResult {
  return {
    agents: [],
    ancestors: [],
    hasMore: false,
    hostErrors: [],
    isArchiveScopeSupported: true,
    isError: false,
    isInitialLoad: false,
    isLoading: false,
    isLoadingMore: false,
    isPreviousResults: false,
    isRevalidating: false,
    isSearchSupported: false,
    isSearchTruncated: false,
    loadMore: vi.fn(),
    refreshAll: async () => {},
    ...overrides,
  };
}

describe("AgentList history hierarchy", () => {
  beforeEach(async () => {
    vi.stubGlobal("React", React);
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders project, workspace metadata and the parent in order with child rows initially hidden", () => {
    const { getByTestId, getByRole, queryByTestId } = render(
      <AgentList
        agents={[child, root, otherChild]}
        ancestors={[]}
        activeWorkspaceIdsByServer={activeWorkspaceIdsByServer}
        showHostColumn
      />,
    );
    const project = getByRole("heading", { name: /Atlas/ });
    const workspace = getByRole("heading", { name: /Spring work/ });
    const parentRow = getByTestId("agent-row-host-root");
    const toggle = getByRole("button", { name: "Show subagents" });

    expect(
      project.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      workspace.compareDocumentPosition(parentRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(workspace.textContent).toContain("feature/spring");
    expect(workspace.textContent).toContain("MacBook");
    expect(parentRow.textContent).not.toContain("Spring work");
    expect(toggle.textContent).toBe("2 subagents");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(queryByTestId("agent-row-host-child")).toBeNull();
    expect(queryByTestId("agent-row-host-other")).toBeNull();
  });

  it("toggles child rows independently and navigates from both session rows", () => {
    const { getByTestId, queryByTestId } = render(
      <AgentList
        agents={[root, child]}
        ancestors={[]}
        activeWorkspaceIdsByServer={activeWorkspaceIdsByServer}
      />,
    );
    const toggle = getByTestId("agent-row-subagents-toggle-host-root");

    expect(toggle.textContent).toBe("1 subagent");
    fireEvent.click(toggle);
    const childRow = getByTestId("agent-row-host-child");
    expect(toggle.getAttribute("aria-label")).toBe("Hide subagents");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(navigateToAgent).not.toHaveBeenCalled();
    expect(within(childRow).getByText("Archived")).toBeDefined();

    fireEvent.click(getByTestId("agent-row-host-root"));
    fireEvent.click(childRow);
    expect(navigateToAgent.mock.calls).toEqual([
      [{ serverId: "host", agentId: "root", workspaceId, pin: true }],
      [{ serverId: "host", agentId: "child", workspaceId, pin: true }],
    ]);

    fireEvent.click(toggle);
    expect(queryByTestId("agent-row-host-child")).toBeNull();
    expect(navigateToAgent).toHaveBeenCalledTimes(2);
  });

  it("auto-expands a matching child when the search changes and restores the collapsed default on clear", () => {
    const initial = (
      <AgentList
        agents={[root, child]}
        ancestors={[]}
        activeWorkspaceIdsByServer={activeWorkspaceIdsByServer}
      />
    );
    const { getByRole, getByTestId, queryByTestId, rerender } = render(initial);
    fireEvent.click(getByRole("button", { name: "Show subagents" }));
    fireEvent.click(getByRole("button", { name: "Hide subagents" }));

    rerender(
      <AgentList
        agents={[child]}
        ancestors={[root]}
        activeWorkspaceIdsByServer={activeWorkspaceIdsByServer}
        search="Quartz"
      />,
    );
    const title = getByTestId("agent-row-title-host-child");
    expect(title.textContent).toBe("Quartz investigation");
    expect(within(title).getByText("Quartz")).toBeDefined();
    expect(getByTestId("agent-row-host-root")).toBeDefined();

    rerender(initial);
    expect(queryByTestId("agent-row-host-child")).toBeNull();
  });

  it("opens history on Archived and resets expansion when the same parent appears in Active", () => {
    const archived = historyResult({ agents: [child], ancestors: [root] });
    const active = historyResult({ agents: [root, otherChild] });
    useAgentHistory.mockImplementation(({ archiveScope }) =>
      archiveScope === "archived" ? archived : active,
    );
    const { getByRole, getByTestId, queryByTestId } = render(<SessionsScreen />);
    const tabs = within(getByTestId("sessions-archive-scope-filter"));
    const archivedTab = tabs.getByRole("button", { name: "Archived" });
    const activeTab = tabs.getByRole("button", { name: "Active" });
    expect(archivedTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(getByRole("button", { name: "Show subagents" }));
    expect(getByTestId("agent-row-title-host-child").textContent).toBe("Quartz investigation");

    fireEvent.click(activeTab);
    expect(activeTab.getAttribute("aria-selected")).toBe("true");
    expect(getByRole("button", { name: "Show subagents" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(queryByTestId("agent-row-host-child")).toBeNull();
    expect(queryByTestId("agent-row-host-other")).toBeNull();

    fireEvent.click(archivedTab);
    expect(queryByTestId("agent-row-host-child")).toBeNull();
  });

  it("keeps Load more reachable when an archive leaves a page without visible sessions", () => {
    const loadMore = vi.fn();
    const firstPage = historyResult({ agents: [root], hasMore: true, loadMore });
    useAgentHistory.mockImplementation(({ archiveScope }) =>
      archiveScope === "active" ? firstPage : historyResult({}),
    );
    const { getByRole, getByTestId, queryByTestId, rerender } = render(<SessionsScreen />);
    fireEvent.click(
      within(getByTestId("sessions-archive-scope-filter")).getByRole("button", { name: "Active" }),
    );
    expect(getByTestId("agent-row-host-root").textContent).toContain("Main session");

    useAgentHistory.mockReturnValue({ ...firstPage, agents: [] });
    rerender(<SessionsScreen />);
    expect(queryByTestId("agent-row-host-root")).toBeNull();
    expect(queryByTestId("sessions-empty")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Load more" }));
    expect(loadMore).toHaveBeenCalledOnce();
  });

  it("keeps an active ancestor above its archived child and puts the workspace badge on the header", () => {
    const { getByRole, getByTestId, queryByTestId } = render(
      <AgentList
        agents={[child]}
        ancestors={[root]}
        activeWorkspaceIdsByServer={new Map([["host", new Set()]])}
      />,
    );
    const parentRow = getByTestId("agent-row-host-root");
    expect(
      within(getByRole("heading", { name: /Spring work/ })).getByText("Archived"),
    ).toBeDefined();
    expect(within(parentRow).queryByText("Archived")).toBeNull();
    expect(queryByTestId("agent-row-host-child")).toBeNull();

    fireEvent.click(getByRole("button", { name: "Show subagents" }));
    const childRow = getByTestId("agent-row-host-child");
    expect(
      parentRow.compareDocumentPosition(childRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(childRow).queryByText("Archived")).toBeNull();
    fireEvent.click(parentRow);
    expect(navigateToAgent).toHaveBeenCalledWith({
      serverId: "host",
      agentId: "root",
      workspaceId,
      pin: true,
    });
  });

  it("preserves long press to archive a child", () => {
    vi.useFakeTimers();
    const { getByRole, getByTestId } = render(
      <AgentList
        agents={[root, child]}
        ancestors={[]}
        activeWorkspaceIdsByServer={activeWorkspaceIdsByServer}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Show subagents" }));
    const childRow = getByTestId("agent-row-host-child");
    fireEvent.mouseDown(childRow, { button: 0 });
    act(() => vi.advanceTimersByTime(600));
    fireEvent.mouseUp(childRow, { button: 0 });
    expect(archiveAgent).toHaveBeenCalledWith({ serverId: "host", agentId: "child" });
    expect(navigateToAgent).not.toHaveBeenCalled();
  });
});
