import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

const TASK_LEDGER_REFRESH_MS = 15_000;

export function useWorkspaceTasks(serverId: string, workspaceId: string, active: boolean) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const clientGeneration = useSessionStore((state) => state.sessions[serverId]?.clientGeneration);
  const available = connected && client !== null;
  const enabled = active && available;
  const query = useFetchQuery({
    queryKey: ["workspace-task-ledger", serverId, workspaceId, clientGeneration],
    // Keep cached data for this workspace, without showing another workspace during a switch.
    dataShape: "value",
    enabled,
    queryFn: async ({ signal }) => {
      if (!client || !enabled) throw new Error("Workspace task ledger is unavailable");
      signal.throwIfAborted();
      const tasks = await client.listWorkspaceTasks(workspaceId);
      signal.throwIfAborted();
      return tasks;
    },
    staleTimeMs: TASK_LEDGER_REFRESH_MS,
    refetchOnMount: true,
    refetchInterval: (current) =>
      enabled && current.state.status !== "error" ? TASK_LEDGER_REFRESH_MS : false,
    retry: false,
  });

  return { query, available };
}
