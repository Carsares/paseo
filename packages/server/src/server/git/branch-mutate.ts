import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { CheckoutGitActiveAgent, SessionInboundMessage } from "../messages.js";
import { assertSafeGitRef } from "../worktree-session.js";
import { absent, readOptional, REBASE_STATE_DIR } from "./controlled-rebase-state.js";
import {
  git,
  GitWorkbenchError,
  operationState,
  readHead,
  readHeadBranchRef,
} from "./git-workbench-state.js";
import { newBackupRef } from "./repo-backup-refs.js";
import type { GitWorktree } from "./repo-write-mutex.js";

export type BranchMutationRequest = Extract<
  SessionInboundMessage,
  { type: "checkout.git.branch.mutate.request" }
>;
type ListAgents = (root: string) => Promise<CheckoutGitActiveAgent[]>;
type GitOperationState = Awaited<ReturnType<typeof operationState>>;

const HEADS = "refs/heads/";
const START_NAMESPACES = [HEADS, "refs/remotes/", "refs/tags/"];
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH_ENV = {
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

interface LocalBranch {
  name: string;
  ref: string;
}

interface Baseline {
  head: string | null;
  branch: string | null;
}

async function readBaseline(repo: GitWorktree): Promise<Baseline> {
  const head = await readHead(repo);
  return { head, branch: await readHeadBranchRef(repo) };
}

async function assertBaseline(repo: GitWorktree, baseline: Baseline): Promise<void> {
  const actual = await readBaseline(repo);
  if (actual.head !== baseline.head || actual.branch !== baseline.branch) {
    throw new GitWorkbenchError(
      "The branch or HEAD changed. Refresh and try again.",
      "STALE_HEAD_CONFLICT",
      { actualHeadSha: actual.head },
    );
  }
  const state = await operationState(repo);
  if (state !== "idle") {
    throw new GitWorkbenchError(
      "Finish the current Git operation before changing branches.",
      undefined,
      { operationState: state },
    );
  }
  for (const marker of ["sequencer", "BISECT_START"]) {
    if (await lstat(join(repo.gitDir, marker)).catch(absent)) {
      throw new Error("Finish the current Git operation before changing branches.");
    }
  }
}

function validateRefInput(ref: string, label: string): void {
  if (ref.startsWith("-") || ref.length > 1024) throw new Error(`Invalid ${label}`);
  assertSafeGitRef(ref, label);
}

async function validateBranch(repo: GitWorktree, input: string): Promise<LocalBranch> {
  const name = input.startsWith(HEADS) ? input.slice(HEADS.length) : input;
  validateRefInput(name, "branch name");
  if (name === "HEAD" || name.startsWith("refs/")) throw new Error("Expected a local branch name");
  await git(repo, ["check-ref-format", "--branch", name], { envOverlay: BRANCH_ENV });
  return { name, ref: HEADS + name };
}

async function readExactRef(repo: GitWorktree, ref: string): Promise<string | null> {
  const result = await git(repo, ["show-ref", "--verify", "--hash", "--", ref], {
    acceptExitCodes: [0, 128],
    envOverlay: BRANCH_ENV,
  });
  if (result.exitCode !== 0) return null;
  const oid = result.stdout.trim();
  if (!OID.test(oid)) throw new Error("Git returned an invalid branch or reference SHA");
  return oid;
}

async function assertDirectLocalRef(repo: GitWorktree, branch: LocalBranch): Promise<void> {
  const { exitCode } = await git(repo, ["symbolic-ref", "--quiet", "--no-recurse", branch.ref], {
    acceptExitCodes: [0, 1],
    envOverlay: BRANCH_ENV,
  });
  if (exitCode === 0)
    throw new Error("Select a direct local branch rather than a symbolic reference");
}

async function resolveStartPoint(repo: GitWorktree, point: string): Promise<string> {
  validateRefInput(point, "start point");
  if (point === "HEAD") {
    const head = await readHead(repo);
    if (!head)
      throw new Error("HEAD has no commit. Select a branch, tag, or commit as the start point.");
    return head;
  }
  if (!OID.test(point))
    await git(repo, ["check-ref-format", "--allow-onelevel", point], { envOverlay: BRANCH_ENV });
  const refs = point.startsWith("refs/")
    ? START_NAMESPACES.filter((prefix) => point.startsWith(prefix)).map(() => point)
    : START_NAMESPACES.map((prefix) => prefix + point);
  const named = (await Promise.all(refs.map((ref) => readExactRef(repo, ref)))).filter(
    (oid) => oid !== null,
  );
  if (named.length > 1 || (named.length && OID.test(point))) {
    throw new Error(
      "The start point is ambiguous. Select a fully qualified branch or tag reference.",
    );
  }
  const oid = named[0] ?? (OID.test(point) ? point : null);
  if (!oid) throw new Error("Start point branch, tag, or commit does not exist");
  const commit = (
    await git(repo, ["rev-parse", "--verify", "--end-of-options", oid + "^{commit}"], {
      envOverlay: BRANCH_ENV,
    })
  ).stdout.trim();
  if (!OID.test(commit)) throw new Error("Start point does not resolve to a commit");
  return commit;
}

async function activeBranchFiles(repo: GitWorktree): Promise<string[]> {
  const linked = join(repo.commonDir, "worktrees");
  const registered = await readdir(linked, { withFileTypes: true }).catch(absent);
  const gitDirs = new Set([repo.commonDir, repo.gitDir]);
  for (const entry of registered ?? []) {
    if (entry.isDirectory()) gitDirs.add(join(linked, entry.name));
  }
  return [...gitDirs].flatMap((dir) => [
    join(dir, REBASE_STATE_DIR, "head-name"),
    join(dir, "rebase-apply", "head-name"),
    join(dir, "BISECT_START"),
  ]);
}

async function assertBranchAvailable(
  repo: GitWorktree,
  branch: LocalBranch,
  allowCurrent: boolean,
): Promise<void> {
  const { stdout } = await git(repo, ["worktree", "list", "--porcelain", "-z"], {
    envOverlay: BRANCH_ENV,
  });
  let root: string | undefined;
  for (const entry of stdout.split("\0")) {
    if (entry.startsWith("worktree ")) root = entry.slice("worktree ".length);
    if (entry !== "branch " + branch.ref) continue;
    const current = allowCurrent && root && (await realpath(root).catch(absent)) === repo.root;
    if (!current) throw new Error("The branch is checked out in a worktree");
  }
  // During a rebase or bisect, a linked worktree can have a detached HEAD and
  // still expect to return to this branch when the operation completes.
  for (const path of await activeBranchFiles(repo)) {
    const name = (await readOptional(path))?.trimEnd();
    if (name === branch.ref || name === branch.name)
      throw new Error("The branch is in use by Git in a worktree");
  }
}

async function assertBranchTip(
  repo: GitWorktree,
  branch: LocalBranch,
  expected: string | null,
): Promise<void> {
  if ((await readExactRef(repo, branch.ref)) !== expected) {
    throw new GitWorkbenchError(
      "The target branch changed. Refresh and try again.",
      "STALE_HEAD_CONFLICT",
      { actualHeadSha: await readHead(repo) },
    );
  }
}

async function createBranch(
  repo: GitWorktree,
  input: BranchMutationRequest,
  branch: LocalBranch,
  baseline: Baseline,
): Promise<Baseline> {
  const oid =
    input.startPoint !== undefined
      ? await resolveStartPoint(repo, input.startPoint)
      : baseline.head;
  if (!oid) throw new Error("HEAD has no commit. Select a start point to create a branch.");
  await assertDirectLocalRef(repo, branch);
  if (await readExactRef(repo, branch.ref))
    throw new Error("A branch with that name already exists");
  await assertBaseline(repo, baseline);
  await git(repo, ["update-ref", "--no-deref", "-m", "Paseo: create branch", branch.ref, oid, ""], {
    envOverlay: BRANCH_ENV,
  });
  await assertBranchTip(repo, branch, oid);
  return baseline.branch === branch.ref && baseline.head === null
    ? { ...baseline, head: oid }
    : baseline;
}

async function checkoutBranch(
  repo: GitWorktree,
  branch: LocalBranch,
  tip: string,
  baseline: Baseline,
): Promise<Baseline> {
  await assertBranchAvailable(repo, branch, true);
  await assertBaseline(repo, baseline);
  await assertBranchTip(repo, branch, tip);
  await git(
    repo,
    ["switch", "--no-guess", "--no-overwrite-ignore", "--no-recurse-submodules", "--", branch.name],
    { envOverlay: BRANCH_ENV },
  );
  return { branch: branch.ref, head: tip };
}

async function renameBranch(
  repo: GitWorktree,
  branch: LocalBranch,
  newName: string | undefined,
  tip: string,
  baseline: Baseline,
): Promise<Baseline> {
  if (!newName) throw new Error("Enter a new branch name");
  const destination = await validateBranch(repo, newName);
  if (destination.ref === branch.ref) throw new Error("Enter a different branch name");
  await assertDirectLocalRef(repo, destination);
  if (await readExactRef(repo, destination.ref))
    throw new Error("A branch with that name already exists");
  await assertBranchAvailable(repo, branch, true);
  await assertBaseline(repo, baseline);
  await assertBranchTip(repo, branch, tip);
  await git(repo, ["branch", "--move", "--", branch.name, destination.name], {
    envOverlay: BRANCH_ENV,
  });
  await assertBranchTip(repo, destination, tip);
  await assertBranchTip(repo, branch, null);
  return baseline.branch === branch.ref ? { ...baseline, branch: destination.ref } : baseline;
}

async function isMerged(repo: GitWorktree, tip: string, head: string | null): Promise<boolean> {
  if (!head) return false;
  const result = await git(repo, ["merge-base", "--is-ancestor", tip, head], {
    acceptExitCodes: [0, 1],
    envOverlay: BRANCH_ENV,
  });
  return result.exitCode === 0;
}

async function removeBranchConfig(repo: GitWorktree, branch: LocalBranch): Promise<void> {
  const section = "branch." + branch.name;
  const { stdout } = await git(repo, ["config", "--local", "--null", "--name-only", "--list"], {
    envOverlay: BRANCH_ENV,
  });
  const hasSection = stdout
    .split("\0")
    .some((key) => key.slice(0, key.lastIndexOf(".")) === section);
  if (!hasSection) return;
  await assertBranchTip(repo, branch, null);
  await git(repo, ["config", "--local", "--remove-section", section], { envOverlay: BRANCH_ENV });
}

async function assertBranchDeleteWorktree(repo: GitWorktree, baseline: Baseline): Promise<void> {
  // Git can read main-worktree/HEAD and worktrees/<id>/HEAD, but update-ref
  // rejects those names for verify on both files and reftable. Even a detached
  // or prunable sibling must be accounted for before we can delete safely.
  const registered = await readdir(join(repo.commonDir, "worktrees"), {
    withFileTypes: true,
  }).catch(absent);
  if (
    repo.gitDir !== repo.commonDir ||
    registered?.some((entry) => entry.isDirectory() || entry.isSymbolicLink())
  ) {
    throw new Error(
      "Paseo cannot safely delete branches in a repository with linked worktrees. Git cannot verify all worktree HEADs in the delete transaction.",
    );
  }

  if (baseline.branch === null) {
    throw new Error(
      "Paseo cannot safely verify the detached HEAD for this deletion. Switch to another branch and try again.",
    );
  }
  const current = await validateBranch(repo, baseline.branch);
  if (current.ref !== baseline.branch) throw new Error("Unsupported symbolic HEAD");
}

async function deleteBranch(
  repo: GitWorktree,
  input: BranchMutationRequest,
  branch: LocalBranch,
  tip: string,
  baseline: Baseline,
): Promise<string | undefined> {
  await assertBranchAvailable(repo, branch, false);
  const merged = await isMerged(repo, tip, baseline.head);
  if (!merged && !input.force)
    throw new Error(
      "The branch is not merged into the current HEAD. Confirm force delete to keep a backup and remove it.",
    );
  const backupRef = merged ? undefined : newBackupRef("branch-del");
  await assertBaseline(repo, baseline);
  await assertBranchAvailable(repo, branch, false);
  await assertBranchDeleteWorktree(repo, baseline);
  // Let Git follow and lock HEAD through to its branch. If HEAD switched to the
  // deletion target, Git rejects the duplicate reference in the transaction.
  // An omitted old SHA requires the checked-out (unborn) branch to remain absent.
  const transaction = ["start", "verify HEAD" + (baseline.head ? " " + baseline.head : "")];
  if (backupRef) transaction.push("option no-deref", "create " + backupRef + " " + tip);
  transaction.push("option no-deref", "delete " + branch.ref + " " + tip, "prepare", "commit", "");
  // Checkout releases its index lock before writing HEAD. This check catches
  // an in-flight index write when it is visible, not every concurrent checkout.
  if (await lstat(join(repo.gitDir, "index.lock")).catch(absent)) {
    throw new Error("Git is writing the worktree index. Wait for Git to finish and try again.");
  }
  const result = await git(repo, ["update-ref", "--stdin"], {
    input: transaction.join("\n"),
    envOverlay: BRANCH_ENV,
    acceptExitCodes: [0, 128],
  });
  if (result.exitCode !== 0) {
    await assertBranchTip(repo, branch, tip);
    await assertBaseline(repo, baseline);
    await assertBranchAvailable(repo, branch, false);
    throw new Error("Git could not safely delete the branch: " + result.stderr.trim());
  }
  try {
    if (backupRef && (await readExactRef(repo, backupRef)) !== tip)
      throw new Error("Git did not preserve the deleted branch backup");
    await assertBranchTip(repo, branch, null);
    await removeBranchConfig(repo, branch);
    await assertBranchTip(repo, branch, null);
  } catch (error) {
    throw new GitWorkbenchError(error instanceof Error ? error.message : String(error), undefined, {
      backupRef,
    });
  }
  return backupRef;
}

// The caller holds both the common repository and selected worktree locks.
export async function mutateBranch(
  repo: GitWorktree,
  input: BranchMutationRequest,
  listAgents: ListAgents,
): Promise<{
  success: true;
  newHeadSha: string | null;
  operationState: GitOperationState;
  backupRef?: string;
}> {
  const branch = await validateBranch(repo, input.name);
  const baseline = await readBaseline(repo);
  if (baseline.head !== input.expectedHeadSha) {
    throw new GitWorkbenchError("HEAD changed. Refresh and try again.", "STALE_HEAD_CONFLICT", {
      actualHeadSha: baseline.head,
    });
  }
  if (!input.forceWithRunningAgents) {
    const activeAgents = await listAgents(repo.root);
    if (activeAgents.length)
      throw new GitWorkbenchError(
        "There are active agents in this worktree",
        "ACTIVE_AGENT_GUARD",
        { activeAgents },
      );
  }
  await assertBaseline(repo, baseline);
  let expected = baseline;
  let backupRef: string | undefined;
  if (input.action === "create") {
    expected = await createBranch(repo, input, branch, baseline);
  } else {
    await assertDirectLocalRef(repo, branch);
    const tip = await readExactRef(repo, branch.ref);
    if (!tip) throw new Error("Local branch does not exist");
    switch (input.action) {
      case "checkout":
        expected = await checkoutBranch(repo, branch, tip, baseline);
        break;
      case "rename":
        expected = await renameBranch(repo, branch, input.newName, tip, baseline);
        break;
      case "delete":
        backupRef = await deleteBranch(repo, input, branch, tip, baseline);
        break;
    }
  }
  const actual = await readBaseline(repo);
  if (actual.head !== expected.head || actual.branch !== expected.branch) {
    throw new GitWorkbenchError(
      "Git did not leave the worktree at the expected branch and HEAD. Refresh to review it.",
      "STALE_HEAD_CONFLICT",
      { actualHeadSha: actual.head, backupRef },
    );
  }
  return {
    success: true,
    newHeadSha: actual.head,
    operationState: await operationState(repo),
    backupRef,
  };
}
