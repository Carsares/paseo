import type { AgentLimitRecoveryRequest } from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import { sendPromptToAgent, waitForAgentRunStartWithTimeout } from "../agent/agent-prompt.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { MessageReceipts } from "../message-receipts/index.js";
import { assertWorkspaceAutomationAllowedForWorkspace } from "../workspace-automation-gate.js";
import { limitFingerprint } from "../workspace-deferral/agent-limit-evidence.js";
import {
  AgentLimitContinuationWithdrawnError,
  type AgentLimitContinuation,
} from "../workspace-deferral/continuation-state.js";
import type { WorkspaceDeferral } from "../workspace-deferral/deferral.js";
import type { FileBackedWorkspaceRegistry } from "../workspace-registry.js";

const CONTINUE_PROMPT = "Continue from where you left off.";
const MAX_TIMER_MS = 2 ** 31 - 1;

type RecoveryAction = Pick<
  AgentLimitRecoveryRequest,
  "agentId" | "workspaceId" | "turnId" | "action"
>;
interface Dependencies {
  serverId: string;
  manager: AgentManager;
  storage: AgentStorage;
  workspaces: FileBackedWorkspaceRegistry;
  deferral: WorkspaceDeferral;
  receipts: MessageReceipts;
  logger: Logger;
  now?: () => number;
  isWorkspaceArchiving?: (workspaceId: string) => boolean;
}

export class AgentLimitRecovery {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private running = false;
  private unsubscribe?: () => void;

  constructor(private readonly deps: Dependencies) {}

  async start(): Promise<void> {
    this.running = true;
    this.unsubscribe = this.deps.workspaces.subscribeToMutations(({ workspaceId }) => {
      // A natural expiration keeps the revision and leaves its continuation eligible.
      // All other changes are checked again before provider handoff.
      void this.cancelChangedWorkspace(workspaceId).catch((err) =>
        this.deps.logger.warn({ err, workspaceId }, "Failed to invalidate workspace continuation"),
      );
    });
    for (const record of await this.deps.storage.listAll()) {
      const task = record.limitContinuation;
      if (task?.status === "scheduled") {
        if (record.archivedAt || !(await this.workspaceStillMatches(task))) {
          await this.cancelWaitingForAgent(record.id);
        } else {
          this.arm(record.id, task);
        }
      } else if (task?.status === "unknown") {
        const receipt = await this.deps.receipts
          .outcome(record.id, task.messageId)
          .catch(() => "unknown");
        if (receipt === "accepted") await this.finish(record.id, task, "accepted");
      }
    }
  }

