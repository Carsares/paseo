import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writePrivateFileAtomicSync } from "../../private-files.js";
import { gitBlobId, oidSchema, snapshotSchema, type FileSnapshot } from "./snapshot.js";
import {
  isMissing,
  lstatIfExists,
  refuse,
  requireRealPath,
  worktreeIdentitySchema,
} from "./worktree.js";

const opaqueId = z.string().min(1);
const snapshotId = z.string().uuid();
const checkpointBoundarySchema = z.enum(["before", "after"]);
const turnOutcomeSchema = z.enum(["succeeded", "failed", "cancelled", "interrupted"]);

export const turnMessageSchema = z.object({
  id: opaqueId,
  text: z.string(),
  clientMessageId: opaqueId.optional(),
  providerMessageId: opaqueId.optional(),
  authorId: opaqueId.optional(),
});
export const turnSchema = z.object({
  timelineId: opaqueId,
  turnId: opaqueId,
  acceptedAt: z.string(),
  daemonEpoch: opaqueId.optional(),
  message: turnMessageSchema,
  before: snapshotId,
  settled: z
    .object({
      outcome: turnOutcomeSchema,
      at: z.string(),
      after: snapshotId.nullable(),
      captureError: z.string().optional(),
    })
    .nullable(),
});

export const timelineSchema = z.object({
  id: opaqueId,
  agentId: opaqueId,
  baseline: snapshotId,
  parent: z
    .object({
      timelineId: opaqueId,
      turnId: opaqueId,
      boundary: checkpointBoundarySchema,
    })
    .nullable(),
  turns: z.array(turnSchema),
});

export const restoreRecordSchema = z.object({
  operationId: opaqueId,
  agentId: opaqueId,
  target: snapshotId,
  backup: snapshotId,
  worktree: worktreeIdentitySchema,
  status: z.enum(["applying", "retryable", "applied"]),
  nextFile: z.number().int().nonnegative(),
  totalFiles: z.number().int().nonnegative(),
  indexApplied: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastError: z.string().nullable(),
});

const workspaceStateSchema = z.object({
  version: z.literal(1),
  worktree: worktreeIdentitySchema,
  timelines: z.array(timelineSchema),
  operations: z.array(restoreRecordSchema),
});

export type CheckpointBoundary = z.infer<typeof checkpointBoundarySchema>;
export type TurnOutcome = z.infer<typeof turnOutcomeSchema>;
export type TurnCheckpoint = z.infer<typeof turnSchema>;
export type CheckpointUserMessage = z.infer<typeof turnMessageSchema>;
export type CheckpointTimeline = z.infer<typeof timelineSchema>;
export type RestoreOperation = z.infer<typeof restoreRecordSchema>;
export type CheckpointState = z.infer<typeof workspaceStateSchema>;

export function stableKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

async function privateDirectory(directory: string, create: boolean): Promise<boolean> {
  if (create) {
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    });
  }
  const info = await lstatIfExists(directory);
  if (!info) return false;
  if (!info.isDirectory() || (process.platform !== "win32" && (info.mode & 0o077n) !== 0n)) {
    refuse("Checkpoint store is not private");
  }
  await requireRealPath(directory);
  return true;
}

async function readPrivate(file: string): Promise<Buffer | null> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    ) {
      refuse("Checkpoint store contains an unsafe file");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writePrivate(file: string, data: string | Buffer): Promise<void> {
  const info = await lstatIfExists(file);
  if (info && (!info.isFile() || info.nlink !== 1n))
    refuse("Checkpoint store contains an unsafe file");
  writePrivateFileAtomicSync(file, data);
}

export class CheckpointStore {
  private readonly workspaceDirectory: string;

  constructor(
    private readonly home: string,
    workspaceId: string,
  ) {
    this.workspaceDirectory = path.join(home, "file-checkpoints", stableKey(workspaceId));
  }

  async open(create: boolean): Promise<boolean> {
    await requireRealPath(this.home);
    for (let dir = this.home; ; dir = path.dirname(dir)) {
      if (
        (await lstatIfExists(path.join(dir, ".git"))) ||
        ((await lstatIfExists(path.join(dir, "HEAD")))?.isFile() &&
          (await lstatIfExists(path.join(dir, "objects")))?.isDirectory())
      ) {
        refuse("Checkpoint storage must be outside Git repositories");
      }
      if (dir === path.dirname(dir)) break;
    }
    return (
      (await privateDirectory(path.dirname(this.workspaceDirectory), create)) &&
      privateDirectory(this.workspaceDirectory, create)
    );
  }

  async load(): Promise<CheckpointState | null> {
    if (!(await this.open(false))) return null;
    const raw = await readPrivate(path.join(this.workspaceDirectory, "state.json"));
    return raw ? workspaceStateSchema.parse(JSON.parse(raw.toString("utf8"))) : null;
  }

  async save(state: CheckpointState): Promise<void> {
    await this.open(true);
    await writePrivate(path.join(this.workspaceDirectory, "state.json"), JSON.stringify(state));
  }

  async putSnapshot(id: string, snapshot: FileSnapshot): Promise<void> {
    const directory = path.join(this.workspaceDirectory, "snapshots");
    await privateDirectory(directory, true);
    await writePrivate(path.join(directory, snapshotId.parse(id)), JSON.stringify(snapshot));
  }

  async getSnapshot(id: string): Promise<FileSnapshot> {
    const directory = path.join(this.workspaceDirectory, "snapshots");
    if (!(await privateDirectory(directory, false))) refuse("Checkpoint snapshot is missing");
    const raw = await readPrivate(path.join(directory, snapshotId.parse(id)));
    if (!raw) refuse("Checkpoint snapshot is missing");
    return snapshotSchema.parse(JSON.parse(raw.toString("utf8")));
  }

  async putBlob(oid: string, bytes: Buffer): Promise<void> {
    const directory = path.join(this.workspaceDirectory, "blobs");
    await privateDirectory(directory, true);
    const file = path.join(directory, oidSchema.parse(oid));
    const existing = await lstatIfExists(file);
    if (!existing) {
      await writePrivate(file, bytes);
    } else if (!existing.isFile() || existing.nlink !== 1n) {
      refuse("Checkpoint store contains an unsafe file");
    }
  }

  async getBlob(oid: string, format: FileSnapshot["format"]): Promise<Buffer> {
    const bytes = await this.findBlob(oid, format);
    if (!bytes) refuse("Checkpoint file content is missing");
    return bytes;
  }

  async findBlob(oid: string, format: FileSnapshot["format"]): Promise<Buffer | null> {
    const directory = path.join(this.workspaceDirectory, "blobs");
    if (!(await privateDirectory(directory, false))) return null;
    const bytes = await readPrivate(path.join(directory, oidSchema.parse(oid)));
    if (bytes && gitBlobId(bytes, format) !== oid) refuse("Checkpoint file content is corrupt");
    return bytes;
  }
}
