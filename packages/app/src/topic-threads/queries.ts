import { replaceEqualDeep, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  AgentAttachment,
  TopicAnchorSummary,
  TopicBlockingResolutionKind,
  TopicDelegationSummary,
  TopicReplyRouteMode,
  TopicThreadEntry,
  WorkspaceTaskSummary,
  WorkspaceTopicAnchorUpdatedMessage,
  WorkspaceTopicDecideRequest,
  WorkspaceTopicDecideResponse,
  WorkspaceTopicReplyResponse,
  WorkspaceTopicThreadUpdatedMessage,
} from "@getpaseo/protocol/messages";
import { useMemo } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import {
  applySingleWorkspaceTaskToCache,
  workspaceTasksQueryPrefix,
} from "@/composer/workspace-task-ledger/query";
import { useFetchQuery, useReplicaQuery } from "@/data/query";
import { applyDurableItemUpdateToCache } from "@/durable-items/queries";
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

export function workspaceTopicAnchorsQueryKey(
  serverId: string,
  workspaceId: string,
  mainAgentId: string,
) {
  return ["workspace-topic-anchors", serverId, workspaceId, mainAgentId] as const;
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

function compareAnchors(left: TopicAnchorSummary, right: TopicAnchorSummary): number {
  const leftMs = Date.parse(left.createdAt) || 0;
  const rightMs = Date.parse(right.createdAt) || 0;
  if (leftMs !== rightMs) return leftMs - rightMs;
  return left.topicKey.localeCompare(right.topicKey);
}

function findSiblingRootPromptText(
  anchors: readonly TopicAnchorSummary[],
  rootMessageId: string | undefined,
): string {
  if (!rootMessageId) return "";
  const sibling = anchors.find(
    (anchor) =>
      anchor.rootMessageId === rootMessageId &&
      anchor.rootPromptText.trim().length > 0 &&
      anchor.rootPromptText !== anchor.title,
  );
  return sibling?.rootPromptText ?? "";
}

function delegationKey(delegation: TopicDelegationSummary): string {
  return JSON.stringify([delegation.serverId, delegation.agentId, delegation.messageId]);
}

function mergeDelegations(
  existing?: TopicDelegationSummary[],
  incoming?: TopicDelegationSummary[],
): TopicDelegationSummary[] | undefined {
  if (!existing || !incoming || existing === incoming) return incoming ?? existing;
  const byDispatch = new Map(existing.map((delegation) => [delegationKey(delegation), delegation]));
  for (const delegation of incoming) {
    const key = delegationKey(delegation);
    const previous = byDispatch.get(key);
    if (!previous || Date.parse(delegation.updatedAt) >= Date.parse(previous.updatedAt)) {
      byDispatch.set(key, delegation);
    }
  }
  return [...byDispatch.values()];
}

function mergeAnchor(
  existing: TopicAnchorSummary,
  incoming: TopicAnchorSummary,
): TopicAnchorSummary {
  const existingUpdatedMs = Date.parse(existing.updatedAt) || 0;
  const incomingUpdatedMs = Date.parse(incoming.updatedAt) || 0;
  const newer = incomingUpdatedMs >= existingUpdatedMs ? incoming : existing;
  const older = newer === incoming ? existing : incoming;
  const resolvedTaskId = incoming.taskId ?? existing.taskId;
  return {
    ...older,
    ...newer,
    topicKey: resolvedTaskId ? `task:${resolvedTaskId}` : newer.topicKey,
    taskId: resolvedTaskId,
    rootMessageId: newer.rootMessageId ?? older.rootMessageId,
    rootPromptText: newer.rootPromptText.trim() ? newer.rootPromptText : older.rootPromptText,
    title: newer.title ?? older.title,
    leadAgentId: newer.leadAgentId ?? older.leadAgentId,
    leadServerId: newer.leadServerId ?? older.leadServerId,
    leadTitle: newer.leadTitle ?? older.leadTitle,
    delegations: mergeDelegations(existing.delegations, incoming.delegations),
    createdAt:
      (Date.parse(older.createdAt) || Infinity) < (Date.parse(newer.createdAt) || Infinity)
        ? older.createdAt
        : newer.createdAt,
  };
}

function resolveIncomingAnchorTaskId(anchor: TopicAnchorSummary): string | undefined {
  if (anchor.taskId) return anchor.taskId;
  return anchor.topicKey.startsWith("task:") ? anchor.topicKey.slice(5) : undefined;
}

function backfillBoundAnchorsFromTemporaryMessage(
  anchors: readonly TopicAnchorSummary[],
  rootMessageId: string,
  promptText: string,
): TopicAnchorSummary[] | null {
  const hasBoundForRoot = anchors.some(
    (anchor) =>
      Boolean(resolveIncomingAnchorTaskId(anchor)) && anchor.rootMessageId === rootMessageId,
  );
  if (!hasBoundForRoot) return null;
  if (!promptText) return [...anchors].sort(compareAnchors);
  return anchors
    .map((anchor) =>
      resolveIncomingAnchorTaskId(anchor) &&
      anchor.rootMessageId === rootMessageId &&
      !anchor.rootPromptText.trim()
        ? { ...anchor, rootPromptText: promptText }
        : anchor,
    )
    .sort(compareAnchors);
}

function findMatchingAnchorIndices(
  anchors: readonly TopicAnchorSummary[],
  incoming: TopicAnchorSummary,
  incomingTaskId: string | undefined,
  messageKey: string | undefined,
): number[] {
  const matchedIndices: number[] = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const existing = anchors[i]!;
    const existingTaskId = resolveIncomingAnchorTaskId(existing);
    if (
      existing.topicKey === incoming.topicKey ||
      (incomingTaskId && existingTaskId && incomingTaskId === existingTaskId) ||
      (incomingTaskId && !existingTaskId && messageKey && existing.topicKey === messageKey)
    ) {
      matchedIndices.push(i);
    }
  }
  return matchedIndices;
}