  stop(): void {
    this.running = false;
    this.unsubscribe?.();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  set(input: RecoveryAction): Promise<void> {
    return this.run(input.agentId, async () => {
      const { agentId, workspaceId, turnId, action } = input;
      if (this.deps.isWorkspaceArchiving?.(workspaceId)) {
        throw new Error("Workspace is being archived.");
      }
      const record = await this.requireAgent(input);
      const existing = record.limitContinuation;
      if (action === "cancel") return this.cancel(input, existing);

      if (existing && existing.turnId === turnId && existing.workspaceId === workspaceId) {
        if (action === "continue" && existing.status === "scheduled") {
          if (await this.workspaceStillMatches(existing)) return;
          await this.finish(agentId, existing, "cancelled");
        }
        if (
          action === "continue" ||
          existing.status === "unknown" ||
          existing.status === "accepted"
        ) {
          throw new Error("A continuation was already requested for this turn.");
        }
      }

      const limit = this.requireFutureLimit(record, turnId);
      const snooze = { workspaceId, action: "snooze", snoozedUntil: limit.resetsAt } as const;
      if (action === "sleep") {
        await this.deps.deferral.set(snooze);
        if (existing?.status === "scheduled") await this.finish(agentId, existing, "cancelled");
        return;
      }

      await assertWorkspaceAutomationAllowedForWorkspace(this.deps.workspaces, workspaceId);
      await this.schedule(input, snooze, limit);
    });
  }

  private async cancel(
    { agentId, workspaceId, turnId }: RecoveryAction,
    existing: AgentLimitContinuation | undefined,
  ): Promise<void> {
    if (!existing || existing.turnId !== turnId || existing.workspaceId !== workspaceId) {
      throw new Error("This turn has no delayed continuation.");
    }
    if (existing.status === "cancelled") return;
    if (existing.status !== "scheduled") throw new Error("The continuation already began.");
    await this.finish(agentId, existing, "cancelled");
  }

  private async schedule(
    input: RecoveryAction,
    snooze: { workspaceId: string; action: "snooze"; snoozedUntil: string },
    limit: NonNullable<StoredAgentRecord["failedConversationLimit"]>,
  ): Promise<void> {
    let prepared: AgentLimitContinuation | undefined;
    try {
      await this.deps.deferral.set(snooze, async (revision) => {
        // Before the workspace commits the same revision, this task cannot fire.
        prepared = await this.persistScheduled(input, revision, limit);
      });
    } catch (error) {
      if (prepared) await this.finish(input.agentId, prepared, "cancelled");
      throw error;
    }
    if (!prepared) throw new Error("The delayed continuation did not persist.");
    this.arm(input.agentId, prepared);
    await this.deps.manager.publishLimitContinuation(input.agentId);
  }

  private requireFutureLimit(record: StoredAgentRecord, turnId: string) {
    const { manager } = this.deps;
    const live = manager.getAgent(record.id);
    const limit = live?.failedConversationLimit;
    if (
      !live?.session ||
      !limit ||
      limit.turnId !== turnId ||
      Date.parse(limit.resetsAt) <= this.now() ||
      manager.conversationLimitFingerprint(live) !== limit.fingerprint ||
      manager.hasInFlightRun(record.id) ||
      manager.hasPendingPermissions(record.id)
    ) {
      throw new Error("This turn has no current conversation limit with a future reset.");
    }
    return limit;
  }

  private async persistScheduled(
    { agentId, workspaceId, turnId }: RecoveryAction,
    workspaceRevision: string,
    limit: NonNullable<StoredAgentRecord["failedConversationLimit"]>,
  ): Promise<AgentLimitContinuation> {
    const task: AgentLimitContinuation = {
      serverId: this.deps.serverId,
      workspaceId,
      workspaceRevision,
      turnId,
      fingerprint: limit.fingerprint,
      messageId: `rate-limit-continuation:${limitFingerprint([this.deps.serverId, workspaceId, agentId, turnId, limit.limitId, workspaceRevision])}`,
      runAt: limit.resetsAt,
      status: "scheduled",
    };
    const updated = await this.deps.storage.updateLimitContinuation(agentId, (latest) => {
      if (
        latest.archivedAt ||
        latest.workspaceId !== workspaceId ||
        latest.failedConversationLimit?.fingerprint !== limit.fingerprint ||
        latest.failedConversationLimit.turnId !== turnId
      )
        return null;
      return task;
    });
    if (!updated) throw new Error("The original conversation changed while scheduling.");
    return task;
  }

  onWorkspaceArchiveStarted(workspaceId: string): void {
    void this.cancelChangedWorkspace(workspaceId).catch((err) =>
      this.deps.logger.warn(
        { err, workspaceId },
        "Failed to cancel continuation for workspace archive",
      ),
    );
  }

  async cancelWaitingForAgent(agentId: string): Promise<void> {
    await this.run(agentId, async () => {
      const record = await this.deps.storage.get(agentId);
      const task = record?.limitContinuation;
      if (task?.status === "scheduled") await this.finish(agentId, task, "cancelled");
    });
  }

  private async cancelChangedWorkspace(workspaceId: string): Promise<void> {
    for (const record of await this.deps.storage.listByWorkspace(workspaceId)) {
      await this.run(record.id, async () => {
        const task = (await this.deps.storage.get(record.id))?.limitContinuation;
        if (task?.status === "scheduled" && !(await this.workspaceStillMatches(task))) {
          await this.finish(record.id, task, "cancelled");
        }
      });
    }
  }

  private arm(agentId: string, task: AgentLimitContinuation): void {
    if (!this.running) return;
    clearTimeout(this.timers.get(agentId));
    const timer = setTimeout(
      () => {
        this.timers.delete(agentId);
        if (!this.running) return;
        if (Date.parse(task.runAt) > this.now()) {
          this.arm(agentId, task);
          return;
        }
        void this.dispatch(agentId, task).catch((err) =>
          this.deps.logger.warn({ err, agentId }, "Failed to settle delayed continuation"),
        );
      },
      Math.min(Math.max(0, Date.parse(task.runAt) - this.now()), MAX_TIMER_MS),
    );
    timer.unref();
    this.timers.set(agentId, timer);
  }

  private async dispatch(agentId: string, task: AgentLimitContinuation): Promise<void> {
    const { manager, receipts, storage, logger } = this.deps;
    let began = false;
    let declined = false;
    try {
      await this.validateDispatch(agentId, task, "scheduled", false);
      if (manager.hasInFlightRun(agentId)) throw new Error("The agent already has an active turn.");
      await receipts.send({
        agentId,
        messageId: task.messageId,
        request: { prompt: CONTINUE_PROMPT, workspaceId: task.workspaceId, turnId: task.turnId },
        send: async (begin, discardReceipt, onProviderOutcome) => {
          const result = await sendPromptToAgent({
            agentManager: manager,
            agentStorage: storage,
            agentId,
            prompt: CONTINUE_PROMPT,
            messageId: task.messageId,
            unarchive: false,
            idleOnly: true,
            logger,
            runOptions: { recoveryIntent: "delayed-limit" },
            validateDispatch: () =>
              this.validateHandoff(agentId, task, began ? "unknown" : "scheduled"),
            waitForCommandOutcome: true,
            handoff: {
              begin: async () => {
                if (began)
                  throw new AgentLimitContinuationWithdrawnError("The continuation already began.");
                await this.run(agentId, async () => {
                  await this.validateHandoff(agentId, task, "scheduled");
                  if (!(await this.finish(agentId, task, "unknown"))) {
                    throw new AgentLimitContinuationWithdrawnError(
                      "The continuation is no longer scheduled.",
                    );
                  }
                  began = true;
                  await begin();
                });
              },
              declined: async () => {
                await discardReceipt();
                declined = true;
              },
              onProviderOutcome,
            },
          });
          if (result.disposition === "turn_started") {
            await waitForAgentRunStartWithTimeout(manager, agentId, result.started);
          }
          if (!began) throw new Error("The continuation did not reach provider handoff.");
        },
      });
      if ((await receipts.outcome(agentId, task.messageId)) === "accepted") {
        await this.run(agentId, () => this.finish(agentId, task, "accepted"));
      }
    } catch {
      const outcome = await receipts
        .outcome(agentId, task.messageId)
        .catch(() => "unknown" as const);
      if (outcome === "unknown" || (outcome === "absent" && began && !declined)) {
        await this.run(agentId, () => this.finish(agentId, task, "unknown"));
        return;
      }
      let status: "accepted" | "failed" | "cancelled" = "accepted";
      if (outcome === "absent") {
        status = began || (await this.workspaceStillMatches(task)) ? "failed" : "cancelled";
      }
      await this.run(agentId, () => this.finish(agentId, task, status));
    }
  }

  private async validateHandoff(
    agentId: string,
    task: AgentLimitContinuation,
    status: "scheduled" | "unknown",
  ): Promise<void> {
    try {
      await this.validateDispatch(agentId, task, status, true);
    } catch (cause) {
      throw new AgentLimitContinuationWithdrawnError(
        "The delayed continuation was withdrawn before provider handoff.",
        { cause },
      );
    }
  }

  private async validateDispatch(
    agentId: string,
    task: AgentLimitContinuation,
    status: AgentLimitContinuation["status"],
    requireLive: boolean,
  ): Promise<void> {
    const { manager } = this.deps;
    const record = await this.requireAgent({ agentId, workspaceId: task.workspaceId });
    const live = manager.getAgent(agentId);
    const limit = live ? live.failedConversationLimit : record.failedConversationLimit;
    if (
      !this.running ||
      record.limitContinuation?.messageId !== task.messageId ||
      record.limitContinuation.status !== status ||
      limit?.turnId !== task.turnId ||
      limit.fingerprint !== task.fingerprint ||
      (requireLive &&
        (!live?.session ||
          live.persistence?.sessionId !== record.persistence?.sessionId ||
          manager.conversationLimitFingerprint(live) !== task.fingerprint)) ||
      manager.hasPendingPermissions(agentId) ||
      !(await this.workspaceStillMatches(task))
    )
      throw new Error(
        "The original conversation or its delayed continuation is no longer eligible.",
      );
    await assertWorkspaceAutomationAllowedForWorkspace(this.deps.workspaces, task.workspaceId);
  }

  private async requireAgent(
    input: Pick<RecoveryAction, "agentId" | "workspaceId">,
  ): Promise<StoredAgentRecord> {
    const { agentId, workspaceId } = input;
    const record = await this.deps.storage.get(agentId);
    const live = this.deps.manager.getAgent(agentId);
    if (
      !record ||
      !record.persistence?.sessionId ||
      record.archivedAt ||
      record.internal ||
      record.background ||
      record.owner ||
      record.workspaceId !== workspaceId ||
      (live && live.workspaceId !== workspaceId)
    ) {
      throw new Error("Agent is unavailable in this workspace.");
    }
    return record;
  }

  private async workspaceStillMatches(task: AgentLimitContinuation): Promise<boolean> {
    if (task.serverId !== this.deps.serverId) return false;
    const workspace = await this.deps.workspaces.get(task.workspaceId);
    return (
      !this.deps.isWorkspaceArchiving?.(task.workspaceId) &&
      !!workspace &&
      !workspace.archivedAt &&
      !workspace.background &&
      workspace.deferralRevision === task.workspaceRevision
    );
  }

  private async finish(
    agentId: string,
    task: AgentLimitContinuation,
    status: AgentLimitContinuation["status"],
  ): Promise<boolean> {
    const changed = await this.deps.storage.updateLimitContinuation(agentId, (record) => {
      const current = record.limitContinuation;
      if (current?.messageId !== task.messageId || current.status === status) return null;
      if (status === "unknown" || status === "cancelled") {
        if (current.status !== "scheduled") return null;
      } else if (current.status !== "scheduled" && current.status !== "unknown") return null;
      return { ...current, status };
    });
    if (!changed) return false;
    clearTimeout(this.timers.get(agentId));
    this.timers.delete(agentId);
    await this.deps.manager.publishLimitContinuation(agentId);
    return true;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private run<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(agentId);
    const result = (previous?.catch(() => undefined) ?? Promise.resolve()).then(fn);
    this.tails.set(agentId, result);
    void result
      .finally(() => {
        if (this.tails.get(agentId) === result) this.tails.delete(agentId);
      })
      .catch(() => undefined);
    return result;
  }
}
