import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PARENT_AGENT_ID_LABEL,
  PARENT_SERVER_ID_LABEL,
  WORKSPACE_MAIN_ROLE,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { WorkspaceTopicDecideRequest } from "@getpaseo/protocol/messages";
import { expect, onTestFinished, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { WorkspaceTaskLedgerStore } from "../agent/task-ledger/index.js";
import * as atomicFile from "../atomic-file.js";
import { DurableItemStore } from "../durable-items/store.js";
import { listWorkspaceTaskSummaries } from "../task-ledger-rpc.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";
import { createTopicDecisionService, type TopicDecisionDependencies } from "./decide.js";
import { createTopicReplyRouter } from "./reply-router.js";
import { TopicThreadStore } from "./store.js";

const now = "2026-11-01T00:00:00.000Z";
const request: WorkspaceTopicDecideRequest = {
  type: "workspace.topic.decide.request",
  requestId: "request",
  workspaceId: "topic",
  mainAgentId: "main",
  topicKey: "task:ship",
  taskId: "ship",
  rootMessageId: "first",
  clientMessageId: "decision-message",
  resolutionKind: "durable_item",
  durableItemRequestId: "durable",
  expectedRevision: 0,
  decision: "approve",
};
const actor = { origin: "decision_reply", serverId: "host", principalId: "owner" } as const;

async function scenario(
  kind: "acceptance" | "decision" | "authorization" = "acceptance",
  leadServerId = "host",
) {
  const home = await mkdtemp(join(tmpdir(), "paseo-topic-decide-"));
  const routers: ReturnType<typeof createTopicReplyRouter>[] = [];
  onTestFinished(async () => {
    await Promise.all(routers.map((router) => router.close()));
    await rm(home, { recursive: true, force: true });
  });
  const logger = createTestLogger();
  const ledger = new WorkspaceTaskLedgerStore(home);
  const registry = new FileBackedWorkspaceRegistry(join(home, "workspaces.json"), logger);
  const agents = new AgentStorage(join(home, "agents"), logger);
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: request.workspaceId,
    projectId: "project",
    cwd: home,
    kind: "directory",
    title: "Ship",
    displayName: "Ship",
    createdAt: now,
    updatedAt: now,
    topic: {},
  });
  await registry.upsert(workspace);
  await agents.upsert({
    id: "lead",
    workspaceId: workspace.workspaceId,
    cwd: home,
    provider: "claude",
    title: null,
    labels: {},
    metadata: {},
    createdAt: now,
    updatedAt: now,
    lastStatus: "closed",
  });
  await ledger.upsert(request.workspaceId, {
    taskId: "ship",
    rootMessageId: "first",
    leadAgentId: "lead",
    leadServerId,
    title: "Ship",
    status: "awaiting_decision",
    blockingQuestion: "Should this ship?",
  });
  const evidencePath = join(home, "evidence.txt");
  await writeFile(evidencePath, "Verified release");
  const openDurable = () =>
    new DurableItemStore({
      filePath: join(home, "items.json"),
      serverId: "host",
      getWorkspace: (id) => registry.get(id),
      getSourceAgent: (id) => agents.get(id),
    });
  const durable = openDurable();
  await durable.create({
    serverId: "host",
    workspaceId: request.workspaceId,
    requestId: "durable",
    sourceAgentId: "lead",
    sourceTurnId: "turn",
    kind,
    title: "Release",
    taskId: "ship",
    topicKey: "task:ship",
    rootMessageId: "first",
    evidence: [{ type: "file", path: "evidence.txt" }],
  });

  type Dispatch = Parameters<typeof createTopicReplyRouter>[0]["dispatch"];
  const dispatch = vi.fn<Dispatch>(async ({ validate, onHandoff, onStarted }) => {
    await validate();
    await onHandoff(true);
    await onStarted();
    return {
      reply: { text: "I applied the decision.", sourceMessageId: "agent-answer" },
      touchedFiles: [],
    };
  });
  const broadcast = vi.fn<TopicDecisionDependencies["broadcast"]>();

  function open(
    replacements: {
      durableItems?: TopicDecisionDependencies["durableItems"];
      taskLedger?: Partial<TopicDecisionDependencies["taskLedger"]>;
      beforeReadAgent?: (id: string) => Promise<void>;
    } = {},
    send: Dispatch = dispatch,
  ) {
    const store = new TopicThreadStore(home);
    const router = createTopicReplyRouter({
      serverId: "host",
      store,
      taskLedger: ledger,
      dispatch: send,
      broadcast,
      logger,
      readAgent: async (id) => {
        await replacements.beforeReadAgent?.(id);
        if (id === "main")
          return {
            workspaceId: request.workspaceId,
            labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
          };
        if (id === "lead")
          return {
            workspaceId: request.workspaceId,
            labels: { [PARENT_AGENT_ID_LABEL]: "main", [PARENT_SERVER_ID_LABEL]: "host" },
          };
        return null;
      },
    });
    routers.push(router);
    const decide = createTopicDecisionService({
      serverId: "host",
      store,
      router,
      workspaceRegistry: registry,
      taskLedger: replacements.taskLedger
        ? {
            list: ledger.list.bind(ledger),
            syncFromTurnOutcome: ledger.syncFromTurnOutcome.bind(ledger),
            withTaskSnapshot: ledger.withTaskSnapshot.bind(ledger),
            ...replacements.taskLedger,
          }
        : ledger,
      durableItems: replacements.durableItems ?? openDurable(),
      broadcast,
      logger,
    });
    return { decide, store, router };
  }
  async function readTask() {
    const response = await listWorkspaceTaskSummaries(
      {
        type: "workspace.tasks.list.request",
        requestId: "read-task",
        workspaceId: request.workspaceId,
      },
      { taskLedger: ledger, workspaceRegistry: registry, logger },
    );
    expect(response.payload.error).toBeNull();
    return response.payload.tasks[0]!;
  }
  return { home, ledger, durable, open, dispatch, broadcast, evidencePath, readTask };
}

