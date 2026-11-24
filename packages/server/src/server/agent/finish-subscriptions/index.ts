import { setTimeout as pause } from "node:timers/promises";
import { HostObservationError, type ToolHosts } from "../host-operations/index.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { AgentExplicitFinishReport, AgentFinishReport } from "@getpaseo/protocol/messages";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { FinishObservationResult } from "./internal/observation-buffer.js";
import type { AgentMessageDelivery, AgentPromptSource } from "../agent-messages/index.js";
import { resolveReportTitle } from "../report-title.js";
import { getParentAddressFromLabels, PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { AgentRequestOutcomeUnknownError } from "../../message-receipts/index.js";
import { decodeParentReportIdentity, encodeParentReportIdentity } from "./report-identity.js";
import {
  formatFinishNotificationBody,
  finishNotificationEvents,
  type FinishNotificationReason,
} from "./internal/notification.js";
export { createJsonFinishSubscriptionStore } from "./internal/json-store.js";

export interface FinishSubscription {
  id: string;
  callerAgentId: string;
  callerServerId?: string;
  childAgentId: string;
  serverId?: string;
  /** Creation subscriptions stop reporting after the child is detached. */
  requireParentOwnership?: boolean;
  /** Allows the remote parent to fetch this turn's reports on its forward connection. */
  followupReport?: boolean;
  /** Authenticated source of a remote observation binding. */
  pullSourceId?: string;
  report?: AgentFinishReport;
  /** An explicit report covered this watch's current result; keep permission checkpoints. */
  suppressFinished?: boolean;
  /** Carries the suppression across a crash between the two stores. */
  supersedesFinished?: string[];
  reportTurnId?: string;
}
export interface FinishSubscriptionStore {
  list(): Promise<FinishSubscription[]>;
  put(subscription: FinishSubscription): Promise<void>;
  remove(id: string): Promise<void>;
}
export interface FinishObservationSession {
  next(): Promise<FinishObservationResult>;
  close(): Promise<void>;
}
export interface FinishObservation {
  open(subscription: FinishSubscription, signal: AbortSignal): Promise<FinishObservationSession>;
}
interface Dependencies extends FinishObservation {
  store: FinishSubscriptionStore;
  followups?: {
    watches: FinishSubscriptionStore;
    reports: FinishSubscriptionStore;
    dispatch(record: FinishSubscription, report: AgentFinishReport): Promise<void>;
  };
  messages(): AgentMessageDelivery;
  hosts?(): ToolHosts;
  callerIsActive(agentId: string): Promise<boolean>;
  serverId: string;
  logger: Logger;
  retryDelayMs?: number;
}
export interface FinishRegistration {
  /** The prompt was accepted. Replaces preceding registrations for this pair. */
  accept(): void;
  /** Rejected dispatch preserves preceding registrations. */
  reject(): Promise<void>;
}
export class ParentReportRecipientUnavailableError extends Error {}

export interface FinishSubscriptions {
  start(): Promise<void>;
  /** Pending notification intent, including registration, recovery and unacknowledged delivery. */
  hasPendingForCaller(agentId: string): boolean;
  register(
    input: Omit<FinishSubscription, "id"> & {
      automaticParent?: boolean;
      canRegister?: () => boolean;
    },
    pendingDispatch?: boolean,
  ): Promise<FinishRegistration>;
  cancelAutomaticParent(childAgentId: string, callerAgentId: string): Promise<void>;
  isFinishedSuppressed?(id: string): boolean;
  trackRemoteChild(input: Omit<FinishSubscription, "id">): Promise<void>;
  queueParentReport(
    address: Pick<FinishSubscription, "childAgentId" | "callerAgentId" | "callerServerId">,
    content: {
      status: NonNullable<AgentFinishReport["parentReportStatus"]>;
      title?: string;
      summary: string;
      turnId?: string;
    },
  ): Promise<string>;
  confirmParentReport(
    address: Pick<FinishSubscription, "childAgentId" | "callerAgentId" | "callerServerId">,
    reportId: string,
  ): Promise<boolean>;
  readConfirmedParentReport(
    address: Pick<FinishSubscription, "childAgentId" | "callerAgentId" | "callerServerId">,
    reportId: string,
  ): Promise<AgentExplicitFinishReport | undefined>;
  suppressRemoteFinished?(
    address: Pick<FinishSubscription, "childAgentId" | "callerAgentId" | "serverId">,
    turnId: string,
  ): Promise<void>;
  pullReports(
    address: {
      childAgentId: string;
      callerAgentId: string;
      callerServerId: string;
      sourceId: string;
    },
    acknowledged: string[],
    observe: boolean,
    childState: "active" | "archived" | "unrelated",
    includeParentReports?: boolean,
  ): Promise<{ ownsBinding: boolean; reports: AgentFinishReport[] }>;
  close(): Promise<void>;
}
interface Watch {
  records: FinishSubscription[];
  controller: AbortController;
  decision: Promise<boolean>;
  decide(accepted: boolean): void;
  pending: boolean;
  acknowledged?: boolean;
  task?: Promise<void>;
  queued: Set<AgentPromptSource>;
  resultTurnId?: string;
  captured?: FinishSubscription & { report: AgentFinishReport };
}
const AUTOMATIC_PARENT_PREFIX = "automatic-parent:";
const REQUESTED_PARENT_PREFIX = "requested-parent:";
const REPORT_PAGE_SIZE = 8;

function remoteReportId(record: FinishSubscription): string {
  return record.report?.parentReportStatus
    ? encodeParentReportIdentity(record.id, record.supersedesFinished ?? [], record.reportTurnId)
    : record.id;
}

export function isAutomaticLocalParentSubscription(record: FinishSubscription): boolean {
  // Older IDs cannot distinguish a default watch from an explicit request.
  // Keep that existing intent until it settles without renewing it automatically.
  return (
    !record.serverId &&
    !record.callerServerId &&
    record.requireParentOwnership === true &&
    record.id.startsWith(AUTOMATIC_PARENT_PREFIX)
  );
}
function isAutomaticParentSubscription(record: FinishSubscription): boolean {
  return record.requireParentOwnership === true && record.id.startsWith(AUTOMATIC_PARENT_PREFIX);
}
function key(record: Omit<FinishSubscription, "id">): string {
  return JSON.stringify([
    record.callerAgentId,
    record.childAgentId,
    record.serverId,
    record.callerServerId,
  ]);
}

function isAgentMessageDispatchConfirmationUnsupported(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "AGENT_MESSAGE_DISPATCH_CONFIRMATION_UNSUPPORTED"
  );
}

