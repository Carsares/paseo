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

export async function getAgentRewindScope(
  directories: AgentRewindDirectories,
  agent: AgentRewindSubject,
): Promise<CheckpointScope> {
  const { workspaceId, cwd } = agent;
  if (!workspaceId || agent.internal || isMainControlAgentLabels(agent.labels)) {
    throw new Error("This agent cannot restore files");
  }

  const workspace = await directories.workspaces.get(workspaceId);
  if (
    !workspace ||
    workspace.archivedAt ||
    directories.isWorkspaceArchiving?.(workspaceId) ||
    workspace.kind !== "worktree" ||
    !workspace.isPaseoOwnedWorktree ||
    workspace.untrustedSource ||
    workspace.cwd !== cwd ||
    workspace.worktreeRoot !== cwd
  ) {
    throw new Error("File rewind requires a trusted, exclusive Paseo worktree");
  }
  const [project, activeWorkspaces] = await Promise.all([
    directories.projects.get(workspace.projectId),
    directories.workspaces.listActive(),
  ]);
  if (
    !project ||
    project.archivedAt ||
    project.kind !== "git" ||
    activeWorkspaces.some(
      (candidate) =>
        candidate.workspaceId !== workspaceId &&
        rewindDirectoriesOverlap(cwd, candidate.worktreeRoot ?? candidate.cwd),
    )
  ) {
    throw new Error("File rewind requires a trusted, exclusive Paseo worktree");
  }
  return {
    workspaceId,
    agentId: agent.id,
    cwd,
    worktreeRoot: workspace.worktreeRoot,
    projectRoot: workspace.mainRepoRoot ?? project.rootPath,
    exclusive: true,
    isController: false,
  };
}
