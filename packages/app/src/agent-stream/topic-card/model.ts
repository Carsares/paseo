import type {
  PendingSubagentInboxItem,
  TopicAnchorSummary,
  TopicThreadEntry,
  WorkspaceDurableItem,
  WorkspaceTaskFileConflict,
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
  entryId: string;
}

export interface TopicUnmatchedRef {
  topicKey?: string;
  taskId?: string;
  rootMessageId?: string;
}

export type TopicBlockingPrompt =
  | {
      kind: "durable_item";
      item: WorkspaceDurableItem;
      /**
       * True only when the item is a non-authorization item with an exact task binding for this
       * topic card so `workspace.topic.decide.*` will accept it. Legacy items without exact task
       * binding route to the dedicated standalone approval view instead.
       */
      canDecideInTopic: boolean;
    }
  | {
      kind: "task_blocking_question";
      taskId: string;
      question: string;
      blockingQuestionGeneration?: string;
      options: string[];
    };

export function hasExactDurableItemTaskBinding(
  item: WorkspaceDurableItem,
  topicTaskId: string | undefined,
): boolean {
  if (!topicTaskId) return false;
  return item.taskId === topicTaskId || item.topicKey === `task:${topicTaskId}`;
}

export function canDecideDurableItemInTopic(
  item: WorkspaceDurableItem,
  topicTaskId: string | undefined,
): boolean {
  if (item.kind === "authorization") return false;
  return hasExactDurableItemTaskBinding(item, topicTaskId);
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
  fileConflicts: WorkspaceTaskFileConflict[];
  activeBlockingPrompt: TopicBlockingPrompt | null;
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
  topicAnchors?: readonly TopicAnchorSummary[];
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
  unitsByRootMessageId: Map<string, MutableTopicUnit[]>;
  byTopicKey: Map<string, MutableTopicUnit>;
  taskById: Map<string, WorkspaceTaskSummary>;
  tasksByRootMessageId: Map<string, WorkspaceTaskSummary[]>;
  userFollowupBySourceMessageId: Map<string, TopicThreadEntry>;
  mirroredReplySourceMessageIds: Set<string>;
  loadedAgentMessageIds: Set<string>;
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
const TERMINAL_TASK_STATUSES = new Set(["completed", "canceled", "deferred"]);
const MAX_QUICK_REPLY_OPTIONS = 4;
const OPTION_LINE_PATTERN =
  /^(?:(?:[1-9][0-9]?|[A-Da-d])[.)、:：]|[①②③④]|[-*•]|(?:方案|选项|Option)\s*[A-D1-4][.)、:：]?)\s*(.+)$/;

/**
 * Extracts up to 4 concise quick-reply options from numbered, lettered, or bulleted lines inside a
 * task blocking question. Requires at least 2 candidates so ordinary notes are not misread as choices.
 */
export function extractQuickReplyOptions(question: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of question.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const match = OPTION_LINE_PATTERN.exec(trimmed);
    if (!match) continue;
    const label = (match[1] ?? "").trim();
    if (label.length < 2 || label.length > 72) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(label);
    if (candidates.length >= MAX_QUICK_REPLY_OPTIONS) break;
  }
  return candidates.length >= 2 ? candidates : [];
}

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

function addUnitToRootIndex(
  state: TopicBuilderState,
  key: string | undefined,
  unit: MutableTopicUnit,
): void {
  if (!key) return;
  const list = state.unitsByRootMessageId.get(key);
  if (!list) {
    state.unitsByRootMessageId.set(key, [unit]);
    return;
  }
  if (!list.includes(unit)) {
    list.push(unit);
  }
}

function findUnboundUnitByRoot(
  state: TopicBuilderState,
  rootId: string | undefined,
): MutableTopicUnit | undefined {
  if (!rootId) return undefined;
  return state.unitsByRootMessageId.get(rootId)?.find((unit) => !unit.taskId);
}

