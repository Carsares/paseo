import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  CheckoutGitRepo,
  WorkspaceDescriptorPayload,
  WorkspaceTopic,
} from "@getpaseo/protocol/messages";
import type { TeamDirectorySummary } from "@/subagents/team-directory";

export const DURABLE_ITEMS_PAGE_SIZE = 50;

export type TopicHeaderDurableLoadState = "disabled" | "loading" | "ready" | "error";

export interface TopicHeaderDurableItemsState {
  status: TopicHeaderDurableLoadState;
  pendingCount: number;
}

export type TopicHeaderGitStatus =
  | {
      kind: "rebase_conflict";
      conflictCount: number;
      conflictRepoRoot: string | null;
      branchLabel: string | null;
      canOpenGraph: boolean;
    }
  | {
      kind: "multi_repo";
      repoCount: number;
      branchLabel: string | null;
      canOpenGraph: boolean;
    }
  | { kind: "branch"; branchName: string; canOpenGraph: boolean }
  | { kind: "detached"; canOpenGraph: boolean }
  | { kind: "directory"; directoryName: string; canOpenGraph: false };

export interface TopicHeaderEnvStatus {
  kind: "running" | "failed" | "blocked" | "checking" | "ready";
  canOpenSetup: boolean;
}

export interface TopicHeaderTeamStatus {
  kind: "unbound" | "quiet" | "running" | "idle";
  runningCount: number;
  activeCount: number;
}

export interface TopicHeaderActionStatus {
  pendingCount: number;
  durableLoadState: TopicHeaderDurableLoadState;
  firstAttentionAgentId: string | null;
}

export interface TopicHeaderModel {
  directionSummary: string | null;
  hideFromModel: boolean;
  git: TopicHeaderGitStatus;
  env: TopicHeaderEnvStatus;
  team: TopicHeaderTeamStatus;
  action: TopicHeaderActionStatus;
}

/**
 * Paginate through every pending durable item page for a workspace so the header count
 * never truncates at page 1 (e.g. >50 items) and surfaces errors instead of reporting 0.
 */
export async function fetchAllPendingDurableItemCount(
  client: Pick<DaemonClient, "listWorkspaceDurableItems">,
  workspaceId: string,
  signal?: Pick<AbortSignal, "aborted">,
): Promise<number> {
  const seenItemIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    checkPendingCountAborted(signal);
    const result = await client.listWorkspaceDurableItems({
      workspaceId,
      statusFilter: "pending",
      limit: DURABLE_ITEMS_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    checkPendingCountAborted(signal);
    if (result.error) {
      throw new Error(result.error);
    }
    for (const item of result.items ?? []) {
      seenItemIds.add(item.requestId);
    }
    const nextCursor = result.nextCursor?.trim() || null;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return seenItemIds.size;
}

function checkPendingCountAborted(signal?: Pick<AbortSignal, "aborted">) {
  if (signal?.aborted) {
    const error = new Error("Pending durable item count was cancelled");
    error.name = "AbortError";
    throw error;
  }
}

function directoryBasename(path: string | null | undefined): string {
  if (!path) return "";
  const normalized = path.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/);
  return segments[segments.length - 1] ?? normalized;
}

export function deriveTopicHeaderGitStatus(input: {
  workspaceDirectory: string | null;
  isGitCheckout: boolean;
  currentBranchName: string | null;
  discoveredRepos: readonly CheckoutGitRepo[];
  supportsGitGraph: boolean;
}): TopicHeaderGitStatus {
  const conflictRepos = input.discoveredRepos.filter(
    (repo) => repo.operationState === "rebase_paused",
  );
  const canOpenGraph =
    input.supportsGitGraph && (input.isGitCheckout || input.discoveredRepos.length > 0);
  if (conflictRepos.length > 0) {
    return {
      kind: "rebase_conflict",
      conflictCount: conflictRepos.length,
      conflictRepoRoot: conflictRepos[0]?.repoRoot ?? null,
      branchLabel: conflictRepos[0]?.currentBranch ?? input.currentBranchName,
      canOpenGraph,
    };
  }
  if (input.discoveredRepos.length > 1) {
    return {
      kind: "multi_repo",
      repoCount: input.discoveredRepos.length,
      branchLabel: input.currentBranchName ?? input.discoveredRepos[0]?.currentBranch ?? null,
      canOpenGraph,
    };
  }
  if (input.isGitCheckout || input.discoveredRepos.length === 1) {
    const branch = input.currentBranchName ?? input.discoveredRepos[0]?.currentBranch ?? null;
    return branch && branch !== "HEAD"
      ? { kind: "branch", branchName: branch, canOpenGraph }
      : { kind: "detached", canOpenGraph };
  }
  return {
    kind: "directory",
    directoryName: directoryBasename(input.workspaceDirectory),
    canOpenGraph: false,
  };
}

function deriveTopicHeaderEnvStatus(input: {
  setupStatus: WorkspaceDescriptorPayload["setupStatus"];
  showWorkspaceSetup: boolean;
  isCheckoutStatusLoading: boolean;
}): TopicHeaderEnvStatus {
  let kind: TopicHeaderEnvStatus["kind"] = "ready";
  if (input.setupStatus === "running") {
    kind = "running";
  } else if (input.setupStatus === "failed") {
    kind = "failed";
  } else if (input.setupStatus === "blocked") {
    kind = "blocked";
  } else if (input.setupStatus === null && input.isCheckoutStatusLoading) {
    kind = "checking";
  }
  return { kind, canOpenSetup: input.showWorkspaceSetup };
}

function deriveTopicHeaderTeamStatus(teamSummary: TeamDirectorySummary): TopicHeaderTeamStatus {
  let kind: TopicHeaderTeamStatus["kind"];
  if (!teamSummary.hasMain) {
    kind = "unbound";
  } else if (teamSummary.runningCount > 0) {
    kind = "running";
  } else if (teamSummary.isMainSilent && teamSummary.activeCount <= 1) {
    kind = "quiet";
  } else {
    kind = "idle";
  }
  return {
    kind,
    runningCount: teamSummary.runningCount,
    activeCount: teamSummary.activeCount,
  };
}

export function deriveTopicHeaderModel(input: {
  topic: WorkspaceTopic | null | undefined;
  workspaceDirectory: string | null;
  isGitCheckout: boolean;
  currentBranchName: string | null;
  discoveredRepos: readonly CheckoutGitRepo[];
  supportsGitGraph: boolean;
  setupStatus: WorkspaceDescriptorPayload["setupStatus"];
  showWorkspaceSetup: boolean;
  isCheckoutStatusLoading: boolean;
  teamSummary: TeamDirectorySummary;
  durableItems: TopicHeaderDurableItemsState;
}): TopicHeaderModel {
  const durablePendingCount =
    input.durableItems.status === "ready" ? Math.max(0, input.durableItems.pendingCount) : 0;

  return {
    directionSummary: input.topic?.summary?.trim() || null,
    hideFromModel: input.topic?.hideFromModel === true,
    git: deriveTopicHeaderGitStatus(input),
    env: deriveTopicHeaderEnvStatus(input),
    team: deriveTopicHeaderTeamStatus(input.teamSummary),
    action: {
      pendingCount: input.teamSummary.needsInputCount + durablePendingCount,
      durableLoadState: input.durableItems.status,
      firstAttentionAgentId: input.teamSummary.firstNeedsInputAgentId,
    },
  };
}
