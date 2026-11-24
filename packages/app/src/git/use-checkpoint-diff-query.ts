import { useFetchQuery } from "@/data/query";
import { useCheckpointCopy } from "./diff-checkpoint-copy";
import { readCheckpointDiffResult, resolveCheckpointDiffView } from "./diff-checkpoint-result";
import type { CheckpointDiffSelection } from "./working-diff-comparison/state";
import { useRewindCheckpointsSupported } from "@/hooks/use-rewind-checkpoint";
import { useSessionStore } from "@/stores/session-store";

export function useCheckpointDiffQuery({
  serverId,
  workspaceId,
  selection,
  enabled,
}: {
  serverId: string;
  workspaceId?: string | null;
  selection?: CheckpointDiffSelection;
  enabled: boolean;
}) {
  const copy = useCheckpointCopy();
  const supported = useRewindCheckpointsSupported(serverId);
  const client = useSessionStore((state) => state.sessions[serverId]?.client);
  const { target, range } = selection ?? {};
  const available = supported && Boolean(client);
  const query = useFetchQuery({
    queryKey: [
      "rewind-checkpoint-diff",
      serverId,
      workspaceId,
      target?.agentId,
      target?.messageId,
      range,
    ],
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: async () => {
      if (!client || !target || !range) throw new Error(copy.unavailable);
      return readCheckpointDiffResult(
        await client.getAgentRewindCheckpointDiff({ ...target, range }),
        copy.loadFailed,
      );
    },
    enabled: enabled && available && Boolean(range),
    retry: false,
  });
  return resolveCheckpointDiffView({ available, result: query.data, error: query.error, copy });
}
