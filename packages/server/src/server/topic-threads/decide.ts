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
  SupersededDurableDecisionError,
  TopicDecisionError,
  type TopicDecisionGuard,
  type TopicReplyRouter,
} from "./reply-router.js";
import {
  canDeliverDurableDecision,
  isOriginalDecisionTask,
  type StoredTopicDecision,
  type TopicThreadStore,
} from "./store.js";

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
  durableItems: Pick<DurableItemStore, "get" | "getCommittedTopicDecision" | "decide">;
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

function validateDurable(
  item: WorkspaceDurableItem,
  input: DecisionInput,
  task: WorkspaceTask,
  committed = false,
) {
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
  if (committed) return; // The source relationship was checked at commit.
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

function requireNewDecision(
  input: DecisionInput,
  task: WorkspaceTask,
  item?: WorkspaceDurableItem,
) {
  if (task.status === "canceled" || task.status === "deferred")
    rejectTopic("This task is no longer active.");
  if (!item && !task.blockingQuestion?.trim())
    rejectTopic("This task has no pending blocking question.");
  if (!item && !input.expectedBlockingQuestionGeneration)
    throw new StaleBlockingQuestionError(taskSummary(task));
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

function matchesDecisionSnapshot(record: StoredTopicDecision, task: WorkspaceTask) {
  return (
    task.status === record.status &&
    task.blockingQuestion === record.blockingQuestion &&
    (task.blockingQuestionGeneration ?? null) === (record.blockingQuestionGeneration ?? null) &&
    !(record.desiredStatus === "completed" && task.closure?.verification?.state === "failed")
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

  function durableDecisionInput(
    record: StoredTopicDecision,
    fields: ReturnType<typeof checkedDurableFields>,
  ) {
    return {
      ...fields,
      workspaceId: record.input.workspaceId,
      note: record.input.note,
      serverId: deps.serverId,
      principalId: record.principalId!,
      topicDecisionOperationId: record.operationId,
    };
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

    const { item, committed } = durableFields
      ? await readApproval(input, durableFields, record)
      : {};
    const tasks = await taskLedger.list(input.workspaceId);
    const task = resolveTask(tasks, record ? { ...input, taskId: record.taskId } : input, item);
    if (record && !isOriginalDecisionTask(record, task))
      rejectTopic("The original task for this decision is unavailable.");
    if (item) validateDurable(item, input, task, !!committed);
    const address = taskAddress(input, task);
    const { anchors } = await store.listWithAnchors(address, address.topicKey);
    requireMatchingAnchor(anchors[0], address);
    actor.assertCurrent?.();
    const pureAcceptance =
      item?.kind === "acceptance" && input.decision === "approve" && !input.note?.trim();
    const dispatchFollowup = input.dispatchFollowup ?? !pureAcceptance;
    if (!committed)
      requireDecisionTaskVersion(task, tasks, record, input.expectedBlockingQuestionGeneration);
    if (record) {
      return { record, task, tasks, dispatchFollowup, durableFields, item, committed };
    }

    requireNewDecision(input, task, item);
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
    return { record: reserved, task, tasks, dispatchFollowup, durableFields, item, committed };
  }

  async function readApproval(
    input: DecisionInput,
    fields: ReturnType<typeof checkedDurableFields>,
    record: StoredTopicDecision | undefined,
  ) {
    const committed =
      record &&
      (await durableItems.getCommittedTopicDecision(durableDecisionInput(record, fields)));
    if (record?.durableItem && !committed)
      rejectTopic("The original approval could not be confirmed.");
    return {
      committed,
      item: committed ?? (await readDurable(input.workspaceId, fields.durableItemRequestId)),
    };
  }

  async function applyDurable(
    record: StoredTopicDecision,
    fields: ReturnType<typeof checkedDurableFields>,
    result: DecisionResult,
    assertCurrent: TopicDecisionActor["assertCurrent"],
    committed: WorkspaceDurableItem | undefined,
  ) {
    assertCurrent?.();
    const item =
      committed ??
      (await durableItems.decide(durableDecisionInput(record, fields), assertCurrent, {
        deferNotification: true,
      }));
    result.durableItem = item;
    return record.durableItem ? record : store.saveDecisionProgress(record, { durableItem: item });
  }

  async function readDecisionTaskSnapshot(record: StoredTopicDecision) {
    const tasks = await taskLedger.list(record.input.workspaceId);
    const summaries = summarizeWorkspaceTasks(tasks);
    const current = tasks.find((task) => isOriginalDecisionTask(record, task));
    if (!current) rejectTopic("The original task for this decision is unavailable.");
    return {
      current,
      summaries,
      task: summaries.find((task) => task.taskId === current.taskId) ?? null,
    };
  }

  async function markResumeRequired(
    failure: DecisionResult,
    record: StoredTopicDecision | undefined,
    actor: TopicDecisionActor,
  ): Promise<DecisionResult> {
    if (record?.input.resolutionKind !== "durable_item" || failure.entry) return failure;
    const { input } = record;
    try {
      // A write can throw even after the approval was committed. Read the
      // receipt for this operation rather than inferring from the failed step.
      const committed = await durableItems.getCommittedTopicDecision(
        durableDecisionInput(record, checkedDurableFields(input)),
      );
      if (!committed) return failure;
      await requireScope(input, actor);
      const reserved = await store.getDecision(input, input.clientMessageId);
      if (reserved?.operationId !== record.operationId) return failure;
      requireMatchingDecision(reserved, input, actor);
      const { current } = await readDecisionTaskSnapshot(record);
      if (!isOriginalDecisionTask(reserved, current)) return failure;
      validateDurable(committed, input, current, true);
      const address = taskAddress(input, current);
      const { entries, anchors } = await store.listWithAnchors(address);
      requireMatchingAnchor(
        anchors.find(({ topicKey }) => topicKey === address.topicKey),
        address,
      );
      actor.assertCurrent?.();
      // An existing history or delivery entry owns any remaining recovery.
      if (
        entries.some(
          (entry) =>
            entry.role !== "agent_reply" && entry.sourceMessageId === input.clientMessageId,
        )
      )
        return failure;
      return {
        ...failure,
        durableItem: committed,
        error:
          "The approval was recorded. Retry with the same message ID to finish the topic decision.",
        errorCode: "topic_decision_resume_required",
      };
    } catch {
      return failure;
    }
  }

  async function applyTask(
    record: StoredTopicDecision,
    result: DecisionResult,
    assertCurrent: TopicDecisionActor["assertCurrent"],
    durableFields: ReturnType<typeof checkedDurableFields> | undefined,
    item: WorkspaceDurableItem | undefined,
    committed: WorkspaceDurableItem | undefined,
  ) {
    assertCurrent?.();
    let applied = record;
    const expectedQuestion = record.input.expectedBlockingQuestionGeneration;
    if (record.task || record.followupSuperseded) {
      const { current, task } = await readDecisionTaskSnapshot(record);
      if (!committed && expectedQuestion !== undefined && !clearedByDecision(record, current))
        throw new StaleBlockingQuestionError(task);
      result.task = task;
      result.durableItem = committed ?? null;
      return record;
    }
    const { workspaceId } = record.input;
    let staleQuestion = false;
    const updated = await taskLedger.syncFromTurnOutcome(
      workspaceId,
      record.taskId,
      (current) => {
        assertCurrent?.();
        if (!isOriginalDecisionTask(record, current))
          rejectTopic("The original task for this decision is unavailable.");
        if (item) validateDurable(item, record.input, current, !!committed);
        if (wasTaskDecisionApplied(record, current)) return {};
        if (expectedQuestion !== undefined && !matchesBlockingQuestion(current, expectedQuestion)) {
          staleQuestion = true;
          return null;
        }
        if (!matchesDecisionSnapshot(record, current)) return null;
        return {
          status: record.desiredStatus,
          blockingQuestion: null,
          blockingQuestionClearedBy: record.operationId,
        };
      },
      durableFields
        ? {
            beforeCommit: async () => {
              applied = await applyDurable(record, durableFields, result, assertCurrent, committed);
            },
          }
        : undefined,
    );
    if (!updated) {
      if (committed) {
        const { task } = await readDecisionTaskSnapshot(record);
        result.task = task;
        result.durableItem = committed;
        assertCurrent?.();
        // The durable commit stands, but this decision no longer owns the task state.
        return store.saveDecisionProgress(record, {
          durableItem: committed,
          followupSuperseded: true,
        });
      }
      if (staleQuestion)
        throw new StaleBlockingQuestionError((await readDecisionTaskSnapshot(record)).task);
      rejectTopic("The task changed. Refresh it before continuing this decision.");
    }
    result.durableItem = applied.durableItem ?? null;
    if (applied.durableItem)
      publish({
        type: "workspace.durable_item.updated",
        payload: { workspaceId, item: applied.durableItem },
      });
    applied = await store.saveDecisionProgress(applied, { task: taskSummary(updated) });
    const { current, task, summaries } = await readDecisionTaskSnapshot(record);
    result.task = task;
    publish({ type: "workspace.tasks.updated", payload: { workspaceId, tasks: summaries } });
    if (
      !applied.durableItem &&
      expectedQuestion !== undefined &&
      !clearedByDecision(record, current)
    )
      throw new StaleBlockingQuestionError(task);
    return applied;
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
    const durable = record.durableItem;
    const versioned =
      durable !== undefined ||
      record.input.expectedBlockingQuestionGeneration !== undefined ||
      (record.input.resolutionKind === "task_blocking_question" &&
        typeof record.blockingQuestionGeneration === "string");
    const validateTask: TopicDecisionGuard["validateTask"] = (tasks) => {
      const current = tasks.find((item) => item.taskId === record.taskId);
      if (!current || !isOriginalDecisionTask(record, current))
        rejectTopic("The original task for this decision is unavailable.");
      if (durable && (!record.task || !canDeliverDurableDecision(record, current)))
        throw new SupersededDurableDecisionError();
      if (!durable && versioned && !clearedByDecision(record, current)) {
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
    const writeHistory = async (superseded: boolean) => {
      const write = async (current: WorkspaceTask, tasks: readonly WorkspaceTask[]) => {
        const { anchors } = await store.listWithAnchors(address, address.topicKey);
        requireMatchingAnchor(anchors[0], address);
        if (superseded && !record.followupSuperseded)
          await store.saveDecisionProgress(record, { followupSuperseded: true });
        const storedAnchor =
          anchors[0] ??
          (await store.upsertAnchor(topicAnchorInput(address, current), assertCurrent, tasks));
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
          superseded,
        );
        return { ...entryWrite, anchor: storedAnchor, anchorCreated: !anchors.length };
      };
      const { entry, changed, anchor, anchorCreated, followupSuppressed } = await (durable
        ? taskLedger.withTaskSnapshot(workspaceId, async (tasks) => {
            assertCurrent?.();
            const current = tasks.find((item) => isOriginalDecisionTask(record, item));
            if (!current) rejectTopic("The original task for this decision is unavailable.");
            result.task =
              summarizeWorkspaceTasks(tasks).find((item) => item.taskId === record.taskId) ?? null;
            return write(current, tasks);
          })
        : commit(() => write(task, knownTasks)));
      if (durable && !record.task && changed)
        publish({
          type: "workspace.durable_item.updated",
          payload: { workspaceId, item: durable },
        });
      if (changed || anchorCreated)
        publish({
          type: "workspace.topic.thread.updated",
          payload: { workspaceId, mainAgentId, entry, anchor },
        });
      let error = null;
      if (superseded && (entry.role === "system_note" || followupSuppressed))
        error = "The approval was recorded, but the task changed before follow-up delivery.";
      else if (entry.status === "error")
        error = "The decision was recorded, but follow-up delivery could not be confirmed.";
      const targetAgentId = entry.role === "user_followup" ? entry.routedAgentId : null;
      const agentRoute = targetAgentId === mainAgentId ? "main" : "lead";
      return {
        ...result,
        entry,
        targetAgentId,
        routedTo: targetAgentId === null ? "none" : agentRoute,
        error,
      } satisfies DecisionResult;
    };

    if (!dispatchFollowup) return writeHistory(false);
    if (
      durable &&
      (!record.task ||
        !canDeliverDurableDecision(record, (await readDecisionTaskSnapshot(record)).current))
    )
      return writeHistory(true);

    const sendFollowup = () =>
      router.reply(
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
    const reply = await sendFollowup().catch((error: unknown) => {
      if (durable && error instanceof SupersededDurableDecisionError) return null;
      throw error;
    });
    if (!reply) return writeHistory(true);
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
    let preparedRecord: StoredTopicDecision | undefined;
    try {
      const input = decisionInputSchema.parse(request);
      await requireScope(input, actor);
      const { record, task, tasks, dispatchFollowup, durableFields, item, committed } =
        await prepare(input, actor);
      preparedRecord = record;
      const applied = await applyTask(
        record,
        result,
        currentTurnGuard(actor),
        durableFields,
        item,
        committed,
      );
      currentTurnGuard(actor)?.();
      const finished = await finish(applied, task, tasks, dispatchFollowup, result, actor);
      if (finished.error) return markResumeRequired(finished, applied, actor);
      return { ...finished, accepted: true };
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
      return markResumeRequired(
        { ...result, error: "Could not apply topic decision. Retry with the same message ID." },
        preparedRecord,
        actor,
      );
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
