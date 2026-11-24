import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";

interface RewindCheckpointIdentity {
  serverId?: string;
  agentId?: string;
  messageId?: string;
}

export function rewindCheckpointQueryKey({
  serverId,
  agentId,
  messageId,
}: RewindCheckpointIdentity) {
  return ["agent-rewind-checkpoint", serverId, agentId, messageId] as const;
}

export function useRewindCheckpointsSupported(serverId?: string): boolean {
  // COMPAT(rewindCheckpoints): added in v0.17.0, remove the gate after 2027-05-24.
  return useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.rewindCheckpoints === true,
  );
}

export function useRewindCheckpoint({
  serverId,
  agentId,
  messageId,
  enabled,
}: RewindCheckpointIdentity & { enabled: boolean }) {
  const client = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.client : undefined,
  );
  const supported = useRewindCheckpointsSupported(serverId);
  const query = useFetchQuery({
    queryKey: rewindCheckpointQueryKey({ serverId, agentId, messageId }),
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: () => {
      if (!client || !agentId || !messageId) throw new Error("Checkpoint target is unavailable");
      return client.getAgentRewindCheckpoint({ agentId, messageId });
    },
    enabled: enabled && supported && Boolean(client && agentId && messageId),
    retry: false,
  });
  // A cached allowance may predate a permission change or another writer starting.
  const checkpoint =
    enabled && supported && query.isSuccess && !query.isFetching ? query.data : undefined;
  const resolved = checkpoint?.ok && checkpoint.target?.messageId === messageId;
  return {
    supported,
    target: resolved ? checkpoint.target : undefined,
    canRewindFiles: resolved && checkpoint.canRewindFiles === true,
    canRewindBoth: resolved && checkpoint.canRewindBoth === true,
  };
}
