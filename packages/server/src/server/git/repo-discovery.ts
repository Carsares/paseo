import { createHash } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import pLimit from "p-limit";
import { expandTilde } from "../../utils/path.js";
import type { CheckoutGitRepo } from "../messages.js";
import {
  assertGitWorktree,
  operationState,
  readHead,
  readHeadBranchRef,
} from "./git-workbench-state.js";
import {
  findGitWorktree,
  isWithinDirectory,
  resolveGitTarget,
  type GitWorktree,
} from "./repo-write-mutex.js";

const MAX_DEPTH = 2;
const MAX_REPOS = 16;
const MAX_DIRECTORY_ENTRIES = 8192;
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "dist", "vendor"]);
export const limitGitGraphRepo = pLimit(4);

export async function resolveP1Target(cwd: string, target?: string): Promise<GitWorktree> {
  const workspace = resolve(expandTilde(cwd));
  const canonical = await realpath(workspace);
  if (target !== undefined) {
    const requested = resolve(expandTilde(target));
    const expected = isWithinDirectory(workspace, requested)
      ? resolve(canonical, relative(workspace, requested))
      : requested;
    if ((await realpath(requested)) !== expected) {
      throw new Error("Target repository must not be reached through a symbolic link");
    }
  }
  const repo = await resolveGitTarget(canonical, target);
  if (!(await hasGitMarker(repo.root))) throw new Error("Unsupported Git worktree marker");
  await assertGitWorktree(repo);
  return repo;
}

export async function resolveGraphRepos(cwd: string, roots: string[]): Promise<GitWorktree[]> {
  if (roots.length === 0 || roots.length > MAX_REPOS) {
    throw new Error("Select between 1 and 16 repositories");
  }
  const repos = await Promise.all(
    [...new Set(roots)].map((root) => limitGitGraphRepo(() => resolveP1Target(cwd, root))),
  );
  return [...new Map(repos.map((repo) => [repo.root, repo])).values()].sort(
    (a, b) => Number(a.root > b.root) - Number(a.root < b.root),
  );
}

async function hasGitMarker(path: string) {
  const marker = await lstat(join(path, ".git")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return marker?.isDirectory() || marker?.isFile();
}

export async function discoverRepos(input: {
  cwd: string;
  maxDepth?: number;
  includeWorktrees?: boolean;
}): Promise<CheckoutGitRepo[]> {
  const workspace = await realpath(expandTilde(input.cwd));
  const enclosing = await findGitWorktree(workspace);
  const roots = new Set<string>();
  const depthLimit = Math.min(MAX_DEPTH, input.maxDepth ?? MAX_DEPTH);
  const queue = [{ path: workspace, depth: 0 }];
  let entries = 0;
  if (enclosing && (await hasGitMarker(enclosing.root))) roots.add(enclosing.root);

  for (const { path, depth } of queue) {
    if ((await realpath(path)) !== path) continue;
    if (!roots.has(path) && (await hasGitMarker(path))) {
      const repo = await findGitWorktree(path);
      if (repo?.root === path && (input.includeWorktrees || repo.gitDir === repo.commonDir)) {
        roots.add(path);
      }
    }
    if (roots.size === MAX_REPOS) break;
    if (depth === depthLimit) continue;
    const children: string[] = [];
    for await (const entry of await opendir(path)) {
      if (++entries > MAX_DIRECTORY_ENTRIES) {
        throw new Error("Workspace directory limit exceeded while discovering Git repositories");
      }
      if (!EXCLUDED_DIRECTORIES.has(entry.name) && entry.isDirectory() && !entry.isSymbolicLink()) {
        children.push(join(path, entry.name));
      }
    }
    children.sort();
    for (const child of children) queue.push({ path: child, depth: depth + 1 });
  }

  return Promise.all(
    [...roots].map((root) =>
      limitGitGraphRepo(async () => {
        const repo = await resolveP1Target(workspace, root);
        const headSha = await readHead(repo);
        const branch = await readHeadBranchRef(repo);
        return {
          repoId: createHash("sha256").update(repo.root).digest("hex").slice(0, 12),
          repoRoot: repo.root,
          displayName: basename(repo.root),
          headSha,
          currentBranch: branch?.replace(/^refs\/heads\//, "") ?? null,
          operationState: await operationState(repo),
        };
      }),
    ),
  );
}