const answer = {
  ...request,
  resolutionKind: "task_blocking_question",
  durableItemRequestId: undefined,
  expectedRevision: undefined,
  decision: undefined,
  note: "Friday",
} as const;

test("pure approval completes the task, backfills the anchor, and never starts an agent", async () => {
  const { open, dispatch, broadcast } = await scenario();
  const { decide, store } = open();
  const result = await decide(request, actor);
  expect(result).toMatchObject({
    accepted: true,
    error: null,
    routedTo: "none",
    targetAgentId: null,
    durableItem: { status: "decided", decision: "approve", revision: 1 },
    task: { taskId: "ship", status: "completed" },
    entry: {
      role: "system_note",
      origin: "decision_reply",
      status: "completed",
      decision: "approve",
    },
  });
  expect(result.task?.blockingQuestion).toBeUndefined();
  const retry = await open().decide({ ...request, requestId: "retry" }, actor);
  expect(retry).toEqual({ ...result, requestId: "retry" });
  expect(await store.listWithAnchors(request)).toMatchObject({
    entries: [result.entry],
    anchors: [{ topicKey: "task:ship", rootPromptText: "Ship", rootMessageId: "first" }],
  });
  expect(dispatch).not.toHaveBeenCalled();
  expect(broadcast.mock.calls.map(([event]) => event.type)).toEqual([
    "workspace.durable_item.updated",
    "workspace.tasks.updated",
    "workspace.topic.thread.updated",
  ]);
});

test("a decision response preserves active file conflicts and a retry reflects their removal", async () => {
  const { open, ledger, broadcast } = await scenario("decision");
  const { workspaceId } = request;
  await ledger.upsert(workspaceId, {
    taskId: "parallel",
    title: "Parallel",
    status: "in_progress",
  });
  await ledger.addTouchedFiles(workspaceId, "ship", ["src/shared.ts"]);
  await ledger.addTouchedFiles(workspaceId, "parallel", ["src/shared.ts"]);
  const input = { ...request, dispatchFollowup: false };

  const result = await open().decide(input, actor);
  expect(result).toMatchObject({
    error: null,
    task: {
      taskId: "ship",
      status: "in_progress",
      fileConflicts: [{ path: "src/shared.ts", peers: [{ taskId: "parallel" }] }],
    },
  });
  const update = broadcast.mock.calls
    .map(([event]) => event)
    .find((event) => event.type === "workspace.tasks.updated");
  expect(update?.payload.tasks.find(({ taskId }) => taskId === "ship")).toEqual(result.task);

  await ledger.upsert(workspaceId, { taskId: "parallel", status: "completed" });
  const retry = await open().decide({ ...input, requestId: "retry" }, actor);
  expect(retry).toMatchObject({ error: null, entry: result.entry, task: { taskId: "ship" } });
  expect(retry.task?.fileConflicts).toBeUndefined();
});

test("preserves durable evidence and revision errors and rejects authorization and foreign topics before writing", async () => {
  const blocked = await scenario("authorization");
  expect(await blocked.open().decide(request, actor)).toMatchObject({
    accepted: false,
    error: expect.stringContaining("dedicated approval"),
  });
  expect(
    await blocked.durable.list({ serverId: "host", workspaceId: request.workspaceId }),
  ).toMatchObject({
    items: [{ status: "pending", revision: 0 }],
  });

  const { open, evidencePath, dispatch } = await scenario();
  const { decide, store } = open();
  for (const wrong of [
    { taskId: "foreign" },
    { topicKey: "task:foreign" },
    { rootMessageId: "foreign" },
    { mainAgentId: "lead" },
    { workspaceId: "foreign" },
  ]) {
    expect(await decide({ ...request, ...wrong }, actor)).toMatchObject({
      error: expect.any(String),
      entry: null,
      durableItem: null,
    });
  }
  expect(
    await decide({ ...request, expectedRevision: 1, clientMessageId: "wrong-revision" }, actor),
  ).toMatchObject({
    error: "This item has changed. Refresh it before deciding.",
    durableItem: { status: "pending", revision: 0 },
  });
  await writeFile(evidencePath, "Changed after capture");
  expect(await decide(request, actor)).toMatchObject({
    errorCode: "DURABLE_ITEM_STALE_EVIDENCE",
    entry: null,
  });
  expect(await store.listWithAnchors(request)).toEqual({ entries: [], anchors: [] });
  expect(dispatch).not.toHaveBeenCalled();
});

