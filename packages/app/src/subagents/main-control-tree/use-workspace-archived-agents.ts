import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useFetchQuery } from "@/data/query";
import { agentHistoryQueryKey } from "@/hooks/agent-history-query-key";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { Agent } from "@/stores/session-store";
import { buildAgentDirectoryState } from "@/utils/agent-directory-sync";

export function useWorkspaceArchivedAgents({
  serverId,
  workspaceId,
  mainAgentId,
  workspaceAgentMembership,
}: {
  serverId: string;
  workspaceId: string;
  mainAgentId: string | null;
  workspaceAgentMembership: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  // COMPAT(agentHistoryArchiveScope): added in v0.16.0, remove gate after 2027-05-19.
  const supportsArchiveScope = useHostFeature(serverId, "agentHistoryArchiveScope");
  // COMPAT(agentHistoryWorkspaceFilter): added in v0.16.0, remove gate after 2027-05-20.
  const supportsWorkspaceFilter = useHostFeature(serverId, "agentHistoryWorkspaceFilter");
  const supportsWorkspaceHistory = supportsArchiveScope && supportsWorkspaceFilter;
  const queryClient = useQueryClient();
  const enabled = Boolean(
    mainAgentId && workspaceId && client && isConnected && supportsWorkspaceHistory,
  );
  const previousMembership = useRef(workspaceAgentMembership);
  useEffect(() => {
    const changed = previousMembership.current !== workspaceAgentMembership;
    previousMembership.current = workspaceAgentMembership;
    if (!changed || !enabled) return;
    const queryKey = [...agentHistoryQueryKey(serverId), "workspace-archived", workspaceId];
    void queryClient.cancelQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey });
  }, [workspaceAgentMembership, enabled, queryClient, serverId, workspaceId]);

  const query = useFetchQuery({
    queryKey: [...agentHistoryQueryKey(serverId), "workspace-archived", workspaceId],
    enabled,
    dataShape: "list",
    staleTimeMs: 0,
    queryFn: async ({ signal }) => {
      if (!client) return [];
      const archived = new Map<string, Agent>();
      let cursor: string | null = null;
      do {
        signal.throwIfAborted();
        const { entries, pageInfo } = await client.fetchAgentHistory({
          archiveScope: "archived",
          filter: { workspaceIds: [workspaceId], includeBackground: false },
          page: cursor ? { limit: 200, cursor } : { limit: 200 },
        });
        const { agents } = buildAgentDirectoryState({
          serverId,
          entries: entries.filter(({ agent }) => !agent.internal),
        });
        for (const agent of agents.values()) {
          if (agent.workspaceId === workspaceId && agent.archivedAt && !agent.background) {
            if (!archived.has(agent.id)) archived.set(agent.id, agent);
          }
        }
        cursor = pageInfo.hasMore ? pageInfo.nextCursor : null;
      } while (cursor);
      signal.throwIfAborted();
      return [...archived.values()];
    },
  });
  return {
    data: supportsWorkspaceHistory && !query.isPlaceholderData ? query.data : undefined,
    isLoading: query.isLoading,
    isError: enabled && query.isError,
    refetch: query.refetch,
    supportsWorkspaceHistory,
  };
}
