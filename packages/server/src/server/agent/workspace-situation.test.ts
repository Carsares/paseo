import type {
  TopicAnchorSummary,
  TopicThreadEntry,
  WorkspaceDurableItem,
  WorkspaceTodoItem,
} from "@getpaseo/protocol/messages";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceTask } from "./task-ledger/index.js";
import { readWorkspaceSituation } from "./workspace-situation.js";

const date = "2026-11-26T00:00:00.000Z";
const scope = { workspaceId: "workspace", mainAgentId: "main" };
const options = { includeCompletedTasks: false, completedLimit: 5 };

function task(taskId: string, overrides: Partial<WorkspaceTask> = {}): WorkspaceTask {
  return {
    taskId,
    title: taskId,
    status: "in_progress",
    tier: "T1",
    participants: [],
    createdAt: date,
    updatedAt: date,
    ...overrides,
  };
}

function durable(requestId: string, title = "Decision"): WorkspaceDurableItem {
  return {
    workspaceId: scope.workspaceId,
    requestId,
    sourceAgentId: "lead",
    sourceTurnId: "turn",
    kind: "decision",
    status: "pending",
    createdAt: date,
    title,
    evidence: [],
    revision: 0,
  };
}

function todo(todoId: string): WorkspaceTodoItem {
  return {
    workspaceId: scope.workspaceId,
    todoId,
    title: "Deadline",
    status: "pending",
    dueAt: date,
    source: null,
    assignedAgentId: null,
    checklist: [{ itemId: "check", text: "Check", completed: true }],
    createdAt: date,
    updatedAt: date,
    completedAt: null,
    remindBeforeMinutes: null,
    lastDueNotifiedAt: null,
    snoozedUntil: null,
    revision: 0,
  };
}

function sources(
  tasks: WorkspaceTask[],
  items: WorkspaceDurableItem[],
  todos: WorkspaceTodoItem[],
  anchors: TopicAnchorSummary[] = [],
  entries: TopicThreadEntry[] = [],
) {
  return {
    listTasks: vi.fn(async () => tasks),
    listPendingDurableItems: vi.fn(async () => items),
    listPendingTodos: vi.fn(async () => todos),
    listWithAnchors: vi.fn(async () => ({ anchors, entries })),
    getReadState: vi.fn(async () => ({
      ...scope,
      watermarkEpoch: "epoch",
      watermarkSeq: 5,
      watermarkTimestampMs: 0,
      topics: [],
      revision: 0,
    })),
    getTimeline: vi.fn(() => ({ epoch: "epoch", rows: [] })),
    listAgents: vi.fn(() => []),
    readTaskParticipantReuse: vi.fn(async () => new Map()),
    now: () => Date.parse(date) + 1,
  };
}

describe("workspace situation", () => {
  it("unifies blockers, durable items, due dates, topic read state and live file conflicts", async () => {
    const a = task("a", {
      rootMessageId: "start",
      status: "awaiting_decision",
      blockingQuestion: "Which option?",
      touchedFiles: ["file.ts"],
    });
    const b = task("b", { status: "verifying", touchedFiles: ["file.ts"] });
    const c = task("c", { status: "completed", touchedFiles: ["file.ts"] });
    const anchor = {
      ...scope,
      topicKey: "msg:start",
      rootMessageId: "start",
      rootPromptText: "First question",
      createdAt: date,
      updatedAt: date,
    };
    const entry: TopicThreadEntry = {
      ...scope,
      entryId: "reply",
      topicKey: "msg:start",
      rootMessageId: "start",
      text: "Latest answer",
      routedAgentId: "lead",
      role: "agent_reply",
      status: "completed",
      seq: 0,
      createdAt: date,
      updatedAt: date,
    };
    const deps = sources([a, b, c], [durable("d")], [todo("overdue")], [anchor], [entry]);
    const read = readWorkspaceSituation(deps, scope.workspaceId, scope.mainAgentId, options);
    expect(deps.listTasks).toHaveBeenCalledWith(scope.workspaceId);
    expect(deps.listPendingTodos).toHaveBeenCalledWith(scope.workspaceId);
    expect(deps.listWithAnchors).toHaveBeenCalledWith(scope);
    expect(deps.getReadState).toHaveBeenCalledWith(scope);
    const result = await read;
    expect(result.counts).toEqual({
      activeTasks: 2,
      awaitingDecisionTasks: 1,
      verifyingTasks: 1,
      completedTasks: 1,
      pendingDurableItems: 1,
      pendingTodos: 1,
      overdueTodos: 1,
      unreadTopics: 1,
      conflictingTaskCount: 2,
    });
    expect(result.pendingHumanActions).toMatchObject({
      durableItems: [{ requestId: "d" }],
      blockingQuestions: [{ taskId: "a", blockingQuestion: "Which option?" }],
      todos: [
        { todoId: "overdue", isOverdue: true, completedChecklistCount: 1, totalChecklistCount: 1 },
      ],
    });
    expect(result.fileConflicts).toMatchObject([
      { path: "file.ts", tasks: [{ taskId: "a" }, { taskId: "b" }] },
    ]);
    expect(result.topics).toMatchObject([
      {
        topicKey: "task:a",
        rootPromptText: "First question",
        hasUnread: true,
        latestReplyPreview: "Latest answer",
      },
      { topicKey: "task:b", hasUnread: false },
    ]);
    expect(result.truncation.completedTopicsExcluded).toBe(1);
    const withCompleted = await readWorkspaceSituation(deps, scope.workspaceId, scope.mainAgentId, {
      includeCompletedTasks: true,
      completedLimit: 1,
    });
    expect(withCompleted.topics.map(({ taskId }) => taskId)).toEqual(["a", "b", "c"]);
  });

  it("caps UTF-8 and JSON escaping costs while preserving exact counts and urgent rows", async () => {
    const text = '🧪题"\\'.repeat(350);
    const tasks = Array.from({ length: 80 }, (_, index) =>
      task(`task-${index}`, { title: text, blockingQuestion: text }),
    );
    const items = Array.from({ length: 140 }, (_, index) => durable(`item-${index}`, text));
    const result = await readWorkspaceSituation(
      sources(tasks, items, [todo("now")]),
      scope.workspaceId,
      scope.mainAgentId,
      options,
    );
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(32_000);
    expect(result.counts).toMatchObject({
      activeTasks: 80,
      pendingDurableItems: 140,
      overdueTodos: 1,
    });
    expect(result.pendingHumanActions.todos).toHaveLength(1);
    expect(result.pendingHumanActions.durableItems.length).toBeGreaterThan(0);
    expect(result.truncation.omitted.durableItems).toBe(
      140 - result.pendingHumanActions.durableItems.length,
    );
    expect(result.truncation.omitted.blockingQuestions).toBe(
      80 - result.pendingHumanActions.blockingQuestions.length,
    );
    expect(result.truncation.omitted.topics).toBe(80 - result.topics.length);
  });
});
