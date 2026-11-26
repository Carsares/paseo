import type {
  TopicAnchorSummary,
  TopicThreadEntry,
  WorkspaceTopicListEntriesRequest,
  WorkspaceTopicListEntriesResponse,
  WorkspaceTopicReplyRequest,
  WorkspaceTopicReplyResponse,
  WorkspaceTopicThreadUpdatedMessage,
} from "@getpaseo/protocol/messages";
import {
  getParentAgentIdFromLabels,
  isMainControlAgentLabels,
} from "@getpaseo/protocol/agent-labels";
import type { Logger } from "pino";
import { topicFollowupRunOptions, type AgentManager } from "../agent/agent-manager.js";
import { AgentNotFoundError } from "../agent/agent-loading.js";
import {
  AgentTurnBusyError,
  QueuedPromptLoadError,
  sendPromptToAgent,
  waitForAgentRunStartWithTimeout,
} from "../agent/agent-prompt.js";
import {
  AgentTurnStartRejectedError,
  getAgentStreamEventTurnId,
  type AgentPromptInput,
} from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { buildAgentPrompt } from "../agent/prompt-attachments.js";
import type {
  WorkspaceTask,
  WorkspaceTaskLedgerStore,
  WorkspaceTaskTurnOutcomePatch,
} from "../agent/task-ledger/index.js";
import { isLocalTaskChild } from "../agent/task-ledger/reuse.js";
import { checkTopicAddress, requireMatchingAnchor, topicAnchorInput } from "./anchors.js";
import {
  canDeliverDurableDecision,
  type StoredTopicDecision,
  type TopicAgentReply,
  type TopicDelivery,
  type TopicThreadStore,
} from "./store.js";
import {
  resolveTopicPromptAttachments,
  restoreTopicRetryAttachments,
  TopicAttachmentsReuploadRequired,
  type TopicUploadAccess,
} from "./uploaded-attachments.js";

type ReplyPayload = WorkspaceTopicReplyResponse["payload"];
type Route = Required<Pick<ReplyPayload, "routedTo" | "fallbackReason">> & {
  targetAgentId: string;
};
interface TopicAgent {
  workspaceId?: string | null;
  archivedAt?: string | Date | null;
  internal?: boolean;
  labels?: Record<string, string>;
}

interface TopicTurnOutcome {
  reply?: TopicAgentReply;
  touchedFiles: string[];
}

type DispatchTopicPrompt = ((input: {
  agentId: string;
  messageId: string;
  scope: Parameters<typeof topicFollowupRunOptions>[0];
  prompt: AgentPromptInput;
  imageAttachments?: TopicThreadEntry["imageAttachments"];
  validate: () => Promise<void>;
  onHandoff: (pending: boolean) => Promise<void>;
  onStarted: () => Promise<void>;
  signal: AbortSignal;
}) => Promise<TopicTurnOutcome | undefined>) & {
  wasAccepted?: (entry: TopicThreadEntry) => Promise<boolean>;
};

class TopicLeadUnavailableError extends AgentTurnStartRejectedError {}

class TopicRouteChangedError extends TopicLeadUnavailableError {
  constructor(readonly route: Route) {
    super("The topic's lead routing changed before delivery.");
  }
}

export class TopicDecisionError extends Error {}

export class SupersededDurableDecisionError extends TopicDecisionError {
  constructor() {
    super("The task changed since this topic decision was recorded.");
  }
}

export interface TopicDecisionGuard {
  commit: <T>(write: () => Promise<T>) => Promise<T>;
  assertCurrent?: () => void;
  validateTask: (tasks: readonly WorkspaceTask[]) => void;
}

export interface TopicDecisionDispatch {
  origin: "decision_reply" | "butler_dispatch";
  durableItemRequestId?: string;
  decision?: TopicThreadEntry["decision"];
  promptText: string;
  taskCreatedAt: string;
  guard?: TopicDecisionGuard;
}

interface RouterDependencies {
  serverId: string;
  store: TopicThreadStore;
  taskLedger: Pick<WorkspaceTaskLedgerStore, "list" | "syncFromTurnOutcome"> &
    Partial<Pick<WorkspaceTaskLedgerStore, "withTaskSnapshot">>;
  readAgent: (agentId: string) => Promise<TopicAgent | null>;
  dispatch: DispatchTopicPrompt;
  /** The WebSocket owner filters this event by capability and workspace access. */
  broadcast: (event: WorkspaceTopicThreadUpdatedMessage) => void;
  logger: Pick<Logger, "warn">;
}

function pendingResult<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const mainMention = /^\s*@(?:主控|main(?![\p{L}\p{N}_]))/iu;

function inWorkspace(agent: TopicAgent | null, workspaceId: string): agent is TopicAgent {
  return !!agent && agent.workspaceId === workspaceId && !agent.internal && !agent.archivedAt;
}

