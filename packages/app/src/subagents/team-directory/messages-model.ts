import { getResidentRoleFromLabels, isResidentAgent } from "@getpaseo/protocol/agent-labels";
import type { WorkspaceDurableItem } from "@getpaseo/protocol/messages";
import { getAgentMessage, resolveAgentSourceStatus } from "@/agent-stream/agent-interactions";
import { startsNewTurn } from "@/agent-stream/turn-membership";
import type { Agent } from "@/stores/session-store";
import {
  isTopicInboxItemRead,
  type MarkAllInboxReadSnapshot,
  type RetainedMainConclusionSnapshot,
  type TopicInboxReadCandidate,
  type TopicInboxReadScope,
} from "@/stores/topic-inbox-read-store";
import { getStreamItemMessageId, type StreamItem } from "@/types/stream";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export type TeamInboxMessageKind =
  | "permission"
  | "durable_item"
  | "pending_inbox"
  | "subagent_report"
  | "main_conclusion";

export interface TeamInboxJumpTarget {
  agentId: string;
  itemId: string | null;
  messageId: string | null;
  epoch: string | null;
  seq: number | null;
}

export interface TeamInboxMessageItem {
  id: string;
  kind: TeamInboxMessageKind;
  isRead: boolean;
  urgencyRank: number;
  timestampMs: number;
  senderTitle: string;
  tagI18nKey: string;
  tone: SidebarStateBucket;
  preview: string;
  targetAgentId: string | null;
  jumpTarget: TeamInboxJumpTarget | null;
  durableItem?: WorkspaceDurableItem;
  canFlushPendingInbox?: boolean;
  readCandidate?: TopicInboxReadCandidate;
  mainConclusionSnapshot?: RetainedMainConclusionSnapshot;
}

export interface TeamDirectoryMessagesProjection {
  unread: TeamInboxMessageItem[];
  read: TeamInboxMessageItem[];
  hasPendingInboxToFlush: boolean;
  markAllSnapshot: MarkAllInboxReadSnapshot;
}

type InboxSourceAgent = Pick<
  Agent,
  | "id"
  | "workspaceId"
  | "title"
  | "labels"
  | "status"
  | "turn"
  | "archivedAt"
  | "background"
  | "backgroundWork"
  | "pendingSubagentInbox"
  | "pendingPermissions"
  | "requiresAttention"
  | "attentionReason"
  | "attentionTimestamp"
  | "lastUserMessageAt"
  | "lastError"
  | "updatedAt"
>;

function resolveAgentDisplayName(
  agent: Pick<InboxSourceAgent, "title" | "labels"> | undefined,
  fallback: string,
): string {
  if (agent) {
    if (isResidentAgent(agent)) {
      const role = getResidentRoleFromLabels(agent.labels);
      if (role?.trim()) return role.trim();
    }
    if (agent.title?.trim()) return agent.title.trim();
  }
  return fallback;
}

