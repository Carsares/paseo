import { ChevronDown, ChevronRight, PanelLeft, PanelLeftClose, Plus } from "lucide-react-native";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { useStreamTopOverlayInset } from "@/agent-stream/top-overlay";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePendingArchiveAgentKeys } from "@/hooks/use-archive-agent";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { useSettings } from "@/hooks/use-settings";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import { useCreateResidentAction } from "../resident-dialog";
import { useTeamDirectoryShell } from "../team-directory/shell-context";
import {
  mainControlTreeNodeKey,
  type MainControlSession,
  type MainControlTreeNode,
  type MainControlWorkspaceSections,
  selectMainControlWorkspaceSections,
} from "./select-tree";
import { useWorkspaceArchivedAgents } from "./use-workspace-archived-agents";

const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const DownIcon = withUnistyles(ChevronDown, iconColor);
const RightIcon = withUnistyles(ChevronRight, iconColor);
const ShowIcon = withUnistyles(PanelLeft, iconColor);
const HideIcon = withUnistyles(PanelLeftClose, iconColor);
const PlusIcon = withUnistyles(Plus, iconColor);

export function MainControlTreeLayout({
  mainAgentId,
  children,
}: {
  mainAgentId: string | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const teamDirectoryShell = useTeamDirectoryShell();
  const { serverId, workspaceId, tabId } = usePaneContext();
  const { focusPane } = usePaneFocus();
  const isCompact = useIsCompactFormFactor();
  const topOverlayInset = useStreamTopOverlayInset();
  const { isBelow, onLayout } = useContainerWidthBelow(560, { initialIsBelow: false });
  const overlay = isCompact || isBelow;
  const [wideVisible, setWideVisible] = useState(true);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const scopeKey = `${serverId}\0${workspaceId}`;
  const [closedState, setClosedState] = useState<{ scopeKey: string; expanded: boolean }>({
    scopeKey,
    expanded: false,
  });
  const closedExpanded = closedState.scopeKey === scopeKey && closedState.expanded;
  const visible = overlay ? overlayVisible : wideVisible;
  const setVisible = overlay ? setOverlayVisible : setWideVisible;
  const hideTree = useCallback(() => setVisible(false), [setVisible]);
  const showTree = useCallback(() => setVisible(true), [setVisible]);
  const toggleClosed = useCallback(() => {
    setClosedState((current) => ({
      scopeKey,
      expanded: current.scopeKey === scopeKey ? !current.expanded : true,
    }));
  }, [scopeKey]);
  const preferences = useSettings((settings) => settings.openInSidePane);
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });

  const ownedByShell = teamDirectoryShell.isOwnedByWorkspaceShell;
  const {
    sections,
    supportsWorkspaceHistory,
    hasMoreArchive,
    isLoadingArchive,
    isLoadingMoreArchive,
    archiveError,
    loadMoreArchive,
    retryArchive,
  } = useMainControlDirectoryData({
    mainAgentId: ownedByShell ? null : mainAgentId,
    serverId,
    workspaceId,
    workspaceKey,
    historyExpanded: closedExpanded,
  });
  const createResident = useCreateResidentAction(serverId, ownedByShell ? null : mainAgentId);

  const openNode = useCallback(
    ({ serverId: nodeServerId, agentId, isArchived, processState }: MainControlTreeNode) => {
      if (overlay) setOverlayVisible(false);
      if (nodeServerId === serverId && agentId === mainAgentId) {
        focusPane();
        return;
      }

      const agent = useSessionStore.getState().sessions[nodeServerId]?.agents.get(agentId);
      if (agent ? Boolean(agent.archivedAt) : isArchived) {
        navigateToAgent({
          serverId: nodeServerId,
          workspaceId: nodeServerId === serverId ? workspaceId : undefined,
          agentId,
          pin: true,
          asTab: true,
        });
        return;
      }
      if (nodeServerId !== serverId || (agent?.workspaceId && agent.workspaceId !== workspaceId)) {
        navigateToAgent({ serverId: nodeServerId, agentId, asTab: processState === "closed" });
        return;
      }
      if (
        processState === "closed" &&
        useWorkspaceLayoutStore.getState().layoutMode === "compact"
      ) {
        navigateToAgent({ serverId, workspaceId, agentId, asTab: true });
        return;
      }
      openPreferredWorkspaceTarget({
        workspaceKey,
        target: { kind: "agent", agentId },
        source: "subagents",
        preferences,
        parentTabId: tabId,
      });
    },
    [focusPane, mainAgentId, overlay, preferences, serverId, tabId, workspaceId, workspaceKey],
  );

  // When WorkspaceScreen mounts the workspace-shell-level Team Directory (Zone 3),
  // avoid rendering a duplicate per-agent directory sidebar.
  if (ownedByShell) {
    return children;
  }

  const showLabel = t("topicWorkbench.directory.show");
  const hideLabel = t("topicWorkbench.directory.hide");
  const closedLabel = closedExpanded
    ? t("topicWorkbench.directory.historySection", { count: sections?.closed.length ?? 0 })
    : t("topicWorkbench.directory.viewHistory");

  return (
    <View style={styles.layout} onLayout={mainAgentId ? onLayout : undefined}>
      {sections && overlay && visible ? (
        <PressHighlight
          style={styles.overlayBackdrop}
          accessibilityRole="button"
          accessibilityLabel={hideLabel}
          onPress={hideTree}
        />
      ) : null}
      {sections && visible ? (
        <MainControlDirectory
          sections={sections}
          overlay={overlay}
          topOverlayInset={topOverlayInset}
          closedExpanded={closedExpanded}
          closedLabel={closedLabel}
          hideLabel={hideLabel}
          supportsWorkspaceHistory={supportsWorkspaceHistory}
          hasMoreArchive={hasMoreArchive}
          isLoadingArchive={isLoadingArchive}
          isLoadingMoreArchive={isLoadingMoreArchive}
          archiveError={archiveError}
          onLoadMoreArchive={loadMoreArchive}
          onRetryArchive={retryArchive}
          onToggleClosed={toggleClosed}
          onHide={hideTree}
          onOpen={openNode}
          onCreateResident={createResident}
        />
      ) : null}
      <View style={styles.content}>
        {sections && !visible ? (
          <View
            style={[
              styles.showTree,
              topOverlayInset > 0 && inlineUnistylesStyle({ paddingTop: topOverlayInset + 4 }),
            ]}
          >
            <ToolbarButton
              compact
              testID="main-control-tree-show"
              label={showLabel}
              onPress={showTree}
            >
              <ShowIcon size={16} />
            </ToolbarButton>
          </View>
        ) : null}
        {children}
      </View>
    </View>
  );
}

