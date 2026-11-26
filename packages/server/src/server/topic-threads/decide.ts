import {
  WorkspaceTopicDecideRequestSchema,
  type WorkspaceDurableItem,
  type WorkspaceTasksUpdatedMessage,
  type WorkspaceDurableItemUpdatedMessage,
  type WorkspaceTopicDecideRequest,
  type WorkspaceTopicDecideResponse,
  type WorkspaceTopicThreadUpdatedMessage,
} from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import type { WorkspaceTask, WorkspaceTaskLedgerStore } from "../agent/task-ledger/index.js";
import { DurableItemEvidenceError } from "../durable-items/evidence.js";
import { DurableItemConflictError, type DurableItemStore } from "../durable-items/store.js";
import { summarizeWorkspaceTasks, taskSummary } from "../task-ledger-rpc.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import { requireMatchingAnchor, topicAnchorInput } from "./anchors.js";
import {
  TopicDecisionError,
  type TopicDecisionGuard,
  type TopicReplyRouter,
} from "./reply-router.js";
import type { StoredTopicDecision, TopicThreadStore } from "./store.js";

type DecisionResult = WorkspaceTopicDecideResponse["payload"];
type DecisionInput = StoredTopicDecision["input"];
type DecisionEvent =
  | WorkspaceTasksUpdatedMessage
  | WorkspaceDurableItemUpdatedMessage
  | WorkspaceTopicThreadUpdatedMessage;

export interface TopicDecisionActor {
  serverId?: string;
  principalId?: string;
  origin: StoredTopicDecision["origin"];
  assertCurrent?: () => void;
}

export interface TopicDecisionDependencies {
  serverId: string;
  store: TopicThreadStore;
  router: Pick<TopicReplyRouter, "requireMain" | "reply">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  taskLedger: Pick<WorkspaceTaskLedgerStore, "list" | "syncFromTurnOutcome" | "withTaskSnapshot">;
  durableItems: Pick<DurableItemStore, "get"> & {
    decide: (
      input: Parameters<DurableItemStore["decide"]>[0],
      assertCurrent?: () => void,
    ) => Promise<WorkspaceDurableItem>;
  };
  broadcast: (event: DecisionEvent) => void;
  logger: Pick<Logger, "warn">;
}

class StaleBlockingQuestionError extends TopicDecisionError {
  constructor(readonly task: DecisionResult["task"]) {
    super("The blocking question changed. Refresh it before continuing this decision.");
  }
}

function rejectTopic(message: string): never {
  throw new TopicDecisionError(message);
}

const decisionInputSchema = WorkspaceTopicDecideRequestSchema.omit({ type: true, requestId: true });
const decisionLanes = new Map<string, Promise<void>>();

