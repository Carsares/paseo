import { lstat, realpath } from "node:fs/promises";
import { join, resolve, win32 } from "node:path";
import type { CheckoutGitFile, CheckoutGitWorkingTree, WorkbenchErrorCode } from "../messages.js";
import { createRunGitCommand, type GitCommandOptions } from "../../utils/run-git-command.js";
import type { GitWorktree } from "./repo-write-mutex.js";

const runGit = createRunGitCommand("checkout-workbench");

export async function git(
  repo: GitWorktree,
  args: string[],
  options?: Omit<GitCommandOptions, "cwd">,
) {
  const result = await runGit(args, {
    cwd: repo.root,
    ...options,
    envOverlay: { GIT_OPTIONAL_LOCKS: "0", ...options?.envOverlay },
  });
  if (result.truncated) throw new Error("Git output exceeds the workbench limit");
  return result;
}

export interface GitMutationDetails {
  actualHeadSha?: string | null;
  activeAgents?: CheckoutGitWorkingTree["activeAgents"];
  backupRef?: string;
  rebaseId?: string | null;
  operationState?: CheckoutGitWorkingTree["operationState"];
}

export class GitWorkbenchError extends Error {
  constructor(
    message: string,
    readonly code?: WorkbenchErrorCode,
    readonly details?: GitMutationDetails,
  ) {
    super(message);
  }
}

export async function assertGitWorktree(repo: GitWorktree): Promise<void> {
  const { stdout } = await git(repo, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--absolute-git-dir",
    "--git-common-dir",
    "--git-path",
    "index",
  ]);
  const [root, gitDir, commonDir, index] = stdout.trimEnd().split("\n");
  // Git consults environment and repository configuration. Verify the checkout
  // and index correspond to the filesystem identity used by the lock.
  if (
    !root ||
    !gitDir ||
    !commonDir ||
    !index ||
    (await realpath(root)) !== repo.root ||
    (await realpath(gitDir)) !== repo.gitDir ||
    (await realpath(commonDir)) !== repo.commonDir ||
    resolve(index) !== join(repo.gitDir, "index")
  ) {
    throw new Error("Git worktree identity changed or uses an unsupported layout");
  }
}

export async function readHead(repo: GitWorktree): Promise<string | null> {
  const { stdout, exitCode } = await git(
    repo,
    ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    {
      acceptExitCodes: [0, 1],
    },
  );
  return exitCode === 0 ? stdout.trim() : null;
}

export async function readHeadBranchRef(repo: GitWorktree): Promise<string | null> {
  const { stdout, exitCode } = await git(repo, ["symbolic-ref", "--quiet", "HEAD"], {
    acceptExitCodes: [0, 1],
  });
  return exitCode === 0 ? stdout.trimEnd() : null;
}

export async function operationState(
  repo: GitWorktree,
): Promise<CheckoutGitWorkingTree["operationState"]> {
  const present = async (name: string) => {
    try {
      await lstat(join(repo.gitDir, name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  if ((await present("rebase-merge")) || (await present("rebase-apply"))) {
    return (await present("REBASE_HEAD")) ? "rebase_paused" : "rebase";
  }
  if (await present("MERGE_HEAD")) return "merge";
  if (await present("CHERRY_PICK_HEAD")) return "cherry_pick";
  if (await present("REVERT_HEAD")) return "revert";
  return "idle";
}

const STATUS: Readonly<Partial<Record<string, CheckoutGitFile["status"]>>> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type_changed",
};
const CONFLICTS = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"] as const;
type ConflictStatus = (typeof CONFLICTS)[number];

function isConflict(status: string): status is ConflictStatus {
  return CONFLICTS.some((conflict) => conflict === status);
}

export function parseNameStatus(stdout: string): CheckoutGitFile[] {
  const tokens = stdout.split("\0");
  const files: CheckoutGitFile[] = [];
  for (let i = 0; i < tokens.length - 1; ) {
    const status = STATUS[tokens[i++]?.[0] ?? ""];
    const path = tokens[i++];
    if (!status || !path) throw new Error("Unexpected Git name-status result");
    if (status === "renamed" || status === "copied") {
      const newPath = tokens[i++];
      if (!newPath) throw new Error("Git did not return the rename destination");
      files.push({ path: newPath, oldPath: path, status });
    } else {
      files.push({ path, status });
    }
  }
  return files;
}

export async function readChanges(repo: GitWorktree, envOverlay?: GitCommandOptions["envOverlay"]) {
  const { stdout } = await git(
    repo,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--renames",
      "--ignore-submodules=none",
    ],
    { envOverlay },
  );
  const result: Pick<CheckoutGitWorkingTree, "staged" | "unstaged" | "untracked" | "conflicts"> = {
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: [],
  };
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]!;
    const xy = token.slice(0, 2);
    const path = token.slice(3);
    if (xy === "??") {
      result.untracked.push(path);
    } else if (isConflict(xy)) {
      result.conflicts.push({ path, status: xy });
    } else {
      const oldPath = /[RC]/.test(xy) ? tokens[++i] : undefined;
      const staged = STATUS[xy[0]!];
      const unstaged = STATUS[xy[1]!];
      if (staged)
        result.staged.push({
          path,
          status: staged,
          ...(oldPath && /[RC]/.test(xy[0]!) ? { oldPath } : {}),
        });
      if (unstaged)
        result.unstaged.push({
          path,
          status: unstaged,
          ...(oldPath && /[RC]/.test(xy[1]!) ? { oldPath } : {}),
        });
    }
  }
  return result;
}

export async function readWorkingTree(
  repo: GitWorktree,
  activeAgents: () => Promise<CheckoutGitWorkingTree["activeAgents"]>,
  envOverlay?: GitCommandOptions["envOverlay"],
): Promise<{ workingTree: CheckoutGitWorkingTree; branchRef: string | null }> {
  const [headSha, branchRef, state, changes, agents] = await Promise.all([
    readHead(repo),
    readHeadBranchRef(repo),
    operationState(repo),
    readChanges(repo, envOverlay),
    activeAgents(),
  ]);
  return {
    branchRef,
    workingTree: {
      repoRoot: repo.root,
      headSha,
      currentBranch: branchRef?.replace(/^refs\/heads\//, "") ?? null,
      operationState: state,
      ...changes,
      activeAgents: agents,
    },
  };
}

export function validateGitPaths(paths: string[] | undefined): string[] {
  if (!paths?.length) throw new Error("Select at least one repository path");
  for (const path of paths) {
    if (
      win32.isAbsolute(path) ||
      path.includes("\0") ||
      path
        .split(process.platform === "win32" ? /[\\/]/ : "/")
        .some(
          (part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git",
        )
    ) {
      throw new Error(`Invalid repository-relative path: ${path}`);
    }
  }
  return [...new Set(paths)];
}
