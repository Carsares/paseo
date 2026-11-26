import { useEffect, useMemo, useRef } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type {
  WorkspaceDurableItem,
  WorkspaceDurableItemUpdatedMessage,
} from "@getpaseo/protocol/messages";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchQueries, useFetchQuery } from "@/data/query";
import { useAppActivelyVisible, useAppVisible } from "@/hooks/use-app-visible";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useHostFeatureMap } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { applyDurableItemRevision, listDurableItems, selectPendingDurableItems } from "./model";

const HOST_REFRESH_MS = 15_000;
// COMPAT(workspaceDurableItemsV1): added in v0.18.0, remove after 2027-06-01 once daemon floor >= v0.18.0.
const FEATURE = "workspaceDurableItemsV1";
// COMPAT(workspaceButlerV1): added in v0.18.0, remove gate after 2027-06-01.
const BUTLER_FEATURE = "workspaceButlerV1";

export function durableItemsQueryKey(serverId: string, workspaceId?: string) {
  return ["durable-items", serverId, workspaceId ?? null] as const;
}

export function getOnlineDurableItemsClient(serverId: string) {
  const snapshot = getHostRuntimeStore().getSnapshot(serverId);
  return snapshot?.connectionStatus === "online" ? snapshot.client : null;
}

export function applyDurableItemUpdateToCache(
  queryClient: QueryClient,
  serverId: string,
  payload: WorkspaceDurableItemUpdatedMessage["payload"],
): void {
  const keys = [
    durableItemsQueryKey(serverId),
    durableItemsQueryKey(serverId, payload.workspaceId),
  ];
  keys.forEach((key, index) => {
    queryClient.setQueryData<WorkspaceDurableItem[]>(key, (previous) =>
      previous ? applyDurableItemRevision(previous, payload.item, index === 0) : undefined,
    );
  });
  void queryClient.invalidateQueries({
    queryKey: ["topic-header-durable-items", serverId, payload.workspaceId],
  });
}

function query(serverId: string, enabled: boolean, workspaceId?: string, supportsPush = false) {
  return {
    queryKey: durableItemsQueryKey(serverId, workspaceId),
    dataShape: "value" as const,
    staleTimeMs: 0,
    enabled,
    // Legacy daemons lack durable-item push events; disable polling when workspaceButlerV1 pushes updates.
    refetchInterval: enabled && !supportsPush ? HOST_REFRESH_MS : (false as const),
    refetchOnWindowFocus: true,
    retry: false as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      const client = getOnlineDurableItemsClient(serverId);
      if (!client) throw new Error("Host is offline");
      return listDurableItems(
        client,
        workspaceId ? { workspaceId } : { pendingOnly: true },
        signal,
      );
    },
  };
}

function useRefreshOnFocus(active: boolean, refresh: () => void) {
  const appFocused = useAppActivelyVisible();
  const focused = active && appFocused;
  const wasFocused = useRef(focused);
  const refreshOnFocus = useStableEvent(refresh);
  useEffect(() => {
    if (focused && !wasFocused.current) refreshOnFocus();
    wasFocused.current = focused;
  }, [focused, refreshOnFocus]);
}

export function useGlobalDurableItems() {
  const hosts = useHosts();
  const paneActive = useRetainedPanelActive();
  const appVisible = useAppVisible();
  const active = paneActive && appVisible;
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const supported = useHostFeatureMap(serverIds, FEATURE);
  const butlerSupported = useHostFeatureMap(serverIds, BUTLER_FEATURE);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const capableHosts = hosts.filter(({ serverId }) => supported.get(serverId));
  const results = useFetchQueries<WorkspaceDurableItem[]>(
    capableHosts.map(({ serverId }) =>
      query(
        serverId,
        active && statuses.get(serverId) === "online",
        undefined,
        butlerSupported.get(serverId) === true,
      ),
    ),
  );
  const available = capableHosts.map(({ serverId, label }, index) => ({
    serverId,
    label,
    online: statuses.get(serverId) === "online",
    result: results[index],
    items: results[index]?.data ?? [],
  }));
  useRefreshOnFocus(active, () => {
    for (const { online, result } of available) {
      if (online) void result?.refetch({ cancelRefetch: false });
    }
  });

  return {
    items: selectPendingDurableItems(available),
    labels: new Map(available.map(({ serverId, label }) => [serverId, label])),
    incomplete: available.some(({ online, result }) => !online || !result?.isSuccess),
    checking: available.some(({ online, result }) => online && result?.isLoading),
    refresh: () => {
      for (const { online, result } of available)
        if (online && result?.isError) void result.refetch();
    },
    canRefresh: available.some(({ online, result }) => online && result?.isError),
  };
}

export function useWorkspaceDurableItems(
  serverId: string,
  workspaceId: string,
  paneFocused = true,
) {
  const paneActive = useRetainedPanelActive();
  const appVisible = useAppVisible();
  const serverIds = useMemo(() => [serverId], [serverId]);
  const supported = useHostFeatureMap(serverIds, FEATURE).get(serverId) === true;
  const butlerSupported = useHostFeatureMap(serverIds, BUTLER_FEATURE).get(serverId) === true;
  const online = useHostRuntimeConnectionStatuses(serverIds).get(serverId) === "online";
  const enabled = paneActive && appVisible && supported && online;
  const result = useFetchQuery(query(serverId, enabled, workspaceId, butlerSupported));
  useRefreshOnFocus(enabled && paneFocused, () => {
    void result.refetch({ cancelRefetch: false });
  });
  return { result, online: supported && online };
}

export async function reconcileDurableItemDecision(
  queryClient: QueryClient,
  serverId: string,
  workspaceId: string,
  item: WorkspaceDurableItem | null,
): Promise<void> {
  const keys = [durableItemsQueryKey(serverId), durableItemsQueryKey(serverId, workspaceId)];
  if (item) {
    // An already running list may have started before the decision. Drop it before applying the
    // authoritative revision so it cannot put a resolved item back in the sidebar.
    await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey, exact: true })));
    keys.forEach((key, index) => {
      queryClient.setQueryData<WorkspaceDurableItem[]>(key, (previous) =>
        previous ? applyDurableItemRevision(previous, item, index === 0) : undefined,
      );
    });
  }
  await Promise.all([
    ...keys.map((queryKey) => queryClient.invalidateQueries({ queryKey, exact: true })),
    queryClient.invalidateQueries({
      queryKey: ["topic-header-durable-items", serverId, workspaceId],
    }),
  ]);
}
