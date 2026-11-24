import { useFetchQuery } from "@/data/query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export function useRebaseWorkingTree({
  client,
  cwd,
  repoRoot,
  serverId,
  enabled,
  revision,
}: {
  client: DaemonClient;
  cwd: string;
  repoRoot: string | undefined;
  serverId: string;
  enabled: boolean;
  revision: number;
}) {
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey: ["git-rebase-tree", serverId, cwd, repoRoot, revision],
    enabled: enabled && !!repoRoot,
    queryFn: async () => {
      if (!repoRoot) return null;
      const result = await client.checkoutGitWorkingTreeGet({ cwd, targetRepoRoot: repoRoot });
      if (result.error) throw new Error(result.error);
      return result.workingTree;
    },
    retry: false,
  });
}

export type RebaseWorkingTree = ReturnType<typeof useRebaseWorkingTree>;

export async function refreshVisibleConflict(
  active: { current: boolean },
  readTree: (() => Promise<unknown>) | undefined,
  readConflict: () => Promise<unknown>,
) {
  if (!active.current) return;
  if (readTree) await readTree();
  if (active.current) await readConflict();
}
