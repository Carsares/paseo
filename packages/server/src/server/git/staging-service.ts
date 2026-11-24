import { randomUUID } from "node:crypto";
import { CHECKOUT_GIT_MAX_PATCH_BYTES } from "../messages.js";
import { backupDiscardPaths, createBackupRef } from "./repo-backup-refs.js";
import {
  git,
  GitWorkbenchError,
  operationState,
  readChanges,
  readHead,
  readHeadBranchRef,
  validateGitPaths,
} from "./git-workbench-state.js";
import type { GitWorktree } from "./repo-write-mutex.js";
import { readStagedTree, withStagedCommitLock } from "./staged-snapshot.js";

interface ChangeSelection {
  scope: "paths" | "all" | "hunk" | "lines";
  paths?: string[];
  patch?: string;
}

type ChangeAction = "stage" | "unstage" | "discard";

async function readPatchPath(repo: GitWorktree, input: ChangeSelection): Promise<string> {
  const patch = input.patch;
  if (!patch || Buffer.byteLength(patch, "utf8") > CHECKOUT_GIT_MAX_PATCH_BYTES) {
    throw new Error("Select a patch no larger than 512 KiB");
  }
  // P0 accepts one textual hunk of an existing file. File operations cover
  // additions, deletions, renames, binaries and changes to the file type.
  if (
    !patch.startsWith("diff --git ") ||
    (patch.match(/^diff --git /gm)?.length ?? 0) !== 1 ||
    (patch.match(/^@@ -/gm)?.length ?? 0) !== 1 ||
    /^(?:new file mode |deleted file mode |(?:old|new) mode |(?:rename|copy) (?:from|to) |--- \/dev\/null$|\+\+\+ \/dev\/null$|GIT binary patch$)/m.test(
      patch,
    ) ||
    /^index .* (?:120000|160000)$/m.test(patch)
  ) {
    throw new Error("Expected one text hunk from an existing file");
  }
  const { stdout } = await git(repo, ["apply", "--numstat", "-z", "-"], { input: patch });
  const [stat, end, extra] = stdout.split("\0");
  const fields = /^\d+\t\d+\t([\s\S]+)$/.exec(stat ?? "");
  if (!fields || end !== "" || extra !== undefined) {
    throw new Error("Patch does not identify one repository file");
  }
  const [path] = validateGitPaths([fields[1]!]);
  if (
    !path ||
    (input.paths !== undefined && (input.paths.length !== 1 || input.paths[0] !== path))
  ) {
    throw new Error("Patch does not match the selected path");
  }
  return path;
}

async function preparePatch(repo: GitWorktree, action: ChangeAction, input: ChangeSelection) {
  try {
    if (input.scope === "lines") throw new Error("Line staging is unavailable on this host");
    const path = await readPatchPath(repo, input);
    const args = [
      "apply",
      "--unidiff-zero",
      "--whitespace=nowarn",
      ...(action === "discard" ? [] : ["--cached"]),
      ...(action === "stage" ? [] : ["--reverse"]),
    ];
    const { stderr } = await git(repo, [...args, "--check", "--verbose", "-"], {
      input: input.patch,
      envOverlay: { LC_ALL: "C" },
    });
    if (/\boffset\b.*\blines?\b/.test(stderr)) {
      throw new Error("Patch no longer matches the selected hunk position");
    }
    return { path, args };
  } catch (error) {
    throw new GitWorkbenchError(
      error instanceof Error ? error.message : "Invalid patch",
      "PATCH_APPLY_REJECTED",
    );
  }
}

