/**
 * @vitest-environment jsdom
 */
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FlatListProps } from "react-native";
import { parentAddressLabels } from "@getpaseo/protocol/agent-labels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHistoryResult } from "@/hooks/use-agent-history";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { i18n } from "@/i18n/i18next";
import { SessionsScreen } from "@/screens/sessions-screen";
import { DEFAULT_HISTORY_SORT } from "@/screens/sessions/history-grouping";
import { useHistoryProjectOptions } from "@/screens/sessions/project-filter";
import type { ProjectDescriptor } from "@/stores/session-store";
import { buildProjects, type ProjectSummary } from "@/utils/projects";
import { AgentList } from "./agent-list";

const { archiveAgent, navigateToAgent, useAgentHistory } = vi.hoisted(() => ({
  archiveAgent: vi.fn(async () => {}),
  navigateToAgent: vi.fn(),
  useAgentHistory: vi.fn<typeof import("@/hooks/use-agent-history").useAgentHistory>(),
}));
const historyCatalog = vi.hoisted(() => ({
  hosts: [] as { serverId: string; label: string }[],
  projects: [] as ProjectSummary[],
  statuses: new Map(),
  sessions: {},
  getClient:
    vi.fn<
      (
        serverId: string,
      ) => { listProjects: (options: unknown) => Promise<{ projects: ProjectDescriptor[] }> } | null
    >(),
}));

vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent }));
vi.mock("@/hooks/use-agent-history", () => ({ useAgentHistory }));
vi.mock("@/hooks/use-archive-agent", () => ({ useArchiveAgent: () => ({ archiveAgent }) }));
vi.mock("@/hooks/use-import-session", () => ({
  useImportSession: () => ({ open: vi.fn(), sheet: null }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => historyCatalog,
  useHostRuntimeConnectionStatuses: () => historyCatalog.statuses,
  useHosts: () => historyCatalog.hosts,
}));
vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => ({ projects: historyCatalog.projects }),
}));
vi.mock("expo-router/react-navigation", () => ({ useIsFocused: () => true }));
vi.mock("expo-router", () => ({ router: { navigate: vi.fn() } }));
vi.mock("@/components/headers/menu-header", () => ({ MenuHeader: () => null }));
vi.mock("@/components/hosts/host-filter", () => ({
  HostFilter: ({
    hosts,
    onSelectHost,
  }: {
    hosts: typeof historyCatalog.hosts;
    onSelectHost: (serverId: string) => void;
  }) =>
    React.createElement(
      React.Fragment,
      null,
      hosts.map(({ serverId, label }) =>
        React.createElement(
          "button",
          {
            type: "button",
            key: serverId,
            onClick: () => onSelectHost(serverId),
          },
          label,
        ),
      ),
    ),
}));
vi.mock("@/components/hosts/host-picker", () => ({ ALL_HOSTS_OPTION_ID: "all" }));
vi.mock("@/stores/session-store", () => ({
  normalizeProjectDescriptor: (payload: ProjectDescriptor) => payload,
  useSessionStore: Object.assign(
    (select: (state: { sessions: object }) => unknown) =>
      select({ sessions: historyCatalog.sessions }),
    {
      getState: () => ({ sessions: { host: { client: {} } } }),
    },
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("@/components/ui/modal", () => ({ Modal: () => null }));
// Keep the page tests on the History controls. The menu surfaces load native overlays.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => children,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => children,
  DropdownMenuItem: ({ children, onSelect }: React.PropsWithChildren<{ onSelect: () => void }>) =>
    React.createElement("button", { type: "button", onClick: onSelect }, children),
  DropdownMenuLabel: () => null,
  DropdownMenuSeparator: () => null,
}));
vi.mock("@/components/ui/dropdown-trigger", () => ({
  DropdownTrigger: ({ children, testID }: React.PropsWithChildren<{ testID: string }>) =>
    React.createElement("button", { type: "button", "data-testid": testID }, children),
}));
vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({
    children,
    onOpenChange,
    onSelect,
    open,
    options,
  }: React.PropsWithChildren<{
    onOpenChange: (open: boolean) => void;
    onSelect: (id: string) => void;
    open: boolean;
    options: Array<{ id: string; label: string }>;
  }>) =>
    open
      ? React.createElement(
          React.Fragment,
          null,
          children ??
            options.map(({ id, label }) =>
              React.createElement(
                "button",
                {
                  type: "button",
                  key: id,
                  onClick: () => {
                    onSelect(id);
                    onOpenChange(false);
                  },
                },
                label,
              ),
            ),
        )
      : null,
}));
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
  Folder: () => null,
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
const createdAscending = { field: "created_at", direction: "asc" } as const;

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
    isQueryControlsSupported: false,
    effectiveSort: DEFAULT_HISTORY_SORT,
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

