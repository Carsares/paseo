import { useMemo, useState, useCallback, useEffect, type ReactElement } from "react";
import { View, Text } from "react-native";
import { useIsFocused } from "expo-router/react-navigation";
import { router } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronLeft, Import } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useShallow } from "zustand/shallow";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { AgentList } from "@/components/agent-list";
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

/** Long enough that a typed word is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 200;
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedSpinnerColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const sessionsHostOptionTestID = (serverId: string) => `sessions-host-filter-item-${serverId}`;

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
  isSearching: boolean;
  isAllHosts: boolean;
  isArchiveScopeSupported: boolean;
  selectedTab: AgentHistoryArchiveScope;
}): string {
  if (input.isSearching) return input.t("sessions.noMatches");
  if (!input.isAllHosts) return input.t("sessions.emptyHost");
  if (!input.isArchiveScopeSupported) return input.t("sessions.empty");
  return input.t(
    input.selectedTab === "archived" ? "sessions.emptyArchived" : "sessions.emptyActive",
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
  onSearchChange: (search: string) => void;
  isSearchSupported: boolean;
  isArchiveScopeSupported: boolean;
}

function SessionFilters({
  hosts,
  selectedHost,
  onSelectHost,
  selectedTab,
  onSelectTab,
  searchInput,
  onSearchChange,
  isSearchSupported,
  isArchiveScopeSupported,
}: SessionFiltersProps) {
  const { t } = useTranslation();
  const tabs = useMemo<SegmentedControlOption<AgentHistoryArchiveScope>[]>(
    () => [
      { value: "archived", label: t("sessions.tabs.archived") },
      { value: "active", label: t("sessions.tabs.active") },
    ],
    [t],
  );
  const showHostFilter = hosts.length > 1;
  const showFilterRow = showHostFilter || isSearchSupported;
  if (!isArchiveScopeSupported && !showFilterRow) return null;

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
      {showFilterRow ? (
        <View style={styles.filterRow}>
          {isSearchSupported ? (
            <SearchField
              value={searchInput}
              onChangeText={onSearchChange}
              placeholder={t("sessions.searchPlaceholder")}
              clearAccessibilityLabel={t("sessions.actions.clearSearch")}
              testID="sessions-search-input"
              clearTestID="sessions-search-clear"
            />
          ) : null}
          {showHostFilter ? (
            <HostFilter
              hosts={hosts}
              selectedHost={selectedHost}
              onSelectHost={onSelectHost}
              triggerTestID="sessions-host-filter-trigger"
              hostOptionTestID={sessionsHostOptionTestID}
            />
          ) : null}
        </View>
      ) : null}
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
    isSearchTruncated,
    hostErrors,
    loadMore,
    refreshAll,
  } = useAgentHistory({
    serverId: historyServerId,
    search,
    archiveScope: selectedTab,
  });
  const isSearching = isSearchSupported && search.length > 0;
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
    isSearching,
    isAllHosts: selectedHost === ALL_HOSTS_OPTION_ID,
    isArchiveScopeSupported,
    selectedTab,
  });
  const showList = agents.length > 0 || hasMore;
  const showLoadError = isError && !showList;

  const handleBack = useCallback(() => {
    router.navigate(buildOpenProjectRoute());
  }, []);

  const handleClearSearch = useCallback(() => setSearchInput(""), []);

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
        onSelectTab={setSelectedTab}
        searchInput={searchInput}
        onSearchChange={setSearchInput}
        isSearchSupported={isSearchSupported}
        isArchiveScopeSupported={isArchiveScopeSupported}
      />
      {hostErrors.length > 0 ? <SessionHostErrorsBanner errors={hostErrors} t={t} /> : null}
      {isInitialLoad ? (
        <View style={styles.loadingContainer}>
          <ThemedLoadingSpinner size="large" uniProps={mutedSpinnerColor} />
        </View>
      ) : null}
      {!isInitialLoad && showLoadError ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>Unable to load sessions</Text>
          <Button variant="ghost" onPress={handleRefresh}>
            Try again
          </Button>
        </View>
      ) : null}
      {!isInitialLoad && !showLoadError && !showList ? (
        <View style={styles.emptyContainer} testID="sessions-empty">
          <Text style={styles.emptyText}>{emptyText}</Text>
          {isSearching ? (
            <Button variant="ghost" onPress={handleClearSearch}>
              {t("sessions.actions.clearSearch")}
            </Button>
          ) : (
            <Button variant="ghost" leftIcon={ChevronLeft} onPress={handleBack}>
              Back
            </Button>
          )}
          <Button variant="ghost" leftIcon={Import} onPress={importSession.open}>
            {t("importSession.title")}
          </Button>
        </View>
      ) : null}
      {!isInitialLoad && showList ? (
        <AgentList
          key={selectedHost}
          agents={agents}
          ancestors={ancestors}
          archiveScope={isArchiveScopeSupported ? selectedTab : undefined}
          activeWorkspaceIdsByServer={activeWorkspaceIdsByServer}
          isRefreshing={isManualRefresh}
          onRefresh={handleRefresh}
          listFooterComponent={listFooterComponent}
          showHostColumn={hosts.length > 1}
          search={isSearching ? search : undefined}
        />
      ) : null}
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
    flexDirection: { xs: "column", md: "row" },
    alignItems: { xs: "flex-start", md: "center" },
    gap: theme.spacing[2],
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[4],
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    alignSelf: "stretch",
    flexGrow: 1,
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
