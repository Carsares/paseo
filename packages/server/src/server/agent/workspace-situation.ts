import type {
  TopicAnchorSummary,
  TopicThreadEntry,
  WorkspaceDurableItem,
  WorkspaceTodoItem,
  WorkspaceTopicReadSnapshot,
} from "@getpaseo/protocol/messages";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import { isSystemInjectedEnvelope, parseAgentMessages } from "./agent-messages/envelope.js";
import type { AgentTimelineFetchResult } from "./agent-timeline-store-types.js";
import { projectTaskParticipantReuse, type WorkspaceTask } from "./task-ledger/index.js";
import {
  computeWorkspaceTaskFileConflicts,
  isActiveWorkspaceTask,
} from "./task-ledger/touched-files.js";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

export interface WorkspaceSituationOptions {
  includeCompletedTasks: boolean;
  completedLimit: number;
}

interface SituationScope {
  workspaceId: string;
  mainAgentId: string;
}

interface SituationThread {
  anchors: readonly TopicAnchorSummary[];
  entries: readonly TopicThreadEntry[];
}

interface SituationSources {
  listTasks(workspaceId: string): Promise<WorkspaceTask[]>;
  listPendingDurableItems(workspaceId: string): Promise<WorkspaceDurableItem[]>;
  listPendingTodos(workspaceId: string): Promise<WorkspaceTodoItem[]>;
  listWithAnchors(scope: SituationScope): Promise<SituationThread>;
  getReadState(scope: SituationScope): Promise<WorkspaceTopicReadSnapshot>;
  getTimeline(mainAgentId: string): Pick<AgentTimelineFetchResult, "epoch" | "rows">;
  listAgents(): ManagedAgent[];
  readTaskParticipantReuse: AgentManager["readTaskParticipantReuse"];
  now?: () => number;
}

export const WORKSPACE_SITUATION_MAX_BYTES = 32_000;

interface TopicView {
  topicKey: string;
  taskId?: string;
  rootMessageId?: string;
  title?: string;
  rootPromptText?: string;
  status?: WorkspaceTask["status"];
  leadAgentId?: string;
  leadTitle?: string;
  leadServerId?: string;
  leadLifecycle?: ManagedAgent["lifecycle"];
  latestReplyPreview?: string;
  touchedFiles?: readonly string[];
  participantReuse?: ReturnType<typeof projectTaskParticipantReuse>[number]["participantReuse"];
  updatedAt: string;
  hasUnread: boolean;
}

function createTopicIndex(tasks: readonly WorkspaceTask[], snapshot: WorkspaceTopicReadSnapshot) {
  const views = new Map<string, TopicView>();
  const roots = new Map<string, string | null>();
  const marks = new Map(snapshot.topics.map((mark) => [mark.topicKey, mark]));
  const latestReplies = new Map<string, string>();
  for (const { taskId, rootMessageId } of tasks) {
    if (!rootMessageId) continue;
    roots.set(rootMessageId, roots.has(rootMessageId) ? null : `task:${taskId}`);
  }

  return {
    views,
    canonicalKey(key: string) {
      if (!key.startsWith("msg:")) return key;
      return roots.get(key.slice(4)) ?? key;
    },
    mark(view: TopicView) {
      const root = view.rootMessageId;
      const rootMark =
        root && roots.get(root) === view.topicKey ? marks.get(`msg:${root}`) : undefined;
      return marks.get(view.topicKey) ?? rootMark;
    },
    topic(key: string, updatedAt: string) {
      const existing = views.get(key);
      if (existing) {
        if (updatedAt > existing.updatedAt) existing.updatedAt = updatedAt;
        return existing;
      }
      const created: TopicView = { topicKey: key, updatedAt, hasUnread: false };
      views.set(key, created);
      return created;
    },
    recordPreview(view: TopicView, timestamp: string, value: string) {
      const latest = latestReplies.get(view.topicKey);
      if (value.trim() && (!latest || timestamp >= latest)) {
        latestReplies.set(view.topicKey, timestamp);
        view.latestReplyPreview = value;
      }
    },
  };
}

type TopicIndex = ReturnType<typeof createTopicIndex>;
type ProjectedTask = ReturnType<typeof projectTaskParticipantReuse>[number];
type SituationTimeline = ReturnType<SituationSources["getTimeline"]>;
type SituationTimelineRow = SituationTimeline["rows"][number];

