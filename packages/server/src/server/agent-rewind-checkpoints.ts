import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm, writeFile } from "node:fs/promises";
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
import { isMissing, withCheckpointLock } from "./agent/checkpoints/worktree.js";
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
    rewindConversation: () => Promise<void>;
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
      state: input.mode === "both" ? "awaiting_conversation" : "files_only",
    };
    await input.validate();
    await this.save(scope, journal);
    if (input.mode === "both") {
      await input.rewindConversation();
      journal.state = "conversation_confirmed";
      await this.save(scope, journal);
    }
    return this.restoreFiles(scope, journal, input.validate);
  }

  async retry(input: {
    scope: CheckpointScope;
    operationId: string;
    validate: () => Promise<void>;
  }) {
    const { scope } = input;
    const operationId = z.uuid().parse(input.operationId);
    if (!(await this.store(scope).open(false))) throw new Error("Restore operation is unavailable");
    const file = await open(
      this.journalPath(scope, operationId),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error) => {
      if (isMissing(error)) throw new Error("Restore operation is unavailable");
      throw error;
    });
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
    if (
      journal.agentId !== scope.agentId ||
      journal.operationId !== operationId ||
      journal.state === "awaiting_conversation"
    ) {
      throw new Error("Restore operation is unavailable");
    }
    return this.restoreFiles(scope, journal, input.validate);
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

  private journalPath(scope: CheckpointScope, operationId: string): string {
    return join(
      this.directories.paseoHome,
      "file-checkpoints",
      stableKey(scope.workspaceId),
      `rewind-${operationId}.json`,
    );
  }

  private async save(scope: CheckpointScope, journal: Journal): Promise<void> {
    const target = this.journalPath(scope, journal.operationId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(journal), { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
