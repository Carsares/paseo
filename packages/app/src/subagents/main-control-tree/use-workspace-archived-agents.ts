import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetchQueries } from "@/data/query";
import { agentHistoryQueryKey } from "@/hooks/agent-history-query-key";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { Agent } from "@/stores/session-store";
import { buildAgentDirectoryState } from "@/utils/agent-directory-sync";

export const WORKSPACE_HISTORY_PAGE_SIZE = 25;

const EMPTY_CURSORS: string[] = [];

interface ArchivedHistoryPage {
  serverId: string;
  workspaceId: string;
  agents: Agent[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface UseWorkspaceArchivedAgentsInput {
  serverId: string;
  workspaceId: string;
  /** Retained for compatibility; history only fetches once `enabled` is explicitly true. */
  mainAgentId?: string | null;
  /** On-demand gate: stays false until the user clicks "View history members". */
  enabled?: boolean;
  workspaceAgentMembership: string;
  pageSize?: number;
}

export interface UseWorkspaceArchivedAgentsResult {
  data: Agent[];
  hasLoadedOnce: boolean;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  isError: boolean;
  loadMore: () => void;
  refetch: () => void;
  supportsWorkspaceHistory: boolean;
}

async function fetchArchivedHistoryPage(input: {
  client: DaemonClient | null;
  serverId: string;
  workspaceId: string;
  pageSize: number;
  cursor: string | null;
  signal: AbortSignal;
}): Promise<ArchivedHistoryPage> {
  const { client, serverId, workspaceId, pageSize, cursor, signal } = input;
  if (!client) {
    return { serverId, workspaceId, agents: [], nextCursor: null, hasMore: false };
  }
  signal.throwIfAborted();
  const { entries, pageInfo } = await client.fetchAgentHistory({
    archiveScope: "archived",
    filter: { workspaceIds: [workspaceId], includeBackground: false },
    page: cursor ? { limit: pageSize, cursor } : { limit: pageSize },
  });
  signal.throwIfAborted();
  const { agents } = buildAgentDirectoryState({
    serverId,
    entries: entries.filter(({ agent }) => !agent.internal),
  });
  const filtered: Agent[] = [];
  for (const agent of agents.values()) {
    if (agent.workspaceId === workspaceId && agent.archivedAt && !agent.background) {
      filtered.push(agent);
    }
  }
  const nextCursor = pageInfo.hasMore && pageInfo.nextCursor ? pageInfo.nextCursor : null;
  return {
    serverId,
    workspaceId,
    agents: filtered,
    nextCursor,
    hasMore: Boolean(nextCursor),
  };
}

function collectScopedArchivedAgents(
  scopedPages: readonly ArchivedHistoryPage[],
  workspaceId: string,
): Agent[] {
  const seen = new Map<string, Agent>();
  for (const page of scopedPages) {
    for (const agent of page.agents) {
      if (agent.workspaceId === workspaceId && agent.archivedAt && !agent.background) {
        if (!seen.has(agent.id)) {
          seen.set(agent.id, agent);
        }
      }
    }
  }
  return [...seen.values()];
}

function summarizeArchivedPages(input: {
  pageQueries: ReadonlyArray<{
    data?: ArchivedHistoryPage;
    isFetching: boolean;
    isPending: boolean;
    isError: boolean;
  }>;
  serverId: string;
  workspaceId: string;
  enabled: boolean;
  supportsWorkspaceHistory: boolean;
  queryEnabled: boolean;
}) {
  const { pageQueries, serverId, workspaceId, enabled, supportsWorkspaceHistory, queryEnabled } =
    input;
  const scopedPages: ArchivedHistoryPage[] = [];
  for (const result of pageQueries) {
    const page = result.data;
    if (page && page.serverId === serverId && page.workspaceId === workspaceId) {
      scopedPages.push(page);
    }
  }
  const lastQuery = pageQueries[pageQueries.length - 1];
  const lastScopedPage = scopedPages[scopedPages.length - 1] ?? null;
  const nextCursor = lastScopedPage?.hasMore ? lastScopedPage.nextCursor : null;
  const canShow = enabled && supportsWorkspaceHistory;
  return {
    scopedPages,
    nextCursor,
    isAnyFetching: pageQueries.some((result) => result.isFetching),
    hasLoadedOnce: Boolean(canShow && scopedPages.length > 0),
    hasMore: Boolean(canShow && nextCursor !== null),
    isLoading: Boolean(queryEnabled && pageQueries.length === 1 && pageQueries[0]?.isPending),
    isLoadingMore: Boolean(queryEnabled && pageQueries.length > 1 && lastQuery?.isPending),
    isError: Boolean(queryEnabled && pageQueries.some((result) => result.isError)),
  };
}

export function useWorkspaceArchivedAgents({
  serverId,
  workspaceId,
  enabled = false,
  workspaceAgentMembership,
  pageSize = WORKSPACE_HISTORY_PAGE_SIZE,
}: UseWorkspaceArchivedAgentsInput): UseWorkspaceArchivedAgentsResult {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  // COMPAT(agentHistoryArchiveScope): added in v0.16.0, remove gate after 2027-05-19.
  const supportsArchiveScope = useHostFeature(serverId, "agentHistoryArchiveScope");
  // COMPAT(agentHistoryWorkspaceFilter): added in v0.16.0, remove gate after 2027-05-20.
  const supportsWorkspaceFilter = useHostFeature(serverId, "agentHistoryWorkspaceFilter");
  const supportsWorkspaceHistory = supportsArchiveScope && supportsWorkspaceFilter;
  const queryClient = useQueryClient();

  const scopeKey = `${serverId}\0${workspaceId}`;
  const queryKeyPrefix = useMemo(
    () => [...agentHistoryQueryKey(serverId), "workspace-archived", workspaceId, pageSize] as const,
    [pageSize, serverId, workspaceId],
  );
  const queryEnabled = Boolean(
    enabled && workspaceId && client && isConnected && supportsWorkspaceHistory,
  );

  // Scoped extra page cursors; resets automatically on workspace switch to avoid crosstalk.
  const [cursorState, setCursorState] = useState<{ scopeKey: string; extraCursors: string[] }>({
    scopeKey,
    extraCursors: EMPTY_CURSORS,
  });
  const extraCursors = cursorState.scopeKey === scopeKey ? cursorState.extraCursors : EMPTY_CURSORS;

  // Synchronous double-click guard keyed by scope so rapid clicks only queue one next page.
  const queuedCursorRef = useRef<{ scopeKey: string; cursor: string | null }>({
    scopeKey,
    cursor: null,
  });
  if (queuedCursorRef.current.scopeKey !== scopeKey) {
    queuedCursorRef.current = { scopeKey, cursor: null };
  }

  // Track membership per scope so switching workspaces never triggers a bogus invalidation loop.
  const membershipRef = useRef({ scopeKey, membership: workspaceAgentMembership });
  useEffect(() => {
    const previous = membershipRef.current;
    membershipRef.current = { scopeKey, membership: workspaceAgentMembership };
    if (previous.scopeKey !== scopeKey || previous.membership === workspaceAgentMembership) {
      return;
    }
    if (!queryEnabled) return;
    queuedCursorRef.current = { scopeKey, cursor: null };
    setCursorState({ scopeKey, extraCursors: EMPTY_CURSORS });
    void queryClient.cancelQueries({ queryKey: queryKeyPrefix });
    void queryClient.invalidateQueries({ queryKey: queryKeyPrefix });
  }, [queryClient, queryEnabled, queryKeyPrefix, scopeKey, workspaceAgentMembership]);

  const pageCursors = useMemo<Array<string | null>>(
    () => (queryEnabled ? [null, ...extraCursors] : []),
    [extraCursors, queryEnabled],
  );

  const pageQueries = useFetchQueries<ArchivedHistoryPage>(
    useMemo(
      () =>
        pageCursors.map((cursor) => ({
          queryKey: [...queryKeyPrefix, cursor ?? "__first__"],
          enabled: queryEnabled,
          dataShape: "list" as const,
          staleTimeMs: 30_000,
          retry: false,
          refetchOnMount: false,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
          queryFn: ({ signal }) =>
            fetchArchivedHistoryPage({ client, serverId, workspaceId, pageSize, cursor, signal }),
        })),
      [client, pageCursors, pageSize, queryEnabled, queryKeyPrefix, serverId, workspaceId],
    ),
  );

  const summary = useMemo(
    () =>
      summarizeArchivedPages({
        pageQueries,
        serverId,
        workspaceId,
        enabled,
        supportsWorkspaceHistory,
        queryEnabled,
      }),
    [enabled, pageQueries, queryEnabled, serverId, supportsWorkspaceHistory, workspaceId],
  );

  const loadMore = useCallback(() => {
    const { nextCursor, isAnyFetching } = summary;
    if (!queryEnabled || !nextCursor || isAnyFetching || extraCursors.includes(nextCursor)) return;
    const queued = queuedCursorRef.current;
    if (queued.scopeKey === scopeKey && queued.cursor === nextCursor) return;
    queuedCursorRef.current = { scopeKey, cursor: nextCursor };
    setCursorState((current) => {
      const existing = current.scopeKey === scopeKey ? current.extraCursors : EMPTY_CURSORS;
      if (existing.includes(nextCursor)) return current;
      return { scopeKey, extraCursors: [...existing, nextCursor] };
    });
  }, [extraCursors, queryEnabled, scopeKey, summary]);

  const handleRefetch = useCallback(() => {
    if (!queryEnabled || summary.isAnyFetching) return;
    const errored = pageQueries.filter((result) => result.isError);
    for (const target of errored.length > 0 ? errored : pageQueries) {
      void target.refetch();
    }
  }, [pageQueries, queryEnabled, summary.isAnyFetching]);

  const data = useMemo(() => {
    if (!supportsWorkspaceHistory || !enabled || summary.scopedPages.length === 0) return [];
    return collectScopedArchivedAgents(summary.scopedPages, workspaceId);
  }, [enabled, summary.scopedPages, supportsWorkspaceHistory, workspaceId]);

  return {
    data,
    hasLoadedOnce: summary.hasLoadedOnce,
    hasMore: summary.hasMore,
    isLoading: summary.isLoading,
    isLoadingMore: summary.isLoadingMore,
    isError: summary.isError,
    loadMore,
    refetch: handleRefetch,
    supportsWorkspaceHistory,
  };
}