export function cleanMessagePreview(raw: string | null | undefined, maxLength = 140): string {
  if (!raw) return "";
  const lines = raw
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^#+\s*/, "")
        .replace(/^[-*>]\s+/, "")
        .replace(/`/g, "")
        .trim(),
    )
    .filter((line) => line.length > 0);
  const joined = lines.slice(0, 2).join(" · ");
  if (joined.length <= maxLength) return joined;
  return `${joined.slice(0, maxLength - 1)}…`;
}

function isAgentActivelyBusy(agent: InboxSourceAgent): boolean {
  return (
    agent.turn.phase === "open" ||
    agent.status === "running" ||
    agent.status === "initializing" ||
    (agent.backgroundWork?.runningCount ?? agent.backgroundWork?.count ?? 0) > 0 ||
    (agent.pendingSubagentInbox?.items.length ?? 0) > 0
  );
}

function parseIsoTimestampMs(iso: string | null | undefined, fallback = 0): number {
  if (!iso) return fallback;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface InboxAggregationAccumulator {
  unread: TeamInboxMessageItem[];
  read: TeamInboxMessageItem[];
  targetEpoch: string | null;
  maxSeq: number | null;
  maxTimestampMs: number;
  markableUnreadIds: string[];
  unreadMainConclusion: RetainedMainConclusionSnapshot | null;
}

function collectPermissionMessages(
  acc: InboxAggregationAccumulator,
  agents: ReadonlyMap<string, InboxSourceAgent> | undefined,
  workspaceId: string,
  fallbackAgentTitle: string,
): void {
  for (const agent of agents?.values() ?? []) {
    if (agent.archivedAt || agent.background || agent.workspaceId !== workspaceId) continue;
    if ((agent.pendingPermissions?.length ?? 0) === 0) continue;
    const senderTitle = resolveAgentDisplayName(agent, fallbackAgentTitle);
    const ts = (agent.attentionTimestamp ?? agent.updatedAt).getTime();
    for (const perm of agent.pendingPermissions) {
      acc.unread.push({
        id: `perm:${agent.id}:${perm.id}`,
        kind: "permission",
        isRead: false,
        urgencyRank: 0,
        timestampMs: ts,
        senderTitle,
        tagI18nKey: "topicWorkbench.directory.permissionTag",
        tone: "needs_input",
        preview: cleanMessagePreview(perm.title || perm.description || perm.name) || perm.name,
        targetAgentId: agent.id,
        jumpTarget: {
          agentId: agent.id,
          itemId: null,
          messageId: null,
          epoch: null,
          seq: null,
        },
      });
    }
  }
}

function collectDurableItemMessages(
  acc: InboxAggregationAccumulator,
  durableItems: readonly WorkspaceDurableItem[],
  workspaceId: string,
  mainAgentId: string | null,
): void {
  for (const item of durableItems) {
    if (item.workspaceId !== workspaceId) continue;
    const isPending = item.status === "pending";
    const updatedIso = "decidedAt" in item && item.decidedAt ? item.decidedAt : item.createdAt;
    const entry: TeamInboxMessageItem = {
      id: `durable:${item.requestId}:${item.revision}`,
      kind: "durable_item",
      isRead: !isPending,
      urgencyRank: isPending ? 0 : 3,
      timestampMs: parseIsoTimestampMs(updatedIso),
      senderTitle: item.title,
      tagI18nKey: `topicWorkbench.durableItems.kind.${item.kind}`,
      tone: isPending ? "needs_input" : "done",
      preview: cleanMessagePreview(item.summary || item.title),
      targetAgentId: mainAgentId,
      jumpTarget: null,
      durableItem: item,
    };
    if (isPending) acc.unread.push(entry);
    else acc.read.push(entry);
  }
}

function collectPendingInboxMessages(
  acc: InboxAggregationAccumulator,
  pendingInboxItems: NonNullable<InboxSourceAgent["pendingSubagentInbox"]>["items"],
  agents: ReadonlyMap<string, InboxSourceAgent> | undefined,
  mainAgent: InboxSourceAgent | undefined,
  mainAgentId: string | null,
  fallbackAgentTitle: string,
): void {
  const defaultJumpTarget: TeamInboxJumpTarget | null = mainAgentId
    ? { agentId: mainAgentId, itemId: null, messageId: null, epoch: null, seq: null }
    : null;
  const fallbackTs = mainAgent?.updatedAt.getTime() ?? 0;

  for (let idx = 0; idx < pendingInboxItems.length; idx += 1) {
    const inboxItem = pendingInboxItems[idx]!;
    const senderTitle = resolveAgentDisplayName(
      agents?.get(inboxItem.agentId),
      inboxItem.title?.trim() || fallbackAgentTitle,
    );
    const previewText = inboxItem.reportStatus
      ? `${inboxItem.event} (${inboxItem.reportStatus})`
      : inboxItem.event;
    acc.unread.push({
      id: `inbox:${inboxItem.agentId}:${inboxItem.event}:${inboxItem.reportStatus ?? "none"}:${idx}`,
      kind: "pending_inbox",
      isRead: false,
      urgencyRank: 2,
      timestampMs: fallbackTs,
      senderTitle,
      tagI18nKey: "topicWorkbench.directory.pendingInboxTag",
      tone: "running",
      preview: previewText,
      targetAgentId: mainAgentId ?? inboxItem.agentId,
      jumpTarget: defaultJumpTarget,
      canFlushPendingInbox: Boolean(mainAgentId),
    });
  }
}

function resolveTimelineReportPresentation(
  status: ReturnType<typeof resolveAgentSourceStatus>,
  isRead: boolean,
): { tagI18nKey: string; tone: SidebarStateBucket; urgencyRank: number } {
  if (status === "blocked") {
    return {
      tagI18nKey: "topicWorkbench.directory.reportBlockedTag",
      tone: "needs_input",
      urgencyRank: 1,
    };
  }
  if (status === "error") {
    return {
      tagI18nKey: "topicWorkbench.directory.agentErrorTag",
      tone: "failed",
      urgencyRank: 1,
    };
  }
  if (status === "permission-required") {
    return {
      tagI18nKey: "topicWorkbench.directory.permissionTag",
      tone: "needs_input",
      urgencyRank: 1,
    };
  }
  if (status === "completed" || status === "finished") {
    return {
      tagI18nKey: "topicWorkbench.directory.reportCompletedTag",
      tone: isRead ? "done" : "attention",
      urgencyRank: 3,
    };
  }
  return {
    tagI18nKey: "topicWorkbench.directory.agentMessageTag",
    tone: isRead ? "done" : "attention",
    urgencyRank: 3,
  };
}

function resolveTargetWatermarkEpoch(
  currentMainEpoch: string | null | undefined,
  combinedStream: readonly StreamItem[],
): string | null {
  if (currentMainEpoch) return currentMainEpoch;
  for (let i = combinedStream.length - 1; i >= 0; i -= 1) {
    const epoch = combinedStream[i]?.timelineCursor?.epoch;
    if (epoch) return epoch;
  }
  return null;
}

function recordStreamWatermark(
  acc: InboxAggregationAccumulator,
  epoch: string | null,
  seq: number | null,
  timestampMs: number,
): void {
  if (epoch && typeof seq === "number" && acc.targetEpoch === epoch) {
    acc.maxSeq = acc.maxSeq === null ? seq : Math.max(acc.maxSeq, seq);
  }
  if (timestampMs > acc.maxTimestampMs) {
    acc.maxTimestampMs = timestampMs;
  }
}

function collectTimelineReportMessages(input: {
  acc: InboxAggregationAccumulator;
  mainAgentId: string | null;
  combinedStream: readonly StreamItem[];
  agents: ReadonlyMap<string, InboxSourceAgent> | undefined;
  readScope: TopicInboxReadScope | undefined;
  fallbackAgentTitle: string;
}): void {
  const { acc, mainAgentId, combinedStream, agents, readScope, fallbackAgentTitle } = input;
  if (!mainAgentId) return;

  const seenStreamIds = new Set<string>();
  for (const streamItem of combinedStream) {
    if (seenStreamIds.has(streamItem.id)) continue;
    const agentMessage = getAgentMessage(streamItem);
    if (!agentMessage) continue;
    seenStreamIds.add(streamItem.id);

    const status = resolveAgentSourceStatus(agentMessage);
    const preview = cleanMessagePreview(agentMessage.text);
    if (status === "closed" && !preview) continue;

    const epoch = streamItem.timelineCursor?.epoch ?? null;
    const seq = streamItem.timelineCursor?.seq ?? null;
    const timestampMs = streamItem.timestamp.getTime();
    recordStreamWatermark(acc, epoch, seq, timestampMs);

    const candidateId = `msg:${streamItem.id}`;
    const readCandidate: TopicInboxReadCandidate = { id: candidateId, epoch, seq, timestampMs };
    const isRead = isTopicInboxItemRead(readScope, readCandidate);
    const senderTitle = resolveAgentDisplayName(
      agents?.get(agentMessage.sender.id),
      agentMessage.sender.title?.trim() || fallbackAgentTitle,
    );
    const { tagI18nKey, tone, urgencyRank } = resolveTimelineReportPresentation(status, isRead);

    const entry: TeamInboxMessageItem = {
      id: candidateId,
      kind: "subagent_report",
      isRead,
      urgencyRank,
      timestampMs,
      senderTitle,
      tagI18nKey,
      tone,
      preview: preview || senderTitle,
      targetAgentId: mainAgentId,
      jumpTarget: {
        agentId: mainAgentId,
        itemId: streamItem.id,
        messageId: getStreamItemMessageId(streamItem),
        epoch,
        seq,
      },
      readCandidate,
    };

    if (isRead) {
      acc.read.push(entry);
    } else {
      acc.unread.push(entry);
      acc.markableUnreadIds.push(candidateId);
    }
  }
}

interface LatestTurnSlice {
  turnKey: string | null;
  turnStartedAtMs: number | null;
  lastItemAtMs: number | null;
  latestAssistant: Extract<StreamItem, { kind: "assistant_message" }> | null;
}

const EMPTY_TURN_SLICE: LatestTurnSlice = {
  turnKey: null,
  turnStartedAtMs: null,
  lastItemAtMs: null,
  latestAssistant: null,
};

function extractLatestTurnSlice(
  combinedStream: readonly StreamItem[],
  lastUserMessageAt: Date | null | undefined,
  mainTimelineHasNewer: boolean,
): LatestTurnSlice {
  if (mainTimelineHasNewer || combinedStream.length === 0) {
    return EMPTY_TURN_SLICE;
  }
  let turnStartIdx = 0;
  for (let i = 1; i < combinedStream.length; i += 1) {
    if (startsNewTurn(combinedStream[i]!, combinedStream[i - 1]!)) {
      turnStartIdx = i;
    }
  }
  const firstItem = combinedStream[turnStartIdx]!;
  const lastItem = combinedStream[combinedStream.length - 1]!;
  const turnStartedAtMs = firstItem.timestamp.getTime();
  const lastItemAtMs = lastItem.timestamp.getTime();
  if (lastUserMessageAt && lastItemAtMs < lastUserMessageAt.getTime()) {
    return EMPTY_TURN_SLICE;
  }
  let latestAssistant: Extract<StreamItem, { kind: "assistant_message" }> | null = null;
  for (let i = combinedStream.length - 1; i >= turnStartIdx; i -= 1) {
    const candidate = combinedStream[i];
    if (candidate?.kind === "assistant_message" && candidate.text.trim().length > 0) {
      latestAssistant = candidate;
      break;
    }
  }
  return {
    turnKey: firstItem.turnId ?? firstItem.id,
    turnStartedAtMs,
    lastItemAtMs,
    latestAssistant,
  };
}

function isSliceSupersededByReadMark(
  rawSlice: LatestTurnSlice,
  attentionTs: number,
  readScope: TopicInboxReadScope | undefined,
): boolean {
  if (!readScope) return false;
  const lastItemAtMs = rawSlice.lastItemAtMs ?? 0;
  if (
    typeof readScope.readMainConclusionAtMs === "number" &&
    attentionTs > readScope.readMainConclusionAtMs &&
    lastItemAtMs <= readScope.readMainConclusionAtMs
  ) {
    return true;
  }
  const retainedTurnKey = readScope.lastReadMainConclusion?.turnKey;
  const retainedTs = readScope.lastReadMainConclusion?.timestampMs ?? 0;
  return Boolean(
    retainedTurnKey && rawSlice.turnKey === retainedTurnKey && attentionTs > retainedTs,
  );
}

function resolveMatchedTurnSliceForConclusion(input: {
  rawSlice: LatestTurnSlice;
  hasUnreadAttention: boolean;
  attentionTs: number;
  isError: boolean;
  hasLastError: boolean;
  isMainTimelineStale: boolean;
  readScope: TopicInboxReadScope | undefined;
}): LatestTurnSlice {
  const { rawSlice, hasUnreadAttention, attentionTs, isError, hasLastError, readScope } = input;
  if (!rawSlice.turnKey) return EMPTY_TURN_SLICE;
  if (!hasUnreadAttention) return rawSlice;
  if (input.isMainTimelineStale) return EMPTY_TURN_SLICE;
  if (isSliceSupersededByReadMark(rawSlice, attentionTs, readScope)) return EMPTY_TURN_SLICE;
  if (isError && hasLastError && attentionTs > (rawSlice.lastItemAtMs ?? 0)) {
    return EMPTY_TURN_SLICE;
  }
  return rawSlice;
}

function hasServerUnreadMainConclusion(mainAgent: InboxSourceAgent): boolean {
  return (
    mainAgent.requiresAttention === true &&
    (mainAgent.attentionReason === "finished" || mainAgent.attentionReason === "error")
  );
}

function buildMainConclusionPreview(
  mainAgent: InboxSourceAgent,
  latestAssistant: Extract<StreamItem, { kind: "assistant_message" }> | null,
  isError: boolean,
  senderTitle: string,
): string {
  const assistantPreview = cleanMessagePreview(latestAssistant?.text);
  if (assistantPreview) return assistantPreview;
  if (isError) {
    const errorPreview = cleanMessagePreview(mainAgent.lastError);
    if (errorPreview) return errorPreview;
  }
  return senderTitle;
}

function buildMainConclusionJumpTarget(
  mainAgentId: string,
  latestAssistant: Extract<StreamItem, { kind: "assistant_message" }> | null,
): TeamInboxJumpTarget {
  return {
    agentId: mainAgentId,
    itemId: latestAssistant?.id ?? null,
    messageId: latestAssistant ? getStreamItemMessageId(latestAssistant) : null,
    epoch: latestAssistant?.timelineCursor?.epoch ?? null,
    seq: latestAssistant?.timelineCursor?.seq ?? null,
  };
}

function resolveMainConclusionTone(isRead: boolean, isError: boolean): SidebarStateBucket {
  if (isRead) return "done";
  return isError ? "failed" : "attention";
}

function appendRetainedReadMainConclusion(input: {
  acc: InboxAggregationAccumulator;
  mainAgent: InboxSourceAgent;
  readScope: TopicInboxReadScope | undefined;
  turnSlice: LatestTurnSlice;
  fallbackAgentTitle: string;
}): void {
  const retained = input.readScope?.lastReadMainConclusion;
  if (!retained) return;
  const userMs = input.mainAgent.lastUserMessageAt?.getTime() ?? 0;
  const sliceMs = input.turnSlice.turnStartedAtMs ?? 0;
  if (userMs > retained.timestampMs || sliceMs > retained.timestampMs) return;

  const senderTitle = resolveAgentDisplayName(input.mainAgent, input.fallbackAgentTitle);
  const conclusionId =
    retained.id ?? `main-conclusion:${input.mainAgent.id}:att:${retained.timestampMs}`;
  input.acc.read.push({
    id: conclusionId,
    kind: "main_conclusion",
    isRead: true,
    urgencyRank: 3,
    timestampMs: retained.timestampMs,
    senderTitle,
    tagI18nKey: retained.isError
      ? "topicWorkbench.directory.agentErrorTag"
      : "topicWorkbench.directory.mainConclusionTag",
    tone: "done",
    preview: retained.preview || senderTitle,
    targetAgentId: input.mainAgent.id,
    jumpTarget: retained.jumpTarget ?? buildMainConclusionJumpTarget(input.mainAgent.id, null),
  });
}

function buildLiveMainConclusionCandidate(
  mainAgent: InboxSourceAgent,
  hasUnreadAttention: boolean,
  attentionTs: number,
  turnSlice: LatestTurnSlice,
): {
  conclusionId: string;
  conclusionTs: number;
  epoch: string | null;
  seq: number | null;
  readCandidate: TopicInboxReadCandidate;
} {
  const assistantTs = turnSlice.latestAssistant?.timestamp.getTime() ?? 0;
  const conclusionTs = Math.max(attentionTs, assistantTs);
  let conclusionKey = `att:${attentionTs}`;
  if (!hasUnreadAttention && turnSlice.turnKey) {
    conclusionKey = `turn:${turnSlice.turnKey}`;
  }
  const conclusionId = `main-conclusion:${mainAgent.id}:${conclusionKey}`;
  const epoch = turnSlice.latestAssistant?.timelineCursor?.epoch ?? null;
  const seq = turnSlice.latestAssistant?.timelineCursor?.seq ?? null;
  return {
    conclusionId,
    conclusionTs,
    epoch,
    seq,
    readCandidate: { id: conclusionId, epoch, seq, timestampMs: conclusionTs },
  };
}

function isLiveMainConclusionRead(
  hasUnreadAttention: boolean,
  readScope: TopicInboxReadScope | undefined,
  readCandidate: TopicInboxReadCandidate,
  conclusionTs: number,
): boolean {
  if (!hasUnreadAttention) return true;
  if (isTopicInboxItemRead(readScope, readCandidate)) return true;
  return (
    typeof readScope?.readMainConclusionAtMs === "number" &&
    conclusionTs <= readScope.readMainConclusionAtMs
  );
}

function resolveConclusionJumpTarget(input: {
  mainAgentId: string;
  conclusionId: string;
  turnSlice: LatestTurnSlice;
  isRead: boolean;
  readScope: TopicInboxReadScope | undefined;
}): TeamInboxJumpTarget {
  const { mainAgentId, conclusionId, turnSlice, isRead, readScope } = input;
  const retained = readScope?.lastReadMainConclusion;
  if (!turnSlice.latestAssistant && isRead && retained?.jumpTarget) {
    const matchesId = Boolean(retained.id && retained.id === conclusionId);
    const matchesTurn = Boolean(
      retained.turnKey && turnSlice.turnKey && retained.turnKey === turnSlice.turnKey,
    );
    if (matchesId || matchesTurn) {
      return retained.jumpTarget;
    }
  }
  return buildMainConclusionJumpTarget(mainAgentId, turnSlice.latestAssistant);
}

function collectMainConclusionMessage(input: {
  acc: InboxAggregationAccumulator;
  mainAgent: InboxSourceAgent | undefined;
  combinedStream: readonly StreamItem[];
  mainTimelineHasNewer: boolean;
  isMainTimelineStale: boolean;
  readScope: TopicInboxReadScope | undefined;
  fallbackAgentTitle: string;
}): void {
  const {
    acc,
    mainAgent,
    combinedStream,
    mainTimelineHasNewer,
    isMainTimelineStale,
    readScope,
    fallbackAgentTitle,
  } = input;
  if (!mainAgent || mainAgent.archivedAt || isAgentActivelyBusy(mainAgent)) return;

  const hasUnreadAttention = hasServerUnreadMainConclusion(mainAgent);
  const attentionTs = (mainAgent.attentionTimestamp ?? mainAgent.updatedAt).getTime();
  const isError = mainAgent.attentionReason === "error" || mainAgent.status === "error";
  const hasLastError = Boolean(mainAgent.lastError?.trim());
  const rawSlice = extractLatestTurnSlice(
    combinedStream,
    mainAgent.lastUserMessageAt,
    mainTimelineHasNewer,
  );
  const turnSlice = resolveMatchedTurnSliceForConclusion({
    rawSlice,
    hasUnreadAttention,
    attentionTs,
    isError,
    hasLastError,
    isMainTimelineStale,
    readScope,
  });

  if (!hasUnreadAttention && !turnSlice.latestAssistant && !(isError && hasLastError)) {
    appendRetainedReadMainConclusion({
      acc,
      mainAgent,
      readScope,
      turnSlice: rawSlice,
      fallbackAgentTitle,
    });
    return;
  }

  const { conclusionId, conclusionTs, epoch, seq, readCandidate } =
    buildLiveMainConclusionCandidate(mainAgent, hasUnreadAttention, attentionTs, turnSlice);
  const isRead = isLiveMainConclusionRead(
    hasUnreadAttention,
    readScope,
    readCandidate,
    conclusionTs,
  );
  const senderTitle = resolveAgentDisplayName(mainAgent, fallbackAgentTitle);
  const preview = buildMainConclusionPreview(
    mainAgent,
    turnSlice.latestAssistant,
    isError,
    senderTitle,
  );
  const jumpTarget = resolveConclusionJumpTarget({
    mainAgentId: mainAgent.id,
    conclusionId,
    turnSlice,
    isRead,
    readScope,
  });
  const mainConclusionSnapshot: RetainedMainConclusionSnapshot = {
    id: conclusionId,
    turnKey: turnSlice.turnKey,
    timestampMs: conclusionTs,
    preview,
    isError,
    jumpTarget,
  };

  if (!isRead) {
    recordStreamWatermark(acc, epoch, seq, conclusionTs);
    acc.markableUnreadIds.push(conclusionId);
    acc.unreadMainConclusion = mainConclusionSnapshot;
  }

  const entry: TeamInboxMessageItem = {
    id: conclusionId,
    kind: "main_conclusion",
    isRead,
    urgencyRank: !isRead && isError ? 1 : 3,
    timestampMs: conclusionTs,
    senderTitle,
    tagI18nKey: isError
      ? "topicWorkbench.directory.agentErrorTag"
      : "topicWorkbench.directory.mainConclusionTag",
    tone: resolveMainConclusionTone(isRead, isError),
    preview,
    targetAgentId: mainAgent.id,
    jumpTarget,
    readCandidate,
    mainConclusionSnapshot,
  };

  if (isRead) acc.read.push(entry);
  else acc.unread.push(entry);
}

function compareUnreadMessages(left: TeamInboxMessageItem, right: TeamInboxMessageItem): number {
  if (left.urgencyRank !== right.urgencyRank) {
    return left.urgencyRank - right.urgencyRank;
  }
  if (left.timestampMs !== right.timestampMs) {
    return right.timestampMs - left.timestampMs;
  }
  return left.id.localeCompare(right.id);
}

function compareReadMessages(left: TeamInboxMessageItem, right: TeamInboxMessageItem): number {
  if (left.timestampMs !== right.timestampMs) {
    return right.timestampMs - left.timestampMs;
  }
  return left.id.localeCompare(right.id);
}

export function selectTeamDirectoryMessages(input: {
  workspaceId: string;
  mainAgentId: string | null;
  agents: ReadonlyMap<string, InboxSourceAgent> | undefined;
  mainStreamTail?: readonly StreamItem[];
  mainStreamHead?: readonly StreamItem[];
  mainTimelineHasNewer?: boolean;
  isMainTimelineStale?: boolean;
  currentMainEpoch?: string | null;
  durableItems?: readonly WorkspaceDurableItem[];
  readScope: TopicInboxReadScope | undefined;
  fallbackAgentTitle: string;
}): TeamDirectoryMessagesProjection {
  const {
    workspaceId,
    mainAgentId,
    agents,
    mainStreamTail = [],
    mainStreamHead = [],
    mainTimelineHasNewer = false,
    isMainTimelineStale = false,
    currentMainEpoch = null,
    durableItems = [],
    readScope,
    fallbackAgentTitle,
  } = input;

  const mainAgent = mainAgentId ? agents?.get(mainAgentId) : undefined;
  const pendingInboxItems = mainAgent?.pendingSubagentInbox?.items ?? [];
  const combinedStream = [...mainStreamTail, ...mainStreamHead];
  const acc: InboxAggregationAccumulator = {
    unread: [],
    read: [],
    targetEpoch: resolveTargetWatermarkEpoch(currentMainEpoch, combinedStream),
    maxSeq: null,
    maxTimestampMs: 0,
    markableUnreadIds: [],
    unreadMainConclusion: null,
  };

  collectPermissionMessages(acc, agents, workspaceId, fallbackAgentTitle);
  collectDurableItemMessages(acc, durableItems, workspaceId, mainAgentId);
  collectPendingInboxMessages(
    acc,
    pendingInboxItems,
    agents,
    mainAgent,
    mainAgentId,
    fallbackAgentTitle,
  );
  collectTimelineReportMessages({
    acc,
    mainAgentId,
    combinedStream,
    agents,
    readScope,
    fallbackAgentTitle,
  });
  collectMainConclusionMessage({
    acc,
    mainAgent,
    combinedStream,
    mainTimelineHasNewer,
    isMainTimelineStale,
    readScope,
    fallbackAgentTitle,
  });

  acc.unread.sort(compareUnreadMessages);
  acc.read.sort(compareReadMessages);

  return {
    unread: acc.unread,
    read: acc.read,
    hasPendingInboxToFlush: Boolean(mainAgentId && pendingInboxItems.length > 0),
    markAllSnapshot: {
      epoch: acc.targetEpoch,
      maxSeq: acc.maxSeq,
      maxTimestampMs: acc.maxTimestampMs > 0 ? acc.maxTimestampMs : undefined,
      itemIds: acc.markableUnreadIds,
      mainConclusion: acc.unreadMainConclusion,
    },
  };
}
