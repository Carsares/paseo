import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RewindCheckpointOperation } from "@getpaseo/protocol/messages";
import { z } from "zod";
import {
  CheckpointService,
  type CheckpointScope,
  type RestoreOperation,
  type TurnCheckpoint,
} from "./agent/checkpoints/checkpoint-service.js";
import { captureWorktreeSnapshot } from "./agent/checkpoints/snapshot.js";
import { CheckpointStore, stableKey } from "./agent/checkpoints/store.js";
import {
  isMissing,
  sameWorktree,
  withCheckpointLock,
  worktreeIdentitySchema,
  type WorktreeIdentity,
} from "./agent/checkpoints/worktree.js";
import type { ConfirmedRewind } from "./agent/agent-storage.js";
import type { AgentRewindDirectories } from "./agent-rewind-scope.js";
import { readCheckpointDiff } from "./agent-checkpoint-diff.js";
import { verifyCheckpointAttribution } from "./agent-rewind-attribution.js";
import type { AgentTimelineItem } from "./agent/agent-sdk-types.js";

const journalSchema = z.object({
  operationId: z.uuid(),
  agentId: z.string(),
  messageId: z.string(),
  checkpointId: z.uuid(),
  backupCheckpointId: z.uuid(),
  timelineId: z.string(),
  turnId: z.string(),
  expectedCurrent: z.string(),
  worktree: worktreeIdentitySchema.optional(),
  state: z.enum(["awaiting_conversation", "files_only", "conversation_confirmed"]),
});

type Journal = z.infer<typeof journalSchema>;

export class AgentRewindCheckpoints {
  readonly service: CheckpointService;

  constructor(private readonly directories: AgentRewindDirectories) {
    this.service = new CheckpointService(directories);
  }

  withDirectory<T>(cwd: string, run: () => Promise<T>): Promise<T> {
    // The outer lock spans the conversation call and the separate storage calls.
    return withCheckpointLock(`agent-rewind:${cwd}`, run);
  }

  async diff(input: { scope: CheckpointScope; beforeId: string; afterId: string }) {
    const store = this.store(input.scope);
    if (!(await store.open(false))) throw new Error("Checkpoint snapshots are unavailable");
    const [before, after] = await Promise.all([
      store.getSnapshot(input.beforeId),
      store.getSnapshot(input.afterId),
    ]);
    return readCheckpointDiff({ store, cwd: input.scope.cwd, before, after });
  }

  async verifyAttribution(input: {
    scope: CheckpointScope;
    turn: TurnCheckpoint;
    paths: string[];
    items: AgentTimelineItem[];
  }): Promise<void> {
    const { scope, turn, paths, items } = input;
    const afterId = turn.settled?.after;
    if (!afterId) throw new Error("A turn has no completed checkpoint");
    const store = this.store(scope);
    const [before, after] = await Promise.all([
      store.getSnapshot(turn.before),
      store.getSnapshot(afterId),
    ]);
    await verifyCheckpointAttribution({ store, before, after, paths, items, cwd: scope.cwd });
  }

