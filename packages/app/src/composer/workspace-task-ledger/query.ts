import type { QueryClient } from "@tanstack/react-query";
import type {
  WorkspaceTaskSummary,
  WorkspaceTasksUpdatedMessage,
} from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

const TASK_LEDGER_REFRESH_MS = 15_000;

export function workspaceTasksQueryPrefix(serverId: string, workspaceId: string) {
  return ["workspace-task-ledger", serverId, workspaceId] as const;
}

export function applyWorkspaceTasksUpdateToCache(
  queryClient: QueryClient,
  serverId: string,
  payload: WorkspaceTasksUpdatedMessage["payload"],
): void {
  const prefix = workspaceTasksQueryPrefix(serverId, payload.workspaceId);
  queryClient.setQueriesData<WorkspaceTaskSummary[]>({ queryKey: prefix }, () => payload.tasks);
  const clientGeneration = useSessionStore.getState().sessions[serverId]?.clientGeneration;
  queryClient.setQueryData<WorkspaceTaskSummary[]>([...prefix, clientGeneration], payload.tasks);
}

export function applySingleWorkspaceTaskToCache(
  queryClient: QueryClient,
  serverId: string,
  workspaceId: string,
  task: WorkspaceTaskSummary,
): void {
  const prefix = workspaceTasksQueryPrefix(serverId, workspaceId);
  queryClient.setQueriesData<WorkspaceTaskSummary[]>({ queryKey: prefix }, (previous) => {
    if (!previous) return [task];
    const index = previous.findIndex((existing) => existing.taskId === task.taskId);
    if (index < 0) return [...previous, task];
    const next = [...previous];
    next[index] = task;
    return next;
  });
}

export function useWorkspaceTasks(serverId: string, workspaceId: string, active: boolean) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  // COMPAT(workspaceButlerV1): added in v0.18.0, remove gate after 2027-06-01.
  const supportsButler = useHostFeature(serverId, "workspaceButlerV1");
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
      enabled && !supportsButler && current.state.status !== "error"
        ? TASK_LEDGER_REFRESH_MS
        : false,
    retry: false,
  });

  return { query, available };
}
