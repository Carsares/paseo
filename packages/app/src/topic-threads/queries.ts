import type { QueryClient } from "@tanstack/react-query";
import type {
  AgentAttachment,
  TopicReplyRouteMode,
  TopicThreadEntry,
  WorkspaceTopicReplyResponse,
  WorkspaceTopicThreadUpdatedMessage,
} from "@getpaseo/protocol/messages";
import { useMemo } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchQuery } from "@/data/query";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";
import { generateMessageId } from "@/types/stream";

// COMPAT(workspaceTopicThreads): added in v0.18.0, remove gate after 2027-06-01.
const FEATURE = "workspaceTopicThreads";
const TOPIC_ENTRIES_STALE_MS = 30_000;

export function workspaceTopicEntriesQueryKey(
  serverId: string,
  workspaceId: string,
  mainAgentId: string,
) {
  return ["workspace-topic-entries", serverId, workspaceId, mainAgentId] as const;
}

function getOnlineThreadClient(serverId: string) {
  const snapshot = getHostRuntimeStore().getSnapshot(serverId);
  return snapshot?.connectionStatus === "online" ? snapshot.client : null;
}

function compareEntries(left: TopicThreadEntry, right: TopicThreadEntry): number {
  if (left.seq !== right.seq) return left.seq - right.seq;
  const leftMs = Date.parse(left.createdAt) || 0;
  const rightMs = Date.parse(right.createdAt) || 0;
  if (leftMs !== rightMs) return leftMs - rightMs;
  return left.entryId.localeCompare(right.entryId);
}

export function upsertTopicThreadEntry(
  entries: readonly TopicThreadEntry[],
  incoming: TopicThreadEntry,
): TopicThreadEntry[] {
  const index = entries.findIndex((entry) => entry.entryId === incoming.entryId);
  if (index < 0) {
    return [...entries, incoming].sort(compareEntries);
  }
  const next = [...entries];
  next[index] = incoming;
  return next.sort(compareEntries);
}

export function applyTopicThreadEntryToCache(
  queryClient: QueryClient,
  serverId: string,
  payload: WorkspaceTopicThreadUpdatedMessage["payload"],
): void {
  const queryKey = workspaceTopicEntriesQueryKey(
    serverId,
    payload.workspaceId,
    payload.mainAgentId,
  );
  queryClient.setQueryData<TopicThreadEntry[]>(queryKey, (previous) =>
    upsertTopicThreadEntry(previous ?? [], payload.entry),
  );
}

export function useWorkspaceTopicEntries(
  serverId: string,
  workspaceId: string,
  mainAgentId: string | null,
  activeOverride?: boolean,
) {
  const paneActive = useRetainedPanelActive();
  const appVisible = useAppVisible();
  const supported = useHostFeature(serverId, FEATURE);
  const serverIds = useMemo(() => [serverId], [serverId]);
  const online = useHostRuntimeConnectionStatuses(serverIds).get(serverId) === "online";
  const active = activeOverride ?? paneActive;
  const enabled =
    Boolean(workspaceId && mainAgentId) && active && appVisible && supported && online;

  const query = useFetchQuery({
    queryKey: workspaceTopicEntriesQueryKey(serverId, workspaceId, mainAgentId ?? ""),
    dataShape: "value" as const,
    staleTimeMs: TOPIC_ENTRIES_STALE_MS,
    enabled,
    refetchOnWindowFocus: true,
    retry: false as const,
    queryFn: async ({ signal }) => {
      const client = getOnlineThreadClient(serverId);
      if (!client || !mainAgentId) throw new Error("Host is offline");
      signal.throwIfAborted();
      const response = await client.listWorkspaceTopicEntries({ workspaceId, mainAgentId });
      signal.throwIfAborted();
      if (response.error) throw new Error(response.error);
      return [...response.entries].sort(compareEntries);
    },
  });

  return {
    entries: supported ? (query.data ?? []) : [],
    isSupported: supported,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

export async function replyToWorkspaceTopic(input: {
  queryClient: QueryClient;
  serverId: string;
  workspaceId: string;
  mainAgentId: string;
  topicKey: string;
  taskId?: string;
  rootMessageId?: string;
  clientMessageId?: string;
  text: string;
  routeMode?: TopicReplyRouteMode;
  attachments?: AgentAttachment[];
}): Promise<WorkspaceTopicReplyResponse["payload"]> {
  const client = getOnlineThreadClient(input.serverId);
  if (!client) throw new Error("Host is offline");
  const response = await client.replyWorkspaceTopic({
    workspaceId: input.workspaceId,
    mainAgentId: input.mainAgentId,
    topicKey: input.topicKey,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.rootMessageId ? { rootMessageId: input.rootMessageId } : {}),
    clientMessageId: input.clientMessageId?.trim() || generateMessageId(),
    text: input.text,
    ...(input.routeMode ? { routeMode: input.routeMode } : {}),
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
  });
  if (response.error) {
    throw new Error(response.error);
  }
  if (response.entry) {
    applyTopicThreadEntryToCache(input.queryClient, input.serverId, {
      workspaceId: input.workspaceId,
      mainAgentId: input.mainAgentId,
      entry: response.entry,
    });
  }
  return response;
}
