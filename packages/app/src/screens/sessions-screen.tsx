import {
  useMemo,
  useState,
  useCallback,
  useEffect,
  type ReactElement,
  type ReactNode,
} from "react";
import { View, Text } from "react-native";
import { useIsFocused } from "expo-router/react-navigation";
import { router } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronLeft, Import } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useShallow } from "zustand/shallow";
import equal from "fast-deep-equal/es6";
import type { AgentHistorySearchScope } from "@getpaseo/protocol/messages";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  AgentList,
  DEFAULT_HISTORY_GROUP_EXPANSION,
  type HistoryGroupExpansion,
} from "@/components/agent-list";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import {
  type AgentHistoryArchiveScope,
  type AgentHistoryHostError,
  useAgentHistory,
} from "@/hooks/use-agent-history";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useImportSession } from "@/hooks/use-import-session";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import {
  areAllHistoryWorkspacesCollapsed,
  buildAllWorkspacesExpansionMap,
  buildHistoryProjectGroups,
  DEFAULT_HISTORY_SORT,
  type HistoryGroupMode,
  type HistorySortOption,
} from "./sessions/history-grouping";
import {
  ALL_PROJECTS_OPTION_ID,
  HistoryProjectFilter,
  resolveHistoryProjectSelection,
  type HistoryProjectOption,
  useHistoryProjectOptions,
} from "./sessions/project-filter";

/** Long enough that a typed word is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 200;
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedSpinnerColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const sessionsHostOptionTestID = (serverId: string) => `sessions-host-filter-item-${serverId}`;
const SEARCH_SCOPE_LABELS = {
  all: "sessions.searchScope.all",
  workspace: "sessions.searchScope.workspace",
  agent: "sessions.searchScope.agent",
} as const;
const SEARCH_PLACEHOLDERS = {
  all: "sessions.searchPlaceholder",
  workspace: "sessions.searchPlaceholderWorkspace",
  agent: "sessions.searchPlaceholderAgent",
} as const;
const SORT_OPTIONS = [
  { field: "updated_at", direction: "desc", label: "sessions.sort.recentDesc" },
  { field: "updated_at", direction: "asc", label: "sessions.sort.recentAsc" },
  { field: "created_at", direction: "desc", label: "sessions.sort.createdDesc" },
  { field: "created_at", direction: "asc", label: "sessions.sort.createdAsc" },
  { field: "archived_at", direction: "desc", label: "sessions.sort.archivedDesc" },
  { field: "archived_at", direction: "asc", label: "sessions.sort.archivedAsc" },
] as const;
const GROUP_MODE_LABELS = {
  project: "sessions.sort.groupByProject",
  workspace: "sessions.sort.streamByWorkspace",
} as const;
const SEARCH_SCOPES = ["all", "workspace", "agent"] as const;
const GROUP_MODES = ["project", "workspace"] as const;

/**
 * A host that failed while others answered. Without this the list silently
 * under-reports, and under a query "No sessions match" becomes a claim the app
 * has no basis for.
 */
