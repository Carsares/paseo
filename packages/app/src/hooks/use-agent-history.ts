import type {
  DaemonClient,
  FetchAgentHistoryOptions,
  FetchAgentHistoryPageInfo,
} from "@getpaseo/client/internal/daemon-client";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { buildAgentDirectoryState } from "@/utils/agent-directory-sync";
import { agentHistoryQueryKey, allAgentHistoryQueryKey } from "./agent-history-query-key";

const AGENT_HISTORY_PAGE_LIMIT = 200;
const AGENT_HISTORY_SORT: NonNullable<FetchAgentHistoryOptions["sort"]> = [
  { key: "updated_at", direction: "desc" },
];
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

export async function fetchAgentHistoryPage(input: {
  client: AgentHistoryClient;
  serverId: string;
  serverLabel?: string;
  cursor: string | null;
  search?: string;
  archiveScope?: AgentHistoryArchiveScope;
}): Promise<AgentHistoryPage> {
  const payload = await input.client.fetchAgentHistory({
    ...(input.search ? { search: input.search } : {}),
    ...(input.archiveScope ? { archiveScope: input.archiveScope } : {}),
    sort: AGENT_HISTORY_SORT,
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

function sortByLatestActivity(agents: AggregatedAgent[]): AggregatedAgent[] {
  return [...agents].sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
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

export async function fetchAgentHistoryBatch(input: {
  hosts: readonly AgentHistoryHost[];
  cursorByServerId: AgentHistoryCursorByServerId | null;
  search?: string;
  archiveScope?: AgentHistoryArchiveScope;
}): Promise<AgentHistoryBatchPage> {
  const cursorByServerId = input.cursorByServerId ?? {};
  const hasCursorFilter = Object.keys(cursorByServerId).length > 0;
  const hostsToFetch = hasCursorFilter
    ? input.hosts.filter((host) => Object.hasOwn(cursorByServerId, host.serverId))
    : input.hosts;

  const settledPages = await Promise.allSettled(
    hostsToFetch.map(async (host) => {
      const page = await fetchAgentHistoryPage({
        client: host.client,
        serverId: host.serverId,
        serverLabel: host.serverLabel,
        cursor: cursorByServerId[host.serverId] ?? null,
        search: input.search,
        archiveScope: input.archiveScope,
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
            serverId: hostsToFetch[index].serverId,
            serverName: hostsToFetch[index].serverLabel,
          },
        ]
      : [],
  );

  const agents = pages.flatMap(({ page }) => page.agents);
  const pageInfoByServerId = Object.fromEntries(
    pages.map(({ host, page }) => [host.serverId, page.pageInfo]),
  );
  return {
    agents: sortByLatestActivity(agents),
    ancestors: collectAgentHistoryAncestors(pages.map(({ page }) => page)),
    pageInfoByServerId,
    hostErrors,
    ...(input.search
      ? { isSearchTruncated: pages.some(({ page }) => page.isSearchTruncated) }
      : {}),
  };
}

export function useAgentHistory(options: {
  serverId?: string | null;
  enabled?: boolean;
  search?: string;
  archiveScope?: AgentHistoryArchiveScope;
  /**
   * Leave out hosts that predate search, instead of searching no host. For a surface that adds
   * history matches to other results, where a missing host is not a claim of "no matches".
   */
  searchableHostsOnly?: boolean;
  /** Keep the previous query's results until the next query's arrive. */
  keepPreviousResults?: boolean;
}): AgentHistoryResult {
  const { t } = useTranslation();
  const daemons = useHosts();
  const runtime = getHostRuntimeStore();
  const serverId = useMemo(() => {
    const value = options.serverId;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }, [options.serverId]);
  const enabled = options.enabled ?? true;
  const requestedServerIds = useMemo(
    () => (serverId ? [serverId] : daemons.map((daemon) => daemon.serverId)),
    [daemons, serverId],
  );
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
  // One gate, checked before the field is offered: a fleet where any host
  // predates search has no search, rather than a list that silently omits that
  // host's sessions.
  const isSearchSupported = useSessionStore(
    useCallback(
      (state) =>
        targetServerIds.length > 0 &&
        targetServerIds.every(
          (id) => state.sessions[id]?.serverInfo?.features?.agentHistorySearch === true,
        ),
      [targetServerIds],
    ),
  );
  // COMPAT(agentHistoryArchiveScope): added in v0.16.0, remove gate after 2027-05-19.
  const isArchiveScopeSupported = useSessionStore(
    useCallback(
      (state) =>
        targetServerIds.length > 0 &&
        targetServerIds.every(
          (id) => state.sessions[id]?.serverInfo?.features?.agentHistoryArchiveScope === true,
        ),
      [targetServerIds],
    ),
  );
  const effectiveArchiveScope = isArchiveScopeSupported ? options.archiveScope : undefined;
  const search = useMemo(() => {
    const trimmed = options.search?.trim() ?? "";
    return isSearchSupported ? trimmed : "";
  }, [isSearchSupported, options.search]);
  const queryKey = useMemo(
    () => [
      ...(serverId ? agentHistoryQueryKey(serverId) : allAgentHistoryQueryKey(targetServerIds)),
      search,
      ...(effectiveArchiveScope ? [{ archiveScope: effectiveArchiveScope }] : []),
    ],
    [effectiveArchiveScope, search, serverId, targetServerIds],
  );
  const serverLabelById = useMemo(
    () => new Map(daemons.map((daemon) => [daemon.serverId, daemon.label])),
    [daemons],
  );

  const queryEnabled = Boolean(enabled && targetHosts.length > 0);
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
    // Previous results stand in only until the next query's arrive. With no host to search,
    // nothing will arrive, so they would stand in, and read as still loading, indefinitely.
    ...(options.keepPreviousResults && queryEnabled
      ? {
          placeholderData: (previousData, previousQuery) => {
            const previousSuffix = previousQuery?.queryKey.at(-1);
            const previousScope =
              previousSuffix &&
              typeof previousSuffix === "object" &&
              "archiveScope" in previousSuffix
                ? previousSuffix.archiveScope
                : undefined;
            return previousScope === effectiveArchiveScope
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
    if (!enabled || targetHosts.length === 0) {
      return;
    }
    await refetch();
  }, [enabled, refetch, targetHosts.length]);

  const loadMore = useCallback(() => {
    if (!enabled || targetHosts.length === 0 || !hasNextPage || isFetchingNextPage) {
      return;
    }
    void fetchNextPage();
  }, [enabled, fetchNextPage, hasNextPage, isFetchingNextPage, targetHosts.length]);

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
      agents: sortByLatestActivity(matched),
      ancestors: parentContext.map((agent) => withCurrentServerLabel(agent, serverLabelById)),
    };
  }, [data?.pages, effectiveArchiveScope, serverLabelById]);
  const isInitialLoad = isLoading && agents.length === 0;
  const isRevalidating = isFetching && !isFetchingNextPage && agents.length > 0;
  const isSearchTruncated = Boolean(search && data?.pages.some((page) => page.isSearchTruncated));
  const hostErrors = useMemo(
    () => collectAgentHistoryHostErrors({ pages: data?.pages ?? [], unreachableHosts }),
    [data?.pages, unreachableHosts],
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
    isSearchTruncated,
    isPreviousResults: isPlaceholderData,
    hostErrors,
    refreshAll,
    loadMore,
  };
}
