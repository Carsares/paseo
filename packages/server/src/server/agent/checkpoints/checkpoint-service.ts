import { randomUUID } from "node:crypto";
import nodePath from "node:path";
import {
  applyFileChange,
  applyIndexChanges,
  planFileRestore,
  verifyRestorePlan,
  verifyRestoreGitState,
  withRestoreIndexLock,
} from "../rewind/restore-files.js";
import {
  captureWorktreeSnapshot,
  describeSnapshotChanges,
  diffEntries,
  diffSnapshots,
  sameEntry,
  type FileSnapshot,
} from "./snapshot.js";
import {
  CheckpointStore,
  stableKey,
  turnMessageSchema,
  type CheckpointBoundary,
  type CheckpointState,
  type CheckpointTimeline,
  type CheckpointUserMessage,
  type RestoreOperation,
  type TurnCheckpoint,
  type TurnOutcome,
} from "./store.js";
import {
  checkCheckpointEligibility,
  CheckpointSafetyError,
  refuse,
  requireCheckpointWorktree,
  sameWorktree,
  withCheckpointLock,
  type CheckpointScope,
  type CheckpointWorktreeOptions,
  type WorktreeIdentity,
} from "./worktree.js";

export type { CheckpointScope, CheckpointEligibility } from "./worktree.js";
export type {
  CheckpointUserMessage,
  TurnOutcome,
  TurnCheckpoint,
  RestoreOperation,
} from "./store.js";

export interface CheckpointServiceOptions extends CheckpointWorktreeOptions {
  /** Existing private-state parent directory, when the daemon home lives in a checkout. */
  storageRoot?: string;
}

export interface TurnLocation {
  timelineId: string;
  turnId: string;
}

export type CheckpointTarget =
  | (TurnLocation & { boundary: CheckpointBoundary })
  | { timelineId: string; boundary: "baseline" }
  | { backupOf: string };

export interface RestorePreview {
  target: string;
  expectedCurrent: string;
  changes: ReturnType<typeof diffSnapshots>;
}

function fingerprint(snapshot: FileSnapshot): string {
  return stableKey(JSON.stringify(snapshot));
}

function getTimeline(state: CheckpointState, scope: CheckpointScope, id: string) {
  return state.timelines.find(
    (timeline) => timeline.id === id && timeline.agentId === scope.agentId,
  );
}

function timelineTurns(
  state: CheckpointState,
  scope: CheckpointScope,
  timeline: CheckpointTimeline,
): TurnCheckpoint[] {
  const segments: TurnCheckpoint[][] = [];
  const visited = new Set<string>();
  let current = timeline;
  let boundary: (TurnLocation & { boundary: CheckpointBoundary }) | null = null;
  while (!visited.has(current.id)) {
    visited.add(current.id);
    const index: number = boundary
      ? current.turns.findIndex((turn: TurnCheckpoint) => turn.turnId === boundary?.turnId)
      : -1;
    let included = current.turns;
    if (boundary) {
      included =
        index < 0 ? [] : current.turns.slice(0, index + (boundary.boundary === "after" ? 1 : 0));
    }
    segments.push(included);
    if (!current.parent) return segments.toReversed().flat();
    if (index >= 0 || boundary === null) boundary = current.parent;
    const parent = getTimeline(state, scope, current.parent.timelineId);
    if (!parent) break;
    current = parent;
  }
  return refuse("Checkpoint timeline ancestry is invalid");
}

function findCheckpoint(
  state: CheckpointState,
  scope: CheckpointScope,
  target: CheckpointTarget,
): string {
  if ("backupOf" in target) {
    const operation = state.operations.find(
      (item) => item.operationId === target.backupOf && item.agentId === scope.agentId,
    );
    return operation?.backup ?? refuse("Restore backup is unavailable");
  }
  const timeline = getTimeline(state, scope, target.timelineId);
  if (!timeline) refuse("Checkpoint timeline is unavailable");
  if (target.boundary === "baseline") return timeline.baseline;
  const turn = timelineTurns(state, scope, timeline).find((item) => item.turnId === target.turnId);
  const id = target.boundary === "before" ? turn?.before : turn?.settled?.after;
  return id ?? refuse("Requested turn boundary has no file checkpoint");
}