function registerTopic(state: TopicBuilderState, unit: MutableTopicUnit): void {
  state.topics.push(unit);
  state.byTopicKey.set(unit.topicKey, unit);
  if (unit.taskId) state.byTaskId.set(unit.taskId, unit);
  addUnitToRootIndex(state, unit.rootMessageId, unit);
  addUnitToRootIndex(state, unit.rootItemId, unit);
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

function extractHintTaskId(hint: { taskId?: string; topicKey?: string }): string | undefined {
  if (hint.taskId) return hint.taskId;
  return hint.topicKey?.startsWith("task:") ? hint.topicKey.slice(5) : undefined;
}

function extractHintRootId(hint: {
  rootMessageId?: string;
  topicKey?: string;
}): string | undefined {
  if (hint.rootMessageId) return hint.rootMessageId;
  return hint.topicKey?.startsWith("msg:") ? hint.topicKey.slice(4) : undefined;
}

function findUnitByRootFallback(
  state: TopicBuilderState,
  rootId: string | undefined,
): MutableTopicUnit | undefined {
  if (!rootId) return undefined;
  const units = state.unitsByRootMessageId.get(rootId);
  if (!units || units.length === 0) return undefined;
  return units.find((unit) => !unit.taskId) ?? units[0];
}

/**
 * Matches a topic unit by explicit references (`topicKey`, `taskId`, `rootMessageId`).
 * When an explicit `taskId` (or `task:` topicKey) is supplied, strictly isolates sibling tasks
 * sharing the same `rootMessageId` — only matching that exact task or an unbound `msg:` placeholder.
 */
function findMatchingTopic(
  state: TopicBuilderState,
  hint: { taskId?: string; rootMessageId?: string; topicKey?: string },
): MutableTopicUnit | undefined {
  const hasExplicitRef = Boolean(hint.topicKey || hint.taskId || hint.rootMessageId);
  const explicitTaskId = extractHintTaskId(hint);
  const explicitRootId = extractHintRootId(hint);

  if (explicitTaskId) {
    return (
      state.byTaskId.get(explicitTaskId) ??
      state.byTopicKey.get(`task:${explicitTaskId}`) ??
      findUnboundUnitByRoot(state, explicitRootId)
    );
  }
  if (hint.topicKey) {
    const exact = state.byTopicKey.get(hint.topicKey);
    if (exact) return exact;
  }
  const byRoot = findUnitByRootFallback(state, explicitRootId);
  if (byRoot) return byRoot;
  if (hasExplicitRef) {
    return undefined;
  }
  return state.activeTopic ?? state.topics.at(-1);
}

function entryBelongsToUnit(entry: TopicThreadEntry, unit: MutableTopicUnit): boolean {
  const entryTaskId = extractHintTaskId(entry);
  if (entryTaskId && unit.taskId && entryTaskId !== unit.taskId) return false;
  if (entry.topicKey === unit.topicKey) return true;
  if (entryTaskId && unit.taskId && entryTaskId === unit.taskId) return true;
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
  const previousTopicKey = target.topicKey;
  target.taskId = taskId;
  target.topicKey = `task:${taskId}`;
  if (previousTopicKey.startsWith("msg:") && state.byTopicKey.get(previousTopicKey) === target) {
    state.byTopicKey.delete(previousTopicKey);
  }
  state.byTaskId.set(taskId, target);
  state.byTopicKey.set(target.topicKey, target);
  const linkedTask = state.taskById.get(taskId);
  if (!linkedTask) return;
  target.task = linkedTask;
  if (!target.leadAgentId) {
    target.leadAgentId = linkedTask.leadAgentId ?? linkedTask.participants[0]?.agentId;
  }
}

function findTasksForHumanPrompt(
  state: TopicBuilderState,
  item: UserMessageItem,
): WorkspaceTaskSummary[] {
  const found: WorkspaceTaskSummary[] = [];
  const seen = new Set<string>();
  const keys = [item.messageId, item.clientMessageId, item.id];
  for (const key of keys) {
    if (!key) continue;
    for (const task of state.tasksByRootMessageId.get(key) ?? []) {
      if (seen.has(task.taskId)) continue;
      seen.add(task.taskId);
      found.push(task);
    }
  }
  return found;
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
    if (candidate.sourceMessageId && (item.messageId || item.clientMessageId)) continue;
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

function resolveAnchorTask(
  state: TopicBuilderState,
  anchor: TopicAnchorSummary,
): WorkspaceTaskSummary | null {
  const anchorTaskId = extractHintTaskId(anchor);
  if (anchorTaskId) {
    return state.taskById.get(anchorTaskId) ?? null;
  }
  if (anchor.rootMessageId) {
    const rootTasks = state.tasksByRootMessageId.get(anchor.rootMessageId);
    return rootTasks?.length === 1 ? rootTasks[0]! : null;
  }
  return null;
}

function resolveAnchorLead(
  state: TopicBuilderState,
  anchor: TopicAnchorSummary,
  linkedTask: WorkspaceTaskSummary | null,
) {
  const leadAgentId =
    linkedTask?.leadAgentId ?? anchor.leadAgentId ?? linkedTask?.participants[0]?.agentId;
  const leadServerId = linkedTask?.leadServerId ?? anchor.leadServerId;
  const leadTitle =
    (leadAgentId ? state.agentTitleById?.get(leadAgentId) : undefined) ?? anchor.leadTitle;
  return { leadAgentId, leadServerId, leadTitle };
}

function resolveAnchorPromptText(
  anchor: TopicAnchorSummary,
  linkedTask: WorkspaceTaskSummary | null,
): string {
  if (anchor.rootPromptText.trim()) return anchor.rootPromptText.trim();
  if (anchor.title?.trim()) return anchor.title.trim();
  return linkedTask?.title?.trim() ?? "";
}

function createUnitFromAnchor(
  state: TopicBuilderState,
  anchor: TopicAnchorSummary,
): MutableTopicUnit {
  const linkedTask = resolveAnchorTask(state, anchor);
  const taskId = anchor.taskId ?? linkedTask?.taskId;
  const topicKey = taskId ? `task:${taskId}` : anchor.topicKey;
  const rootMessageId = anchor.rootMessageId ?? linkedTask?.rootMessageId;
  const rootItemId = rootMessageId ?? `anchor:${topicKey}`;
  const { leadAgentId, leadServerId, leadTitle } = resolveAnchorLead(state, anchor, linkedTask);

  return {
    topicKey,
    taskId,
    rootItemId,
    rootMessageId,
    rootPrompt: {
      id: rootItemId,
      messageId: rootMessageId,
      text: resolveAnchorPromptText(anchor, linkedTask),
      timestampMs: parseIsoMs(anchor.createdAt, parseIsoMs(linkedTask?.createdAt, 0)),
      seq: null,
      epoch: null,
      item: null,
    },
    task: linkedTask,
    leadAgentId,
    leadServerId,
    leadTitle,
    processSteps: [],
    replies: [],
    pendingInboxItems: [],
    linkedTodos: [],
    linkedDurableItems: [],
    linkedPermissions: [],
    latestCanceledTurnTimestampMs: null,
  };
}

function migrateUnboundUnitToAnchor(
  state: TopicBuilderState,
  unit: MutableTopicUnit,
  anchor: TopicAnchorSummary,
  anchorTaskId: string,
): void {
  const previousKey = unit.topicKey;
  if (previousKey.startsWith("msg:") && state.byTopicKey.get(previousKey) === unit) {
    state.byTopicKey.delete(previousKey);
  }
  const linkedTask = resolveAnchorTask(state, anchor);
  unit.taskId = anchorTaskId;
  unit.topicKey = `task:${anchorTaskId}`;
  if (linkedTask) unit.task = linkedTask;
  const lead = resolveAnchorLead(state, anchor, linkedTask);
  unit.leadAgentId = unit.leadAgentId ?? lead.leadAgentId;
  unit.leadServerId = unit.leadServerId ?? lead.leadServerId;
  unit.leadTitle = unit.leadTitle ?? lead.leadTitle;
  if (!unit.rootPrompt.text.trim()) {
    unit.rootPrompt.text = resolveAnchorPromptText(anchor, linkedTask);
  }
  state.byTaskId.set(anchorTaskId, unit);
  state.byTopicKey.set(unit.topicKey, unit);
  addUnitToRootIndex(state, anchor.rootMessageId, unit);
}

function backfillBoundUnitsPrompt(
  state: TopicBuilderState,
  rootMessageId: string,
  promptText: string,
): boolean {
  const boundUnits = (state.unitsByRootMessageId.get(rootMessageId) ?? []).filter((u) => u.taskId);
  if (boundUnits.length === 0) return false;
  const trimmed = promptText.trim();
  if (trimmed) {
    for (const unit of boundUnits) {
      if (!unit.rootPrompt.text.trim()) {
        unit.rootPrompt.text = trimmed;
      }
    }
  }
  return true;
}

function seedTopicsFromAnchors(
  state: TopicBuilderState,
  anchors: readonly TopicAnchorSummary[],
): void {
  const ordered = [...anchors].sort((left, right) => {
    const diff = parseIsoMs(left.createdAt) - parseIsoMs(right.createdAt);
    return diff !== 0 ? diff : left.topicKey.localeCompare(right.topicKey);
  });

  for (const anchor of ordered) {
    const anchorTaskId = extractHintTaskId(anchor);
    if (!anchorTaskId) {
      if (
        anchor.rootMessageId &&
        backfillBoundUnitsPrompt(state, anchor.rootMessageId, anchor.rootPromptText)
      ) {
        continue;
      }
      if (state.byTopicKey.has(anchor.topicKey)) continue;
      registerTopic(state, createUnitFromAnchor(state, anchor));
      continue;
    }

    if (state.byTaskId.has(anchorTaskId)) continue;
    const unbound = findUnboundUnitByRoot(state, anchor.rootMessageId);
    if (unbound) {
      migrateUnboundUnitToAnchor(state, unbound, anchor, anchorTaskId);
      continue;
    }
    registerTopic(state, createUnitFromAnchor(state, anchor));
  }
}

function syncHydratedUnitTask(
  state: TopicBuilderState,
  existing: MutableTopicUnit,
  matchedTask: WorkspaceTaskSummary | null,
): void {
  if (!matchedTask) return;
  if (!existing.task) existing.task = matchedTask;
  if (!existing.taskId) {
    const previousKey = existing.topicKey;
    if (previousKey.startsWith("msg:") && state.byTopicKey.get(previousKey) === existing) {
      state.byTopicKey.delete(previousKey);
    }
    existing.taskId = matchedTask.taskId;
    existing.topicKey = `task:${matchedTask.taskId}`;
    state.byTaskId.set(matchedTask.taskId, existing);
    state.byTopicKey.set(existing.topicKey, existing);
  }
  const leadAgentId =
    existing.leadAgentId ?? matchedTask.leadAgentId ?? matchedTask.participants[0]?.agentId;
  if (leadAgentId) {
    existing.leadAgentId = leadAgentId;
    existing.leadServerId = existing.leadServerId ?? matchedTask.leadServerId;
    existing.leadTitle = existing.leadTitle ?? state.agentTitleById?.get(leadAgentId);
  }
}

function hydrateAnchorUnitWithHumanPrompt(
  state: TopicBuilderState,
  existing: MutableTopicUnit,
  item: UserMessageItem,
  matchedTask: WorkspaceTaskSummary | null,
  rootItemIdOverride?: string,
): void {
  const cursor = item.timelineCursor;
  existing.rootItemId = rootItemIdOverride ?? item.id;
  existing.rootMessageId = item.messageId ?? item.id;
  existing.rootPrompt = {
    id: item.id,
    messageId: item.messageId,
    text: item.text || existing.rootPrompt.text,
    timestampMs: item.timestamp.getTime(),
    seq: cursor?.seq ?? null,
    epoch: cursor?.epoch ?? null,
    item,
  };
  syncHydratedUnitTask(state, existing, matchedTask);
  addUnitToRootIndex(state, existing.rootItemId, existing);
  addUnitToRootIndex(state, existing.rootMessageId, existing);
  addUnitToRootIndex(state, item.clientMessageId, existing);
  markTopicCanceledIfStamped(existing, item);
  state.activeTopic = existing;
}

function createUnitFromHumanPrompt(
  state: TopicBuilderState,
  item: UserMessageItem,
  matchedTask: WorkspaceTaskSummary | null,
  topicKey: string,
  rootItemIdOverride?: string,
): MutableTopicUnit {
  const leadAgentId = matchedTask?.leadAgentId ?? matchedTask?.participants[0]?.agentId;
  const cursor = item.timelineCursor;
  return {
    topicKey,
    taskId: matchedTask?.taskId,
    rootItemId: rootItemIdOverride ?? item.id,
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
    leadTitle: leadAgentId ? state.agentTitleById?.get(leadAgentId) : undefined,
    processSteps: [],
    replies: [],
    pendingInboxItems: [],
    linkedTodos: [],
    linkedDurableItems: [],
    linkedPermissions: [],
    latestCanceledTurnTimestampMs: null,
  };
}

function hydrateRemainingAnchorUnitsForRoot(
  state: TopicBuilderState,
  item: UserMessageItem,
  messageId: string,
): MutableTopicUnit | undefined {
  const existingUnits = [
    ...(state.unitsByRootMessageId.get(messageId) ?? []),
    ...(item.clientMessageId && item.clientMessageId !== messageId
      ? (state.unitsByRootMessageId.get(item.clientMessageId) ?? [])
      : []),
  ];
  const seen = new Set<MutableTopicUnit>();
  let lastUnit: MutableTopicUnit | undefined;
  for (const unit of existingUnits) {
    if (seen.has(unit)) continue;
    seen.add(unit);
    if (unit.rootPrompt.item === null) {
      const unitTask = unit.taskId ? (state.taskById.get(unit.taskId) ?? unit.task) : unit.task;
      const rootItemId = unit.taskId ? `${item.id}:${unit.taskId}` : item.id;
      hydrateAnchorUnitWithHumanPrompt(state, unit, item, unitTask, rootItemId);
    }
    lastUnit = unit;
  }
  return lastUnit;
}

function ingestHumanPrompt(state: TopicBuilderState, item: UserMessageItem): void {
  if (ingestMirroredPrompt(state, item)) return;

  const messageId = item.messageId ?? item.clientMessageId ?? item.id;
  const matchedTasks = findTasksForHumanPrompt(state, item);

  if (matchedTasks.length > 0) {
    const multiTask = matchedTasks.length > 1;
    let lastUnit: MutableTopicUnit | undefined;
    for (const task of matchedTasks) {
      const rootItemId = multiTask ? `${item.id}:${task.taskId}` : item.id;
      const existing = state.byTaskId.get(task.taskId) ?? findUnboundUnitByRoot(state, messageId);
      if (existing && existing.rootPrompt.item === null) {
        hydrateAnchorUnitWithHumanPrompt(state, existing, item, task, rootItemId);
        lastUnit = existing;
        continue;
      }
      if (existing) {
        lastUnit = existing;
        continue;
      }
      const unit = createUnitFromHumanPrompt(state, item, task, `task:${task.taskId}`, rootItemId);
      markTopicCanceledIfStamped(unit, item);
      registerTopic(state, unit);
      lastUnit = unit;
    }
    const extraHydrated = hydrateRemainingAnchorUnitsForRoot(state, item, messageId);
    state.activeTopic = extraHydrated ?? lastUnit;
    return;
  }

  const hydratedAnchor = hydrateRemainingAnchorUnitsForRoot(state, item, messageId);
  if (hydratedAnchor) {
    state.activeTopic = hydratedAnchor;
    return;
  }

  const unit = createUnitFromHumanPrompt(state, item, null, `msg:${messageId}`);
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
  const sourceTaskId = extractHintTaskId(todo.source);
  if (sourceTaskId && target.taskId && sourceTaskId !== target.taskId) return false;
  if (todo.source.topicKey === target.topicKey) return true;
  if (sourceTaskId && sourceTaskId === target.taskId) return true;
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
    // When a subagent report already exists on the main timeline with the same sourceMessageId
    // (e.g. multi-track merge path), keep the main-timeline item to avoid duplicate rendering.
    if (
      entry.origin === "subagent_report" &&
      entry.sourceMessageId &&
      state.loadedAgentMessageIds.has(entry.sourceMessageId)
    ) {
      continue;
    }

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
    if (entry.origin === "subagent_report" && entry.authorAgentId && !target.leadAgentId) {
      target.leadAgentId = entry.authorAgentId;
      target.leadTitle =
        state.agentTitleById?.get(entry.authorAgentId) ?? entry.authorTitle?.trim();
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

function attachLinkedTodos(state: TopicBuilderState, todos: readonly WorkspaceTodoItem[]): void {
  for (const todo of todos) {
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
}

function attachDurableItems(
  state: TopicBuilderState,
  durableItems: readonly WorkspaceDurableItem[],
): void {
  for (const durable of durableItems) {
    const hasExplicitRef = Boolean(durable.topicKey || durable.taskId || durable.rootMessageId);
    const target = hasExplicitRef
      ? findMatchingTopic(state, {
          topicKey: durable.topicKey,
          taskId: durable.taskId,
          rootMessageId: durable.rootMessageId,
        })
      : state.topics.findLast((unit) => unitHasParticipant(unit, durable.sourceAgentId));
    if (target) {
      target.linkedDurableItems.push(durable);
    } else if (hasExplicitRef) {
      recordUnmatchedRef(state, {
        topicKey: durable.topicKey,
        taskId: durable.taskId,
        rootMessageId: durable.rootMessageId,
      });
    }
  }
}

function attachExternalCollections(state: TopicBuilderState, input: ProjectTopicUnitsInput): void {
  attachThreadEntries(state, input.threadEntries ?? []);
  attachPendingInboxItems(state, input.pendingInboxItems ?? []);
  attachLinkedTodos(state, input.todos ?? []);
  attachDurableItems(state, input.durableItems ?? []);

  for (const perm of input.pendingPermissions ?? []) {
    const target =
      state.topics.findLast((unit) => unitHasParticipant(unit, perm.agentId)) ??
      state.topics.at(-1);
    if (target) target.linkedPermissions.push(perm);
  }
}

function isManuallyUnreadReply(
  topicRead: WorkspaceTopicReadSnapshot["topics"][number],
  markedUnreadAtMs: number,
  seq: number | null,
  sameEpoch: boolean,
  timestampMs: number,
): boolean {
  if (seq === null) {
    return timestampMs > topicRead.readUpToTimestampMs || timestampMs >= markedUnreadAtMs;
  }
  if (sameEpoch && topicRead.readUpToSeq >= 0) return seq > topicRead.readUpToSeq;
  return timestampMs >= topicRead.readUpToTimestampMs;
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
    const sameEpoch = epoch !== null && readSnapshot.watermarkEpoch === epoch;
    if (topicRead && topicRead.markedUnreadAtMs !== null) {
      return isManuallyUnreadReply(
        topicRead,
        topicRead.markedUnreadAtMs,
        seq,
        sameEpoch,
        timestampMs,
      );
    }
    if (seq !== null) {
      const effectiveReadSeq = Math.max(readSnapshot.watermarkSeq, topicRead?.readUpToSeq ?? -1);
      const timelineReadAt = Math.max(
        readSnapshot.watermarkTimelineTimestampMs ?? 0,
        topicRead?.readUpToTimelineTimestampMs ?? 0,
      );
      return (
        !(sameEpoch && seq <= effectiveReadSeq) &&
        !(timelineReadAt > 0 && timestampMs <= timelineReadAt)
      );
    }
    const effectiveReadTs = Math.max(
      readSnapshot.watermarkTimestampMs,
      topicRead?.readUpToTimestampMs ?? 0,
    );
    return effectiveReadTs > 0 ? timestampMs > effectiveReadTs : true;
  }

  if (legacyReadScope) {
    return !isTopicInboxItemRead(legacyReadScope, { id, epoch, seq, timestampMs });
  }

  return input.agentRequiresAttention && input.isLatestTopic;
}

function resolveActiveBlockingPrompt(unit: MutableTopicUnit): TopicBlockingPrompt | null {
  const pendingDurables = unit.linkedDurableItems.filter((item) => item.status === "pending");
  const preferredDurable =
    pendingDurables.find((item) => canDecideDurableItemInTopic(item, unit.taskId)) ??
    pendingDurables.find((item) => item.kind === "decision" || item.kind === "acceptance") ??
    pendingDurables[0];
  if (preferredDurable) {
    return {
      kind: "durable_item",
      item: preferredDurable,
      canDecideInTopic: canDecideDurableItemInTopic(preferredDurable, unit.taskId),
    };
  }
  const blockingQuestion = unit.task?.blockingQuestion?.trim();
  if (unit.task && blockingQuestion && !TERMINAL_TASK_STATUSES.has(unit.task.status)) {
    return {
      kind: "task_blocking_question",
      taskId: unit.task.taskId,
      question: blockingQuestion,
      blockingQuestionGeneration: unit.task.blockingQuestionGeneration,
      options: extractQuickReplyOptions(blockingQuestion),
    };
  }
  return null;
}

function resolveTopicFileConflicts(unit: MutableTopicUnit): WorkspaceTaskFileConflict[] {
  if (!unit.task || TERMINAL_TASK_STATUSES.has(unit.task.status)) return [];
  return unit.task.fileConflicts ? [...unit.task.fileConflicts] : [];
}

function isTopicBlocked(
  unit: MutableTopicUnit,
  latestReport: Extract<TopicReplyItem, { kind: "subagent_report" }> | undefined,
  latestOutcome: TopicReplyItem | undefined,
  activeBlockingPrompt: TopicBlockingPrompt | null,
): boolean {
  if (unit.linkedPermissions.length > 0) return true;
  if (activeBlockingPrompt !== null) return true;
  if (latestReport?.status === "blocked" || latestReport?.status === "permission-required") {
    return true;
  }
  if (
    latestOutcome?.kind === "thread_entry" &&
    latestOutcome.entry.origin === "subagent_report" &&
    latestOutcome.entry.reportStatus === "blocked"
  ) {
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
  activeBlockingPrompt: TopicBlockingPrompt | null;
  hasUnread: boolean;
  isLatestTopic: boolean;
  isTurnActive: boolean;
}): TopicLifecycleStatus {
  const { unit, replies, activeBlockingPrompt, hasUnread } = input;
  const latestReport = replies
    .toReversed()
    .find(
      (reply): reply is Extract<TopicReplyItem, { kind: "subagent_report" }> =>
        reply.kind === "subagent_report",
    );
  const latestOutcome = replies.toReversed().find(isOutcomeReply);

  if (isTopicBlocked(unit, latestReport, latestOutcome, activeBlockingPrompt)) return "blocked";
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
  replies: readonly TopicReplyItem[],
  lifecycleStatus: TopicLifecycleStatus,
): TopicRetryCandidate | null {
  if (lifecycleStatus !== "error" && lifecycleStatus !== "interrupted") return null;
  const latestFollowup = replies.findLast(
    (reply) => reply.kind === "thread_entry" && reply.entry.role === "user_followup",
  );
  if (latestFollowup?.kind !== "thread_entry" || latestFollowup.entry.retryable !== true) {
    return null;
  }
  return { entryId: latestFollowup.entry.entryId, text: latestFollowup.entry.text };
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
  const fileConflicts = resolveTopicFileConflicts(unit);
  const activeBlockingPrompt = resolveActiveBlockingPrompt(unit);
  const lifecycleStatus = resolveTopicLifecycleStatus({
    unit,
    replies,
    activeBlockingPrompt,
    hasUnread,
    isLatestTopic,
    isTurnActive: Boolean(projectionInput.isTurnActive),
  });
  const retryCandidate = resolveRetryCandidate(replies, lifecycleStatus);

  return {
    ...unit,
    replies,
    fileConflicts,
    activeBlockingPrompt,
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

function collectLoadedAgentMessageIds(items: readonly StreamItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (!getAgentMessage(item)) continue;
    ids.add(item.id);
    if ("messageId" in item && item.messageId) ids.add(item.messageId);
    if (item.kind === "tool_call" && item.payload.source === "agent" && item.payload.data.callId) {
      ids.add(item.payload.data.callId);
    }
  }
  return ids;
}

function indexThreadEntries(
  entries: readonly TopicThreadEntry[],
  assistantIds: ReadonlySet<string> | null,
) {
  const userFollowupBySourceMessageId = new Map<string, TopicThreadEntry>();
  const mirroredReplySourceMessageIds = new Set<string>();
  const unmatchedUserFollowups: TopicThreadEntry[] = [];
  const unmatchedAgentReplies: TopicThreadEntry[] = [];

  for (const entry of entries) {
    if (entry.role === "user_followup") {
      if (entry.sourceMessageId) userFollowupBySourceMessageId.set(entry.sourceMessageId, entry);
      unmatchedUserFollowups.push(entry);
    } else if (entry.role === "agent_reply" && entry.routedAgentId === entry.mainAgentId) {
      if (entry.sourceMessageId) {
        mirroredReplySourceMessageIds.add(entry.sourceMessageId);
        if (assistantIds?.has(entry.sourceMessageId)) continue;
      }
      unmatchedAgentReplies.push(entry);
    }
  }

  return {
    userFollowupBySourceMessageId,
    mirroredReplySourceMessageIds,
    unmatchedUserFollowups,
    unmatchedAgentReplies,
  };
}

function sortTopicsChronologically(topics: readonly MutableTopicUnit[]): MutableTopicUnit[] {
  return topics
    .map((unit, index) => ({ unit, index }))
    .sort((left, right) => {
      if (left.unit.rootPrompt.timestampMs !== right.unit.rootPrompt.timestampMs) {
        return left.unit.rootPrompt.timestampMs - right.unit.rootPrompt.timestampMs;
      }
      return left.index - right.index;
    })
    .map(({ unit }) => unit);
}

function indexTasksByRoot(tasks: readonly WorkspaceTaskSummary[]) {
  const taskById = new Map<string, WorkspaceTaskSummary>();
  const tasksByRootMessageId = new Map<string, WorkspaceTaskSummary[]>();
  for (const task of tasks) {
    taskById.set(task.taskId, task);
    if (!task.rootMessageId) continue;
    const list = tasksByRootMessageId.get(task.rootMessageId);
    if (list) list.push(task);
    else tasksByRootMessageId.set(task.rootMessageId, [task]);
  }
  return { taskById, tasksByRootMessageId };
}

export function projectTopicUnits(input: ProjectTopicUnitsInput): TopicProjectionResult {
  const { taskById, tasksByRootMessageId } = indexTasksByRoot(input.tasks ?? []);

  const threadEntries = input.threadEntries ?? [];
  const assistantIds = threadEntries.length > 0 ? loadedAssistantSourceIds(input.items) : null;
  const loadedAgentMessageIds =
    threadEntries.length > 0 ? collectLoadedAgentMessageIds(input.items) : new Set<string>();
  const indexed = indexThreadEntries(threadEntries, assistantIds);

  const state: TopicBuilderState = {
    topics: [],
    byTaskId: new Map(),
    unitsByRootMessageId: new Map(),
    byTopicKey: new Map(),
    taskById,
    tasksByRootMessageId,
    ...indexed,
    loadedAgentMessageIds,
    consumedFollowupEntryIds: new Set(),
    consumedReplyEntryIds: new Set(),
    unmatchedExplicitRefs: [],
    activeTopic: undefined,
    activeMainFollowup: undefined,
    fallbackSenderTitle: input.fallbackSenderTitle ?? "Subagent",
    agentTitleById: input.agentTitleById,
  };

  if (input.topicAnchors && input.topicAnchors.length > 0) {
    seedTopicsFromAnchors(state, input.topicAnchors);
  }
  for (const item of input.items) {
    ingestStreamItem(state, item);
  }
  attachExternalCollections(state, input);

  if (input.topicAnchors && input.topicAnchors.length > 0 && state.topics.length > 1) {
    state.topics = sortTopicsChronologically(state.topics);
  }

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
