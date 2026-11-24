import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkspaceDeferralSetRequest } from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import type { MessageReceipts } from "../message-receipts/index.js";
import type {
  FileBackedWorkspaceRegistry,
  PersistedWorkspaceRecord,
} from "../workspace-registry.js";

type DeferralAction = Pick<WorkspaceDeferralSetRequest, "workspaceId" | "action" | "snoozedUntil">;
const MAX_TIMER_MS = 2 ** 31 - 1;

export class WorkspaceDeferral {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private unsubscribe?: () => void;

  constructor(
    private readonly registry: FileBackedWorkspaceRegistry,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly receipts?: MessageReceipts,
  ) {}

  async start(): Promise<void> {
    this.unsubscribe = this.registry.subscribeToMutations(({ workspaceId }) => {
      this.observe(workspaceId);
    });
    const workspaces = await this.registry.listActive();
    for (const workspace of workspaces) {
      if (workspace.snoozedUntil && Date.parse(workspace.snoozedUntil) <= this.now()) {
        await this.expire(workspace.workspaceId, workspace.deferralRevision);
      } else {
        this.observe(workspace.workspaceId);
      }
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  set(
    input: DeferralAction,
    prepare?: (revision: string) => Promise<void>,
  ): Promise<PersistedWorkspaceRecord> {
    return this.run(input.workspaceId, async () => {
      const now = this.now();
      const snoozedUntil = input.snoozedUntil;
      if (
        input.action === "snooze"
          ? !z.iso.datetime().safeParse(snoozedUntil).success || Date.parse(snoozedUntil!) <= now
          : snoozedUntil !== undefined
      ) {
        throw new Error("Snoozing requires a future time. Other actions cannot include a time.");
      }

      const revision = randomUUID();
      if (prepare) {
        const current = await this.registry.get(input.workspaceId);
        if (!current || current.archivedAt || current.background) {
          throw new Error("Workspace is unavailable.");
        }
        await prepare(revision);
      }
      const workspace = await this.registry.update(input.workspaceId, (record) => {
        if (record.archivedAt || record.background) throw new Error("Workspace is unavailable.");
        return {
          ...record,
          snoozedUntil,
          parkedAt: input.action === "park" ? new Date(now).toISOString() : undefined,
          deferralRevision: revision,
          deferralStartedAt: input.action === "restore" ? undefined : new Date(now).toISOString(),
        };
      });
      if (!workspace) throw new Error("Workspace is unavailable.");
      return workspace;
    });
  }

  /** Call at the live event edge, with the destination's bound workspace id. */
  wake(workspaceId: string): Promise<void> {
    return this.clear(workspaceId, (record) => Boolean(record.snoozedUntil || record.parkedAt));
  }

  wakeForBlockedReport(workspaceId: string, reportId: string, reportedAt: string): Promise<void> {
    return this.run(workspaceId, async () => {
      if (!this.receipts) return;
      const record = await this.registry.get(workspaceId);
      if (!record || record.archivedAt || record.background) return;
      const startedAt = record.deferralStartedAt ?? record.parkedAt;
      const reportedDuringDeferral = startedAt && Date.parse(reportedAt) > Date.parse(startedAt);
      const revision = await this.receipts.blockedReportDeferralRevision(
        workspaceId,
        reportId,
        reportedDuringDeferral ? record.deferralRevision : undefined,
      );
      if (!revision) return;
      await this.clearIf(
        workspaceId,
        (latest) =>
          latest.deferralRevision === revision && Boolean(latest.snoozedUntil || latest.parkedAt),
      );
    });
  }

  private expire(workspaceId: string, revision: string | undefined): Promise<void> {
    return this.clear(
      workspaceId,
      (record) =>
        record.deferralRevision === revision &&
        !!record.snoozedUntil &&
        Date.parse(record.snoozedUntil) <= this.now(),
      true,
    );
  }

  private clear(
    workspaceId: string,
    shouldClear: (record: PersistedWorkspaceRecord) => boolean,
    keepRevision = false,
  ): Promise<void> {
    return this.run(workspaceId, () => this.clearIf(workspaceId, shouldClear, keepRevision));
  }

  private async clearIf(
    workspaceId: string,
    shouldClear: (record: PersistedWorkspaceRecord) => boolean,
    keepRevision = false,
  ): Promise<void> {
    const record = await this.registry.get(workspaceId);
    if (!record || record.archivedAt || record.background || !shouldClear(record)) return;
    await this.registry.update(workspaceId, (latest) =>
      !latest.archivedAt && !latest.background && shouldClear(latest)
        ? {
            ...latest,
            snoozedUntil: undefined,
            parkedAt: undefined,
            deferralStartedAt: undefined,
            deferralRevision: keepRevision ? latest.deferralRevision : randomUUID(),
          }
        : latest,
    );
  }

  private observe(workspaceId: string): void {
    void this.run(workspaceId, async () => {
      clearTimeout(this.timers.get(workspaceId));
      this.timers.delete(workspaceId);
      if (!this.unsubscribe) return;
      const record = await this.registry.get(workspaceId);
      if (!record?.snoozedUntil || record.archivedAt || record.background || !this.unsubscribe)
        return;
      const delay = Math.max(0, Date.parse(record.snoozedUntil) - this.now());
      const timer = setTimeout(
        () => {
          this.expire(workspaceId, record.deferralRevision)
            .catch((error) =>
              this.logger.warn({ err: error, workspaceId }, "Could not restore snoozed workspace"),
            )
            .finally(() => this.observe(workspaceId));
        },
        Math.min(delay || 1, MAX_TIMER_MS),
      );
      timer.unref();
      this.timers.set(workspaceId, timer);
    }).catch((error) =>
      this.logger.warn({ err: error, workspaceId }, "Could not observe snoozed workspace"),
    );
  }

  private run<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(workspaceId);
    const result = (previous?.catch(() => undefined) ?? Promise.resolve()).then(fn);
    this.tails.set(workspaceId, result);
    void result
      .finally(() => {
        if (this.tails.get(workspaceId) === result) this.tails.delete(workspaceId);
      })
      .catch(() => undefined);
    return result;
  }
}