export function upsertTopicAnchor(
  anchors: readonly TopicAnchorSummary[],
  incoming: TopicAnchorSummary,
): TopicAnchorSummary[] {
  const incomingTaskId = resolveIncomingAnchorTaskId(incoming);
  const rootMessageId = incoming.rootMessageId;
  const messageKey = rootMessageId ? `msg:${rootMessageId}` : undefined;

  // Refreshing a temporary msg:<root> anchor when task-bound anchors already exist for this root
  // must keep every task anchor independent and only backfill empty prompt text.
  if (!incomingTaskId && rootMessageId && messageKey && incoming.topicKey === messageKey) {
    const backfilled = backfillBoundAnchorsFromTemporaryMessage(
      anchors,
      rootMessageId,
      incoming.rootPromptText.trim(),
    );
    if (backfilled) return backfilled;
  }

  // Match strictly by exact topicKey/taskId; when a task anchor arrives, absorb ONLY an unbound
  // temporary msg:<root> anchor so sibling tasks under the same rootMessageId stay isolated.
  const matchedIndices = findMatchingAnchorIndices(anchors, incoming, incomingTaskId, messageKey);

  if (matchedIndices.length === 0) {
    const fallbackPrompt =
      incoming.rootPromptText.trim() || findSiblingRootPromptText(anchors, rootMessageId);
    const normalized =
      fallbackPrompt && !incoming.rootPromptText.trim()
        ? { ...incoming, rootPromptText: fallbackPrompt }
        : incoming;
    return [...anchors, normalized].sort(compareAnchors);
  }

  let merged = incoming;
  for (const idx of matchedIndices) {
    merged = mergeAnchor(anchors[idx]!, merged);
  }
  const rest = anchors.filter((_, index) => !matchedIndices.includes(index));
  return [...rest, merged].sort(compareAnchors);
}