function isAvailableLead(
  agent: TopicAgent | null,
  request: WorkspaceTopicReplyRequest,
  serverId: string,
): boolean {
  return (
    inWorkspace(agent, request.workspaceId) &&
    isLocalTaskChild(agent.labels, request.mainAgentId, serverId)
  );
}

async function selectRoute(
  request: WorkspaceTopicReplyRequest,
  task: WorkspaceTask | undefined,
  { serverId, readAgent }: Pick<RouterDependencies, "serverId" | "readAgent">,
): Promise<Route> {
  const main = (fallbackReason: Route["fallbackReason"]): Route => ({
    routedTo: "main",
    targetAgentId: request.mainAgentId,
    fallbackReason,
  });
  if (request.routeMode === "main" || mainMention.test(request.text)) return main("explicit_main");
  if (!task?.leadAgentId) return main("no_lead_bound");
  if (task.leadServerId && task.leadServerId !== serverId) return main("remote_lead");
  if (
    task.leadAgentId === request.mainAgentId ||
    !isAvailableLead(await readAgent(task.leadAgentId), request, serverId)
  )
    return main("lead_archived");
  return { routedTo: "lead", targetAgentId: task.leadAgentId, fallbackReason: "none" };
}

function requireReplyTask(
  task: WorkspaceTask | undefined,
  rootMessageId: string | undefined,
  decision?: TopicDecisionDispatch,
) {
  if (task?.rootMessageId && rootMessageId && task.rootMessageId !== rootMessageId)
    throw new Error("The task does not belong to this topic.");
  if (
    decision &&
    (task?.createdAt !== decision.taskCreatedAt || task.rootMessageId !== rootMessageId)
  )
    throw new Error("The task no longer belongs to this topic decision.");
}

function replyOutcomePatch(
  current: Readonly<WorkspaceTask>,
  submitted: WorkspaceTask,
  { reply, touchedFiles }: TopicTurnOutcome,
  answerBlockingQuestion: boolean,
): WorkspaceTaskTurnOutcomePatch | null {
  if (
    current.createdAt !== submitted.createdAt ||
    current.rootMessageId !== submitted.rootMessageId
  )
    return null;
  const patch: WorkspaceTaskTurnOutcomePatch = { touchedFiles };
  const preview = reply?.text.replace(/\s+/g, " ").trim();
  if (!preview) return patch;
  patch.latestReplyPreview = Array.from(preview).slice(0, 240).join("");
  const sameBlockingQuestion =
    answerBlockingQuestion &&
    submitted.blockingQuestion?.trim() &&
    submitted.blockingQuestion === current.blockingQuestion &&
    submitted.blockingQuestionGeneration === current.blockingQuestionGeneration;
  if (sameBlockingQuestion) {
    patch.blockingQuestion = null;
    if (current.status === "awaiting_decision") patch.status = "in_progress";
  }
  return patch;
}

function sameTopicTask(a: WorkspaceTask | undefined, b: WorkspaceTask | undefined): boolean {
  return (
    a?.taskId === b?.taskId &&
    a?.createdAt === b?.createdAt &&
    a?.rootMessageId === b?.rootMessageId
  );
}

function requireUniqueReplyTask(tasks: readonly WorkspaceTask[], expected: WorkspaceTask) {
  const owners = tasks.filter((task) => task.rootMessageId === expected.rootMessageId);
  const current = owners[0];
  if (owners.length !== 1 || !current || !sameTopicTask(current, expected))
    throw new Error("The original reply has no unique task for this topic.");
  return current;
}

function topicContext(entry: TopicThreadEntry, fallbackReason: Route["fallbackReason"]): string {
  const attr = (name: string, value: string | undefined) =>
    value ? ` ${name}="${value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}"` : "";
  let note = "";
  if (fallbackReason === "lead_archived")
    note =
      "\nThe previous lead is unavailable. Answer in this topic or assign a new lead to the same task.";
  if (fallbackReason === "remote_lead")
    note =
      "\nThe lead is on another host. Answer in this topic or coordinate with the lead via the usual tools.";
  return `<paseo-topic-context${attr("task-id", entry.taskId)}${attr("root-message-id", entry.rootMessageId)}>${note}\n</paseo-topic-context>\n\n`;
}

