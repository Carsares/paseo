import type {
  SessionInboundMessage,
  SessionOutboundMessage,
  WorkbenchErrorCode,
} from "../messages.js";
import type { GitMutationRefreshReason } from "../../utils/checkout-git.js";
import { mutateBranch, type BranchMutationRequest } from "./branch-mutate.js";
import type { GitWorkbenchHost } from "./checkout-git-workbench.js";
import { inspectConflicts, resolveConflict } from "./conflict-inspect.js";
import {
  actOnControlledRebase,
  buildRebasePlan,
  executeControlledRebase,
} from "./controlled-rebase.js";
import {
  assertGitWorktree,
  GitWorkbenchError,
  type GitMutationDetails,
  operationState,
  readHead,
} from "./git-workbench-state.js";
import {
  enforceLogBudget,
  getCommitDetail,
  listGraphRefs,
  queryMultiRepoLog,
} from "./multi-repo-log.js";
import { discoverRepos, resolveP1Target } from "./repo-discovery.js";
import { collectExpiredBackupRefs } from "./repo-backup-refs.js";
import { RepoWriteLockTimeout, repoWriteMutex, type GitWorktree } from "./repo-write-mutex.js";

type Operation =
  | "repos.discover"
  | "refs.list"
  | "log.query"
  | "commit.get_detail"
  | "branch.mutate"
  | "rebase.build_plan"
  | "rebase.execute"
  | "rebase.act"
  | "conflict.inspect"
  | "conflict.resolve";
export type GitWorkbenchP1Request = Extract<
  SessionInboundMessage,
  { type: `checkout.git.${Operation}.request` }
>;
type GitWorkbenchP1Response = Extract<
  SessionOutboundMessage,
  { type: `checkout.git.${Operation}.response` }
>;
export type GitWorkbenchP1Host = Pick<
  GitWorkbenchHost,
  "withDirectoryWrite" | "listActiveAgents" | "refresh" | "reportBackgroundError"
>;

function serializeError(error: unknown): {
  error: string;
  lockOperation?: string;
} & GitMutationDetails & {
    errorCode?: WorkbenchErrorCode;
  } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof GitWorkbenchError)
    return { error: message, errorCode: error.code, ...error.details };
  if (error instanceof RepoWriteLockTimeout) {
    return {
      error: message,
      errorCode: "REPO_WRITE_LOCK_TIMEOUT" as const,
      lockOperation: error.lockOperation,
    };
  }
  return { error: message };
}

async function mutate<T>(
  repo: GitWorktree,
  input: GitWorkbenchP1Request,
  host: GitWorkbenchP1Host,
  work: () => Promise<T>,
  reason: GitMutationRefreshReason = "commit-changes",
): Promise<T> {
  let attempted = false;
  try {
    return await host.withDirectoryWrite(repo.root, () =>
      repoWriteMutex.run(repo, input.type, async () => {
        await assertGitWorktree(repo);
        attempted = true;
        return work();
      }),
    );
  } finally {
    if (attempted) {
      try {
        await host.refresh(repo.root, input.cwd, reason);
      } catch (error) {
        host.reportBackgroundError(error, input.cwd);
      }
    }
  }
}

const BRANCH_REFRESH = {
  create: "create-branch",
  checkout: "switch-branch",
  rename: "rename-branch",
  delete: "commit-changes",
} satisfies Record<BranchMutationRequest["action"], GitMutationRefreshReason>;

async function handleBranchMutation(
  repo: GitWorktree,
  input: BranchMutationRequest,
  host: GitWorkbenchP1Host,
) {
  const result = await mutate(
    repo,
    input,
    host,
    () => mutateBranch(repo, input, (root) => host.listActiveAgents(root)),
    BRANCH_REFRESH[input.action],
  );
  if (result.backupRef) {
    void repoWriteMutex
      .run(repo, "backup-retention", () => collectExpiredBackupRefs(repo))
      .catch((error: unknown) => host.reportBackgroundError(error, input.cwd));
  }
  return result;
}

