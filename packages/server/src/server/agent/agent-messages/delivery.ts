import { AgentTurnBusyError, type PromptDispatchDisposition } from "../agent-prompt.js";
import { randomUUID } from "node:crypto";
import type { AgentPromptInput, AgentPromptContentBlock } from "../agent-sdk-types.js";
import { prepareAgentMessage, type AgentPromptSource } from "./envelope.js";
import type { QueueHandoff } from "../../message-receipts/index.js";

interface Message {
  recipientId: string;
  messageId?: string;
  source: AgentPromptSource;
  /** A verified child report can wake its parent without changing its displayed message kind. */
  childReported?: boolean;
  prompt: AgentPromptInput;
  sessionMode?: string;
  unarchive?: boolean;
  clearPendingPermissions?: boolean;
  activeTurnBehavior?: "steer" | "interrupt";
  beforeDispatch?: () => void;
  /** Recheck mutable sender authority when the message leaves the queue. */
  validateDispatch?: () => Promise<void>;
  beforeProviderDispatch?: () => Promise<void>;
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
  handoff?: QueueHandoff;
}
interface Dependencies {
  /** Includes admitted starts and provider turns, including compaction. */
  isRunning?: (recipientId: string) => boolean;
  hasPendingPermission?: (recipientId: string) => boolean;
  /** Notify when recipient state changes; admission still checks whether it is idle. */
  subscribe?: (listener: (recipientId: string) => void) => () => void;
  tryRunOutOfBand?(
    request: DispatchRequest,
    onAccepted: () => void | Promise<void>,
  ): Promise<boolean>;
  dispatch(request: DispatchRequest): Promise<PromptDispatchDisposition>;
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
  const dispatching = new Map<string, Promise<void>>();
  const admitted = new Map<string, Set<Admitted>>();
  let sequence = 0;
  let closed = false;
  let admissionPaused = false;
  let closing: Promise<void> | undefined;

  const isWithdrawn = (message: Admitted): boolean => message.state === "withdrawn";
  const draining = () => admissionPaused || closed;
  const preparing = () => admissionPaused && !closed;

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
            async begin() {
              for (const message of messages) await message.handoff?.begin();
            },
            async declined() {
              for (const message of messages) await message.handoff?.declined();
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
      validateDispatch: messages[0]!.validateDispatch,
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
          requeue(recipientId, messages);
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
          const accepted = await dependencies.tryRunOutOfBand!(request, async () => {
            if (!request.admit()) throw new Error("Queued agent message was withdrawn");
            message.beforeDispatch?.();
            await request.handoff?.begin();
            await request.validateDispatch?.();
          });
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
      if (
        group.length &&
        ((message.activeTurnBehavior ?? "steer") !== (group[0]!.activeTurnBehavior ?? "steer") ||
          (mode && message.sessionMode && mode !== message.sessionMode) ||
          group[0]!.validateDispatch ||
          message.validateDispatch ||
          group[0]!.beforeProviderDispatch ||
          message.beforeProviderDispatch)
      ) {
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

  async function drain(): Promise<void> {
    for (const recipientId of pending.keys()) flush(recipientId);
    // Receipts include messages that an in-flight dispatch may put back in the queue.
    await Promise.allSettled(
      [...admitted.values()].flatMap((owned) =>
        [...owned].map((message) => message.receipt.dispatched),
      ),
    );
  }
  const unsubscribe = dependencies.subscribe?.((recipientId) => {
    if (pending.get(recipientId)?.ready && !dependencies.isRunning?.(recipientId))
      flush(recipientId);
  });

  return {
    withdrawPending: (recipientId, matches) =>
      withdrawPending(recipientId, (message) => matches(message.source)),
    hasPending: (recipientId) => pending.has(recipientId) || dispatching.has(recipientId),
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
      const entry = pending.get(message.recipientId) ?? {
        messages: [],
        ready: false,
        cancel: () => {},
      };
      entry.cancel();
      entry.ready = false;
      entry.messages.push(item);
      entry.cancel = schedule(2000, () => flush(message.recipientId));
      pending.set(message.recipientId, entry);
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