function activeRestore(state: CheckpointState) {
  return state.operations.find((operation) => operation.status !== "applied");
}

function requireIdle(state: CheckpointState): void {
  if (state.timelines.some((timeline) => timeline.turns.some((turn) => !turn.settled))) {
    refuse("A checkpointed turn is still active");
  }
}

function operationError(error: unknown): string {
  return error instanceof CheckpointSafetyError
    ? error.message
    : "Worktree checkpoint operation failed";
}

/** The caller owns agent authorization and must keep all workspace writers idle during restore. */
export class CheckpointService {
  private readonly storageRoot: string;

  constructor(private readonly options: CheckpointServiceOptions) {
    this.storageRoot = options.storageRoot ?? options.paseoHome;
  }

  async eligibility(scope: CheckpointScope) {
    const result = await checkCheckpointEligibility({ scope, options: this.options });
    if (!result.allowed) return result;
    try {
      await this.store(scope).open(false);
      return result;
    } catch (error) {
      return { allowed: false as const, reason: operationError(error) };
    }
  }

  private store(scope: CheckpointScope): CheckpointStore {
    return new CheckpointStore(this.storageRoot, scope.workspaceId);
  }

  private async mutate<T>(
    scope: CheckpointScope,
    operation: (
      store: CheckpointStore,
      worktree: WorktreeIdentity,
      state: CheckpointState,
    ) => Promise<T>,
  ): Promise<T> {
    return withCheckpointLock(
      nodePath.join(this.storageRoot, stableKey(scope.workspaceId)),
      async () => {
        const worktree = await requireCheckpointWorktree({ scope, options: this.options });
        return withCheckpointLock(worktree.root, async () => {
          const store = this.store(scope);
          const saved = await store.load();
          if (saved && !sameWorktree(saved.worktree, worktree))
            refuse("Checkpoint worktree was replaced");
          return operation(
            store,
            worktree,
            saved ?? { version: 1, worktree, timelines: [], operations: [] },
          );
        });
      },
    );
  }

  private async capture(store: CheckpointStore, worktree: WorktreeIdentity): Promise<string> {
    await store.open(true);
    const snapshot = await captureWorktreeSnapshot({
      worktree,
      saveBlob: (oid, bytes) => store.putBlob(oid, bytes),
    });
    const id = randomUUID();
    await store.putSnapshot(id, snapshot);
    return id;
  }

  /** Call before dispatching the turn to its provider. Replayed events return the original boundary. */
  async acceptTurn(
    input: TurnLocation & {
      scope: CheckpointScope;
      message: CheckpointUserMessage;
      at?: string;
      daemonEpoch?: string;
    },
  ) {
    return this.mutate(input.scope, async (store, worktree, state) => {
      let timeline = getTimeline(state, input.scope, input.timelineId);
      const original = timeline?.turns.find((turn) => turn.turnId === input.turnId);
      if (original) {
        if (
          original.message.id !== input.message.id ||
          original.message.text !== input.message.text
        ) {
          refuse("Checkpoint turn ID already identifies another message");
        }
        return original;
      }
      if (activeRestore(state)) refuse("A checkpoint restore must finish first");
      requireIdle(state);
      const message = turnMessageSchema.parse(input.message);
      if (!input.timelineId || !input.turnId)
        refuse("Checkpoint timeline and turn IDs are required");
      if (
        timeline &&
        timelineTurns(state, input.scope, timeline).some((turn) => turn.turnId === input.turnId)
      ) {
        refuse("Checkpoint turn ID already exists in the inherited timeline");
      }
      const before = await this.capture(store, worktree);
      if (!timeline) {
        timeline = {
          id: input.timelineId,
          agentId: input.scope.agentId,
          baseline: before,
          parent: null,
          turns: [],
        };
        state.timelines.push(timeline);
      }
      const turn: TurnCheckpoint = {
        timelineId: input.timelineId,
        turnId: input.turnId,
        message,
        before,
        acceptedAt: input.at ?? new Date().toISOString(),
        daemonEpoch: input.daemonEpoch,
        settled: null,
      };
      timeline.turns.push(turn);
      await store.save(state);
      return turn;
    });
  }

