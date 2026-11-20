import type { QueryClient } from "@tanstack/react-query";

export function agentHistoryQueryKey(serverId: string | null) {
  return ["agentHistory", serverId] as const;
}

const ALL_AGENT_HISTORY_QUERY_ROOT = ["allAgentHistory"] as const;

export function allAgentHistoryQueryRootKey() {
  return ALL_AGENT_HISTORY_QUERY_ROOT;
}

export function allAgentHistoryQueryKey(serverIds: readonly string[]) {
  return [...ALL_AGENT_HISTORY_QUERY_ROOT, ...[...serverIds].sort()] as const;
}

export function invalidateAgentHistory(queryClient: QueryClient, serverId: string): void {
  for (const queryKey of [agentHistoryQueryKey(serverId), allAgentHistoryQueryRootKey()]) {
    // A request started before the mutation could otherwise overwrite the invalidation.
    void queryClient.cancelQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey });
  }
}
