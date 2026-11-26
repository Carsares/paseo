import type {
  PendingSubagentInboxItem,
  TopicReplyRouteMode,
  TopicThreadEntry,
  WorkspaceDurableItem,
  WorkspaceTaskSummary,
  WorkspaceTodoItem,
  WorkspaceTopicReadSnapshot,
} from "@getpaseo/protocol/messages";
import type { PendingPermission } from "@/types/shared";
import { isTopicInboxItemRead, type TopicInboxReadScope } from "@/stores/topic-inbox-read-store";
import {
  getStreamItemMessageId,
  type AssistantMessageItem,
  type StreamItem,
  type ThoughtItem,
  type ToolCallItem,
  type UserMessageItem,
} from "@/types/stream";
import {
  getAgentMessage,
  getAgentSourcePresentation,
  resolveAgentSourceStatus,
  type AgentSourceStatus,
} from "../agent-interactions";

export type TopicLifecycleStatus =
  | "dispatching"
  | "aggregating"
  | "unread"
  | "blocked"
  | "interrupted"
  | "error"
  | "settled";

export type TopicProcessStep =
  | {
      kind: "tool_call";
      id: string;
      toolName: string;
      status: string;
      timestampMs: number;
      item: ToolCallItem;
    }
  | {
      kind: "thought";
      id: string;
      text: string;
      status: ThoughtItem["status"];
      timestampMs: number;
      item: ThoughtItem;
    };

export type TopicReplyItem =
  | {
      kind: "subagent_report";
      id: string;
      senderId: string;
      senderServerId?: string;
      senderTitle: string;
      status: AgentSourceStatus;
      text: string;
      taskId?: string;
      rootMessageId?: string;
      epoch: string | null;
      /** Main timeline sequence number (null when unavailable). */
      seq: number | null;
      timestampMs: number;
      isUnread: boolean;
    }
  | {
      kind: "main_conclusion";
      id: string;
      messageId?: string;
      text: string;
      epoch: string | null;
      /** Main timeline sequence number (null when unavailable). */
      seq: number | null;
      timestampMs: number;
      isUnread: boolean;
      item: AssistantMessageItem;
    }
  | {
      kind: "thread_entry";
      id: string;
      entry: TopicThreadEntry;
      /** Separate topic-thread sequence domain; never compared against main timeline seq. */
      threadSeq: number;
      /** Always null for thread entries so main timeline watermarks stay unpolluted. */
      seq: null;
      timestampMs: number;
      isUnread: boolean;
    };

export interface TopicRetryCandidate {
  text: string;
  routeMode: TopicReplyRouteMode;
  clientMessageId?: string;
}

export interface TopicUnmatchedRef {
  topicKey?: string;
  taskId?: string;
  rootMessageId?: string;
}

export interface TopicUnit {
  topicKey: string;
  taskId?: string;
  rootItemId: string;
  rootMessageId?: string;
  rootPrompt: {
    id: string;
    messageId?: string;
    text: string;
    timestampMs: number;
    seq: number | null;
    epoch: string | null;
    item: UserMessageItem | null;
  };
  task: WorkspaceTaskSummary | null;
  leadAgentId?: string;
  leadServerId?: string;
  leadTitle?: string;
  processSteps: TopicProcessStep[];
  replies: TopicReplyItem[];
  pendingInboxItems: PendingSubagentInboxItem[];
  linkedTodos: WorkspaceTodoItem[];
  linkedDurableItems: WorkspaceDurableItem[];
  linkedPermissions: PendingPermission[];
  unreadReplyCount: number;
  firstUnreadReplyIndex: number | null;
  isMarkedUnread: boolean;
  hasUnread: boolean;
  /** Highest main-timeline seq inside this topic (never polluted by thread-entry seq). */
  latestSeq: number | null;
  latestTimestampMs: number;
  latestEpoch: string | null;
  lifecycleStatus: TopicLifecycleStatus;
  retryCandidate: TopicRetryCandidate | null;
}

export interface TopicWatermarkSnapshot {
  epoch: string | null;
  /** Highest main-timeline seq across projected topics. */
  maxSeq: number | null;
  /** Highest timestamp (ms) across both main-timeline items and mirrored thread entries. */
  maxTimestampMs: number;
  fallbackItemIds: string[];
}

export interface TopicProjectionResult {
  topics: TopicUnit[];
  totalUnreadTopics: number;
  totalUnreadReplies: number;
  watermark: TopicWatermarkSnapshot;
  unmatchedExplicitRefs: TopicUnmatchedRef[];
}

export interface ProjectTopicUnitsInput {
  items: readonly StreamItem[];
  tasks?: readonly WorkspaceTaskSummary[];
  threadEntries?: readonly TopicThreadEntry[];
  pendingInboxItems?: readonly PendingSubagentInboxItem[];
  todos?: readonly WorkspaceTodoItem[];
  durableItems?: readonly WorkspaceDurableItem[];
  pendingPermissions?: readonly PendingPermission[];
  readSnapshot?: WorkspaceTopicReadSnapshot | null;
  legacyReadScope?: TopicInboxReadScope;
  isTurnActive?: boolean;
  agentRequiresAttention?: boolean;
  fallbackSenderTitle?: string;
  agentTitleById?: ReadonlyMap<string, string>;
}