export function createTopicReplyRouter(deps: RouterDependencies) {
  const { store, taskLedger, readAgent, logger } = deps;
  const shutdown = new AbortController();
  const inFlight = new Set<Promise<void>>();

  async function requireMain({
    workspaceId,
    mainAgentId,
  }: Pick<TopicThreadEntry, "workspaceId" | "mainAgentId">) {
    const main = await readAgent(mainAgentId);
    if (
      !inWorkspace(main, workspaceId) ||
      !isMainControlAgentLabels(main.labels) ||
      getParentAgentIdFromLabels(main.labels)
    )
      throw new Error("Workspace Main Control is unavailable.");
  }

  function publish(entry: TopicThreadEntry, anchor?: TopicAnchorSummary) {
    try {
      deps.broadcast({
        type: "workspace.topic.thread.updated",
        payload: { workspaceId: entry.workspaceId, mainAgentId: entry.mainAgentId, entry, anchor },
      });
    } catch (error) {
      logger.warn({ err: error, entryId: entry.entryId }, "Could not broadcast topic update");
    }
  }

  async function dispatch(
    request: WorkspaceTopicReplyRequest,
    entry: TopicThreadEntry,
    route: Route,
    humanInitiated: boolean,
    uploads: TopicUploadAccess | undefined,
    decision?: TopicDecisionDispatch,
    originalTaskCreatedAt?: string,
    boundRetryTask?: WorkspaceTask,
  ) {
    const { workspaceId, entryId, taskId, rootMessageId } = entry;
    let failedLeadId: string | undefined;
    const mainFallback: Route = {
      routedTo: "main",
      targetAgentId: request.mainAgentId,
      fallbackReason: "lead_archived",
    };
    const readTask = async () => {
      if (!taskId && !rootMessageId) return;
      const tasks = await taskLedger.list(workspaceId);
      if (boundRetryTask) return requireUniqueReplyTask(tasks, boundRetryTask);
      decision?.guard?.validateTask(tasks);
      const task = taskId
        ? tasks.find((item) => item.taskId === taskId)
        : tasks.findLast((item) => item.rootMessageId === rootMessageId);
      requireReplyTask(task, rootMessageId, decision);
      if (originalTaskCreatedAt && task?.createdAt !== originalTaskCreatedAt)
        throw new Error("The original task for this reply is unavailable.");
      return task;
    };
    const readRoute = async () => {
      let task = await readTask();
      for (;;) {
        shutdown.signal.throwIfAborted();
        const current = await selectRoute(request, task, deps);
        // Availability checks can yield while the ledger changes underneath them.
        const latest = await readTask();
        if (
          latest?.leadAgentId === task?.leadAgentId &&
          latest?.leadServerId === task?.leadServerId
        )
          return current.targetAgentId === failedLeadId ? mainFallback : current;
        task = latest;
      }
    };
    let submittedTask: WorkspaceTask | undefined;
    const send = async (
      target: Route,
      {
        files,
        images,
        imageAttachments,
      }: Awaited<ReturnType<typeof resolveTopicPromptAttachments>>,
    ) => {
      const task = await readTask();
      return deps.dispatch({
        agentId: target.targetAgentId,
        messageId: entry.sourceMessageId ?? entryId,
        scope: {
          workspaceId,
          mainAgentId: request.mainAgentId,
          taskId: task?.taskId,
          topicKey: entry.topicKey,
          rootMessageId: entry.rootMessageId,
          humanInitiated: decision === undefined && humanInitiated === true,
        },
        prompt: buildAgentPrompt(
          topicContext(entry, target.fallbackReason) + (decision?.promptText ?? request.text),
          images,
          files,
        ),
        ...(imageAttachments.length ? { imageAttachments } : {}),
        validate: async () => {
          await requireMain(request);
          if (target.fallbackReason !== "explicit_main") {
            const current = await readRoute();
            if (
              current.targetAgentId !== target.targetAgentId ||
              current.fallbackReason !== target.fallbackReason
            )
              throw new TopicRouteChangedError(current);
          }
          if (!sameTopicTask(task, await readTask())) throw new TopicRouteChangedError(target);
        },
        onHandoff: async (pending) => {
          if (pending && boundRetryTask && taskLedger.withTaskSnapshot) {
            await taskLedger.withTaskSnapshot(workspaceId, async (tasks) => {
              submittedTask = requireUniqueReplyTask(tasks, boundRetryTask);
              await store.setHandoffPending(workspaceId, entryId, true);
            });
            return;
          }
          submittedTask = pending ? await readTask() : undefined;
          if (pending && decision?.durableItemRequestId && taskLedger.withTaskSnapshot) {
            // Keep the last version check and the handoff marker ordered with task writes.
            await taskLedger.withTaskSnapshot(workspaceId, async (tasks) => {
              decision.guard?.validateTask(tasks);
              const delivery = await store.getDelivery(entry, { entryId });
              if (delivery?.decision?.followupSuperseded)
                throw new SupersededDurableDecisionError();
              await store.setHandoffPending(workspaceId, entryId, true);
            });
            return;
          }
          await store.setHandoffPending(workspaceId, entryId, pending);
        },
        onStarted: async () => {
          for (const update of await store.update(workspaceId, entryId, "running")) publish(update);
        },
        signal: shutdown.signal,
      });
    };
    let outcome: TopicTurnOutcome | undefined;
    try {
      const attachments = await resolveTopicPromptAttachments(request.attachments, uploads);
      if (!request.text.trim() && !attachments.images.length)
        throw new Error("Topic follow-up text is required.");
      if (attachments.imageAttachments.length)
        publish(
          await store.setImageAttachments(workspaceId, entryId, attachments.imageAttachments),
        );
      let target = route;
      for (;;) {
        shutdown.signal.throwIfAborted();
        try {
          outcome = await send(target, attachments);
          break;
        } catch (error) {
          if (
            !(error instanceof TopicRouteChangedError) &&
            (target.routedTo !== "lead" || !(error instanceof TopicLeadUnavailableError))
          )
            throw error;
          shutdown.signal.throwIfAborted();
          if (error instanceof TopicRouteChangedError) {
            target = error.route;
          } else {
            failedLeadId = target.targetAgentId;
            target = await readRoute();
          }
          publish(await store.reroute(workspaceId, entryId, target.targetAgentId));
        }
      }
    } catch (error) {
      if (shutdown.signal.aborted) return;
      logger.warn({ err: error, entryId }, "Could not deliver topic follow-up");
      const suppressed = error instanceof SupersededDurableDecisionError;
      for (const update of await store.update(workspaceId, entryId, "error", undefined, suppressed))
        publish(update);
      return;
    }
    for (const update of await store.update(workspaceId, entryId, "completed", outcome?.reply))
      publish(update);
    const submitted = submittedTask;
    // A structured decision cleared its own question before dispatch.
    const answerBlockingQuestion = decision === undefined;
    if (submitted && outcome)
      await taskLedger.syncFromTurnOutcome(workspaceId, submitted.taskId, (current) =>
        replyOutcomePatch(current, submitted, outcome, answerBlockingQuestion),
      );
  }

  async function resolveReplyAddress(
    request: WorkspaceTopicReplyRequest,
    decision?: TopicDecisionDispatch,
  ) {
    const { workspaceId, topicKey } = request;
    const keyTaskId = topicKey.startsWith("task:") ? topicKey.slice(5) : undefined;
    const keyRootId = topicKey.startsWith("msg:") ? topicKey.slice(4) : undefined;
    const taskId = request.taskId ?? keyTaskId;
    const rootMessageId = request.rootMessageId ?? keyRootId;
    const tasks = taskId || rootMessageId ? await taskLedger.list(workspaceId) : [];
    const task = taskId
      ? tasks.find((item) => item.taskId === taskId)
      : tasks.findLast((item) => item.rootMessageId === rootMessageId);
    requireReplyTask(task, rootMessageId, decision);
    const canonicalKey = keyRootId && task ? `task:${task.taskId}` : topicKey;
    const address = {
      workspaceId,
      mainAgentId: request.mainAgentId,
      topicKey: canonicalKey,
      taskId: task?.taskId ?? taskId,
      rootMessageId: task?.rootMessageId ?? rootMessageId,
    };
    // A stale msg: card may follow a task after binding, but only for the same root.
    if (keyRootId && rootMessageId !== keyRootId)
      throw new Error("The first message does not belong to this topic.");
    if (keyRootId && task && !task.rootMessageId)
      throw new Error("The task does not belong to this topic.");
    checkTopicAddress(address);
    return { address, task, tasks };
  }

  async function ensureReplyAnchor(
    address: Parameters<typeof topicAnchorInput>[0],
    task: WorkspaceTask | undefined,
    tasks: readonly WorkspaceTask[],
    rootPromptPreview: string | undefined,
    assertCurrent?: () => void,
  ) {
    const { anchors } = await store.listWithAnchors(address, address.topicKey);
    const existing = anchors[0];
    requireMatchingAnchor(existing, address);
    const canImprovePrompt =
      rootPromptPreview?.trim() &&
      (!existing?.rootPromptText || existing.rootPromptText === existing.title);
    if (existing && !canImprovePrompt) return { anchor: existing, changed: false };
    const anchor = await store.upsertAnchor(
      topicAnchorInput(address, task, rootPromptPreview),
      assertCurrent,
      tasks,
    );
    return { anchor, changed: true };
  }

  function resumeDecision(
    workspaceId: string,
    record: StoredTopicDecision,
    entry: TopicThreadEntry,
    delivery: TopicDelivery,
  ): TopicDecisionDispatch {
    const versioned =
      record.input.expectedBlockingQuestionGeneration !== undefined ||
      record.input.resolutionKind === "task_blocking_question";
    const validateTask: TopicDecisionGuard["validateTask"] = (items) => {
      const current = items.find((item) => item.taskId === record.taskId);
      if (
        record.input.resolutionKind === "durable_item" &&
        !canDeliverDurableDecision(record, current)
      )
        throw new SupersededDurableDecisionError();
      if (
        !record.task ||
        current?.createdAt !== record.taskCreatedAt ||
        current.rootMessageId !== record.rootMessageId ||
        current.status === "canceled" ||
        current.status === "deferred" ||
        (versioned &&
          (current.blockingQuestion || current.blockingQuestionGeneration !== record.operationId))
      )
        throw new Error("The task changed since this topic decision was recorded.");
    };
    const ledger = taskLedger.withTaskSnapshot?.bind(taskLedger);
    if (!delivery.decisionPrompt || !ledger)
      throw new Error("The original decision cannot be safely delivered.");
    return {
      origin: record.origin,
      decision: entry.decision,
      durableItemRequestId: entry.durableItemRequestId,
      taskCreatedAt: record.taskCreatedAt,
      promptText: delivery.decisionPrompt,
      guard: {
        validateTask,
        commit: (write) =>
          ledger(workspaceId, async (items) => {
            validateTask(items);
            return write();
          }),
      },
    };
  }

  type ReplyAddress = Awaited<ReturnType<typeof resolveReplyAddress>>["address"];
  type SavedDelivery = NonNullable<Awaited<ReturnType<TopicThreadStore["getDelivery"]>>>;

  async function retryAddress(request: WorkspaceTopicReplyRequest, entryId: string) {
    const source = await store.getDelivery(request, { entryId });
    // Only the requested thread address and the attempt ID come from the retry request.
    return {
      type: request.type,
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      topicKey: request.topicKey,
      mainAgentId: request.mainAgentId,
      clientMessageId: request.clientMessageId,
      text: "",
      taskId: source?.entry.taskId,
      rootMessageId: source?.entry.rootMessageId,
    };
  }

  function retryTaskBinding(
    { entry, delivery, promoted }: SavedDelivery,
    address: ReplyAddress,
    task: WorkspaceTask | undefined,
    tasks: readonly WorkspaceTask[],
  ) {
    const ordinary = (entry.origin ?? "topic_reply") === "topic_reply";
    if (promoted && !ordinary) throw new Error("The original topic decision cannot be rebound.");
    if (
      !ordinary ||
      !task?.rootMessageId ||
      address.topicKey !== `task:${task.taskId}` ||
      (!promoted && delivery.taskCreatedAt && !delivery.requiresUniqueTask)
    )
      return;
    if (!taskLedger.withTaskSnapshot)
      throw new Error("The original reply cannot be safely bound to this task.");
    return requireUniqueReplyTask(tasks, task);
  }

  async function requireRetryDelivery(
    topicKey: string,
    entryId: string,
    { address, task, tasks }: Awaited<ReturnType<typeof resolveReplyAddress>>,
  ) {
    if (topicKey.startsWith("msg:") && task) requireUniqueReplyTask(tasks, task);
    const delivery = await store.getDelivery(address, { entryId }, tasks);
    if (!delivery) throw new Error("The original topic follow-up is unavailable.");
    return delivery;
  }

  function verifyDelivery(
    request: WorkspaceTopicReplyRequest,
    decision: TopicDecisionDispatch | undefined,
    retryOfEntryId: string | undefined,
    previous: TopicThreadEntry,
    stored: TopicDelivery,
    task: WorkspaceTask | undefined,
    address: ReplyAddress,
  ) {
    if (
      (!retryOfEntryId &&
        (previous.text !== request.text ||
          (previous.origin ?? "topic_reply") !== (decision?.origin ?? "topic_reply"))) ||
      (stored.taskCreatedAt && task?.createdAt !== stored.taskCreatedAt) ||
      previous.taskId !== address.taskId ||
      previous.rootMessageId !== address.rootMessageId
    )
      throw new Error("The reply no longer belongs to this topic operation.");
  }

  async function prepareRetryAttachments(
    address: ReplyAddress,
    request: WorkspaceTopicReplyRequest,
    replay: SavedDelivery,
    replacements?: WorkspaceTopicReplyRequest["attachments"],
    uploads?: TopicUploadAccess,
  ) {
    const { entry, delivery } = replay;
    if (entry.origin && entry.origin !== "topic_reply") return;
    if (replay.retryAttachments) return;
    const repeat = await store.getDelivery(address, { sourceMessageId: request.clientMessageId });
    if (
      repeat?.retryAttachments ||
      repeat?.entry.status === "completed" ||
      repeat?.entry.status === "error"
    )
      return;
    if (!entry.retryable && (repeat?.entry ?? entry).status !== "queued") return;
    const restored = await restoreTopicRetryAttachments(
      delivery.attachments,
      replacements,
      uploads,
    );
    if (restored === delivery.attachments) return;
    await resolveTopicPromptAttachments(restored, uploads);
    return restored;
  }

  async function prepareDelivery(
    request: WorkspaceTopicReplyRequest,
    decision?: TopicDecisionDispatch,
    uploads?: TopicUploadAccess,
  ) {
    const { workspaceId, topicKey } = request;
    const replacementAttachments = request.retryOfEntryId ? request.attachments : undefined;
    // COMPAT(topicReplyLegacyRetry): v0.18.0 clients used a deterministic retry:<entryId> ID.
    // Remove after the client floor sends retryOfEntryId.
    const legacyRetry = /^retry:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
    const retryOfEntryId = request.retryOfEntryId ?? legacyRetry.exec(request.clientMessageId)?.[1];
    if (retryOfEntryId) {
      if (decision) throw new Error("A repeat delivery requires an existing topic follow-up.");
      request = await retryAddress(request, retryOfEntryId);
    }
    const resolved = await resolveReplyAddress(request, decision);
    const { address, task, tasks } = resolved;
    const replay = retryOfEntryId
      ? await requireRetryDelivery(topicKey, retryOfEntryId, resolved)
      : await store.getDelivery(address, { sourceMessageId: request.clientMessageId });
    let boundRetryTask: WorkspaceTask | undefined;
    let retryAttachments: TopicDelivery["attachments"];
    if (replay) {
      const { entry: previous, delivery: stored, decision: record } = replay;
      verifyDelivery(request, decision, retryOfEntryId, previous, stored, task, address);
      if (retryOfEntryId) {
        boundRetryTask = retryTaskBinding(replay, address, task, tasks);
        retryAttachments = await prepareRetryAttachments(
          address,
          request,
          replay,
          replacementAttachments,
          uploads,
        );
      }
      request = {
        ...request,
        text: previous.text,
        attachments: stored.attachments,
        routeMode: stored.routeMode,
      };
      if (retryOfEntryId && record)
        decision = resumeDecision(workspaceId, record, previous, stored);
    }
    if (!request.text.trim() && !request.attachments?.some((file) => file.type === "uploaded_file"))
      throw new Error("Topic follow-up text is required.");
    const delivery = replay
      ? {
          ...replay.delivery,
          taskCreatedAt: boundRetryTask?.createdAt ?? replay.delivery.taskCreatedAt,
        }
      : {
          routeMode: request.routeMode,
          attachments: request.attachments,
          decisionPrompt: decision?.promptText,
          taskCreatedAt: task?.createdAt,
        };
    return {
      request,
      decision,
      delivery,
      address,
      task,
      tasks,
      retryOfEntryId,
      boundRetryTask,
      retryAttachments,
    };
  }

  return {
    requireMain,
    async list(
      request: WorkspaceTopicListEntriesRequest,
    ): Promise<WorkspaceTopicListEntriesResponse> {
      const { requestId, workspaceId, topicKey } = request;
      const reply = (
        snapshot: Awaited<ReturnType<TopicThreadStore["listWithAnchors"]>>,
        error: string | null,
      ): WorkspaceTopicListEntriesResponse => ({
        type: "workspace.topic.list_entries.response",
        payload: { requestId, workspaceId, ...snapshot, error },
      });
      try {
        await requireMain(request);
        return reply(
          await store.listWithAnchors(request, topicKey, deps.dispatch.wasAccepted),
          null,
        );
      } catch (error) {
        logger.warn({ err: error, workspaceId }, "Could not list topic entries");
        return reply({ entries: [], anchors: [] }, "Could not list topic entries.");
      }
    },
    async reply(
      request: WorkspaceTopicReplyRequest,
      decision?: TopicDecisionDispatch,
      humanInitiated = false,
      uploads?: TopicUploadAccess,
    ): Promise<WorkspaceTopicReplyResponse> {
      const { requestId, workspaceId, topicKey } = request;
      const structured = decision !== undefined;
      const respond = (
        result: Omit<ReplyPayload, "requestId" | "workspaceId" | "topicKey">,
      ): WorkspaceTopicReplyResponse => ({
        type: "workspace.topic.reply.response",
        payload: { requestId, workspaceId, topicKey, ...result },
      });
      try {
        shutdown.signal.throwIfAborted();
        await requireMain(request);
        const {
          request: preparedRequest,
          decision: preparedDecision,
          delivery,
          address,
          task,
          tasks,
          retryOfEntryId,
          boundRetryTask,
          retryAttachments,
        } = await prepareDelivery(request, decision, uploads);
        request = preparedRequest;
        decision = preparedDecision;
        const route = await selectRoute(request, task, deps);
        const write = async (retryTasks?: readonly WorkspaceTask[]) => {
          const anchorWrite = await ensureReplyAnchor(
            address,
            task,
            retryTasks ?? tasks,
            request.rootPromptPreview,
            decision?.guard?.assertCurrent,
          );
          const result = await store.begin(
            {
              ...address,
              // AgentManager uses the submitted client ID as the canonical user message ID.
              sourceMessageId: request.clientMessageId,
              routedAgentId: route.targetAgentId,
              text: request.text,
              origin: decision?.origin ?? "topic_reply",
              durableItemRequestId: decision?.durableItemRequestId,
              decision: decision?.decision,
            },
            deps.dispatch.wasAccepted,
            decision?.guard?.assertCurrent,
            delivery,
            retryOfEntryId,
            retryTasks,
            retryAttachments,
          );
          return { ...result, anchorWrite };
        };
        const claim = async () => {
          if (decision?.guard) return decision.guard.commit(write);
          if (boundRetryTask && taskLedger.withTaskSnapshot)
            return taskLedger.withTaskSnapshot(workspaceId, (currentTasks) => {
              requireUniqueReplyTask(currentTasks, boundRetryTask);
              return write(currentTasks);
            });
          return write();
        };
        const {
          entry,
          changed,
          release,
          anchorWrite,
          sourceUpdate,
          retryAttachments: claimedAttachments,
        } = await claim();
        if (sourceUpdate) publish(sourceUpdate);
        if (changed || anchorWrite.changed) publish(entry, anchorWrite.anchor);
        if (release) {
          const work = dispatch(
            claimedAttachments ? { ...request, attachments: claimedAttachments } : request,
            entry,
            route,
            humanInitiated,
            uploads,
            decision,
            delivery.taskCreatedAt,
            boundRetryTask,
          ).catch((error) => {
            logger.warn({ err: error, entryId: entry.entryId }, "Could not persist topic result");
          });
          inFlight.add(work);
          void work.finally(() => {
            release();
            inFlight.delete(work);
          });
        }
        return respond({
          ...(entry.routedAgentId === route.targetAgentId
            ? route
            : {
                routedTo: entry.routedAgentId === request.mainAgentId ? "main" : "lead",
                targetAgentId: entry.routedAgentId,
              }),
          entry,
          error: null,
        });
      } catch (error) {
        if (error instanceof TopicDecisionError && structured) throw error;
        if (
          error instanceof SupersededDurableDecisionError ||
          error instanceof TopicAttachmentsReuploadRequired
        )
          return respond({
            routedTo: "main",
            targetAgentId: null,
            entry: null,
            error: error.message,
          });
        logger.warn({ err: error, workspaceId }, "Could not queue topic reply");
        return respond({
          routedTo: "main",
          targetAgentId: null,
          entry: null,
          error: "Could not queue topic reply.",
        });
      }
    },
    async close() {
      shutdown.abort();
      await Promise.allSettled(inFlight);
    },
  };
}

