import {
  ChevronDown,
  ChevronRight,
  ListCollapse,
  ListTree,
  PanelLeft,
  PanelLeftClose,
} from "lucide-react-native";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import type { AgentAddress } from "@getpaseo/protocol/addresses";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { useStreamTopOverlayInset } from "@/agent-stream/top-overlay";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { usePendingArchiveAgentKeys } from "@/hooks/use-archive-agent";
import { useSettings } from "@/hooks/use-settings";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import {
  mainControlTreeNodeKey,
  type MainControlSession,
  type MainControlTreeNode,
  selectMainControlTree,
} from "./select-tree";

const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const DownIcon = withUnistyles(ChevronDown, iconColor);
const RightIcon = withUnistyles(ChevronRight, iconColor);
const CollapseIcon = withUnistyles(ListCollapse, iconColor);
const ExpandIcon = withUnistyles(ListTree, iconColor);
const ShowIcon = withUnistyles(PanelLeft, iconColor);
const HideIcon = withUnistyles(PanelLeftClose, iconColor);

export function MainControlTreeLayout({
  mainAgentId,
  children,
}: {
  mainAgentId: string | null;
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { serverId, workspaceId, tabId } = usePaneContext();
  const { focusPane } = usePaneFocus();
  const isCompact = useIsCompactFormFactor();
  const topOverlayInset = useStreamTopOverlayInset();
  const { isBelow, onLayout } = useContainerWidthBelow(560, { initialIsBelow: false });
  const overlay = isCompact || isBelow;
  const [wideVisible, setWideVisible] = useState(true);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const visible = overlay ? overlayVisible : wideVisible;
  const setVisible = overlay ? setOverlayVisible : setWideVisible;
  const hideTree = useCallback(() => setVisible(false), [setVisible]);
  const showTree = useCallback(() => setVisible(true), [setVisible]);
  const preferences = useSettings((settings) => settings.openInSidePane);
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
  const pendingArchiveIds = usePendingArchiveAgentKeys();
  const fallbackTitle = t("workspace.tabs.fallback.agent");
  const tree = useMemo(() => {
    const agents = agentMaps[serverId];
    if (!mainAgentId || !agents) return null;
    return selectMainControlTree({
      session: { serverId, agents },
      agentMaps,
      mainAgentId,
      fallbackTitle,
      pendingArchiveIds,
    });
  }, [agentMaps, fallbackTitle, mainAgentId, pendingArchiveIds, serverId]);
  const isChinese = i18n.language?.startsWith("zh") === true;
  const showLabel = isChinese ? "显示会话进程目录树" : "Show agent tree";
  const hideLabel = isChinese ? "隐藏" : "Hide";

  const openNode = useCallback(
    ({ serverId: nodeServerId, agentId }: AgentAddress) => {
      if (overlay) setOverlayVisible(false);
      if (nodeServerId !== serverId) {
        navigateToAgent({ serverId: nodeServerId, agentId });
        return;
      }
      if (agentId === mainAgentId) {
        focusPane();
        return;
      }
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      if (agent?.workspaceId && agent.workspaceId !== workspaceId) {
        navigateToAgent({ serverId, agentId });
        return;
      }
      openPreferredWorkspaceTarget({
        workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
        target: { kind: "agent", agentId },
        source: "subagents",
        preferences,
        parentTabId: tabId,
      });
    },
    [focusPane, mainAgentId, overlay, preferences, serverId, tabId, workspaceId],
  );

  return (
    <View style={styles.layout} onLayout={mainAgentId ? onLayout : undefined}>
      {tree && overlay && visible ? (
        <PressHighlight
          style={styles.overlayBackdrop}
          accessibilityRole="button"
          accessibilityLabel={hideLabel}
          onPress={hideTree}
        />
      ) : null}
      {tree ? (
        <MainControlTree
          key={mainControlTreeNodeKey(tree)}
          tree={tree}
          visible={visible}
          overlay={overlay}
          topOverlayInset={topOverlayInset}
          isChinese={isChinese}
          hideLabel={hideLabel}
          onHide={hideTree}
          onOpen={openNode}
        />
      ) : null}
      <View style={styles.content}>
        {tree && !visible ? (
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

function MainControlTree({
  tree,
  visible,
  overlay,
  topOverlayInset,
  isChinese,
  hideLabel,
  onHide,
  onOpen,
}: {
  tree: MainControlTreeNode;
  visible: boolean;
  overlay: boolean;
  topOverlayInset: number;
  isChinese: boolean;
  hideLabel: string;
  onHide: () => void;
  onOpen: (address: AgentAddress) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const collapsibleIds = useMemo(() => {
    const ids: string[] = [];
    if (tree.children.length > 0) ids.push(mainControlTreeNodeKey(tree));
    for (const child of tree.children) {
      if (child.children.length > 0) ids.push(mainControlTreeNodeKey(child));
    }
    return ids;
  }, [tree]);
  const collapseLabel = isChinese ? "折叠" : "Collapse";
  const expandLabel = isChinese ? "展开" : "Expand";
  const activeLabel = isChinese ? "活跃" : "Active";
  const terminatedLabel = isChinese ? "已终止" : "Terminated";

  const visibleNodes = useMemo(() => {
    const nodes: MainControlTreeNode[] = [];
    function visit(node: MainControlTreeNode) {
      nodes.push(node);
      if (!collapsed.has(mainControlTreeNodeKey(node))) node.children.forEach(visit);
    }
    if (visible) visit(tree);
    return nodes;
  }, [collapsed, tree, visible]);
  const allCollapsed =
    collapsibleIds.length > 0 &&
    !visibleNodes.some(
      (node) => node.children.length > 0 && !collapsed.has(mainControlTreeNodeKey(node)),
    );

  const toggleBranches = useCallback(() => {
    setCollapsed(allCollapsed ? new Set() : new Set(collapsibleIds));
  }, [allCollapsed, collapsibleIds]);
  const toggleNode = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  if (!visible) return null;

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
          {isChinese ? "会话进程目录树" : "Agent Tree"}
        </Text>
        <ToolbarButton
          compact
          testID="main-control-tree-toggle-all"
          disabled={collapsibleIds.length === 0}
          label={allCollapsed ? expandLabel : collapseLabel}
          onPress={toggleBranches}
        >
          {allCollapsed ? <ExpandIcon size={16} /> : <CollapseIcon size={16} />}
        </ToolbarButton>
        <ToolbarButton compact testID="main-control-tree-hide" label={hideLabel} onPress={onHide}>
          <HideIcon size={16} />
        </ToolbarButton>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.tree}>
        {visibleNodes.map((node) => (
          <MainControlTreeRow
            key={mainControlTreeNodeKey(node)}
            node={node}
            expanded={!collapsed.has(mainControlTreeNodeKey(node))}
            toggleLabel={collapsed.has(mainControlTreeNodeKey(node)) ? expandLabel : collapseLabel}
            statusLabel={node.processState === "active" ? activeLabel : terminatedLabel}
            onToggle={toggleNode}
            onOpen={onOpen}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function MainControlTreeRow({
  node,
  expanded,
  toggleLabel,
  statusLabel,
  onToggle,
  onOpen,
}: {
  node: MainControlTreeNode;
  expanded: boolean;
  toggleLabel: string;
  statusLabel: string;
  onToggle: (id: string) => void;
  onOpen: (address: AgentAddress) => void;
}) {
  const { serverId, agentId, depth, title, processState } = node;
  const key = mainControlTreeNodeKey(node);
  const toggle = useCallback(() => onToggle(key), [key, onToggle]);
  const open = useCallback(() => onOpen({ serverId, agentId }), [agentId, onOpen, serverId]);
  const statusDot = useMemo(
    () => <View style={[styles.statusDot, processState === "active" && styles.activeDot]} />,
    [processState],
  );

  return (
    <View style={[styles.row, depth === 1 && styles.levelTwo, depth === 2 && styles.levelThree]}>
      {node.children.length > 0 ? (
        <ToolbarButton compact label={`${toggleLabel}: ${title}`} onPress={toggle}>
          {expanded ? <DownIcon size={14} /> : <RightIcon size={14} />}
        </ToolbarButton>
      ) : (
        <View style={styles.leaf}>
          <View style={styles.leafDot} />
        </View>
      )}
      <PressHighlight
        testID={`main-control-tree-row-${agentId}`}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${statusLabel}`}
        style={styles.rowBody}
        highlightStyle={styles.rowHighlight}
        onPress={open}
      >
        <Text numberOfLines={1} ellipsizeMode="tail" style={styles.nodeTitle}>
          {title}
        </Text>
        <StatusBadge
          size="xs"
          variant={processState === "active" ? "success" : "muted"}
          label={statusLabel}
          leading={statusDot}
        />
      </PressHighlight>
    </View>
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
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  tree: { padding: theme.spacing[2] },
  row: { flexDirection: "row", alignItems: "center", minHeight: 36 },
  levelTwo: { paddingLeft: theme.spacing[3] },
  levelThree: { paddingLeft: theme.spacing[6] },
  rowBody: {
    flex: 1,
    minWidth: 0,
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  rowHighlight: { backgroundColor: theme.colors.interactionHighlight },
  nodeTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  leaf: { width: 24, alignItems: "center" },
  leafDot: {
    width: 3,
    height: 3,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  activeDot: { backgroundColor: theme.colors.statusDotSuccess },
}));