interface MutableTopicUnit {
  topicKey: string;
  taskId?: string;
  rootItemId: string;
  rootMessageId?: string;
  rootPrompt: TopicUnit["rootPrompt"];
  task: WorkspaceTaskSummary | null;
  leadAgentId?: string;
  leadServerId?: string;
  leadTitle?: string;
  processSteps: TopicProcessStep[];
  replies: TopicReplyItem[];
  pendingInboxItems: PendingSubagentInboxItem[];
  linkedTodos: WorkspaceTodoItem[];
  linkedDurableItems: WorkspaceDurableItem[];
  linkedPermissions: PendingPermission[];
  /** Timestamp of the latest canceled main-timeline item belonging to this topic (for taskless turns). */
  latestCanceledTurnTimestampMs: number | null;
}

interface TopicBuilderState {
  topics: MutableTopicUnit[];
  byTaskId: Map<string, MutableTopicUnit>;
  byRootMessageId: Map<string, MutableTopicUnit>;
  byTopicKey: Map<string, MutableTopicUnit>;
  taskById: Map<string, WorkspaceTaskSummary>;
  taskByRootMessageId: Map<string, WorkspaceTaskSummary>;
  userFollowupBySourceMessageId: Map<string, TopicThreadEntry>;
  mirroredReplySourceMessageIds: Set<string>;
  unmatchedUserFollowups: TopicThreadEntry[];
  unmatchedAgentReplies: TopicThreadEntry[];
  consumedFollowupEntryIds: Set<string>;
  consumedReplyEntryIds: Set<string>;
  unmatchedExplicitRefs: TopicUnmatchedRef[];
  activeTopic: MutableTopicUnit | undefined;
  activeMainFollowup: TopicThreadEntry | undefined;
  fallbackSenderTitle: string;
  agentTitleById?: ReadonlyMap<string, string>;
}

const FALLBACK_MIRROR_WINDOW_MS = 120_000;

function normalizeDedupeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function isRealHumanPrompt(item: UserMessageItem): boolean {
  return item.sender === undefined && getAgentSourcePresentation(item) === undefined;
}

function resolveToolCallName(item: ToolCallItem): string {
  return item.payload.source === "agent" ? item.payload.data.name : item.payload.data.toolName;
}

function resolveToolCallStatus(item: ToolCallItem): string {
  return item.payload.source === "agent" ? item.payload.data.status : item.payload.data.status;
}

