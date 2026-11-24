import { realpath } from "node:fs/promises";
import type { CheckoutGitActiveAgent } from "../messages.js";
import { findGitWorktree, isWithinDirectory } from "./repo-write-mutex.js";

interface RunningAgentSnapshot {
  id: string;
  cwd: string;
  lifecycle: CheckoutGitActiveAgent["status"];
  workspaceId?: string;
  config: { title?: string | null };
}

interface ActiveAgentSources {
  manager: {
    listAgents(): RunningAgentSnapshot[];
    getAgentBackgroundWorkSummary(id: string): { runningCount?: number } | null | undefined;
  };
  storage: {
    get(
      id: string,
    ): Promise<{ archivedAt?: string | null; title?: string | null; workspaceId?: string } | null>;
  };
}

export async function listActiveAgentsForRepo(
  input: ActiveAgentSources & {
    root: string;
  },
): Promise<CheckoutGitActiveAgent[]> {
  const candidates = await Promise.all(
    input.manager.listAgents().map(async (agent) => {
      if (agent.lifecycle === "closed") return null;
      const backgroundRunningCount =
        input.manager.getAgentBackgroundWorkSummary(agent.id)?.runningCount ?? 0;
      if (
        agent.lifecycle !== "running" &&
        agent.lifecycle !== "initializing" &&
        backgroundRunningCount === 0
      )
        return null;
      const cwd = await realpath(agent.cwd).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (cwd === null || !isWithinDirectory(input.root, cwd)) return null;
      if ((await findGitWorktree(cwd))?.root !== input.root) return null;
      const stored = await input.storage.get(agent.id);
      if (stored?.archivedAt) return null;
      return {
        agentId: agent.id,
        workspaceId: agent.workspaceId ?? stored?.workspaceId ?? null,
        title: stored?.title ?? agent.config.title ?? null,
        status: agent.lifecycle,
        backgroundRunningCount,
      } satisfies CheckoutGitActiveAgent;
    }),
  );
  return candidates.filter((agent) => agent !== null);
}
