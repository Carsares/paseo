import { setTimeout as pause } from "node:timers/promises";
import { HostObservationError, type ToolHosts } from "../host-operations/index.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { AgentExplicitFinishReport, AgentFinishReport } from "@getpaseo/protocol/messages";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { FinishObservationResult } from "./internal/observation-buffer.js";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import { AgentRequestOutcomeUnknownError } from "../../message-receipts/index.js";
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
    input: Omit<FinishSubscription, "id">,
    pendingDispatch?: boolean,
  ): Promise<FinishRegistration>;
  trackRemoteChild(input: Omit<FinishSubscription, "id">): Promise<void>;
  queueParentReport(
    address: Pick<FinishSubscription, "childAgentId" | "callerAgentId" | "callerServerId">,
    content: {
      status: NonNullable<AgentFinishReport["parentReportStatus"]>;
      title: string;
      summary: string;
    },
  ): Promise<string>;
  confirmParentReport(
    address: Pick<FinishSubscription, "childAgentId" | "callerAgentId" | "callerServerId">,
    reportId: string,
  ): Promise<boolean>;
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
  task?: Promise<void>;
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
    const watch: Watch = { records, controller: new AbortController(), pending, decision, decide };
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
  async function remove(watch: Watch): Promise<void> {
    // Only IDs captured by this observer are eligible; newer registrations survive.
    for (const record of watch.records) await deps.store.remove(record.id);
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
  ): Promise<boolean> {
    if (!deps.hosts) throw new Error("Remote finish delivery is unavailable");
    return deps.hosts().use(
      record.callerServerId,
      async (client) => {
        const caller = (await client.fetchAgent(record.callerAgentId))?.agent;
        if (!caller || caller.archivedAt) return false;
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
      return await deliverRemote(record, childServerId, report, signal);
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

  function enqueueLocalNotification(
    record: FinishSubscription,
    report: AgentFinishReport,
    hasFinalSnapshot: boolean,
  ) {
    const messages = deps.messages();
    const validateParentOwnership = messages.validateParentOwnership;
    return messages.enqueue({
      recipientId: record.callerAgentId,
      prompt: report.prompt,
      source: {
        kind: "agent-notification",
        agentId: record.childAgentId,
        serverId: record.serverId ?? deps.serverId,
        title: report.title,
        event: report.event,
      },
      activeTurnBehavior: "steer",
      unarchive: false,
      // The observation's snapshot cannot authorize a notification that
      // waited behind another turn or the recipient's quiet window.
      validateDispatch:
        record.requireParentOwnership && hasFinalSnapshot && validateParentOwnership
          ? () => validateParentOwnership(record)
          : undefined,
    });
  }

  async function deliver(
    record: FinishSubscription,
    result: FinishObservationResult,
    permissions: Set<string>,
    savedFollowups: Set<string>,
    signal: AbortSignal,
  ): Promise<boolean> {
    const requests = permissionRequests(result, permissions);
    const reason = reasonFor(result);
    const acknowledgments: Promise<unknown>[] = [];
    for (const request of reason === "needs permission" ? requests : [undefined]) {
      if (signal.aborted) return false;
      const title = result.final?.title ?? record.childAgentId;
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
      const followups = record.followupReport ? deps.followups : undefined;
      let bound = false;
      if (followups) {
        bound = await serializeReports(async () => {
          const binding = (await followups.watches.list()).find(
            (entry) => entry.id === key(record),
          );
          if (!savedFollowups.has(id)) {
            // The turn can finish before the origin's first poll. Keep the result across
            // supersession and restart, even if a reverse route cannot be opened.
            await followups.reports.put({
              ...record,
              id,
              pullSourceId: binding?.pullSourceId,
              report,
            });
            savedFollowups.add(id);
          }
          return Boolean(binding);
        });
      }
      if (record.callerServerId) {
        const dispatched = await tryReverseNotification(
          { ...record, callerServerId: record.callerServerId },
          childServerId,
          report,
          bound,
          signal,
        );
        if (followups && dispatched) await serializeReports(() => followups.reports.remove(id));
        if (!bound && !dispatched) return true;
        if (request) permissions.add(request.id);
        continue;
      }
      const receipt = enqueueLocalNotification(record, report, Boolean(result.final));
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
      ...watch.records[0]!,
      requireParentOwnership: watch.records.every(
        (intent) => intent.requireParentOwnership === true,
      ),
    };
    const permissions = new Set<string>();
    const savedFollowups = new Set<string>();
    let observation: FinishObservationSession | undefined;
    let pending: FinishObservationResult | undefined;
    let acknowledged = false;
    let remoteFailures = 0;
    let retries = 0;
    let warned = false;
    async function observeNext(): Promise<FinishObservationResult | undefined> {
      try {
        observation ??= await deps.open(record, signal);
        const result = await abortable(observation.next(), signal);
        remoteFailures = 0;
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
          if (!pending) pending = await observeNext();
          if (!pending) {
            await delay(signal, retries++);
            continue;
          }
          if (signal.aborted) return;
          // A queued follow-up cannot start until the current permission is answered.
          // Its pending registration must not hold the running turn's checkpoint.
          if (pending.status !== "permission" || watch.pending) await decisions(group);
          if (signal.aborted) return;
          if (await suppressed(record, pending)) {
            await remove(watch);
            stop(watch, group);
            return;
          }
          if (!acknowledged)
            acknowledged = await deliver(record, pending, permissions, savedFollowups, signal);
          if (acknowledged) {
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
  function startLocalReport(record: FinishSubscription, report: AgentFinishReport): void {
    if (!deps.followups || localReportTasks.has(record.id)) return;
    const { dispatch, reports } = deps.followups;
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
          await serializeReports(() => reports.remove(record.id));
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
    const { reports } = deps.followups;
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
                client.pushAgentFinishReport(
                  record.childAgentId,
                  record.callerAgentId,
                  report as AgentExplicitFinishReport,
                ),
              signal,
              record.childAgentId,
            ),
            signal,
          );
          await serializeReports(() => reports.remove(record.id));
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
    const task = (async () => {
      let acknowledged: string[] = [];
      const outcomesUnknown = new Set<string>();
      async function dispatchReports(reports: AgentFinishReport[]): Promise<void> {
        for (const report of reports) {
          signal.throwIfAborted();
          if (!(await deps.callerIsActive(record.callerAgentId))) return;
          try {
            await abortable(followups.dispatch(record, report), signal);
            outcomesUnknown.delete(report.id);
            acknowledged.push(report.id);
          } catch (error) {
            if (error instanceof ParentReportRecipientUnavailableError) {
              acknowledged.push(report.id);
              continue;
            }
            if (!(error instanceof AgentRequestOutcomeUnknownError)) throw error;
            if (!outcomesUnknown.has(report.id)) {
              outcomesUnknown.add(report.id);
              deps.logger.warn(
                { reportId: report.id, subscription: record.id },
                "Remote finish report awaits delivery verification",
              );
            }
          }
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
            const response = await hosts.use(
              serverId,
              (client) =>
                client.pullAgentFinishReports(
                  record.childAgentId,
                  record.callerAgentId,
                  acknowledged,
                  true,
                ),
              signal,
            );
            signal.throwIfAborted();
            if (response.error) throw new Error(response.error);
            if (!response.ownsChild) {
              await followups.watches.remove(record.id);
              return;
            }
            acknowledged = [];
            await dispatchReports(response.reports);
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
    void task.then(() => {
      followupWatches.delete(record.id);
      tasks.delete(task);
      return undefined;
    });
  }

  return {
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
        const groups = new Map<string, FinishSubscription[]>();
        for (const record of await deps.store.list()) {
          const records = groups.get(key(record)) ?? [];
          records.push(record);
          groups.set(key(record), records);
        }
        for (const records of groups.values()) attach(records, false);
        for (const record of (await deps.followups?.watches.list()) ?? [])
          startFollowupWatch(record);
        for (const record of (await deps.followups?.reports.list()) ?? []) {
          if (!record.callerServerId && record.report?.parentReportStatus)
            startLocalReport(record, record.report);
          if (record.callerServerId && record.report?.parentReportStatus)
            startRemoteReport({ ...record, callerServerId: record.callerServerId }, record.report);
        }
        recovering = false;
      }),
    register: (input, pendingDispatch = false) => {
      registering.set(input.callerAgentId, (registering.get(input.callerAgentId) ?? 0) + 1);
      return serialize(async () => {
        if (closed) throw new Error("Finish subscriptions are closed");
        const record: FinishSubscription = {
          ...input,
          serverId: input.serverId === deps.serverId ? undefined : input.serverId,
          callerServerId: input.callerServerId === deps.serverId ? undefined : input.callerServerId,
          id: randomUUID(),
        };
        await deps.store.put(record);
        const group = watches.get(key(record)) ?? new Set<Watch>();
        const predecessors = [...group];
        const watch = attach([record], true);
        const actualGroup = watches.get(key(record))!;
        const registration: FinishRegistration = {
          accept() {
            if (!watch.pending || closed) return;
            watch.pending = false;
            for (const prior of predecessors) stop(prior, actualGroup);
            watch.decide(true);
            void serialize(async () => {
              for (const prior of predecessors) await remove(prior);
            }).catch((error) =>
              deps.logger.error({ err: error }, "Failed to remove superseded finish subscriptions"),
            );
          },
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
    trackRemoteChild: (input) =>
      serialize(async () => {
        if (closed || !deps.followups)
          throw new Error("Remote follow-up observation is unavailable");
        const record = { ...input, id: key(input) };
        await deps.followups.watches.put(record);
        startFollowupWatch(record);
      }),
    queueParentReport: (address, { status, title, summary }) =>
      serialize(async () => {
        if (closed || !deps.followups) throw new Error("Parent report delivery is unavailable");
        const id = randomUUID();
        const report: AgentFinishReport = {
          id,
          title,
          prompt: `Report to parent (${status}):\n\n${summary}`,
          event: "finished",
          parentReportStatus: status,
        };
        const record = { ...address, id, report };
        await serializeReports(() => deps.followups!.reports.put(record));
        if (!record.callerServerId) startLocalReport(record, report);
        else startRemoteReport({ ...record, callerServerId: record.callerServerId }, report);
        return id;
      }),
    confirmParentReport: (address, reportId) =>
      serializeReports(async () => {
        const reports = deps.followups?.reports;
        if (!reports) return false;
        const expected = key(address);
        const record = (await reports.list()).find(
          (entry) =>
            entry.id === reportId &&
            key(entry) === expected &&
            entry.report?.id === reportId &&
            entry.report.parentReportStatus !== undefined,
        );
        return record !== undefined;
      }),
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
          (record) => includeParentReports || !record.report?.parentReportStatus,
        );
        const consumed = new Set(acknowledged);
        for (const record of eligible) if (consumed.has(record.id)) await reports.remove(record.id);
        const remaining = eligible.filter((record) => !consumed.has(record.id));
        const lastReportId = lastReportByBinding.get(bindingId);
        const cursor = eligible.findIndex((record) => record.id === lastReportId);
        const page = [...eligible.slice(cursor + 1), ...eligible.slice(0, cursor + 1)]
          .filter((record) => !consumed.has(record.id))
          .slice(0, 8)
          .map((record) => record.report!);
        // An unacknowledged report stays durable. Rotate through remaining pages even
        // when an entire page is awaiting delivery verification.
        if (page.length && remaining.length > page.length)
          lastReportByBinding.set(bindingId, page.at(-1)!.id);
        else lastReportByBinding.delete(bindingId);
        if (
          childState === "archived" &&
          matching.every((record) => eligible.includes(record) && consumed.has(record.id))
        )
          await followups.watches.remove(bindingId);
        return { ownsBinding: childState === "active" || remaining.length > 0, reports: page };
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
