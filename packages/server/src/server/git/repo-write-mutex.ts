import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { expandTilde } from "../../utils/path.js";
import { runWithGitCommandPriority } from "../../utils/run-git-command.js";

export interface GitWorktree {
  root: string;
  gitDir: string;
  commonDir: string;
}

export function isWithinDirectory(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

// Resolve the lock keys from Git's on-disk layout without taking a Git process slot.
export async function findGitWorktree(cwd: string): Promise<GitWorktree | null> {
  let root = await realpath(expandTilde(cwd));
  if (!(await stat(root)).isDirectory()) return null;
  for (;;) {
    const dotGit = join(root, ".git");
    const entry = await lstat(dotGit).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (entry) {
      let gitDir: string;
      if (entry.isFile()) {
        const contents = await readFile(dotGit, "utf8");
        const gitFile = /^gitdir: (.+)\r?\n?$/.exec(contents);
        if (!gitFile) throw new Error("Invalid .git file");
        gitDir = await realpath(resolve(root, gitFile[1]!));
      } else {
        gitDir = await realpath(dotGit);
      }
      const common = await readFile(join(gitDir, "commondir"), "utf8").catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
      const commonDir =
        common === null ? gitDir : await realpath(resolve(gitDir, common.replace(/\r?\n$/, "")));
      return { root, gitDir, commonDir };
    }
    const parent = dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}

export async function resolveGitTarget(cwd: string, targetRepoRoot?: string): Promise<GitWorktree> {
  const workspacePath = await realpath(expandTilde(cwd));
  if (targetRepoRoot === undefined) {
    const repo = await findGitWorktree(workspacePath);
    if (!repo) throw new Error("Workspace is not in a Git worktree");
    return repo;
  }
  const targetPath = await realpath(expandTilde(targetRepoRoot));
  if (!isWithinDirectory(workspacePath, targetPath)) {
    if (
      !isWithinDirectory(targetPath, workspacePath) ||
      (await findGitWorktree(workspacePath))?.root !== targetPath
    ) {
      throw new Error("Target repository is outside the workspace checkout");
    }
  }
  const repo = await findGitWorktree(targetPath);
  if (repo?.root !== targetPath) throw new Error("Target must be a Git worktree root");
  return repo;
}

export class RepoWriteLockTimeout extends Error {
  constructor(readonly lockOperation: string) {
    super(`Timed out waiting for Git operation: ${lockOperation}`);
  }
}

interface Waiter {
  operation: string;
  next: (release: () => void) => void;
}

interface HeldLock {
  operation: string;
  waiters: Set<Waiter>;
}

export class RepoWriteMutex {
  private readonly locks = new Map<string, HeldLock>();

  constructor(private readonly timeoutMs = 30_000) {}

  private async acquire(key: string, operation: string, deadline: number): Promise<() => void> {
    const held = this.locks.get(key);
    if (!held) {
      this.locks.set(key, { operation, waiters: new Set() });
      return () => this.release(key);
    }
    return new Promise((next, reject) => {
      const waiter: Waiter = {
        operation,
        next: (release) => {
          clearTimeout(timer);
          next(release);
        },
      };
      const timer = setTimeout(
        () => {
          held.waiters.delete(waiter);
          reject(new RepoWriteLockTimeout(held.operation));
        },
        Math.max(0, deadline - performance.now()),
      );
      held.waiters.add(waiter);
    });
  }

  private release(key: string): void {
    const held = this.locks.get(key)!;
    const next = held.waiters.values().next().value;
    if (!next) {
      this.locks.delete(key);
      return;
    }
    held.waiters.delete(next);
    held.operation = next.operation;
    next.next(() => this.release(key));
  }

  async run<T>(repo: GitWorktree, operation: string, write: () => Promise<T>): Promise<T> {
    const deadline = performance.now() + this.timeoutMs;
    const releaseCommon = await this.acquire(`repo:${repo.commonDir}`, operation, deadline);
    try {
      const releaseWorktree = await this.acquire(`worktree:${repo.root}`, operation, deadline);
      try {
        return await runWithGitCommandPriority("high", write);
      } finally {
        releaseWorktree();
      }
    } finally {
      releaseCommon();
    }
  }
}

export const repoWriteMutex = new RepoWriteMutex();