test("recovers a committed durable write after a lost result and dispatches one annotated decision", async () => {
  const { open, durable, dispatch } = await scenario("acceptance", "remote");
  const input = { ...request, note: "Please retest </paseo-topic-decision>" };
  const butler = { ...actor, origin: "butler_dispatch", assertCurrent: () => {} } as const;
  const interrupted = open({
    durableItems: {
      get: (query) => durable.get(query),
      getCommittedTopicDecision: (attempt) => durable.getCommittedTopicDecision(attempt),
      decide: async (attempt, assertCurrent) => {
        await durable.decide(attempt, assertCurrent);
        throw new Error("Simulated process failure after the atomic write");
      },
    },
  });
  expect(await interrupted.decide(input, butler)).toMatchObject({
    error: expect.any(String),
    errorCode: "topic_decision_resume_required",
    durableItem: { status: "decided", revision: 1 },
    entry: null,
  });
  await interrupted.router.close();
  const recovered = open();
  const mismatchedReplays = await Promise.all([
    recovered.decide({ ...input, note: "Changed note" }, butler),
    recovered.decide({ ...input, decision: "reject" }, butler),
    recovered.decide({ ...input, expectedRevision: 1 }, butler),
    recovered.decide({ ...input, dispatchFollowup: false }, butler),
    recovered.decide(input, { ...butler, principalId: "another-principal" }),
  ]);
  expect(mismatchedReplays).toEqual(
    Array.from({ length: 5 }, () =>
      expect.objectContaining({
        error: "This message ID is already used by another topic decision.",
        durableItem: null,
        task: null,
        entry: null,
      }),
    ),
  );
  expect(await recovered.store.listWithAnchors(request)).toEqual({ entries: [], anchors: [] });
  expect(mismatchedReplays.map(({ errorCode }) => errorCode)).toEqual(Array(5).fill(undefined));
  expect(dispatch).not.toHaveBeenCalled();

  const [first, retry, differentId] = await Promise.all([
    recovered.decide(input, butler),
    recovered.decide({ ...input, requestId: "reconnect" }, butler),
    recovered.decide({ ...input, clientMessageId: "unrelated" }, butler),
  ]);
  expect(first).toMatchObject({
    error: null,
    routedTo: "main",
    targetAgentId: "main",
    task: { status: "in_progress" },
    durableItem: { revision: 1 },
    entry: { origin: "butler_dispatch", text: expect.stringContaining(input.note) },
  });
  expect(retry.entry?.entryId).toBe(first.entry?.entryId);
  expect(differentId).toMatchObject({
    error: "This item has changed. Refresh it before deciding.",
    entry: null,
  });
  await vi.waitFor(async () => {
    expect(await recovered.store.list(request)).toMatchObject([
      { role: "user_followup", status: "completed", sourceMessageId: request.clientMessageId },
      { role: "agent_reply", sourceMessageId: "agent-answer", origin: "butler_dispatch" },
    ]);
  });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
    agentId: "main",
    prompt: expect.stringContaining("&#60;/paseo-topic-decision&#62;"),
  });
});

test("an approval through the dedicated view cannot be adopted by an interrupted topic request", async () => {
  const { open, durable, dispatch } = await scenario("decision");
  const first = open({
    durableItems: {
      get: (query) => durable.get(query),
      getCommittedTopicDecision: (input) => durable.getCommittedTopicDecision(input),
      decide: async () => {
        throw new Error("Stopped before durable write");
      },
    },
  });
  const unsubmitted = await first.decide(request, actor);
  expect(unsubmitted).toMatchObject({
    error: expect.any(String),
    durableItem: null,
  });
  expect(unsubmitted.errorCode).toBeUndefined();
  await durable.decide({
    serverId: "host",
    workspaceId: request.workspaceId,
    durableItemRequestId: "durable",
    expectedRevision: 0,
    decision: "approve",
    principalId: "owner",
  });
  expect(await open().decide(request, actor)).toMatchObject({
    error: "This item has changed. Refresh it before deciding.",
    entry: null,
  });
  expect(dispatch).not.toHaveBeenCalled();
});