function mergeAnchor(index: TopicIndex, anchor: TopicAnchorSummary) {
  const view = index.topic(index.canonicalKey(anchor.topicKey), anchor.updatedAt);
  view.taskId = anchor.taskId ?? view.taskId;
  view.rootMessageId = anchor.rootMessageId ?? view.rootMessageId;
  view.title = anchor.title ?? view.title;
  view.rootPromptText = anchor.rootPromptText || view.rootPromptText;
  view.leadAgentId = anchor.leadAgentId ?? view.leadAgentId;
  view.leadTitle = anchor.leadTitle ?? view.leadTitle;
  view.leadServerId = anchor.leadServerId ?? view.leadServerId;
}

function mergeTask(index: TopicIndex, task: ProjectedTask) {
  const view = index.topic(`task:${task.taskId}`, task.updatedAt);
  Object.assign(view, {
    taskId: task.taskId,
    rootMessageId: task.rootMessageId ?? view.rootMessageId,
    title: task.title,
    status: task.status,
    leadAgentId: task.leadAgentId ?? view.leadAgentId,
    leadServerId: task.leadServerId ?? view.leadServerId,
    latestReplyPreview: task.latestReplyPreview,
    touchedFiles: task.touchedFiles,
    participantReuse: task.participantReuse,
  });
}

function createReplyObserver(
  index: TopicIndex,
  snapshot: WorkspaceTopicReadSnapshot,
  epoch: string,
) {
  return (view: TopicView, timestamp: string, seq?: number) => {
    const mark = index.mark(view);
    const readAt = Math.max(snapshot.watermarkTimestampMs, mark?.readUpToTimestampMs ?? 0);
    const readSeq = Math.max(snapshot.watermarkSeq, mark?.readUpToSeq ?? -1);
    const unread =
      snapshot.watermarkEpoch === epoch && seq !== undefined
        ? seq > readSeq
        : Date.parse(timestamp) > readAt;
    view.hasUnread ||= unread;
  };
}

type ObserveReply = ReturnType<typeof createReplyObserver>;

function projectThreadEntries(
  index: TopicIndex,
  entries: readonly TopicThreadEntry[],
  observeReply: ObserveReply,
) {
  const followups = new Map<string, string>();
  const mirrorIds = new Set<string>();
  for (const entry of entries) {
    const key = index.canonicalKey(entry.topicKey);
    const view = index.topic(key, entry.updatedAt);
    view.taskId ??= entry.taskId;
    view.rootMessageId ??= entry.rootMessageId;
    if (entry.role === "user_followup") {
      followups.set(entry.entryId, key);
      if (entry.sourceMessageId) followups.set(entry.sourceMessageId, key);
      continue;
    }
    if (entry.routedAgentId === entry.mainAgentId && entry.sourceMessageId)
      mirrorIds.add(entry.sourceMessageId);
    observeReply(view, entry.updatedAt);
    index.recordPreview(view, entry.updatedAt, entry.text);
  }
  return { followups, mirrorIds };
}

function readPromptTopic(
  index: TopicIndex,
  followups: ReadonlyMap<string, string>,
  row: SituationTimelineRow,
) {
  const { item, providerMessageId, timestamp } = row;
  if (item.type !== "user_message") return;
  const ids = [item.messageId, item.clientMessageId, providerMessageId].filter((id): id is string =>
    Boolean(id),
  );
  const followup = ids.map((id) => followups.get(id)).find(Boolean);
  if (followup) return followup;
  if (!ids.length || isSystemInjectedEnvelope(item.text)) return;
  const messages = parseAgentMessages(item.text);
  const humanMessage = messages?.find(({ source }) => source === null);
  if (messages && !humanMessage) return;

  const keys = ids.map((id) => index.canonicalKey(`msg:${id}`));
  const key =
    keys.find((candidate) => candidate.startsWith("task:")) ??
    keys.find((candidate) => index.views.has(candidate)) ??
    keys[0];
  const view = index.topic(key, timestamp);
  view.rootMessageId ??= ids[0];
  view.rootPromptText ??= humanMessage?.text ?? item.text;
  return key;
}

function reportTopic(index: TopicIndex, taskId?: string, rootMessageId?: string) {
  const key = taskId
    ? `task:${taskId}`
    : rootMessageId && index.canonicalKey(`msg:${rootMessageId}`);
  const view = key ? index.views.get(key) : undefined;
  if (!view || (rootMessageId && view.rootMessageId && view.rootMessageId !== rootMessageId))
    return;
  return view;
}