function useMainControlDirectoryData({
  mainAgentId,
  serverId,
  workspaceId,
  workspaceKey,
  historyExpanded,
}: {
  mainAgentId: string | null;
  serverId: string;
  workspaceId: string;
  workspaceKey: string | null;
  historyExpanded: boolean;
}) {
  const { t } = useTranslation();
  const layoutRoot = useWorkspaceLayoutStore((state) =>
    mainAgentId && workspaceKey ? state.layoutByWorkspace[workspaceKey]?.root : undefined,
  );
  const openTabAgentIds = useMemo(() => {
    const ids = new Set<string>();
    if (layoutRoot) {
      for (const { target } of collectAllTabs(layoutRoot)) {
        if (target.kind === "agent") ids.add(target.agentId);
      }
    }
    return ids;
  }, [layoutRoot]);
  const agentMaps = useSessionStore(
    useShallow(
      (state): Record<string, MainControlSession["agents"]> =>
        mainAgentId
          ? Object.fromEntries(
              Object.entries(state.sessions).map(([id, session]) => [id, session.agents]),
            )
          : {},
    ),
  );
  const agents = agentMaps[serverId];
  const workspaceAgentMembership = useMemo(() => {
    const ids = [];
    for (const agent of agents?.values() ?? []) {
      if (agent.workspaceId === workspaceId && !agent.background) {
        ids.push([agent.id, agent.archivedAt != null]);
      }
    }
    return JSON.stringify(ids.sort());
  }, [agents, workspaceId]);
  const {
    data: archivedAgents,
    supportsWorkspaceHistory,
    hasMore: hasMoreArchive,
    isLoading: isLoadingArchive,
    isLoadingMore: isLoadingMoreArchive,
    isError: archiveError,
    loadMore: loadMoreArchive,
    refetch: retryArchive,
  } = useWorkspaceArchivedAgents({
    serverId,
    workspaceId,
    mainAgentId,
    enabled: Boolean(mainAgentId && historyExpanded),
    workspaceAgentMembership,
  });
  const pendingArchiveIds = usePendingArchiveAgentKeys();
  const fallbackTitle = t("workspace.tabs.fallback.agent");
  const sections = useMemo(() => {
    if (!mainAgentId || !agents) return null;
    return selectMainControlWorkspaceSections({
      session: { serverId, agents },
      agentMaps,
      archivedAgents,
      mainAgentId,
      workspaceId,
      fallbackTitle,
      openTabAgentIds,
      pendingArchiveIds,
    });
  }, [
    agentMaps,
    agents,
    archivedAgents,
    fallbackTitle,
    mainAgentId,
    openTabAgentIds,
    pendingArchiveIds,
    serverId,
    workspaceId,
  ]);

  return {
    sections,
    supportsWorkspaceHistory,
    hasMoreArchive,
    isLoadingArchive,
    isLoadingMoreArchive,
    archiveError,
    loadMoreArchive,
    retryArchive,
  };
}