  async restore(input: {
    scope: CheckpointScope;
    turn: TurnCheckpoint;
    messageId: string;
    mode: "files" | "both";
    validate: () => Promise<void>;
    verifyChanges: (files: string[], expectedCurrent: string) => Promise<void>;
    rewindConversation: (confirmation: ConfirmedRewind) => Promise<void>;
  }) {
    const { scope, turn } = input;
    const target = {
      timelineId: turn.timelineId,
      turnId: turn.turnId,
      boundary: "before" as const,
    };
    const preview = await this.service.preflightRestore({ scope, target });
    await input.verifyChanges(
      [
        ...new Set(
          [...preview.changes.files, ...preview.changes.index].map((change) => change.path),
        ),
      ],
      preview.expectedCurrent,
    );
    const worktree = await this.service.eligibility(scope);
    if (!worktree.allowed) throw new Error(worktree.reason);
    const store = this.store(scope);
    await store.open(true);
    const backupCheckpointId = randomUUID();
    const backup = await captureWorktreeSnapshot({
      worktree: worktree.worktree,
      saveBlob: (oid, bytes) => store.putBlob(oid, bytes),
    });
    if (stableKey(JSON.stringify(backup)) !== preview.expectedCurrent) {
      throw new Error("Worktree changed during checkpoint preflight");
    }
    await store.putSnapshot(backupCheckpointId, backup);
    const journal: Journal = {
      operationId: randomUUID(),
      agentId: scope.agentId,
      messageId: input.messageId,
      checkpointId: preview.target,
      backupCheckpointId,
      timelineId: turn.timelineId,
      turnId: turn.turnId,
      expectedCurrent: preview.expectedCurrent,
      worktree: worktree.worktree,
      state: input.mode === "both" ? "awaiting_conversation" : "files_only",
    };
    await input.validate();
    await this.save(scope, journal);
    if (input.mode === "both") {
      await input.rewindConversation({
        operationId: journal.operationId,
        agentId: scope.agentId,
        workspaceId: scope.workspaceId,
        messageId: journal.messageId,
        checkpointId: journal.checkpointId,
        worktree: worktree.worktree,
      });
      // Recovery reads the confirmation from the saved session, even if file
      // restore has not started. The journal alone cannot confirm the rewind.
      journal.state = "conversation_confirmed";
    }
    return this.restoreFiles(scope, journal, input.validate);
  }

  async retry(input: {
    scope: CheckpointScope;
    operationId: string;
    validate: () => Promise<void>;
    confirmations: readonly ConfirmedRewind[];
  }) {
    const { scope } = input;
    const operationId = z.uuid().parse(input.operationId);
    if (!(await this.store(scope).open(false))) throw new Error("Restore operation is unavailable");
    const journal = await this.readJournal(this.store(scope), operationId);
    if (journal?.agentId !== scope.agentId) throw new Error("Restore operation is unavailable");
    const worktree = await this.requireWorktree(scope);
    this.assertJournalWorktree(journal, worktree);
    const confirmed = this.withConfirmation(scope, journal, worktree, input.confirmations);
    if (confirmed.state === "awaiting_conversation") {
      throw new Error("Conversation rewind is unconfirmed. Files were not restored.");
    }
    return this.restoreFiles(scope, confirmed, input.validate);
  }

  async getFileRecovery(scope: CheckpointScope, confirmations: readonly ConfirmedRewind[]) {
    const pendingFiles: Array<{ operationId: string; conversationRewound: boolean }> = [];
    const unconfirmedFileRewinds: Array<{ operationId: string }> = [];
    const store = this.store(scope);
    if (!(await store.open(false))) return { pendingFiles, unconfirmedFileRewinds };
    const worktree = await this.requireWorktree(scope);
    const operations = await this.service.listRestoreOperations(scope);
    const applied = new Set(
      operations.filter(({ status }) => status === "applied").map(({ operationId }) => operationId),
    );
    // The journal precedes file writes, so it also covers interruption before
    // CheckpointService could record an operation.
    for (const id of await this.listJournalIds(store)) {
      if (applied.has(id)) continue;
      const saved = await this.readJournal(store, id);
      if (saved?.agentId !== scope.agentId) continue;
      this.assertJournalWorktree(saved, worktree);
      const journal = this.withConfirmation(scope, saved, worktree, confirmations);
      if (journal.state === "awaiting_conversation") {
        unconfirmedFileRewinds.push({ operationId: journal.operationId });
      } else {
        pendingFiles.push({
          operationId: journal.operationId,
          conversationRewound: journal.state === "conversation_confirmed",
        });
      }
    }
    return { pendingFiles, unconfirmedFileRewinds };
  }

  async hasFileRecovery(agentId: string): Promise<boolean> {
    // Agents can move between workspaces. Inspect the saved records without
    // treating the agent's current workspace as proof of its old worktree identity.
    for await (const store of CheckpointStore.existing(this.directories.paseoHome)) {
      const state = await store.load();
      const operations = state?.operations.filter((operation) => operation.agentId === agentId);
      if (operations?.some((operation) => operation.status !== "applied")) return true;
      const applied = new Set(operations?.map((operation) => operation.operationId));
      for (const id of await this.listJournalIds(store)) {
        if (applied.has(id)) continue;
        if ((await this.readJournal(store, id))?.agentId === agentId) return true;
      }
    }
    return false;
  }

