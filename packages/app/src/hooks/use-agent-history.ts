import type {
  DaemonClient,
  FetchAgentHistoryOptions,
  FetchAgentHistoryPageInfo,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentHistorySearchScope } from "@getpaseo/protocol/messages";
import { hashKey, keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import {
  DEFAULT_HISTORY_SORT,
  resolveHistoryAgentTimestamp,
  type HistorySortOption,
} from "@/screens/sessions/history-grouping";
import { useSessionStore } from "@/stores/session-store";
import { buildAgentDirectoryState } from "@/utils/agent-directory-sync";
import { agentHistoryQueryKey, allAgentHistoryQueryKey } from "./agent-history-query-key";

const AGENT_HISTORY_PAGE_LIMIT = 200;
const AGENT_HISTORY_ALL_HOSTS_FAILED_MESSAGE = "No connected hosts could load agent history";

export type AgentHistoryArchiveScope = Exclude<
  FetchAgentHistoryOptions["archiveScope"],
  "all" | undefined
>;

export interface AgentHistoryResult {
  agents: AggregatedAgent[];
  ancestors: AggregatedAgent[];
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  /** False when any target host predates search; the screen hides the field. */
  isSearchSupported: boolean;
  isArchiveScopeSupported: boolean;
  isQueryControlsSupported: boolean;
  effectiveSort: HistorySortOption;
  /** More sessions matched than the ranked page holds. Narrow the query. */
  isSearchTruncated: boolean;
  /** The agents answer the previous query; the current one is loading (`keepPreviousResults`). */
  isPreviousResults: boolean;
  /** Hosts that failed while others succeeded. The list still renders. */
  hostErrors: AgentHistoryHostError[];
  refreshAll: () => Promise<void>;
  loadMore: () => void;
}

export interface AgentHistoryPage {
  agents: AggregatedAgent[];
  ancestors: AggregatedAgent[];
  pageInfo: FetchAgentHistoryPageInfo;
  /** More matched this host's query than its page could hold. */
  isSearchTruncated: boolean;
}

export type AgentHistoryClient = Pick<DaemonClient, "fetchAgentHistory">;

/**
 * A host that could not be reached while at least one other could. Its sessions
 * are missing from the list, which under a query means "no matches" would be a
 * claim the app cannot make.
 */
export interface AgentHistoryHostError {
  serverId: string;
  serverName: string;
}

export interface AgentHistoryHost {
  serverId: string;
  serverLabel: string;
  client: AgentHistoryClient;
}

interface AgentHistoryBatchPage {
  agents: AggregatedAgent[];
  ancestors: AggregatedAgent[];
  pageInfoByServerId: Record<string, FetchAgentHistoryPageInfo>;
  hostErrors: AgentHistoryHostError[];
  /** Set only under a query: more sessions matched than this page can hold. */
  isSearchTruncated?: boolean;
}

type AgentHistoryCursorByServerId = Record<string, string | null>;

interface AgentHistoryControls {
  search?: string;
  archiveScope?: AgentHistoryArchiveScope;
  searchScope?: AgentHistorySearchScope;
  sort?: HistorySortOption;
}

export async function fetchAgentHistoryPage(
  input: {
    client: AgentHistoryClient;
    serverId: string;
    serverLabel?: string;
    cursor: string | null;
    projectKeys?: readonly string[];
  } & AgentHistoryControls,
): Promise<AgentHistoryPage> {
  const { field, direction } = input.sort ?? DEFAULT_HISTORY_SORT;
  const payload = await input.client.fetchAgentHistory({
    ...(input.search ? { search: input.search } : {}),
    ...(input.archiveScope ? { archiveScope: input.archiveScope } : {}),
    ...(input.searchScope ? { searchScope: input.searchScope } : {}),
    ...(input.projectKeys?.length ? { filter: { projectKeys: [...input.projectKeys] } } : {}),
    sort: [{ key: field, direction }],
    page: input.cursor
      ? { limit: AGENT_HISTORY_PAGE_LIMIT, cursor: input.cursor }
      : { limit: AGENT_HISTORY_PAGE_LIMIT },
  });

  function normalizeEntries(entries: typeof payload.entries): AggregatedAgent[] {
    const { agents } = buildAgentDirectoryState({ serverId: input.serverId, entries });
    return Array.from(agents.values(), (agent) => ({
      id: agent.id,
      serverId: input.serverId,
      serverLabel: input.serverLabel ?? input.serverId,
      title: agent.title ?? null,
      status: agent.status,
      turn: agent.turn,
      lastActivityAt: agent.lastActivityAt,
      cwd: agent.cwd,
      workspaceId: agent.workspaceId,
      provider: agent.provider,
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
      attentionTimestamp: agent.attentionTimestamp ?? null,
      archivedAt: agent.archivedAt ?? null,
      createdAt: agent.createdAt,
      labels: agent.labels,
      projectPlacement: agent.projectPlacement,
    }));
  }

  return {
    isSearchTruncated: payload.searchTruncated === true,
    agents: normalizeEntries(payload.entries),
    ancestors: normalizeEntries(payload.ancestors ?? []),
    pageInfo: payload.pageInfo,
  };
}

function collectAgentHistoryAncestors(
  pages: readonly Partial<Pick<AgentHistoryPage, "ancestors">>[],
): AggregatedAgent[] {
  const ancestors = new Map<string, AggregatedAgent>();
  for (const page of pages) {
    for (const agent of page.ancestors ?? []) {
      const key = JSON.stringify([agent.serverId, agent.id]);
      if (!ancestors.has(key)) ancestors.set(key, agent);
    }
  }
  return [...ancestors.values()];
}

function withCurrentServerLabel(agent: AggregatedAgent, labels: ReadonlyMap<string, string>) {
  const serverLabel = labels.get(agent.serverId);
  return serverLabel !== undefined && serverLabel !== agent.serverLabel
    ? { ...agent, serverLabel }
    : agent;
}

function useAgentHistoryCapabilities(serverIds: readonly string[]) {
  return useSessionStore(
    useShallow((state) => {
      const features = serverIds.map((id) => state.sessions[id]?.serverInfo?.features);
      const hasHosts = features.length > 0;
      return {
        isSearchSupported:
          hasHosts && features.every((entry) => entry?.agentHistorySearch === true),
        // COMPAT(agentHistoryArchiveScope): added in v0.16.0, remove gate after 2027-05-19.
        isArchiveScopeSupported:
          hasHosts && features.every((entry) => entry?.agentHistoryArchiveScope === true),
        // COMPAT(agentHistoryQueryControls): added in v0.16.0, remove gate after 2027-05-19.
        isQueryControlsSupported:
          hasHosts && features.every((entry) => entry?.agentHistoryQueryControls === true),
      };
    }),
  );
}

function resolveAgentHistorySortField(input: {
  field: HistorySortOption["field"];
  archiveScope: AgentHistoryArchiveScope | undefined;
  supportsQueryControls: boolean;
}): HistorySortOption["field"] {
  if (
    input.field === "archived_at" &&
    (!input.supportsQueryControls || input.archiveScope !== "archived")
  ) {
    return "updated_at";
  }
  return input.field;
}

function sortHistoryAgents(agents: AggregatedAgent[], sort: HistorySortOption): AggregatedAgent[] {
  const preservesLegacyOrder =
    sort.field === DEFAULT_HISTORY_SORT.field && sort.direction === DEFAULT_HISTORY_SORT.direction;
  return [...agents].sort((a, b) => {
    const left = resolveHistoryAgentTimestamp(a, sort.field).getTime();
    const right = resolveHistoryAgentTimestamp(b, sort.field).getTime();
    if (Number.isNaN(left) !== Number.isNaN(right)) return Number.isNaN(left) ? 1 : -1;
    const delta = sort.direction === "asc" ? left - right : right - left;
    // Preserve daemon order for equal timestamps, including unscoped workspace search.
    if (delta || preservesLegacyOrder) return delta;
    const leftKey = `${a.serverId}:${a.id}`;
    const rightKey = `${b.serverId}:${b.id}`;
    return (
      leftKey.localeCompare(rightKey) || (leftKey < rightKey ? -1 : Number(leftKey > rightKey))
    );
  });
}

/**
 * Which hosts are missing from the list the user is looking at.
 *
 * Failures are collected across every loaded page, not just the newest: a host
 * that rejects page one contributes no cursor and is never asked again, so a
 * later page carries no error of its own while that host's history is still
 * absent. A refetch replaces every page, which is what clears an error that has
 * healed.
 */
export function collectAgentHistoryHostErrors(input: {
  pages: readonly Pick<AgentHistoryBatchPage, "hostErrors">[];
  unreachableHosts: readonly AgentHistoryHostError[];
}): AgentHistoryHostError[] {
  const byServerId = new Map<string, AgentHistoryHostError>();
  for (const error of input.unreachableHosts) {
    byServerId.set(error.serverId, error);
  }
  for (const page of input.pages) {
    for (const error of page.hostErrors) {
      byServerId.set(error.serverId, error);
    }
  }
  return [...byServerId.values()];
}

function getNextAgentHistoryPageParam(
  page: AgentHistoryBatchPage,
): AgentHistoryCursorByServerId | null {
  const cursorByServerId: AgentHistoryCursorByServerId = {};
  for (const [serverId, pageInfo] of Object.entries(page.pageInfoByServerId)) {
    if (pageInfo.hasMore && pageInfo.nextCursor) {
      cursorByServerId[serverId] = pageInfo.nextCursor;
    }
  }

  return Object.keys(cursorByServerId).length > 0 ? cursorByServerId : null;
}

export async function fetchAgentHistoryBatch(
  input: {
    hosts: readonly AgentHistoryHost[];
    cursorByServerId: AgentHistoryCursorByServerId | null;
    projectKeysByServer?: ReadonlyMap<string, readonly string[]> | null;
  } & AgentHistoryControls,
): Promise<AgentHistoryBatchPage> {
  const cursorByServerId = input.cursorByServerId ?? {};
  const hasCursorFilter = Object.keys(cursorByServerId).length > 0;
  const hostsToFetch = input.hosts.flatMap((host) => {
    if (hasCursorFilter && !Object.hasOwn(cursorByServerId, host.serverId)) return [];
    const projectKeys = input.projectKeysByServer?.get(host.serverId)?.filter((key) => key.trim());
    return input.projectKeysByServer && !projectKeys?.length ? [] : [{ host, projectKeys }];
  });
  if (input.projectKeysByServer && hostsToFetch.length === 0) {
    return { agents: [], ancestors: [], pageInfoByServerId: {}, hostErrors: [] };
  }

  const settledPages = await Promise.allSettled(
    hostsToFetch.map(async ({ host, projectKeys }) => {
      const page = await fetchAgentHistoryPage({
        client: host.client,
        serverId: host.serverId,
        serverLabel: host.serverLabel,
        cursor: cursorByServerId[host.serverId] ?? null,
        search: input.search,
        archiveScope: input.archiveScope,
        searchScope: input.searchScope,
        sort: input.sort,
        projectKeys,
      });
      return { host, page };
    }),
  );
  const pages = settledPages.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (pages.length === 0) {
    throw new Error(AGENT_HISTORY_ALL_HOSTS_FAILED_MESSAGE);
  }
  // allSettled preserves order, so a rejection still names the host it came
  // from. Losing that name is what would let the list quietly under-report.
  const hostErrors = settledPages.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          {
            serverId: hostsToFetch[index].host.serverId,
            serverName: hostsToFetch[index].host.serverLabel,
          },
        ]
      : [],
  );

  const agents = pages.flatMap(({ page }) => page.agents);
  const pageInfoByServerId = Object.fromEntries(
    pages.map(({ host, page }) => [host.serverId, page.pageInfo]),
  );
  return {
    agents: sortHistoryAgents(agents, input.sort ?? DEFAULT_HISTORY_SORT),
    ancestors: collectAgentHistoryAncestors(pages.map(({ page }) => page)),
    pageInfoByServerId,
    hostErrors,
    ...(input.search
      ? { isSearchTruncated: pages.some(({ page }) => page.isSearchTruncated) }
      : {}),
  };
}