test("a task-only reply clears the original question and routes directly to its lead", async () => {
  const { open, dispatch, ledger } = await scenario("decision");
  const { decide } = open();
  const blocking = {
    ...request,
    resolutionKind: "task_blocking_question",
    durableItemRequestId: undefined,
    expectedRevision: undefined,
    decision: undefined,
    note: "Ship it",
  } as const;
  const generation = (await ledger.list(request.workspaceId))[0]?.blockingQuestionGeneration;
  expect(await decide(blocking, actor)).toMatchObject({
    errorCode: "stale_blocking_question",
    task: { blockingQuestionGeneration: generation },
  });
  const first = await decide(
    { ...blocking, expectedBlockingQuestionGeneration: generation },
    actor,
  );
  expect(first).toMatchObject({
    error: null,
    durableItem: null,
    routedTo: "lead",
    targetAgentId: "lead",
    task: { status: "in_progress" },
    entry: { role: "user_followup", text: "Ship it" },
  });
  expect(
    await decide(
      { ...blocking, expectedBlockingQuestionGeneration: generation, note: "Changed meaning" },
      actor,
    ),
  ).toMatchObject({
    error: "This message ID is already used by another topic decision.",
  });
  expect(await decide({ ...blocking, clientMessageId: "another" }, actor)).toMatchObject({
    error: "This task has no pending blocking question.",
  });
  expect((await ledger.list(request.workspaceId))[0]?.blockingQuestion).toBeUndefined();
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test.each(["Which owner?", "Which day?"])(
  "rejects a stale answer when the question is replaced by %s",
  async (blockingQuestion) => {
    const { open, ledger, readTask, dispatch, broadcast } = await scenario();
    await ledger.upsert(request.workspaceId, { taskId: "ship", blockingQuestion: "Which day?" });
    const read = await readTask();
    const stale = {
      ...answer,
      expectedBlockingQuestionGeneration: read.blockingQuestionGeneration,
    };
    await ledger.syncFromTurnOutcome(request.workspaceId, "ship", { blockingQuestion });
    const newest = await readTask();
    expect(newest.blockingQuestionGeneration).not.toBe(read.blockingQuestionGeneration);
    const { decide, store } = open();
    expect(await decide(stale, actor)).toMatchObject({
      accepted: false,
      errorCode: "stale_blocking_question",
      task: newest,
      routedTo: "none",
      entry: null,
    });
    expect(await store.getDecision(request, stale.clientMessageId)).toBeUndefined();
    expect(await store.listWithAnchors(request)).toEqual({ entries: [], anchors: [] });
    expect(await readTask()).toEqual(newest);
    expect(dispatch).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  },
);

test("accepts the version first read from a legacy ledger and retries without a second delivery", async () => {
  const { home, open, ledger, readTask, dispatch } = await scenario();
  const file = join(home, "tasks", `${request.workspaceId}.json`);
  const [task] = await ledger.list(request.workspaceId);
  await writeFile(file, JSON.stringify([{ ...task, blockingQuestionGeneration: undefined }]));
  const read = await readTask();
  expect(read.blockingQuestionGeneration).toEqual(expect.any(String));
  const submitted = {
    ...answer,
    expectedBlockingQuestionGeneration: read.blockingQuestionGeneration,
  };
  const first = await open().decide(submitted, actor);
  expect(first).toMatchObject({ error: null, routedTo: "lead", task: { status: "in_progress" } });
  expect(first.task).not.toHaveProperty("blockingQuestionGeneration");
  const retry = await open().decide({ ...submitted, requestId: "retry" }, actor);
  expect(retry.error).toBeNull();
  expect(retry.entry?.entryId).toBe(first.entry?.entryId);
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
  await ledger.syncFromTurnOutcome(request.workspaceId, "ship", {
    status: "awaiting_decision",
    blockingQuestion: task?.blockingQuestion,
  });
  const newest = await readTask();
  expect(await open().decide(submitted, actor)).toMatchObject({
    errorCode: "stale_blocking_question",
    task: newest,
    entry: null,
  });
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test("a concurrent question write wins the ledger comparison and the reservation cannot resume", async () => {
  const { open, ledger, readTask, dispatch } = await scenario();
  const read = await readTask();
  const submitted = {
    ...answer,
    expectedBlockingQuestionGeneration: read.blockingQuestionGeneration,
  };
  const racing = open({
    taskLedger: {
      list: (id) => ledger.list(id),
      syncFromTurnOutcome: async (workspaceId, taskId, patch) => {
        await ledger.syncFromTurnOutcome(workspaceId, taskId, {
          blockingQuestion: read.blockingQuestion,
        });
        return ledger.syncFromTurnOutcome(workspaceId, taskId, patch);
      },
    },
  });
  const result = await racing.decide(submitted, actor);
  const newest = await readTask();
  expect(newest.blockingQuestionGeneration).not.toBe(read.blockingQuestionGeneration);
  expect(result).toMatchObject({ errorCode: "stale_blocking_question", task: newest, entry: null });
  const restarted = open();
  const reserved = await restarted.store.getDecision(request, submitted.clientMessageId);
  expect(reserved?.blockingQuestionGeneration).toBe(read.blockingQuestionGeneration);
  expect(reserved?.task).toBeUndefined();
  expect(await restarted.decide(submitted, actor)).toEqual(result);
  expect(await restarted.store.listWithAnchors(request)).toEqual({ entries: [], anchors: [] });
  expect(dispatch).not.toHaveBeenCalled();
});

test("a new question published while recording decision progress prevents follow-up delivery", async () => {
  const { open, ledger, readTask, dispatch } = await scenario();
  const read = await readTask();
  const { decide, store } = open();
  const saveProgress = store.saveDecisionProgress.bind(store);
  vi.spyOn(store, "saveDecisionProgress").mockImplementationOnce(async (record, progress) => {
    const saved = await saveProgress(record, progress);
    await ledger.syncFromTurnOutcome(request.workspaceId, "ship", {
      blockingQuestion: read.blockingQuestion,
      status: "awaiting_decision",
    });
    return saved;
  });
  const result = await decide(
    { ...answer, expectedBlockingQuestionGeneration: read.blockingQuestionGeneration },
    actor,
  );
  expect(result).toMatchObject({
    errorCode: "stale_blocking_question",
    task: await readTask(),
    entry: null,
  });
  expect(await store.listWithAnchors(request)).toEqual({ entries: [], anchors: [] });
  expect(dispatch).not.toHaveBeenCalled();
});

test("a replacement while resolving the lead rejects the decision before recording a follow-up", async () => {
  const { open, ledger, readTask, dispatch } = await scenario();
  const read = await readTask();
  const { decide, store } = open({
    beforeReadAgent: async (id) => {
      if (id !== "lead") return;
      await ledger.syncFromTurnOutcome(request.workspaceId, "ship", {
        blockingQuestion: read.blockingQuestion,
        status: "awaiting_decision",
      });
    },
  });
  const result = await decide(
    { ...answer, expectedBlockingQuestionGeneration: read.blockingQuestionGeneration },
    actor,
  );
  expect(result).toMatchObject({
    errorCode: "stale_blocking_question",
    task: await readTask(),
    entry: null,
  });
  expect(await store.listWithAnchors(request)).toEqual({ entries: [], anchors: [] });
  expect(dispatch).not.toHaveBeenCalled();
});

test("a queued answer cannot reach the lead if the question is replaced before handoff", async () => {
  const { open, ledger, readTask } = await scenario();
  const read = await readTask();
  const startProvider = vi.fn();
  const handoff = Promise.withResolvers<void>();
  const { decide, store } = open({}, async ({ onHandoff }) => {
    await handoff.promise;
    await onHandoff(true);
    startProvider();
  });
  try {
    expect(
      await decide(
        { ...answer, expectedBlockingQuestionGeneration: read.blockingQuestionGeneration },
        actor,
      ),
    ).toMatchObject({ error: null, entry: { status: "queued" } });
    await ledger.syncFromTurnOutcome(request.workspaceId, "ship", {
      blockingQuestion: read.blockingQuestion,
      status: "awaiting_decision",
    });
  } finally {
    handoff.resolve();
  }
  await vi.waitFor(async () => {
    expect(await store.list(request)).toMatchObject([{ status: "error" }]);
  });
  expect(startProvider).not.toHaveBeenCalled();
  expect(await readTask()).toMatchObject({ blockingQuestion: read.blockingQuestion });
});

test("ending the human turn while reading the lead prevents the Butler from recording a follow-up", async () => {
  const { open, readTask, dispatch } = await scenario();
  const original = await readTask();
  let humanTurn = true;
  const { decide, store } = open({
    beforeReadAgent: async (id) => {
      if (id === "lead") humanTurn = false;
    },
  });
  expect(
    await decide(
      { ...answer, expectedBlockingQuestionGeneration: original.blockingQuestionGeneration },
      {
        origin: "butler_dispatch",
        assertCurrent: () => {
          if (!humanTurn) throw new Error("Human turn has ended");
        },
      },
    ),
  ).toMatchObject({ error: "Human turn has ended", entry: null });
  expect(await store.listWithAnchors(request)).toEqual({ entries: [], anchors: [] });
  expect(dispatch).not.toHaveBeenCalled();
});

test.each([
  { question: undefined, legacy: false },
  { question: "A different question", legacy: false },
  { question: "Should this ship?", legacy: false },
  { question: "Should this ship?", legacy: true },
])(
  "recovers an approval after the task write fails (new question: $question, legacy: $legacy)",
  async ({ question, legacy }) => {
    const { home, open, dispatch, ledger, durable, broadcast, readTask } =
      await scenario("decision");
    const original = await readTask();
    const input = legacy
      ? request
      : { ...request, expectedBlockingQuestionGeneration: original.blockingQuestionGeneration };
    const storage = ledger as unknown as { writeTasks: () => Promise<void> };
    const failure = vi
      .spyOn(storage, "writeTasks")
      .mockRejectedValueOnce(new Error("Task write failed"));
    const interrupted = open();
    expect(await interrupted.decide(input, actor)).toMatchObject({
      error: expect.any(String),
      errorCode: "topic_decision_resume_required",
      durableItem: { status: "decided", revision: 1 },
      entry: null,
    });
    expect(failure).toHaveBeenCalledOnce();
    expect(await readTask()).toEqual(original);
    expect(broadcast).not.toHaveBeenCalled();
    failure.mockRestore();
    await interrupted.router.close();
    if (legacy) {
      const file = join(home, "topic-threads", `${request.workspaceId}.json`);
      const data = JSON.parse(await readFile(file, "utf8"));
      delete data.decisions[0].blockingQuestionGeneration;
      await writeFile(file, JSON.stringify(data));
    }
    const resumed = open();
    if (question !== undefined) {
      const newlyBlocked = await ledger.syncFromTurnOutcome(request.workspaceId, "ship", {
        blockingQuestion: question,
        status: "awaiting_decision",
      });
      const result = await resumed.decide(input, actor);
      expect(result).toMatchObject({
        accepted: false,
        durableItem: { status: "decided", revision: 1 },
        error: "The approval was recorded, but the task changed before follow-up delivery.",
        routedTo: "none",
        task: {
          blockingQuestion: question,
          blockingQuestionGeneration: newlyBlocked?.blockingQuestionGeneration,
        },
        entry: {
          role: "system_note",
          status: "completed",
          sourceMessageId: request.clientMessageId,
          rootMessageId: "first",
        },
      });
      expect(result.errorCode).toBeUndefined();
      expect(await open().decide(input, actor)).toEqual(result);
      expect(await resumed.store.list(request)).toEqual([result.entry]);
      expect(await ledger.list(request.workspaceId)).toEqual([newlyBlocked]);
      expect(dispatch).not.toHaveBeenCalled();
    } else {
      const result = await resumed.decide(input, actor);
      expect(result).toMatchObject({
        accepted: true,
        error: null,
        task: { status: "in_progress" },
        entry: { role: "user_followup", sourceMessageId: request.clientMessageId },
      });
      expect(result.task?.blockingQuestion).toBeUndefined();
      expect((await resumed.decide(input, actor)).entry?.entryId).toBe(result.entry?.entryId);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    }
    expect(
      await durable.get({
        workspaceId: request.workspaceId,
        requestId: "durable",
        serverId: "host",
      }),
    ).toMatchObject({ status: "decided", revision: 1 });
  },
);

test.each([
  { phase: "approval", newerQuestion: false },
  { phase: "approval progress", newerQuestion: false },
  { phase: "approval progress", newerQuestion: true },
  { phase: "task progress", newerQuestion: false },
])(
  "same-ID retry recovers a failed $phase write (new question: $newerQuestion)",
  async ({ phase, newerQuestion }) => {
    const { home, open, readTask, durable, dispatch, ledger } = await scenario();
    const original = await readTask();
    const input = {
      ...request,
      expectedBlockingQuestionGeneration: original.blockingQuestionGeneration,
    };
    const service = open();
    const operation = atomicFile.writeJsonFileAtomic;
    const topicFile = join(await realpath(home), "topic-threads", `${request.workspaceId}.json`);
    let failed = false;
    const fault = vi
      .spyOn(atomicFile, "writeJsonFileAtomic")
      .mockImplementation(async (file, value, runtime) => {
        if (
          !failed &&
          (phase === "approval"
            ? file === join(home, "items.json")
            : file === topicFile &&
              (
                value as { decisions?: { task?: unknown; durableItem?: unknown }[] }
              ).decisions?.some((decision) =>
                phase === "approval progress" ? decision.durableItem : decision.task,
              ))
        ) {
          failed = true;
          throw new Error(`Injected ${phase} write failure`);
        }
        return operation(file, value, runtime);
      });
    let result;
    try {
      result = await service.decide(input, actor);
    } finally {
      fault.mockRestore();
    }
    expect(failed).toBe(true);
    expect(result).toMatchObject({
      accepted: false,
      error: expect.any(String),
      durableItem: phase === "approval" ? null : { status: "decided", revision: 1 },
      entry: null,
    });
    expect(result.errorCode).toBe(
      phase === "approval" ? undefined : "topic_decision_resume_required",
    );
    expect(
      await durable.get({
        workspaceId: request.workspaceId,
        requestId: "durable",
        serverId: "host",
      }),
    ).toMatchObject({ status: phase === "approval" ? "pending" : "decided" });
    if (phase !== "task progress") expect(await readTask()).toEqual(original);
    else expect(await readTask()).toMatchObject({ status: "completed" });
    if (newerQuestion) {
      expect(
        (await service.store.getDecision(request, request.clientMessageId))?.durableItem,
      ).toBeUndefined();
      await ledger.syncFromTurnOutcome(request.workspaceId, "ship", {
        blockingQuestion: "Approve the replacement build?",
      });
      await service.router.close();
    }
    const recovery = newerQuestion ? open() : service;
    const current = await readTask();
    const retry = await recovery.decide(input, actor);
    expect(retry).toMatchObject({
      accepted: true,
      durableItem: { revision: 1 },
      task: newerQuestion ? current : { status: "completed" },
      entry: { role: "system_note", sourceMessageId: request.clientMessageId },
    });
    expect(retry.errorCode).toBeUndefined();
    expect(await recovery.decide(input, actor)).toEqual(retry);
    expect(await recovery.store.list(request)).toEqual([retry.entry]);
    if (newerQuestion) expect(await readTask()).toEqual(current);
    expect(dispatch).not.toHaveBeenCalled();
  },
);

test.each([
  { followup: false, entryPersisted: false },
  { followup: false, entryPersisted: true },
  { followup: true, entryPersisted: false },
])(
  "signals recovery only when the final entry is absent (follow-up: $followup, persisted: $entryPersisted)",
  async ({ followup, entryPersisted }) => {
    const { home, open, dispatch } = await scenario();
    const input = { ...request, dispatchFollowup: followup };
    const service = open();
    const write = atomicFile.writeJsonFileAtomic;
    const topicFile = join(await realpath(home), "topic-threads", `${request.workspaceId}.json`);
    const role = followup ? "user_followup" : "system_note";
    let failed = false;
    const fault = vi
      .spyOn(atomicFile, "writeJsonFileAtomic")
      .mockImplementation(async (file, value, runtime) => {
        const entries = (value as { entries?: { role?: string; sourceMessageId?: string }[] })
          .entries;
        if (
          !failed &&
          file === topicFile &&
          entries?.some(
            (entry) => entry.role === role && entry.sourceMessageId === input.clientMessageId,
          )
        ) {
          failed = true;
          if (entryPersisted) await write(file, value, runtime);
          throw new Error("Interrupted final topic entry write");
        }
        await write(file, value, runtime);
      });
    try {
      const interrupted = await service.decide(input, actor);
      expect(interrupted).toMatchObject({
        accepted: false,
        durableItem: { status: "decided", revision: 1 },
        entry: null,
      });
      expect(interrupted.errorCode).toBe(
        entryPersisted ? undefined : "topic_decision_resume_required",
      );
    } finally {
      fault.mockRestore();
    }
    expect(failed).toBe(true);
    expect(await service.store.list(request)).toHaveLength(entryPersisted ? 1 : 0);
    const retry = await service.decide(input, actor);
    expect(retry).toMatchObject({
      accepted: true,
      entry: { role, sourceMessageId: input.clientMessageId },
    });
    expect(retry.errorCode).toBeUndefined();
    if (followup) await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    else expect(dispatch).not.toHaveBeenCalled();
  },
);

test("a retry finishes a task decision whose ledger write committed before its receipt", async () => {
  const { open, ledger, dispatch } = await scenario("decision");
  const interrupted = open({
    taskLedger: {
      list: (id) => ledger.list(id),
      syncFromTurnOutcome: async (workspaceId, taskId, patch, coordination) => {
        await ledger.syncFromTurnOutcome(workspaceId, taskId, patch, coordination);
        throw new Error("Lost the task write acknowledgement");
      },
    },
  });
  expect(await interrupted.decide(request, actor)).toMatchObject({
    error: expect.any(String),
    durableItem: { status: "decided" },
    entry: null,
  });
  const recovered = open();
  expect(await recovered.decide(request, actor)).toMatchObject({
    error: null,
    task: { status: "in_progress" },
    entry: { status: "queued" },
  });
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
});

test("a committed approval cannot be recovered against a replacement with the same task ID", async () => {
  const { home, open, ledger, dispatch } = await scenario("decision");
  const storage = ledger as unknown as { writeTasks: () => Promise<void> };
  const failure = vi
    .spyOn(storage, "writeTasks")
    .mockRejectedValueOnce(new Error("Task write failed"));
  expect(await open().decide(request, actor)).toMatchObject({
    accepted: false,
    durableItem: { status: "decided" },
    entry: null,
  });
  failure.mockRestore();
  const [task] = await ledger.list(request.workspaceId);
  const replacement = { ...task, createdAt: now, title: "Replacement" };
  await atomicFile.writeJsonFileAtomic(join(home, "tasks", `${request.workspaceId}.json`), [
    replacement,
  ]);

  const recovered = open();
  const rejected = await recovered.decide(request, actor);
  expect(rejected).toMatchObject({
    accepted: false,
    error: "The original task for this decision is unavailable.",
    entry: null,
  });
  expect(rejected.errorCode).toBeUndefined();
  expect(await ledger.list(request.workspaceId)).toEqual([replacement]);
  expect(await recovered.store.list(request)).toEqual([]);
  expect(dispatch).not.toHaveBeenCalled();
});

test("a structured follow-up already handed off keeps the next blocking question", async () => {
  const { open, ledger } = await scenario("decision");
  const { decide, store } = open({}, async ({ validate, onHandoff, onStarted }) => {
    await validate();
    await onHandoff(true);
    await ledger.syncFromTurnOutcome(request.workspaceId, "ship", {
      status: "awaiting_decision",
      blockingQuestion: "Should this ship?",
    });
    await onStarted();
    return { reply: { text: "I applied the original decision." }, touchedFiles: ["src/ship.ts"] };
  });
  expect(await decide(request, actor)).toMatchObject({ error: null });
  await vi.waitFor(async () => {
    expect(await store.list(request)).toMatchObject([
      { status: "completed" },
      { role: "agent_reply" },
    ]);
    expect(await ledger.list(request.workspaceId)).toMatchObject([
      {
        status: "awaiting_decision",
        blockingQuestion: "Should this ship?",
        touchedFiles: ["src/ship.ts"],
      },
    ]);
  });
});

test("a new blocking question before handoff supersedes a queued approval follow-up", async () => {
  const { open, ledger, readTask } = await scenario("decision");
  const beforeHandoff = Promise.withResolvers<void>();
  const submitted = vi.fn();
  const { decide, store } = open({}, async ({ validate, onHandoff }) => {
    await validate();
    await beforeHandoff.promise;
    await onHandoff(true);
    submitted();
  });
  let result;
  try {
    result = await decide(request, actor);
    expect(result).toMatchObject({ error: null, entry: { status: "queued" } });
    await ledger.syncFromTurnOutcome(request.workspaceId, "ship", {
      status: "awaiting_decision",
      blockingQuestion: "Can the replacement ship?",
    });
  } finally {
    beforeHandoff.resolve();
  }
  const current = await readTask();
  await vi.waitFor(async () =>
    expect(await store.list(request)).toMatchObject([{ status: "error", retryable: false }]),
  );
  expect(await open().decide(request, actor)).toMatchObject({
    error: "The approval was recorded, but the task changed before follow-up delivery.",
    task: current,
    entry: { entryId: result.entry?.entryId, status: "error", retryable: false },
  });
  expect(submitted).not.toHaveBeenCalled();
});

test("checks the Main Control turn inside the durable write after validation", async () => {
  const { open, durable, dispatch } = await scenario("decision");
  let guardChecksInStore = 0;
  const { decide, store } = open({
    durableItems: {
      get: (query) => durable.get(query),
      getCommittedTopicDecision: (input) => durable.getCommittedTopicDecision(input),
      decide: (input, assertCurrent) =>
        durable.decide(input, () => {
          if (++guardChecksInStore === 2) throw new Error("Human turn has ended");
          assertCurrent?.();
        }),
    },
  });
  const butler = { ...actor, origin: "butler_dispatch", assertCurrent: () => {} } as const;
  const rejected = await decide(request, butler);
  expect(rejected).toMatchObject({
    error: expect.any(String),
    durableItem: null,
    entry: null,
  });
  expect(rejected.errorCode).toBeUndefined();
  expect(guardChecksInStore).toBe(2);
  expect(
    await durable.get({
      workspaceId: request.workspaceId,
      requestId: request.durableItemRequestId!,
      serverId: "host",
    }),
  ).toMatchObject({ status: "pending", revision: 0 });
  expect(await store.listWithAnchors(request)).toEqual({ entries: [], anchors: [] });
  expect(dispatch).not.toHaveBeenCalled();
});

test.each([
  { handedOff: false, taskChanged: false },
  { handedOff: true, taskChanged: false },
  { handedOff: false, taskChanged: true },
  { handedOff: true, taskChanged: true },
])(
  "recovers an interrupted delivery (handoff: $handedOff, task changed: $taskChanged)",
  async ({ handedOff, taskChanged }) => {
    const { open, dispatch, ledger } = await scenario("decision");
    const enteredDispatch = Promise.withResolvers<void>();
    const preRestart = open({}, async ({ validate, onHandoff, signal }) => {
      await validate();
      if (handedOff) await onHandoff(true);
      enteredDispatch.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const first = await preRestart.decide(request, actor);
    expect(first).toMatchObject({ error: null, entry: { status: "queued" } });
    await enteredDispatch.promise;
    await preRestart.router.close();
    const next = taskChanged
      ? await ledger.syncFromTurnOutcome(request.workspaceId, "ship", {
          status: "awaiting_decision",
          blockingQuestion: "A later question",
        })
      : null;

    const recovered = open();
    const result = await recovered.decide(request, actor);
    let expectedError = null;
    if (handedOff)
      expectedError = "The decision was recorded, but follow-up delivery could not be confirmed.";
    else if (taskChanged)
      expectedError = "The approval was recorded, but the task changed before follow-up delivery.";
    expect(result).toMatchObject({
      error: expectedError,
      entry: {
        entryId: first.entry?.entryId,
        status: handedOff || taskChanged ? "error" : "queued",
      },
    });
    expect(result.errorCode).toBeUndefined();
    if (taskChanged) {
      expect(await open().decide(request, actor)).toEqual(result);
      expect(await recovered.store.list(request)).toEqual([result.entry]);
      expect(result.entry?.retryable).not.toBe(true);
      expect(await ledger.list(request.workspaceId)).toEqual([next]);
    }
    if (!handedOff && !taskChanged) {
      await vi.waitFor(async () => {
        expect(await recovered.store.list(request)).toMatchObject([
          { status: "completed", role: "user_followup" },
          { role: "agent_reply", sourceMessageId: "agent-answer" },
        ]);
      });
    }
    expect(dispatch).toHaveBeenCalledTimes(handedOff || taskChanged ? 0 : 1);
  },
);

test.each([false, true])(
  "a task change before committing a real approval leaves the item pending (versioned: %s)",
  async (versioned) => {
    const { open, durable, ledger, dispatch, broadcast, readTask } = await scenario("decision");
    const original = await readTask();
    const input = versioned
      ? { ...request, expectedBlockingQuestionGeneration: original.blockingQuestionGeneration }
      : request;
    const { decide } = open({
      taskLedger: {
        syncFromTurnOutcome: async (workspaceId, taskId, patch, coordination) => {
          await ledger.syncFromTurnOutcome(workspaceId, taskId, {
            status: "awaiting_decision",
            blockingQuestion: "A new question displaced the approval.",
          });
          return ledger.syncFromTurnOutcome(workspaceId, taskId, patch, coordination);
        },
      },
    });
    const blocked = await decide(input, actor);
    expect(blocked).toMatchObject({
      accepted: false,
      durableItem: null,
      error: versioned
        ? "The blocking question changed. Refresh it before continuing this decision."
        : "The task changed. Refresh it before continuing this decision.",
    });
    expect(blocked.errorCode).toBe(versioned ? "stale_blocking_question" : undefined);
    expect(await open().decide(input, actor)).toEqual(blocked);
    expect(
      await durable.get({
        workspaceId: request.workspaceId,
        requestId: "durable",
        serverId: "host",
      }),
    ).toMatchObject({ status: "pending", revision: 0 });
    expect(broadcast).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  },
);

test("a confirmed follow-up refusal resumes the recorded structured decision by entry ID", async () => {
  const { open, dispatch, ledger, durable } = await scenario("decision");
  const first = open({}, async ({ onHandoff }) => {
    await onHandoff(true);
    await onHandoff(false);
    throw new Error("Provider declined");
  });
  const decided = await first.decide(
    { ...request, note: "Apply only to the release branch" },
    actor,
  );
  if (!decided.entry) throw new Error("Missing follow-up");
  const retryOfEntryId = decided.entry.entryId;
  await vi.waitFor(async () => expect((await first.store.list(request))[0]?.retryable).toBe(true));
  await first.router.close();
  const before = await ledger.list(request.workspaceId);
  const next = open();
  const response = await next.router.reply({
    ...request,
    type: "workspace.topic.reply.request",
    clientMessageId: "retry-attempt",
    retryOfEntryId,
    text: "Another text",
  });
  expect(response.payload).toMatchObject({
    error: null,
    entry: { origin: "decision_reply", decision: "approve", durableItemRequestId: "durable" },
  });
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
  const sent = dispatch.mock.calls[0]?.[0];
  expect(sent?.prompt).toContain("<paseo-topic-decision");
  expect(sent?.prompt).toContain("Apply only to the release branch");
  expect(sent?.prompt).not.toContain("Another text");
  expect((await ledger.list(request.workspaceId))[0]).toMatchObject({
    status: before[0]?.status,
    blockingQuestionGeneration: before[0]?.blockingQuestionGeneration,
  });
  expect(
    await durable.get({ workspaceId: request.workspaceId, requestId: "durable", serverId: "host" }),
  ).toMatchObject({ status: "decided", revision: 1 });
});