function SessionHostErrorsBanner({
  errors,
  t,
}: {
  errors: AgentHistoryHostError[];
  t: TFunction;
}): ReactElement {
  return (
    <View style={styles.errorsBannerWrap}>
      <View style={styles.errorsBanner} testID="sessions-host-errors">
        {errors.map((error) => (
          <Text key={error.serverId} style={styles.errorsBannerText}>
            {t("sessions.hostLoadFailed", { host: error.serverName })}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** An empty list means something different once a query is narrowing it. */
function resolveEmptyText(input: {
  t: TFunction;
  hasActiveFilter: boolean;
  isAllHosts: boolean;
  isArchiveScopeSupported: boolean;
  selectedTab: AgentHistoryArchiveScope;
}): string {
  if (input.hasActiveFilter) return input.t("sessions.noMatches");
  if (!input.isAllHosts) return input.t("sessions.emptyHost");
  if (!input.isArchiveScopeSupported) return input.t("sessions.empty");
  return input.t(
    input.selectedTab === "archived" ? "sessions.emptyArchived" : "sessions.emptyActive",
  );
}

function HistoryEmptyActions({
  clearSearch,
  clearProject,
  goBack,
  openImport,
}: {
  clearSearch?: () => void;
  clearProject?: () => void;
  goBack: () => void;
  openImport: () => void;
}) {
  const { t } = useTranslation();
  let navigationLabel = "Back";
  if (clearProject) navigationLabel = t("sessions.projectFilter.all");
  else if (clearSearch) navigationLabel = t("sessions.actions.clearSearch");
  return (
    <>
      <Button
        variant="ghost"
        leftIcon={clearProject || clearSearch ? undefined : ChevronLeft}
        onPress={clearProject ?? clearSearch ?? goBack}
      >
        {navigationLabel}
      </Button>
      <Button variant="outline" leftIcon={Import} onPress={openImport}>
        {t("importSession.title")}
      </Button>
    </>
  );
}

function HistoryResults({
  isLoading,
  isError,
  showList,
  onRetry,
  empty,
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  showList: boolean;
  onRetry: () => void;
  empty: ReactNode;
  children: ReactNode;
}) {
  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ThemedLoadingSpinner size="large" uniProps={mutedSpinnerColor} />
      </View>
    );
  }
  if (showList) return children;
  if (isError) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>Unable to load sessions</Text>
        <Button variant="ghost" onPress={onRetry}>
          Try again
        </Button>
      </View>
    );
  }
  return (
    <View style={styles.emptyContainer} testID="sessions-empty">
      {empty}
    </View>
  );
}

export function SessionsScreen() {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <SessionsScreenContent />;
}

interface SessionFiltersProps {
  hosts: ReturnType<typeof useHosts>;
  selectedHost: string;
  onSelectHost: (host: string) => void;
  selectedTab: AgentHistoryArchiveScope;
  onSelectTab: (tab: AgentHistoryArchiveScope) => void;
  searchInput: string;
  searchFieldVersion: number;
  onSearchChange: (search: string) => void;
  isSearchSupported: boolean;
  isArchiveScopeSupported: boolean;
  isQueryControlsSupported: boolean;
  searchScope: AgentHistorySearchScope;
  onSelectSearchScope: (scope: AgentHistorySearchScope) => void;
  selectedProject: string;
  projectOptions: readonly HistoryProjectOption[];
  onSelectProject: (id: string) => void;
  sort: HistorySortOption;
  onSelectSort: (sort: HistorySortOption) => void;
  groupMode: HistoryGroupMode;
  onSelectGroupMode: (mode: HistoryGroupMode) => void;
  showList: boolean;
  allCollapsed: boolean;
  onToggleCollapseAll: () => void;
}

function HistoryMenuChoice<Value>({
  children,
  selected,
  value,
  onChange,
}: {
  children: ReactNode;
  selected: boolean;
  value: Value;
  onChange: (value: Value) => void;
}) {
  const onSelect = useCallback(() => onChange(value), [onChange, value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={onSelect}>
      {children}
    </DropdownMenuItem>
  );
}

function SessionFilters({
  hosts,
  selectedHost,
  onSelectHost,
  selectedTab,
  onSelectTab,
  searchInput,
  searchFieldVersion,
  onSearchChange,
  isSearchSupported,
  isArchiveScopeSupported,
  isQueryControlsSupported,
  searchScope,
  onSelectSearchScope,
  selectedProject,
  projectOptions,
  onSelectProject,
  sort,
  onSelectSort,
  groupMode,
  onSelectGroupMode,
  showList,
  allCollapsed,
  onToggleCollapseAll,
}: SessionFiltersProps) {
  const { t } = useTranslation();
  const tabs = useMemo<SegmentedControlOption<AgentHistoryArchiveScope>[]>(
    () => [
      { value: "archived", label: t("sessions.tabs.archived"), testID: "sessions-tab-archived" },
      { value: "active", label: t("sessions.tabs.active"), testID: "sessions-tab-active" },
    ],
    [t],
  );
  const scopeLabel = t("sessions.searchScope.label");
  const selectedScopeLabel = t(SEARCH_SCOPE_LABELS[searchScope]);
  const sortLabel = t("sessions.sort.label");
  const allowArchivedSort =
    selectedTab === "archived" && isArchiveScopeSupported && isQueryControlsSupported;
  const sortOptions = SORT_OPTIONS.filter(
    ({ field }) => field !== "archived_at" || allowArchivedSort,
  );

  return (
    <View style={styles.filterContainer}>
      {isArchiveScopeSupported ? (
        <SegmentedControl
          value={selectedTab}
          onValueChange={onSelectTab}
          options={tabs}
          testID="sessions-archive-scope-filter"
        />
      ) : null}
      <View style={styles.filterRow}>
        {isSearchSupported ? (
          <View style={styles.searchSlot}>
            <SearchField
              key={searchFieldVersion}
              value={searchInput}
              onChangeText={onSearchChange}
              placeholder={t(SEARCH_PLACEHOLDERS[searchScope])}
              clearAccessibilityLabel={t("sessions.actions.clearSearch")}
              testID="sessions-search-input"
              clearTestID="sessions-search-clear"
            />
          </View>
        ) : null}
        {isSearchSupported && isQueryControlsSupported ? (
          <DropdownMenu>
            <DropdownTrigger
              size="md"
              testID="sessions-search-scope-trigger"
              accessibilityLabel={`${scopeLabel}: ${selectedScopeLabel}`}
            >
              {selectedScopeLabel}
            </DropdownTrigger>
            <DropdownMenuContent side="bottom" align="start" width={220} sheetTitle={scopeLabel}>
              {SEARCH_SCOPES.map((scope) => (
                <HistoryMenuChoice
                  key={scope}
                  selected={searchScope === scope}
                  value={scope}
                  onChange={onSelectSearchScope}
                >
                  {t(SEARCH_SCOPE_LABELS[scope])}
                </HistoryMenuChoice>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {projectOptions.length > 0 || selectedProject !== ALL_PROJECTS_OPTION_ID ? (
          <HistoryProjectFilter
            options={projectOptions}
            value={selectedProject}
            onSelect={onSelectProject}
          />
        ) : null}
        <DropdownMenu>
          <DropdownTrigger size="md" testID="sessions-sort-trigger">
            {sortLabel}
          </DropdownTrigger>
          <DropdownMenuContent side="bottom" align="start" width={260} sheetTitle={sortLabel}>
            <DropdownMenuLabel>{t("sessions.sort.sectionOrder")}</DropdownMenuLabel>
            {sortOptions.map((option) => (
              <HistoryMenuChoice
                key={option.label}
                selected={sort.field === option.field && sort.direction === option.direction}
                value={option}
                onChange={onSelectSort}
              >
                {t(option.label)}
              </HistoryMenuChoice>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("sessions.sort.sectionGrouping")}</DropdownMenuLabel>
            {GROUP_MODES.map((mode) => (
              <HistoryMenuChoice
                key={mode}
                selected={groupMode === mode}
                value={mode}
                onChange={onSelectGroupMode}
              >
                {t(GROUP_MODE_LABELS[mode])}
              </HistoryMenuChoice>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {showList ? (
          <Button
            variant="ghost"
            size="md"
            onPress={onToggleCollapseAll}
            testID="sessions-collapse-all-button"
          >
            {t(allCollapsed ? "sessions.actions.expandAll" : "sessions.actions.collapseAll")}
          </Button>
        ) : null}
        {hosts.length > 1 ? (
          <HostFilter
            hosts={hosts}
            selectedHost={selectedHost}
            onSelectHost={onSelectHost}
            triggerTestID="sessions-host-filter-trigger"
            hostOptionTestID={sessionsHostOptionTestID}
          />
        ) : null}
      </View>
    </View>
  );
}

function SessionsScreenContent() {
  const { t } = useTranslation();
  const importSession = useImportSession();
  const hosts = useHosts();
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);
  const [selectedTab, setSelectedTab] = useState<AgentHistoryArchiveScope>("archived");
  const [searchInput, setSearchInput] = useState("");
  const [searchFieldVersion, setSearchFieldVersion] = useState(0);
  const [searchScope, setSearchScope] = useState<AgentHistorySearchScope>("all");
  const [projectSelection, setProjectSelection] = useState<HistoryProjectOption | null>(null);
  const selectedProject = projectSelection?.id ?? ALL_PROJECTS_OPTION_ID;
  const [sort, setSort] = useState<HistorySortOption>(DEFAULT_HISTORY_SORT);
  const [groupMode, setGroupMode] = useState<HistoryGroupMode>("project");
  const search = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS).trim();
  const historyServerId = selectedHost === ALL_HOSTS_OPTION_ID ? null : selectedHost;
  const {
    agents,
    ancestors,
    hasMore,
    isInitialLoad,
    isLoadingMore,
    isError,
    isSearchSupported,
    isArchiveScopeSupported,
    isQueryControlsSupported,
    effectiveSort,
    isSearchTruncated,
    hostErrors,
    loadMore,
    refreshAll,
  } = useAgentHistory({
    serverId: historyServerId,
    search,
    archiveScope: selectedTab,
    searchScope,
    sort,
    projectKeysByServer: projectSelection?.projectKeysByServer,
  });
  const isSearching = isSearchSupported && search.length > 0;
  const effectiveSearchScope = isQueryControlsSupported ? searchScope : "all";
  const effectiveSearch = isSearching ? search : "";
  const projectOptions = useHistoryProjectOptions({ selectedHost, agents, ancestors });
  // The catalog can gain project placements while history is already filtered.
  useEffect(() => {
    if (!projectSelection) return;
    const current = resolveHistoryProjectSelection(projectSelection, projectOptions);
    if (!equal(current, projectSelection)) setProjectSelection(current);
  }, [projectOptions, projectSelection]);
  const workspacesByServer = useSessionStore(
    useShallow((state) =>
      Object.fromEntries(
        Object.entries(state.sessions).map(([serverId, session]) => [serverId, session.workspaces]),
      ),
    ),
  );
  const activeWorkspaceIdsByServer = useMemo(
    () =>
      new Map(
        Object.entries(workspacesByServer).map(([serverId, workspaces]) => [
          serverId,
          new Set(workspaces.keys()),
        ]),
      ),
    [workspacesByServer],
  );
  const groups = useMemo(
    () =>
      buildHistoryProjectGroups({
        entries: agents,
        ancestors,
        activeWorkspaceIdsByServer,
        search: effectiveSearch,
        sort: effectiveSort,
      }),
    [agents, ancestors, activeWorkspaceIdsByServer, effectiveSearch, effectiveSort],
  );
  const expansionKey = JSON.stringify([
    selectedTab,
    effectiveSearch,
    effectiveSearchScope,
    selectedProject,
    selectedHost,
    groupMode,
  ]);
  const initialExpansion = { key: expansionKey, ...DEFAULT_HISTORY_GROUP_EXPANSION };
  const [expansion, setExpansion] = useState(initialExpansion);
  if (expansion.key !== expansionKey) setExpansion(initialExpansion);
  const groupExpansion = expansion.key === expansionKey ? expansion : initialExpansion;
  const allCollapsed = areAllHistoryWorkspacesCollapsed({ groups, groupMode, ...groupExpansion });
  const handleToggleCollapseAll = useCallback(() => {
    setExpansion((current) => {
      if (allCollapsed) return { key: current.key, ...DEFAULT_HISTORY_GROUP_EXPANSION };
      const visibleProjects =
        groupMode === "workspace"
          ? groups
          : groups.filter((project) => current.projectExpandedOverrides.get(project.key) !== false);
      const workspaceExpandedOverrides = new Map([
        ...current.workspaceExpandedOverrides,
        ...buildAllWorkspacesExpansionMap(visibleProjects, false),
      ]);
      return { ...current, workspaceExpandedOverrides };
    });
  }, [allCollapsed, groupMode, groups]);
  const toggleGroup = useCallback(
    (group: keyof HistoryGroupExpansion, key: string, expanded: boolean) => {
      setExpansion((current) => {
        const overrides = new Map(current[group]);
        overrides.set(key, expanded);
        return { ...current, [group]: overrides };
      });
    },
    [],
  );
  const toggleProject = useCallback(
    (key: string, expanded: boolean) => toggleGroup("projectExpandedOverrides", key, expanded),
    [toggleGroup],
  );
  const toggleWorkspace = useCallback(
    (key: string, expanded: boolean) => toggleGroup("workspaceExpandedOverrides", key, expanded),
    [toggleGroup],
  );
  const listGroupExpansion = useMemo(
    () => ({
      ...groupExpansion,
      onToggleProject: toggleProject,
      onToggleWorkspace: toggleWorkspace,
    }),
    [groupExpansion, toggleProject, toggleWorkspace],
  );

  useEffect(() => {
    if (
      selectedHost !== ALL_HOSTS_OPTION_ID &&
      !hosts.some((host) => host.serverId === selectedHost)
    ) {
      setSelectedHost(ALL_HOSTS_OPTION_ID);
    }
  }, [hosts, selectedHost]);

  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    void refreshAll().finally(() => setIsManualRefresh(false));
  }, [refreshAll]);

  const emptyText = resolveEmptyText({
    t,
    hasActiveFilter: isSearching || selectedProject !== ALL_PROJECTS_OPTION_ID,
    isAllHosts: selectedHost === ALL_HOSTS_OPTION_ID,
    isArchiveScopeSupported,
    selectedTab,
  });
  const showList = agents.length > 0 || hasMore;

  const handleBack = useCallback(() => {
    router.navigate(buildOpenProjectRoute());
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchInput("");
    setSearchFieldVersion((version) => version + 1);
  }, []);
  const handleClearProject = useCallback(() => setProjectSelection(null), []);
  const handleSelectSort = useCallback(
    ({ field, direction }: HistorySortOption) => setSort({ field, direction }),
    [],
  );
  const handleSelectProject = useCallback(
    (id: string) => setProjectSelection(projectOptions.find((option) => option.id === id) ?? null),
    [projectOptions],
  );
  const handleSelectTab = useCallback((tab: AgentHistoryArchiveScope) => {
    setSelectedTab(tab);
    if (tab === "active") {
      setSort((current) =>
        current.field === "archived_at"
          ? { field: "updated_at", direction: current.direction }
          : current,
      );
    }
  }, []);

  const listFooterComponent = useMemo(() => {
    // COMPAT(historyPagination): old daemons return a truncated relevance page.
    // Added in v0.8.0; remove after 2027-03-16 once the daemon floor supports search pagination.
    if (isSearchTruncated) {
      return (
        <View style={styles.footer}>
          <Text style={styles.footerHint}>{t("sessions.tooManyMatches")}</Text>
        </View>
      );
    }
    if (!hasMore) {
      return null;
    }
    return (
      <View style={styles.footer}>
        <Button variant="ghost" onPress={loadMore} disabled={isLoadingMore}>
          {isLoadingMore ? "Loading..." : t("sessions.actions.loadMore")}
        </Button>
      </View>
    );
  }, [hasMore, isLoadingMore, isSearchTruncated, loadMore, t]);

  return (
    <View style={styles.container}>
      <MenuHeader title={t("sessions.title")} />
      <SessionFilters
        hosts={hosts}
        selectedHost={selectedHost}
        onSelectHost={setSelectedHost}
        selectedTab={selectedTab}
        onSelectTab={handleSelectTab}
        searchInput={searchInput}
        searchFieldVersion={searchFieldVersion}
        onSearchChange={setSearchInput}
        isSearchSupported={isSearchSupported}
        isArchiveScopeSupported={isArchiveScopeSupported}
        isQueryControlsSupported={isQueryControlsSupported}
        searchScope={effectiveSearchScope}
        onSelectSearchScope={setSearchScope}
        selectedProject={selectedProject}
        projectOptions={projectOptions}
        onSelectProject={handleSelectProject}
        sort={effectiveSort}
        onSelectSort={handleSelectSort}
        groupMode={groupMode}
        onSelectGroupMode={setGroupMode}
        showList={showList}
        allCollapsed={allCollapsed}
        onToggleCollapseAll={handleToggleCollapseAll}
      />
      {hostErrors.length > 0 ? <SessionHostErrorsBanner errors={hostErrors} t={t} /> : null}
      <HistoryResults
        isLoading={isInitialLoad}
        isError={isError}
        showList={showList}
        onRetry={handleRefresh}
        empty={
          <>
            <Text style={styles.emptyText}>{emptyText}</Text>
            <HistoryEmptyActions
              clearSearch={isSearching ? handleClearSearch : undefined}
              clearProject={projectSelection ? handleClearProject : undefined}
              goBack={handleBack}
              openImport={importSession.open}
            />
          </>
        }
      >
        <AgentList
          key={JSON.stringify([selectedHost, selectedProject])}
          agents={agents}
          ancestors={ancestors}
          groups={groups}
          archiveScope={isArchiveScopeSupported ? selectedTab : undefined}
          activeWorkspaceIdsByServer={activeWorkspaceIdsByServer}
          isRefreshing={isManualRefresh}
          onRefresh={handleRefresh}
          listFooterComponent={listFooterComponent}
          showHostColumn={hosts.length > 1}
          search={effectiveSearch}
          searchScope={effectiveSearchScope}
          sort={effectiveSort}
          groupMode={groupMode}
          groupExpansion={listGroupExpansion}
        />
      </HistoryResults>
      {importSession.sheet}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  filterContainer: {
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[4],
  },
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    alignSelf: "stretch",
    minWidth: 0,
  },
  searchSlot: {
    flexDirection: "row",
    flexBasis: { xs: "100%", md: 220 },
    flexGrow: 1,
    maxWidth: { xs: "100%", md: 420 },
    minWidth: 0,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  footer: {
    alignItems: "center",
    paddingVertical: theme.spacing[4],
  },
  footerHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  errorsBannerWrap: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[3],
  },
  errorsBanner: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  errorsBannerText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