// The checkout session owns permission checks, routing, and capability advertisement.
export async function handleGitWorkbenchP1Request(
  input: GitWorkbenchP1Request,
  host: GitWorkbenchP1Host,
): Promise<GitWorkbenchP1Response> {
  const base = { requestId: input.requestId, cwd: input.cwd, error: null };
  let repoRoot = "targetRepoRoot" in input ? (input.targetRepoRoot ?? input.cwd) : input.cwd;
  try {
    switch (input.type) {
      case "checkout.git.repos.discover.request": {
        const repos = await discoverRepos(input);
        const mode = repos.length === 1 ? "single" : "multi";
        return {
          type: "checkout.git.repos.discover.response",
          payload: {
            ...base,
            mode: repos.length ? mode : null,
            repos,
          },
        };
      }
      case "checkout.git.refs.list.request":
        return {
          type: "checkout.git.refs.list.response",
          payload: { ...base, refs: await listGraphRefs(input) },
        };
      case "checkout.git.log.query.request":
        return await queryMultiRepoLog(input);
    }

    const repo = await resolveP1Target(input.cwd, input.targetRepoRoot);
    repoRoot = repo.root;
    const target = { ...base, repoRoot };
    switch (input.type) {
      case "checkout.git.commit.get_detail.request":
        return {
          type: "checkout.git.commit.get_detail.response",
          payload: { ...target, detail: await getCommitDetail(repo, input.sha) },
        };
      case "checkout.git.branch.mutate.request":
        return {
          type: "checkout.git.branch.mutate.response",
          payload: { ...target, ...(await handleBranchMutation(repo, input, host)) },
        };
      case "checkout.git.rebase.build_plan.request":
        return {
          type: "checkout.git.rebase.build_plan.response",
          payload: { ...target, ...(await buildRebasePlan(repo, input)) },
        };
      case "checkout.git.rebase.execute.request":
        return {
          type: "checkout.git.rebase.execute.response",
          payload: {
            ...target,
            ...(await mutate(repo, input, host, () =>
              executeControlledRebase(repo, input, (root) => host.listActiveAgents(root)),
            )),
          },
        };
      case "checkout.git.rebase.act.request":
        return {
          type: "checkout.git.rebase.act.response",
          payload: {
            ...target,
            ...(await mutate(repo, input, host, () =>
              actOnControlledRebase(repo, input, (root) => host.listActiveAgents(root)),
            )),
          },
        };
      case "checkout.git.conflict.inspect.request": {
        const conflicts = await repoWriteMutex.run(repo, input.type, async () => {
          await assertGitWorktree(repo);
          return inspectConflicts(repo, input.path);
        });
        return {
          type: "checkout.git.conflict.inspect.response",
          payload: { ...target, conflicts },
        };
      }
      case "checkout.git.conflict.resolve.request": {
        const state = await mutate(repo, input, host, async () => {
          // Conflict resolution is an explicit edit, but must not race a writing agent.
          const activeAgents = await host.listActiveAgents(repo.root);
          if (activeAgents.length) {
            throw new GitWorkbenchError(
              "There are active agents in this worktree",
              "ACTIVE_AGENT_GUARD",
              { activeAgents },
            );
          }
          await resolveConflict(repo, input);
          return { newHeadSha: await readHead(repo), operationState: await operationState(repo) };
        });
        return {
          type: "checkout.git.conflict.resolve.response",
          payload: { ...target, ...state, success: true },
        };
      }
    }
  } catch (error) {
    return failureResponse(input, repoRoot, error);
  }
}

function failureResponse(
  input: GitWorkbenchP1Request,
  repoRoot: string,
  error: unknown,
): GitWorkbenchP1Response {
  const failure = { cwd: input.cwd, requestId: input.requestId, ...serializeError(error) };
  const target = { ...failure, repoRoot };
  const mutation = { ...target, success: false };
  switch (input.type) {
    case "checkout.git.repos.discover.request":
      return {
        type: "checkout.git.repos.discover.response",
        payload: { ...failure, mode: null, repos: [] },
      };
    case "checkout.git.refs.list.request":
      return { type: "checkout.git.refs.list.response", payload: { ...failure, refs: [] } };
    case "checkout.git.log.query.request": {
      const response = {
        type: "checkout.git.log.query.response" as const,
        payload: {
          ...failure,
          error: failure.error.slice(0, 2048),
          commits: [],
          nextCursor: null,
          hasMore: false,
          approxBytes: 0,
        },
      };
      try {
        return enforceLogBudget(response);
      } catch {
        // Retain the request ID for correlation even if an oversized cwd is unactionable.
        return enforceLogBudget({ ...response, payload: { ...response.payload, cwd: "" } });
      }
    }
    case "checkout.git.commit.get_detail.request":
      return {
        type: "checkout.git.commit.get_detail.response",
        payload: { ...target, detail: null },
      };
    case "checkout.git.branch.mutate.request":
      return { type: "checkout.git.branch.mutate.response", payload: mutation };
    case "checkout.git.rebase.build_plan.request":
      return {
        type: "checkout.git.rebase.build_plan.response",
        payload: { ...target, headSha: null, ontoSha: null, entries: [], isPushedRange: false },
      };
    case "checkout.git.rebase.execute.request":
      return {
        type: "checkout.git.rebase.execute.response",
        payload: { ...mutation, rebaseId: mutation.rebaseId ?? null },
      };
    case "checkout.git.rebase.act.request":
      return {
        type: "checkout.git.rebase.act.response",
        payload: { ...mutation, rebaseId: mutation.rebaseId ?? null },
      };
    case "checkout.git.conflict.inspect.request":
      return {
        type: "checkout.git.conflict.inspect.response",
        payload: { ...target, conflicts: [] },
      };
    case "checkout.git.conflict.resolve.request":
      return { type: "checkout.git.conflict.resolve.response", payload: mutation };
  }
}