function escapePrompt(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function checkedDurableFields({ durableItemRequestId, expectedRevision, decision }: DecisionInput) {
  if (!durableItemRequestId || expectedRevision === undefined || !decision)
    rejectTopic("A durable item, expected revision and decision are required.");
  return { durableItemRequestId, expectedRevision, decision };
}

function resolveTask(tasks: WorkspaceTask[], input: DecisionInput, durable?: WorkspaceDurableItem) {
  const keyTaskId = input.topicKey.startsWith("task:") ? input.topicKey.slice(5) : undefined;
  const keyRootId = input.topicKey.startsWith("msg:") ? input.topicKey.slice(4) : undefined;
  const taskId = input.taskId ?? keyTaskId ?? durable?.taskId;
  const rootTasks = tasks.filter((item) => keyRootId && item.rootMessageId === keyRootId);
  const uniqueRootTask = rootTasks.length === 1 ? rootTasks[0] : undefined;
  const task = taskId ? tasks.find((item) => item.taskId === taskId) : uniqueRootTask;
  if (!task) rejectTopic("The task is unavailable in this workspace.");
  if (input.rootMessageId !== undefined && input.rootMessageId !== task.rootMessageId)
    rejectTopic("The first message does not belong to this task.");
  const matchesTaskKey = keyTaskId === task.taskId;
  const matchesRootKey = !!keyRootId && keyRootId === task.rootMessageId;
  if (!matchesTaskKey && !matchesRootKey) rejectTopic("The task does not belong to this topic.");
  return task;
}

function validateDurable(item: WorkspaceDurableItem, input: DecisionInput, task: WorkspaceTask) {
  if (item.kind === "authorization")
    rejectTopic("Decide authorization items in their dedicated approval view.");
  const taskKey = `task:${task.taskId}`;
  const rootKey = task.rootMessageId && `msg:${task.rootMessageId}`;
  if (
    item.workspaceId !== input.workspaceId ||
    (item.taskId !== undefined && item.taskId !== task.taskId) ||
    (item.rootMessageId !== undefined && item.rootMessageId !== task.rootMessageId) ||
    (item.topicKey !== undefined && item.topicKey !== taskKey && item.topicKey !== rootKey)
  )
    rejectTopic("The durable item does not belong to this topic.");
  const exactTask = item.taskId === task.taskId || item.topicKey === taskKey;
  if (!exactTask) rejectTopic("The durable item has no exact task binding for this topic.");
  const knownSource =
    item.sourceAgentId === input.mainAgentId ||
    item.sourceAgentId === task.leadAgentId ||
    task.participants.some(
      ({ agentId, boundBy }) =>
        agentId === item.sourceAgentId && (!boundBy || boundBy === input.mainAgentId),
    );
  if (!knownSource) rejectTopic("The durable item source does not belong to this task.");
}

function decideTaskStatus(
  input: DecisionInput,
  task: WorkspaceTask,
  durable: WorkspaceDurableItem | undefined,
  pureAcceptance: boolean,
  dispatchFollowup: boolean,
): WorkspaceTask["status"] | undefined {
  if (pureAcceptance && !dispatchFollowup) {
    if (task.closure?.verification?.state === "failed")
      rejectTopic("A task with failed verification cannot be completed.");
    return "completed";
  }
  if (task.status === "awaiting_decision") return "in_progress";
  if (durable?.kind === "acceptance" && input.decision !== "approve" && task.status === "verifying")
    return "in_progress";
}

function decisionText(input: DecisionInput, durable?: WorkspaceDurableItem): string {
  if (!durable) return input.note!.trim();
  const subject = durable.kind === "acceptance" ? "验收" : "拍板";
  const action = {
    approve: "通过",
    reject: "拒绝",
    request_changes: "要求修改",
  }[input.decision!];
  const base = `${subject}${action}：${durable.title}`;
  return input.note?.trim() ? `${base}\n${input.note.trim()}` : base;
}

function requireMatchingDecision(
  record: StoredTopicDecision | undefined,
  input: DecisionInput,
  actor: TopicDecisionActor,
) {
  if (
    record &&
    (JSON.stringify(record.input) !== JSON.stringify(input) ||
      record.origin !== actor.origin ||
      record.principalId !== actor.principalId)
  )
    rejectTopic("This message ID is already used by another topic decision.");
}

function requireBlockingReply(input: DecisionInput) {
  if (!input.note?.trim()) rejectTopic("A reply to the blocking question is required.");
  if (input.durableItemRequestId || input.decision || input.expectedRevision !== undefined)
    rejectTopic("Use a durable item decision for durable approval fields.");
}

function taskAddress(input: DecisionInput, task: WorkspaceTask) {
  return {
    workspaceId: input.workspaceId,
    mainAgentId: input.mainAgentId,
    topicKey: `task:${task.taskId}`,
    taskId: task.taskId,
    rootMessageId: task.rootMessageId,
  };
}

function isOriginalTask(record: StoredTopicDecision, task: WorkspaceTask) {
  return (
    record.taskCreatedAt === task.createdAt &&
    record.taskId === task.taskId &&
    record.rootMessageId === task.rootMessageId
  );
}

function clearedByDecision(record: StoredTopicDecision, task: WorkspaceTask): boolean {
  return (
    task.blockingQuestion === undefined && task.blockingQuestionGeneration === record.operationId
  );
}

function matchesBlockingQuestion(task: WorkspaceTask, expected: string): boolean {
  return !!task.blockingQuestion?.trim() && task.blockingQuestionGeneration === expected;
}

function requireDecisionTaskVersion(
  task: WorkspaceTask,
  tasks: readonly WorkspaceTask[],
  record: StoredTopicDecision | undefined,
  expectedQuestion: string | undefined,
) {
  if (record && !isOriginalTask(record, task))
    rejectTopic("The original task for this decision is unavailable.");
  if (
    expectedQuestion !== undefined &&
    !matchesBlockingQuestion(task, expectedQuestion) &&
    !(record && clearedByDecision(record, task))
  ) {
    throw new StaleBlockingQuestionError(
      summarizeWorkspaceTasks(tasks).find(({ taskId }) => taskId === task.taskId) ?? null,
    );
  }
}

function wasTaskDecisionApplied(record: StoredTopicDecision, task: WorkspaceTask): boolean {
  if (task.status !== record.desiredStatus || task.blockingQuestion !== undefined) return false;
  if (clearedByDecision(record, task)) return true;
  // Older decisions left no identifier on the task. Only resume on an unversioned task.
  return (
    record.blockingQuestionGeneration === undefined && task.blockingQuestionGeneration === undefined
  );
}

function currentTurnGuard({ assertCurrent }: TopicDecisionActor) {
  if (!assertCurrent) return;
  return () => {
    try {
      assertCurrent();
    } catch (error) {
      rejectTopic(error instanceof Error ? error.message : "The Main Control turn has ended.");
    }
  };
}

export function createTopicDecisionService(deps: TopicDecisionDependencies) {
  const { store, router, taskLedger, durableItems } = deps;

  function publish(event: DecisionEvent) {
    try {
      deps.broadcast(event);
    } catch (error) {
      deps.logger.warn(
        { err: error, type: event.type },
        "Could not broadcast topic decision update",
      );
    }
  }

  async function readDurable(workspaceId: string, requestId: string) {
    const item = await durableItems.get({ workspaceId, requestId, serverId: deps.serverId });
    if (!item) rejectTopic("The durable item is unavailable in this workspace.");
    return item;
  }

  async function requireScope(input: DecisionInput, actor: TopicDecisionActor) {
    const workspace = await deps.workspaceRegistry.get(input.workspaceId);
    if (
      !workspace?.topic ||
      workspace.workspaceId !== input.workspaceId ||
      workspace.archivedAt ||
      workspace.background
    )
      rejectTopic("This topic workspace is unavailable.");
    if (actor.serverId !== undefined && actor.serverId !== deps.serverId)
      rejectTopic("The topic decision belongs to another host.");
    await router.requireMain(input);
    if (actor.origin === "butler_dispatch" && !actor.assertCurrent)
      rejectTopic("The Main Control turn must be checked for this decision.");
    actor.assertCurrent?.();
  }

  async function prepare(input: DecisionInput, actor: TopicDecisionActor) {
    const durableFields =
      input.resolutionKind === "durable_item" ? checkedDurableFields(input) : undefined;
    if (durableFields) {
      if (!actor.principalId) rejectTopic("A principal is required to decide a durable item.");
    } else {
      requireBlockingReply(input);
    }
    const record = await store.getDecision(input, input.clientMessageId);
    requireMatchingDecision(record, input, actor);

    const item = durableFields
      ? await readDurable(input.workspaceId, durableFields.durableItemRequestId)
      : undefined;
    const tasks = await taskLedger.list(input.workspaceId);
    const task = resolveTask(tasks, input, item);
    if (item) validateDurable(item, input, task);
    const address = taskAddress(input, task);
    const { anchors } = await store.listWithAnchors(address, address.topicKey);
    requireMatchingAnchor(anchors[0], address);
    actor.assertCurrent?.();
    const pureAcceptance =
      item?.kind === "acceptance" && input.decision === "approve" && !input.note?.trim();
    const dispatchFollowup = input.dispatchFollowup ?? !pureAcceptance;
    requireDecisionTaskVersion(task, tasks, record, input.expectedBlockingQuestionGeneration);
    if (record) {
      return { record, task, tasks, dispatchFollowup, durableFields };
    }

    if (task.status === "canceled" || task.status === "deferred")
      rejectTopic("This task is no longer active.");
    if (!item && !task.blockingQuestion?.trim())
      rejectTopic("This task has no pending blocking question.");
    const status = decideTaskStatus(input, task, item, pureAcceptance, dispatchFollowup);
    const reserved = await store.reserveDecision(
      {
        input,
        origin: actor.origin,
        principalId: actor.principalId,
        taskCreatedAt: task.createdAt,
        taskId: task.taskId,
        rootMessageId: task.rootMessageId,
        status: task.status,
        desiredStatus: status ?? task.status,
        blockingQuestion: task.blockingQuestion,
        blockingQuestionGeneration: task.blockingQuestionGeneration ?? null,
      },
      currentTurnGuard(actor),
    );
    return { record: reserved, task, tasks, dispatchFollowup, durableFields };
  }

  async function applyDurable(
    record: StoredTopicDecision,
    fields: ReturnType<typeof checkedDurableFields>,
    result: DecisionResult,
    assertCurrent: TopicDecisionActor["assertCurrent"],
  ) {
    assertCurrent?.();
    if (record.durableItem) {
      result.durableItem = record.durableItem;
      return record;
    }
    const { workspaceId, note } = record.input;
    const item = await durableItems.decide(
      {
        workspaceId,
        ...fields,
        note,
        serverId: deps.serverId,
        principalId: record.principalId!,
        topicDecisionOperationId: record.operationId,
      },
      assertCurrent,
    );
    result.durableItem = item;
    publish({ type: "workspace.durable_item.updated", payload: { workspaceId, item } });
    return store.saveDecisionProgress(record, { durableItem: item });
  }

  async function readDecisionTaskSnapshot(record: StoredTopicDecision) {
    const tasks = await taskLedger.list(record.input.workspaceId);
    const summaries = summarizeWorkspaceTasks(tasks);
    const current = tasks.find((task) => isOriginalTask(record, task));
    return {
      current,
      summaries,
      task: current ? (summaries.find((task) => task.taskId === current.taskId) ?? null) : null,
    };
  }

  async function applyTask(
    record: StoredTopicDecision,
    result: DecisionResult,
    assertCurrent: TopicDecisionActor["assertCurrent"],
  ) {
    assertCurrent?.();
    const expectedQuestion = record.input.expectedBlockingQuestionGeneration;
    if (record.task) {
      const { current, task } = await readDecisionTaskSnapshot(record);
      if (expectedQuestion !== undefined && (!current || !clearedByDecision(record, current)))
        throw new StaleBlockingQuestionError(task);
      result.task = task;
      return;
    }
    const { workspaceId } = record.input;
    let staleQuestion = false;
    const updated = await taskLedger.syncFromTurnOutcome(workspaceId, record.taskId, (current) => {
      assertCurrent?.();
      if (!isOriginalTask(record, current)) return null;
      if (wasTaskDecisionApplied(record, current)) return {};
      if (expectedQuestion !== undefined && !matchesBlockingQuestion(current, expectedQuestion)) {
        staleQuestion = true;
        return null;
      }
      const currentGeneration = current.blockingQuestionGeneration ?? null;
      const expectedGeneration = record.blockingQuestionGeneration ?? null;
      if (
        current.status !== record.status ||
        current.blockingQuestion !== record.blockingQuestion ||
        currentGeneration !== expectedGeneration
      )
        return null;
      return {
        status: record.desiredStatus,
        blockingQuestion: null,
        blockingQuestionClearedBy: record.operationId,
      };
    });
    if (!updated) {
      if (staleQuestion)
        throw new StaleBlockingQuestionError((await readDecisionTaskSnapshot(record)).task);
      rejectTopic("The task changed. Refresh it before continuing this decision.");
    }
    await store.saveDecisionProgress(record, { task: taskSummary(updated) });
    const { current, task, summaries } = await readDecisionTaskSnapshot(record);
    result.task = task;
    publish({ type: "workspace.tasks.updated", payload: { workspaceId, tasks: summaries } });
    if (expectedQuestion !== undefined && (!current || !clearedByDecision(record, current)))
      throw new StaleBlockingQuestionError(task);
  }

  async function finish(
    record: StoredTopicDecision,
    task: WorkspaceTask,
    knownTasks: readonly WorkspaceTask[],
    dispatchFollowup: boolean,
    result: DecisionResult,
    actor: TopicDecisionActor,
  ): Promise<DecisionResult> {
    const { workspaceId, mainAgentId, clientMessageId, durableItemRequestId, decision } =
      record.input;
    const address = taskAddress(record.input, task);
    const text = decisionText(record.input, result.durableItem ?? undefined);
    const assertCurrent = currentTurnGuard(actor);
    const versioned =
      record.input.expectedBlockingQuestionGeneration !== undefined ||
      (record.input.resolutionKind === "task_blocking_question" &&
        typeof record.blockingQuestionGeneration === "string");
    const validateTask: TopicDecisionGuard["validateTask"] = (tasks) => {
      const current = tasks.find((item) => item.taskId === record.taskId);
      if (
        versioned &&
        (!current || !isOriginalTask(record, current) || !clearedByDecision(record, current))
      ) {
        throw new StaleBlockingQuestionError(
          summarizeWorkspaceTasks(tasks).find(({ taskId }) => taskId === record.taskId) ?? null,
        );
      }
    };
    const commit: TopicDecisionGuard["commit"] = (write) => {
      if (!versioned) {
        assertCurrent?.();
        return write();
      }
      return taskLedger.withTaskSnapshot(workspaceId, async (tasks) => {
        validateTask(tasks);
        assertCurrent?.();
        return write();
      });
    };
    if (!dispatchFollowup) {
      const { entry, changed, anchor, anchorCreated } = await commit(async () => {
        const { anchors } = await store.listWithAnchors(address, address.topicKey);
        requireMatchingAnchor(anchors[0], address);
        const storedAnchor =
          anchors[0] ??
          (await store.upsertAnchor(topicAnchorInput(address, task), assertCurrent, knownTasks));
        const entryWrite = await store.appendDecisionEntry(
          {
            ...address,
            sourceMessageId: clientMessageId,
            routedAgentId: mainAgentId,
            origin: record.origin,
            durableItemRequestId,
            decision,
            text,
          },
          assertCurrent,
        );
        return { ...entryWrite, anchor: storedAnchor, anchorCreated: !anchors.length };
      });
      if (changed || anchorCreated)
        publish({
          type: "workspace.topic.thread.updated",
          payload: { workspaceId, mainAgentId, entry, anchor },
        });
      return { ...result, entry };
    }

    const reply = await router.reply(
      {
        type: "workspace.topic.reply.request",
        requestId: result.requestId,
        ...address,
        clientMessageId,
        text,
      },
      {
        origin: record.origin,
        durableItemRequestId,
        decision,
        taskCreatedAt: task.createdAt,
        guard: { commit, assertCurrent, validateTask },
        promptText: `<paseo-topic-decision task-id="${escapePrompt(task.taskId)}">
${escapePrompt(text)}
</paseo-topic-decision>`,
      },
    );
    if (reply.payload.error) return { ...result, error: reply.payload.error };
    return {
      ...result,
      entry: reply.payload.entry,
      routedTo: reply.payload.routedTo,
      targetAgentId: reply.payload.targetAgentId,
      error:
        reply.payload.entry?.status === "error"
          ? "The decision was recorded, but follow-up delivery could not be confirmed."
          : null,
    };
  }

  async function apply(
    request: WorkspaceTopicDecideRequest,
    actor: TopicDecisionActor,
  ): Promise<DecisionResult> {
    const { requestId, workspaceId, topicKey } = request;
    const result: DecisionResult = {
      requestId,
      workspaceId,
      topicKey,
      accepted: false,
      durableItem: null,
      task: null,
      routedTo: "none",
      targetAgentId: null,
      entry: null,
      error: null,
    };
    try {
      const input = decisionInputSchema.parse(request);
      await requireScope(input, actor);
      const { record, task, tasks, dispatchFollowup, durableFields } = await prepare(input, actor);
      const applied = durableFields
        ? await applyDurable(record, durableFields, result, actor.assertCurrent)
        : record;
      await applyTask(applied, result, actor.assertCurrent);
      actor.assertCurrent?.();
      const finished = await finish(applied, task, tasks, dispatchFollowup, result, actor);
      return { ...finished, accepted: finished.error === null };
    } catch (error) {
      if (error instanceof DurableItemEvidenceError)
        return { ...result, error: error.message, errorCode: error.errorCode };
      if (error instanceof DurableItemConflictError)
        return { ...result, durableItem: error.item, error: error.message };
      if (error instanceof StaleBlockingQuestionError)
        return {
          ...result,
          task: error.task,
          error: error.message,
          errorCode: "stale_blocking_question",
        };
      if (error instanceof TopicDecisionError) return { ...result, error: error.message };
      deps.logger.warn({ err: error, workspaceId, topicKey }, "Could not apply topic decision");
      return {
        ...result,
        error: "Could not apply topic decision. Retry with the same message ID.",
      };
    }
  }

  return (
    request: WorkspaceTopicDecideRequest,
    actor: TopicDecisionActor,
  ): Promise<DecisionResult> => {
    // The two entry points share one lane. Routers dispatch after this operation releases it.
    const key = JSON.stringify([deps.serverId, request.workspaceId]);
    const result = (decisionLanes.get(key) ?? Promise.resolve()).then(() => apply(request, actor));
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    decisionLanes.set(key, settled);
    void settled.then(() => {
      if (decisionLanes.get(key) === settled) decisionLanes.delete(key);
      return undefined;
    });
    return result;
  };
}