  /** Call only after the provider has stopped writing, even on failure or cancellation. */
  async settleTurn(
    input: TurnLocation & {
      scope: CheckpointScope;
      outcome: TurnOutcome;
      at?: string;
      providerMessageId?: string;
    },
  ) {
    // Persist the settled outcome even when worktree eligibility/capture was lost while running.
    return withCheckpointLock(
      nodePath.join(this.storageRoot, stableKey(input.scope.workspaceId)),
      async () => {
        const store = this.store(input.scope);
        const state = await store.load();
        const turn =
          state &&
          getTimeline(state, input.scope, input.timelineId)?.turns.find(
            (item) => item.turnId === input.turnId,
          );
        if (!state || !turn) return null;
        if (turn.settled) return turn;
        let after: string | null = null;
        let captureError: string | undefined;
        try {
          const worktree = await requireCheckpointWorktree({
            scope: input.scope,
            options: this.options,
          });
          if (!sameWorktree(state.worktree, worktree)) refuse("Checkpoint worktree was replaced");
          after = await withCheckpointLock(worktree.root, () => this.capture(store, worktree));
        } catch (error) {
          captureError = operationError(error);
        }
        if (input.providerMessageId) turn.message.providerMessageId = input.providerMessageId;
        turn.settled = {
          outcome: input.outcome,
          at: input.at ?? new Date().toISOString(),
          after,
          ...(captureError ? { captureError } : {}),
        };
        await store.save(state);
        return turn;
      },
    );
  }

  async forkTimeline(input: {
    scope: CheckpointScope;
    timelineId: string;
    from: TurnLocation & { boundary: CheckpointBoundary };
  }) {
    return this.mutate(input.scope, async (store, _worktree, state) => {
      const existing = getTimeline(state, input.scope, input.timelineId);
      if (existing) {
        if (JSON.stringify(existing.parent) === JSON.stringify(input.from)) return existing;
        refuse("Checkpoint timeline ID already exists");
      }
      if (!input.timelineId) refuse("Checkpoint timeline ID is required");
      if (activeRestore(state)) refuse("A checkpoint restore must finish first");
      requireIdle(state);
      const parent = getTimeline(state, input.scope, input.from.timelineId);
      if (!parent) refuse("Parent checkpoint timeline is unavailable");
      const baseline = findCheckpoint(state, input.scope, input.from);
      const timeline: CheckpointTimeline = {
        id: input.timelineId,
        agentId: input.scope.agentId,
        parent: input.from,
        baseline,
        turns: [],
      };
      state.timelines.push(timeline);
      await store.save(state);
      return timeline;
    });
  }

  async getTimeline(input: { scope: CheckpointScope; timelineId: string }) {
    const state = await this.store(input.scope).load();
    const timeline = state && getTimeline(state, input.scope, input.timelineId);
    return state && timeline
      ? { ...timeline, turns: timelineTurns(state, input.scope, timeline) }
      : null;
  }

  async getActiveTimeline(scope: CheckpointScope) {
    const state = await this.store(scope).load();
    const timeline = state?.timelines.findLast((item) => item.agentId === scope.agentId);
    return state && timeline ? { ...timeline, turns: timelineTurns(state, scope, timeline) } : null;
  }

  async recoverInterruptedTurns(scope: CheckpointScope, daemonEpoch: string): Promise<void> {
    await this.mutate(scope, async (store, _worktree, state) => {
      let changed = false;
      for (const timeline of state.timelines) {
        for (const turn of timeline.turns) {
          if (turn.settled || turn.daemonEpoch === daemonEpoch) continue;
          // Restart cannot establish which process wrote to the directory while it was down.
          turn.settled = {
            outcome: "interrupted",
            at: new Date().toISOString(),
            after: null,
            captureError: "The daemon stopped before the turn was settled",
          };
          changed = true;
        }
      }
      if (changed) await store.save(state);
    });
  }

  /** The daemon can settle these as interrupted once it has stopped the previous run. */
  async listPendingTurns(scope: CheckpointScope): Promise<TurnCheckpoint[]> {
    const state = await this.store(scope).load();
    return (
      state?.timelines
        .filter((timeline) => timeline.agentId === scope.agentId)
        .flatMap((timeline) => timeline.turns.filter((turn) => !turn.settled)) ?? []
    );
  }