function buildAgentHistoryQueryOptions(input: {
  archiveScope: AgentHistoryArchiveScope | undefined;
  searchScope: AgentHistorySearchScope | undefined;
  sort: HistorySortOption;
  projectKeysByServer: ReadonlyMap<string, readonly string[]> | null;
}) {
  const { archiveScope, searchScope, sort, projectKeysByServer } = input;
  const isNonDefaultSort =
    sort.field !== DEFAULT_HISTORY_SORT.field || sort.direction !== DEFAULT_HISTORY_SORT.direction;
  return {
    ...(archiveScope ? { archiveScope } : {}),
    ...(searchScope ? { searchScope } : {}),
    ...(isNonDefaultSort ? { sort: `${sort.field}:${sort.direction}` } : {}),
    ...(projectKeysByServer ? { projectKeys: [...projectKeysByServer] } : {}),
  };
}

function resolveAgentHistorySearchScope(
  search: string,
  supported: boolean,
  scope: AgentHistorySearchScope | undefined,
): AgentHistorySearchScope | undefined {
  return search && supported && scope !== "all" ? scope : undefined;
}

export function useAgentHistory(
  options: {
    serverId?: string | null;
    enabled?: boolean;
    projectKeysByServer?: ReadonlyMap<string, readonly string[]> | null;
    /**
     * Leave out hosts that predate search, instead of searching no host. For a surface that adds
     * history matches to other results, where a missing host is not a claim of "no matches".
     */
    searchableHostsOnly?: boolean;
    /** Keep the previous query's results until the next query's arrive. */
    keepPreviousResults?: boolean;
  } & AgentHistoryControls,
): AgentHistoryResult {
  const { t } = useTranslation();
  const daemons = useHosts();
  const runtime = getHostRuntimeStore();
  const serverId = useMemo(() => {
    const value = options.serverId;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }, [options.serverId]);
  const enabled = options.enabled ?? true;
  const projectKeysByServer = useMemo(() => {
    if (options.projectKeysByServer == null) return null;
    const normalized = new Map<string, string[]>();
    for (const id of [...options.projectKeysByServer.keys()].sort()) {
      const keys = [...new Set(options.projectKeysByServer.get(id)?.filter((key) => key.trim()))];
      if (keys.length > 0) normalized.set(id, keys.sort());
    }
    return normalized;
  }, [options.projectKeysByServer]);
  const requestedProjects = options.projectKeysByServer;
  const requestedServerIds = useMemo(() => {
    const ids = serverId ? [serverId] : daemons.map((daemon) => daemon.serverId);
    return requestedProjects?.size ? ids.filter((id) => projectKeysByServer?.has(id)) : ids;
  }, [daemons, serverId, requestedProjects, projectKeysByServer]);
  const searchableServerIds = useSessionStore(
    useShallow((state) =>
      requestedServerIds.filter(
        (id) => state.sessions[id]?.serverInfo?.features?.agentHistorySearch === true,
      ),
    ),
  );
  const serverIds = options.searchableHostsOnly ? searchableServerIds : requestedServerIds;
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  // A host the user asked about splits two ways: one this fetch can reach, and
  // one whose sessions will be missing from the answer. Both come out of here,
  // because dropping the unreachable ones silently is what lets the list — and
  // worse, "No sessions match" — overstate what was actually searched.
  const { targetHosts, unreachableHosts } = useMemo(() => {
    const serverLabelById = new Map(daemons.map((daemon) => [daemon.serverId, daemon.label]));
    const hosts: AgentHistoryHost[] = [];
    const unreachable: AgentHistoryHostError[] = [];

    for (const targetServerId of serverIds) {
      const client = runtime.getClient(targetServerId);
      const serverName = serverLabelById.get(targetServerId) ?? targetServerId;
      if (!client || connectionStatuses.get(targetServerId) !== "online") {
        unreachable.push({ serverId: targetServerId, serverName });
        continue;
      }
      hosts.push({ serverId: targetServerId, serverLabel: serverName, client });
    }

    return { targetHosts: hosts, unreachableHosts: unreachable };
  }, [daemons, runtime, connectionStatuses, serverIds]);
  const targetServerIds = useMemo(() => targetHosts.map((host) => host.serverId), [targetHosts]);
  // A single host's cache identity follows its last advertised capabilities across disconnects.
  const { isSearchSupported, isArchiveScopeSupported, isQueryControlsSupported } =
    useAgentHistoryCapabilities(serverId ? serverIds : targetServerIds);
  const effectiveArchiveScope = isArchiveScopeSupported ? options.archiveScope : undefined;
  const search = useMemo(() => {
    const trimmed = options.search?.trim() ?? "";
    return isSearchSupported ? trimmed : "";
  }, [isSearchSupported, options.search]);
  const effectiveSearchScope = resolveAgentHistorySearchScope(
    search,
    isQueryControlsSupported,
    options.searchScope,
  );
  const requestedSort = options.sort ?? DEFAULT_HISTORY_SORT;
  const sortDirection = requestedSort.direction;
  const sortField = resolveAgentHistorySortField({
    field: requestedSort.field,
    archiveScope: effectiveArchiveScope,
    supportsQueryControls: isQueryControlsSupported,
  });
  const effectiveSort = useMemo<HistorySortOption>(
    () => ({ field: sortField, direction: sortDirection }),
    [sortField, sortDirection],
  );
  const queryOptions = buildAgentHistoryQueryOptions({
    archiveScope: effectiveArchiveScope,
    searchScope: effectiveSearchScope,
    sort: effectiveSort,
    projectKeysByServer,
  });
  const queryKey = [
    ...(serverId ? agentHistoryQueryKey(serverId) : allAgentHistoryQueryKey(targetServerIds)),
    search,
    ...(Object.keys(queryOptions).length > 0 ? [queryOptions] : []),
  ];
  const serverLabelById = useMemo(
    () => new Map(daemons.map((daemon) => [daemon.serverId, daemon.label])),
    [daemons],
  );

  const queryEnabled = enabled && targetHosts.length > 0;
  const historyQuery = useInfiniteQuery<
    AgentHistoryBatchPage,
    Error,
    { pages: AgentHistoryBatchPage[] },
    readonly unknown[],
    AgentHistoryCursorByServerId | null
  >({
    queryKey,
    enabled: queryEnabled,
    staleTime: 30_000,
    refetchOnMount: (query) => query.state.isInvalidated,
    // Previous results stand in only until the next query's arrive. With no host to search,
    // nothing will arrive, so they would stand in, and read as still loading, indefinitely.
    ...(options.keepPreviousResults && queryEnabled
      ? {
          placeholderData: (previousData, previousQuery) => {
            const previousSuffix = previousQuery?.queryKey.at(-1);
            const previousOptions =
              previousSuffix && typeof previousSuffix === "object" ? previousSuffix : {};
            return hashKey([previousOptions]) === hashKey([queryOptions])
              ? keepPreviousData(previousData)
              : undefined;
          },
        }
      : {}),
    initialPageParam: null,
    getNextPageParam: getNextAgentHistoryPageParam,
    queryFn: async ({ pageParam }) => {
      if (targetHosts.length === 0) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return fetchAgentHistoryBatch({
        hosts: targetHosts,
        cursorByServerId: pageParam,
        search,
        archiveScope: effectiveArchiveScope,
        searchScope: effectiveSearchScope,
        sort: effectiveSort,
        projectKeysByServer,
      });
    },
  });
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetching,
    isFetchingNextPage,
    isLoading,
    isPlaceholderData,
    refetch,
  } = historyQuery;

  const refreshAll = useCallback(async () => {
    if (!queryEnabled) {
      return;
    }
    await refetch();
  }, [queryEnabled, refetch]);

  const loadMore = useCallback(() => {
    if (!queryEnabled || !hasNextPage || isFetchingNextPage) {
      return;
    }
    void fetchNextPage();
  }, [queryEnabled, fetchNextPage, hasNextPage, isFetchingNextPage]);

  const { agents, ancestors } = useMemo(() => {
    const pages = data?.pages ?? [];
    const matched: AggregatedAgent[] = [];
    const archivedWhileActive: AggregatedAgent[] = [];
    for (const page of pages) {
      for (const agent of page.agents) {
        // An optimistic archive may leave a parent in the active cache until refetch.
        const destination =
          effectiveArchiveScope === "active" && agent.archivedAt ? archivedWhileActive : matched;
        destination.push(withCurrentServerLabel(agent, serverLabelById));
      }
    }
    const parentContext = collectAgentHistoryAncestors([
      { ancestors: archivedWhileActive },
      ...pages,
    ]);
    return {
      agents: sortHistoryAgents(matched, effectiveSort),
      ancestors: parentContext.map((agent) => withCurrentServerLabel(agent, serverLabelById)),
    };
  }, [data?.pages, effectiveArchiveScope, effectiveSort, serverLabelById]);
  const isInitialLoad = isLoading && agents.length === 0;
  const isRevalidating = isFetching && !isFetchingNextPage && agents.length > 0;
  const isSearchTruncated = Boolean(search && data?.pages.some((page) => page.isSearchTruncated));
  const hostErrors = useMemo(
    () =>
      collectAgentHistoryHostErrors({
        pages: data?.pages ?? [],
        unreachableHosts: projectKeysByServer
          ? unreachableHosts.filter((host) => projectKeysByServer.has(host.serverId))
          : unreachableHosts,
      }),
    [data?.pages, projectKeysByServer, unreachableHosts],
  );

  return {
    agents,
    ancestors,
    isLoading,
    isInitialLoad,
    isRevalidating,
    isError,
    hasMore: hasNextPage,
    isLoadingMore: isFetchingNextPage,
    isSearchSupported,
    isArchiveScopeSupported,
    isQueryControlsSupported,
    effectiveSort,
    isSearchTruncated,
    isPreviousResults: isPlaceholderData,
    hostErrors,
    refreshAll,
    loadMore,
  };
}