function projectMainTimeline(
  index: TopicIndex,
  timeline: SituationTimeline,
  thread: ReturnType<typeof projectThreadEntries>,
  observeReply: ObserveReply,
) {
  const keysByTurn = new Map<string, string>();
  let currentKey: string | undefined;
  for (const row of timeline.rows) {
    const { item, turnId, timestamp, seqEnd, providerMessageId } = row;
    if (item.type === "user_message") {
      currentKey = readPromptTopic(index, thread.followups, row);
      if (turnId && currentKey) keysByTurn.set(turnId, currentKey);
    } else if (item.type === "assistant_message" && item.text.trim()) {
      const key = turnId ? keysByTurn.get(turnId) : currentKey;
      if (
        !key ||
        thread.mirrorIds.has(item.messageId ?? "") ||
        thread.mirrorIds.has(providerMessageId ?? "")
      )
        continue;
      const view = index.topic(key, timestamp);
      observeReply(view, timestamp, seqEnd);
      index.recordPreview(view, timestamp, item.text);
    } else if (item.type === "tool_call" && item.agentMessage) {
      const view = reportTopic(index, item.agentMessage.taskId, item.agentMessage.rootMessageId);
      if (!view) continue;
      observeReply(view, timestamp, seqEnd);
      index.recordPreview(view, timestamp, item.agentMessage.text);
    }
  }
}

function buildTopics(
  thread: SituationThread,
  tasks: ProjectedTask[],
  snapshot: WorkspaceTopicReadSnapshot,
  timeline: SituationTimeline,
  agents: ReadonlyMap<string, ManagedAgent>,
) {
  const index = createTopicIndex(tasks, snapshot);
  const anchors = [...thread.anchors].sort(
    (a, b) => Number(b.topicKey.startsWith("msg:")) - Number(a.topicKey.startsWith("msg:")),
  );
  for (const anchor of anchors) mergeAnchor(index, anchor);
  for (const task of tasks) mergeTask(index, task);
  const observeReply = createReplyObserver(index, snapshot, timeline.epoch);
  const projected = projectThreadEntries(index, thread.entries, observeReply);
  projectMainTimeline(index, timeline, projected, observeReply);

  for (const view of index.views.values()) {
    view.hasUnread ||= index.mark(view)?.markedUnreadAtMs != null;
    const lead = view.leadAgentId ? agents.get(view.leadAgentId) : undefined;
    if (lead) {
      view.leadTitle = lead.config.title ?? view.leadTitle;
      view.leadLifecycle = lead.lifecycle;
    }
  }
  return [...index.views.values()];
}

function previewText(value: string | undefined, limit: number) {
  if (value === undefined || value.length <= limit) return value;
  const prefix = value.slice(0, limit);
  return `${/[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix}…`;
}

type SituationRow =
  | ReturnType<typeof projectDurableItem>
  | ReturnType<typeof projectTodo>
  | ReturnType<typeof projectBlockingQuestion>
  | ReturnType<typeof projectConflict>
  | ReturnType<typeof projectTopic>
  | ReturnType<typeof projectAgent>;

function projectDurableItem(item: WorkspaceDurableItem) {
  return {
    requestId: item.requestId,
    kind: item.kind,
    title: previewText(item.title, 200),
    summary: previewText(item.summary, 600),
    taskId: item.taskId,
    topicKey: item.topicKey,
    sourceAgentId: item.sourceAgentId,
    evidencePaths: item.evidence.map(({ path }) => path),
    revision: item.revision,
  };
}

function projectTodo(item: WorkspaceTodoItem, now: number) {
  return {
    todoId: item.todoId,
    title: previewText(item.title, 200),
    isOverdue: item.dueAt !== null && Date.parse(item.dueAt) <= now,
    dueAt: item.dueAt,
    completedChecklistCount: item.checklist.filter(({ completed }) => completed).length,
    totalChecklistCount: item.checklist.length,
    source: item.source ? { topicKey: item.source.topicKey } : null,
    revision: item.revision,
  };
}

function projectBlockingQuestion(topic: TopicView, task: WorkspaceTask) {
  return {
    taskId: task.taskId,
    topicKey: topic.topicKey,
    title: previewText(task.title, 200),
    leadAgentId: topic.leadAgentId,
    leadTitle: previewText(topic.leadTitle, 160),
    blockingQuestion: previewText(task.blockingQuestion?.trim(), 600),
    blockingQuestionGeneration: task.blockingQuestionGeneration,
  };
}