  async getCheckpointChanges(input: {
    scope: CheckpointScope;
    target: CheckpointTarget;
    from?: CheckpointTarget;
  }) {
    const store = this.store(input.scope);
    const state = await store.load();
    if (!state) refuse("Checkpoint timeline is unavailable");
    const target = await store.getSnapshot(findCheckpoint(state, input.scope, input.target));
    const reference = input.from
      ? await store.getSnapshot(findCheckpoint(state, input.scope, input.from))
      : null;
    return {
      head: target.head,
      ...describeSnapshotChanges(target),
      sinceReference: reference ? diffSnapshots(reference, target) : null,
    };
  }

  /** Returns a fingerprint that executeRestore must match before writing its backup. */
  async preflightRestore(input: {
    scope: CheckpointScope;
    target: CheckpointTarget;
  }): Promise<RestorePreview> {
    return this.mutate(input.scope, async (store, worktree, state) => {
      if (activeRestore(state)) refuse("A checkpoint restore must finish first");
      requireIdle(state);
      const target = findCheckpoint(state, input.scope, input.target);
      const before = await captureWorktreeSnapshot({ worktree });
      const after = await store.getSnapshot(target);
      const plan = planFileRestore(before, after);
      await verifyRestorePlan({ worktree, plan, before, after });
      return {
        target,
        expectedCurrent: fingerprint(before),
        changes: diffSnapshots(before, after),
      };
    });
  }