function mergeFetchedAnchors(
  snapshot: readonly TopicAnchorSummary[],
  beforeFetch: readonly TopicAnchorSummary[],
  current: readonly TopicAnchorSummary[],
): TopicAnchorSummary[] {
  let merged = [...snapshot].sort(compareAnchors);
  if (current === beforeFetch) return merged;
  const priorByKey = new Map(beforeFetch.map((anchor) => [anchor.topicKey, anchor]));
  for (const anchor of current) {
    const prior =
      priorByKey.get(anchor.topicKey) ??
      (anchor.taskId && anchor.rootMessageId
        ? priorByKey.get(`msg:${anchor.rootMessageId}`)
        : undefined);
    if (prior === anchor) continue;
    // An ordinary thread event can update anchor metadata while carrying forward
    // a stale delegation from the cache. Replay only changed dispatches.
    const priorByDispatch = new Map(
      prior?.delegations?.map((delegation) => [delegationKey(delegation), delegation]),
    );
    const changed = anchor.delegations?.filter((delegation) => {
      const previous = priorByDispatch.get(delegationKey(delegation));
      return !previous || replaceEqualDeep(previous, delegation) !== previous;
    });
    merged = upsertTopicAnchor(merged, {
      ...anchor,
      delegations: changed?.length ? changed : undefined,
    });
  }
  return merged;
}

export function applyTopicAnchorToCache(
  queryClient: QueryClient,
  serverId: string,
  payload: WorkspaceTopicAnchorUpdatedMessage["payload"],
): void {
  const queryKey = workspaceTopicAnchorsQueryKey(
    serverId,
    payload.workspaceId,
    payload.mainAgentId,
  );
  queryClient.setQueryData<TopicAnchorSummary[]>(queryKey, (previous) =>
    upsertTopicAnchor(previous ?? [], payload.anchor),
  );
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
  if (payload.anchor) {
    applyTopicAnchorToCache(queryClient, serverId, {
      workspaceId: payload.workspaceId,
      mainAgentId: payload.mainAgentId,
      anchor: payload.anchor,
    });
  }
}

export function useWorkspaceTopicEntries(
  serverId: string,
  workspaceId: string,
  mainAgentId: string | null,
  activeOverride?: boolean,
) {
  const queryClient = useQueryClient();
  const paneActive = useRetainedPanelActive();
  const appVisible = useAppVisible();
  const supported = useHostFeature(serverId, FEATURE);
  const serverIds = useMemo(() => [serverId], [serverId]);
  const online = useHostRuntimeConnectionStatuses(serverIds).get(serverId) === "online";
  const active = activeOverride ?? paneActive;
  const enabled =
    Boolean(workspaceId && mainAgentId) && active && appVisible && supported && online;

  const anchorsKey = useMemo(
    () => workspaceTopicAnchorsQueryKey(serverId, workspaceId, mainAgentId ?? ""),
    [mainAgentId, serverId, workspaceId],
  );

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
      const beforeFetch = queryClient.getQueryData<TopicAnchorSummary[]>(anchorsKey) ?? [];
      const response = await client.listWorkspaceTopicEntries({ workspaceId, mainAgentId });
      signal.throwIfAborted();
      if (response.error) throw new Error(response.error);
      if (response.anchors) {
        const incomingAnchors = response.anchors;
        queryClient.setQueryData<TopicAnchorSummary[]>(anchorsKey, (current) =>
          mergeFetchedAnchors(incomingAnchors, beforeFetch, current ?? []),
        );
      }
      return [...response.entries].sort(compareEntries);
    },
  });

  const anchorsQuery = useReplicaQuery<TopicAnchorSummary[]>({
    queryKey: anchorsKey,
    pushEvent: "workspace.topic.anchor.updated",
    enabled: false,
  });

  return {
    entries: supported ? (query.data ?? []) : [],
    anchors: supported ? (anchorsQuery.data ?? []) : [],
    isSupported: supported,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

/** A reply response explicitly declined the request. Transport failures leave its result unknown. */
export class TopicReplyRejectedError extends Error {}

export async function replyToWorkspaceTopic(input: {
  queryClient: QueryClient;
  serverId: string;
  workspaceId: string;
  mainAgentId: string;
  topicKey: string;
  taskId?: string;
  rootMessageId?: string;
  rootPromptPreview?: string;
  clientMessageId?: string;
  retryOfEntryId?: string;
  text: string;
  routeMode?: TopicReplyRouteMode;
  attachments?: AgentAttachment[];
}): Promise<WorkspaceTopicReplyResponse["payload"]> {
  const client = getOnlineThreadClient(input.serverId);
  if (!client) throw new Error("Host is offline");
  const trimmedPreview = input.rootPromptPreview?.trim();
  const response = await client.replyWorkspaceTopic({
    workspaceId: input.workspaceId,
    mainAgentId: input.mainAgentId,
    topicKey: input.topicKey,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.rootMessageId ? { rootMessageId: input.rootMessageId } : {}),
    ...(trimmedPreview ? { rootPromptPreview: trimmedPreview } : {}),
    clientMessageId: input.clientMessageId?.trim() || generateMessageId(),
    text: input.text,
    ...(input.retryOfEntryId ? { retryOfEntryId: input.retryOfEntryId } : {}),
    ...(input.routeMode ? { routeMode: input.routeMode } : {}),
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
  });
  if (response.entry) {
    applyTopicThreadEntryToCache(input.queryClient, input.serverId, {
      workspaceId: input.workspaceId,
      mainAgentId: input.mainAgentId,
      entry: response.entry,
    });
  }
  if (response.error) throw new TopicReplyRejectedError(response.error);
  return response;
}

