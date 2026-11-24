import { copyFile, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitWorktree } from "./repo-write-mutex.js";
import { git, GitWorkbenchError } from "./git-workbench-state.js";

export interface StagedSnapshot {
  directory: string;
  indexPath: string;
  envOverlay: { GIT_INDEX_FILE: string };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

// Git installs a new index via atomic rename. Copying it gives us one stable
// view even if another Git process stages files immediately afterwards.
export async function withStagedSnapshot<T>(
  repo: GitWorktree,
  run: (snapshot: StagedSnapshot) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-staged-snapshot-"));
  const indexPath = join(directory, "index");
  try {
    await copyFile(join(repo.gitDir, "index"), indexPath).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
    return await run({ directory, indexPath, envOverlay: { GIT_INDEX_FILE: indexPath } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function readStagedTree(repo: GitWorktree, snapshot: StagedSnapshot): Promise<string> {
  const objects = join(snapshot.directory, "objects");
  const info = join(objects, "info");
  await mkdir(info, { recursive: true });
  // New trees and cache data go into scratch files. The real object store is
  // only an alternate, so a read request writes neither objects nor the index.
  const original = await git(repo, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "objects",
  ]);
  await writeFile(join(info, "alternates"), original.stdout);
  const scratchIndex = join(snapshot.directory, "tree-index");
  await copyFile(snapshot.indexPath, scratchIndex).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error;
  });
  return (
    await git(repo, ["write-tree"], {
      envOverlay: { GIT_INDEX_FILE: scratchIndex, GIT_OBJECT_DIRECTORY: objects },
    })
  ).stdout.trim();
}

export async function emptyTree(repo: GitWorktree): Promise<string> {
  return (await git(repo, ["hash-object", "-t", "tree", "--stdin"], { input: "" })).stdout.trim();
}

export async function withStagedCommitLock<T>(
  repo: GitWorktree,
  commit: (snapshot: StagedSnapshot) => Promise<T>,
): Promise<{ result: T; indexError?: string }> {
  const indexPath = join(repo.gitDir, "index");
  const lockPath = `${indexPath}.lock`;
  // Hold the same lock as Git while the commit and its hooks use the private
  // index. Other Git processes either finish before our copy or wait/fail.
  const lock = await open(lockPath, "wx", 0o666).catch((error: unknown) => {
    if (errorCode(error) === "EEXIST") {
      throw new GitWorkbenchError(
        "Another Git process is updating the staged files. Refresh and try again",
        "STALE_HEAD_CONFLICT",
      );
    }
    throw error;
  });
  let installed = false;
  const identity = await lock.stat({ bigint: true }).finally(() => lock.close());
  const stillOwnsLock = async () => {
    const current = await lstat(lockPath, { bigint: true }).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
      return null;
    });
    return current?.dev === identity.dev && current?.ino === identity.ino;
  };
  try {
    return await withStagedSnapshot(repo, async (snapshot) => {
      const result = await commit(snapshot);
      try {
        if (!(await stillOwnsLock())) throw new Error("Git index lock was replaced");
        await copyFile(snapshot.indexPath, lockPath);
        await rename(lockPath, indexPath);
        installed = true;
        return { result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          result,
          indexError: `Commit created, but Git's updated index could not be installed: ${message}`,
        };
      }
    });
  } finally {
    if (!installed && (await stillOwnsLock())) await rm(lockPath, { force: true });
  }
}