function isFinishReportPushUnsupported(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "AGENT_FINISH_REPORT_PUSH_UNSUPPORTED"
  );
}

/** Owns durable intent, live observation, supersession, and dispatch acknowledgment. */
export function createFinishSubscriptions(deps: Dependencies): FinishSubscriptions {
  const tasks = new Set<Promise<void>>();
  const watches = new Map<string, Set<Watch>>();
  const followupWatches = new Map<string, AbortController>();
  const remoteReportTasks = new Map<string, AbortController>();
  const lastReportByBinding = new Map<string, string>();
  const suppressedFinished = new Set<string>();
  const remoteExplicitTurns = new Set<string>();
  let reportMutations = Promise.resolve();
  function serializeReports<T>(action: () => Promise<T>): Promise<T> {
    const result = reportMutations.then(action);
    reportMutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  let closed = false;
  let recovering = true;
  const registering = new Map<string, number>();
  let mutations = Promise.resolve();
  const skippedRegistration: FinishRegistration = { accept() {}, reject: async () => {} };
  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = mutations.then(action);
    mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  function attach(records: FinishSubscription[], pending: boolean): Watch {
    let decide!: Watch["decide"];
    const decision = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    const watch: Watch = {
      records,
      controller: new AbortController(),
      pending,
      decision,
      decide,
      queued: new Set(),
      resultTurnId: records[0]?.reportTurnId,
    };
    const stored = records[0]!;
    if (stored.report) watch.captured = { ...stored, report: stored.report };
    const group = watches.get(key(records[0]!)) ?? new Set<Watch>();
    group.add(watch);
    watches.set(key(records[0]!), group);
    if (!pending) decide(true);
    watch.task = run(watch, group).catch((error) =>
      deps.logger.error({ err: error }, "Finish subscription failed"),
    );
    tasks.add(watch.task);
    void watch.task.then(() => tasks.delete(watch.task!));
    return watch;
  }
  function stop(watch: Watch, group: Set<Watch>): void {
    watch.controller.abort();
    watch.decide(false);
    group.delete(watch);
    if (!group.size && watches.get(key(watch.records[0]!)) === group)
      watches.delete(key(watch.records[0]!));
  }
  function stopAutomatic(watch: Watch, group: Set<Watch>): void {
    stop(watch, group);
    if (watch.captured)
      deps.messages().withdrawInboxReport?.(watch.captured.callerAgentId, watch.captured.id);
    if (watch.queued.size) {
      deps
        .messages()
        .withdrawPending(watch.records[0]!.callerAgentId, (source) => watch.queued.has(source));
    }
  }
  async function remove(watch: Watch): Promise<void> {
    // Only IDs captured by this observer are eligible; newer registrations survive.
    for (const record of watch.records) {
      await deps.store.remove(record.id);
      if (record.followupReport && suppressedFinished.has(record.id) && deps.followups)
        await serializeReports(() => deps.followups!.reports.remove(record.id));
      suppressedFinished.delete(record.id);
    }
  }
  async function delay(signal: AbortSignal, attempt: number): Promise<void> {
    try {
      await pause(
        Math.min((deps.retryDelayMs ?? 1000) * 2 ** Math.min(attempt, 3), 5000),
        undefined,
        { signal },
      );
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
  async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([operation, cancellation]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async function decisions(group: Set<Watch>): Promise<void> {
    // New candidates may arrive while an older dispatch decision is pending.
    while (true) {
      if (closed) return;
      const pending = [...group].filter((watch) => watch.pending);
      if (!pending.length) return;
      await Promise.all(pending.map((watch) => watch.decision));
    }
  }
  async function suppressed(
    record: FinishSubscription,
    result?: WaitForFinishResult,
  ): Promise<boolean> {
    if (!record.callerServerId && !(await deps.callerIsActive(record.callerAgentId))) return true;
    if (!record.requireParentOwnership || !result?.final) return false;
    const parent = getParentAddressFromLabels(
      result.final.labels,
      record.serverId ?? deps.serverId,
    );
    return (
      parent?.agentId !== record.callerAgentId ||
      parent.serverId !== (record.callerServerId ?? deps.serverId)
    );
  }
  function reasonFor(result: FinishObservationResult): FinishNotificationReason {
    if (result.reason === "host unreachable" || result.reason === "host removed")
      return result.reason;
    if (!result.final) return "is unavailable";
    if (result.final.status === "closed") return "was closed";
    if (result.status === "error") return "errored";
    if (result.status === "permission") return "needs permission";
    return result.reason ?? "finished";
  }
  function notificationId(subscriptionId: string, permissionId?: string): string {
    return permissionId ? subscriptionId + ":" + permissionId : subscriptionId;
  }

  async function deliverRemote(
    record: FinishSubscription & { callerServerId: string },
    childServerId: string,
    report: AgentFinishReport,
    signal: AbortSignal,
    preferPull = false,
  ): Promise<boolean> {
    if (!deps.hosts) throw new Error("Remote finish delivery is unavailable");
    return deps.hosts().use(
      record.callerServerId,
      async (client) => {
        const caller = (await client.fetchAgent(record.callerAgentId))?.agent;
        if (!caller || caller.archivedAt) return false;
        if (preferPull && client.getLastServerInfoMessage()?.features?.subagentInbox) return false;
        const receipt = await client.sendMessage(record.callerAgentId, report.prompt, {
          messageId: report.id,
          sourceAgentId: record.childAgentId,
          sourceAgentServerId: childServerId,
          ...(client.getLastServerInfoMessage()?.features?.agentNotificationEvents === true
            ? { sourceAgentEvent: report.event }
            : {}),
          activeTurnBehavior: "steer",
          waitForDispatch: true,
        });
        if (receipt.deliveryStatus === "queued")
          throw new Error("Remote finish notification has not been dispatched");
        return true;
      },
      signal,
    );
  }

  async function tryReverseNotification(
    record: FinishSubscription & { callerServerId: string },
    childServerId: string,
    report: AgentFinishReport,
    bound: boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!bound) return deliverRemote(record, childServerId, report, signal);
    // A pull binding survives disconnects. Use a live reverse connection even if
    // the parent has polled in the past. Both paths share the notification receipt.
    try {
      const directory = await deps.hosts?.().directory();
      if (
        !directory?.hosts.some(
          (host) => host.serverId === record.callerServerId && host.status === "online",
        )
      )
        return false;
      return await deliverRemote(record, childServerId, report, signal, true);
    } catch (error) {
      if (signal.aborted) throw error;
      // The parent can still pull the saved report if reverse dispatch is unconfirmed.
      return false;
    }
  }

  function permissionRequests(result: FinishObservationResult, notified: Set<string>) {
    const requests = result.final?.pendingPermissions ?? [];
    for (const id of notified)
      if (!requests.some((request) => request.id === id)) notified.delete(id);
    return requests.filter((request) => !notified.has(request.id));
  }

  async function enqueueLocalNotification(
    record: FinishSubscription,
    report: AgentFinishReport,
    hasFinalSnapshot: boolean,
    watch: Watch,
  ) {
    const messages = deps.messages();
    const validateParentOwnership = messages.validateParentOwnership;
    const validate =
      record.requireParentOwnership &&
      (hasFinalSnapshot || isAutomaticLocalParentSubscription(record));
    const validation = { ...record, hasFinalSnapshot };
    const title = resolveReportTitle(record.childAgentId, report.title);
    const source: AgentPromptSource = {
      kind: "agent-notification",
      agentId: record.childAgentId,
      serverId: record.serverId ?? deps.serverId,
      ...(title ? { title } : {}),
      event: report.event,
    };
    const subagentInbox =
      record.requireParentOwnership &&
      (report.event !== "finished" || isAutomaticParentSubscription(record))
        ? await messages.classifyInbox?.(record.callerAgentId, source)
        : undefined;
    if (
      watch.controller.signal.aborted ||
      (report.event === "finished" && suppressedFinished.has(record.id))
    )
      return undefined;
    const receipt = messages.enqueue({
      recipientId: record.callerAgentId,
      prompt: report.prompt,
      source,
      subagentInbox,
      activeTurnBehavior: "steer",
      unarchive: false,
      // The observation's snapshot cannot authorize a notification that
      // waited behind another turn or the recipient's quiet window.
      validateDispatch:
        validate && validateParentOwnership ? () => validateParentOwnership(validation) : undefined,
    });
    watch.queued.add(source);
    void receipt.dispatched.then(
      () => watch.queued.delete(source),
      () => watch.queued.delete(source),
    );
    return receipt;
  }

  function isSuppressedFinish(
    record: FinishSubscription,
    result: FinishObservationResult,
    report: AgentFinishReport,
  ): boolean {
    return (
      report.event === "finished" &&
      (suppressedFinished.has(record.id) ||
        (isAutomaticParentSubscription(record) &&
          !!result.turnId &&
          remoteExplicitTurns.has(JSON.stringify([key(record), result.turnId]))))
    );
  }

  async function saveRemoteFollowup(
    record: FinishSubscription,
    report: AgentFinishReport,
    saved: Set<string>,
    turnId?: string,
  ): Promise<boolean> {
    const followups = deps.followups;
    if (!followups || !record.followupReport) return false;
    return serializeReports(async () => {
      if (report.event === "finished" && suppressedFinished.has(record.id)) return false;
      const binding = (await followups.watches.list()).find((entry) => entry.id === key(record));
      if (!saved.has(report.id)) {
        // The result can precede the parent's first pull.
        await followups.reports.put({
          ...record,
          id: report.id,
          pullSourceId: binding?.pullSourceId,
          report,
          reportTurnId: turnId,
        });
        saved.add(report.id);
      }
      return Boolean(binding);
    });
  }

  async function dispatchRemoteNotification(
    record: FinishSubscription & { callerServerId: string },
    childServerId: string,
    report: AgentFinishReport,
    bound: boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    const dispatched = await tryReverseNotification(record, childServerId, report, bound, signal);
    if (record.followupReport && dispatched)
      await serializeReports(async () => {
        await deps.followups?.reports.remove(report.id);
      });
    return bound || dispatched;
  }

  async function dispatchCapturedReport(
    record: FinishSubscription,
    report: AgentFinishReport,
    signal: AbortSignal,
  ): Promise<void> {
    if (!deps.followups || suppressedFinished.has(record.id)) return;
    try {
      await abortable(deps.followups.dispatch(record, report), signal);
    } catch (error) {
      if (
        !suppressedFinished.has(record.id) &&
        !(error instanceof ParentReportRecipientUnavailableError)
      )
        throw error;
    }
  }

  async function captureLocalFinish(
    record: FinishSubscription,
    report: AgentFinishReport,
    result: FinishObservationResult,
    watch: Watch,
  ): Promise<boolean> {
    const { signal } = watch.controller;
    if (
      report.event !== "finished" ||
      !result.final ||
      !deps.followups ||
      !isAutomaticParentSubscription(record)
    )
      return false;
    const title = resolveReportTitle(record.childAgentId, report.title);
    const inbox = await deps.messages().classifyInbox?.(record.callerAgentId, {
      kind: "agent-notification",
      agentId: record.childAgentId,
      serverId: record.serverId ?? deps.serverId,
      ...(title ? { title } : {}),
      event: "finished",
    });
    if (!inbox) return false;
    const captured = { ...record, report, reportTurnId: result.turnId };
    await serialize(async () => {
      if (!signal.aborted && !isSuppressedFinish(record, result, report)) {
        await deps.store.put(captured);
        watch.captured = captured;
      }
    });
    if (!signal.aborted && !isSuppressedFinish(record, result, report))
      await dispatchCapturedReport(captured, report, signal);
    return true;
  }

  async function deliver(
    record: FinishSubscription,
    result: FinishObservationResult,
    permissions: Set<string>,
    savedFollowups: Set<string>,
    watch: Watch,
  ): Promise<boolean> {
    const { signal } = watch.controller;
    const requests = permissionRequests(result, permissions);
    const reason = reasonFor(result);
    const acknowledgments: Promise<unknown>[] = [];
    for (const request of reason === "needs permission" ? requests : [undefined]) {
      if (signal.aborted) return false;
      const title = resolveReportTitle(record.childAgentId, result.final?.title) ?? "";
      const childServerId = record.serverId ?? deps.serverId;
      const prompt = formatFinishNotificationBody({
        childAgentId: record.childAgentId,
        serverId: childServerId,
        title,
        reason,
        lastAssistantMessage: result.lastMessage,
        permissionRequest: request,
      });
      const id = notificationId(record.id, request?.id);
      const report = { id, prompt, title, event: finishNotificationEvents[reason] };
      if (isSuppressedFinish(record, result, report)) return true;
      const bound = await saveRemoteFollowup(record, report, savedFollowups, result.turnId);
      if (signal.aborted || isSuppressedFinish(record, result, report)) return true;
      if (record.callerServerId) {
        const handled = await dispatchRemoteNotification(
          { ...record, callerServerId: record.callerServerId },
          childServerId,
          report,
          bound,
          signal,
        );
        if (!handled) return true;
        if (request) permissions.add(request.id);
        continue;
      }
      if (await captureLocalFinish(record, report, result, watch)) return true;
      const receipt = await enqueueLocalNotification(record, report, Boolean(result.final), watch);
      if (!receipt) return !signal.aborted;
      acknowledgments.push(
        receipt.dispatched.then(() => {
          if (request) permissions.add(request.id);
          return undefined;
        }),
      );
    }
    try {
      await abortable(Promise.all(acknowledgments), signal);
    } catch (error) {
      if (error instanceof ParentReportRecipientUnavailableError) return true;
      throw error;
    }
    return !signal.aborted && reason !== "needs permission";
  }
  async function run(watch: Watch, group: Set<Watch>): Promise<void> {
    const signal = watch.controller.signal;
    if (!(await watch.decision) || signal.aborted) return;
    const record = {
      ...(watch.records.find((intent) => !isAutomaticLocalParentSubscription(intent)) ??
        watch.records[0]!),
      requireParentOwnership: watch.records.every(
        (intent) => intent.requireParentOwnership === true,
      ),
    };
    const permissions = new Set<string>();
    const savedFollowups = new Set<string>();
    let observation: FinishObservationSession | undefined;
    let pending: FinishObservationResult | undefined;
    let remoteFailures = 0;
    let retries = 0;
    let warned = false;
    async function deliverCapturedResult(
      captured: FinishSubscription & { report: AgentFinishReport },
    ): Promise<void> {
      if (watch.acknowledged) return;
      await dispatchCapturedReport(captured, captured.report, signal);
      watch.acknowledged = true;
    }
    async function observeNext(): Promise<FinishObservationResult | undefined> {
      try {
        observation ??= await deps.open(record, signal);
        const result = await abortable(observation.next(), signal);
        remoteFailures = 0;
        // An observation opened after a fast remote turn sees the settled snapshot
        // without a terminal event. Recover its identity from the same timeline.
        if (
          !result.turnId &&
          result.final?.status === "idle" &&
          record.serverId &&
          isAutomaticParentSubscription(record) &&
          deps.hosts
        ) {
          const settled = result.final;
          const turnId = await deps
            .hosts()
            .use(
              record.serverId,
              async (client) => {
                const timeline = await client.fetchAgentTimeline(record.childAgentId, {
                  direction: "tail",
                  limit: 1,
                });
                const current = (await client.fetchAgent(record.childAgentId))?.agent;
                if (
                  current?.status === "idle" &&
                  current.lastUserMessageAt === settled.lastUserMessageAt &&
                  current.updatedAt === settled.updatedAt
                )
                  return timeline.entries.at(-1)?.turnId;
                return undefined;
              },
              signal,
            )
            .catch(() => undefined);
          return { ...result, turnId };
        }
        return result;
      } catch (error) {
        await observation?.close();
        observation = undefined;
        signal.throwIfAborted();
        if (!(error instanceof HostObservationError) || !record.serverId) throw error;
        if (error.reason === "connecting") return undefined;
        if (error.reason === "unreachable" && ++remoteFailures < 3) return undefined;
        // Host visibility ends this subscription; it says nothing about child completion.
        return {
          status: "error",
          final: null,
          lastMessage: null,
          error: null,
          reason: error.reason === "removed" ? "host removed" : "host unreachable",
        };
      }
    }
    try {
      while (!signal.aborted) {
        try {
          if (await suppressed(record)) {
            await remove(watch);
            stop(watch, group);
            return;
          }
          if (watch.captured) {
            await deliverCapturedResult(watch.captured);
            await remove(watch);
            stop(watch, group);
            return;
          }
          pending ??= await observeNext();
          if (!pending) {
            await delay(signal, retries++);
            continue;
          }
          watch.resultTurnId = pending.turnId;
          if (signal.aborted) return;
          // A queued follow-up cannot start until the current permission is answered.
          // Its pending registration must not hold the running turn's checkpoint.
          if (pending.status !== "permission" || watch.pending) await decisions(group);
          if (await suppressed(record, pending)) {
            await remove(watch);
            stop(watch, group);
            return;
          }
          if (!watch.acknowledged)
            watch.acknowledged = await deliver(record, pending, permissions, savedFollowups, watch);
          if (watch.acknowledged) {
            // A removal failure retries only the commit, never the already accepted callback.
            await remove(watch);
            stop(watch, group);
            return;
          }
          pending = undefined;
          retries = 0;
          warned = false;
        } catch (error) {
          if (signal.aborted) return;
          if (isAgentMessageDispatchConfirmationUnsupported(error)) {
            // Keep the intent for recovery on restart after the parent host is updated.
            deps.logger.warn(
              { err: error, subscription: record.id, callerServerId: record.callerServerId },
              "Finish notification paused. Update the parent host to support message dispatch confirmation.",
            );
            return;
          }
          // Delivery and storage failures retain the captured outcome and durable intent.
          // They do not spend the remote-observation budget or change the child's outcome.
          if (!warned) {
            deps.logger.warn(
              { err: error, subscription: record.id },
              "Retrying finish subscription",
            );
            warned = true;
          }
          await delay(signal, retries++);
        }
      }
    } finally {
      await observation?.close();
    }
  }

  const localReportTasks = new Map<string, AbortController>();
  async function removeDeliveredReport(record: FinishSubscription): Promise<void> {
    const reports = deps.followups!.reports;
    if (record.callerServerId)
      for (const id of record.supersedesFinished ?? []) await reports.remove(id);
    await reports.remove(record.id);
  }
  async function finishParentReport(record: FinishSubscription): Promise<void> {
    await serialize(async () => {
      if (record.supersedesFinished?.length) {
        const covered = new Set(record.supersedesFinished);
        for (const entry of await deps.store.list()) {
          if (!entry.suppressFinished && covered.has(entry.id))
            await deps.store.put({ ...entry, suppressFinished: true });
        }
      }
      await serializeReports(() => removeDeliveredReport(record));
    });
  }
  function startLocalReport(record: FinishSubscription, report: AgentFinishReport): void {
    if (!deps.followups || localReportTasks.has(record.id)) return;
    const { dispatch } = deps.followups;
    const controller = new AbortController();
    const { signal } = controller;
    localReportTasks.set(record.id, controller);
    const task = (async () => {
      let warned = false;
      while (!signal.aborted) {
        try {
          try {
            await abortable(dispatch(record, report), signal);
          } catch (error) {
            if (!(error instanceof ParentReportRecipientUnavailableError)) throw error;
          }
          await finishParentReport(record);
          return;
        } catch (error) {
          if (signal.aborted) return;
          if (!warned) {
            warned = true;
            deps.logger.warn({ err: error, reportId: record.id }, "Retrying parent report");
          }
          await delay(signal, 3);
        }
      }
    })();
    tasks.add(task);
    void task.then(() => {
      localReportTasks.delete(record.id);
      tasks.delete(task);
      return undefined;
    });
  }

  function startRemoteReport(
    record: FinishSubscription & { callerServerId: string },
    report: AgentFinishReport,
  ): void {
    if (!deps.followups || !deps.hosts || remoteReportTasks.has(record.id)) return;
    if (report.parentReportStatus === undefined) return;
    const controller = new AbortController();
    const { signal } = controller;
    remoteReportTasks.set(record.id, controller);
    const task = (async () => {
      let warned = false;
      while (!signal.aborted) {
        try {
          const hosts = deps.hosts?.();
          if (!hosts) return;
          const response = await abortable(
            hosts.use(
              record.callerServerId,
              (client) =>
                client.pushAgentFinishReport(record.childAgentId, record.callerAgentId, {
                  ...report,
                  id: remoteReportId(record),
                } as AgentExplicitFinishReport),
              signal,
              record.childAgentId,
            ),
            signal,
          );
          await finishParentReport(record);
          if (!response.accepted) return;
          return;
        } catch (error) {
          if (signal.aborted) return;
          if (isFinishReportPushUnsupported(error)) return;
          if (!warned) {
            warned = true;
            deps.logger.warn(
              { err: error, reportId: record.id, callerServerId: record.callerServerId },
              "Retrying explicit parent report push",
            );
          }
          await delay(signal, 0);
        }
      }
    })();
    tasks.add(task);
    void task.then(() => {
      remoteReportTasks.delete(record.id);
      tasks.delete(task);
      return undefined;
    });
  }

  function startFollowupWatch(record: FinishSubscription): void {
    if (!deps.followups || !deps.hosts || !record.serverId || followupWatches.has(record.id))
      return;
    const followups = deps.followups;
    const serverId = record.serverId;
    const controller = new AbortController();
    const { signal } = controller;
    followupWatches.set(record.id, controller);
    const { callerAgentId, childAgentId } = record;
    const reportChildState = deps.messages().observeRemoteChild;
    const observeChildState = async () => {
      if (!reportChildState) return;
      try {
        await deps.hosts!().use(
          serverId,
          async (client) => {
            const observation = client.observeAgents({
              filter: { labels: { [PARENT_AGENT_ID_LABEL]: callerAgentId } },
              signal,
            });
            const publish = (child?: AgentSnapshotPayload) => {
              const parent = getParentAddressFromLabels(child?.labels, serverId);
              reportChildState(
                callerAgentId,
                serverId,
                childAgentId,
                Boolean(
                  child &&
                  !child.archivedAt &&
                  parent?.serverId === deps.serverId &&
                  parent.agentId === callerAgentId &&
                  (child.status === "running" ||
                    child.status === "initializing" ||
                    child.activeTurn),
                ),
              );
            };
            let disconnect!: (error: unknown) => void;
            const disconnected = new Promise<never>((_resolve, reject) => {
              disconnect = reject;
            });
            const unsubscribe = observation.subscribe({
              snapshot: (snapshot) =>
                publish(snapshot.entries.find(({ agent }) => agent.id === childAgentId)?.agent),
              update: (update) => {
                if (update.type !== "agent_update") return;
                const payload = update.payload;
                if (payload.kind === "upsert" && payload.agent.id === childAgentId)
                  publish(payload.agent);
                if (payload.kind === "remove" && payload.agentId === childAgentId) publish();
              },
              error: disconnect,
            });
            try {
              await abortable(Promise.all([observation.ready, disconnected]), signal);
            } finally {
              unsubscribe();
              await observation.release();
            }
          },
          signal,
        );
      } catch (error) {
        if (!signal.aborted)
          deps.logger.debug(
            { err: error, subscription: record.id },
            "Remote child state observation disconnected",
          );
      } finally {
        reportChildState(callerAgentId, serverId, childAgentId, false);
      }
    };
    let stateTask: Promise<void> | undefined;
    const task = (async () => {
      let acknowledged: string[] = [];
      const outcomesUnknown = new Set<string>();
      const pendingReports = new Map<string, Promise<void>>();
      function dispatchReports(reports: AgentFinishReport[]): void {
        for (const report of reports) {
          if (signal.aborted || pendingReports.has(report.id) || acknowledged.includes(report.id))
            continue;
          const dispatch = (async () => {
            if (!(await deps.callerIsActive(record.callerAgentId))) return;
            try {
              await abortable(
                followups.dispatch({ ...record, requireParentOwnership: true }, report),
                signal,
              );
              outcomesUnknown.delete(report.id);
              acknowledged.push(report.id);
            } catch (error) {
              if (signal.aborted) return;
              if (error instanceof ParentReportRecipientUnavailableError) {
                acknowledged.push(report.id);
              } else if (!outcomesUnknown.has(report.id)) {
                outcomesUnknown.add(report.id);
                deps.logger.warn(
                  { err: error, reportId: report.id, subscription: record.id },
                  error instanceof AgentRequestOutcomeUnknownError
                    ? "Remote finish report awaits delivery verification"
                    : "Retrying remote finish report",
                );
              }
            }
          })().finally(() => pendingReports.delete(report.id));
          pendingReports.set(report.id, dispatch);
          void dispatch.catch((err) =>
            deps.logger.warn({ err }, "Failed to dispatch remote finish report"),
          );
        }
      }
      let warned = false;
      while (!signal.aborted) {
        try {
          const hosts = deps.hosts!();
          const host = (await hosts.directory()).hosts.find((row) => row.serverId === serverId);
          if (!(await deps.callerIsActive(record.callerAgentId)) || !host) {
            await followups.watches.remove(record.id);
            return;
          }
          if (host.status === "online") {
            if (!stateTask && reportChildState)
              stateTask = observeChildState().finally(() => {
                stateTask = undefined;
              });
            const sentAcknowledgments = acknowledged.splice(0, REPORT_PAGE_SIZE);
            const response = await hosts
              .use(
                serverId,
                (client) =>
                  client.pullAgentFinishReports(
                    record.childAgentId,
                    record.callerAgentId,
                    sentAcknowledgments,
                    true,
                  ),
                signal,
              )
              .catch((error) => {
                acknowledged.unshift(...sentAcknowledgments);
                throw error;
              });
            signal.throwIfAborted();
            if (response.error) {
              acknowledged.unshift(...sentAcknowledgments);
              throw new Error(response.error);
            }
            if (!response.ownsChild) {
              await followups.watches.remove(record.id);
              return;
            }
            dispatchReports(response.reports);
            warned = false;
            if (acknowledged.length) continue;
          }
        } catch (error) {
          if (signal.aborted) return;
          if (!warned) {
            deps.logger.warn(
              { err: error, subscription: record.id },
              "Retrying remote follow-up observation",
            );
            warned = true;
          }
        }
        await delay(signal, 3);
      }
    })();
    tasks.add(task);
    void task
      .finally(() => {
        controller.abort();
        followupWatches.delete(record.id);
        tasks.delete(task);
      })
      .catch(() => undefined);
  }

  async function restoreFinishWatches(): Promise<void> {
    const groups = new Map<string, FinishSubscription[]>();
    for (const record of await deps.store.list()) {
      if (record.suppressFinished) suppressedFinished.add(record.id);
      if (record.report) {
        attach([record], false);
        continue;
      }
      const records = groups.get(key(record)) ?? [];
      records.push(record);
      groups.set(key(record), records);
    }
    for (const records of groups.values()) attach(records, false);
  }

  const readConfirmedParentReport: FinishSubscriptions["readConfirmedParentReport"] = (
    address,
    reportId,
  ) =>
    serializeReports(async () => {
      const reports = deps.followups?.reports;
      if (!reports) return undefined;
      const expected = key(address);
      const identity = decodeParentReportIdentity(reportId);
      const record = (await reports.list()).find(
        (entry) =>
          entry.id === identity.id &&
          key(entry) === expected &&
          entry.report?.id === identity.id &&
          entry.report.parentReportStatus !== undefined,
      );
      if (!record?.report?.parentReportStatus) return undefined;
      if (reportId !== identity.id && reportId !== remoteReportId(record)) return undefined;
      return {
        ...record.report,
        id: reportId,
        parentReportStatus: record.report.parentReportStatus,
      };
    });

  return {
    isFinishedSuppressed: (id) => suppressedFinished.has(id),
    async suppressRemoteFinished(address, turnId) {
      const pair = key(address);
      const turn = JSON.stringify([pair, turnId]);
      remoteExplicitTurns.delete(turn);
      remoteExplicitTurns.add(turn);
      if (remoteExplicitTurns.size > 1024)
        remoteExplicitTurns.delete(remoteExplicitTurns.values().next().value!);
      await serialize(async () => {
        // The parent may restart after acknowledging the explicit report on
        // the child host. Do not recover a captured finish it already replaced.
        for (const entry of await deps.store.list()) {
          if (
            key(entry) === pair &&
            entry.reportTurnId === turnId &&
            entry.report?.event === "finished" &&
            isAutomaticParentSubscription(entry) &&
            !entry.suppressFinished
          )
            await deps.store.put({ ...entry, suppressFinished: true });
        }
      });
      for (const watch of watches.get(pair) ?? []) {
        if (watch.resultTurnId !== turnId || !watch.records.every(isAutomaticParentSubscription))
          continue;
        for (const entry of watch.records) suppressedFinished.add(entry.id);
        deps
          .messages()
          .withdrawPending(
            address.callerAgentId,
            (source) =>
              source.kind === "agent-notification" &&
              source.event === "finished" &&
              watch.queued.has(source),
          );
        for (const entry of watch.records)
          deps.messages().withdrawInboxReport?.(address.callerAgentId, entry.id);
      }
    },
    hasPendingForCaller(agentId) {
      if (recovering || registering.has(agentId)) return true;
      for (const group of watches.values()) {
        for (const watch of group) {
          const record = watch.records[0]!;
          if (!record.callerServerId && record.callerAgentId === agentId) return true;
        }
      }
      return false;
    },
    start: () =>
      serialize(async () => {
        const storedReports = (await deps.followups?.reports.list()) ?? [];
        for (const stored of storedReports)
          for (const id of stored.supersedesFinished ?? []) suppressedFinished.add(id);
        await restoreFinishWatches();
        for (const record of (await deps.followups?.watches.list()) ?? [])
          startFollowupWatch(record);
        for (const record of storedReports) {
          if (!record.callerServerId && record.report?.parentReportStatus)
            startLocalReport(record, record.report);
          if (record.callerServerId && record.report?.parentReportStatus)
            startRemoteReport({ ...record, callerServerId: record.callerServerId }, record.report);
        }
        recovering = false;
      }),
    register: ({ automaticParent, canRegister, ...input }, pendingDispatch = false) => {
      registering.set(input.callerAgentId, (registering.get(input.callerAgentId) ?? 0) + 1);
      return serialize(async () => {
        if (closed) throw new Error("Finish subscriptions are closed");
        if (canRegister && !canRegister()) {
          return skippedRegistration;
        }
        // The ID is the durable notification identity. Namespacing it keeps the
        // persisted record compatible with older readers.
        let prefix = "";
        if (input.requireParentOwnership) {
          prefix =
            (automaticParent ?? input.followupReport)
              ? AUTOMATIC_PARENT_PREFIX
              : REQUESTED_PARENT_PREFIX;
        }
        const record: FinishSubscription = {
          ...input,
          serverId: input.serverId === deps.serverId ? undefined : input.serverId,
          callerServerId: input.callerServerId === deps.serverId ? undefined : input.callerServerId,
          id: prefix + randomUUID(),
        };
        await deps.store.put(record);
        if (canRegister && !canRegister()) {
          await deps.store.remove(record.id);
          return skippedRegistration;
        }
        const group = watches.get(key(record)) ?? new Set<Watch>();
        // A captured result belongs to an earlier turn and may still be held
        // in the parent's inbox when a new foreground turn is accepted.
        const predecessors = [...group].filter((prior) => !prior.captured);
        const watch = attach([record], true);
        const actualGroup = watches.get(key(record))!;
        const automatic = isAutomaticLocalParentSubscription(record);
        function removeSuperseded(records: FinishSubscription[]) {
          if (!records.length) return;
          void serialize(async () => {
            for (const prior of records) await deps.store.remove(prior.id);
          }).catch((error) =>
            deps.logger.error({ err: error }, "Failed to remove superseded finish subscriptions"),
          );
        }
        function accept() {
          if (!watch.pending || watch.controller.signal.aborted || closed) return;
          if (canRegister && !canRegister()) {
            stop(watch, actualGroup);
            removeSuperseded([record]);
            return;
          }
          const activePredecessors = predecessors.filter(
            (prior) => actualGroup.has(prior) && !prior.captured,
          );
          if (automatic) {
            const requested = activePredecessors.filter(
              (prior) =>
                !prior.acknowledged &&
                prior.records.some((intent) => !isAutomaticLocalParentSubscription(intent)),
            );
            const undecided = requested.filter((prior) => prior.pending);
            if (undecided.length) {
              // Wait for the requested prompt's admission before replacing its observer.
              void Promise.all(undecided.map((prior) => prior.decision)).then(accept);
              return;
            }
            if (requested.some((prior) => prior.queued.size)) {
              // The requested result is already queued. Let that delivery settle.
              stop(watch, actualGroup);
              removeSuperseded([record]);
              return;
            }
            watch.records.push(
              ...requested.flatMap((prior) =>
                prior.records.filter((intent) => !isAutomaticLocalParentSubscription(intent)),
              ),
            );
          }
          watch.pending = false;
          for (const prior of activePredecessors) {
            if (prior.records.every(isAutomaticLocalParentSubscription)) {
              stopAutomatic(prior, actualGroup);
            } else {
              stop(prior, actualGroup);
            }
          }
          watch.decide(true);
          removeSuperseded(
            activePredecessors.flatMap((prior) =>
              prior.records.filter((intent) => !watch.records.includes(intent)),
            ),
          );
        }
        const registration: FinishRegistration = {
          accept,
          reject: () =>
            serialize(async () => {
              stop(watch, actualGroup);
              await remove(watch);
            }),
        };
        if (!pendingDispatch) registration.accept();
        return registration;
      }).finally(() => {
        const remaining = registering.get(input.callerAgentId)! - 1;
        if (remaining) registering.set(input.callerAgentId, remaining);
        else registering.delete(input.callerAgentId);
      });
    },
    cancelAutomaticParent: (childAgentId, callerAgentId) =>
      serialize(async () => {
        const address = { childAgentId, callerAgentId };
        const group = watches.get(key(address));
        for (const watch of group ?? []) {
          const retained = watch.records.filter(
            (record) => !isAutomaticLocalParentSubscription(record),
          );
          if (retained.length === watch.records.length) continue;
          if (retained.length) watch.records = retained;
          else stopAutomatic(watch, group!);
        }
        // A failed removal is retried by the next recovery or dispatch for this
        // pair. The agent's committed reporting label prevents stale delivery.
        for (const record of await deps.store.list()) {
          if (key(record) === key(address) && isAutomaticLocalParentSubscription(record))
            await deps.store.remove(record.id);
        }
      }),
    trackRemoteChild: (input) =>
      serialize(async () => {
        if (closed || !deps.followups)
          throw new Error("Remote follow-up observation is unavailable");
        const record = { ...input, id: key(input) };
        await deps.followups.watches.put(record);
        startFollowupWatch(record);
      }),
    queueParentReport: (address, { status, title, summary, turnId }) =>
      serialize(async () => {
        if (closed || !deps.followups) throw new Error("Parent report delivery is unavailable");
        const id = randomUUID();
        const report: AgentFinishReport = {
          id,
          title: resolveReportTitle(address.childAgentId, title) ?? "",
          prompt: `Report to parent (${status}):\n\n${summary}`,
          event: "finished",
          parentReportStatus: status,
        };
        const group = watches.get(key(address));
        const covered = [...(group ?? [])]
          .filter(
            (watch) =>
              !watch.pending &&
              watch.records.every(isAutomaticParentSubscription) &&
              (!watch.resultTurnId || turnId === watch.resultTurnId),
          )
          .flatMap((watch) => watch.records);
        const record = {
          ...address,
          id,
          report,
          reportTurnId: turnId,
          supersedesFinished: covered.map((entry) => entry.id),
        };
        await serializeReports(async () => {
          if (address.callerServerId && turnId) {
            for (const saved of await deps.followups!.reports.list()) {
              if (
                key(saved) === key(address) &&
                saved.reportTurnId === turnId &&
                saved.report?.event === "finished" &&
                !saved.report.parentReportStatus &&
                isAutomaticParentSubscription(saved) &&
                !record.supersedesFinished.includes(saved.id)
              )
                record.supersedesFinished.push(saved.id);
            }
          }
          report.reportedAt = new Date().toISOString();
          await deps.followups!.reports.put(record);
          for (const finishedId of record.supersedesFinished) suppressedFinished.add(finishedId);
        });
        // Suppress only finished notifications. A blocked tool report is not a
        // response to the provider's permission checkpoint.
        if (covered.length && !record.callerServerId) {
          const queued = new Set<AgentPromptSource>();
          for (const watch of group ?? [])
            if (watch.records.every((entry) => suppressedFinished.has(entry.id)))
              for (const source of watch.queued) queued.add(source);
          deps
            .messages()
            .withdrawPending(
              record.callerAgentId,
              (source) =>
                source.kind === "agent-notification" &&
                source.event === "finished" &&
                queued.has(source),
            );
          for (const entry of covered)
            deps.messages().withdrawInboxReport?.(record.callerAgentId, entry.id);
        }
        if (!record.callerServerId) startLocalReport(record, report);
        else startRemoteReport({ ...record, callerServerId: record.callerServerId }, report);
        return id;
      }),
    readConfirmedParentReport,
    confirmParentReport: async (address, reportId) =>
      (await readConfirmedParentReport(address, reportId)) !== undefined,
    pullReports: (address, acknowledged, observe, childState, includeParentReports = false) =>
      serializeReports(async () => {
        const followups = deps.followups;
        if (!followups) return { ownsBinding: false, reports: [] };
        const { sourceId, ...pair } = address;
        const bindingId = key(pair);
        const existing = (await followups.watches.list()).find((entry) => entry.id === bindingId);
        const reports = followups.reports;
        const matching = (await reports.list()).filter(
          (record) =>
            key(record) === bindingId &&
            (!record.pullSourceId || record.pullSourceId === sourceId) &&
            record.report,
        );
        if (childState === "unrelated") {
          if (existing?.pullSourceId === sourceId) {
            for (const record of matching) await reports.remove(record.id);
            await followups.watches.remove(bindingId);
            lastReportByBinding.delete(bindingId);
          }
          return { ownsBinding: false, reports: [] };
        }
        if (existing?.pullSourceId !== sourceId) {
          if (existing || !observe || (childState === "archived" && matching.length === 0))
            return { ownsBinding: false, reports: [] };
          await followups.watches.put({ ...pair, id: bindingId, pullSourceId: sourceId });
        }
        const eligible = matching.filter(
          (record) =>
            !suppressedFinished.has(record.id) &&
            (includeParentReports || !record.report?.parentReportStatus),
        );
        const confirmedIds = new Set(acknowledged);
        const consumed = new Set(
          eligible
            .filter(
              (record) => confirmedIds.has(record.id) || confirmedIds.has(remoteReportId(record)),
            )
            .map((record) => record.id),
        );
        for (const record of eligible)
          if (consumed.has(record.id)) await removeDeliveredReport(record);
        const remaining = eligible.filter((record) => !consumed.has(record.id));
        const lastReportId = lastReportByBinding.get(bindingId);
        const cursor = eligible.findIndex((record) => record.id === lastReportId);
        const page = [...eligible.slice(cursor + 1), ...eligible.slice(0, cursor + 1)]
          .filter((record) => !consumed.has(record.id))
          .slice(0, REPORT_PAGE_SIZE);
        // An unacknowledged report stays durable. Rotate through remaining pages even
        // when an entire page is awaiting delivery verification.
        if (page.length && remaining.length > page.length)
          lastReportByBinding.set(bindingId, page.at(-1)!.id);
        else lastReportByBinding.delete(bindingId);
        if (
          childState === "archived" &&
          !remaining.length &&
          matching.every((record) => suppressedFinished.has(record.id) || consumed.has(record.id))
        )
          await followups.watches.remove(bindingId);
        return {
          ownsBinding: childState === "active" || remaining.length > 0,
          reports: page.map((record) =>
            Object.assign({}, record.report!, { id: remoteReportId(record) }),
          ),
        };
      }),
    async close() {
      closed = true;
      await mutations;
      for (const group of watches.values())
        for (const watch of group) {
          watch.controller.abort();
          watch.decide(false);
        }
      await mutations;
      for (const controller of followupWatches.values()) controller.abort();
      for (const controller of localReportTasks.values()) controller.abort();
      for (const controller of remoteReportTasks.values()) controller.abort();
      await Promise.all(tasks);
      await reportMutations;
      await deps.store.list();
      // Dispatch may still be pending. The delivery owner drains it after observers stop.
    },
  };
}

export { createFinishObservation } from "./internal/observation.js";