function renderSessions() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<SessionsScreen />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

describe("AgentList history hierarchy", () => {
  beforeEach(async () => {
    vi.stubGlobal("React", React);
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    historyCatalog.hosts = [];
    historyCatalog.projects = [];
    historyCatalog.sessions = {};
    historyCatalog.statuses.clear();
    historyCatalog.getClient.mockReset();
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
    const project = getByTestId("history-project-header-host:atlas");
    const workspace = getByTestId(`history-workspace-header-host:${workspaceId}`);
    expect(project.getAttribute("aria-expanded")).toBe("true");
    expect(workspace.getAttribute("aria-expanded")).toBe("true");
    const parentRow = getByTestId("agent-row-host-root");
    const toggle = getByRole("button", { name: "Show subagents" });

    expect(
      project.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      workspace.compareDocumentPosition(parentRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(project).getByTestId("history-project-name-host:atlas").textContent).toBe(
      "Atlas",
    );
    expect(
      within(workspace).getByTestId(`history-workspace-name-host:${workspaceId}`).textContent,
    ).toBe("Spring work");
    expect(
      within(workspace).getByTestId(`history-workspace-branch-host:${workspaceId}`).textContent,
    ).toBe("feature/spring");
    expect(workspace.textContent).toContain("MacBook");
    expect(parentRow.textContent).not.toContain("Spring work");
    expect(toggle.textContent).toBe("2 subagents");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(queryByTestId("agent-row-host-child")).toBeNull();
    expect(queryByTestId("agent-row-host-other")).toBeNull();
  });

  it("collapses each heading independently and keeps its count and time visible", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T10:02:00.000Z"));
    const sibling = agent("sibling", { workspaceId: "sibling-workspace" });
    const { getByRole, getByTestId, queryByTestId } = render(
      <AgentList
        agents={[root, child, sibling]}
        ancestors={[]}
        activeWorkspaceIdsByServer={activeWorkspaceIdsByServer}
      />,
    );
    const workspaceTestID = `history-workspace-header-host:${workspaceId}`;
    const workspace = getByTestId(workspaceTestID);
    fireEvent.click(getByRole("button", { name: "Show subagents" }));
    expect(getByTestId("agent-row-host-child")).toBeDefined();
    fireEvent.click(workspace);
    expect(workspace.getAttribute("aria-expanded")).toBe("false");
    expect(queryByTestId("agent-row-host-root")).toBeNull();
    expect(queryByTestId("agent-row-host-child")).toBeNull();
    expect(getByTestId("agent-row-host-sibling")).toBeDefined();
    expect(within(workspace).getByText("2 sessions")).toBeDefined();
    expect(within(workspace).getByText("2m ago")).toBeDefined();
    fireEvent.click(getByRole("button", { name: "Expand workspace Spring work" }));
    expect(getByTestId("agent-row-host-root")).toBeDefined();

    const project = getByRole("button", { name: "Collapse project Atlas" });
    fireEvent.click(project);
    expect(project.getAttribute("aria-expanded")).toBe("false");
    expect(queryByTestId(workspaceTestID)).toBeNull();
    expect(queryByTestId("agent-row-host-sibling")).toBeNull();
    expect(within(project).getByText("2 workspaces")).toBeDefined();
    expect(within(project).getByText("2m ago")).toBeDefined();
    fireEvent.click(getByRole("button", { name: "Expand project Atlas" }));
    expect(getByTestId(workspaceTestID)).toBeDefined();
    expect(getByTestId("agent-row-host-root")).toBeDefined();
  });

  it("streams workspaces across projects using the selected time and shows their owning project", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T10:10:00.000Z"));
    const other = agent("boron", {
      workspaceId: "boron",
      createdAt: new Date("2026-04-02T10:05:00.000Z"),
      lastActivityAt: new Date("2026-04-02T10:09:00.000Z"),
      projectPlacement: { ...root.projectPlacement!, projectKey: "boron", projectName: "Boron" },
    });
    const { getByTestId, queryByTestId } = render(
      <AgentList
        agents={[other, root]}
        ancestors={[]}
        activeWorkspaceIdsByServer={activeWorkspaceIdsByServer}
        groupMode="workspace"
        sort={createdAscending}
      />,
    );
    const first = getByTestId(`history-workspace-header-host:${workspaceId}`);
    const second = getByTestId("history-workspace-header-host:boron");
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      within(first).getByTestId(`history-workspace-project-host:${workspaceId}`).textContent,
    ).toBe("Atlas");
    expect(within(second).getByTestId("history-workspace-project-host:boron").textContent).toBe(
      "Boron",
    );
    expect(queryByTestId("history-project-header-host:atlas")).toBeNull();
    expect(queryByTestId("history-project-header-host:boron")).toBeNull();
    expect(within(getByTestId("agent-row-host-boron")).getByText("5m ago")).toBeDefined();
  });

  it("highlights only fields in the selected search scope", () => {
    const matched = agent("spring", {
      title: "Spring session",
      projectPlacement: { ...root.projectPlacement!, projectName: "Spring project" },
    });
    const props = {
      agents: [matched],
      ancestors: [],
      activeWorkspaceIdsByServer,
      search: "spring",
    };
    const { getByTestId, rerender } = render(<AgentList {...props} searchScope="workspace" />);
    const project = getByTestId("history-project-name-host:atlas");
    const workspace = getByTestId(`history-workspace-name-host:${workspaceId}`);
    const branch = getByTestId(`history-workspace-branch-host:${workspaceId}`);
    const title = getByTestId("agent-row-title-host-spring");
    const isHighlighted = (el: HTMLElement) => Boolean(within(el).queryByText(/^spring$/i));
    expect([project, workspace, branch, title].map(isHighlighted)).toEqual([
      false,
      true,
      true,
      false,
    ]);

    rerender(<AgentList {...props} searchScope="agent" />);
    expect([project, workspace, branch, title].map(isHighlighted)).toEqual([
      false,
      false,
      false,
      true,
    ]);

    rerender(<AgentList {...props} />);
    expect([project, workspace, branch, title].map(isHighlighted)).toEqual([
      true,
      true,
      true,
      true,
    ]);

    const inlineProjectID = `history-workspace-project-host:${workspaceId}`;
    rerender(<AgentList {...props} groupMode="workspace" />);
    expect(isHighlighted(getByTestId(inlineProjectID))).toBe(true);
    rerender(<AgentList {...props} groupMode="workspace" searchScope="workspace" />);
    expect(isHighlighted(getByTestId(inlineProjectID))).toBe(false);
    rerender(<AgentList {...props} groupMode="workspace" searchScope="agent" />);
    expect(isHighlighted(getByTestId(inlineProjectID))).toBe(false);
  });

  it("shows a renamed workspace's directory only when search matches it", () => {
    const props = { agents: [root], ancestors: [], activeWorkspaceIdsByServer };
    const directoryId = `history-workspace-directory-host:${workspaceId}`;
    const { getByTestId, queryByTestId, rerender } = render(
      <AgentList {...props} search="atlas" searchScope="workspace" />,
    );
    const directory = getByTestId(directoryId);
    expect(directory.textContent).toBe("atlas");
    expect(within(directory).getByText("atlas")).not.toBe(directory);
    rerender(<AgentList {...props} search="spring" searchScope="workspace" />);
    expect(queryByTestId(directoryId)).toBeNull();
    rerender(<AgentList {...props} search="atlas" searchScope="agent" />);
    expect(queryByTestId(directoryId)).toBeNull();
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
    const { getByRole, getByTestId, queryByTestId } = renderSessions();
    const tabs = within(getByTestId("sessions-archive-scope-filter"));
    const archivedTab = tabs.getByTestId("sessions-tab-archived");
    const activeTab = tabs.getByTestId("sessions-tab-active");
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

  it("keeps expanded subagents after a sort loads and remounts the results", () => {
    const initial = historyResult({
      agents: [child],
      ancestors: [root],
      isQueryControlsSupported: true,
    });
    useAgentHistory.mockImplementation(({ sort }) =>
      sort?.field === "archived_at"
        ? historyResult({ isInitialLoad: true, isQueryControlsSupported: true })
        : initial,
    );
    const { getByRole, getByTestId, queryByTestId, rerender } = renderSessions();
    fireEvent.click(getByRole("button", { name: "Show subagents" }));
    expect(getByTestId("agent-row-host-child")).toBeDefined();

    fireEvent.click(getByRole("button", { name: "Archived (oldest)" }));
    expect(queryByTestId("agent-row-host-root")).toBeNull();

    useAgentHistory.mockReturnValue(initial);
    rerender(<SessionsScreen />);
    expect(getByTestId("agent-row-host-child")).toBeDefined();
  });

  it("keeps Load more reachable when an archive leaves a page without visible sessions", () => {
    const loadMore = vi.fn();
    const firstPage = historyResult({ agents: [root], hasMore: true, loadMore });
    useAgentHistory.mockImplementation(({ archiveScope }) =>
      archiveScope === "active" ? firstPage : historyResult({}),
    );
    const { getByRole, getByTestId, queryByTestId, rerender } = renderSessions();
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

  it("leaves archive-time sorting when switching to Active and resets collapsed workspaces", () => {
    useAgentHistory.mockReturnValue(
      historyResult({ agents: [root], isQueryControlsSupported: true }),
    );
    const { getByRole, getByTestId, queryByRole, queryByTestId } = renderSessions();
    fireEvent.click(getByRole("button", { name: "Archived (oldest)" }));
    expect(useAgentHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        archiveScope: "archived",
        sort: { field: "archived_at", direction: "asc" },
      }),
    );
    fireEvent.click(getByRole("button", { name: "Collapse workspace Spring work" }));
    expect(queryByTestId("agent-row-host-root")).toBeNull();

    fireEvent.click(getByTestId("sessions-tab-active"));
    expect(getByTestId("agent-row-host-root")).toBeDefined();
    expect(queryByRole("button", { name: "Archived (oldest)" })).toBeNull();
    expect(useAgentHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        archiveScope: "active",
        sort: { field: "updated_at", direction: "asc" },
      }),
    );
  });

  it("expands both levels after a project heading is collapsed", () => {
    const other = agent("boron", {
      workspaceId: "boron",
      projectPlacement: {
        ...root.projectPlacement!,
        projectKey: "boron",
        projectName: "Boron",
        workspaceName: "Boron work",
      },
    });
    const result = historyResult({ agents: [root, child, other] });
    useAgentHistory.mockReturnValue(result);
    const { getByRole, getByTestId, queryByTestId } = renderSessions();
    const toggleAll = getByTestId("sessions-collapse-all-button");

    fireEvent.click(getByRole("button", { name: "Collapse project Atlas" }));
    expect(queryByTestId(`history-workspace-header-host:${workspaceId}`)).toBeNull();
    fireEvent.click(toggleAll);
    expect(queryByTestId("agent-row-host-boron")).toBeNull();
    expect(toggleAll.textContent).toBe("Expand all");
    fireEvent.click(getByRole("button", { name: "Expand project Atlas" }));
    expect(getByTestId("agent-row-host-root")).toBeDefined();
    fireEvent.click(getByRole("button", { name: "Collapse project Atlas" }));
    fireEvent.click(toggleAll);
    expect(getByTestId("agent-row-host-root")).toBeDefined();
    expect(getByTestId("agent-row-host-boron")).toBeDefined();
    expect(toggleAll.textContent).toBe("Collapse all");

    fireEvent.click(toggleAll);
    expect(getByRole("button", { name: "Expand workspace Spring work" })).toBeDefined();
    expect(queryByTestId("agent-row-host-root")).toBeNull();
    fireEvent.click(toggleAll);
    expect(getByTestId("agent-row-host-root")).toBeDefined();
  });

  it("keeps observed projects selectable after an empty project result and can clear the filter", () => {
    const other = agent("boron", {
      projectPlacement: { ...root.projectPlacement!, projectKey: "boron", projectName: "Boron" },
    });
    const unfiltered = historyResult({ agents: [root, other] });
    const filtered = historyResult({});
    useAgentHistory.mockImplementation(({ projectKeysByServer }) =>
      projectKeysByServer ? filtered : unfiltered,
    );
    const { getByRole, getByTestId, queryByTestId } = renderSessions();
    const trigger = getByTestId("sessions-project-filter-trigger");
    fireEvent.click(trigger);
    fireEvent.click(getByRole("button", { name: "Atlas" }));
    expect(useAgentHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectKeysByServer: new Map([["host", ["atlas"]]]),
      }),
    );
    const empty = getByTestId("sessions-empty");
    expect(empty.textContent).toContain("No sessions match");
    fireEvent.click(trigger);
    expect(getByRole("button", { name: "Boron" })).toBeDefined();
    fireEvent.click(getByRole("button", { name: "Boron" }));
    fireEvent.click(within(empty).getByRole("button", { name: "All projects" }));
    expect(queryByTestId("sessions-empty")).toBeNull();
  });

  it("keeps new workspaces collapsed after loading another page and permits a single override", () => {
    const later = agent("later", {
      workspaceId: "later",
      projectPlacement: { ...root.projectPlacement!, workspaceName: "Later workspace" },
    });
    useAgentHistory.mockReturnValue(historyResult({ agents: [root], hasMore: true }));
    const { getByRole, getByTestId, queryByTestId, rerender } = renderSessions();
    const toggleAll = getByTestId("sessions-collapse-all-button");
    fireEvent.click(toggleAll);
    useAgentHistory.mockReturnValue(historyResult({ agents: [root, later] }));
    rerender(<SessionsScreen />);
    expect(toggleAll.textContent).toBe("Expand all");
    expect(queryByTestId("agent-row-host-later")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Expand workspace Later workspace" }));
    expect(getByTestId("agent-row-host-later").textContent).toContain(later.title);
    expect(queryByTestId("agent-row-host-root")).toBeNull();
    expect(toggleAll.textContent).toBe("Collapse all");
  });

  it("distinguishes same-named filter choices by the paths and hosts of their copies", () => {
    const project: ProjectDescriptor = {
      projectId: "atlas-one",
      projectKey: "remote:github.com/acme/atlas",
      projectDisplayName: "Atlas",
      projectCustomName: null,
      projectKind: "git",
      projectRootPath: "/repos/atlas",
    };
    historyCatalog.hosts = [
      { serverId: "host", label: "Mac" },
      { serverId: "peer", label: "Linux" },
    ];
    historyCatalog.projects = buildProjects({
      hosts: [
        {
          serverId: "host",
          serverName: "Mac",
          isOnline: true,
          workspaces: [],
          projects: [
            project,
            { ...project, projectId: "atlas-two", projectRootPath: "/temp/atlas" },
          ],
        },
        {
          serverId: "peer",
          serverName: "Linux",
          isOnline: true,
          workspaces: [],
          projects: [project],
        },
      ],
    }).projects;
    const entry = agent("root", {
      projectPlacement: { ...root.projectPlacement!, projectKey: project.projectId },
    });
    useAgentHistory.mockReturnValue(historyResult({ agents: [entry] }));
    const { getByRole, getByTestId } = renderSessions();
    const trigger = getByTestId("sessions-project-filter-trigger");
    fireEvent.click(trigger);
    expect(getByRole("button", { name: "Atlas · /repos/atlas (Linux)" })).toHaveProperty(
      "tagName",
      "BUTTON",
    );
    fireEvent.click(getByRole("button", { name: "Atlas · /temp/atlas (Mac)" }));
    expect(useAgentHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectKeysByServer: new Map([["host", ["atlas-two"]]]),
      }),
    );
    fireEvent.click(getByRole("button", { name: "Mac" }));
    fireEvent.click(trigger);
    fireEvent.click(getByRole("button", { name: "Atlas · /repos/atlas" }));
    expect(useAgentHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectKeysByServer: new Map([["host", ["atlas-one"]]]),
      }),
    );
  });

  it("distinguishes identical project paths on hosts with the same display name", () => {
    const project: ProjectDescriptor = {
      projectId: "atlas",
      projectKey: "remote:github.com/acme/atlas",
      projectDisplayName: "Atlas",
      projectCustomName: null,
      projectKind: "git",
      projectRootPath: "/repos/atlas",
    };
    historyCatalog.hosts = [
      { serverId: "host", label: "Mac" },
      { serverId: "peer", label: "Mac" },
    ];
    historyCatalog.projects = buildProjects({
      hosts: [
        {
          serverId: "host",
          serverName: "Mac",
          isOnline: true,
          workspaces: [],
          projects: [project],
        },
        {
          serverId: "peer",
          serverName: "Mac",
          isOnline: true,
          workspaces: [],
          projects: [{ ...project, projectKey: "remote:github.com/other/atlas" }],
        },
      ],
    }).projects;
    useAgentHistory.mockReturnValue(historyResult({}));
    const { getByRole, getByTestId } = renderSessions();
    fireEvent.click(getByTestId("sessions-project-filter-trigger"));
    expect(getByRole("button", { name: "Atlas · /repos/atlas (Mac · host)" })).toBeDefined();
    fireEvent.click(getByRole("button", { name: "Atlas · /repos/atlas (Mac · peer)" }));
    expect(useAgentHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectKeysByServer: new Map([["peer", ["atlas"]]]) }),
    );
  });

  it("unifies active and archived catalog placements and clears projects outside the selected host", async () => {
    const activeAtlas: ProjectDescriptor = {
      projectId: "atlas-active",
      projectKey: "shared-atlas",
      projectDisplayName: "Atlas",
      projectCustomName: "Atlas renamed",
      projectKind: "git",
      projectRootPath: "/active/atlas",
    };
    const archivedAtlas: ProjectDescriptor = {
      ...activeAtlas,
      projectId: "atlas-archived",
      projectCustomName: null,
      projectRootPath: "/archive/atlas",
    };
    const archivedBoron: ProjectDescriptor = {
      ...archivedAtlas,
      projectId: "boron-archived",
      projectDisplayName: "Boron",
      projectKey: "shared-boron",
    };
    historyCatalog.hosts = [
      { serverId: "legacy", label: "Legacy Mac" },
      { serverId: "current", label: "Current Mac" },
    ];
    historyCatalog.projects = buildProjects({
      hosts: [
        {
          serverId: "legacy",
          serverName: "Legacy Mac",
          isOnline: true,
          projects: [activeAtlas],
          workspaces: [],
        },
      ],
    }).projects;
    historyCatalog.sessions = {
      legacy: { workspaces: new Map(), serverInfo: { features: {} } },
      current: {
        workspaces: new Map(),
        serverInfo: { features: { agentHistoryQueryControls: true } },
      },
    };
    historyCatalog.statuses.set("legacy", "online");
    historyCatalog.statuses.set("current", "online");
    const listProjects = vi.fn(async () => ({ projects: [archivedAtlas, archivedBoron] }));
    historyCatalog.getClient.mockImplementation((serverId) =>
      serverId === "current" ? { listProjects } : null,
    );
    useAgentHistory.mockReturnValue(historyResult({}));

    const { getByRole, getByTestId, findByRole, queryByRole } = renderSessions();
    const trigger = getByTestId("sessions-project-filter-trigger");
    fireEvent.click(trigger);
    await findByRole("button", { name: "Boron" });
    expect(listProjects).toHaveBeenCalledExactlyOnceWith({ includeArchived: true });
    expect(historyCatalog.getClient).toHaveBeenCalledExactlyOnceWith("current");
    fireEvent.click(getByRole("button", { name: "Atlas renamed" }));
    expect(useAgentHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectKeysByServer: new Map([
          ["current", ["atlas-archived"]],
          ["legacy", ["atlas-active"]],
        ]),
      }),
    );
    fireEvent.click(trigger);
    fireEvent.click(getByRole("button", { name: "Boron" }));
    fireEvent.click(getByRole("button", { name: "Legacy Mac" }));
    await waitFor(() =>
      expect(useAgentHistory).toHaveBeenLastCalledWith(
        expect.objectContaining({
          serverId: "legacy",
          projectKeysByServer: undefined,
        }),
      ),
    );
    fireEvent.click(trigger);
    expect(queryByRole("button", { name: "Boron" })).toBeNull();
  });

  it("reuses the history catalog inputs when a render leaves the query data unchanged", () => {
    const project: ProjectDescriptor = {
      projectId: "archived-atlas",
      projectKey: "shared-atlas",
      projectDisplayName: "Atlas",
      projectCustomName: null,
      projectKind: "git",
      projectRootPath: "/archive/atlas",
    };
    historyCatalog.hosts = [{ serverId: "host", label: "MacBook" }];
    historyCatalog.statuses.set("host", "online");
    const queryClient = new QueryClient();
    queryClient.setQueryData(["historyProjectCatalog", "host"], {
      serverId: "host",
      projects: [project],
    });
    const input = { selectedHost: "host", agents: [], ancestors: [] };
    const { result, rerender } = renderHook(() => useHistoryProjectOptions(input), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
    const { options, catalogEquivalenceCounts } = result.current;
    expect(options.map(({ label }) => label)).toEqual(["Atlas"]);
    expect(catalogEquivalenceCounts.get("host")?.get("shared-atlas")).toBe(1);

    rerender();
    expect(result.current.catalogEquivalenceCounts).toBe(catalogEquivalenceCounts);
    expect(result.current.options).toBe(options);
  });

  it("retains a selected placement when the complete catalog splits it from another host", async () => {
    const remote = "remote:github.com/acme/atlas";
    const project: ProjectDescriptor = {
      projectId: "atlas",
      projectKey: remote,
      projectDisplayName: "Atlas",
      projectCustomName: null,
      projectKind: "git",
      projectRootPath: "/repos/atlas",
    };
    historyCatalog.hosts = [
      { serverId: "host", label: "Mac" },
      { serverId: "peer", label: "Linux" },
    ];
    historyCatalog.projects = buildProjects({
      hosts: historyCatalog.hosts.map(({ serverId, label }) => ({
        serverId,
        serverName: label,
        isOnline: true,
        projects: [project],
        workspaces: [],
      })),
    }).projects;
    historyCatalog.sessions = {
      host: {
        workspaces: new Map(),
        projects: new Map([["atlas", project]]),
        serverInfo: { features: { agentHistoryQueryControls: true } },
      },
      peer: { workspaces: new Map(), projects: new Map([["atlas", project]]) },
    };
    historyCatalog.statuses.set("host", "online");
    const catalog = Promise.withResolvers<{ projects: ProjectDescriptor[] }>();
    historyCatalog.getClient.mockReturnValue({ listProjects: () => catalog.promise });
    const entry = agent("root", {
      projectPlacement: { ...root.projectPlacement!, projectEquivalenceKey: remote },
    });
    useAgentHistory.mockReturnValue(historyResult({ agents: [entry] }));

    const { getByRole, getByTestId, findByTestId, queryByTestId } = renderSessions();
    fireEvent.click(getByTestId("sessions-project-filter-trigger"));
    fireEvent.click(getByRole("button", { name: "Atlas" }));
    fireEvent.click(getByRole("button", { name: "Collapse project Atlas" }));
    expect(getByTestId(`history-project-header-eq:${remote}`)).toBeDefined();

    catalog.resolve({
      projects: [
        project,
        { ...project, projectId: "atlas-old", projectDisplayName: "Atlas (old)" },
      ],
    });
    expect(
      (await findByTestId("history-project-header-host:atlas")).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(queryByTestId("agent-row-host-root")).toBeNull();
    expect(useAgentHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectKeysByServer: new Map([
          ["host", ["atlas"]],
          ["peer", ["atlas"]],
        ]),
      }),
    );
    fireEvent.click(getByRole("button", { name: "Expand project Atlas" }));
    expect(getByTestId("agent-row-host-root")).toBeDefined();
  });

  it("keeps an active ancestor above its archived child and puts the workspace badge on the header", () => {
    vi.useFakeTimers();
    const { getByRole, getByTestId, queryByTestId } = render(
      <AgentList
        agents={[child]}
        ancestors={[root]}
        activeWorkspaceIdsByServer={new Map([["host", new Set()]])}
      />,
    );
    const parentRow = getByTestId("agent-row-host-root");
    expect(
      within(getByTestId(`history-workspace-header-host:${workspaceId}`)).getByText("Archived"),
    ).toBeDefined();
    expect(within(parentRow).queryByText("Archived")).toBeNull();
    expect(queryByTestId("agent-row-host-child")).toBeNull();

    fireEvent.click(getByRole("button", { name: "Show subagents" }));
    const childRow = getByTestId("agent-row-host-child");
    expect(
      parentRow.compareDocumentPosition(childRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(childRow).queryByText("Archived")).toBeNull();
    fireEvent.mouseDown(parentRow, { button: 0 });
    act(() => vi.advanceTimersByTime(600));
    fireEvent.mouseUp(parentRow, { button: 0 });
    expect(archiveAgent).not.toHaveBeenCalled();
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
