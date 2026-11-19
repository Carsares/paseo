import {
  FlatList,
  RefreshControl,
  Text,
  View,
  type ListRenderItem,
  type PressableStateCallbackType,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { ArchivedBadge } from "@/components/archived-badge";
import { ProjectIconView } from "@/components/project-icon-view";
import { useProviderIcon, type ProviderIconProps } from "@/components/provider-icons";
import { HighlightedText } from "@/components/ui/highlighted-text";
import { findHighlightRanges } from "@/components/ui/highlighted-text-segments";
import { Modal } from "@/components/ui/modal";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { AgentHistoryArchiveScope } from "@/hooks/use-agent-history";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useTimeAgo } from "@/hooks/use-time-ago";
import {
  buildHistoryProjectGroups,
  flattenHistoryProjectGroups,
  type HistoryFlatListItem,
  type HistoryProjectGroup,
  type HistoryWorkspaceGroup,
} from "@/screens/sessions/history-grouping";
import { useSessionStore } from "@/stores/session-store";
import { density, densityIconProps } from "@/styles/density";
import type { Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";

interface AgentListProps {
  agents: AggregatedAgent[];
  ancestors: AggregatedAgent[];
  archiveScope?: AgentHistoryArchiveScope;
  activeWorkspaceIdsByServer: ReadonlyMap<string, ReadonlySet<string>>;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  listFooterComponent?: ReactElement | null;
  showHostColumn?: boolean;
  search?: string;
}

const HISTORY_MATCH_OPTIONS = { typoTolerant: true } as const;
const EMPTY_EXPANDED_OVERRIDES: ReadonlyMap<string, boolean> = new Map();
const ThemedRefreshControl = withUnistyles(RefreshControl);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronDown = withUnistyles(ChevronDown);

const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const chevronProps = densityIconProps("xs", mutedIconColor);
const providerIconProps = densityIconProps("sm", mutedIconColor);
const refreshControlColors = (theme: Theme) => ({
  tintColor: theme.colors.foregroundMuted,
  colors: [theme.colors.foregroundMuted],
});

function SessionProviderIcon({
  agent,
  size,
  color,
}: ProviderIconProps & { agent: AggregatedAgent }) {
  const Icon = useProviderIcon(agent.provider, agent.serverId);
  return <Icon size={size} color={color} />;
}

const ThemedSessionProviderIcon = withUnistyles(SessionProviderIcon);

function ProjectHeading({ project, search }: { project: HistoryProjectGroup; search: string }) {
  const { projectName } = project;
  const initial = projectName.trim().charAt(0).toUpperCase() || "?";
  return (
    <View
      style={styles.projectHeading}
      accessibilityRole="header"
      testID={`history-project-header-${project.key}`}
    >
      <ProjectIconView
        size={18}
        iconDataUri={null}
        initial={initial}
        projectViewKey={project.key}
        textStyle={styles.projectIconText}
      />
      <HighlightedText
        text={projectName}
        ranges={findHighlightRanges(search, projectName, HISTORY_MATCH_OPTIONS)}
        style={styles.projectTitle}
        numberOfLines={1}
        testID={`history-project-name-${project.key}`}
      />
    </View>
  );
}

function WorkspaceHeading({
  workspace,
  search,
  showHost,
}: {
  workspace: HistoryWorkspaceGroup;
  search: string;
  showHost: boolean;
}) {
  const { workspaceName, branch, serverLabel, isWorkspaceArchived } = workspace;
  const hostLabel = showHost ? serverLabel : "";
  return (
    <View
      style={styles.workspaceHeading}
      accessibilityRole="header"
      testID={`history-workspace-header-${workspace.key}`}
    >
      <View style={[styles.workspaceHeadingRow, styles.workspaceNameRow]}>
        <HighlightedText
          text={workspaceName}
          ranges={findHighlightRanges(search, workspaceName, HISTORY_MATCH_OPTIONS)}
          style={styles.workspaceTitle}
          numberOfLines={1}
          testID={`history-workspace-name-${workspace.key}`}
        />
        {isWorkspaceArchived ? <ArchivedBadge /> : null}
      </View>
      {branch || hostLabel ? (
        <View style={styles.workspaceHeadingRow}>
          {branch ? (
            <HighlightedText
              text={branch}
              ranges={findHighlightRanges(search, branch, HISTORY_MATCH_OPTIONS)}
              style={styles.workspaceMeta}
              numberOfLines={1}
              testID={`history-workspace-branch-${workspace.key}`}
            />
          ) : null}
          {branch && hostLabel ? <Text style={styles.workspaceMeta}>·</Text> : null}
          {hostLabel ? (
            <Text style={styles.workspaceMeta} numberOfLines={1}>
              {hostLabel}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

type SessionListItem = Extract<HistoryFlatListItem, { type: "root-agent" | "subagent" }>;

function sessionNavigationStyle({ hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.sessionNavigation, hovered && styles.rowHovered];
}

function SessionRow({
  item,
  search,
  onPress,
  onLongPress,
  onToggle,
}: {
  item: SessionListItem;
  search: string;
  onPress: (agent: AggregatedAgent) => void;
  onLongPress: (agent: AggregatedAgent) => void;
  onToggle: (key: string, expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const isRoot = item.type === "root-agent";
  const agent = isRoot ? item.node.agent : item.agent;
  const isAncestorShell = isRoot && item.node.isAncestorShell;
  const showArchiveBadge = Boolean(agent.archivedAt) && !item.workspace.isWorkspaceArchived;
  const permissionCount = agent.pendingPermissionCount ?? 0;
  const title = agent.title || t("agentList.fallbackTitle");
  const testSuffix = `${agent.serverId}-${agent.id}`;
  const handlePress = useCallback(() => onPress(agent), [onPress, agent]);
  const handleLongPress = useCallback(() => onLongPress(agent), [onLongPress, agent]);

  return (
    <View style={[styles.sessionRow, !isRoot && styles.subagentRow]}>
      <PressHighlight
        style={sessionNavigationStyle}
        highlightStyle={styles.rowPressed}
        onPress={handlePress}
        onLongPress={handleLongPress}
        accessibilityRole="button"
        testID={`agent-row-${testSuffix}`}
      >
        <View style={styles.sessionTitleRow}>
          <ThemedSessionProviderIcon agent={agent} uniProps={providerIconProps} />
          <HighlightedText
            text={title}
            ranges={findHighlightRanges(search, title, HISTORY_MATCH_OPTIONS)}
            style={[styles.sessionTitle, isAncestorShell && styles.ancestorTitle]}
            numberOfLines={1}
            testID={`agent-row-title-${testSuffix}`}
          />
        </View>
        <View style={styles.sessionMetadata}>
          {showArchiveBadge ? <ArchivedBadge /> : null}
          {permissionCount > 0 ? (
            <StatusBadge
              label={t("agentList.badges.pending", { count: permissionCount })}
              variant="warning"
            />
          ) : null}
          <AgentActivityTime date={agent.lastActivityAt} />
        </View>
      </PressHighlight>
      {isRoot && item.node.subagents.length > 0 ? (
        <SubagentsToggle
          agentKey={item.node.key}
          testSuffix={testSuffix}
          expanded={item.expanded}
          count={item.node.subagents.length}
          onToggle={onToggle}
        />
      ) : null}
    </View>
  );
}

function SubagentsToggle({
  agentKey,
  testSuffix,
  expanded,
  count,
  onToggle,
}: {
  agentKey: string;
  testSuffix: string;
  expanded: boolean;
  count: number;
  onToggle: (key: string, expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(
    () => onToggle(agentKey, !expanded),
    [onToggle, agentKey, expanded],
  );
  const Chevron = expanded ? ThemedChevronDown : ThemedChevronRight;
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <PressHighlight
      style={styles.subagentsToggle}
      highlightStyle={styles.rowPressed}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      aria-expanded={expanded}
      accessibilityLabel={t(
        expanded
          ? "agentList.subagents.collapseAccessibility"
          : "agentList.subagents.expandAccessibility",
      )}
      testID={`agent-row-subagents-toggle-${testSuffix}`}
    >
      <Text style={styles.subagentsLabel} numberOfLines={1}>
        {count === 1 ? t("agentList.subagents.one") : t("agentList.subagents.many", { count })}
      </Text>
      <Chevron uniProps={chevronProps} />
    </PressHighlight>
  );
}

function AgentActivityTime({ date }: { date: Date }) {
  const label = useTimeAgo(date);
  return (
    <Text style={styles.activityTime} numberOfLines={1}>
      {label}
    </Text>
  );
}

function historyItemKey(item: HistoryFlatListItem) {
  return item.key;
}

export function AgentList({
  agents,
  ancestors,
  archiveScope,
  activeWorkspaceIdsByServer,
  isRefreshing = false,
  onRefresh,
  listFooterComponent,
  showHostColumn = false,
  search = "",
}: AgentListProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [actionAgent, setActionAgent] = useState<AggregatedAgent | null>(null);
  const [expansion, setExpansion] = useState({
    archiveScope,
    search,
    overrides: EMPTY_EXPANDED_OVERRIDES,
  });
  const isCurrentExpansion = expansion.archiveScope === archiveScope && expansion.search === search;
  if (!isCurrentExpansion) {
    setExpansion({ archiveScope, search, overrides: EMPTY_EXPANDED_OVERRIDES });
  }
  const expandedOverrides = isCurrentExpansion ? expansion.overrides : EMPTY_EXPANDED_OVERRIDES;
  const { archiveAgent } = useArchiveAgent();

  const actionClient = useSessionStore((state) =>
    actionAgent?.serverId ? (state.sessions[actionAgent.serverId]?.client ?? null) : null,
  );
  const isActionSheetVisible = actionAgent !== null;
  const isActionDaemonUnavailable = Boolean(actionAgent?.serverId && !actionClient);

  const handleAgentPress = useCallback(
    (agent: AggregatedAgent) => {
      if (isActionSheetVisible) return;

      navigateToAgent({
        serverId: agent.serverId,
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        pin: true,
      });
    },
    [isActionSheetVisible],
  );

  const handleAgentLongPress = useCallback(
    (agent: AggregatedAgent) => {
      const client = useSessionStore.getState().sessions[agent.serverId]?.client ?? null;
      if (agent.status === "running" || !client) {
        setActionAgent(agent);
        return;
      }
      void archiveAgent({ serverId: agent.serverId, agentId: agent.id }).catch(() => {});
    },
    [archiveAgent],
  );

  const handleCloseActionSheet = useCallback(() => setActionAgent(null), []);

  const handleArchiveAgent = useCallback(() => {
    if (!actionAgent || !actionClient) return;
    // Timeout errors are swallowed — the daemon will still process the archive.
    void archiveAgent({ serverId: actionAgent.serverId, agentId: actionAgent.id }).catch(() => {});
    setActionAgent(null);
  }, [actionAgent, actionClient, archiveAgent]);

  const handleToggle = useCallback((key: string, expanded: boolean) => {
    setExpansion((current) => {
      const overrides = new Map(current.overrides);
      overrides.set(key, expanded);
      return { ...current, overrides };
    });
  }, []);

  const groups = useMemo(
    () =>
      buildHistoryProjectGroups({ entries: agents, ancestors, activeWorkspaceIdsByServer, search }),
    [agents, ancestors, activeWorkspaceIdsByServer, search],
  );
  const flatItems = useMemo(
    () =>
      flattenHistoryProjectGroups({
        groups,
        isSearching: search.length > 0,
        expandedOverrides,
      }),
    [groups, search, expandedOverrides],
  );

  const renderItem: ListRenderItem<HistoryFlatListItem> = useCallback(
    ({ item }) => {
      if (item.type === "project-header") {
        return <ProjectHeading project={item.project} search={search} />;
      }
      if (item.type === "workspace-header") {
        return (
          <WorkspaceHeading workspace={item.workspace} search={search} showHost={showHostColumn} />
        );
      }
      return (
        <SessionRow
          item={item}
          search={search}
          onPress={handleAgentPress}
          onLongPress={handleAgentLongPress}
          onToggle={handleToggle}
        />
      );
    },
    [search, showHostColumn, handleAgentPress, handleAgentLongPress, handleToggle],
  );

  const refreshControl = useMemo(
    () =>
      onRefresh ? (
        <ThemedRefreshControl
          refreshing={isRefreshing}
          onRefresh={onRefresh}
          uniProps={refreshControlColors}
        />
      ) : undefined,
    [onRefresh, isRefreshing],
  );
  return (
    <>
      <FlatList
        data={flatItems}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyExtractor={historyItemKey}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        ListFooterComponent={listFooterComponent}
        refreshControl={refreshControl}
      />

      <Modal
        visible={isActionSheetVisible}
        animationType="fade"
        transparent
        onRequestClose={handleCloseActionSheet}
      >
        <View style={styles.sheetOverlay}>
          <PressHighlight style={styles.sheetBackdrop} onPress={handleCloseActionSheet} />
          <View style={styles.sheetContainer(insets.bottom)}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>
              {isActionDaemonUnavailable
                ? t("agentList.archiveSheet.hostOffline")
                : t("agentList.archiveSheet.runningAgent")}
            </Text>
            <View style={styles.sheetButtonRow}>
              <PressHighlight
                style={[styles.sheetButton, styles.sheetCancelButton]}
                onPress={handleCloseActionSheet}
                testID="agent-action-cancel"
              >
                <Text style={styles.sheetCancelText}>{t("common.actions.cancel")}</Text>
              </PressHighlight>
              <PressHighlight
                disabled={isActionDaemonUnavailable}
                style={[styles.sheetButton, styles.sheetArchiveButton]}
                onPress={handleArchiveAgent}
                testID="agent-action-archive"
              >
                <Text
                  style={[
                    styles.sheetArchiveText,
                    isActionDaemonUnavailable && styles.sheetArchiveTextDisabled,
                  ]}
                >
                  {t("agentList.archiveSheet.archive")}
                </Text>
              </PressHighlight>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    flex: 1,
    minHeight: 0,
  },
  listContent: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  projectHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    marginTop: theme.spacing[3],
    marginBottom: theme.spacing[2],
  },
  projectIconText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  projectTitle: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  workspaceHeading: {
    gap: theme.spacing[1],
    marginStart: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  workspaceHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  workspaceNameRow: {
    minHeight: theme.spacing[6],
  },
  workspaceTitle: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  workspaceMeta: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginStart: theme.spacing[6],
  },
  subagentRow: {
    marginStart: theme.spacing[8],
  },
  sessionNavigation: {
    flex: 1,
    minWidth: 0,
    minHeight: density.rowHeight,
    flexDirection: { xs: "column", md: "row" },
    alignItems: { xs: "stretch", md: "center" },
    justifyContent: { xs: "center", md: "space-between" },
    columnGap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  sessionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    minWidth: 0,
    gap: theme.spacing[2],
  },
  sessionTitle: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  ancestorTitle: {
    color: theme.colors.foregroundMuted,
  },
  sessionMetadata: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: 20,
    minWidth: 0,
  },
  activityTime: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  subagentsToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    maxWidth: "38%",
    minHeight: density.rowHeight,
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
  },
  subagentsLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  sheetOverlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheetBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  sheetContainer: (bottomInset: number) => ({
    backgroundColor: theme.colors.surface2,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[4],
    paddingBottom: Math.max(bottomInset, theme.spacing[6]),
    gap: theme.spacing[4],
  }),
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
    opacity: 0.3,
  },
  sheetTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  sheetButtonRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  sheetButton: {
    flex: 1,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[4],
    alignItems: "center",
    justifyContent: "center",
  },
  sheetArchiveButton: {
    backgroundColor: theme.colors.primary,
  },
  sheetArchiveText: {
    color: theme.colors.primaryForeground,
    fontWeight: theme.fontWeight.medium,
    fontSize: theme.fontSize.base,
  },
  sheetArchiveTextDisabled: {
    opacity: 0.5,
  },
  sheetCancelButton: {
    backgroundColor: theme.colors.surface1,
  },
  sheetCancelText: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
    fontSize: theme.fontSize.base,
  },
}));
