import { isMainControlAgentLabels } from "@getpaseo/protocol/agent-labels";
import type { ManagedAgent } from "./agent/agent-manager.js";
import type { CheckpointScope, CheckpointWorktreeOptions } from "./agent/checkpoints/worktree.js";
import type { ProjectRegistry, WorkspaceRegistry } from "./workspace-registry.js";
import { isRealpathInsideRoot } from "../utils/path.js";

export interface AgentRewindDirectories extends CheckpointWorktreeOptions {
  projects: Pick<ProjectRegistry, "get">;
  workspaces: Pick<WorkspaceRegistry, "get" | "listActive">;
  isWorkspaceArchiving?: (workspaceId: string) => boolean;
  hasActiveTerminal?: (cwd: string) => Promise<boolean>;
}

export type AgentRewindSubject = Pick<
  ManagedAgent,
  "id" | "cwd" | "workspaceId" | "labels" | "internal"
>;

export function rewindDirectoriesOverlap(left: string, right: string): boolean {
  return isRealpathInsideRoot(left, right) || isRealpathInsideRoot(right, left);
}

interface DirectoryActivity {
  rewinds: Set<string>;
  writers: Map<string, number>;
}
const activityByManager = new WeakMap<object, DirectoryActivity>();

export function rewindDirectoryActivity(manager: object): DirectoryActivity {
  let activity = activityByManager.get(manager);
  if (!activity) {
    activity = { rewinds: new Set(), writers: new Map() };
    activityByManager.set(manager, activity);
  }
  return activity;
}

export function assertNoFileRewind(manager: object, cwd: string): void {
  if (
    [...rewindDirectoryActivity(manager).rewinds].some((root) =>
      rewindDirectoriesOverlap(root, cwd),
    )
  ) {
    throw new Error("A file rewind is active in this directory");
  }
}

export async function runRewindDirectoryWriter<T>(
  manager: object,
  cwd: string,
  write: () => Promise<T>,
): Promise<T> {
  assertNoFileRewind(manager, cwd);
  const { writers } = rewindDirectoryActivity(manager);
  writers.set(cwd, (writers.get(cwd) ?? 0) + 1);
  try {
    return await write();
  } finally {
    const remainder = (writers.get(cwd) ?? 1) - 1;
    if (remainder) writers.set(cwd, remainder);
    else writers.delete(cwd);
  }
}

type AgentRewindScopeResult =
  | { kind: "eligible"; scope: CheckpointScope }
  | { kind: "not_applicable"; reason: string };

const WORKTREE_REQUIRED = "File rewind requires a trusted, exclusive Paseo worktree";

export async function resolveAgentRewindScope(
  directories: AgentRewindDirectories,
  agent: AgentRewindSubject,
): Promise<AgentRewindScopeResult> {
  const { workspaceId, cwd } = agent;
  if (!workspaceId || agent.internal || isMainControlAgentLabels(agent.labels)) {
    return { kind: "not_applicable", reason: "This agent cannot restore files" };
  }

  const workspace = await directories.workspaces.get(workspaceId);
  if (!workspace || workspace.archivedAt || directories.isWorkspaceArchiving?.(workspaceId)) {
    throw new Error(WORKTREE_REQUIRED);
  }
  if (workspace.kind !== "worktree") {
    return { kind: "not_applicable", reason: WORKTREE_REQUIRED };
  }
  if (workspace.cwd !== cwd || workspace.worktreeRoot !== cwd) {
    throw new Error(WORKTREE_REQUIRED);
  }
  if (!workspace.isPaseoOwnedWorktree || workspace.untrustedSource) {
    return { kind: "not_applicable", reason: WORKTREE_REQUIRED };
  }
  const project = await directories.projects.get(workspace.projectId);
  if (!project || project.archivedAt) throw new Error(WORKTREE_REQUIRED);
  if (project.kind !== "git") return { kind: "not_applicable", reason: WORKTREE_REQUIRED };

  if (
    (await directories.workspaces.listActive()).some(
      (candidate) =>
        candidate.workspaceId !== workspaceId &&
        rewindDirectoriesOverlap(cwd, candidate.worktreeRoot ?? candidate.cwd),
    )
  ) {
    throw new Error(WORKTREE_REQUIRED);
  }
  return {
    kind: "eligible",
    scope: {
      workspaceId,
      agentId: agent.id,
      cwd,
      worktreeRoot: workspace.worktreeRoot,
      projectRoot: workspace.mainRepoRoot ?? project.rootPath,
      exclusive: true,
      isController: false,
    },
  };
}

export async function getAgentRewindScope(
  directories: AgentRewindDirectories,
  agent: AgentRewindSubject,
): Promise<CheckpointScope> {
  const result = await resolveAgentRewindScope(directories, agent);
  if (result.kind === "not_applicable") throw new Error(result.reason);
  return result.scope;
}
