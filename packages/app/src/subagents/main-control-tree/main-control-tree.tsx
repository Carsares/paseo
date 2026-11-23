import { ChevronDown, ChevronRight, PanelLeft, PanelLeftClose } from "lucide-react-native";
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
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { usePendingArchiveAgentKeys } from "@/hooks/use-archive-agent";
import { useSettings } from "@/hooks/use-settings";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import {
  mainControlTreeNodeKey,
  type MainControlSession,
  type MainControlTreeNode,
  type MainControlWorkspaceSections,
  selectMainControlWorkspaceSections,
} from "./select-tree";
import { useCreateResidentAction } from "../resident-dialog";
import { useWorkspaceArchivedAgents } from "./use-workspace-archived-agents";

const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const DownIcon = withUnistyles(ChevronDown, iconColor);
const RightIcon = withUnistyles(ChevronRight, iconColor);
const ShowIcon = withUnistyles(PanelLeft, iconColor);
const HideIcon = withUnistyles(PanelLeftClose, iconColor);

export function MainControlTreeLayout({
  mainAgentId,
  children,
}: {
  mainAgentId: string | null;
  children: ReactNode;
}) {
  const { i18n } = useTranslation();
  const { serverId, workspaceId, tabId } = usePaneContext();
  const { focusPane } = usePaneFocus();
  const isCompact = useIsCompactFormFactor();
  const topOverlayInset = useStreamTopOverlayInset();
  const { isBelow, onLayout } = useContainerWidthBelow(560, { initialIsBelow: false });
  const overlay = isCompact || isBelow;
  const [wideVisible, setWideVisible] = useState(true);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [closedExpanded, setClosedExpanded] = useState(false);
  const visible = overlay ? overlayVisible : wideVisible;
  const setVisible = overlay ? setOverlayVisible : setWideVisible;
  const hideTree = useCallback(() => setVisible(false), [setVisible]);
  const showTree = useCallback(() => setVisible(true), [setVisible]);
  const expandAll = useCallback(() => {
    setVisible(true);
    setClosedExpanded(true);
  }, [setVisible]);
  const toggleClosed = useCallback(() => setClosedExpanded((current) => !current), []);
  const preferences = useSettings((settings) => settings.openInSidePane);
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const { sections, supportsWorkspaceHistory, isLoadingArchive, archiveError, retryArchive } =
    useMainControlDirectoryData({
      mainAgentId,
      serverId,
      workspaceId,
      workspaceKey,
    });
  const createResident = useCreateResidentAction(serverId, mainAgentId);

  const isChinese = i18n.language?.startsWith("zh") === true;
  const showLabel = isChinese ? "显示会话目录" : "Show sessions";
  const hideLabel = isChinese ? "隐藏" : "Hide";
  const expandLabel = isChinese ? "展开全部会话" : "Expand all sessions";
  const closedLabel = `${isChinese ? "已关闭" : "Closed"} (${sections?.closed.length ?? 0})`;

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
      // The preferred opener uses a sheet for subagents in compact mode.
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
          isChinese={isChinese}
          overlay={overlay}
          topOverlayInset={topOverlayInset}
          closedExpanded={closedExpanded}
          closedLabel={closedLabel}
          hideLabel={hideLabel}
          supportsWorkspaceHistory={supportsWorkspaceHistory}
          isLoadingArchive={isLoadingArchive}
          archiveError={archiveError}
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
            <Button
              size="sm"
              variant="secondary"
              accessibilityLabel={`${expandLabel}, ${closedLabel}`}
              testID="main-control-tree-show-all"
              style={styles.toggle}
              onPress={expandAll}
            >
              {expandLabel}
            </Button>
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
}: {
  mainAgentId: string | null;
  serverId: string;
  workspaceId: string;
  workspaceKey: string | null;
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
    isLoading: isLoadingArchive,
    isError: archiveError,
    refetch: refetchArchive,
  } = useWorkspaceArchivedAgents({ serverId, workspaceId, mainAgentId, workspaceAgentMembership });
  const retryArchive = useCallback(() => {
    void refetchArchive();
  }, [refetchArchive]);
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

  return { sections, supportsWorkspaceHistory, isLoadingArchive, archiveError, retryArchive };
}