function parseIsoMs(iso: string | null | undefined, fallback = 0): number {
  if (!iso) return fallback;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isStreamItemTurnCanceled(item: StreamItem): boolean {
  return (
    (item.kind === "user_message" ||
      item.kind === "assistant_message" ||
      item.kind === "thought" ||
      item.kind === "tool_call") &&
    item.turnCanceled === true
  );
}

function markTopicCanceledIfStamped(unit: MutableTopicUnit, item: StreamItem): void {
  if (!isStreamItemTurnCanceled(item)) return;
  const ts = item.timestamp.getTime();
  unit.latestCanceledTurnTimestampMs =
    unit.latestCanceledTurnTimestampMs === null
      ? ts
      : Math.max(unit.latestCanceledTurnTimestampMs, ts);
}

function registerTopic(state: TopicBuilderState, unit: MutableTopicUnit): void {
  state.topics.push(unit);
  state.byTopicKey.set(unit.topicKey, unit);
  if (unit.taskId) state.byTaskId.set(unit.taskId, unit);
  if (unit.rootMessageId) state.byRootMessageId.set(unit.rootMessageId, unit);
  state.byRootMessageId.set(unit.rootItemId, unit);
}

function ensureFallbackTopic(state: TopicBuilderState, item: StreamItem): MutableTopicUnit {
  const existing = state.topics.at(-1);
  if (existing) return existing;
  const messageId = getStreamItemMessageId(item);
  const synthetic: MutableTopicUnit = {
    topicKey: `msg:${messageId}`,
    rootItemId: item.id,
    rootMessageId: messageId,
    rootPrompt: {
      id: item.id,
      messageId,
      text: "",
      timestampMs: item.timestamp.getTime(),
      seq: item.timelineCursor?.seq ?? null,
      epoch: item.timelineCursor?.epoch ?? null,
      item: null,
    },
    task: null,
    processSteps: [],
    replies: [],
    pendingInboxItems: [],
    linkedTodos: [],
    linkedDurableItems: [],
    linkedPermissions: [],
    latestCanceledTurnTimestampMs: null,
  };
  registerTopic(state, synthetic);
  return synthetic;
}

function recordUnmatchedRef(
  state: TopicBuilderState,
  { topicKey, taskId, rootMessageId }: TopicUnmatchedRef,
): void {
  if (!topicKey && !taskId && !rootMessageId) return;
  const alreadyRecorded = state.unmatchedExplicitRefs.some(
    (existing) =>
      existing.topicKey === topicKey &&
      existing.taskId === taskId &&
      existing.rootMessageId === rootMessageId,
  );
  if (!alreadyRecorded) {
    state.unmatchedExplicitRefs.push({ topicKey, taskId, rootMessageId });
  }
}

/**
 * Matches a topic unit by explicit references (`topicKey`, `taskId`, `rootMessageId`).
 * When ANY explicit reference is supplied, never falls back to an unrelated latest topic card —
 * returning `undefined` instead so out-of-window items wait for older history instead of
 * corrupting another topic.
 */
function findMatchingTopic(
  state: TopicBuilderState,
  hint: { taskId?: string; rootMessageId?: string; topicKey?: string },
): MutableTopicUnit | undefined {
  const hasExplicitRef = Boolean(hint.topicKey || hint.taskId || hint.rootMessageId);
  if (hint.topicKey) {
    const exact = state.byTopicKey.get(hint.topicKey);
    if (exact) return exact;
    if (hint.topicKey.startsWith("msg:")) {
      const byMsgKey = state.byRootMessageId.get(hint.topicKey.slice(4));
      if (byMsgKey) return byMsgKey;
    } else if (hint.topicKey.startsWith("task:")) {
      const byTaskKey = state.byTaskId.get(hint.topicKey.slice(5));
      if (byTaskKey) return byTaskKey;
    }
  }
  if (hint.taskId) {
    const byTask = state.byTaskId.get(hint.taskId);
    if (byTask) return byTask;
  }
  if (hint.rootMessageId) {
    const byRoot = state.byRootMessageId.get(hint.rootMessageId);
    if (byRoot) return byRoot;
  }
  if (hasExplicitRef) {
    return undefined;
  }
  return state.activeTopic ?? state.topics.at(-1);
}

function entryBelongsToUnit(entry: TopicThreadEntry, unit: MutableTopicUnit): boolean {
  if (entry.topicKey === unit.topicKey) return true;
  if (entry.taskId && unit.taskId && entry.taskId === unit.taskId) return true;
  if (
    entry.rootMessageId &&
    (entry.rootMessageId === unit.rootMessageId || entry.rootMessageId === unit.rootItemId)
  ) {
    return true;
  }
  if (entry.topicKey.startsWith("msg:")) {
    const rawMsg = entry.topicKey.slice(4);
    if (rawMsg === unit.rootMessageId || rawMsg === unit.rootItemId) return true;
  }
  return false;
}

function bindTaskToTopic(state: TopicBuilderState, target: MutableTopicUnit, taskId: string): void {
  if (target.taskId) return;
  target.taskId = taskId;
  state.byTaskId.set(taskId, target);
  const linkedTask = state.taskById.get(taskId);
  if (!linkedTask) return;
  target.task = linkedTask;
  if (!target.leadAgentId) {
    target.leadAgentId = linkedTask.leadAgentId ?? linkedTask.participants[0]?.agentId;
  }
}

function findTaskForHumanPrompt(
  state: TopicBuilderState,
  item: UserMessageItem,
): WorkspaceTaskSummary | null {
  if (item.messageId) {
    const byMsg = state.taskByRootMessageId.get(item.messageId);
    if (byMsg) return byMsg;
  }
  if (item.clientMessageId) {
    const byClient = state.taskByRootMessageId.get(item.clientMessageId);
    if (byClient) return byClient;
  }
  return state.taskByRootMessageId.get(item.id) ?? null;
}

function findMirroredUserFollowup(
  state: TopicBuilderState,
  item: UserMessageItem,
): TopicThreadEntry | undefined {
  if (item.messageId) {
    const byMsg = state.userFollowupBySourceMessageId.get(item.messageId);
    if (byMsg) {
      state.consumedFollowupEntryIds.add(byMsg.entryId);
      return byMsg;
    }
  }
  if (item.clientMessageId) {
    const byClient = state.userFollowupBySourceMessageId.get(item.clientMessageId);
    if (byClient) {
      state.consumedFollowupEntryIds.add(byClient.entryId);
      return byClient;
    }
  }
  const byId = state.userFollowupBySourceMessageId.get(item.id);
  if (byId) {
    state.consumedFollowupEntryIds.add(byId.entryId);
    return byId;
  }

  // Deterministic fallback when provider omits messageId or entry lacks sourceMessageId:
  // match 1-to-1 against an unconsumed user_followup routed to main with identical normalized text
  // within a bounded time window around the entry timestamp.
  const normalizedPrompt = normalizeDedupeText(item.text);
  if (!normalizedPrompt) return undefined;
  const itemTs = item.timestamp.getTime();
  for (const candidate of state.unmatchedUserFollowups) {
    if (state.consumedFollowupEntryIds.has(candidate.entryId)) continue;
    if (candidate.routedAgentId !== candidate.mainAgentId) continue;
    if (normalizeDedupeText(candidate.text) !== normalizedPrompt) continue;
    const entryTs = parseIsoMs(candidate.createdAt, itemTs);
    if (Math.abs(itemTs - entryTs) > FALLBACK_MIRROR_WINDOW_MS) continue;
    const originating = findMatchingTopic(state, {
      topicKey: candidate.topicKey,
      taskId: candidate.taskId,
      rootMessageId: candidate.rootMessageId,
    });
    if (!originating) continue;
    state.consumedFollowupEntryIds.add(candidate.entryId);
    return candidate;
  }
  return undefined;
}

function isMirroredReplyMessage(
  state: TopicBuilderState,
  item: StreamItem,
  target?: MutableTopicUnit,
): boolean {
  if (state.mirroredReplySourceMessageIds.has(item.id)) return true;
  if ("messageId" in item && item.messageId) {
    if (state.mirroredReplySourceMessageIds.has(item.messageId)) return true;
  }
  const followup = state.activeMainFollowup;
  if (!target || !followup || item.kind !== "assistant_message") return false;

  // Deterministic 1-to-1 fallback deduplication when provider lacks optional messageId
  // or mirrored main reply lacks sourceMessageId.
  const normalizedReply = normalizeDedupeText(item.text);
  if (!normalizedReply) return false;
  const itemTs = item.timestamp.getTime();
  for (const candidate of state.unmatchedAgentReplies) {
    if (state.consumedReplyEntryIds.has(candidate.entryId)) continue;
    if (candidate.routedAgentId !== candidate.mainAgentId) continue;
    if (!entryBelongsToUnit(candidate, target)) continue;
    if (candidate.seq <= followup.seq) continue;
    if (
      candidate.sourceMessageId?.startsWith("topic-reply:") &&
      candidate.sourceMessageId !== `topic-reply:${followup.entryId}`
    )
      continue;
    if (normalizeDedupeText(candidate.text) !== normalizedReply) continue;
    const entryTs = parseIsoMs(candidate.updatedAt || candidate.createdAt, itemTs);
    if (Math.abs(itemTs - entryTs) > FALLBACK_MIRROR_WINDOW_MS) continue;
    state.consumedReplyEntryIds.add(candidate.entryId);
    return true;
  }
  return false;
}

function ingestMirroredPrompt(state: TopicBuilderState, item: UserMessageItem): boolean {
  // Keep the provider's turn on the original card instead of creating a second topic.
  const followup = findMirroredUserFollowup(state, item);
  state.activeMainFollowup = undefined;
  if (!followup) return false;
  if (followup.routedAgentId === followup.mainAgentId) state.activeMainFollowup = followup;
  const topic = findMatchingTopic(state, followup);
  if (topic) markTopicCanceledIfStamped(topic, item);
  else recordUnmatchedRef(state, followup);
  state.activeTopic = topic;
  return true;
}

function ingestHumanPrompt(state: TopicBuilderState, item: UserMessageItem): void {
  if (ingestMirroredPrompt(state, item)) return;

  const messageId = item.messageId ?? item.clientMessageId ?? item.id;
  const matchedTask = findTaskForHumanPrompt(state, item);
  const topicKey = matchedTask ? `task:${matchedTask.taskId}` : `msg:${messageId}`;
  const leadAgentId = matchedTask?.leadAgentId ?? matchedTask?.participants[0]?.agentId;
  const leadTitle = leadAgentId ? state.agentTitleById?.get(leadAgentId) : undefined;
  const cursor = item.timelineCursor;
  const unit: MutableTopicUnit = {
    topicKey,
    taskId: matchedTask?.taskId,
    rootItemId: item.id,
    rootMessageId: item.messageId ?? item.id,
    rootPrompt: {
      id: item.id,
      messageId: item.messageId,
      text: item.text,
      timestampMs: item.timestamp.getTime(),
      seq: cursor?.seq ?? null,
      epoch: cursor?.epoch ?? null,
      item,
    },
    task: matchedTask,
    leadAgentId,
    leadServerId: matchedTask?.leadServerId,
    leadTitle,
    processSteps: [],
    replies: [],
    pendingInboxItems: [],
    linkedTodos: [],
    linkedDurableItems: [],
    linkedPermissions: [],
    latestCanceledTurnTimestampMs: null,
  };
  markTopicCanceledIfStamped(unit, item);
  registerTopic(state, unit);
  state.activeTopic = unit;
}

function updateTopicReportSender(
  state: TopicBuilderState,
  target: MutableTopicUnit,
  agentMessage: NonNullable<ReturnType<typeof getAgentMessage>>,
): string {
  if (agentMessage.taskId) {
    bindTaskToTopic(state, target, agentMessage.taskId);
  }
  if (!target.leadAgentId && agentMessage.sender.id) {
    target.leadAgentId = agentMessage.sender.id;
    target.leadServerId = agentMessage.sender.serverId;
  }

  const senderTitle =
    state.agentTitleById?.get(agentMessage.sender.id) ??
    agentMessage.sender.title?.trim() ??
    state.fallbackSenderTitle;
  if (!target.leadTitle && target.leadAgentId === agentMessage.sender.id) {
    target.leadTitle = senderTitle;
  }

  return senderTitle;
}

function ingestAgentMessageItem(state: TopicBuilderState, item: StreamItem): boolean {
  const agentMessage = getAgentMessage(item);
  if (!agentMessage) return false;
  if (isMirroredReplyMessage(state, item)) {
    return true;
  }

  const hasExplicitRef = Boolean(agentMessage.taskId || agentMessage.rootMessageId);
  const matched = findMatchingTopic(state, {
    taskId: agentMessage.taskId,
    rootMessageId: agentMessage.rootMessageId,
  });

  if (!matched && hasExplicitRef) {
    recordUnmatchedRef(state, {
      taskId: agentMessage.taskId,
      rootMessageId: agentMessage.rootMessageId,
    });
    return true;
  }

  const target = matched ?? ensureFallbackTopic(state, item);

  const senderTitle = updateTopicReportSender(state, target, agentMessage);

  if (state.activeTopic === target || !hasExplicitRef) markTopicCanceledIfStamped(target, item);
  target.replies.push({
    kind: "subagent_report",
    id: item.id,
    senderId: agentMessage.sender.id,
    senderServerId: agentMessage.sender.serverId,
    senderTitle,
    status: resolveAgentSourceStatus(agentMessage),
    text: agentMessage.text,
    taskId: agentMessage.taskId,
    rootMessageId: agentMessage.rootMessageId,
    epoch: item.timelineCursor?.epoch ?? null,
    seq: item.timelineCursor?.seq ?? null,
    timestampMs: item.timestamp.getTime(),
    isUnread: false,
  });
  // A report belongs to its own card even when it arrives inside another prompt's turn.
  if (!hasExplicitRef) state.activeTopic = target;
  return true;
}

function resolveSenderTitle(
  state: TopicBuilderState,
  senderId: string,
  senderTitle?: string,
): string {
  return state.agentTitleById?.get(senderId) ?? senderTitle?.trim() ?? state.fallbackSenderTitle;
}

function ingestLegacySubagentUserMessage(state: TopicBuilderState, item: UserMessageItem): void {
  const firstSource = getAgentSourcePresentation(item)?.group.sources[0];
  const sender = item.sender ?? firstSource?.sender;
  const target = state.activeTopic ?? ensureFallbackTopic(state, item);
  const senderId = sender?.id ?? "subagent";
  const senderTitle = resolveSenderTitle(state, senderId, sender?.title);
  if (!target.leadAgentId && sender?.id) {
    target.leadAgentId = sender.id;
    target.leadServerId = sender.serverId;
    target.leadTitle = senderTitle;
  }
  const cursor = item.timelineCursor;
  target.replies.push({
    kind: "subagent_report",
    id: item.id,
    senderId,
    senderServerId: sender?.serverId,
    senderTitle,
    status: firstSource?.status ?? "completed",
    text: item.text,
    epoch: cursor?.epoch ?? null,
    seq: cursor?.seq ?? null,
    timestampMs: item.timestamp.getTime(),
    isUnread: false,
  });
}

function ingestStreamItem(state: TopicBuilderState, item: StreamItem): void {
  if (item.kind === "user_message") {
    if (isRealHumanPrompt(item)) {
      ingestHumanPrompt(state, item);
    } else {
      ingestLegacySubagentUserMessage(state, item);
    }
    return;
  }
  if (ingestAgentMessageItem(state, item)) return;

  const target =
    state.activeTopic ?? (state.topics.length > 0 ? undefined : ensureFallbackTopic(state, item));
  if (!target) return;

  markTopicCanceledIfStamped(target, item);

  // Skip assistant replies already mirrored into TopicThreadEntry for fallback-to-main turns
  // so the topic card does not render duplicate conclusions (full timeline still preserves them).
  if (item.kind === "assistant_message" && isMirroredReplyMessage(state, item, target)) {
    return;
  }

  if (item.kind === "tool_call") {
    target.processSteps.push({
      kind: "tool_call",
      id: item.id,
      toolName: resolveToolCallName(item),
      status: resolveToolCallStatus(item),
      timestampMs: item.timestamp.getTime(),
      item,
    });
  } else if (item.kind === "thought") {
    target.processSteps.push({
      kind: "thought",
      id: item.id,
      text: item.text,
      status: item.status,
      timestampMs: item.timestamp.getTime(),
      item,
    });
  } else if (item.kind === "assistant_message" && item.text.trim().length > 0) {
    target.replies.push({
      kind: "main_conclusion",
      id: item.id,
      messageId: item.messageId,
      text: item.text,
      epoch: item.timelineCursor?.epoch ?? null,
      seq: item.timelineCursor?.seq ?? null,
      timestampMs: item.timestamp.getTime(),
      isUnread: false,
      item,
    });
  }
}

function matchesTodoTarget(todo: WorkspaceTodoItem, target: MutableTopicUnit): boolean {
  if (!todo.source) return false;
  if (todo.source.topicKey === target.topicKey) return true;
  if (todo.source.taskId && todo.source.taskId === target.taskId) return true;
  if (todo.source.rootMessageId && todo.source.rootMessageId === target.rootMessageId) return true;
  if (todo.source.topicKey.startsWith("msg:")) {
    const rawMsg = todo.source.topicKey.slice(4);
    if (rawMsg === target.rootMessageId || rawMsg === target.rootItemId) return true;
  }
  return false;
}

function unitHasParticipant(unit: MutableTopicUnit, agentId: string): boolean {
  if (unit.leadAgentId === agentId) return true;
  return Boolean(unit.task?.participants.some((participant) => participant.agentId === agentId));
}

function attachThreadEntries(state: TopicBuilderState, entries: readonly TopicThreadEntry[]): void {
  for (const entry of entries) {
    const target = findMatchingTopic(state, {
      topicKey: entry.topicKey,
      taskId: entry.taskId,
      rootMessageId: entry.rootMessageId,
    });
    if (!target) {
      recordUnmatchedRef(state, {
        topicKey: entry.topicKey,
        taskId: entry.taskId,
        rootMessageId: entry.rootMessageId,
      });
      continue;
    }
    target.replies.push({
      kind: "thread_entry",
      id: `thread:${entry.entryId}`,
      entry,
      threadSeq: entry.seq,
      seq: null,
      timestampMs: parseIsoMs(entry.updatedAt || entry.createdAt),
      isUnread: false,
    });
  }
}

function attachPendingInboxItems(
  state: TopicBuilderState,
  inboxItems: readonly PendingSubagentInboxItem[],
): void {
  for (const inboxItem of inboxItems) {
    const hasExplicitRef = Boolean(inboxItem.taskId || inboxItem.rootMessageId);
    const target = findMatchingTopic(state, {
      taskId: inboxItem.taskId,
      rootMessageId: inboxItem.rootMessageId,
    });
    if (target) {
      target.pendingInboxItems.push(inboxItem);
    } else if (hasExplicitRef) {
      recordUnmatchedRef(state, {
        taskId: inboxItem.taskId,
        rootMessageId: inboxItem.rootMessageId,
      });
    }
  }
}

function attachExternalCollections(state: TopicBuilderState, input: ProjectTopicUnitsInput): void {
  attachThreadEntries(state, input.threadEntries ?? []);
  attachPendingInboxItems(state, input.pendingInboxItems ?? []);

  for (const todo of input.todos ?? []) {
    if (!todo.source) continue;
    const target = findMatchingTopic(state, {
      topicKey: todo.source.topicKey,
      taskId: todo.source.taskId,
      rootMessageId: todo.source.rootMessageId,
    });
    if (target && matchesTodoTarget(todo, target)) {
      target.linkedTodos.push(todo);
    }
  }

  for (const durable of input.durableItems ?? []) {
    const target = state.topics.find((unit) => unitHasParticipant(unit, durable.sourceAgentId));
    if (target) target.linkedDurableItems.push(durable);
  }

  for (const perm of input.pendingPermissions ?? []) {
    const target =
      state.topics.find((unit) => unitHasParticipant(unit, perm.agentId)) ?? state.topics.at(-1);
    if (target) target.linkedPermissions.push(perm);
  }
}

/**
 * Evaluates unread status for a single reply while keeping the main-timeline `seq` domain strictly
 * isolated from mirrored `thread_entry` items (which always carry `seq: null` and compare by
 * `timestampMs` against `watermarkTimestampMs` / `topicRead.readUpToTimestampMs`).
 */
function computeReplyUnread(input: {
  id: string;
  epoch: string | null;
  seq: number | null;
  timestampMs: number;
  topicKey: string;
  readSnapshot: WorkspaceTopicReadSnapshot | null | undefined;
  legacyReadScope: TopicInboxReadScope | undefined;
  agentRequiresAttention: boolean;
  isLatestTopic: boolean;
}): boolean {
  const { readSnapshot, legacyReadScope, topicKey, seq, timestampMs, epoch, id } = input;
  if (readSnapshot) {
    const topicRead = readSnapshot.topics.find((entry) => entry.topicKey === topicKey);
    if (topicRead && topicRead.markedUnreadAtMs !== null) {
      if (seq !== null) {
        return seq > topicRead.readUpToSeq;
      }
      return (
        timestampMs > topicRead.readUpToTimestampMs || timestampMs >= topicRead.markedUnreadAtMs
      );
    }
    const effectiveReadSeq = Math.max(readSnapshot.watermarkSeq, topicRead?.readUpToSeq ?? -1);
    const effectiveReadTs = Math.max(
      readSnapshot.watermarkTimestampMs,
      topicRead?.readUpToTimestampMs ?? 0,
    );
    if (seq !== null) {
      if (readSnapshot.watermarkEpoch && epoch && readSnapshot.watermarkEpoch !== epoch) {
        return topicRead ? seq > topicRead.readUpToSeq : true;
      }
      return seq > effectiveReadSeq;
    }
    return effectiveReadTs > 0 ? timestampMs > effectiveReadTs : true;
  }

  if (legacyReadScope) {
    return !isTopicInboxItemRead(legacyReadScope, { id, epoch, seq, timestampMs });
  }

  return input.agentRequiresAttention && input.isLatestTopic;
}

function isTopicBlocked(
  unit: MutableTopicUnit,
  latestReport: Extract<TopicReplyItem, { kind: "subagent_report" }> | undefined,
): boolean {
  if (unit.linkedPermissions.length > 0) return true;
  if (unit.linkedDurableItems.some((item) => item.status === "pending")) return true;
  if (latestReport?.status === "blocked" || latestReport?.status === "permission-required") {
    return true;
  }
  return unit.task?.status === "awaiting_decision";
}

function isOutcomeReply(reply: TopicReplyItem): boolean {
  if (reply.kind === "main_conclusion" || reply.kind === "subagent_report") return true;
  if (reply.entry.role === "agent_reply") return true;
  return (
    reply.entry.status === "error" ||
    reply.entry.status === "running" ||
    reply.entry.status === "queued"
  );
}

function isCompletedOutcome(reply: TopicReplyItem | undefined): boolean {
  if (!reply) return false;
  if (reply.kind === "main_conclusion") return true;
  if (reply.kind === "subagent_report") {
    return reply.status === "completed" || reply.status === "finished";
  }
  return reply.entry.role === "agent_reply" && reply.entry.status === "completed";
}

function isActiveDispatchOutcome(reply: TopicReplyItem | undefined): boolean {
  return Boolean(
    reply &&
    reply.kind === "thread_entry" &&
    (reply.entry.status === "running" || reply.entry.status === "queued"),
  );
}

function isTopicDispatching(input: {
  unit: MutableTopicUnit;
  latestOutcome: TopicReplyItem | undefined;
  isLatestTopic: boolean;
  isTurnActive: boolean;
}): boolean {
  if (input.isLatestTopic && input.isTurnActive) return true;
  const taskStatus = input.unit.task?.status;
  if (taskStatus === "in_progress" || taskStatus === "analyzing" || taskStatus === "verifying") {
    return true;
  }
  return isActiveDispatchOutcome(input.latestOutcome);
}

function hasUnrecoveredError(
  unit: MutableTopicUnit,
  latestOutcome: TopicReplyItem | undefined,
): boolean {
  if (latestOutcome) {
    if (latestOutcome.kind === "thread_entry") {
      return latestOutcome.entry.status === "error";
    }
    if (latestOutcome.kind === "subagent_report") {
      return latestOutcome.status === "error";
    }
    // A newer main_conclusion supersedes earlier failed attempts.
    return false;
  }
  return unit.task?.verificationState === "failed";
}

function isTopicInterrupted(
  unit: MutableTopicUnit,
  latestOutcome: TopicReplyItem | undefined,
): boolean {
  // Any active retry or subsequent completed reply clears a historical interruption.
  if (isActiveDispatchOutcome(latestOutcome)) return false;

  if (unit.latestCanceledTurnTimestampMs !== null) {
    const canceledTs = unit.latestCanceledTurnTimestampMs;
    const supersededByLaterCompletion =
      isCompletedOutcome(latestOutcome) &&
      latestOutcome !== undefined &&
      latestOutcome.timestampMs > canceledTs;
    if (!supersededByLaterCompletion) return true;
  }

  if (latestOutcome) {
    if (latestOutcome.kind === "subagent_report" && latestOutcome.status === "closed") {
      return true;
    }
    if (isCompletedOutcome(latestOutcome)) {
      const taskCanceledAtMs = unit.task ? parseIsoMs(unit.task.updatedAt, 0) : 0;
      if (unit.task?.status === "canceled" && taskCanceledAtMs > latestOutcome.timestampMs) {
        return true;
      }
      return false;
    }
  }

  if (unit.task?.status === "canceled") return true;
  if (unit.task?.latestProgress?.kind === "turn_canceled") return true;
  return false;
}

function resolveTopicLifecycleStatus(input: {
  unit: MutableTopicUnit;
  replies: readonly TopicReplyItem[];
  hasUnread: boolean;
  isLatestTopic: boolean;
  isTurnActive: boolean;
}): TopicLifecycleStatus {
  const { unit, replies, hasUnread } = input;
  const latestReport = replies
    .toReversed()
    .find(
      (reply): reply is Extract<TopicReplyItem, { kind: "subagent_report" }> =>
        reply.kind === "subagent_report",
    );
  const latestOutcome = replies.toReversed().find(isOutcomeReply);

  if (isTopicBlocked(unit, latestReport)) return "blocked";
  if (
    isTopicDispatching({
      unit,
      latestOutcome,
      isLatestTopic: input.isLatestTopic,
      isTurnActive: input.isTurnActive,
    })
  ) {
    return "dispatching";
  }
  if (hasUnrecoveredError(unit, latestOutcome)) return "error";
  if (isTopicInterrupted(unit, latestOutcome)) return "interrupted";
  if (unit.pendingInboxItems.length > 0) return "aggregating";
  return hasUnread ? "unread" : "settled";
}

function resolveRetryCandidate(
  unit: MutableTopicUnit,
  replies: readonly TopicReplyItem[],
  lifecycleStatus: TopicLifecycleStatus,
): TopicRetryCandidate | null {
  if (lifecycleStatus !== "error" && lifecycleStatus !== "interrupted") {
    return null;
  }
  // Prefer the latest user_followup inside the topic thread if one exists; otherwise retry root prompt.
  const latestFollowup = replies
    .toReversed()
    .find(
      (reply): reply is Extract<TopicReplyItem, { kind: "thread_entry" }> =>
        reply.kind === "thread_entry" &&
        reply.entry.role === "user_followup" &&
        reply.entry.text.trim().length > 0,
    );
  if (latestFollowup) {
    return {
      text: latestFollowup.entry.text,
      routeMode: latestFollowup.entry.routedAgentId === unit.leadAgentId ? "auto" : "main",
      clientMessageId: `retry:${latestFollowup.entry.entryId}`,
    };
  }
  const rootText = unit.rootPrompt.text.trim();
  if (!rootText) return null;
  return {
    text: rootText,
    routeMode: unit.leadAgentId ? "auto" : "main",
    clientMessageId: `retry:${unit.topicKey}:${unit.rootItemId}`,
  };
}

function maxSeqValue(current: number | null, candidate: number | null): number | null {
  if (typeof candidate !== "number") return current;
  return current === null ? candidate : Math.max(current, candidate);
}

function sortRepliesChronologically(replies: readonly TopicReplyItem[]): TopicReplyItem[] {
  return replies
    .map((reply, index) => ({ reply, index }))
    .sort((left, right) => {
      if (left.reply.timestampMs !== right.reply.timestampMs) {
        return left.reply.timestampMs - right.reply.timestampMs;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.reply);
}

function finalizeTopicUnit(input: {
  unit: MutableTopicUnit;
  isLatestTopic: boolean;
  projectionInput: ProjectTopicUnitsInput;
  watermark: TopicWatermarkSnapshot;
}): TopicUnit {
  const { unit, isLatestTopic, projectionInput, watermark } = input;
  const topicReadEntry = projectionInput.readSnapshot?.topics.find(
    (entry) => entry.topicKey === unit.topicKey,
  );
  const isMarkedUnread = Boolean(topicReadEntry && topicReadEntry.markedUnreadAtMs !== null);

  let unreadReplyCount = 0;
  let firstUnreadReplyIndex: number | null = null;
  let latestSeq: number | null = unit.rootPrompt.seq;
  let latestTimestampMs = unit.rootPrompt.timestampMs;
  let latestEpoch: string | null = unit.rootPrompt.epoch;

  watermark.maxSeq = maxSeqValue(watermark.maxSeq, unit.rootPrompt.seq);
  watermark.maxTimestampMs = Math.max(watermark.maxTimestampMs, unit.rootPrompt.timestampMs);
  if (unit.rootPrompt.epoch) {
    watermark.epoch = unit.rootPrompt.epoch;
  }

  const orderedReplies = sortRepliesChronologically(unit.replies);

  const replies: TopicReplyItem[] = [];
  for (let replyIndex = 0; replyIndex < orderedReplies.length; replyIndex += 1) {
    const reply = orderedReplies[replyIndex]!;
    const replyEpoch = reply.kind === "thread_entry" ? null : reply.epoch;
    if (replyEpoch) {
      latestEpoch = replyEpoch;
      watermark.epoch = replyEpoch;
    }
    if (reply.kind !== "thread_entry") {
      latestSeq = maxSeqValue(latestSeq, reply.seq);
      watermark.maxSeq = maxSeqValue(watermark.maxSeq, reply.seq);
    }
    latestTimestampMs = Math.max(latestTimestampMs, reply.timestampMs);
    watermark.maxTimestampMs = Math.max(watermark.maxTimestampMs, reply.timestampMs);

    const isUserFollowup = reply.kind === "thread_entry" && reply.entry.role === "user_followup";
    const isUnread = isUserFollowup
      ? false
      : computeReplyUnread({
          id: reply.id,
          epoch: replyEpoch,
          seq: reply.seq,
          timestampMs: reply.timestampMs,
          topicKey: unit.topicKey,
          readSnapshot: projectionInput.readSnapshot,
          legacyReadScope: projectionInput.legacyReadScope,
          agentRequiresAttention: Boolean(projectionInput.agentRequiresAttention),
          isLatestTopic,
        });

    if (isUnread) {
      unreadReplyCount += 1;
      if (firstUnreadReplyIndex === null) firstUnreadReplyIndex = replyIndex;
      watermark.fallbackItemIds.push(reply.id);
    }
    replies.push(Object.assign({}, reply, { isUnread }));
  }

  const hasUnread = unreadReplyCount > 0 || isMarkedUnread;
  const lifecycleStatus = resolveTopicLifecycleStatus({
    unit,
    replies,
    hasUnread,
    isLatestTopic,
    isTurnActive: Boolean(projectionInput.isTurnActive),
  });
  const retryCandidate = resolveRetryCandidate(unit, replies, lifecycleStatus);

  return {
    ...unit,
    replies,
    unreadReplyCount,
    firstUnreadReplyIndex,
    isMarkedUnread,
    hasUnread,
    latestSeq,
    latestTimestampMs,
    latestEpoch,
    lifecycleStatus,
    retryCandidate,
  };
}

function loadedAssistantSourceIds(items: readonly StreamItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind !== "assistant_message") continue;
    ids.add(item.id);
    if (item.messageId) ids.add(item.messageId);
  }
  return ids;
}

export function projectTopicUnits(input: ProjectTopicUnitsInput): TopicProjectionResult {
  const taskById = new Map<string, WorkspaceTaskSummary>();
  const taskByRootMessageId = new Map<string, WorkspaceTaskSummary>();
  for (const task of input.tasks ?? []) {
    taskById.set(task.taskId, task);
    if (task.rootMessageId) taskByRootMessageId.set(task.rootMessageId, task);
  }

  const userFollowupBySourceMessageId = new Map<string, TopicThreadEntry>();
  const mirroredReplySourceMessageIds = new Set<string>();
  const assistantIds = input.threadEntries?.length ? loadedAssistantSourceIds(input.items) : null;
  const unmatchedUserFollowups: TopicThreadEntry[] = [];
  const unmatchedAgentReplies: TopicThreadEntry[] = [];
  for (const entry of input.threadEntries ?? []) {
    if (entry.role === "user_followup") {
      if (entry.sourceMessageId) {
        userFollowupBySourceMessageId.set(entry.sourceMessageId, entry);
      }
      unmatchedUserFollowups.push(entry);
    } else if (entry.role === "agent_reply" && entry.routedAgentId === entry.mainAgentId) {
      if (entry.sourceMessageId) {
        mirroredReplySourceMessageIds.add(entry.sourceMessageId);
        if (assistantIds?.has(entry.sourceMessageId)) continue;
      }
      unmatchedAgentReplies.push(entry);
    }
  }

  const state: TopicBuilderState = {
    topics: [],
    byTaskId: new Map(),
    byRootMessageId: new Map(),
    byTopicKey: new Map(),
    taskById,
    taskByRootMessageId,
    userFollowupBySourceMessageId,
    mirroredReplySourceMessageIds,
    unmatchedUserFollowups,
    unmatchedAgentReplies,
    consumedFollowupEntryIds: new Set(),
    consumedReplyEntryIds: new Set(),
    unmatchedExplicitRefs: [],
    activeTopic: undefined,
    activeMainFollowup: undefined,
    fallbackSenderTitle: input.fallbackSenderTitle ?? "Subagent",
    agentTitleById: input.agentTitleById,
  };

  for (const item of input.items) {
    ingestStreamItem(state, item);
  }
  attachExternalCollections(state, input);

  const watermark: TopicWatermarkSnapshot = {
    epoch: input.readSnapshot?.watermarkEpoch ?? null,
    maxSeq: null,
    maxTimestampMs: 0,
    fallbackItemIds: [],
  };

  let totalUnreadTopics = 0;
  let totalUnreadReplies = 0;
  const topics = state.topics.map((unit, index) => {
    const finalized = finalizeTopicUnit({
      unit,
      isLatestTopic: index === state.topics.length - 1,
      projectionInput: input,
      watermark,
    });
    if (finalized.hasUnread) {
      totalUnreadTopics += 1;
      totalUnreadReplies += finalized.unreadReplyCount > 0 ? finalized.unreadReplyCount : 1;
    }
    return finalized;
  });

  return {
    topics,
    totalUnreadTopics,
    totalUnreadReplies,
    watermark,
    unmatchedExplicitRefs: state.unmatchedExplicitRefs,
  };
}
