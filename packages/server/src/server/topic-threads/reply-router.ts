import type {
  TopicThreadEntry,
  WorkspaceTopicListEntriesRequest,
  WorkspaceTopicListEntriesResponse,
  WorkspaceTopicReplyRequest,
  WorkspaceTopicReplyResponse,
  WorkspaceTopicThreadUpdatedMessage,
} from "@getpaseo/protocol/messages";
import { isMainControlAgentLabels } from "@getpaseo/protocol/agent-labels";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
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
import type { WorkspaceTask, WorkspaceTaskLedgerStore } from "../agent/task-ledger/index.js";
import { isLocalTaskChild } from "../agent/task-ledger/reuse.js";
import type { TopicAgentReply, TopicThreadStore } from "./store.js";

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

type DispatchTopicPrompt = ((input: {
  agentId: string;
  messageId: string;
  prompt: AgentPromptInput;
  validate: () => Promise<void>;
  onHandoff: (pending: boolean) => Promise<void>;
  onStarted: () => Promise<void>;
  signal: AbortSignal;
}) => Promise<TopicAgentReply | undefined>) & {
  wasAccepted?: (entry: TopicThreadEntry) => Promise<boolean>;
};

class TopicLeadUnavailableError extends AgentTurnStartRejectedError {}

class TopicRouteChangedError extends TopicLeadUnavailableError {
  constructor(readonly route: Route) {
    super("The topic's lead routing changed before delivery.");
  }
}

interface RouterDependencies {
  serverId: string;
  store: TopicThreadStore;
  taskLedger: Pick<WorkspaceTaskLedgerStore, "list" | "updateLatestReplyPreview">;
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
    if (!inWorkspace(main, workspaceId) || !isMainControlAgentLabels(main.labels))
      throw new Error("Workspace Main Control is unavailable.");
  }

  function publish(entry: TopicThreadEntry) {
    try {
      deps.broadcast({
        type: "workspace.topic.thread.updated",
        payload: { workspaceId: entry.workspaceId, mainAgentId: entry.mainAgentId, entry },
      });
    } catch (error) {
      logger.warn({ err: error, entryId: entry.entryId }, "Could not broadcast topic update");
    }
  }

  async function dispatch(
    request: WorkspaceTopicReplyRequest,
    entry: TopicThreadEntry,
    route: Route,
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
      return taskId
        ? tasks.find((task) => task.taskId === taskId)
        : tasks.findLast((task) => task.rootMessageId === rootMessageId);
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
    const send = (target: Route) =>
      deps.dispatch({
        agentId: target.targetAgentId,
        messageId: entry.sourceMessageId ?? entryId,
        prompt: buildAgentPrompt(
          topicContext(entry, target.fallbackReason) + request.text,
          undefined,
          request.attachments,
        ),
        validate: async () => {
          await requireMain(request);
          if (target.fallbackReason === "explicit_main") return;
          const current = await readRoute();
          if (
            current.targetAgentId !== target.targetAgentId ||
            current.fallbackReason !== target.fallbackReason
          )
            throw new TopicRouteChangedError(current);
        },
        onHandoff: (pending) => store.setHandoffPending(workspaceId, entryId, pending),
        onStarted: async () => {
          for (const update of await store.update(workspaceId, entryId, "running")) publish(update);
        },
        signal: shutdown.signal,
      });
    let reply: TopicAgentReply | undefined;
    try {
      let target = route;
      for (;;) {
        shutdown.signal.throwIfAborted();
        try {
          reply = await send(target);
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
      for (const update of await store.update(workspaceId, entryId, "error")) publish(update);
      return;
    }
    for (const update of await store.update(workspaceId, entryId, "completed", reply))
      publish(update);
    if (entry.taskId && reply?.text) {
      const preview = Array.from(reply.text.replace(/\s+/g, " ").trim()).slice(0, 240).join("");
      await taskLedger.updateLatestReplyPreview(workspaceId, entry.taskId, preview);
    }
  }

  return {
    async list(
      request: WorkspaceTopicListEntriesRequest,
    ): Promise<WorkspaceTopicListEntriesResponse> {
      const { requestId, workspaceId, topicKey } = request;
      const reply = (
        entries: TopicThreadEntry[],
        error: string | null,
      ): WorkspaceTopicListEntriesResponse => ({
        type: "workspace.topic.list_entries.response",
        payload: { requestId, workspaceId, entries, error },
      });
      try {
        await requireMain(request);
        return reply(await store.list(request, topicKey), null);
      } catch (error) {
        logger.warn({ err: error, workspaceId }, "Could not list topic entries");
        return reply([], "Could not list topic entries.");
      }
    },
    async reply(request: WorkspaceTopicReplyRequest): Promise<WorkspaceTopicReplyResponse> {
      const { requestId, workspaceId, topicKey } = request;
      const respond = (
        result: Omit<ReplyPayload, "requestId" | "workspaceId" | "topicKey">,
      ): WorkspaceTopicReplyResponse => ({
        type: "workspace.topic.reply.response",
        payload: { requestId, workspaceId, topicKey, ...result },
      });
      try {
        shutdown.signal.throwIfAborted();
        await requireMain(request);
        if (!request.text.trim()) throw new Error("Topic follow-up text is required.");
        const tasks =
          request.taskId || request.rootMessageId ? await taskLedger.list(workspaceId) : [];
        const task = request.taskId
          ? tasks.find((item) => item.taskId === request.taskId)
          : tasks.findLast((item) => item.rootMessageId === request.rootMessageId);
        if (
          task?.rootMessageId &&
          request.rootMessageId &&
          task.rootMessageId !== request.rootMessageId
        )
          throw new Error("The task does not belong to this topic.");
        const route = await selectRoute(request, task, deps);
        const { entry, changed, release } = await store.begin(
          {
            workspaceId,
            mainAgentId: request.mainAgentId,
            topicKey,
            taskId: task?.taskId ?? request.taskId,
            rootMessageId: task?.rootMessageId ?? request.rootMessageId,
            // AgentManager uses the submitted client ID as the canonical user message ID.
            sourceMessageId: request.clientMessageId,
            routedAgentId: route.targetAgentId,
            text: request.text,
          },
          deps.dispatch.wasAccepted,
        );
        if (changed) publish(entry);
        if (release) {
          const work = dispatch(request, entry, route).catch((error) => {
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
    prompt,
    validate,
    onHandoff,
    onStarted,
    signal,
  }) => {
    const turn = pendingResult<TopicAgentReply | undefined>();
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
      turn.resolve(
        text
          ? {
              text,
              sourceMessageId: lastAssistantMessage?.messageId,
              authorTitle: agent?.config.title ?? undefined,
            }
          : undefined,
      );
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
          const reply = await turn.promise;
          if (!turnId || !reply || reply.sourceMessageId) return reply;

          // A trailing chunk can omit the ID carried by the projected message it extends.
          const sourceMessageId = await readReplyMessageId(agentId, turnId);
          return sourceMessageId ? { ...reply, sourceMessageId } : reply;
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