export type TopicReplyRouter = ReturnType<typeof createTopicReplyRouter>;

export function createTopicPromptDispatcher({
  agentManager,
  agentStorage,
  logger,
}: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}): DispatchTopicPrompt {
  async function readReplyMessageId(agentId: string, turnId: string): Promise<string | undefined> {
    const findReplyId = (rows: readonly AgentTimelineRow[]) => {
      const row = rows.findLast(
        ({ turnId: id, item }) =>
          id === turnId && item.type === "assistant_message" && item.text.trim(),
      );
      if (row?.item.type === "assistant_message")
        return row.item.messageId || row.providerMessageId;
    };
    try {
      if (agentManager.getAgent(agentId)) {
        const id = findReplyId(agentManager.fetchTimeline(agentId, { limit: 0 }).rows);
        if (id) return id;
        const committedId = findReplyId(await agentManager.getTimelineRows(agentId));
        if (committedId) return committedId;
      }
    } catch (error) {
      logger.warn({ err: error, agentId, turnId }, "Could not read topic reply timeline");
    }
    try {
      const record = await agentStorage.get(agentId);
      if (record)
        return findReplyId((await agentManager.readStoredTimeline(record, { limit: 0 })).rows);
    } catch (error) {
      logger.warn({ err: error, agentId, turnId }, "Could not read stored topic reply timeline");
    }
  }

  const dispatch: DispatchTopicPrompt = async ({
    agentId,
    messageId,
    scope,
    prompt,
    imageAttachments,
    validate,
    onHandoff,
    onStarted,
    signal,
  }) => {
    const turn = pendingResult<TopicTurnOutcome>();
    void turn.promise.catch(() => {});
    let turnId: string | undefined;
    let lastAssistantMessage: { text: string; messageId?: string } | undefined;
    const abort = () => turn.reject(signal.reason);
    const finish = (completedId: string) => {
      const agent = agentManager.getAgent(agentId);
      const completion = agent?.lastTurnCompletion;
      const text =
        (completion?.event.turnId === completedId ? completion.lastMessage : null) ??
        lastAssistantMessage?.text;
      turn.resolve({
        reply: text
          ? {
              text,
              sourceMessageId: lastAssistantMessage?.messageId,
              authorTitle: agent?.config.title ?? undefined,
            }
          : undefined,
        touchedFiles: scope.taskId ? agentManager.getTurnTouchedFiles(agentId, completedId) : [],
      });
    };
    const unsubscribe = agentManager.subscribe(
      (event) => {
        if (event.type === "agent_removed") {
          turn.reject(new Error("The topic recipient was removed."));
          return;
        }
        if (event.type !== "agent_stream") return;
        const stream = event.event;
        if (
          stream.type === "timeline" &&
          stream.item.type === "user_message" &&
          stream.item.clientMessageId === messageId &&
          stream.turnId
        ) {
          turnId = stream.turnId;
        }
        if (!turnId || getAgentStreamEventTurnId(stream) !== turnId) return;
        if (stream.type === "timeline" && stream.item.type === "assistant_message")
          lastAssistantMessage = stream.item;
        if (stream.type === "turn_completed") {
          finish(turnId);
        } else if (stream.type === "turn_failed" || stream.type === "turn_canceled") {
          turn.reject(new Error("The topic follow-up turn did not complete."));
        }
      },
      { agentId, replayState: false },
    );
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        await validate();
        let handedOff = false;
        let unavailable: TopicLeadUnavailableError | undefined;
        const validateAttempt = async () => {
          try {
            await validate();
          } catch (error) {
            if (error instanceof TopicLeadUnavailableError) unavailable = error;
            throw error;
          }
        };
        try {
          let prepared = false;
          const dispatched = await sendPromptToAgent({
            agentManager,
            agentStorage,
            agentId,
            prompt,
            messageId,
            runOptions: { ...topicFollowupRunOptions(scope), imageAttachments },
            logger,
            idleOnly: true,
            unarchive: false,
            validateDispatch: validateAttempt,
            handoff: {
              begin: async () => {
                await onHandoff(true);
                handedOff = true;
              },
              declined: async () => {
                if (!handedOff) return;
                await onHandoff(false);
                handedOff = false;
              },
            },
            assertDispatchAllowed: () => signal.throwIfAborted(),
            beforeDispatch: async () => {
              await validateAttempt();
              prepared = true;
            },
          });
          if (!prepared || dispatched.disposition !== "turn_started")
            throw new Error("Topic follow-up did not start a new turn.");
          await waitForAgentRunStartWithTimeout(agentManager, agentId, dispatched.started, signal);
          await onStarted();
          const outcome = await turn.promise;
          if (!turnId || !outcome.reply || outcome.reply.sourceMessageId) return outcome;

          // A trailing chunk can omit the ID carried by the projected message it extends.
          const sourceMessageId = await readReplyMessageId(agentId, turnId);
          return sourceMessageId
            ? { ...outcome, reply: { ...outcome.reply, sourceMessageId } }
            : outcome;
        } catch (error) {
          if ((handedOff || turnId) && error instanceof TopicLeadUnavailableError)
            throw new Error("Topic routing changed after provider handoff.", { cause: error });
          if (handedOff || turnId) throw error;
          signal.throwIfAborted();
          if (unavailable) throw unavailable;
          // Loading and foreground reservation can race with archive or removal.
          // Revalidate errors and the archived no-op before considering another target.
          await validate();
          if (error instanceof AgentNotFoundError || error instanceof QueuedPromptLoadError) {
            throw new TopicLeadUnavailableError("The topic recipient could not be loaded.", {
              cause: error,
            });
          }
          if (!(error instanceof AgentTurnBusyError)) throw error;
          await waitForIdle(agentManager, agentId, validate, signal);
        }
      }
    } finally {
      signal.removeEventListener("abort", abort);
      unsubscribe();
    }
  };
  dispatch.wasAccepted = async ({ routedAgentId, entryId, sourceMessageId }) => {
    const matches = ({ item, providerMessageId, turnId }: AgentTimelineRow) =>
      item.type === "user_message" &&
      // A rejected submission has a client ID but never has a provider turn.
      (!!turnId || !item.clientMessageId) &&
      [item.clientMessageId, item.messageId, providerMessageId].some(
        (id) => id && (id === entryId || id === sourceMessageId),
      );
    if (agentManager.getAgent(routedAgentId))
      return (await agentManager.getTimelineRows(routedAgentId)).some(matches);
    const record = await agentStorage.get(routedAgentId);
    if (!record) return false;
    return (await agentManager.readStoredTimeline(record, { limit: 0 })).rows.some(matches);
  };
  return dispatch;
}

async function waitForIdle(
  manager: AgentManager,
  agentId: string,
  validate: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const idle = pendingResult<void>();
  let checking = false;
  let recheck = false;
  let stopped = false;
  const check = () => {
    recheck = true;
    if (checking) return;
    checking = true;
    void (async () => {
      while (recheck) {
        if (stopped) return;
        recheck = false;
        await validate();
        if (!manager.hasInFlightRun(agentId)) {
          idle.resolve();
          return;
        }
      }
    })()
      .catch(idle.reject)
      .finally(() => {
        checking = false;
        if (recheck && !stopped) check();
      });
  };
  const unsubscribe = manager.subscribe(
    (event) => {
      if (event.type === "agent_removed") idle.resolve();
      else if (event.type === "agent_state") check();
    },
    { agentId, replayState: false },
  );
  const abort = () => idle.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    check();
    await idle.promise;
  } finally {
    stopped = true;
    unsubscribe();
    signal.removeEventListener("abort", abort);
  }
}
