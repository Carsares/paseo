import {
  attachTaskDispatchMessage,
  runWithTaskDispatchAdmission,
  type TaskDispatchAdmission,
} from "../task-ledger/admission.js";
import {
  AgentRequestOutcomeUnknownError,
  type QueueHandoff,
} from "../../message-receipts/index.js";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";

type InboxSummary = NonNullable<AgentSnapshotPayload["pendingSubagentInbox"]>;
type ChildSource = Extract<AgentPromptSource, { kind: "agent-message" | "agent-notification" }>;

function isChildSource(source: AgentPromptSource): source is ChildSource {
  return source.kind === "agent-message" || source.kind === "agent-notification";
}

import {
  AgentTurnBusyError,
  AgentTurnChangedError,
  QueuedPromptLoadError,
  type PromptDispatchDisposition,
  type PromptDispatchResult,
} from "../agent-prompt.js";
import { PeerRecipientNotReadyError } from "../agent-sdk-types.js";
import { randomUUID } from "node:crypto";
import type {
  AgentCommandOutcome,
  AgentPromptInput,
  AgentPromptContentBlock,
  AgentRunOptions,
} from "../agent-sdk-types.js";
import {
  claimPromptDispatchReservation,
  ensurePeerDispatchEnvironmentReady,
  envelopeMessage,
  flushAllHostPendingPeerOutcomes,
  hasMandatoryPeerDispatchMarker,
  notifyPromptDispatchOutcome,
  prepareAgentMessage,
  verifyMandatoryPeerPromptAtDispatch,
  type AgentPromptSource,
  type PeerDispatchTerminalOutcome,
} from "./envelope.js";
import { describeAgentMessage, type AgentMessageBehavior } from "./guidance.js";

/** A message's quiet window closes this long after the latest arrival. */
const QUIET_MS = 2000;
/** Steady arrivals cannot keep a quiet window open longer than this. */
const MAX_COLLECTING_MS = 10_000;
/** Held subagent inbox reports auto-release no later than this after the first arrival. */
export const MAX_SUBAGENT_INBOX_WAIT_MS = 30_000;

interface Message {
  recipientId: string;
  messageId?: string;
  source: AgentPromptSource;
  childReported?: boolean;
  subagentInbox?: "ordinary" | "urgent";
  validateDispatch?: () => Promise<void>;
  beforeProviderDispatch?: () => Promise<void>;
  waitForProviderOutcome?: boolean;
  handoff?: QueueHandoff;
  heldAfterStop?: boolean;
  prompt: AgentPromptInput;
  sessionMode?: string;
  unarchive?: boolean;
  clearPendingPermissions?: boolean;
  /** Absent: queue. */
  activeTurnBehavior?: AgentMessageBehavior;
  beforeDispatch?: () => void;
  onDispatch?: (disposition: PromptDispatchDisposition) => void;
}
interface Receipt {
  status: "queued";
  messageId: string;
  activeTurnBehavior: AgentMessageBehavior;
  /** What happens to the message, and how the sender can change it. */
  guidance: string;
  dispatched: Promise<PromptDispatchDisposition>;
}
interface Admitted extends Message {
  /** Withdrawal matches the sender's source; dispatch uses the admission snapshot. */
  originalSource: AgentPromptSource;
  taskAdmission?: TaskDispatchAdmission;
  drainSteerDeclined?: boolean;
  dispatchFailure?: { error: unknown };
  retainedForRestart?: boolean;
  waitingForPeerRecipient?: boolean;
  outcomeUnknown?: boolean;
  beginDispatchAttempt?: () => void;
  peerTurnAuthorization?: () => AgentRunOptions["turnAuthorization"];
  onReturnedToQueue?: () => Promise<void>;
  capturePeerAcceptance?: () => () => Promise<void>;
  rejectHeldPeerReservation?: (prompt: AgentPromptInput) => Promise<boolean>;
  peerReservationRejected?: boolean;
  /** claimed: a dispatch has it. It leaves the queue when the provider admits the prompt. */
  state: "queued" | "claimed" | "withdrawn" | "rejected";
  /** A steer or interrupt that was not released yet. After a Stop it waits like any other message. */
  urgency: "steer" | "interrupt" | null;
  /** A Stop found it in the queue. It waits for a prompt admitted after that Stop. */
  held: boolean;
  outOfBandDeclined: boolean;
  receipt: Receipt;
  resolve(disposition: PromptDispatchDisposition): void;
  reject(error: unknown): void;
}
/**
 * A recipient's queue. A dispatch in flight for the recipient is its entry in `releasing`:
 * collecting → waiting → releasing, and Stop moves the queue to held.
 */
interface Inbox {
  /**
   * Admission order. A message stays, in its place, until the provider admits the prompt that
   * carries it, so a Stop or a later prompt always finds it here.
   */
  messages: Admitted[];
  phase:
    | "collecting" // The quiet window is open.
    | "waiting" // The window closed; released as soon as the recipient is idle.
    | "held"; // A Stop held it; released with the recipient's next prompt.
  /** The quiet window while collecting, the busy retry while waiting. */
  cancelTimer(): void;
  cancelCap(): void;
  /** A polling queue step is already in line behind the recipient's current operation. */
  advancing: boolean;
  /** A queue step reserved before the queue was held again is void. */
  holdGeneration: number;
  /** Explicit Stops invalidate acceptance of a human prompt already in flight. */
  stops: number;
  recipientStateVersion: number;
}
interface DispatchRequest {
  recipientId: string;
  messageIds: readonly string[];
  shouldReportUpward: boolean;
  canSteerDuringDrain?: () => boolean;
  validateDispatch?: () => Promise<void>;
  beforeProviderDispatch(): Promise<void>;
  waitForProviderOutcome: boolean;
  handoff?: QueueHandoff;
  prompt: AgentPromptInput;
  activeTurnBehavior: "steer" | "interrupt";
  idleOnly: boolean;
  readonly turnAuthorization?: AgentRunOptions["turnAuthorization"];
  /**
   * Claim this exact prompt at provider admission. A withdrawn message or a Stop that reached
   * the recipient first invalidates it.
   */
  admit(): boolean;
  sessionMode?: string;
  clearPendingPermissions: boolean;
  unarchive: boolean;
}
/** A prompt that does not wait its turn: a person's, or the daemon's own. */
interface DirectPrompt {
  recipientId: string;
  prompt: AgentPromptInput;
  source?: AgentPromptSource;
  messageId?: string;
  sessionMode?: string;
  unarchive?: boolean;
  handoff?: QueueHandoff;
  /** When true on a human direct prompt, block any sourced queued message from riding along. */
  isolateFromSourcedRiders?: boolean;
}
/** Snapshot of a background agent-message batch that can be safely requeued if interrupted. */
export interface InterruptedBackgroundBatch {
  readonly recipientId: string;
  readonly messages: readonly Pick<
    Message,
    | "recipientId"
    | "messageId"
    | "source"
    | "childReported"
    | "validateDispatch"
    | "beforeProviderDispatch"
    | "prompt"
    | "sessionMode"
    | "unarchive"
    | "clearPendingPermissions"
  >[];
}
/** The provider prompt a direct prompt became. Unchanged when nothing was queued. */
interface JoinedPrompt {
  prompt: AgentPromptInput;
  messageId?: string;
  sessionMode?: string;
  unarchive: boolean;
  /** This prompt carries or reopens messages held by Stop. */
  waitForProviderPrompt?: boolean;
  admit?: () => boolean;
  handoff?: QueueHandoff;
}
interface ParentNotificationAddress {
  callerAgentId: string;
  childAgentId: string;
  serverId?: string;
}
interface Dependencies {
  shouldHoldInbox?(recipientId: string, source?: ChildSource): boolean;
  /** When true for a recipient, human direct prompts never carry sourced messages as riders. */
  isolateDirectPrompts?(recipientId: string): boolean;
  onInboxChange?(recipientId: string): void;
  classifyInbox?(recipientId: string, source: ChildSource): Promise<Message["subagentInbox"]>;
  /** Includes admitted starts and provider turns, including compaction. */
  isRunning?: (recipientId: string) => boolean;
  /** The recipient's provider can take a message into a running turn. */
  canSteer?: (recipientId: string) => boolean;
  hasPendingPermission?: (recipientId: string) => boolean;
  /** Notify when recipient state changes; admission still checks whether it is idle. */
  subscribe?: (
    listener: (recipientId: string, releaseInboxForRecipient?: boolean) => void,
  ) => () => void;
  unavailableHeldRecipient?: (recipientId: string) => Promise<string | undefined>;
  /** Notify before a recipient's turn is stopped with no prompt replacing it. */
  onStop?: (listener: (recipientId: string) => void) => () => void;
  tryRunOutOfBand?(
    request: DispatchRequest,
    onAccepted: () => void | Promise<void>,
    commandDispatch?: {
      waitForProviderOutcome?: boolean;
      onProviderOutcome?: (outcome: AgentCommandOutcome) => Promise<void>;
    },
  ): Promise<boolean>;
  /** Hand a batch to the recipient. Resolves once the provider admitted it. */
  dispatch(request: DispatchRequest): Promise<PromptDispatchDisposition>;
  /** Bound the wait for the provider to admit a direct prompt. Unbounded when absent. */
  awaitStart?(recipientId: string, started: Promise<void>): Promise<void>;
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
  /**
   * Admit a message. A queued one waits for the running turn to end; a steer or an interrupt
   * releases at once, with everything queued before it.
   */
  enqueue(message: Message): Receipt;
  getInbox?(recipientId: string): InboxSummary | undefined;
  flushInbox?(recipientId: string, taskId?: string): void;
  refreshInbox?(releaseLegacyRecipientId?: string): void;
  withdrawInboxReport?(recipientId: string, messageId: string, sender?: ChildSource): void;
  classifyInbox?: Dependencies["classifyInbox"];
  observeRemoteChild?(
    parentId: string,
    serverId: string,
    childId: string,
    active: boolean,
    taskId?: string,
  ): void;
  isRemoteFinishSuperseded?(address: ParentNotificationAddress, messageId: string): boolean;
  validateParentOwnership?(address: ParentNotificationAddress): Promise<void>;
  /**
   * Send a prompt that does not wait its turn. The messages admitted before it go ahead of it
   * in the same provider prompt, so none starts a turn of its own afterwards. Its place is
   * decided by this call, whenever the recipient gets to it. A command travels alone.
   */
  sendDirect<Result extends PromptDispatchResult>(
    direct: DirectPrompt,
    send: (joined: JoinedPrompt) => Promise<Result>,
  ): Promise<Result>;
  /** Remove matching messages that the queue still owns before dispatcher handoff. */
  withdrawPending(recipientId: string, matches: (source: AgentPromptSource) => boolean): number;
  /** Whether the recipient currently has an in-flight turn started by agent-message delivery. */
  hasActiveBackgroundTurn?(recipientId: string): boolean;
  /** Capture the active background delivery batch so a caller can requeue it if interrupted. */
  captureActiveBackgroundTurn?(recipientId: string): InterruptedBackgroundBatch | undefined;
  /** Re-enqueue an interrupted background delivery batch as queued messages in order. */
  requeueBackgroundBatch?(batch: InterruptedBackgroundBatch): number;
  /** Temporarily pause starting new background dispatches for a recipient; returns a release fn. */
  holdBackgroundDelivery?(recipientId: string): () => void;
  /** Messages and dispatches that will proceed without a new prompt. Held messages do not count. */
  hasPending(recipientId: string): boolean;
  /** Stop admission, flush pending messages, and await provider dispatch acknowledgments. */
  close(options?: { deferWith?: Error }): Promise<void>;
  /** Completion waits include admitted messages, but return at permission checkpoints and holds. */
  waitForDispatch(recipientId: string, signal: AbortSignal): Promise<void>;
}

