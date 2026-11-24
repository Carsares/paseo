import type { CheckoutGitRepoRefs, CheckoutGitWorkingTree } from "@getpaseo/protocol/messages";

export interface RebaseSnapshot {
  rebaseId: string;
  backupRef: string | null;
  plannedSteps: number | null;
  branch: string | null;
  completedHeadSha?: string;
}

export function recordRebaseSnapshot(
  result: {
    rebaseId: string;
    backupRef?: string | null;
    completedHeadSha?: string;
  },
  branch: string | null,
  plannedSteps: number | undefined,
  saved: RebaseSnapshot | undefined,
): RebaseSnapshot {
  const previous = saved?.rebaseId === result.rebaseId ? saved : undefined;
  return {
    rebaseId: result.rebaseId,
    backupRef: result.backupRef ?? previous?.backupRef ?? null,
    plannedSteps: plannedSteps ?? previous?.plannedSteps ?? null,
    branch: previous?.branch ?? branch,
    completedHeadSha: result.completedHeadSha,
  };
}

export function selectCompletedUndo(
  repoRoot: string,
  current:
    | Pick<
        CheckoutGitWorkingTree,
        "repoRoot" | "operationState" | "currentBranch" | "headSha" | "rebaseId"
      >
    | null
    | undefined,
  refs: readonly CheckoutGitRepoRefs[],
  saved: RebaseSnapshot | undefined,
): RebaseSnapshot | undefined {
  if (current?.repoRoot !== repoRoot || current.operationState !== "idle") return;
  if (!saved?.completedHeadSha || !saved.backupRef || current.rebaseId !== saved.rebaseId) return;
  if (!current.currentBranch || current.headSha !== saved.completedHeadSha) return;
  if (saved.branch !== null && current.currentBranch !== saved.branch) return;
  const backups = refs.find((repo) => repo.repoRoot === repoRoot)?.backups;
  if (findActiveRebaseBackup(saved.rebaseId, backups) !== saved.backupRef) return;
  return { ...saved, branch: current.currentBranch };
}

export function isRebasePaused(state: CheckoutGitWorkingTree["operationState"] | undefined) {
  return state === "rebase_paused" || state === "rebase";
}

export function recoverPausedRebaseSnapshot(
  repoRoot: string,
  tree: CheckoutGitWorkingTree | null | undefined,
  refs: readonly CheckoutGitRepoRefs[],
  saved: RebaseSnapshot | undefined,
): RebaseSnapshot | undefined {
  if (tree?.repoRoot !== repoRoot || !isRebasePaused(tree.operationState) || !tree.rebaseId) return;
  const savedInstance = saved?.rebaseId === tree.rebaseId ? saved : undefined;
  const backups = refs.find((repo) => repo.repoRoot === repoRoot)?.backups;
  return {
    rebaseId: tree.rebaseId,
    backupRef: findActiveRebaseBackup(tree.rebaseId, backups),
    plannedSteps: savedInstance?.plannedSteps ?? null,
    branch: savedInstance?.branch ?? tree.currentBranch,
  };
}

/** The controlled rebase journal uses this ID as the last component of its backup reference. */
function findActiveRebaseBackup(
  rebaseId: string,
  backups: CheckoutGitRepoRefs["backups"] | undefined,
): string | null {
  const id = rebaseId.replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  const matching = backups?.filter(({ name }) => {
    const match = /^refs\/paseo\/backup\/rebase-\d{13}-([a-f0-9]{32})$/.exec(name);
    return match?.[1] === id;
  });
  return matching?.length === 1 ? (matching[0]?.name ?? null) : null;
}