export async function changeSelection(
  repo: GitWorktree,
  head: string | null,
  action: ChangeAction,
  input: ChangeSelection,
  preserveBackup: (backupRef: string) => void,
): Promise<void> {
  if (input.scope === "hunk" || input.scope === "lines") {
    const { path, args } = await preparePatch(repo, action, input);
    if (action === "discard") preserveBackup(await backupDiscardPaths(repo, head, [path]));
    try {
      await git(repo, [...args, "-"], { input: input.patch });
    } catch (error) {
      throw new GitWorkbenchError(
        error instanceof Error ? error.message : "Could not apply patch",
        "PATCH_APPLY_REJECTED",
      );
    }
    return;
  }
  const paths = input.scope === "paths" ? validateGitPaths(input.paths) : [];
  if (input.patch !== undefined || (input.scope === "all" && input.paths !== undefined)) {
    throw new Error("The supplied selection does not match the operation scope");
  }
  if (action === "stage") {
    await git(repo, ["--literal-pathspecs", "add", "-A", "--", ...paths]);
  } else if (action === "unstage") {
    if (head !== null) {
      await git(repo, ["--literal-pathspecs", "reset", "-q", head, "--", ...paths]);
    } else {
      await git(repo, [
        "--literal-pathspecs",
        "rm",
        "-r",
        "--cached",
        "--force",
        "--ignore-unmatch",
        "--",
        ...(paths.length > 0 ? paths : ["."]),
      ]);
    }
  } else {
    if (paths.length === 0) throw new Error("Discard requires selected paths");
    const changes = await readChanges(repo);
    const unstaged = new Set(changes.unstaged.map((file) => file.path));
    const untracked = new Set(changes.untracked);
    const trackedPaths = paths.filter((path) => unstaged.has(path));
    const untrackedPaths = paths.filter((path) => untracked.has(path));
    if (trackedPaths.length + untrackedPaths.length !== paths.length) {
      throw new Error("The selected unstaged paths changed. Refresh and try again");
    }
    preserveBackup(await backupDiscardPaths(repo, head, paths));
    if (trackedPaths.length > 0) {
      await git(repo, ["--literal-pathspecs", "restore", "--worktree", "--", ...trackedPaths]);
    }
    if (untrackedPaths.length > 0) {
      await git(repo, ["--literal-pathspecs", "clean", "-f", "--", ...untrackedPaths]);
    }
  }
}

export async function createStagedCommit(input: {
  repo: GitWorktree;
  head: string | null;
  branchRef: string | null;
  message: string;
  tree: string;
  amend?: boolean;
  noVerify?: boolean;
  preserveBackup: (backupRef: string) => void;
}) {
  const { repo, head, branchRef, tree, message, amend, noVerify } = input;
  if (!message.trim()) throw new Error("Commit message is required");
  return withStagedCommitLock(repo, async (snapshot) => {
    const [actualHead, actualBranchRef] = await Promise.all([
      readHead(repo),
      readHeadBranchRef(repo),
    ]);
    if (
      actualHead !== head ||
      actualBranchRef !== branchRef ||
      (await readStagedTree(repo, snapshot)) !== tree
    ) {
      throw new GitWorkbenchError(
        "The branch, HEAD or staged content changed. Refresh and try again",
        "STALE_HEAD_CONFLICT",
        { actualHeadSha: actualHead },
      );
    }
    const state = await operationState(repo);
    if (state !== "idle") throw new Error(`Finish the active Git operation (${state}) first`);
    if (amend) {
      if (!head) throw new Error("There is no commit to amend");
      input.preserveBackup(await createBackupRef(repo, "amend", head));
    } else {
      const staged = await git(repo, ["diff", "--cached", "--quiet", "--exit-code", "--"], {
        acceptExitCodes: [0, 1],
        envOverlay: snapshot.envOverlay,
      });
      if (staged.exitCode === 0) throw new Error("Stage changes before committing");
    }
    if ((await readHeadBranchRef(repo)) !== branchRef) {
      throw new GitWorkbenchError(
        "The current branch changed. Refresh and try again",
        "STALE_HEAD_CONFLICT",
        { actualHeadSha: await readHead(repo) },
      );
    }
    const action = `commit (Paseo ${randomUUID()})`;
    await git(
      repo,
      [
        "commit",
        ...(amend ? ["--amend"] : []),
        ...(noVerify ? ["--no-verify"] : []),
        "-m",
        message,
      ],
      { timeout: 120_000, envOverlay: { ...snapshot.envOverlay, GIT_REFLOG_ACTION: action } },
    );
    return findCreatedCommit(repo, action);
  });
}

async function findCreatedCommit(repo: GitWorktree, action: string): Promise<string | null> {
  // Git records this action before running post-commit hooks. A later HEAD
  // read could pick up a different commit made by a hook or another process.
  try {
    const { stdout } = await git(repo, [
      "--no-replace-objects",
      "reflog",
      "show",
      "-64",
      "--no-notes",
      "--no-show-signature",
      "--format=%H%x09%gs",
      "HEAD",
    ]);
    const matches = stdout.split("\n").filter((line) => {
      const separator = line.indexOf("\t");
      return separator !== -1 && line.slice(separator + 1).startsWith(`${action}:`);
    });
    return matches.length === 1 ? (matches[0]?.split("\t")[0] ?? null) : null;
  } catch {
    return null;
  }
}