const isQueued = (message: Admitted): boolean => message.state === "queued";
const isRunnable = (message: Admitted): boolean =>
  isQueued(message) && !message.waitingForPeerRecipient;
const isWithdrawn = (message: Admitted): boolean => message.state === "withdrawn";
const isUrgent = (message: Admitted): boolean => isQueued(message) && message.urgency !== null;
const isOfferable = (message: Admitted): boolean =>
  isQueued(message) &&
  !message.outOfBandDeclined &&
  message.sessionMode === undefined &&
  !message.subagentInbox &&
  !message.beforeProviderDispatch &&
  !hasMandatoryPeerDispatchMarker(message.prompt);

/**
 * Providers read a command from the raw start of the prompt: a slash and a name with no
 * second slash in it. A path such as `/tmp/build.log` is plain text.
 */
function isCommand(prompt: AgentPromptInput): boolean {
  const first = typeof prompt === "string" ? prompt : prompt[0];
  if (typeof first !== "string" && first?.type !== "text") return false;
  const text = typeof first === "string" ? first : first.text;
  return /^\/[^\s/]+(\s|$)/.test(text.trim());
}

function combine(prompts: AgentPromptInput[]): AgentPromptInput {
  return prompts.every((entry) => typeof entry === "string")
    ? prompts.join("\n\n")
    : prompts.flatMap((entry): AgentPromptContentBlock[] =>
        typeof entry === "string" ? [{ type: "text", text: entry }] : entry,
      );
}

function envelope(message: Admitted): AgentPromptInput {
  return prepareAgentMessage(
    message.prompt,
    message.source,
    message.receipt.messageId,
    message.recipientId,
  ).prompt;
}

function normalizeTopicId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sourceTopicKey(source: AgentPromptSource | undefined): string | undefined {
  if (!source) return undefined;
  if (source.kind === "agent-message") {
    const taskId = normalizeTopicId(source.taskId);
    if (taskId) return `task:${taskId}`;
    const rootMessageId = normalizeTopicId(source.rootMessageId);
    if (rootMessageId) return `msg:${rootMessageId}`;
    return undefined;
  }
  if (source.kind === "peer-workspace-message") {
    const correlationId = normalizeTopicId(source.correlationId);
    return correlationId ? `peer:${correlationId}` : undefined;
  }
  return undefined;
}

function messageTopicKey(message: Admitted): string | undefined {
  return sourceTopicKey(message.source);
}

/** Explicitly conflicting session modes or topic keys require separate, ordered dispatches. */
function modeGroups(messages: Admitted[]): Admitted[][] {
  const groups: Admitted[][] = [];
  let group: Admitted[] = [];
  let mode: string | undefined;
  for (const message of messages) {
    if (
      group.length &&
      ((mode && message.sessionMode && mode !== message.sessionMode) ||
        messageTopicKey(group[0]!) !== messageTopicKey(message) ||
        Boolean(group[0]!.peerTurnAuthorization) !== Boolean(message.peerTurnAuthorization) ||
        group[0]!.taskAdmission ||
        message.taskAdmission ||
        group[0]!.beforeProviderDispatch ||
        message.beforeProviderDispatch ||
        Boolean(group[0]!.subagentInbox) !== Boolean(message.subagentInbox) ||
        (!message.subagentInbox && (group[0]!.validateDispatch || message.validateDispatch)))
    ) {
      groups.push(group);
      group = [];
      mode = undefined;
    }
    group.push(message);
    mode ??= message.sessionMode;
  }
  if (group.length) groups.push(group);
  return groups;
}

/**
 * Owns the order in which prompts reach a recipient. Delivery order equals admission order:
 * only a prefix of the queue is ever dispatched, except a command a provider runs out of band.
 *
 * Every prompt for a recipient takes its place when it is admitted, and one operation at a
 * time acts on the queue. A message stays in the queue until the provider admits the prompt
 * that carries it, so agent messages, a person's prompts, and Stop all decide over the same list.
 */
