import type {
  CheckoutGitActiveAgent,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../messages.js";
import { pushCurrentBranch, type GitMutationRefreshReason } from "../../utils/checkout-git.js";
import {
  assertGitWorktree,
  git,
  GitWorkbenchError,
  operationState,
  readHead,
  readHeadBranchRef,
  readWorkingTree,
} from "./git-workbench-state.js";
import type { GitCommitBaselines } from "./git-commit-baselines.js";
import { collectExpiredBackupRefs } from "./repo-backup-refs.js";
import {
  RepoWriteLockTimeout,
  repoWriteMutex,
  resolveGitTarget,
  type GitWorktree,
} from "./repo-write-mutex.js";
import { changeSelection, createStagedCommit } from "./staging-service.js";
import { readStagedTree, withStagedSnapshot } from "./staged-snapshot.js";
import { createStash, listStashes, mutateStash, showStash } from "./stash-service.js";

type GitWorkbenchOperation =
  | "working_tree.get"
  | "stage.apply"
  | "unstage.apply"
  | "discard.apply"
  | "commit.create"
  | "commit.generate_message"
  | "stash.list"
  | "stash.create"
  | "stash.show"
  | "stash.apply"
  | "stash.drop";
export type GitWorkbenchRequest = Extract<
  SessionInboundMessage,
  {
    type: `checkout.git.${GitWorkbenchOperation}.request`;
  }
>;
type GitWorkbenchResponse = Extract<
  SessionOutboundMessage,
  {
    type: `checkout.git.${GitWorkbenchOperation}.response`;
  }
>;
type GitWorkbenchMutation = Extract<GitWorkbenchRequest, { expectedHeadSha?: string | null }>;

export interface GitWorkbenchHost {
  listActiveAgents(repoRoot: string): Promise<CheckoutGitActiveAgent[]>;
  withDirectoryWrite<T>(cwd: string, write: () => Promise<T>): Promise<T>;
  refresh(repoRoot: string, cwd: string, reason: GitMutationRefreshReason): Promise<void>;
  generateCommitMessage(cwd: string, source: "staged" | "uncommitted"): Promise<string>;
  reportBackgroundError(error: unknown, cwd: string): void;
}

const REFRESH_REASONS = {
  "checkout.git.stage.apply.request": "stage-changes",
  "checkout.git.unstage.apply.request": "unstage-changes",
  "checkout.git.discard.apply.request": "discard-changes",
  "checkout.git.commit.create.request": "commit-changes",
  "checkout.git.stash.create.request": "stash-push",
  "checkout.git.stash.apply.request": "stash-pop",
  "checkout.git.stash.drop.request": "stash-drop",
} satisfies Record<GitWorkbenchMutation["type"], GitMutationRefreshReason>;

function serializeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof GitWorkbenchError) {
    return { error: message, errorCode: error.code, ...error.details };
  }
  if (error instanceof RepoWriteLockTimeout) {
    return {
      error: message,
      errorCode: "REPO_WRITE_LOCK_TIMEOUT" as const,
      lockOperation: error.lockOperation,
    };
  }
  return { error: message };
}