function MainControlDirectory({
  sections,
  overlay,
  topOverlayInset,
  closedExpanded,
  closedLabel,
  hideLabel,
  supportsWorkspaceHistory,
  hasMoreArchive,
  isLoadingArchive,
  isLoadingMoreArchive,
  archiveError,
  onLoadMoreArchive,
  onRetryArchive,
  onToggleClosed,
  onHide,
  onOpen,
  onCreateResident,
}: {
  sections: MainControlWorkspaceSections;
  overlay: boolean;
  topOverlayInset: number;
  closedExpanded: boolean;
  closedLabel: string;
  hideLabel: string;
  supportsWorkspaceHistory: boolean;
  hasMoreArchive: boolean;
  isLoadingArchive: boolean;
  isLoadingMoreArchive: boolean;
  archiveError: boolean;
  onLoadMoreArchive: () => void;
  onRetryArchive: () => void;
  onToggleClosed: () => void;
  onHide: () => void;
  onOpen: (node: MainControlTreeNode) => void;
  onCreateResident?: () => void;
}) {
  const { t } = useTranslation();
  const expandedState = useMemo(() => ({ expanded: closedExpanded }), [closedExpanded]);
  const flattenResidents = sections.residentGroups.length === 1;

  return (
    <View
      style={[
        styles.sidebar,
        overlay && styles.overlay,
        overlay && topOverlayInset > 0 && inlineUnistylesStyle({ top: topOverlayInset }),
      ]}
      testID="main-control-tree"
    >
      <View style={styles.header}>
        <Text numberOfLines={1} style={styles.headerTitle}>
          {t("topicWorkbench.directory.title")}
        </Text>
        <ToolbarButton compact testID="main-control-tree-hide" label={hideLabel} onPress={onHide}>
          <HideIcon size={16} />
        </ToolbarButton>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled">
        <View style={styles.tree}>
          {sections.residentGroups.length > 0 || onCreateResident ? (
            <>
              <View style={styles.sectionHeading}>
                <Text accessibilityRole="header" style={styles.sectionTitle}>
                  {t("topicWorkbench.directory.residentsSection")}
                </Text>
                {onCreateResident ? (
                  <ToolbarButton
                    compact
                    label={t("subagents.resident.createAction")}
                    onPress={onCreateResident}
                    testID="main-control-tree-create-resident"
                  >
                    <PlusIcon size={14} />
                  </ToolbarButton>
                ) : null}
              </View>
              {sections.residentGroups.map((group) => (
                <View key={group.parent ? mainControlTreeNodeKey(group.parent) : "standalone"}>
                  {!flattenResidents ? (
                    <View style={styles.sectionHeading}>
                      <Text numberOfLines={1} accessibilityRole="header" style={styles.rowMeta}>
                        {group.parentTitle ?? t("topicWorkbench.directory.standalone")}
                      </Text>
                    </View>
                  ) : null}
                  {group.nodes.map((node) => (
                    <MainControlTreeRow
                      key={mainControlTreeNodeKey(node)}
                      node={node}
                      onOpen={onOpen}
                    />
                  ))}
                </View>
              ))}
            </>
          ) : null}
          <View style={styles.sectionHeading}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              {t("topicWorkbench.directory.tasksSection")} ({sections.active.length})
            </Text>
          </View>
          {sections.active.map((node) => (
            <MainControlTreeRow key={mainControlTreeNodeKey(node)} node={node} onOpen={onOpen} />
          ))}
          <PressHighlight
            style={styles.sectionHeading}
            highlightStyle={styles.rowHighlight}
            accessibilityRole="button"
            accessibilityState={expandedState}
            testID="main-control-tree-toggle-closed"
            onPress={onToggleClosed}
          >
            {closedExpanded ? <DownIcon size={14} /> : <RightIcon size={14} />}
            <Text style={styles.sectionTitle}>{closedLabel}</Text>
          </PressHighlight>
          {closedExpanded ? (
            <>
              {sections.closed.map((node) => (
                <MainControlTreeRow
                  key={mainControlTreeNodeKey(node)}
                  node={node}
                  onOpen={onOpen}
                />
              ))}
              {!supportsWorkspaceHistory ? (
                <Text style={styles.rowMeta}>
                  {t("topicWorkbench.directory.historyUpgradeHost")}
                </Text>
              ) : null}
              {isLoadingArchive ? (
                <Text style={styles.rowMeta}>{t("topicWorkbench.directory.loadingHistory")}</Text>
              ) : null}
              {archiveError ? (
                <Button size="sm" variant="ghost" onPress={onRetryArchive}>
                  {t("topicWorkbench.directory.retryHistory")}
                </Button>
              ) : null}
              {hasMoreArchive ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isLoadingMoreArchive}
                  onPress={onLoadMoreArchive}
                  testID="main-control-tree-load-more"
                >
                  {isLoadingMoreArchive
                    ? t("topicWorkbench.directory.loadingHistory")
                    : t("topicWorkbench.directory.loadMoreHistory")}
                </Button>
              ) : null}
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function resolveProcessStateLabel(
  processState: MainControlTreeNode["processState"],
  t: ReturnType<typeof useTranslation>["t"],
): string {
  switch (processState) {
    case "running":
      return t("topicWorkbench.directory.statusRunning");
    case "idle":
      return t("topicWorkbench.directory.statusIdle");
    default:
      return t("topicWorkbench.directory.statusClosed");
  }
}

function resolveRoleBadgeLabel(
  roleBadge: MainControlTreeNode["roleBadge"],
  t: ReturnType<typeof useTranslation>["t"],
): string | undefined {
  if (roleBadge === "main") return t("topicWorkbench.directory.mainBadge");
  if (roleBadge === "standalone") return t("topicWorkbench.directory.standalone");
  return undefined;
}

function MainControlTreeRow({
  node,
  onOpen,
}: {
  node: MainControlTreeNode;
  onOpen: (node: MainControlTreeNode) => void;
}) {
  const { t } = useTranslation();
  const { agentId, depth, title, processState, roleBadge, residentRole } = node;
  const label = residentRole ?? title;
  const open = useCallback(() => onOpen(node), [node, onOpen]);
  const statusLabel = resolveProcessStateLabel(processState, t);
  const roleLabel = resolveRoleBadgeLabel(roleBadge, t);

  return (
    <PressHighlight
      testID={`main-control-tree-row-${agentId}`}
      accessibilityRole="button"
      accessibilityLabel={
        roleLabel ? `${label}, ${roleLabel}, ${statusLabel}` : `${label}, ${statusLabel}`
      }
      style={[styles.row, depth === 1 && styles.levelTwo, depth === 2 && styles.levelThree]}
      highlightStyle={styles.rowHighlight}
      onPress={open}
    >
      <View style={[styles.dot, processState === "running" ? styles.dotRunning : styles.dotDone]} />
      <Text numberOfLines={1} ellipsizeMode="tail" style={styles.nodeTitle}>
        {label}
      </Text>
      {roleLabel ? <StatusBadge size="xs" variant="muted" label={roleLabel} /> : null}
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  layout: { flex: 1, flexDirection: "row", minWidth: 0, minHeight: 0 },
  content: { flex: 1, minWidth: 0, minHeight: 0 },
  showTree: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface0,
    paddingLeft: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  overlayBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1,
  },
  sidebar: {
    width: 248,
    maxWidth: "100%",
    flexShrink: 0,
    backgroundColor: theme.colors.surfaceSidebar,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  overlay: { position: "absolute", top: 0, left: 0, bottom: 0, zIndex: 2 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 36,
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  tree: { padding: theme.spacing[2], gap: theme.spacing[0.5] },
  sectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: 28,
    paddingHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  sectionTitle: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 32,
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  levelTwo: {
    marginLeft: theme.spacing[2],
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  levelThree: {
    marginLeft: theme.spacing[4],
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
  },
  dotRunning: {
    backgroundColor:
      getStatusDotColor({ theme, bucket: "running", showDoneAsInactive: true }) ??
      theme.colors.border,
  },
  dotDone: {
    backgroundColor:
      getStatusDotColor({ theme, bucket: "done", showDoneAsInactive: true }) ?? theme.colors.border,
  },
  rowHighlight: { backgroundColor: theme.colors.interactionHighlight },
  nodeTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowMeta: {
    paddingHorizontal: theme.spacing[1.5],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
