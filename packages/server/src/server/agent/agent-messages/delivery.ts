import { AgentTurnBusyError, type PromptDispatchDisposition } from "../agent-prompt.js";
import { randomUUID } from "node:crypto";
import type {
  AgentCommandOutcome,
  AgentPromptInput,
  AgentPromptContentBlock,
} from "../agent-sdk-types.js";
import { prepareAgentMessage, type AgentPromptSource } from "./envelope.js";
import type { QueueHandoff } from "../../message-receipts/index.js";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";

type InboxSummary = NonNullable<AgentSnapshotPayload["pendingSubagentInbox"]>;
type ChildSource = Extract<AgentPromptSource, { kind: "agent-message" | "agent-notification" }>;

interface Message {
  recipientId: string;
  messageId?: string;
  source: AgentPromptSource;
  /** A verified child report can wake its parent without changing its displayed message kind. */
  childReported?: boolean;
  subagentInbox?: "ordinary" | "urgent";
  prompt: AgentPromptInput;
  sessionMode?: string;
  unarchive?: boolean;
  clearPendingPermissions?: boolean;
  activeTurnBehavior?: "steer" | "interrupt";
  beforeDispatch?: () => void;
  /** Recheck mutable sender authority when the message leaves the queue. */
  validateDispatch?: () => Promise<void>;
  beforeProviderDispatch?: () => Promise<void>;
  waitForProviderOutcome?: boolean;
  handoff?: QueueHandoff;
  onDispatch?: (disposition: PromptDispatchDisposition) => void;
}
interface Receipt {
  status: "queued";
  messageId: string;
  dispatched: Promise<PromptDispatchDisposition>;
}
interface Admitted extends Message {
  sequence: number;
  state: "queued" | "claimed" | "withdrawn";
  outOfBandDeclined: boolean;
  drainSteerDeclined?: boolean;
  dispatchFailure?: { error: unknown };
  receipt: Receipt;
  resolve(disposition: PromptDispatchDisposition): void;
  reject(error: unknown): void;
}
interface DispatchRequest {
  recipientId: string;
  messageIds: readonly string[];
  shouldReportUpward: boolean;
  prompt: AgentPromptInput;
  activeTurnBehavior: "steer" | "interrupt";
  idleOnly: boolean;
  canSteerDuringDrain?: () => boolean;
  /** Claim this exact prompt at provider admission. A withdrawn message invalidates the batch. */
  admit(): boolean;
  sessionMode?: string;
  clearPendingPermissions: boolean;
  unarchive: boolean;
  validateDispatch?: () => Promise<void>;
  beforeProviderDispatch(): Promise<void>;
  waitForProviderOutcome: boolean;
  handoff?: QueueHandoff;
}
interface ParentNotificationAddress {
  callerAgentId: string;
  childAgentId: string;
  serverId?: string;
}
interface Dependencies {
  shouldHoldInbox?(recipientId: string, source?: ChildSource): boolean;
  onInboxChange?(recipientId: string): void;
  classifyInbox?(recipientId: string, source: ChildSource): Promise<Message["subagentInbox"]>;
  /** Includes admitted starts and provider turns, including compaction. */
  isRunning?: (recipientId: string) => boolean;
  hasPendingPermission?: (recipientId: string) => boolean;
  /** Notify when recipient state changes; admission still checks whether it is idle. */
  subscribe?: (
    listener: (recipientId: string, releaseInboxForRecipient?: boolean) => void,
  ) => () => void;
  tryRunOutOfBand?(
    request: DispatchRequest,
    onAccepted: () => void | Promise<void>,
    commandDispatch?: {
      waitForProviderOutcome?: boolean;
      onProviderOutcome?: (outcome: AgentCommandOutcome) => Promise<void>;
    },
  ): Promise<boolean>;
  dispatch(request: DispatchRequest): Promise<PromptDispatchDisposition>;
  validateParentOwnership?(address: ParentNotificationAddress): Promise<void>;
  onError(error: unknown, request: DispatchRequest): void;
  /** Return a cancellation function. Production uses the daemon's event loop. */
  schedule?: (delayMs: number, callback: () => void) => () => void;
}
export class AgentMessageAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentMessageAdmissionError";
  }
}