export async function handleGitWorkbenchRequest(
  msg: GitWorkbenchRequest,
  host: GitWorkbenchHost,
  commitBaselines: GitCommitBaselines,
): Promise<GitWorkbenchResponse> {
  const base = { cwd: msg.cwd, requestId: msg.requestId };
  let repoRoot = msg.targetRepoRoot ?? msg.cwd;
  try {
    const repo = await resolveGitTarget(msg.cwd, msg.targetRepoRoot);
    repoRoot = repo.root;
    const target = { ...base, repoRoot, error: null };
    switch (msg.type) {
      case "checkout.git.working_tree.get.request": {
        const workingTree = await repoWriteMutex.run(repo, msg.type, async () => {
          await assertGitWorktree(repo);
          return withStagedSnapshot(repo, async (snapshot) => {
            const { workingTree: tree, branchRef } = await readWorkingTree(
              repo,
              () => host.listActiveAgents(repo.root),
              snapshot.envOverlay,
            );
            if (tree.conflicts.length === 0 && tree.operationState === "idle") {
              const stagedTree = await readStagedTree(repo, snapshot);
              const [head, currentBranchRef] = await Promise.all([
                readHead(repo),
                readHeadBranchRef(repo),
              ]);
              if (tree.headSha !== head || branchRef !== currentBranchRef) {
                throw new GitWorkbenchError(
                  "The branch or HEAD changed while reading the working tree. Refresh and try again",
                  "STALE_HEAD_CONFLICT",
                );
              }
              const recorded = commitBaselines.remember(msg.requestId, {
                cwd: msg.cwd,
                repoRoot: repo.root,
                head,
                branchRef,
                tree: stagedTree,
              });
              if (!recorded) {
                throw new GitWorkbenchError(
                  "Use a new request ID to refresh the working tree snapshot",
                  "STALE_HEAD_CONFLICT",
                  { actualHeadSha: head },
                );
              }
            }
            return tree;
          });
        });
        return {
          type: "checkout.git.working_tree.get.response",
          payload: { ...base, error: null, workingTree },
        };
      }
      case "checkout.git.commit.generate_message.request": {
        await assertGitWorktree(repo);
        const message = await host.generateCommitMessage(repo.root, msg.source);
        return {
          type: "checkout.git.commit.generate_message.response",
          payload: { ...target, message },
        };
      }
      case "checkout.git.stash.list.request": {
        await assertGitWorktree(repo);
        const entries = await listStashes(repo);
        return { type: "checkout.git.stash.list.response", payload: { ...target, entries } };
      }
      case "checkout.git.stash.show.request": {
        const result = await repoWriteMutex.run(repo, msg.type, async () => {
          await assertGitWorktree(repo);
          return showStash(repo, msg.stashRef);
        });
        return { type: "checkout.git.stash.show.response", payload: { ...target, ...result } };
      }
      default:
        return await mutateGitWorkbench(msg, repo, host, commitBaselines);
    }
  } catch (error) {
    const failure = { ...base, repoRoot, ...serializeError(error) };
    switch (msg.type) {
      case "checkout.git.working_tree.get.request":
        return {
          type: "checkout.git.working_tree.get.response",
          payload: { ...failure, workingTree: null },
        };
      case "checkout.git.commit.generate_message.request":
        return {
          type: "checkout.git.commit.generate_message.response",
          payload: { ...failure, message: null },
        };
      case "checkout.git.stash.list.request":
        return { type: "checkout.git.stash.list.response", payload: { ...failure, entries: [] } };
      case "checkout.git.stash.show.request":
        return {
          type: "checkout.git.stash.show.response",
          payload: { ...failure, entry: null, files: [] },
        };
      case "checkout.git.stash.create.request":
        return {
          type: "checkout.git.stash.create.response",
          payload: { ...failure, success: false, entry: null },
        };
      default: {
        const type = mutationResponseType(msg.type);
        return { type, payload: { ...failure, success: false } };
      }
    }
  }
}

function mutationResponseType(
  type: Exclude<GitWorkbenchMutation["type"], "checkout.git.stash.create.request">,
) {
  switch (type) {
    case "checkout.git.stage.apply.request":
      return "checkout.git.stage.apply.response";
    case "checkout.git.unstage.apply.request":
      return "checkout.git.unstage.apply.response";
    case "checkout.git.discard.apply.request":
      return "checkout.git.discard.apply.response";
    case "checkout.git.commit.create.request":
      return "checkout.git.commit.create.response";
    case "checkout.git.stash.apply.request":
      return "checkout.git.stash.apply.response";
    case "checkout.git.stash.drop.request":
      return "checkout.git.stash.drop.response";
  }
}

function requiresAgentGuard(msg: GitWorkbenchMutation): boolean {
  return (
    msg.type === "checkout.git.discard.apply.request" ||
    (msg.type === "checkout.git.commit.create.request" && msg.amend === true) ||
    msg.type.startsWith("checkout.git.stash.")
  );
}

async function checkMutationPreconditions(
  msg: GitWorkbenchMutation,
  repo: GitWorktree,
  host: GitWorkbenchHost,
) {
  await assertGitWorktree(repo);
  if (requiresAgentGuard(msg) && !msg.forceWithRunningAgents) {
    const activeAgents = await host.listActiveAgents(repo.root);
    if (activeAgents.length > 0) {
      throw new GitWorkbenchError(
        "There are active agents in this worktree",
        "ACTIVE_AGENT_GUARD",
        { activeAgents },
      );
    }
  }
  const head = await readHead(repo);
  if (msg.expectedHeadSha !== undefined && msg.expectedHeadSha !== head) {
    throw new GitWorkbenchError("HEAD changed. Refresh and try again", "STALE_HEAD_CONFLICT", {
      actualHeadSha: head,
    });
  }
  const state = await operationState(repo);
  if (
    (msg.type === "checkout.git.commit.create.request" ||
      msg.type === "checkout.git.stash.create.request") &&
    state !== "idle"
  ) {
    throw new Error(`Finish the active Git operation (${state}) first`);
  }
  return { head, state };
}

const SELECTION_ACTIONS = {
  "checkout.git.stage.apply.request": "stage",
  "checkout.git.unstage.apply.request": "unstage",
  "checkout.git.discard.apply.request": "discard",
} as const;