function MainControlDirectory({
  sections,
  isChinese,
  overlay,
  topOverlayInset,
  closedExpanded,
  closedLabel,
  hideLabel,
  supportsWorkspaceHistory,
  isLoadingArchive,
  archiveError,
  onRetryArchive,
  onToggleClosed,
  onHide,
  onOpen,
  onCreateResident,
}: {
  sections: MainControlWorkspaceSections;
  isChinese: boolean;
  overlay: boolean;
  topOverlayInset: number;
  closedExpanded: boolean;
  closedLabel: string;
  hideLabel: string;
  supportsWorkspaceHistory: boolean;
  isLoadingArchive: boolean;
  archiveError: boolean;
  onRetryArchive: () => void;
  onToggleClosed: () => void;
  onHide: () => void;
  onOpen: (node: MainControlTreeNode) => void;
  onCreateResident?: () => void;
}) {
  const { t } = useTranslation();
  const expandedState = useMemo(() => ({ expanded: closedExpanded }), [closedExpanded]);
  const expandLabel = isChinese ? "展开全部会话" : "Expand all sessions";
  const collapseLabel = isChinese ? "收起已关闭" : "Collapse closed";
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
          {isChinese ? "会话" : "Sessions"}
        </Text>
        <Button
          size="sm"
          variant="ghost"
          testID="main-control-tree-toggle-all"
          style={styles.toggle}
          numberOfLines={1}
          accessibilityState={expandedState}
          onPress={onToggleClosed}
        >
          {closedExpanded ? collapseLabel : expandLabel}
        </Button>
        <ToolbarButton compact testID="main-control-tree-hide" label={hideLabel} onPress={onHide}>
          <HideIcon size={16} />
        </ToolbarButton>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled">
        <View style={styles.tree}>
          {sections.residentGroups.length || onCreateResident ? (
            <>
              <View style={styles.sectionHeading}>
                <Text accessibilityRole="header" style={styles.sectionTitle}>
                  {t("subagents.resident.groupTitle")}
                </Text>
              </View>
              {onCreateResident ? (
                <Button
                  size="sm"
                  variant="ghost"
                  style={styles.toggle}
                  onPress={onCreateResident}
                  testID="main-control-tree-create-resident"
                >
                  {t("subagents.resident.createAction")}
                </Button>
              ) : null}
              {sections.residentGroups.map((group) => (
                <View key={group.parent ? mainControlTreeNodeKey(group.parent) : "standalone"}>
                  <View style={styles.sectionHeading}>
                    <Text numberOfLines={1} accessibilityRole="header" style={styles.rowMeta}>
                      {group.parentTitle ?? (isChinese ? "独立" : "Standalone")}
                    </Text>
                  </View>
                  {group.nodes.map((node) => (
                    <MainControlTreeRow
                      key={mainControlTreeNodeKey(node)}
                      node={node}
                      isChinese={isChinese}
                      onOpen={onOpen}
                    />
                  ))}
                </View>
              ))}
            </>
          ) : null}
          <View style={styles.sectionHeading}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              {isChinese ? "活跃中" : "Active"} ({sections.active.length})
            </Text>
          </View>
          {sections.active.map((node) => (
            <MainControlTreeRow
              key={mainControlTreeNodeKey(node)}
              node={node}
              isChinese={isChinese}
              onOpen={onOpen}
            />
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
                  isChinese={isChinese}
                  onOpen={onOpen}
                />
              ))}
              {!supportsWorkspaceHistory ? (
                <Text style={styles.rowMeta}>
                  {isChinese
                    ? "更新主机以查看归档会话"
                    : "Update the host to see archived sessions"}
                </Text>
              ) : null}
              {isLoadingArchive ? (
                <Text style={styles.rowMeta}>
                  {isChinese ? "正在加载归档会话…" : "Loading archived sessions…"}
                </Text>
              ) : null}
              {archiveError ? (
                <Button size="sm" variant="ghost" onPress={onRetryArchive}>
                  {isChinese ? "重试加载归档会话" : "Retry loading archived sessions"}
                </Button>
              ) : null}
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function MainControlTreeRow({
  node,
  isChinese,
  onOpen,
}: {
  node: MainControlTreeNode;
  isChinese: boolean;
  onOpen: (node: MainControlTreeNode) => void;
}) {
  const { agentId, depth, title, processState, roleBadge, residentRole } = node;
  const label = residentRole ?? title;
  const open = useCallback(() => onOpen(node), [node, onOpen]);
  let statusLabel: string;
  if (processState === "running") statusLabel = isChinese ? "运行中" : "Running";
  else if (processState === "idle") statusLabel = isChinese ? "空闲" : "Idle";
  else statusLabel = isChinese ? "已关闭" : "Closed";
  let roleLabel: string | undefined;
  if (roleBadge === "main") roleLabel = isChinese ? "主控" : "Main";
  else if (roleBadge === "standalone") roleLabel = isChinese ? "独立" : "Standalone";

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
      <View style={styles.rowHeading}>
        <Text numberOfLines={1} ellipsizeMode="tail" style={styles.nodeTitle}>
          {label}
        </Text>
        {roleLabel ? <StatusBadge size="xs" variant="muted" label={roleLabel} /> : null}
      </View>
      <Text style={styles.rowMeta}>{statusLabel}</Text>
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
    width: 268,
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
    minHeight: 38,
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  tree: { padding: theme.spacing[2] },
  toggle: {
    flexShrink: 1,
    borderRadius: theme.borderRadius.full,
  },
  sectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: 36,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  row: {
    minHeight: 36,
    justifyContent: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  levelTwo: { marginLeft: theme.spacing[3] },
  levelThree: { marginLeft: theme.spacing[6] },
  rowHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  rowHighlight: { backgroundColor: theme.colors.interactionHighlight },
  nodeTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
