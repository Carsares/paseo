import type { TopicThreadEntry, WorkspaceTopicReadSnapshot } from "@getpaseo/protocol/messages";
import type { ProjectedTimelineRow } from "../agent/timeline-projection.js";
import type { WorkspaceTask } from "../agent/task-ledger/index.js";

interface VisibleReply {
  topicKey?: string;
  timestamp: string;
  seq?: number;
  turnId?: string;
}

type TopicBindings = Map<string, string | null>;

function bind(keys: TopicBindings, id: string, key: string | null) {
  const previous = keys.get(id);
  keys.set(id, previous === undefined || previous === key ? key : null);
}

function resolveKeys(keys: TopicBindings, ids: readonly string[]): string | null | undefined {
  const matches = new Set(ids.map((id) => keys.get(id)).filter((key) => key !== undefined));
  return matches.size > 1 ? null : matches.values().next().value;
}

function userIds(row: ProjectedTimelineRow): string[] {
  return row.item.type === "user_message"
    ? [row.item.messageId, row.item.clientMessageId, row.providerMessageId].filter(
        (id): id is string => Boolean(id),
      )
    : [];
}

function createTopicKeys(
  rows: readonly ProjectedTimelineRow[],
  tasks: readonly WorkspaceTask[],
  thread: readonly TopicThreadEntry[],
) {
  const taskKeys: TopicBindings = new Map();
  const rootKeys: TopicBindings = new Map();
  const followupKeys: TopicBindings = new Map();
  const promptKeys = new Map<ProjectedTimelineRow, string | null>();
  const threadKeys = new Map<string, string>();
  for (const { taskId, rootMessageId } of tasks) {
    if (!rootMessageId) continue;
    const key = `task:${taskId}`;
    bind(taskKeys, taskId, key);
    bind(rootKeys, rootMessageId, key);
  }
  const ledgerRootKeys = new Map(rootKeys);
  for (const entry of thread) {
    const legacyRoot = entry.topicKey.startsWith("msg:") ? entry.topicKey.slice(4) : undefined;
    const ledgerKey = legacyRoot ? ledgerRootKeys.get(legacyRoot) : undefined;
    const key =
      ledgerKey &&
      (!entry.taskId || ledgerKey === `task:${entry.taskId}`) &&
      (!entry.rootMessageId || entry.rootMessageId === legacyRoot)
        ? ledgerKey
        : entry.topicKey;
    threadKeys.set(entry.entryId, key);
    if (entry.taskId) bind(taskKeys, entry.taskId, key);
    if (entry.rootMessageId) bind(rootKeys, entry.rootMessageId, key);
    if (entry.role !== "user_followup") continue;
    bind(followupKeys, entry.entryId, key);
    if (entry.sourceMessageId) bind(followupKeys, entry.sourceMessageId, key);
  }
  // Index all root aliases before inspecting reports, even if the root appears later.
  for (const row of rows) {
    const ids = userIds(row);
    if (!ids.length) continue;
    const followup = resolveKeys(followupKeys, ids);
    if (followup !== undefined) {
      promptKeys.set(row, followup);
      continue;
    }
    const root = resolveKeys(rootKeys, ids);
    const key = root === undefined ? `msg:${ids[0]}` : root;
    promptKeys.set(row, key);
    for (const id of ids) bind(rootKeys, id, key);
  }
  return {
    thread(entry: TopicThreadEntry) {
      return threadKeys.get(entry.entryId);
    },
    user(row: ProjectedTimelineRow) {
      return promptKeys.get(row) ?? undefined;
    },
    report({ taskId, rootMessageId }: { taskId?: string; rootMessageId?: string }) {
      const rootKey = rootMessageId ? rootKeys.get(rootMessageId) : undefined;
      const taskKey = taskId ? taskKeys.get(taskId) : undefined;
      if ((taskId && !taskKey) || (rootMessageId && !rootKey)) return;
      if (rootKey && taskKey && rootKey !== taskKey) return;
      return rootKey ?? taskKey ?? undefined;
    },
  };
}

