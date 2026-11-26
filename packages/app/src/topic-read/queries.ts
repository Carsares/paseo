import type { QueryClient } from "@tanstack/react-query";
import type {
  WorkspaceTopicReadMarkAllRequest,
  WorkspaceTopicReadMarkRequest,
  WorkspaceTopicReadSnapshot,
} from "@getpaseo/protocol/messages";
import { useMemo } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchQuery } from "@/data/query";
import { useAppVisible } from "@/hooks/use-app-visible";
import { hostSupportsFeature, useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  buildTopicInboxReadScopeKey,
  useTopicInboxReadStore,
} from "@/stores/topic-inbox-read-store";

// COMPAT(workspaceTopicReadState): added in v0.18.0, remove gate after 2027-06-01.
const FEATURE = "workspaceTopicReadState";
const TOPIC_READ_STALE_MS = 30_000;

export function workspaceTopicReadQueryKey(
  serverId: string,
  workspaceId: string,
  mainAgentId: string,
) {
  return ["workspace-topic-read", serverId, workspaceId, mainAgentId] as const;
}

function getOnlineReadClient(serverId: string) {
  const snapshot = getHostRuntimeStore().getSnapshot(serverId);
  return snapshot?.connectionStatus === "online" ? snapshot.client : null;
}

export function applyTopicReadSnapshotToCache(
  queryClient: QueryClient,
  serverId: string,
  snapshot: WorkspaceTopicReadSnapshot,
): void {
  const queryKey = workspaceTopicReadQueryKey(serverId, snapshot.workspaceId, snapshot.mainAgentId);
  queryClient.setQueryData<WorkspaceTopicReadSnapshot | null>(queryKey, (previous) => {
    if (previous && snapshot.revision < previous.revision) {
      return previous;
    }
    return snapshot;
  });
}

export function useWorkspaceTopicReadState(
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
    queryKey: workspaceTopicReadQueryKey(serverId, workspaceId, mainAgentId ?? ""),
    dataShape: "value" as const,
    staleTimeMs: TOPIC_READ_STALE_MS,
    enabled,
    refetchOnWindowFocus: true,
    retry: false as const,
    queryFn: async ({ signal }) => {
      const client = getOnlineReadClient(serverId);
      if (!client || !mainAgentId) throw new Error("Host is offline");
      signal.throwIfAborted();
      const response = await client.getWorkspaceTopicReadState({ workspaceId, mainAgentId });
      signal.throwIfAborted();
      if (response.error) throw new Error(response.error);
      return response.snapshot;
    },
  });

  return {
    snapshot: supported ? (query.data ?? null) : null,
    isSupported: supported,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

export async function markTopicReadOnHost(input: {
  queryClient: QueryClient;
  serverId: string;
  workspaceId: string;
  mainAgentId: string;
  topicKey: string;
  mode: WorkspaceTopicReadMarkRequest["mode"];
  seq?: number;
  timestampMs?: number;
  fallbackItemIds?: readonly string[];
}): Promise<WorkspaceTopicReadSnapshot | null> {
  const session = useSessionStore.getState().sessions[input.serverId];
  const supportsServerRead = hostSupportsFeature(session?.serverInfo, FEATURE);
  const client = getOnlineReadClient(input.serverId);

  if (supportsServerRead && client) {
    const response = await client.markWorkspaceTopicRead({
      workspaceId: input.workspaceId,
      mainAgentId: input.mainAgentId,
      topicKey: input.topicKey,
      mode: input.mode,
      ...(typeof input.seq === "number" ? { seq: input.seq } : {}),
      ...(typeof input.timestampMs === "number" ? { timestampMs: input.timestampMs } : {}),
    });
    if (response.error) throw new Error(response.error);
    if (response.snapshot) {
      applyTopicReadSnapshotToCache(input.queryClient, input.serverId, response.snapshot);
    }
    return response.snapshot;
  }

  if (input.mode === "read") {
    const scopeKey = buildTopicInboxReadScopeKey({
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      mainAgentId: input.mainAgentId,
    });
    const readStore = useTopicInboxReadStore.getState();
    for (const itemId of input.fallbackItemIds ?? [input.topicKey]) {
      readStore.markItemRead(scopeKey, itemId);
    }
  }
  return null;
}

export async function markAllTopicsReadOnHost(input: {
  queryClient: QueryClient;
  serverId: string;
  workspaceId?: string;
  mainAgentId?: string;
  epoch?: string | null;
  maxSeq?: number | null;
  maxTimestampMs?: number | null;
  fallbackItemIds?: readonly string[];
}): Promise<WorkspaceTopicReadSnapshot[]> {
  const session = useSessionStore.getState().sessions[input.serverId];
  const supportsServerRead = hostSupportsFeature(session?.serverInfo, FEATURE);
  const client = getOnlineReadClient(input.serverId);

  if (input.workspaceId && input.mainAgentId) {
    const scopeKey = buildTopicInboxReadScopeKey({
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      mainAgentId: input.mainAgentId,
    });
    useTopicInboxReadStore.getState().markAllRead(scopeKey, {
      epoch: input.epoch ?? null,
      maxSeq: input.maxSeq ?? null,
      maxTimestampMs: input.maxTimestampMs ?? null,
      itemIds: input.fallbackItemIds,
    });
  }

  if (supportsServerRead && client) {
    const payload: Omit<WorkspaceTopicReadMarkAllRequest, "type" | "requestId"> = {
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.mainAgentId ? { mainAgentId: input.mainAgentId } : {}),
      ...(input.epoch !== undefined ? { epoch: input.epoch } : {}),
      ...(typeof input.maxSeq === "number" ? { maxSeq: input.maxSeq } : {}),
      ...(typeof input.maxTimestampMs === "number" ? { maxTimestampMs: input.maxTimestampMs } : {}),
    };
    const response = await client.markAllWorkspaceTopicsRead(payload);
    if (response.error) throw new Error(response.error);
    for (const snapshot of response.snapshots) {
      applyTopicReadSnapshotToCache(input.queryClient, input.serverId, snapshot);
    }
    return response.snapshots;
  }

  return [];
}
