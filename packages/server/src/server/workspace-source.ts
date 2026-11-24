import { expandTilde } from "../utils/path.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { resolveFixedWorktreeStartPoint } from "../utils/worktree.js";
import { resolveWorktreeBaseBranch } from "./resolve-worktree-creation-intent.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { ProjectRegistry } from "./workspace-registry.js";

export interface WorktreeWorkspaceSource {
  cwd?: string;
  projectId?: string;
}

export async function resolveWorktreeSourceCwd(
  source: WorktreeWorkspaceSource,
  projectRegistry: Pick<ProjectRegistry, "get">,
): Promise<string> {
  if (source.cwd) {
    return expandTilde(source.cwd);
  }
  if (!source.projectId) {
    throw new Error("cwd or projectId is required for a worktree-backed workspace");
  }

  const project = await projectRegistry.get(source.projectId);
  if (!project || project.archivedAt) {
    throw new Error(`Project not found: ${source.projectId}`);
  }
  return project.rootPath;
}

export async function resolveWorkspaceWorktreeStartPoint(
  source: WorktreeWorkspaceSource & { refName?: string },
  projectRegistry: Pick<ProjectRegistry, "get">,
  workspaceGitService: Pick<WorkspaceGitService, "resolveDefaultBranch">,
): Promise<{ commitSha: string; refName: string }> {
  const cwd = await resolveWorktreeSourceCwd(source, projectRegistry);
  // Branch refs are shared by linked worktrees. Reading the checkout root suffices and
  // keeps this request out of Git status and workspace observation.
  const { stdout } = await runGitCommand(["rev-parse", "--show-toplevel"], { cwd });
  const repoRoot = stdout.replace(/\r?\n$/, "");
  const refName = await resolveWorktreeBaseBranch(source.refName, () =>
    workspaceGitService.resolveDefaultBranch(repoRoot),
  );
  const { commitSha, baseRef } = await resolveFixedWorktreeStartPoint(repoRoot, refName);
  return { commitSha, refName: baseRef };
}