function mainReplyMirrors(thread: readonly TopicThreadEntry[]) {
  const mirrors = new Map<string, TopicThreadEntry>();
  const followupIds = new Map<string, string>();
  for (const entry of thread) {
    if (entry.routedAgentId !== entry.mainAgentId) continue;
    if (entry.role === "user_followup") {
      followupIds.set(entry.entryId, entry.entryId);
      if (entry.sourceMessageId) followupIds.set(entry.sourceMessageId, entry.entryId);
    }
    if (entry.role === "agent_reply" && entry.sourceMessageId) {
      mirrors.set(entry.sourceMessageId, entry);
    }
  }
  const matchedSyntheticReplies = new Set<string>();

  function findReply(row: ProjectedTimelineRow, followupId: string | undefined) {
    if (row.item.type !== "assistant_message") return;
    const exact = mirrors.get(row.item.messageId ?? "") ?? mirrors.get(row.providerMessageId ?? "");
    if (exact) return exact;
    if (!followupId) return;
    const synthetic = mirrors.get(`topic-reply:${followupId}`);
    if (!synthetic || matchedSyntheticReplies.has(synthetic.entryId)) return;
    if (synthetic.text.trim() !== row.item.text.trim()) return;
    matchedSyntheticReplies.add(synthetic.entryId);
    return synthetic;
  }

  return { findReply, followupIds };
}

function* visibleReplies(
  rows: readonly ProjectedTimelineRow[],
  tasks: readonly WorkspaceTask[],
  thread: readonly TopicThreadEntry[],
): Iterable<VisibleReply> {
  const keys = createTopicKeys(rows, tasks, thread);
  const { findReply, followupIds } = mainReplyMirrors(thread);
  const mirrorTurns = new Map<string, string>();
  const promptTopicsByTurn = new Map<string, string | undefined>();
  const followupsByTurn = new Map<string, string | undefined>();
  let promptTopicKey: string | undefined;
  let promptTurnId: string | undefined;
  let promptFollowupId: string | undefined;
  for (const row of rows) {
    const { item, timestamp, seqEnd, turnId } = row;
    if (item.type === "user_message") {
      promptTopicKey = keys.user(row);
      promptTurnId = turnId;
      promptFollowupId = userIds(row)
        .map((id) => followupIds.get(id))
        .find(Boolean);
      if (turnId) {
        promptTopicsByTurn.set(turnId, promptTopicKey);
        followupsByTurn.set(turnId, promptFollowupId);
      }
    } else if (item.type === "tool_call" && item.agentMessage) {
      const topicKey = keys.report(item.agentMessage);
      yield {
        topicKey,
        timestamp,
        seq: seqEnd,
        turnId:
          turnId && promptTopicsByTurn.get(turnId) === (topicKey ?? null) ? turnId : undefined,
      };
    } else if (item.type === "assistant_message" && item.text.trim()) {
      const followup = turnId ? followupsByTurn.get(turnId) : promptFollowupId;
      const mirror = findReply(row, followup);
      if (mirror) {
        if (turnId) mirrorTurns.set(mirror.entryId, turnId);
        continue;
      }
      // Older timeline rows can lack turn identity, so use the preceding prompt in that case.
      let topicKey = promptTopicKey;
      if (turnId && (promptTurnId || promptTopicsByTurn.has(turnId))) {
        topicKey = promptTopicsByTurn.get(turnId);
      }
      yield { topicKey, timestamp, seq: seqEnd, turnId };
    }
  }
  for (const entry of thread) {
    if (entry.role === "user_followup") continue;
    yield {
      topicKey: keys.thread(entry),
      timestamp: entry.updatedAt,
      turnId: mirrorTurns.get(entry.entryId),
    };
  }
}

/** Read coverage for the visible conclusions, using the same task and root keys as the cards. */
export function coversFinishedAttention(input: {
  snapshot: WorkspaceTopicReadSnapshot;
  epoch: string;
  rows: readonly ProjectedTimelineRow[];
  tasks: readonly WorkspaceTask[];
  thread: readonly TopicThreadEntry[];
  attentionAt: number;
  completedTurnId?: string;
}): boolean {
  const { snapshot, epoch, rows, tasks, thread, attentionAt, completedTurnId } = input;
  if (snapshot.topics.some((topic) => topic.markedUnreadAtMs !== null)) return false;
  const readByKey = new Map(snapshot.topics.map((topic) => [topic.topicKey, topic]));
  let finishCovered = false;
  for (const { topicKey, seq, timestamp, turnId } of visibleReplies(rows, tasks, thread)) {
    const mark = topicKey ? readByKey.get(topicKey) : undefined;
    const readAt = Math.max(snapshot.watermarkTimestampMs, mark?.readUpToTimestampMs ?? 0);
    const readSeq = Math.max(snapshot.watermarkSeq, mark?.readUpToSeq ?? -1);
    const covered =
      snapshot.watermarkEpoch === epoch && seq !== undefined
        ? seq <= readSeq
        : Date.parse(timestamp) <= readAt;
    if (!covered) return false;
    if (readAt >= attentionAt || (completedTurnId && turnId === completedTurnId)) {
      finishCovered = true;
    }
  }
  return finishCovered;
}