export function createAgentMessageDelivery(dependencies: Dependencies): AgentMessageDelivery & {
  /** Explicit reports still buffered or awaiting provider admission for the recipient's task. */
  hasPendingTaskReport(recipientId: string, taskId: string, excludeMessageId?: string): boolean;
  /** Explicit untasked reports still buffered or awaiting admission for the recipient's msg:<root>. */
  hasPendingTopicReport(
    recipientId: string,
    rootMessageId: string,
    excludeMessageId?: string,
  ): boolean;
  pauseAdmission(): { drained: Promise<void>; release(): void };
} {
  const schedule =
    dependencies.schedule ??
    ((delayMs, callback) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
  const inboxes = new Map<string, Inbox>();
  const releasing = new Map<string, Promise<void>>();
  const parentInboxes = new Map<string, Admitted[]>();
  const parentInboxCaps = new Map<string, Map<string | undefined, () => void>>();
  const activeBackgroundTurns = new Map<string, Admitted[]>();
  const backgroundDeliveryHolds = new Map<string, number>();
  const stopWrites = new Set<Promise<void>>();
  const outcomeWrites = new Set<Promise<void>>();
  const stopWaiters = new Set<(recipientId: string) => void>();
  let admissionPaused = false;
  let closed = false;
  let queuesDrainedOnClose = false;
  let closing: Promise<void> | undefined;

  const isBackgroundDeliveryHeld = (recipientId: string): boolean =>
    (backgroundDeliveryHolds.get(recipientId) ?? 0) > 0;

  function inboxTaskId({ source }: Admitted): string | undefined {
    return source.kind === "agent-message" ? source.taskId || undefined : undefined;
  }

  function syncParentInboxCaps(recipientId: string): void {
    const pendingTasks = new Set(parentInboxes.get(recipientId)?.map(inboxTaskId));
    const caps = parentInboxCaps.get(recipientId) ?? new Map();
    for (const [taskId, cancel] of caps) {
      if (!pendingTasks.has(taskId)) {
        cancel();
        caps.delete(taskId);
      }
    }
    for (const taskId of pendingTasks) {
      // A topic keeps its original deadline when another topic is flushed.
      if (caps.has(taskId)) continue;
      caps.set(
        taskId,
        schedule(MAX_SUBAGENT_INBOX_WAIT_MS, () => {
          if (!closed) releaseInbox(recipientId, [], (message) => inboxTaskId(message) === taskId);
        }),
      );
    }
    if (caps.size) parentInboxCaps.set(recipientId, caps);
    else parentInboxCaps.delete(recipientId);
  }

  const isRunning = (recipientId: string): boolean =>
    Boolean(dependencies.isRunning?.(recipientId));
  const isHeld = (recipientId: string): boolean => inboxes.get(recipientId)?.phase === "held";

  function watchForHold(inbox: Inbox): () => boolean {
    const seen = inbox.holdGeneration;
    return () => inbox.holdGeneration !== seen;
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

  function maySteerDuringDrain(message: Admitted): boolean {
    // A request that needs a different session mode must wait for its own turn.
    return (
      preparing() &&
      message.urgency === "steer" &&
      !message.sessionMode &&
      !message.drainSteerDeclined
    );
  }

  const preparing = () => admissionPaused && !closed;

  function requestFor(
    recipientId: string,
    messages: Admitted[],
    idleOnly: boolean,
    stopped: () => boolean,
  ): DispatchRequest {
    const peerOnly = messages.some((message) => message.peerTurnAuthorization);
    return {
      recipientId,
      idleOnly: idleOnly || peerOnly,
      get turnAuthorization() {
        return messages.find((message) => message.peerTurnAuthorization)?.peerTurnAuthorization?.();
      },
      shouldReportUpward: messages.some(
        ({ childReported, source }) =>
          childReported ||
          (source.kind === "agent-notification" && source.event !== "permission-required"),
      ),
      canSteerDuringDrain:
        idleOnly && !peerOnly && messages.every(maySteerDuringDrain) ? preparing : undefined,
      validateDispatch: messages.some((message) => message.validateDispatch)
        ? checkMessages(messages, (message) => message.validateDispatch?.())
        : undefined,
      beforeProviderDispatch: checkMessages(messages, (message) =>
        message.beforeProviderDispatch?.(),
      ),
      waitForProviderOutcome: messages.some((message) => message.waitForProviderOutcome),
      handoff: combineHandoffs(messages),
      admit() {
        if (
          stopped() ||
          messages.some((message) => !isQueued(message) && message.state !== "claimed")
        )
          return false;
        for (const message of messages) message.state = "claimed";
        return true;
      },
      messageIds: messages.map((message) => message.receipt.messageId),
      prompt: combine(messages.map(envelope)),
      // A batch that waited for the turn to end is dispatched idle-only, so it never steers.
      activeTurnBehavior: messages.some((message) => message.urgency === "interrupt")
        ? "interrupt"
        : "steer",
      // An interrupt may follow a message that asked for another mode; the latest choice wins.
      sessionMode: messages.findLast((message) => message.sessionMode)?.sessionMode,
      clearPendingPermissions: messages.some((message) => message.clearPendingPermissions),
      unarchive: messages.some((message) => message.unarchive !== false),
    };
  }

  function combineHandoffs(messages: Admitted[], direct?: QueueHandoff): QueueHandoff | undefined {
    const handoffs = [...messages.map((message) => message.handoff), direct].filter(
      (handoff): handoff is QueueHandoff => handoff !== undefined,
    );
    const confirmPeer = messages.flatMap((message) => {
      const confirm = message.capturePeerAcceptance?.();
      return confirm ? [confirm] : [];
    });
    if (!handoffs.length && !confirmPeer.length) return undefined;
    return {
      waitForForegroundConfirmation: handoffs.some((entry) => entry.waitForForegroundConfirmation),
      async begin() {
        await checkMessages(messages, (message) => {
          const prepareTask = message.taskAdmission?.beforeProviderDispatch;
          return prepareTask
            ? prepareTask().then(() => message.handoff?.begin())
            : message.handoff?.begin();
        })();
        await direct?.begin();
      },
      async declined() {
        for (const entry of handoffs) await entry.declined();
      },
      async onProviderOutcome(outcome) {
        // Leave the handed-off receipt in place until peer acceptance is recoverable.
        if (outcome === "accepted") {
          for (const confirm of confirmPeer) await confirm();
        }
        for (const entry of handoffs) await entry.onProviderOutcome?.(outcome);
      },
    };
  }

  function retire(recipientId: string, inbox: Inbox): void {
    inbox.cancelTimer();
    inbox.cancelCap();
    if (inboxes.get(recipientId) === inbox) inboxes.delete(recipientId);
  }

  /** The message reached its end: delivered, failed, or withdrawn. */
  function settle(message: Admitted, state: "claimed" | "rejected" | "withdrawn"): void {
    message.state = state;
    const inbox = inboxes.get(message.recipientId);
    const index = inbox?.messages.indexOf(message) ?? -1;
    if (!inbox || index < 0) return;
    inbox.messages.splice(index, 1);
    if (!inbox.messages.length) retire(message.recipientId, inbox);
  }

  function claim(
    message: Admitted,
    disposition: PromptDispatchDisposition,
    request: DispatchRequest,
  ): void {
    settle(message, "claimed");
    try {
      message.onDispatch?.(disposition);
    } catch (error) {
      dependencies.onError(error, request);
    }
    message.resolve(disposition);
  }

  /** A dispatch that did not happen leaves its messages queued, each still in its place. */
  function handBack(messages: Admitted[]): void {
    for (const message of messages) if (message.state === "claimed") message.state = "queued";
  }

  function fail(message: Admitted, error: unknown): void {
    settle(message, "rejected");
    message.reject(error);
  }

  /** One operation per recipient at a time, whether the queue or a person started it. */
  function run(recipientId: string, operation: () => Promise<void>): void {
    const previous = releasing.get(recipientId) ?? Promise.resolve();
    const tracked = previous
      .then(operation)
      .catch(() => undefined)
      .then(() => rest(recipientId));
    releasing.set(recipientId, tracked);
    void tracked.then(() => {
      if (releasing.get(recipientId) === tracked) releasing.delete(recipientId);
      return undefined;
    });
  }

  /** After an operation, a waiting queue keeps polling for the turn to end. */
  function rest(recipientId: string): void {
    const inbox = inboxes.get(recipientId);
    if (
      closed ||
      !inbox ||
      inbox.advancing ||
      inbox.phase !== "waiting" ||
      isBackgroundDeliveryHeld(recipientId) ||
      !inbox.messages.some(isRunnable)
    )
      return;
    inbox.cancelTimer();
    if (preparing() && !isRunning(recipientId)) {
      nudge(recipientId, inbox);
      return;
    }
    inbox.cancelTimer = schedule(preparing() ? 100 : QUIET_MS, () => attempt(recipientId));
  }

  async function returnUnsubmittedBatch(messages: Admitted[], request: DispatchRequest) {
    await request.handoff?.declined();
    handBack(messages);
    for (const message of messages) {
      if (!message.outcomeUnknown) await message.onReturnedToQueue?.();
      if (message.dispatchFailure) fail(message, message.dispatchFailure.error);
    }
  }

  async function returnBlockedBatch(
    error: unknown,
    messages: Admitted[],
    request: DispatchRequest,
    inbox: Inbox,
    stateVersion: number,
  ): Promise<boolean> {
    if (!(error instanceof AgentTurnBusyError) || !request.idleOnly) {
      return deferUntilPeerRecipientChanges(error, messages, request, inbox, stateVersion);
    }
    handBack(messages);
    for (const message of messages) {
      await message.onReturnedToQueue?.();
      if (request.canSteerDuringDrain && preparing()) message.drainSteerDeclined = true;
    }
    return true;
  }

  async function deferUntilPeerRecipientChanges(
    error: unknown,
    messages: Admitted[],
    request: DispatchRequest,
    inbox: Inbox,
    stateVersion: number,
  ): Promise<boolean> {
    if (
      !(error instanceof PeerRecipientNotReadyError) ||
      !request.turnAuthorization ||
      !messages.every((message) => message.handoff?.retryQueued)
    )
      return false;
    await returnUnsubmittedBatch(messages, request);
    for (const message of messages) {
      await message.handoff?.retryQueued?.();
      // A session can open while validation or the receipt write is in progress.
      message.waitingForPeerRecipient = inbox.recipientStateVersion === stateVersion;
    }
    for (const check of stopWaiters) check(request.recipientId);
    return true;
  }

  function isUnconfirmedDispatch(error: unknown): boolean {
    return (
      error instanceof AgentRequestOutcomeUnknownError ||
      (error instanceof Error && error.name === "AbortError")
    );
  }

  function isUnconfirmedBatch(error: unknown, messages: Admitted[]): boolean {
    return (
      isUnconfirmedDispatch(error) &&
      messages.some(
        (message) =>
          Boolean(message.handoff) ||
          (Boolean(message.outcomeUnknown) && hasMandatoryPeerDispatchMarker(message.prompt)),
      )
    );
  }

  function hasSubagentInboxBatch(messages: Admitted[]): boolean {
    return messages.some((message) => Boolean(message.subagentInbox));
  }

  function isBatchIdleOnly(idleOnly: boolean, hasSubagentInbox: boolean): boolean {
    return (idleOnly && !closed) || hasSubagentInbox;
  }

  function failBatch(messages: Admitted[], error: unknown): void {
    for (const message of messages) fail(message, error);
  }

  async function prepareDispatchAttempt(messages: Admitted[]): Promise<void> {
    for (const message of messages) message.beginDispatchAttempt?.();
    const peerMsg = messages.find((message) => hasMandatoryPeerDispatchMarker(message.prompt));
    if (!peerMsg) return;
    const senderServerId = "serverId" in peerMsg.source ? peerMsg.source.serverId : undefined;
    await ensurePeerDispatchEnvironmentReady(senderServerId);
  }

  function trackOutcomeWrite(write: Promise<void>): void {
    const settled = write.catch(() => undefined);
    outcomeWrites.add(settled);
    void settled.finally(() => {
      outcomeWrites.delete(settled);
    });
  }

  function combineDispatchValidators(
    recipientId: string,
    source: AgentPromptSource,
    prompt: AgentPromptInput,
    validateDispatch: (() => Promise<void> | void) | undefined,
  ): {
    beginDispatchAttempt?: () => void;
    peerTurnAuthorization?: Admitted["peerTurnAuthorization"];
    validateDispatch?: () => Promise<void>;
    onReturnedToQueue?: () => Promise<void>;
    onOutcome?: (outcome: PeerDispatchTerminalOutcome) => void;
    capturePeerAcceptance?: Admitted["capturePeerAcceptance"];
    rejectHeldPeerReservation?: Admitted["rejectHeldPeerReservation"];
  } {
    const hasPeerMarker = hasMandatoryPeerDispatchMarker(prompt);
    if (!validateDispatch && !hasPeerMarker) return {};
    const baseContext = {
      recipientId,
      senderAgentId: "agentId" in source ? source.agentId : undefined,
      senderServerId: "serverId" in source ? source.serverId : undefined,
    };
    const owner = {};
    const reservation = hasPeerMarker
      ? claimPromptDispatchReservation(prompt, baseContext, owner)
      : undefined;
    let attemptId: string | undefined;
    let turnAuthorization: AgentRunOptions["turnAuthorization"];
    const notify = async (outcome: PeerDispatchTerminalOutcome, id = attemptId) => {
      await reservation;
      await notifyPromptDispatchOutcome(prompt, outcome, { ...baseContext, attemptId: id }, owner);
    };
    return {
      beginDispatchAttempt: hasPeerMarker
        ? () => {
            attemptId = randomUUID();
            turnAuthorization = undefined;
          }
        : undefined,
      peerTurnAuthorization: hasPeerMarker ? () => turnAuthorization : undefined,
      validateDispatch: async () => {
        await validateDispatch?.();
        if (hasPeerMarker) {
          if (!attemptId) throw new Error("Peer dispatch requires an active delivery attempt.");
          await reservation;
          turnAuthorization = await verifyMandatoryPeerPromptAtDispatch(
            prompt,
            baseContext,
            attemptId,
            owner,
          );
          if (!turnAuthorization) throw new Error("Missing verified peer dispatch authorization.");
        }
      },
      onReturnedToQueue: hasPeerMarker
        ? async () => {
            if (attemptId) await notify("returned_to_queue").catch(() => undefined);
          }
        : undefined,
      onOutcome: hasPeerMarker ? (outcome) => trackOutcomeWrite(notify(outcome)) : undefined,
      rejectHeldPeerReservation: hasPeerMarker
        ? async (heldPrompt) => {
            await reservation;
            // A previous check may have removed the reservation before the receipt write failed.
            await claimPromptDispatchReservation(prompt, baseContext, owner);
            return (
              (await notifyPromptDispatchOutcome(
                heldPrompt,
                "definitively_unsent",
                { ...baseContext, rejectDurableHold: true },
                owner,
              )) === true
            );
          }
        : undefined,
      capturePeerAcceptance: hasPeerMarker
        ? () => {
            const id = attemptId;
            return async () => {
              if (!id) throw new Error("Peer acceptance requires a delivery attempt.");
              const write = notify("accepted", id);
              trackOutcomeWrite(write);
              await write;
            };
          }
        : undefined,
    };
  }

  function resolveRejectedOutcome(message: Admitted, error: unknown): PeerDispatchTerminalOutcome {
    if (message.outcomeUnknown) return "outcome_unknown";
    if (message.retainedForRestart || error instanceof QueuedPromptLoadError)
      return "retained_for_restart";
    return "definitively_unsent";
  }

  function bindValidationLifecycle(
    message: Admitted,
    validation: ReturnType<typeof combineDispatchValidators>,
  ): void {
    if (!validation.onOutcome) return;
    void message.receipt.dispatched.then(
      () => {
        validation.onOutcome?.("accepted");
        return undefined;
      },
      (error: unknown) => {
        if (!message.peerReservationRejected)
          validation.onOutcome?.(resolveRejectedOutcome(message, error));
      },
    );
  }

  function resolveMessageUrgency(
    activeTurnBehavior: AgentMessageBehavior,
    heldAfterStop: boolean | undefined,
  ): Admitted["urgency"] {
    return activeTurnBehavior === "queue" || heldAfterStop ? null : activeTurnBehavior;
  }

  function markOutcomeUnknownIfSubmitted(
    enteredProviderSubmission: boolean,
    error: unknown,
    messages: Admitted[],
  ): void {
    if (!enteredProviderSubmission || !isUnconfirmedDispatch(error)) return;
    for (const message of messages) message.outcomeUnknown = true;
  }

  function recordDispatchedBatch(
    recipientId: string,
    disposition: PromptDispatchDisposition,
    messages: Admitted[],
  ): void {
    if (disposition === "turn_started") {
      activeBackgroundTurns.set(recipientId, [...messages]);
    }
  }

  function isDirectRiderBlocked(
    message: Admitted,
    direct: DirectPrompt,
    isolateSourcedRiders: boolean,
    directTopicKey: string | undefined,
  ): boolean {
    if (
      message.taskAdmission ||
      message.validateDispatch ||
      message.subagentInbox ||
      message.beforeProviderDispatch ||
      message.sessionMode ||
      message.childReported ||
      message.source.kind === "agent-notification"
    ) {
      return true;
    }
    if (!direct.source) {
      if (isolateSourcedRiders) return true;
      return (
        messageTopicKey(message) !== undefined ||
        message.source.kind === "peer-workspace-message" ||
        message.source.kind === "change-request-update" ||
        (message.source.kind === "agent-message" && message.source.reportStatus !== undefined)
      );
    }
    return messageTopicKey(message) !== directTopicKey;
  }

  function selectDirectRiders(candidates: Admitted[], direct: DirectPrompt): Admitted[] {
    const isolateSourcedRiders =
      !direct.source &&
      (direct.isolateFromSourcedRiders === true ||
        Boolean(dependencies.isolateDirectPrompts?.(direct.recipientId)));
    const directTopicKey = sourceTopicKey(direct.source);
    const boundary = candidates.findIndex((message) =>
      isDirectRiderBlocked(message, direct, isolateSourcedRiders, directTopicKey),
    );
    return boundary < 0 ? candidates : candidates.slice(0, boundary);
  }

  function clearActiveBackgroundTurnIfStarted(
    recipientId: string,
    disposition: PromptDispatchDisposition,
  ): void {
    if (disposition === "turn_started") {
      activeBackgroundTurns.delete(recipientId);
    }
  }

  /** Dispatch one batch. A batch that finds the recipient stopped, or busy when idle-only, stays queued. */
  async function deliver(
    recipientId: string,
    inbox: Inbox,
    batch: Admitted[],
    idleOnly: boolean,
    stopped: () => boolean,
  ): Promise<void> {
    let retriedChangedTurn = false;
    for (;;) {
      const messages = batch.filter(isRunnable);
      if (!messages.length) return;
      const stateVersion = inbox.recipientStateVersion;
      await prepareDispatchAttempt(messages);
      const hasSubagentInbox = hasSubagentInboxBatch(messages);
      const request = requestFor(
        recipientId,
        messages,
        isBatchIdleOnly(idleOnly, hasSubagentInbox),
        stopped,
      );
      let enteredProviderSubmission = false;
      try {
        await request.validateDispatch?.();
        if (!messages.every(isQueued)) {
          throw new DOMException("Agent message withdrawn", "AbortError");
        }
        for (const message of messages) message.beforeDispatch?.();
        enteredProviderSubmission = true;
        const disposition = await runWithTaskDispatchAdmission(messages[0]?.taskAdmission, () =>
          dependencies.dispatch(request),
        );
        recordDispatchedBatch(recipientId, disposition, messages);
        for (const message of messages) claim(message, disposition, request);
        return;
      } catch (error) {
        markOutcomeUnknownIfSubmitted(enteredProviderSubmission, error, messages);
        if (isUnconfirmedBatch(error, messages)) {
          failBatch(messages, error);
          throw error;
        }
        const isStopped = stopped();
        if (isStopped || messages.some(isWithdrawn)) {
          await returnUnsubmittedBatch(messages, request);
          if (isStopped) return;
          continue;
        }
        if (error instanceof AgentTurnChangedError) {
          await returnUnsubmittedBatch(messages, request);
          if (retriedChangedTurn) return;
          retriedChangedTurn = true;
          continue;
        }
        if (await returnBlockedBatch(error, messages, request, inbox, stateVersion)) {
          if (closed && !hasSubagentInbox && !request.turnAuthorization) continue;
          return;
        }
        failBatch(messages, error);
        dependencies.onError(error, request);
        throw error;
      }
    }
  }

  /** A provider may run a command beside the turn. Each message is offered once, alone. */
  async function offerOutOfBand(
    recipientId: string,
    candidates: Admitted[],
    stopped: () => boolean,
    stillDue: () => boolean = () => true,
  ): Promise<void> {
    const tryRunOutOfBand = dependencies.tryRunOutOfBand;
    if (!tryRunOutOfBand) return;
    for (const message of candidates) {
      if (closed || stopped() || !stillDue()) return;
      if (!isOfferable(message)) continue;
      await prepareDispatchAttempt([message]);
      const request = requestFor(recipientId, [message], true, stopped);
      try {
        await request.validateDispatch?.();
        const accepted = await runWithTaskDispatchAdmission(message.taskAdmission, () =>
          tryRunOutOfBand(
            request,
            async () => {
              if (!request.admit()) throw new Error("Queued agent message was withdrawn");
              message.beforeDispatch?.();
              await request.handoff?.begin();
              await request.validateDispatch?.();
              if (stopped()) throw new Error("Queued agent message was stopped");
            },
            {
              waitForProviderOutcome: request.waitForProviderOutcome,
              onProviderOutcome: request.handoff?.onProviderOutcome,
            },
          ),
        );
        if (accepted) claim(message, "out_of_band", request);
        else {
          handBack([message]);
          await message.onReturnedToQueue?.();
          message.outOfBandDeclined = true;
        }
      } catch (error) {
        if (isWithdrawn(message)) continue;
        await request.handoff?.declined();
        if (stopped()) {
          handBack([message]);
          await message.onReturnedToQueue?.();
          return;
        }
        fail(message, error);
        dependencies.onError(error, request);
      }
    }
  }

  /**
   * Move the queue forward: a steer or an interrupt takes it now, a closed window once the turn
   * has ended.
   * `ahead` is what was admitted before this step got in line; it leaves later messages alone.
   */
  async function advance(
    recipientId: string,
    inbox: Inbox,
    ahead: Admitted[],
    stopped: () => boolean,
  ): Promise<void> {
    const urgent = ahead.filter(isUrgent);
    if (urgent.length) {
      // A command the provider runs beside the turn replaces nothing, so it takes nothing along.
      await offerOutOfBand(recipientId, urgent, stopped);
      const last = ahead.findLastIndex(isUrgent);
      if (last >= 0) {
        // A steer or an interrupt does not jump the queue: everything admitted before it goes first.
        const first = modeGroups(ahead.slice(0, last + 1).filter(isRunnable))[0] ?? [];
        if (first.some(isUrgent) || !isRunning(recipientId)) {
          await deliver(recipientId, inbox, first, !first.some(isUrgent), stopped);
        }
        return;
      }
    }
    if (inbox.phase !== "waiting" || isBackgroundDeliveryHeld(recipientId)) return;
    const running = (): boolean => inbox.phase === "waiting" && isRunning(recipientId);
    if (running()) await offerOutOfBand(recipientId, ahead, stopped, running);
    // Later mode groups stay queued for the turn ends that follow.
    if (inbox.phase === "waiting" && !isBackgroundDeliveryHeld(recipientId)) {
      const first = modeGroups(ahead.filter(isRunnable))[0] ?? [];
      if (!isRunning(recipientId) || (first.length && first.every(maySteerDuringDrain))) {
        await deliver(recipientId, inbox, first, true, stopped);
      }
    }
  }

  /**
   * Line up a queue step behind the recipient's current operation, for what is queued now.
   * A Stop voids the steps reserved before it: what they covered waits for the next prompt.
   */
  function lineUp(recipientId: string, inbox: Inbox, onStart?: () => void): void {
    const ahead = [...inbox.messages];
    const stopped = watchForHold(inbox);
    run(recipientId, async () => {
      onStart?.();
      if (!stopped()) await advance(recipientId, inbox, ahead, stopped);
    });
  }

  /** Polling lines up one step at a time; a steer or an interrupt always reserves its own place. */
  function nudge(recipientId: string, inbox: Inbox): void {
    if (inbox.advancing) return;
    inbox.advancing = true;
    lineUp(recipientId, inbox, () => {
      inbox.advancing = false;
    });
  }

  /** The quiet window closed, a retry came due, or the recipient settled. */
  function attempt(recipientId: string): void {
    const inbox = inboxes.get(recipientId);
    if (!inbox || inbox.phase === "held" || !inbox.messages.some(isRunnable)) return;
    inbox.cancelTimer();
    inbox.cancelCap();
    inbox.phase = "waiting";
    if (isBackgroundDeliveryHeld(recipientId)) return;
    const running = isRunning(recipientId);
    if (running)
      inbox.cancelTimer = schedule(preparing() ? 100 : QUIET_MS, () => attempt(recipientId));
    const nothingToOffer = !dependencies.tryRunOutOfBand || !inbox.messages.some(isOfferable);
    if (
      running &&
      nothingToOffer &&
      !inbox.messages.some(isUrgent) &&
      !inbox.messages.some(maySteerDuringDrain)
    )
      return;
    nudge(recipientId, inbox);
  }

  function admit(item: Admitted): void {
    const existing = inboxes.get(item.recipientId);
    const inbox = existing ?? {
      messages: [],
      phase: "waiting",
      cancelTimer: () => {},
      cancelCap: () => {},
      advancing: false,
      holdGeneration: 0,
      stops: 0,
      recipientStateVersion: 0,
    };
    inboxes.set(item.recipientId, inbox);
    inbox.messages.push(item);
    if (item.held) rejectUnavailableHeldMessages(item.recipientId);
    if (item.heldAfterStop && inbox.messages.every((message) => message.held)) {
      inbox.phase = "held";
      return;
    }
    inbox.cancelTimer();
    if (item.urgency) {
      // A steer or an interrupt does not wait: it closes the window and takes the queue along. Its place
      // is reserved now, so a prompt admitted after it cannot take it away.
      inbox.cancelCap();
      inbox.phase = "waiting";
      lineUp(item.recipientId, inbox);
      return;
    }
    inbox.cancelTimer = schedule(QUIET_MS, () => attempt(item.recipientId));
    if (inbox.phase === "collecting") return;
    // A new window. It closes after a quiet spell, and no later than the cap.
    inbox.phase = "collecting";
    inbox.cancelCap = schedule(MAX_COLLECTING_MS, () => attempt(item.recipientId));
  }

  function releaseInbox(
    recipientId: string,
    arriving: Admitted[] = [],
    matches: (message: Admitted) => boolean = () => true,
  ): void {
    const backlog = parentInboxes.get(recipientId);
    const released: Admitted[] = [];
    const remaining: Admitted[] = [];
    for (const message of backlog ?? []) {
      (matches(message) ? released : remaining).push(message);
    }
    if (remaining.length) parentInboxes.set(recipientId, remaining);
    else parentInboxes.delete(recipientId);
    syncParentInboxCaps(recipientId);
    for (const message of [...released, ...arriving]) admit(message);
    if (released.length) dependencies.onInboxChange?.(recipientId);
  }

  function refreshInbox(releaseLegacyRecipientId?: string): void {
    if (closed || admissionPaused) return;
    for (const [recipientId, backlog] of parentInboxes) {
      const readyTasks = new Set<string | undefined>();
      if (recipientId === releaseLegacyRecipientId) readyTasks.add(undefined);
      for (const message of backlog) {
        const taskId = inboxTaskId(message);
        if (readyTasks.has(taskId)) continue;
        const { source } = message;
        if (isChildSource(source) && !dependencies.shouldHoldInbox?.(recipientId, source))
          readyTasks.add(taskId);
      }
      if (readyTasks.size)
        releaseInbox(recipientId, [], (message) => readyTasks.has(inboxTaskId(message)));
    }
  }

  function join(queued: Admitted[], direct: DirectPrompt): JoinedPrompt {
    if (!queued.length) {
      const own = prepareAgentMessage(direct.prompt, direct.source, direct.messageId);
      return {
        prompt: own.prompt,
        messageId: own.messageId,
        sessionMode: direct.sessionMode,
        unarchive: direct.unarchive !== false,
      };
    }
    // Sharing a prompt with agent messages, a person's text needs its own envelope to stay
    // a separate row with its own identity.
    const own = envelopeMessage(direct.prompt, direct.source ?? null, direct.messageId);
    return {
      prompt: combine([...queued.map(envelope), own.prompt]),
      messageId: own.messageId,
      sessionMode:
        direct.sessionMode ?? queued.findLast((message) => message.sessionMode)?.sessionMode,
      unarchive: direct.unarchive !== false,
      handoff: combineHandoffs(queued, direct.handoff),
    };
  }

  function returnUnconfirmedRiders(riders: Admitted[], error: unknown) {
    for (const rider of riders) {
      if (rider.handoff) fail(rider, error);
      else handBack([rider]);
    }
  }

  /**
   * Messages that rode a direct prompt are delivered when the provider admits that prompt.
   * Until it answers, nothing later may pass them.
   */
  async function ride(
    recipientId: string,
    riders: Admitted[],
    result: PromptDispatchResult,
  ): Promise<boolean> {
    const request = requestFor(recipientId, riders, false, () => false);
    if (result.disposition === "turn_started") {
      try {
        await (dependencies.awaitStart?.(recipientId, result.started) ?? result.started);
      } catch (error) {
        // The provider may already have the prompt. Replaying a durable send could duplicate it.
        if (isUnconfirmedDispatch(error)) {
          returnUnconfirmedRiders(riders, error);
        } else {
          await request.handoff?.declined();
          handBack(riders);
        }
        return false;
      }
    }
    for (const message of riders) claim(message, result.disposition, request);
    return result.disposition !== "out_of_band";
  }

  function trackStopWrite(message: Admitted, changed?: Promise<void>): void {
    if (!changed) return;
    stopWrites.add(changed);
    void changed
      .then(
        () => stopWrites.delete(changed),
        (error) => {
          stopWrites.delete(changed);
          dependencies.onError(
            error,
            requestFor(message.recipientId, [message], true, () => true),
          );
        },
      )
      .catch(() => undefined);
  }

  function resumeHeldInbox(recipientId: string, inbox: Inbox): void {
    if (closed || inboxes.get(recipientId) !== inbox) return;
    for (const message of inbox.messages) {
      if (!message.held) continue;
      message.held = false;
      trackStopWrite(message, message.handoff?.releaseAfterStop?.());
    }
    if (inbox.phase === "held") {
      inbox.phase = "waiting";
      attempt(recipientId);
    }
  }

  /**
   * The stopped recipient stays stopped. Its queue, steers and interrupts included, goes with whatever
   * prompts it next.
   */
  function hold(inbox: Inbox): void {
    inbox.cancelTimer();
    inbox.cancelCap();
    inbox.phase = "held";
    inbox.holdGeneration++;
    for (const message of inbox.messages) {
      message.urgency = null;
      message.held = true;
      trackStopWrite(message, message.handoff?.holdAfterStop?.());
    }
  }

  function rejectUnavailableHeldMessages(recipientId: string): void {
    const check = dependencies.unavailableHeldRecipient;
    const candidates = inboxes
      .get(recipientId)
      ?.messages.filter(
        (message) =>
          message.held &&
          !message.outcomeUnknown &&
          message.rejectHeldPeerReservation &&
          message.handoff?.rejectHeld,
      );
    if (!check || !candidates?.length) return;
    run(recipientId, async () => {
      for (const message of candidates) {
        if (!isQueued(message) || !message.held || message.outcomeUnknown) continue;
        const rejectReservation = message.rejectHeldPeerReservation;
        if (!message.handoff?.rejectHeld || !rejectReservation) continue;
        const request = requestFor(recipientId, [message], true, () => true);
        try {
          const reason = await check(recipientId);
          if (!reason || !isQueued(message)) continue;
          const rejected = await message.handoff.rejectHeld(
            recipientId,
            message.receipt.messageId,
            (held) => rejectReservation(held.prompt),
          );
          if (!rejected) continue;
          message.peerReservationRejected = true;
          if (isQueued(message)) fail(message, new Error(reason));
        } catch (error) {
          dependencies.onError(error, request);
        }
      }
    });
  }

  const unsubscribe = dependencies.subscribe?.((recipientId, releaseInboxForRecipient) => {
    if (!isRunning(recipientId)) activeBackgroundTurns.delete(recipientId);
    refreshInbox(releaseInboxForRecipient ? recipientId : undefined);
    const inbox = inboxes.get(recipientId);
    if (!inbox) return;
    rejectUnavailableHeldMessages(recipientId);
    inbox.recipientStateVersion++;
    for (const message of inbox.messages) message.waitingForPeerRecipient = false;
    if (inbox.phase === "waiting" && !isRunning(recipientId)) attempt(recipientId);
  });
  const unsubscribeStop = dependencies.onStop?.((recipientId) => {
    activeBackgroundTurns.delete(recipientId);
    const inbox = inboxes.get(recipientId);
    if (inbox) {
      inbox.stops++;
      hold(inbox);
      rejectUnavailableHeldMessages(recipientId);
    }
    for (const check of stopWaiters) check(recipientId);
  });

  function activeReports(recipientId: string): Admitted[] | undefined {
    const batch = activeBackgroundTurns.get(recipientId);
    return batch?.every(({ source }) => isChildSource(source)) ? batch : undefined;
  }

  function withdrawPending(recipientId: string, matches: (message: Admitted) => boolean): number {
    const parent = parentInboxes.get(recipientId);
    const removedParent = parent?.filter((message) => isQueued(message) && matches(message)) ?? [];
    if (parent && removedParent.length) {
      const remaining = parent.filter((message) => !removedParent.includes(message));
      if (remaining.length) parentInboxes.set(recipientId, remaining);
      else parentInboxes.delete(recipientId);
      syncParentInboxCaps(recipientId);
      for (const message of removedParent) {
        message.state = "withdrawn";
        message.reject(new DOMException("Agent message withdrawn", "AbortError"));
      }
      dependencies.onInboxChange?.(recipientId);
    }
    const withdrawn = (inboxes.get(recipientId)?.messages ?? []).filter(
      (message) => isQueued(message) && matches(message),
    );
    for (const message of withdrawn) {
      settle(message, "withdrawn");
      message.reject(new DOMException("Agent message withdrawn", "AbortError"));
    }
    // Without the message that reopened it after a Stop, the queue is held again.
    const inbox = inboxes.get(recipientId);
    if (withdrawn.length && inbox?.messages.every((message) => message.held)) hold(inbox);
    return withdrawn.length + removedParent.length;
  }

  async function drain(): Promise<void> {
    const receipts: Promise<unknown>[] = [];
    for (const [recipientId, inbox] of inboxes) {
      if (inbox.phase === "held") continue;
      receipts.push(...inbox.messages.map(waitForRunnableMessage));
      attempt(recipientId);
    }
    await Promise.allSettled(receipts);
  }

  function waitForRunnableMessage(message: Admitted): Promise<unknown> {
    if (!message.peerTurnAuthorization || !message.handoff?.retryQueued)
      return message.receipt.dispatched;
    if (message.waitingForPeerRecipient) return Promise.resolve();
    let resolveParked!: () => void;
    const parked = new Promise<void>((resolve) => {
      resolveParked = resolve;
    });
    const check = (recipientId: string) => {
      if (recipientId === message.recipientId && message.waitingForPeerRecipient) resolveParked();
    };
    stopWaiters.add(check);
    return Promise.race([message.receipt.dispatched, parked]).finally(() =>
      stopWaiters.delete(check),
    );
  }

  return {
    validateParentOwnership: dependencies.validateParentOwnership,
    classifyInbox: dependencies.classifyInbox,
    getInbox: (recipientId) => {
      const backlog = parentInboxes.get(recipientId);
      if (!backlog) return undefined;
      return {
        count: backlog.length,
        items: backlog.flatMap(({ source }) => {
          if (!isChildSource(source)) return [];
          return [
            {
              agentId: source.agentId,
              serverId: source.serverId,
              title: source.title,
              event: source.kind === "agent-message" ? "message" : source.event,
              ...(source.kind === "agent-message" && source.reportStatus
                ? { reportStatus: source.reportStatus }
                : {}),
              ...(source.kind === "agent-message" && source.taskId
                ? { taskId: source.taskId }
                : {}),
              ...(source.kind === "agent-message" && source.rootMessageId
                ? { rootMessageId: source.rootMessageId }
                : {}),
            },
          ];
        }),
      };
    },
    flushInbox: (recipientId, taskId) => {
      if (closed || admissionPaused)
        throw new AgentMessageAdmissionError("Agent message delivery is stopping");
      if (taskId === undefined) releaseInbox(recipientId);
      else releaseInbox(recipientId, [], (message) => inboxTaskId(message) === taskId);
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
    withdrawPending: (recipientId, matches) =>
      withdrawPending(recipientId, (message) => matches(message.originalSource)),
    hasActiveBackgroundTurn: (recipientId) => activeReports(recipientId) !== undefined,
    captureActiveBackgroundTurn: (recipientId) => {
      const messages = activeReports(recipientId);
      if (!messages?.length) return undefined;
      return {
        recipientId,
        messages: messages.map((message) => ({
          recipientId: message.recipientId,
          messageId: message.receipt.messageId,
          source: { ...message.source },
          childReported: message.childReported,
          validateDispatch: message.validateDispatch,
          beforeProviderDispatch: message.beforeProviderDispatch,
          prompt: message.prompt,
          sessionMode: message.sessionMode,
          unarchive: message.unarchive,
          clearPendingPermissions: message.clearPendingPermissions,
        })),
      };
    },
    requeueBackgroundBatch(batch) {
      if (closed || admissionPaused || !batch.messages.length) return 0;
      const existingIds = new Set<string>([
        ...(inboxes.get(batch.recipientId)?.messages.map((message) => message.receipt.messageId) ??
          []),
        ...(parentInboxes.get(batch.recipientId)?.map((message) => message.receipt.messageId) ??
          []),
      ]);
      let requeued = 0;
      for (const message of batch.messages) {
        if (message.messageId && existingIds.has(message.messageId)) continue;
        this.enqueue({
          recipientId: batch.recipientId,
          messageId: message.messageId,
          source: { ...message.source },
          childReported: message.childReported,
          validateDispatch: message.validateDispatch,
          beforeProviderDispatch: message.beforeProviderDispatch,
          prompt: message.prompt,
          sessionMode: message.sessionMode,
          unarchive: message.unarchive,
          clearPendingPermissions: message.clearPendingPermissions,
          activeTurnBehavior: "queue",
        });
        if (message.messageId) existingIds.add(message.messageId);
        requeued++;
      }
      return requeued;
    },
    holdBackgroundDelivery: (recipientId) => {
      backgroundDeliveryHolds.set(recipientId, (backgroundDeliveryHolds.get(recipientId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (backgroundDeliveryHolds.get(recipientId) ?? 0) - 1;
        if (remaining > 0) {
          backgroundDeliveryHolds.set(recipientId, remaining);
          return;
        }
        backgroundDeliveryHolds.delete(recipientId);
        if (closed) return;
        const inbox = inboxes.get(recipientId);
        if (!inbox || inbox.phase !== "waiting" || !inbox.messages.some(isRunnable)) return;
        if (!isRunning(recipientId)) attempt(recipientId);
        else rest(recipientId);
      };
    },
    hasPendingTaskReport(recipientId, taskId, excludeMessageId) {
      const matches = ({ source, childReported, receipt }: Admitted) =>
        receipt.messageId !== excludeMessageId &&
        source.kind === "agent-message" &&
        source.taskId === taskId &&
        (childReported === true || source.reportStatus !== undefined);
      return (
        parentInboxes.get(recipientId)?.some(matches) === true ||
        inboxes.get(recipientId)?.messages.some(matches) === true
      );
    },
    hasPendingTopicReport(recipientId, rootMessageId, excludeMessageId) {
      const matches = ({ source, childReported, receipt }: Admitted) =>
        receipt.messageId !== excludeMessageId &&
        source.kind === "agent-message" &&
        !source.taskId &&
        source.rootMessageId === rootMessageId &&
        (childReported === true || source.reportStatus !== undefined);
      return (
        parentInboxes.get(recipientId)?.some(matches) === true ||
        inboxes.get(recipientId)?.messages.some(matches) === true
      );
    },
    hasPending(recipientId) {
      const inbox = inboxes.get(recipientId);
      return (
        parentInboxes.has(recipientId) ||
        (inbox !== undefined &&
          inbox.phase !== "held" &&
          inbox.messages.some((message) => !message.waitingForPeerRecipient))
      );
    },
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
      const activeTurnBehavior = hasMandatoryPeerDispatchMarker(message.prompt)
        ? "queue"
        : (message.activeTurnBehavior ?? "queue");
      const receipt: Receipt = {
        status: "queued",
        messageId: message.messageId ?? randomUUID(),
        activeTurnBehavior,
        guidance: describeAgentMessage({
          activeTurnBehavior,
          running: isRunning(message.recipientId),
          canSteer: Boolean(dependencies.canSteer?.(message.recipientId)),
        }),
        dispatched,
      };
      const taskAdmission = message.handoff?.waitForForegroundConfirmation
        ? attachTaskDispatchMessage(message.recipientId, receipt.messageId)
        : undefined;
      const source = { ...message.source };
      const combinedValidation = combineDispatchValidators(
        message.recipientId,
        source,
        message.prompt,
        message.validateDispatch,
      );
      const item: Admitted = {
        ...message,
        source,
        originalSource: message.source,
        validateDispatch: combinedValidation.validateDispatch,
        beginDispatchAttempt: combinedValidation.beginDispatchAttempt,
        peerTurnAuthorization: combinedValidation.peerTurnAuthorization,
        onReturnedToQueue: combinedValidation.onReturnedToQueue,
        capturePeerAcceptance: combinedValidation.capturePeerAcceptance,
        rejectHeldPeerReservation: combinedValidation.rejectHeldPeerReservation,
        taskAdmission,
        receipt,
        resolve,
        reject,
        state: "queued",
        urgency: resolveMessageUrgency(activeTurnBehavior, message.heldAfterStop),
        held: message.heldAfterStop ?? false,
        outOfBandDeclined: false,
      };
      bindValidationLifecycle(item, combinedValidation);
      if (
        message.subagentInbox === "ordinary" &&
        isChildSource(source) &&
        dependencies.shouldHoldInbox?.(message.recipientId, source)
      ) {
        const existing = parentInboxes.get(message.recipientId);
        const backlog = existing ?? [];
        backlog.push(item);
        parentInboxes.set(message.recipientId, backlog);
        syncParentInboxCaps(message.recipientId);
        dependencies.onInboxChange?.(message.recipientId);
      } else if (message.subagentInbox) {
        const taskId = inboxTaskId(item);
        releaseInbox(message.recipientId, [item], (pending) => inboxTaskId(pending) === taskId);
      } else admit(item);
      return receipt;
    },
    sendDirect<Result extends PromptDispatchResult>(
      direct: DirectPrompt,
      send: (joined: JoinedPrompt) => Promise<Result>,
    ): Promise<Result> {
      // Its place in line is decided now: what is queued goes with it, what comes later follows.
      const inbox =
        closed || isCommand(direct.prompt) ? undefined : inboxes.get(direct.recipientId);
      const ahead = [...(inbox?.messages ?? [])];
      const stopsAtSubmission = inbox?.stops;
      return new Promise<Result>((resolve, reject) => {
        run(direct.recipientId, async () => {
          // A newer Stop holds agent messages for a prompt submitted after it.
          const candidates = inbox?.stops === stopsAtSubmission ? ahead.filter(isQueued) : [];
          const canResumeHeld = candidates.some((message) => message.held);
          const riders = selectDirectRiders(candidates, direct);
          const stopped = inbox ? watchForHold(inbox) : () => false;
          const request = requestFor(direct.recipientId, riders, false, stopped);
          const joined = { ...join(riders, direct), waitForProviderPrompt: canResumeHeld };
          let result: Result;
          try {
            for (const message of riders) message.beforeDispatch?.();
            result = await send(riders.length ? { ...joined, admit: request.admit } : joined);
          } catch (error) {
            if (isUnconfirmedDispatch(error)) {
              returnUnconfirmedRiders(riders, error);
            } else {
              await joined.handoff?.declined();
              handBack(riders);
            }
            reject(error);
            return;
          }
          clearActiveBackgroundTurnIfStarted(direct.recipientId, result.disposition);
          for (const rider of riders) if (isQueued(rider)) rider.state = "claimed";
          resolve(result);
          if (!riders.length && !canResumeHeld) return;
          const accepted = await ride(direct.recipientId, riders, result);
          if (accepted && canResumeHeld && inbox && inbox.stops === stopsAtSubmission)
            resumeHeldInbox(direct.recipientId, inbox);
        });
      });
    },
    async waitForDispatch(recipientId, signal) {
      signal.throwIfAborted();
      const waiting = Array.from(
        [...(inboxes.get(recipientId)?.messages ?? []), ...(parentInboxes.get(recipientId) ?? [])],
        (message) =>
          waitForRunnableMessage(message).catch((error) => {
            if (message.state !== "withdrawn") throw error;
            return undefined;
          }),
      );
      let unsubscribeCheckpoint: (() => void) | undefined;
      let onStopCheckpoint!: (agentId: string) => void;
      const checkpoint = new Promise<void>((resolve) => {
        const check = () => {
          if (dependencies.hasPendingPermission?.(recipientId) || isHeld(recipientId)) resolve();
        };
        onStopCheckpoint = (agentId) => {
          if (agentId === recipientId) check();
        };
        stopWaiters.add(onStopCheckpoint);
        unsubscribeCheckpoint = dependencies.subscribe?.(onStopCheckpoint);
        check();
      });
      let aborted!: () => void;
      const cancellation = new Promise<never>((_resolve, reject) => {
        aborted = () => reject(new DOMException("Wait aborted", "AbortError"));
        signal.addEventListener("abort", aborted, { once: true });
      });
      try {
        await Promise.race([
          Promise.all([releasing.get(recipientId), ...waiting]),
          cancellation,
          checkpoint,
        ]);
      } finally {
        signal.removeEventListener("abort", aborted);
        unsubscribeCheckpoint?.();
        stopWaiters.delete(onStopCheckpoint);
      }
    },
    pauseAdmission() {
      admissionPaused = true;
      return {
        drained: drain(),
        release() {
          admissionPaused = false;
          refreshInbox();
          for (const [recipientId, inbox] of inboxes) {
            for (const message of inbox.messages) message.drainSteerDeclined = false;
            rest(recipientId);
          }
        },
      };
    },
    close(options) {
      if (closing) return closing;
      if (queuesDrainedOnClose) {
        const retryFlush = flushAllHostPendingPeerOutcomes().finally(() => {
          if (closing === retryFlush) closing = undefined;
        });
        closing = retryFlush;
        return retryFlush;
      }
      closed = true;
      activeBackgroundTurns.clear();
      backgroundDeliveryHolds.clear();
      unsubscribe?.();
      unsubscribeStop?.();
      const receipts: Promise<unknown>[] = [];
      const deferred =
        options?.deferWith ?? new AgentMessageAdmissionError("Inbox retained for restart");
      for (const caps of parentInboxCaps.values()) {
        for (const cancel of caps.values()) cancel();
      }
      parentInboxCaps.clear();
      for (const backlog of parentInboxes.values())
        for (const message of backlog) {
          message.retainedForRestart = true;
          message.state = "withdrawn";
          message.reject(deferred);
        }
      parentInboxes.clear();
      for (const [recipientId, inbox] of inboxes) {
        inbox.cancelTimer();
        inbox.cancelCap();
        const retainHeld = (message: Admitted) =>
          Boolean(message.waitingForPeerRecipient) ||
          (inbox.phase === "held" && Boolean(message.handoff?.holdAfterStop)) ||
          (Boolean(message.subagentInbox) && isRunning(recipientId));
        const deferQueued = (matches: (message: Admitted) => boolean) => {
          for (const message of inbox.messages.filter(matches)) {
            if (!isQueued(message)) continue;
            message.retainedForRestart = true;
            settle(message, "withdrawn");
            message.reject(deferred);
          }
        };
        if (options?.deferWith) {
          deferQueued(() => true);
          // The caller has timed out waiting for this recipient. Defer anything
          // an in-flight attempt later returns to the queue without blocking shutdown.
          if (inbox.messages.length) run(recipientId, async () => deferQueued(() => true));
          continue;
        }
        deferQueued(retainHeld);
        if (!inbox.messages.length) continue;
        receipts.push(...inbox.messages.map((message) => message.receipt.dispatched));
        run(recipientId, async () => {
          // An in-flight attempt can return held messages after close has started.
          deferQueued(retainHeld);
          try {
            for (const group of modeGroups(inbox.messages.filter(isQueued)))
              await deliver(recipientId, inbox, group, false, () => false).catch(() => undefined);
          } finally {
            deferQueued(() => true);
          }
        });
      }
      closing = (async () => {
        await Promise.allSettled([...receipts, ...stopWrites]);
        while (outcomeWrites.size > 0) {
          await Promise.allSettled(outcomeWrites);
        }
        queuesDrainedOnClose = true;
        try {
          await flushAllHostPendingPeerOutcomes();
        } catch (error) {
          closing = undefined;
          throw error;
        }
      })();
      return closing;
    },
  };
}