  private async listJournalIds(store: CheckpointStore): Promise<string[]> {
    const ids: string[] = [];
    for (const name of await readdir(store.workspaceDirectory)) {
      const id = z.uuid().safeParse(/^rewind-(.+)\.json$/.exec(name)?.[1]);
      if (id.success) ids.push(id.data);
    }
    return ids;
  }

  private withConfirmation(
    scope: CheckpointScope,
    journal: Journal,
    worktree: WorktreeIdentity,
    confirmations: readonly ConfirmedRewind[],
  ): Journal {
    if (
      journal.state === "awaiting_conversation" &&
      journal.worktree &&
      confirmations.some(
        (confirmed) =>
          confirmed.operationId === journal.operationId &&
          confirmed.agentId === scope.agentId &&
          confirmed.workspaceId === scope.workspaceId &&
          confirmed.messageId === journal.messageId &&
          confirmed.checkpointId === journal.checkpointId &&
          sameWorktree(confirmed.worktree, worktree),
      )
    ) {
      return { ...journal, state: "conversation_confirmed" };
    }
    return journal;
  }

  private async requireWorktree(scope: CheckpointScope): Promise<WorktreeIdentity> {
    const eligibility = await this.service.eligibility(scope);
    if (!eligibility.allowed) throw new Error(eligibility.reason);
    return eligibility.worktree;
  }

  private assertJournalWorktree(journal: Journal, worktree: WorktreeIdentity): void {
    if (journal.worktree && !sameWorktree(journal.worktree, worktree)) {
      throw new Error("Checkpoint worktree was replaced");
    }
  }

  private async readJournal(store: CheckpointStore, operationId: string): Promise<Journal | null> {
    const file = await open(
      this.journalPath(store, operationId),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (!file) return null;
    const raw = await (async () => {
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > 16 * 1024 ||
          (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
        ) {
          throw new Error("Restore operation is unavailable");
        }
        return await file.readFile("utf8");
      } finally {
        await file.close();
      }
    })();
    const journal = journalSchema.parse(JSON.parse(raw));
    if (journal.operationId !== operationId) throw new Error("Restore operation is unavailable");
    return journal;
  }

  private async restoreFiles(
    scope: CheckpointScope,
    journal: Journal,
    validate: () => Promise<void>,
  ): Promise<{ operation: RewindCheckpointOperation; error: string | null }> {
    let result: RestoreOperation | undefined;
    let error: string | null = null;
    try {
      await validate();
      if (journal.state === "conversation_confirmed") {
        await this.service.forkTimeline({
          scope,
          timelineId: journal.operationId,
          from: { timelineId: journal.timelineId, turnId: journal.turnId, boundary: "before" },
        });
      }
      const lookup = { scope, operationId: journal.operationId, validate };
      const existing = await this.service.getRestoreOperation(lookup);
      result = existing
        ? await this.service.retryRestore(lookup)
        : await this.service.executeRestore({
            ...lookup,
            target: { timelineId: journal.timelineId, turnId: journal.turnId, boundary: "before" },
            expectedCurrent: journal.expectedCurrent,
          });
      error = result.lastError;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : "File restore failed";
    }
    return {
      error,
      operation: {
        operationId: journal.operationId,
        target: { messageId: journal.messageId, checkpointId: journal.checkpointId },
        backupCheckpointId: journal.backupCheckpointId,
        conversationRewound: journal.state === "conversation_confirmed",
        status: result?.status === "applied" ? "files_restored" : "files_pending",
      },
    };
  }

  private store(scope: CheckpointScope): CheckpointStore {
    return new CheckpointStore(this.directories.paseoHome, scope.workspaceId);
  }

  private journalPath(store: CheckpointStore, operationId: string): string {
    return join(store.workspaceDirectory, `rewind-${operationId}.json`);
  }

  private async save(scope: CheckpointScope, journal: Journal): Promise<void> {
    const target = this.journalPath(this.store(scope), journal.operationId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(journal), { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