function applyDurableDecisionTask(
  queryClient: QueryClient,
  serverId: string,
  workspaceId: string,
  task: WorkspaceTaskSummary,
) {
  queryClient.setQueriesData<WorkspaceTaskSummary[]>(
    { queryKey: workspaceTasksQueryPrefix(serverId, workspaceId) },
    (previous = []) => {
      const existing = previous.find((current) => current.taskId === task.taskId);
      if (!existing) return [...previous, task];
      const existingUpdatedAt = Date.parse(existing.updatedAt);
      const responseUpdatedAt = Date.parse(task.updatedAt);
      // An approval may finish after a task update with a newer blocking question arrives.
      if (
        existingUpdatedAt > responseUpdatedAt ||
        (existingUpdatedAt === responseUpdatedAt &&
          existing.blockingQuestionGeneration &&
          existing.blockingQuestionGeneration !== task.blockingQuestionGeneration)
      ) {
        return previous;
      }
      return previous.map((current) => (current === existing ? task : current));
    },
  );
}

export async function decideWorkspaceTopicOnHost(input: {
  queryClient: QueryClient;
  serverId: string;
  workspaceId: string;
  mainAgentId: string;
  topicKey: string;
  taskId?: string;
  rootMessageId?: string;
  clientMessageId?: string;
  resolutionKind: TopicBlockingResolutionKind;
  expectedBlockingQuestionGeneration?: string;
  durableItemRequestId?: string;
  expectedRevision?: number;
  decision?: WorkspaceTopicDecideRequest["decision"];
  note?: string;
  dispatchFollowup?: boolean;
}): Promise<WorkspaceTopicDecideResponse["payload"]> {
  const client = getOnlineThreadClient(input.serverId);
  if (!client) throw new Error("Host is offline");
  const trimmedNote = input.note?.trim();
  const response = await client.decideWorkspaceTopic({
    workspaceId: input.workspaceId,
    mainAgentId: input.mainAgentId,
    topicKey: input.topicKey,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.rootMessageId ? { rootMessageId: input.rootMessageId } : {}),
    clientMessageId: input.clientMessageId?.trim() || generateMessageId(),
    resolutionKind: input.resolutionKind,
    ...(input.expectedBlockingQuestionGeneration
      ? { expectedBlockingQuestionGeneration: input.expectedBlockingQuestionGeneration }
      : {}),
    ...(input.durableItemRequestId ? { durableItemRequestId: input.durableItemRequestId } : {}),
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
    ...(input.decision ? { decision: input.decision } : {}),
    ...(trimmedNote ? { note: trimmedNote } : {}),
    ...(input.dispatchFollowup !== undefined ? { dispatchFollowup: input.dispatchFollowup } : {}),
  });

  if (response.durableItem) {
    applyDurableItemUpdateToCache(input.queryClient, input.serverId, {
      workspaceId: input.workspaceId,
      item: response.durableItem,
    });
  }
  if (response.task) {
    const applyTask =
      input.resolutionKind === "durable_item"
        ? applyDurableDecisionTask
        : applySingleWorkspaceTaskToCache;
    applyTask(input.queryClient, input.serverId, input.workspaceId, response.task);
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
