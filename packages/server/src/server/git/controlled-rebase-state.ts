import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { git, validateGitPaths } from "./git-workbench-state.js";
import type { GitWorktree } from "./repo-write-mutex.js";

export const REBASE_STATE_DIR = "rebase-merge";
export const REBASE_MARKER = "paseo-rebase-id";
export const REBASE_JOURNAL = "paseo-controlled-rebase.json";
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export function absent(error: NodeJS.ErrnoException): null {
  if (error.code === "ENOENT") return null;
  throw error;
}

export function readOptional(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch(absent);
}

export async function readPausedStep(repo: GitWorktree, head: string): Promise<string> {
  const state = await readOptional(join(repo.gitDir, REBASE_STATE_DIR, "done"));
  return createHash("sha256")
    .update(JSON.stringify([head, state]))
    .digest("hex");
}

async function pathWithoutLinkedParents(root: string, path: string): Promise<string | null> {
  const parts = path.split(process.platform === "win32" ? /[/\\]/ : "/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const entry = await lstat(current).catch(absent);
    if (!entry) return null;
    if (!entry.isDirectory()) throw new Error("Cannot verify the parent of a paused rebase path");
  }
  return join(current, parts.at(-1)!);
}

async function hashRegularFile(
  path: string,
  expected: { dev: number; ino: number },
  limit: number,
) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      before.size > limit
    ) {
      throw new Error("Cannot verify a file in the paused rebase");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new Error("Pause snapshot exceeds its size limit");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (
      size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("A paused rebase file changed while being read");
    }
    return { size, fingerprint: ["file", before.mode, hash.digest("hex")] };
  } finally {
    await handle.close();
  }
}

async function fingerprintWorktreePath(root: string, path: string, limit: number) {
  const absolute = await pathWithoutLinkedParents(root, path);
  const entry = absolute ? await lstat(absolute).catch(absent) : null;
  if (!absolute || !entry) return { size: 0, fingerprint: ["missing"] };
  if (entry.isSymbolicLink()) {
    const target = await readlink(absolute, { encoding: "buffer" });
    return { size: target.length, fingerprint: ["link", target.toString("base64")] };
  }
  if (!entry.isFile()) throw new Error("Cannot verify a non-file path in the paused rebase");
  return hashRegularFile(absolute, entry, limit);
}

// Includes the index's normal and unmerged entries. File bytes matter because
// status alone cannot distinguish edits made to an unmerged worktree file.
export async function capturePauseFingerprint(
  repo: GitWorktree,
  paths: string[],
): Promise<string | null> {
  try {
    const { stdout: index } = await git(repo, ["ls-files", "--stage", "-z"]);
    if (index.includes("\uFFFD") || paths.some((path) => path.includes("\uFFFD"))) return null;
    const hash = createHash("sha256").update(index);
    let remaining = MAX_SNAPSHOT_BYTES;
    for (const path of paths.toSorted()) {
      validateGitPaths([path]);
      const { size, fingerprint } = await fingerprintWorktreePath(repo.root, path, remaining);
      remaining -= size;
      if (remaining < 0) return null;
      hash.update(JSON.stringify([path, fingerprint]));
    }
    return hash.digest("hex");
  } catch {
    // Continuing remains possible. Refuse destructive actions without a snapshot.
    return null;
  }
}
