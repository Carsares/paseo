import { useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { shallow } from "zustand/shallow";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { workspaceDeferralKind, type WorkspaceDeferralKind } from "./model";

export interface DeferredWorkspaceRow {
  serverId: string;
  hostLabel: string;
  workspace: WorkspaceDescriptor;
  kind: WorkspaceDeferralKind;
}

export function useDeferredWorkspaceRows(): DeferredWorkspaceRow[] {
  const hosts = useHosts();
  const selectMaps = useMemo(
    () => (state: ReturnType<typeof useSessionStore.getState>) =>
      hosts.map(({ serverId }) => state.sessions[serverId]?.workspaces),
    [hosts],
  );
  const maps = useStoreWithEqualityFn(useSessionStore, selectMaps, shallow);
  return useMemo(() => {
    const rows: DeferredWorkspaceRow[] = [];
    hosts.forEach(({ serverId, label }, index) => {
      for (const workspace of maps[index]?.values() ?? []) {
        const kind = workspaceDeferralKind(workspace);
        if (!kind || workspace.archivingAt) continue;
        rows.push({ serverId, hostLabel: label, workspace, kind });
      }
    });
    return rows.sort((a, b) =>
      (a.workspace.title ?? a.workspace.name).localeCompare(b.workspace.title ?? b.workspace.name),
    );
  }, [hosts, maps]);
}
