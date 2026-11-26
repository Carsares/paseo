import {
  collectAllPanes,
  FOCUSED_PANE_PLACEMENT,
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";

/** Directory and Main Control navigation reveal conversations in the workspace center. */
export function revealWorkspaceConversation(
  workspaceKey: string,
  agentId: string,
  lastMainPaneId: string | null,
): void {
  const store = useWorkspaceLayoutStore.getState();
  let explorerTabId: string | null = null;
  for (const tab of store.getWorkspaceTabs(workspaceKey)) {
    if (tab.target.kind !== "agent" || tab.target.agentId !== agentId) continue;
    const destination = store.getTabDestination(workspaceKey, tab.tabId);
    if (destination?.kind !== "pane") continue;
    if (destination.host === "main") {
      revealWorkspaceTab(workspaceKey, tab.tabId);
      return;
    }
    explorerTabId ??= tab.tabId;
  }

  const layout = store.layoutByWorkspace[workspaceKey];
  const explorerPaneId = selectExplorerSidebarPaneId(store, workspaceKey);
  const mainPanes = layout
    ? collectAllPanes(layout.root).filter((pane) => !pane.hidden && pane.id !== explorerPaneId)
    : [];
  const paneId =
    mainPanes.find((pane) => pane.id === layout?.focusedPaneId)?.id ??
    mainPanes.find((pane) => pane.id === lastMainPaneId)?.id ??
    mainPanes[0]?.id;

  if (explorerTabId && paneId) {
    store.moveTabToPane(workspaceKey, explorerTabId, paneId);
    revealWorkspaceTab(workspaceKey, explorerTabId);
    return;
  }

  const tabId = store.openTab({
    workspaceKey,
    target: { kind: "agent", agentId },
    intent: "reveal",
    placement: paneId ? { mode: "pane", paneId } : FOCUSED_PANE_PLACEMENT,
  });
  revealWorkspaceTab(workspaceKey, tabId);
}