function projectConflict(path: string, tasks: Map<string, WorkspaceTask>) {
  return {
    path,
    tasks: [...tasks.values()].map(({ taskId, title, leadAgentId, status }) => ({
      taskId,
      title: previewText(title, 200),
      leadAgentId,
      status,
    })),
  };
}

function projectTopic(view: TopicView) {
  return {
    ...view,
    title: previewText(view.title, 200),
    rootPromptText: previewText(view.rootPromptText, 360),
    latestReplyPreview: previewText(view.latestReplyPreview, 360),
    leadTitle: previewText(view.leadTitle, 160),
  };
}

function projectAgent(agent: ManagedAgent) {
  return {
    agentId: agent.id,
    title: previewText(agent.config.title ?? undefined, 160),
    lifecycle: agent.lifecycle,
  };
}

export async function readWorkspaceSituation(
  sources: SituationSources,
  workspaceId: string,
  mainAgentId: string,
  options: WorkspaceSituationOptions,
) {
  const scope = { workspaceId, mainAgentId };
  const [tasks, durableItems, todos, thread, readState, timeline, live] = await Promise.all([
    sources.listTasks(workspaceId),
    sources.listPendingDurableItems(workspaceId),
    sources.listPendingTodos(workspaceId),
    sources.listWithAnchors(scope),
    sources.getReadState(scope),
    Promise.resolve().then(() => sources.getTimeline(mainAgentId)),
    Promise.resolve().then(() => sources.listAgents()),
  ]);
  const agents = new Map(
    live
      .filter((agent) => agent.workspaceId === workspaceId && !agent.internal)
      .map((agent) => [agent.id, agent]),
  );
  const pendingItems = durableItems.filter(
    (item) => item.workspaceId === workspaceId && item.status === "pending",
  );
  const pendingTodos = todos.filter(
    (item) => item.workspaceId === workspaceId && item.status === "pending",
  );
  const reuse = await sources.readTaskParticipantReuse(mainAgentId, workspaceId, tasks);
  const topicViews = buildTopics(
    thread,
    projectTaskParticipantReuse(tasks, reuse),
    readState,
    timeline,
    agents,
  );
  const topicByKey = new Map(topicViews.map((topic) => [topic.topicKey, topic]));
  const active = tasks.filter(isActiveWorkspaceTask);
  const completed = tasks.filter(({ status }) => status === "completed");
  const blocked = tasks.filter(
    ({ status, blockingQuestion }) =>
      status === "awaiting_decision" || Boolean(blockingQuestion?.trim()),
  );
  const conflicts = computeWorkspaceTaskFileConflicts(tasks);
  const conflictsByPath = new Map<string, Map<string, WorkspaceTask>>();
  for (const task of active) {
    for (const { path } of conflicts.get(task.taskId) ?? []) {
      const group = conflictsByPath.get(path) ?? new Map<string, WorkspaceTask>();
      group.set(task.taskId, task);
      conflictsByPath.set(path, group);
    }
  }

  const now = sources.now?.() ?? Date.now();
  const todoViews = pendingTodos
    .map((item) => projectTodo(item, now))
    .sort(
      (a, b) =>
        (a.dueAt ?? "\uffff").localeCompare(b.dueAt ?? "\uffff") ||
        a.todoId.localeCompare(b.todoId),
    );
  topicViews.sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.topicKey.localeCompare(b.topicKey),
  );
  const completedTopics = topicViews.filter(({ status }) => status === "completed");
  const completedLimit = options.includeCompletedTasks ? options.completedLimit : 0;
  const includedCompleted = completedTopics.slice(0, completedLimit);
  function isSubagent(agent: ManagedAgent) {
    const visited = new Set<string>([agent.id]);
    let parentId = getParentAgentIdFromLabels(agent.labels);
    while (parentId && !visited.has(parentId)) {
      if (parentId === mainAgentId) return true;
      visited.add(parentId);
      parentId = getParentAgentIdFromLabels(agents.get(parentId)?.labels);
    }
    return false;
  }
  const activeAgents = [...agents.values()].filter(
    (agent) =>
      (agent.lifecycle === "initializing" || agent.lifecycle === "running") && isSubagent(agent),
  );
  const result = {
    workspaceId,
    counts: {
      activeTasks: active.length,
      awaitingDecisionTasks: tasks.filter(({ status }) => status === "awaiting_decision").length,
      verifyingTasks: tasks.filter(({ status }) => status === "verifying").length,
      completedTasks: completed.length,
      pendingDurableItems: pendingItems.length,
      pendingTodos: pendingTodos.length,
      overdueTodos: todoViews.filter(({ isOverdue }) => isOverdue).length,
      unreadTopics: topicViews.filter(({ hasUnread }) => hasUnread).length,
      conflictingTaskCount: active.filter(({ taskId }) => (conflicts.get(taskId)?.length ?? 0) > 0)
        .length,
    },
    pendingHumanActions: {
      durableItems: [] as ReturnType<typeof projectDurableItem>[],
      blockingQuestions: [] as ReturnType<typeof projectBlockingQuestion>[],
      todos: [] as ReturnType<typeof projectTodo>[],
    },
    fileConflicts: [] as ReturnType<typeof projectConflict>[],
    topics: [] as ReturnType<typeof projectTopic>[],
    activeAgents: [] as ReturnType<typeof projectAgent>[],
    truncation: {
      byteLimitExclusive: WORKSPACE_SITUATION_MAX_BYTES,
      previewTextLimits: {
        title: 200,
        leadTitle: 160,
        summary: 600,
        blockingQuestion: 600,
        topic: 360,
      },
      completedTopicsExcluded: completedTopics.length - includedCompleted.length,
      omitted: {
        durableItems: 0,
        blockingQuestions: 0,
        todos: 0,
        fileConflicts: 0,
        topics: 0,
        activeAgents: 0,
      },
    },
  };
  const kindOrder = { authorization: 0, decision: 1, acceptance: 2 };
  const durableViews = pendingItems
    .sort(
      (a, b) =>
        kindOrder[a.kind] - kindOrder[b.kind] ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.requestId.localeCompare(b.requestId),
    )
    .map(projectDurableItem);
  const blockingViews = blocked
    .sort(
      (a, b) =>
        Number(b.status === "awaiting_decision") - Number(a.status === "awaiting_decision") ||
        a.updatedAt.localeCompare(b.updatedAt),
    )
    .map((task) => projectBlockingQuestion(topicByKey.get(`task:${task.taskId}`)!, task));
  const conflictViews = [...conflictsByPath]
    .filter(([, group]) => group.size > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, group]) => projectConflict(path, group));
  const topicCandidates = topicViews
    .filter(({ status }) => status !== "completed")
    .concat(includedCompleted);
  const agentViews = activeAgents.map(projectAgent);

  function view<Row extends SituationRow>(
    key: keyof typeof result.truncation.omitted,
    candidates: Row[],
    output: Row[],
  ) {
    result.truncation.omitted[key] = candidates.length;
    return {
      length: candidates.length,
      add(index: number, bytesLeft: number) {
        const row = candidates[index];
        if (!row) return 0;
        const bytes = Buffer.byteLength(JSON.stringify(row), "utf8") + Number(output.length > 0);
        if (bytes > bytesLeft) return 0;
        output.push(row);
        result.truncation.omitted[key] -= 1;
        return bytes;
      },
    };
  }

  const views = [
    view("durableItems", durableViews, result.pendingHumanActions.durableItems),
    view("blockingQuestions", blockingViews, result.pendingHumanActions.blockingQuestions),
    view("todos", todoViews, result.pendingHumanActions.todos),
    view("fileConflicts", conflictViews, result.fileConflicts),
    view("topics", topicCandidates.map(projectTopic), result.topics),
    view("activeAgents", agentViews, result.activeAgents),
  ];
  // Omitted counts can only get shorter. Reserve their full initial JSON size.
  let bytesLeft =
    WORKSPACE_SITUATION_MAX_BYTES - 1 - Buffer.byteLength(JSON.stringify(result), "utf8");
  if (bytesLeft < 0) throw new Error("Workspace situation metadata exceeds the output limit.");
  const rows = Math.max(...views.map(({ length }) => length));
  for (let index = 0; index < rows && bytesLeft > 0; index++) {
    for (const source of views) bytesLeft -= source.add(index, bytesLeft);
  }
  return result;
}

export type WorkspaceSituation = Awaited<ReturnType<typeof readWorkspaceSituation>>;
