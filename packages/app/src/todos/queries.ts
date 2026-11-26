import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  WorkspaceTodoDeleteRequest,
  WorkspaceTodoItem,
  WorkspaceTodoSetStatusRequest,
  WorkspaceTodoUpdatedMessage,
  WorkspaceTodoUpsertRequest,
} from "@getpaseo/protocol/messages";
import { useMemo } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchQueries, useFetchQuery } from "@/data/query";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useHostFeature, useHostFeatureMap } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import {
  applyWorkspaceTodoUpdate,
  compareWorkspaceTodos,
  isTodoOverdue,
  sortWorkspaceTodos,
  type HostedWorkspaceTodoItem,
} from "./model";

// COMPAT(workspaceTodos): added in v0.18.0, remove gate after 2027-06-01.
const FEATURE = "workspaceTodos";
const TODOS_STALE_MS = 30_000;

export function workspaceTodosQueryKey(serverId: string, workspaceId?: string) {
  return ["workspace-todos", serverId, workspaceId ?? null] as const;
}

function getOnlineTodosClient(serverId: string) {
  const snapshot = getHostRuntimeStore().getSnapshot(serverId);
  return snapshot?.connectionStatus === "online" ? snapshot.client : null;
}

function buildTodosQuery(serverId: string, enabled: boolean, workspaceId?: string) {
  return {
    queryKey: workspaceTodosQueryKey(serverId, workspaceId),
    dataShape: "value" as const,
    staleTimeMs: TODOS_STALE_MS,
    enabled,
    refetchOnWindowFocus: true,
    retry: false as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const client = getOnlineTodosClient(serverId);
      if (!client) throw new Error("Host is offline");
      signal.throwIfAborted();
      const response = await client.listWorkspaceTodos(
        workspaceId ? { workspaceId } : { statusFilter: "pending" },
      );
      signal.throwIfAborted();
      if (response.error) throw new Error(response.error);
      return response.items;
    },
  };
}

export function applyWorkspaceTodoUpdateToCache(
  queryClient: QueryClient,
  serverId: string,
  payload: WorkspaceTodoUpdatedMessage["payload"],
): void {
  const workspaceKey = workspaceTodosQueryKey(serverId, payload.workspaceId);
  const globalKey = workspaceTodosQueryKey(serverId);

  queryClient.setQueryData<WorkspaceTodoItem[]>(workspaceKey, (previous) => {
    if (!previous) return payload.item ? [payload.item] : undefined;
    return applyWorkspaceTodoUpdate(previous, payload);
  });

  queryClient.setQueryData<WorkspaceTodoItem[]>(globalKey, (previous) => {
    if (!previous) {
      return payload.item && payload.item.status === "pending" ? [payload.item] : undefined;
    }
    const updated = applyWorkspaceTodoUpdate(previous, payload);
    return updated.filter((entry) => entry.status === "pending");
  });
}

export function useWorkspaceTodos(serverId: string, workspaceId: string, activeOverride?: boolean) {
  const paneActive = useRetainedPanelActive();
  const appVisible = useAppVisible();
  const supported = useHostFeature(serverId, FEATURE);
  const serverIds = useMemo(() => [serverId], [serverId]);
  const online = useHostRuntimeConnectionStatuses(serverIds).get(serverId) === "online";
  const active = activeOverride ?? paneActive;
  const enabled = Boolean(workspaceId) && active && appVisible && supported && online;
  const result = useFetchQuery(buildTodosQuery(serverId, enabled, workspaceId));

  const sortedItems = useMemo(() => sortWorkspaceTodos(result.data ?? []), [result.data]);
  const counts = useMemo(() => {
    let pendingCount = 0;
    let overdueCount = 0;
    const now = Date.now();
    for (const item of sortedItems) {
      if (item.status !== "pending") continue;
      pendingCount += 1;
      if (isTodoOverdue(item, now)) overdueCount += 1;
    }
    return { pendingCount, overdueCount };
  }, [sortedItems]);

  return {
    items: sortedItems,
    pendingCount: counts.pendingCount,
    overdueCount: counts.overdueCount,
    isSupported: supported,
    online: supported && online,
    isLoading: result.isLoading,
    isError: result.isError,
    refetch: result.refetch,
  };
}

export function useGlobalTodos() {
  const hosts = useHosts();
  const paneActive = useRetainedPanelActive();
  const appVisible = useAppVisible();
  const active = paneActive && appVisible;
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const supported = useHostFeatureMap(serverIds, FEATURE);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const capableHosts = useMemo(
    () => hosts.filter(({ serverId }) => supported.get(serverId)),
    [hosts, supported],
  );
  const results = useFetchQueries<WorkspaceTodoItem[]>(
    capableHosts.map(({ serverId }) =>
      buildTodosQuery(serverId, active && statuses.get(serverId) === "online"),
    ),
  );

  const items = useMemo<HostedWorkspaceTodoItem[]>(() => {
    const collected: HostedWorkspaceTodoItem[] = [];
    for (let index = 0; index < capableHosts.length; index += 1) {
      const host = capableHosts[index]!;
      const rows = results[index]?.data ?? [];
      for (const item of rows) {
        if (item.status === "pending") {
          collected.push({ serverId: host.serverId, item });
        }
      }
    }
    const now = Date.now();
    return collected.sort((left, right) => compareWorkspaceTodos(left.item, right.item, now));
  }, [capableHosts, results]);

  const labels = useMemo(
    () => new Map(capableHosts.map(({ serverId, label }) => [serverId, label] as const)),
    [capableHosts],
  );

  return {
    items,
    labels,
    anySupported: capableHosts.length > 0,
    isLoading: results.some((result) => result.isLoading),
  };
}

export function useUpsertWorkspaceTodo(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<WorkspaceTodoUpsertRequest, "type" | "requestId">) => {
      const client = getOnlineTodosClient(serverId);
      if (!client) throw new Error("Host is offline");
      const response = await client.upsertWorkspaceTodo(input);
      if (response.error || !response.item) {
        throw new Error(response.error ?? "Failed to save todo");
      }
      return response.item;
    },
    onSuccess: (item) => {
      applyWorkspaceTodoUpdateToCache(queryClient, serverId, {
        workspaceId: item.workspaceId,
        item,
      });
    },
  });
}

export function useSetWorkspaceTodoStatus(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<WorkspaceTodoSetStatusRequest, "type" | "requestId">) => {
      const client = getOnlineTodosClient(serverId);
      if (!client) throw new Error("Host is offline");
      const response = await client.setWorkspaceTodoStatus(input);
      if (response.error || !response.item) {
        throw new Error(response.error ?? "Failed to update todo status");
      }
      return response.item;
    },
    onSuccess: (item) => {
      applyWorkspaceTodoUpdateToCache(queryClient, serverId, {
        workspaceId: item.workspaceId,
        item,
      });
    },
  });
}

export function useDeleteWorkspaceTodo(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<WorkspaceTodoDeleteRequest, "type" | "requestId">) => {
      const client = getOnlineTodosClient(serverId);
      if (!client) throw new Error("Host is offline");
      const response = await client.deleteWorkspaceTodo(input);
      if (response.error || !response.deleted) {
        throw new Error(response.error ?? "Failed to delete todo");
      }
      return { workspaceId: input.workspaceId, todoId: response.todoId };
    },
    onSuccess: ({ workspaceId, todoId }) => {
      applyWorkspaceTodoUpdateToCache(queryClient, serverId, {
        workspaceId,
        item: null,
        deletedTodoId: todoId,
      });
    },
  });
}