export interface AgentMessageDelivery {
  enqueue(message: Message): Receipt;
  getInbox?(recipientId: string): InboxSummary | undefined;
  flushInbox?(recipientId: string): void;
  refreshInbox?(releaseRecipientId?: string): void;
  withdrawInboxReport?(recipientId: string, messageId: string, sender?: ChildSource): void;
  classifyInbox?: Dependencies["classifyInbox"];
  observeRemoteChild?(parentId: string, serverId: string, childId: string, active: boolean): void;
  isRemoteFinishSuperseded?(address: ParentNotificationAddress, messageId: string): boolean;
  validateParentOwnership?(address: ParentNotificationAddress): Promise<void>;
  /** Remove matching messages that the queue still owns before dispatcher handoff. */
  withdrawPending(recipientId: string, matches: (source: AgentPromptSource) => boolean): number;
  /** Queued messages and provider dispatches still owned by this recipient. */
  hasPending(recipientId: string): boolean;
  /** Stop admission, flush pending messages, and await provider dispatch acknowledgments. */
  close(options?: { deferWith?: Error }): Promise<void>;
  /** Completion waits include admitted messages, but return at permission checkpoints. */
  waitForDispatch(recipientId: string, signal: AbortSignal): Promise<void>;
}

/** Recipient-owned agent delivery. Human prompts never enter this module. */
export function createAgentMessageDelivery(dependencies: Dependencies): AgentMessageDelivery & {
  pauseAdmission(): { drained: Promise<void>; release(): void };
} {
  const schedule =
    dependencies.schedule ??
    ((delayMs, callback) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
  const pending = new Map<string, { messages: Admitted[]; ready: boolean; cancel(): void }>();
  const inboxes = new Map<string, Admitted[]>();
  const dispatching = new Map<string, Promise<void>>();
  const admitted = new Map<string, Set<Admitted>>();
  let sequence = 0;
  let closed = false;
  let admissionPaused = false;
  let closing: Promise<void> | undefined;

  const isWithdrawn = (message: Admitted): boolean => message.state === "withdrawn";
  const draining = () => admissionPaused || closed;
  const preparing = () => admissionPaused && !closed;

  function queue(recipientId: string, messages: Admitted[]): void {
    const entry = pending.get(recipientId) ?? { messages: [], ready: false, cancel: () => {} };
    entry.cancel();
    entry.ready = false;
    entry.messages.push(...messages);
    entry.messages.sort((a, b) => a.sequence - b.sequence);
    entry.cancel = schedule(2000, () => flush(recipientId));
    pending.set(recipientId, entry);
  }

  function releaseInbox(recipientId: string, arriving: Admitted[] = []): void {
    const backlog = inboxes.get(recipientId);
    if (!backlog) {
      if (arriving.length) queue(recipientId, arriving);
      return;
    }
    inboxes.delete(recipientId);
    const released = [...backlog, ...arriving];
    // Join the ready queue together so an intervening message cannot split the
    // accumulated reports and the urgent report that released them.
    for (const message of released) message.sequence = sequence++;
    queue(recipientId, released);
    dependencies.onInboxChange?.(recipientId);
  }

  function refreshInbox(releaseRecipientId?: string): void {
    if (closed || admissionPaused) return;
    for (const [recipientId, backlog] of inboxes)
      if (
        recipientId === releaseRecipientId ||
        backlog.some(
          ({ source }) =>
            source.kind !== "change-request-update" &&
            !dependencies.shouldHoldInbox?.(recipientId, source),
        )
      )
        releaseInbox(recipientId);
  }

  function checkMessages(
    messages: Admitted[],
    check: (message: Admitted) => Promise<void> | undefined,
  ): () => Promise<void> {
    return async () => {
      for (const message of messages) {
        try {
          await check(message);
        } catch (error) {
          if (messages.length > 1 && message.subagentInbox) {
            // A failed source recheck must not discard the other reports.
            message.state = "withdrawn";
            message.dispatchFailure = { error };
          }
          throw error;
        }
      }
    };
  }

  function rejectFailedMembers(messages: Admitted[]): void {
    for (const message of messages)
      if (message.dispatchFailure) message.reject(message.dispatchFailure.error);
  }

  function maySteerDuringDrain(message: Admitted): boolean {
    // A request that needs a different session mode must wait for its own turn.
    return (
      preparing() &&
      message.activeTurnBehavior !== "interrupt" &&
      !message.sessionMode &&
      !message.drainSteerDeclined
    );
  }

  function requestFor(recipientId: string, messages: Admitted[]): DispatchRequest {
    const prompts = messages.map(
      (message) =>
        prepareAgentMessage(message.prompt, message.source, message.receipt.messageId).prompt,
    );
    const prompt: AgentPromptInput = prompts.every((entry) => typeof entry === "string")
      ? prompts.join("\n\n")
      : prompts.flatMap((entry): AgentPromptContentBlock[] =>
          typeof entry === "string" ? [{ type: "text", text: entry }] : entry,
        );
    return {
      handoff: messages.some((message) => message.handoff)
        ? {
            begin: checkMessages(messages, (message) => message.handoff?.begin()),
            async declined() {
              for (const message of messages) await message.handoff?.declined();
            },
            async onProviderOutcome(outcome: AgentCommandOutcome) {
              for (const message of messages) await message.handoff?.onProviderOutcome?.(outcome);
            },
          }
        : undefined,
      recipientId,
      idleOnly: !closed && messages[0]!.activeTurnBehavior !== "interrupt",
      canSteerDuringDrain: messages.every(maySteerDuringDrain) ? preparing : undefined,
      admit() {
        if (messages.some(isWithdrawn)) return false;
        for (const message of messages) message.state = "claimed";
        return true;
      },
      messageIds: messages.map((message) => message.receipt.messageId),
      shouldReportUpward: messages.some(
        ({ childReported, source }) =>
          childReported ||
          (source.kind === "agent-notification" && source.event !== "permission-required"),
      ),
      prompt,
      activeTurnBehavior: messages[0]!.activeTurnBehavior ?? "steer",
      sessionMode: messages.find((message) => message.sessionMode)?.sessionMode,
      clearPendingPermissions: messages.some((message) => message.clearPendingPermissions),
      unarchive: messages.some((message) => message.unarchive !== false),
      validateDispatch: messages.some((message) => message.validateDispatch)
        ? checkMessages(messages, (message) => message.validateDispatch?.())
        : undefined,
      waitForProviderOutcome: messages.some((message) => message.waitForProviderOutcome === true),
      async beforeProviderDispatch() {
        for (const message of messages) await message.beforeProviderDispatch?.();
      },
    };
  }

  function withdraw(message: Admitted): void {
    message.state = "withdrawn";
    message.reject(new DOMException("Agent message withdrawn", "AbortError"));
  }

  function withdrawPending(recipientId: string, matches: (message: Admitted) => boolean): number {
    let removed = 0;
    for (const message of admitted.get(recipientId) ?? []) {
      if (message.state !== "queued" || !matches(message)) continue;
      withdraw(message);
      removed++;
    }
    const entry = pending.get(recipientId);
    if (entry && removed) {
      entry.messages = entry.messages.filter((message) => !isWithdrawn(message));
      if (!entry.messages.length) {
        entry.cancel();
        pending.delete(recipientId);
      }
    }
    const backlog = inboxes.get(recipientId);
    if (backlog && removed) {
      const retained = backlog.filter((message) => !isWithdrawn(message));
      if (retained.length !== backlog.length) {
        if (retained.length) inboxes.set(recipientId, retained);
        else inboxes.delete(recipientId);
        dependencies.onInboxChange?.(recipientId);
      }
    }
    return removed;
  }

  async function dispatchRequest(request: DispatchRequest, messages: Admitted[]) {
    try {
      return await dependencies.dispatch(request);
    } catch (error) {
      if (
        !(error instanceof AgentTurnBusyError) ||
        !request.idleOnly ||
        request.canSteerDuringDrain ||
        !closed ||
        messages.some(isWithdrawn)
      )
        throw error;
      // Legacy queue closure can flush a dispatch started before close. A
      // shutdown steer that was declined must never use this replacement path.
      return await dependencies.dispatch({ ...request, idleOnly: false });
    }
  }

  function dispatch(recipientId: string, batch: Admitted[]): void {
    queueDispatch(recipientId, async () => {
      const messages = batch.filter((message) => message.state === "queued");
      if (!messages.length) return;
      const request = requestFor(recipientId, messages);
      try {
        await request.validateDispatch?.();
        for (const message of messages) message.beforeDispatch?.();
        const disposition = await dispatchRequest(request, messages);
        for (const message of messages) {
          message.state = "claimed";
          try {
            message.onDispatch?.(disposition);
          } catch (error) {
            dependencies.onError(error, request);
          }
          message.resolve(disposition);
        }
        return undefined;
      } catch (error) {
        if (messages.some(isWithdrawn)) {
          try {
            if (messages.some((message) => message.subagentInbox))
              await request.handoff?.declined();
          } finally {
            rejectFailedMembers(messages);
            requeue(recipientId, messages);
          }
          return;
        }
        if (error instanceof AgentTurnBusyError && !closed) {
          if (request.canSteerDuringDrain && preparing()) {
            for (const message of messages) message.drainSteerDeclined = true;
          }
          requeue(recipientId, messages);
          return;
        }
        for (const message of messages) message.reject(error);
        dependencies.onError(error, request);
        throw error;
      }
    });
  }

  function queueDispatch(recipientId: string, operation: () => Promise<void>): void {
    const previous = dispatching.get(recipientId) ?? Promise.resolve();
    const dispatched = previous.catch(() => undefined).then(operation);
    dispatching.set(recipientId, dispatched);
    void dispatched
      .finally(() => {
        if (dispatching.get(recipientId) !== dispatched) return;
        dispatching.delete(recipientId);
        if (draining()) flush(recipientId);
      })
      .catch(() => undefined);
  }

  function requeue(recipientId: string, messages: Admitted[]): void {
    const queued = messages.filter((message) => !isWithdrawn(message));
    if (!queued.length) return;
    for (const message of queued) message.state = "queued";
    const entry = pending.get(recipientId) ?? {
      messages: [],
      ready: true,
      cancel: () => {},
    };
    entry.cancel();
    entry.messages.push(...queued);
    entry.messages.sort((a, b) => a.sequence - b.sequence);
    entry.cancel = schedule(2000, () => flush(recipientId));
    pending.set(recipientId, entry);
  }

  function flush(recipientId: string): void {
    const entry = pending.get(recipientId);
    if (!entry) return;
    // A previous dispatch can still restore an earlier message to the head of the queue.
    if (draining() && dispatching.has(recipientId)) return;
    entry.ready = true;
    entry.cancel();
    if (!closed && dependencies.isRunning?.(recipientId)) {
      const interrupts = entry.messages.filter(
        (message) => message.activeTurnBehavior === "interrupt",
      );
      entry.messages = entry.messages.filter(
        (message) => message.activeTurnBehavior !== "interrupt",
      );
      if (interrupts.length) {
        dispatchGroups(recipientId, interrupts);
        if (preparing() && entry.messages.length) return;
      }
      if (
        dependencies.tryRunOutOfBand &&
        entry.messages.some((message) => canOfferOutOfBand(recipientId, message))
      ) {
        pending.delete(recipientId);
        offerOutOfBand(recipientId, entry.messages);
      } else if (entry.messages[0] && maySteerDuringDrain(entry.messages[0])) {
        const firstWaiting = entry.messages.findIndex((message) => !maySteerDuringDrain(message));
        const messages = entry.messages.splice(
          0,
          firstWaiting < 0 ? entry.messages.length : firstWaiting,
        );
        if (!entry.messages.length) pending.delete(recipientId);
        dispatchGroups(recipientId, messages);
      } else if (entry.messages.length) {
        // A turn can settle after its final state event. Resample within the
        // lifecycle budget if that event still saw the recipient as busy.
        entry.cancel = schedule(admissionPaused ? 100 : 2000, () => flush(recipientId));
      } else {
        pending.delete(recipientId);
      }
      return;
    }
    pending.delete(recipientId);
    dispatchGroups(recipientId, entry.messages);
  }

  function canOfferOutOfBand(recipientId: string, message: Admitted): boolean {
    return (
      !message.outOfBandDeclined &&
      !message.subagentInbox &&
      message.sessionMode === undefined &&
      message.beforeProviderDispatch === undefined &&
      !closed &&
      dependencies.isRunning?.(recipientId) === true
    );
  }

  function offerOutOfBand(recipientId: string, messages: Admitted[]): void {
    queueDispatch(recipientId, async () => {
      const waiting: Admitted[] = [];
      for (const message of messages) {
        if (isWithdrawn(message)) continue;
        if (!canOfferOutOfBand(recipientId, message)) {
          waiting.push(message);
          continue;
        }
        const request = requestFor(recipientId, [message]);
        try {
          await request.validateDispatch?.();
          const accepted = await dependencies.tryRunOutOfBand!(
            request,
            async () => {
              if (!request.admit()) throw new Error("Queued agent message was withdrawn");
              message.beforeDispatch?.();
              await request.handoff?.begin();
              await request.validateDispatch?.();
            },
            {
              waitForProviderOutcome: request.waitForProviderOutcome,
              onProviderOutcome: request.handoff?.onProviderOutcome,
            },
          );
          if (!accepted) {
            message.outOfBandDeclined = true;
            waiting.push(message);
            continue;
          }
          message.state = "claimed";
          try {
            message.onDispatch?.("out_of_band");
          } catch (error) {
            dependencies.onError(error, request);
          }
          message.resolve("out_of_band");
        } catch (error) {
          if (isWithdrawn(message)) continue;
          await request.handoff?.declined();
          message.reject(error);
          dependencies.onError(error, request);
        }
      }
      if (waiting.length) requeue(recipientId, waiting);
      if (pending.get(recipientId)?.ready && !dependencies.isRunning?.(recipientId))
        flush(recipientId);
    });
  }

  function dispatchGroups(recipientId: string, messages: Admitted[]): void {
    const groups: Admitted[][] = [];
    let group: Admitted[] = [];
    let mode: string | undefined;
    for (const message of messages) {
      // Explicitly conflicting send options require separate, ordered dispatches.
      if (group.length && !canBatch(group[0]!, message, mode)) {
        groups.push(group);
        group = [];
        mode = undefined;
      }
      group.push(message);
      mode ??= message.sessionMode;
    }
    if (group.length) groups.push(group);
    let started = false;
    for (const batch of groups) {
      if (started && (draining() || batch[0]!.activeTurnBehavior !== "interrupt")) {
        requeue(recipientId, batch);
      } else {
        dispatch(recipientId, batch);
        started = true;
      }
    }
  }

  function canBatch(first: Admitted, next: Admitted, mode: string | undefined): boolean {
    if ((first.activeTurnBehavior ?? "steer") !== (next.activeTurnBehavior ?? "steer"))
      return false;
    if (mode && next.sessionMode && mode !== next.sessionMode) return false;
    if (first.beforeProviderDispatch || next.beforeProviderDispatch) return false;
    if (first.subagentInbox && next.subagentInbox) return true;
    return !(
      first.subagentInbox ||
      next.subagentInbox ||
      first.validateDispatch ||
      next.validateDispatch
    );
  }

  async function drain(): Promise<void> {
    for (const recipientId of pending.keys()) flush(recipientId);
    // Receipts include messages that an in-flight dispatch may put back in the queue.
    await Promise.allSettled(
      [...admitted.entries()].flatMap(([recipientId, owned]) =>
        [...owned]
          .filter((message) => !inboxes.get(recipientId)?.includes(message))
          .map((message) => message.receipt.dispatched),
      ),
    );
  }
  const unsubscribe = dependencies.subscribe?.((recipientId, releaseInboxForRecipient) => {
    refreshInbox(releaseInboxForRecipient ? recipientId : undefined);
    if (pending.get(recipientId)?.ready && !dependencies.isRunning?.(recipientId))
      flush(recipientId);
  });

  return {
    validateParentOwnership: dependencies.validateParentOwnership,
    classifyInbox: dependencies.classifyInbox,
    withdrawPending: (recipientId, matches) =>
      withdrawPending(recipientId, (message) => matches(message.source)),
    getInbox: (recipientId) => {
      const backlog = inboxes.get(recipientId);
      if (!backlog) return undefined;
      return {
        count: backlog.length,
        items: backlog.flatMap(({ source }) => {
          if (source.kind === "change-request-update") return [];
          return [
            {
              agentId: source.agentId,
              serverId: source.serverId,
              title: source.title,
              event: source.kind === "agent-message" ? "message" : source.event,
              ...(source.kind === "agent-message" && source.reportStatus
                ? { reportStatus: source.reportStatus }
                : {}),
            },
          ];
        }),
      };
    },
    flushInbox: (recipientId) => {
      if (closed || admissionPaused)
        throw new AgentMessageAdmissionError("Agent message delivery is stopping");
      releaseInbox(recipientId);
    },
    refreshInbox,
    withdrawInboxReport: (recipientId, messageId, sender) => {
      withdrawPending(
        recipientId,
        (message) =>
          message.receipt.messageId === messageId &&
          (!sender ||
            (message.source.kind === sender.kind &&
              message.source.agentId === sender.agentId &&
              message.source.serverId === sender.serverId)),
      );
    },
    hasPending: (recipientId) =>
      inboxes.has(recipientId) || pending.has(recipientId) || dispatching.has(recipientId),
    enqueue(message) {
      if (closed) throw new AgentMessageAdmissionError("Agent message delivery is closed");
      if (admissionPaused)
        throw new AgentMessageAdmissionError("Agent message delivery is preparing for shutdown");
      let resolve!: Admitted["resolve"];
      let reject!: Admitted["reject"];
      const dispatched = new Promise<PromptDispatchDisposition>((accepted, failed) => {
        resolve = accepted;
        reject = failed;
      });
      void dispatched.catch(() => undefined);
      const receipt: Receipt = {
        status: "queued",
        messageId: message.messageId ?? randomUUID(),
        dispatched,
      };
      const item: Admitted = {
        ...message,
        receipt,
        resolve,
        reject,
        sequence: sequence++,
        state: "queued",
        outOfBandDeclined: false,
      };
      const owned = admitted.get(message.recipientId) ?? new Set<Admitted>();
      owned.add(item);
      admitted.set(message.recipientId, owned);
      void dispatched
        .finally(() => {
          owned.delete(item);
          if (!owned.size) admitted.delete(message.recipientId);
        })
        .catch(() => undefined);
      if (
        message.subagentInbox === "ordinary" &&
        message.source.kind !== "change-request-update" &&
        dependencies.shouldHoldInbox?.(message.recipientId, message.source)
      ) {
        const backlog = inboxes.get(message.recipientId) ?? [];
        backlog.push(item);
        inboxes.set(message.recipientId, backlog);
        dependencies.onInboxChange?.(message.recipientId);
      } else if (message.subagentInbox) {
        releaseInbox(message.recipientId, [item]);
      } else {
        queue(message.recipientId, [item]);
      }
      return receipt;
    },
    async waitForDispatch(recipientId, signal) {
      signal.throwIfAborted();
      const waiting = Array.from(admitted.get(recipientId) ?? [], (message) =>
        message.receipt.dispatched.catch((error) => {
          if (message.state !== "withdrawn") throw error;
          return undefined;
        }),
      );
      let unsubscribePermission: (() => void) | undefined;
      const permission = new Promise<void>((resolve) => {
        const check = () => {
          if (dependencies.hasPendingPermission?.(recipientId)) resolve();
        };
        unsubscribePermission = dependencies.subscribe?.((agentId) => {
          if (agentId === recipientId) check();
        });
        check();
      });
      let aborted!: () => void;
      const cancellation = new Promise<never>((_resolve, reject) => {
        aborted = () => reject(new DOMException("Wait aborted", "AbortError"));
        signal.addEventListener("abort", aborted, { once: true });
      });
      try {
        await Promise.race([
          Promise.all([dispatching.get(recipientId), ...waiting]),
          cancellation,
          permission,
        ]);
      } finally {
        signal.removeEventListener("abort", aborted);
        unsubscribePermission?.();
      }
    },
    pauseAdmission() {
      admissionPaused = true;
      return {
        drained: drain(),
        release: () => {
          admissionPaused = false;
          refreshInbox();
          for (const messages of admitted.values()) {
            for (const message of messages) message.drainSteerDeclined = false;
          }
        },
      };
    },
    close(options) {
      if (closing) return closing;
      closed = true;
      unsubscribe?.();
      for (const [recipientId, backlog] of inboxes) {
        for (const message of backlog) {
          message.state = "withdrawn";
          message.reject(
            options?.deferWith ?? new AgentMessageAdmissionError("Inbox retained for restart"),
          );
        }
        inboxes.delete(recipientId);
      }
      if (options?.deferWith) {
        // The shutdown budget expired. Cancel work before provider handoff so
        // durable receipts can replay it without replacing the active turn.
        for (const entry of pending.values()) entry.cancel();
        pending.clear();
        for (const messages of admitted.values()) {
          for (const message of messages) {
            if (message.state !== "queued") continue;
            message.state = "withdrawn";
            message.reject(options.deferWith);
          }
        }
        closing = Promise.resolve();
      } else {
        closing = drain();
      }
      return closing;
    },
  };
}
