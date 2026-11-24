import type { CheckoutGitRepoRefs, CheckoutGitWorkingTree } from "@getpaseo/protocol/messages";
import { expect, it } from "vitest";
import { recordRebaseSnapshot, recoverPausedRebaseSnapshot, selectCompletedUndo } from "./snapshot";

const repoRoot = "/workspace/repo";
const rebaseId = "f847981e-5d25-4bd2-bd60-34a3203d14b7";
const suffix = rebaseId.replaceAll("-", "");
const backupRef = "refs/paseo/backup/rebase-1800000000000-" + suffix;
const backup = { name: backupRef, sha: "a".repeat(40) };
const tree: CheckoutGitWorkingTree = {
  repoRoot,
  rebaseId,
  operationState: "rebase_paused",
  headSha: "b".repeat(40),
  currentBranch: null,
  staged: [],
  unstaged: [],
  untracked: [],
  conflicts: [],
  activeAgents: [],
};

function refs(root: string, backups: CheckoutGitRepoRefs["backups"]): CheckoutGitRepoRefs {
  return { repoRoot: root, localBranches: [], remotes: [], tags: [], backups };
}

it("recovers the paused instance and matching backup after reopening a graph", () => {
  const newer = { ...backup, name: "refs/paseo/backup/rebase-1800000000002-" + "c".repeat(32) };
  const amend = { ...backup, name: "refs/paseo/backup/amend-1800000000001-" + suffix };
  expect(
    recoverPausedRebaseSnapshot(
      repoRoot,
      tree,
      [refs(repoRoot, [newer, amend, backup])],
      undefined,
    ),
  ).toEqual({ rebaseId, backupRef, branch: null, plannedSteps: null });
});

it("requires a matching working tree and a unique backup from that repository", () => {
  const duplicate = { ...backup, name: "refs/paseo/backup/rebase-1800000000001-" + suffix };
  const wrongRepo = refs("/workspace/other", [backup]);
  expect(recoverPausedRebaseSnapshot(repoRoot, tree, [wrongRepo], undefined)?.backupRef).toBeNull();
  expect(
    recoverPausedRebaseSnapshot(repoRoot, tree, [refs(repoRoot, [backup, duplicate])], undefined)
      ?.backupRef,
  ).toBeNull();
  expect(
    recoverPausedRebaseSnapshot(wrongRepo.repoRoot, tree, [wrongRepo], undefined),
  ).toBeUndefined();
  expect(
    recoverPausedRebaseSnapshot(repoRoot, { ...tree, rebaseId: null }, [], undefined),
  ).toBeUndefined();
  expect(
    recoverPausedRebaseSnapshot(repoRoot, { ...tree, operationState: "idle" }, [], undefined),
  ).toBeUndefined();
});

it("keeps branch and plan metadata only for the same rebase instance", () => {
  const saved = { rebaseId, backupRef, branch: "topic", plannedSteps: 4 };
  const references = [refs(repoRoot, [backup])];
  expect(recoverPausedRebaseSnapshot(repoRoot, tree, references, saved)).toEqual(saved);
  expect(
    recoverPausedRebaseSnapshot(repoRoot, tree, references, { ...saved, rebaseId: "previous" }),
  ).toEqual({ rebaseId, backupRef, branch: null, plannedSteps: null });
});

it("allows completed undo only against the same idle checkout and its unique backup", () => {
  const current = {
    ...tree,
    operationState: "idle" as const,
    currentBranch: "topic",
    headSha: "b".repeat(40),
  };
  const saved = {
    branch: "topic",
    completedHeadSha: current.headSha,
    rebaseId,
    backupRef,
    plannedSteps: 4,
  };
  const references = [refs(repoRoot, [backup])];
  expect(selectCompletedUndo(repoRoot, current, references, saved)).toEqual(saved);
  expect(
    selectCompletedUndo(repoRoot, { ...current, headSha: "c".repeat(40) }, references, saved),
  ).toBeUndefined();
  expect(
    selectCompletedUndo(repoRoot, { ...current, currentBranch: "different" }, references, saved),
  ).toBeUndefined();
  expect(selectCompletedUndo(repoRoot, tree, references, saved)).toBeUndefined();
  expect(
    selectCompletedUndo(repoRoot, { ...current, repoRoot: "/other" }, references, saved),
  ).toBeUndefined();
  expect(selectCompletedUndo(repoRoot, current, [refs("/other", [backup])], saved)).toBeUndefined();
  expect(selectCompletedUndo(repoRoot, current, [refs(repoRoot, [])], saved)).toBeUndefined();
  const duplicate = { ...backup, name: "refs/paseo/backup/rebase-1800000000001-" + suffix };
  expect(
    selectCompletedUndo(repoRoot, current, [refs(repoRoot, [backup, duplicate])], saved),
  ).toBeUndefined();
});

it("restores undo after a recovered detached rebase completes on its verified branch", () => {
  const references = [refs(repoRoot, [backup])];
  const paused = recoverPausedRebaseSnapshot(repoRoot, tree, references, undefined);
  expect(paused?.branch).toBeNull();
  const completedHeadSha = "d".repeat(40);
  const saved = recordRebaseSnapshot(
    { rebaseId, backupRef, completedHeadSha },
    null,
    undefined,
    paused,
  );
  const current: CheckoutGitWorkingTree = {
    ...tree,
    headSha: completedHeadSha,
    operationState: "idle",
    currentBranch: "restored-topic",
  };
  expect(selectCompletedUndo(repoRoot, current, references, saved)).toEqual({
    ...saved,
    branch: "restored-topic",
  });
  expect(
    selectCompletedUndo(
      repoRoot,
      { ...current, currentBranch: "other-branch", rebaseId: null },
      references,
      saved,
    ),
  ).toBeUndefined();
  expect(
    selectCompletedUndo(repoRoot, { ...current, rebaseId: "another-instance" }, references, saved),
  ).toBeUndefined();
  expect(
    selectCompletedUndo(repoRoot, { ...current, rebaseId: undefined }, references, saved),
  ).toBeUndefined();
  expect(
    selectCompletedUndo(repoRoot, { ...current, currentBranch: null }, references, saved),
  ).toBeUndefined();
});