async function mutateGitWorkbench(
  msg: GitWorkbenchMutation,
  repo: GitWorktree,
  host: GitWorkbenchHost,
  commitBaselines: GitCommitBaselines,
): Promise<GitWorkbenchResponse> {
  let backupRef: string | undefined;
  let attempted = false;
  const preserveBackup = (ref: string) => {
    backupRef = ref;
  };
  try {
    return await host.withDirectoryWrite(repo.root, () =>
      repoWriteMutex.run(repo, msg.type, async () => {
        const { head, state } = await checkMutationPreconditions(msg, repo, host);
        const base = {
          cwd: msg.cwd,
          repoRoot: repo.root,
          requestId: msg.requestId,
          success: true,
          error: null,
        };
        attempted = true;
        switch (msg.type) {
          case "checkout.git.stage.apply.request":
          case "checkout.git.unstage.apply.request":
          case "checkout.git.discard.apply.request": {
            await changeSelection(repo, head, SELECTION_ACTIONS[msg.type], msg, preserveBackup);
            return {
              type: mutationResponseType(msg.type),
              payload: { ...base, newHeadSha: head, operationState: state, backupRef },
            };
          }
          case "checkout.git.commit.create.request": {
            const baseline = commitBaselines.get(msg.requestId);
            if (
              !baseline ||
              baseline.cwd !== msg.cwd ||
              baseline.repoRoot !== repo.root ||
              baseline.head !== head
            ) {
              throw new GitWorkbenchError(
                "The commit must refer to the current working tree snapshot. Refresh and try again",
                "STALE_HEAD_CONFLICT",
                { actualHeadSha: head },
              );
            }
            const { result: newHeadSha, indexError } = await createStagedCommit({
              repo,
              head,
              ...msg,
              branchRef: baseline.branchRef,
              tree: baseline.tree,
              preserveBackup,
            });
            const pushError = msg.pushAfter
              ? await pushReviewedCommit({
                  repo,
                  newHeadSha,
                  branchRef: baseline.branchRef,
                  head,
                  tree: baseline.tree,
                  amend: msg.amend,
                })
              : null;
            return {
              type: "checkout.git.commit.create.response",
              payload: {
                ...base,
                error:
                  indexError ??
                  (newHeadSha
                    ? null
                    : "Commit created, but its SHA could not be verified. Refresh to review it"),
                newHeadSha,
                operationState: state,
                backupRef,
                pushError,
              },
            };
          }
          case "checkout.git.stash.create.request": {
            await createStash(repo, msg);
            return {
              type: "checkout.git.stash.create.response",
              // Git does not return the new stash SHA. The list may already
              // contain entries written by another process.
              payload: { ...base, newHeadSha: head, operationState: state, entry: null },
            };
          }
          case "checkout.git.stash.apply.request":
          case "checkout.git.stash.drop.request": {
            let action: "apply" | "pop" | "drop" = "apply";
            if (msg.type === "checkout.git.stash.drop.request") action = "drop";
            else if (msg.pop) action = "pop";
            const warning = await mutateStash({ repo, stashRef: msg.stashRef, action });
            return {
              type: mutationResponseType(msg.type),
              payload: {
                ...base,
                error: warning,
                newHeadSha: head,
                operationState: await operationState(repo),
                backupRef,
              },
            };
          }
        }
      }),
    );
  } catch (error) {
    if (!backupRef) throw error;
    const failure = serializeError(error);
    throw new GitWorkbenchError(failure.error, failure.errorCode, { backupRef });
  } finally {
    if (attempted) {
      await host
        .refresh(repo.root, msg.cwd, REFRESH_REASONS[msg.type])
        .catch((error: unknown) => host.reportBackgroundError(error, repo.root));
    }
    if (backupRef) {
      void repoWriteMutex
        .run(repo, "backup-retention", () => collectExpiredBackupRefs(repo))
        .catch((error: unknown) => host.reportBackgroundError(error, repo.root));
    }
  }
}

async function pushReviewedCommit(input: {
  repo: GitWorktree;
  newHeadSha: string | null;
  branchRef: string | null;
  head: string | null;
  tree: string;
  amend?: boolean;
}): Promise<string | null> {
  const { repo, newHeadSha, branchRef, head, tree, amend } = input;
  if (!newHeadSha) return "Could not identify the local commit. Review it before pushing";
  if (!branchRef) return "Unable to determine current branch for push";
  try {
    const commitFormat = [
      "--no-replace-objects",
      "show",
      "-s",
      "--no-notes",
      "--no-show-signature",
      "--format=%T%n%P",
    ];
    const { stdout } = await git(repo, [...commitFormat, newHeadSha]);
    const [actualTree, parents = ""] = stdout.trimEnd().split("\n");
    if (actualTree !== tree) return "The local commit differs from the reviewed staged changes";
    let expectedParents = head ?? "";
    if (amend && head) {
      const original = await git(repo, [...commitFormat, head]);
      expectedParents = original.stdout.trimEnd().split("\n")[1] ?? "";
    }
    if (parents !== expectedParents)
      return "The local commit has a different base. Review before pushing";
    await pushCurrentBranch(repo.root, undefined, { sha: newHeadSha, branchRef });
    return null;
  } catch (error) {
    return serializeError(error).error;
  }
}