  async executeRestore(input: {
    scope: CheckpointScope;
    target: CheckpointTarget;
    operationId: string;
    expectedCurrent: string;
    signal?: AbortSignal;
    validate?: () => Promise<void>;
  }): Promise<RestoreOperation> {
    return this.mutate(input.scope, async (store, worktree, state) => {
      if (!input.operationId) refuse("Restore operation ID is required");
      const target = findCheckpoint(state, input.scope, input.target);
      const existing = state.operations.find(
        (operation) => operation.operationId === input.operationId,
      );
      if (existing) {
        if (existing.agentId !== input.scope.agentId || existing.target !== target)
          refuse("Restore operation ID already exists");
        return this.resume(store, worktree, state, existing, input);
      }
      if (activeRestore(state)) refuse("A checkpoint restore must finish first");
      requireIdle(state);
      input.signal?.throwIfAborted();
      const before = await captureWorktreeSnapshot({ worktree });
      const after = await store.getSnapshot(target);
      if (fingerprint(before) !== input.expectedCurrent) refuse("Checkpoint preflight is stale");
      const plan = planFileRestore(before, after);
      await verifyRestorePlan({ worktree, plan, before, after });
      // Revalidate after capturing the actual backup, before any Git or worktree writes.
      const backup = await this.capture(store, worktree);
      if (fingerprint(await store.getSnapshot(backup)) !== input.expectedCurrent)
        refuse("Checkpoint preflight is stale");
      const now = new Date().toISOString();
      const operation: RestoreOperation = {
        operationId: input.operationId,
        agentId: input.scope.agentId,
        target,
        backup,
        worktree,
        status: "applying",
        nextFile: 0,
        totalFiles: plan.files.length,
        indexApplied: false,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      state.operations.push(operation);
      await store.save(state);
      return this.resume(store, worktree, state, operation, input);
    });
  }

  async retryRestore(input: {
    scope: CheckpointScope;
    operationId: string;
    signal?: AbortSignal;
    validate?: () => Promise<void>;
  }) {
    return this.mutate(input.scope, async (store, worktree, state) => {
      const operation = state.operations.find(
        (item) => item.operationId === input.operationId && item.agentId === input.scope.agentId,
      );
      if (!operation) refuse("Restore operation is unavailable");
      return this.resume(store, worktree, state, operation, input);
    });
  }

  async getRestoreOperation(input: { scope: CheckpointScope; operationId: string }) {
    const state = await this.store(input.scope).load();
    return (
      state?.operations.find(
        (item) => item.operationId === input.operationId && item.agentId === input.scope.agentId,
      ) ?? null
    );
  }

  async listRestoreOperations(scope: CheckpointScope) {
    const state = await this.store(scope).load();
    return state?.operations.filter((item) => item.agentId === scope.agentId) ?? [];
  }

  private async resume(
    store: CheckpointStore,
    worktree: WorktreeIdentity,
    state: CheckpointState,
    operation: RestoreOperation,
    { signal, validate }: { signal?: AbortSignal; validate?: () => Promise<void> },
  ): Promise<RestoreOperation> {
    if (operation.status === "applied") return operation;
    if (!sameWorktree(operation.worktree, worktree)) refuse("Restore worktree was replaced");
    const saveProgress = async () => {
      operation.updatedAt = new Date().toISOString();
      await store.save(state);
    };
    try {
      await withRestoreIndexLock(worktree, operation.operationId, async (ownedLock) => {
        signal?.throwIfAborted();
        const [before, after, current] = await Promise.all([
          store.getSnapshot(operation.backup),
          store.getSnapshot(operation.target),
          captureWorktreeSnapshot({ worktree, ownedIndexLock: ownedLock }),
        ]);
        const plan = planFileRestore(before, after);
        planFileRestore(current, after);
        if (
          operation.totalFiles !== plan.files.length ||
          operation.nextFile > operation.totalFiles
        ) {
          refuse("Restore operation journal is inconsistent");
        }
        const currentFiles = new Map(current.files.map((entry) => [entry.path, entry]));
        const newFiles = new Map(after.files.map((entry) => [entry.path, entry]));
        const expected = new Map(before.files.map((entry) => [entry.path, entry]));
        for (const change of plan.files.slice(0, operation.nextFile)) {
          if (change.after) expected.set(change.path, change.after);
          else expected.delete(change.path);
        }
        const differences = diffEntries([...expected.values()], current.files);
        // A crash after a write but before recording progress may leave exactly the next change applied.
        if (
          differences.some(
            ({ path }) =>
              path !== plan.files[operation.nextFile]?.path ||
              !sameEntry(currentFiles.get(path), newFiles.get(path)),
          )
        ) {
          refuse("Working files changed since the restore backup was taken");
        }
        const canHaveAppliedIndex = operation.nextFile === operation.totalFiles;
        const indexMatchesBefore = diffEntries(before.index, current.index).length === 0;
        const indexMatchesAfter = diffEntries(after.index, current.index).length === 0;
        if (
          operation.indexApplied
            ? !indexMatchesAfter
            : !indexMatchesBefore && !(canHaveAppliedIndex && indexMatchesAfter)
        ) {
          refuse("Git index changed since the restore backup was taken");
        }
        const expectedGit = { ...before, index: current.index };
        operation.status = "applying";
        operation.lastError = null;
        const deletions = new Set(
          plan.files.filter((change) => !change.after).map((change) => change.path),
        );
        while (operation.nextFile < plan.files.length) {
          signal?.throwIfAborted();
          await applyFileChange({
            worktree,
            change: plan.files[operation.nextFile],
            format: before.format,
            deletions,
            readBlob: (entry) => store.getBlob(entry.oid, before.format),
            validate: async () => {
              signal?.throwIfAborted();
              await validate?.();
              await verifyRestoreGitState({ worktree, expected: expectedGit, ownedLock });
            },
          });
          operation.nextFile += 1;
          await saveProgress();
        }
        signal?.throwIfAborted();
        await applyIndexChanges({
          worktree,
          before: expectedGit,
          after,
          ownedLock,
          validate: async () => {
            await validate?.();
            const actual = await captureWorktreeSnapshot({ worktree, ownedIndexLock: ownedLock });
            if (fingerprint(actual) !== fingerprint({ ...after, index: expectedGit.index })) {
              refuse("Worktree changed before staging could be restored");
            }
          },
        });
        operation.indexApplied = true;
        await saveProgress();
        const verified = await captureWorktreeSnapshot({ worktree, ownedIndexLock: ownedLock });
        if (fingerprint(verified) !== fingerprint(after))
          refuse("Restored worktree does not match the checkpoint");
        operation.status = "applied";
        await saveProgress();
      });
    } catch (error) {
      operation.status = "retryable";
      operation.lastError = signal?.aborted
        ? "Checkpoint restore cancelled"
        : operationError(error);
      await saveProgress();
    }
    return operation;
  }
}
