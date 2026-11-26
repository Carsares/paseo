import { useWorkspaceRowPress } from "../../../modules/paseo-press-feedback";
import { PressHighlight as Pressable } from "@/components/ui/press-highlight";
import {
  memo,
  useCallback,
  useMemo,
  useState,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import { View, Text } from "react-native";
import type { GestureType } from "react-native-gesture-handler";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { type SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type {
  SidebarGroupLeading,
  SidebarWorkspaceGroup,
} from "@/components/sidebar/sidebar-labels";
import {
  deriveTopicStatusClassification,
  type TopicWorkspaceFacts,
} from "@/components/sidebar/sidebar-topic-view-model";
import { SidebarFilterEmptyState } from "@/components/sidebar/empty-states";
import type { HostBadgeModel } from "@/hosts/appearance";
import { isWeb as platformIsWeb, isNative as platformIsNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { HoverEnvelope } from "@/agent-stream/topic-card/hover-envelope";
import { StyleSheet } from "react-native-unistyles";
import { density, densityIconBox, densityIconProps } from "@/styles/density";
import type { SidebarSurfaceBackdrop } from "@/styles/surface-backdrop";
import { withUnistyles } from "react-native-unistyles";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleX,
} from "lucide-react-native";
import { useToast } from "@/contexts/toast-context";
import { useSidebarWorkspaceRename } from "@/workspace-rename";
import { useWorkspaceClipboardActions } from "@/hooks/use-workspace-clipboard-actions";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { useWorkspaceArchive } from "@/workspace/use-workspace-archive";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useWorkspaceReadState } from "@/hooks/use-workspace-read-state";
import {
  SidebarWorkspaceRowFrame,
  SidebarWorkspaceRowContent,
  resolveTrailingActionVisibility,
  type SidebarWorkspaceTrailingPresentation,
  SidebarWorkspaceTrailingActionBase,
  SidebarWorkspaceTrailingActionOverlay,
  SidebarWorkspaceTrailingActionSlot,
  sidebarWorkspaceRowStyles,
} from "@/components/sidebar/sidebar-workspace-row-content";
import { useOpenKebabMenuVisibility } from "@/components/sidebar/use-open-kebab-menu-visibility";
import { getSidebarRowBackdrop } from "@/components/sidebar/sidebar-row-backdrop";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { selectWorkspaceServiceSummary } from "@/components/sidebar/workspace-meta-row";
import {
  SidebarWorkspaceTrailingContent,
  useSidebarWorkspaceTrailing,
  type SidebarWorkspaceTrailing,
} from "@/components/sidebar/workspace-trailing";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarTopicCompletionStore } from "@/stores/sidebar-topic-completion-store";
import {
  SidebarWorkspaceContextMenu,
  SidebarWorkspaceMenu,
} from "@/components/sidebar/sidebar-workspace-menu";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { SidebarGroupToggleRow } from "@/components/sidebar/sidebar-group-toggle-row";
import { useLimitedSidebarGroup } from "@/components/sidebar/use-limited-sidebar-group";
import type { ToggleSidebarWorkspacePin } from "@/hooks/use-sidebar-workspace-pin";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { useLongPressDragInteraction } from "@/components/sidebar/use-long-press-drag-interaction";

// Themed icon wrappers
const mutedGroupIconProps = densityIconProps("sm", (theme) => ({
  color: theme.colors.foregroundMuted,
}));
// One mapping per bucket, resolved through the status-dot producer so a group header and
// the rows under it cannot disagree about what "failed" looks like.
const needsInputGroupIconProps = densityIconProps("sm", (theme) => ({
  color: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
}));
const failedGroupIconProps = densityIconProps("sm", (theme) => ({
  color: getStatusDotColor({ theme, bucket: "failed" }) ?? undefined,
}));
const attentionGroupIconProps = densityIconProps("sm", (theme) => ({
  color: getStatusDotColor({ theme, bucket: "attention" }) ?? undefined,
}));
const runningGroupIconProps = densityIconProps("sm", (theme) => ({
  color: getStatusDotColor({ theme, bucket: "running" }) ?? undefined,
}));

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleX = withUnistyles(CircleX);
const EMPTY_SHORTCUT_INDEX = new Map<string, number>();

function statusWorkspaceKeyExtractor(workspace: SidebarWorkspaceEntry): string {
  return workspace.workspaceKey;
}

interface StatusWorkspaceListProps {
  groups: SidebarWorkspaceGroup[];
  pinnedWorkspaces: SidebarWorkspaceEntry[];
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  onPinnedWorkspaceReorder: (workspaces: SidebarWorkspaceEntry[]) => void;
  forceShowProject?: boolean;
  topicFactsByWorkspaceKey?: ReadonlyMap<string, TopicWorkspaceFacts>;
  emptyStateComponent?: ReactNode;
  listFooterComponent?: ReactNode;
  listHeaderComponent?: ReactNode;
  /** Swaps the group list for the label filter's empty state. Never the header above it. */
  sidebarFilterEmpty?: boolean;
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
  dragGestureHostActive?: boolean;
}

export function SidebarStatusWorkspaceList({
  groups,
  pinnedWorkspaces,
  projectIconByProjectViewKey,
  shortcutIndexByWorkspaceKey,
  showShortcutBadges,
  onWorkspacePress,
  hostBadgeByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
  onPinnedWorkspaceReorder,
  forceShowProject = false,
  topicFactsByWorkspaceKey,
  emptyStateComponent = null,
  listFooterComponent = null,
  listHeaderComponent,
  sidebarFilterEmpty = false,
  parentGestureRef,
  dragGestureHostActive,
}: StatusWorkspaceListProps) {
  const { t } = useTranslation();
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const collapsedWorkspaceGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedWorkspaceGroupKeys,
  );
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const togglePinnedCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.togglePinnedCollapsed,
  );
  const [pinnedWorkspacesExpanded, setPinnedWorkspacesExpanded] = useState(false);
  const togglePinnedWorkspacesExpanded = useCallback(
    () => setPinnedWorkspacesExpanded((current) => !current),
    [],
  );
  const {
    leadingItem: leadingPinnedWorkspace,
    visibleItems: visiblePinnedWorkspaces,
    canToggle: canTogglePinnedWorkspaces,
  } = useLimitedSidebarGroup({
    items: pinnedWorkspaces,
    selection: activeWorkspaceSelection,
    expanded: pinnedWorkspacesExpanded,
  });

  const statusShortcutIndex = showShortcutBadges
    ? shortcutIndexByWorkspaceKey
    : EMPTY_SHORTCUT_INDEX;
  const renderPinnedWorkspaceRow = useCallback(
    (
      workspace: SidebarWorkspaceEntry,
      input?: {
        drag?: () => void;
        isDragging?: boolean;
        dragHandleProps?: DraggableListDragHandleProps;
      },
    ) => (
      <StatusWorkspaceRow
        key={workspace.workspaceKey}
        workspace={workspace}
        {...buildStatusRowProjectPresentation({
          workspace,
          projectIconByProjectViewKey,
          hostBadgeByServerId,
        })}
        forceShowProject={forceShowProject}
        topicFacts={topicFactsByWorkspaceKey?.get(workspace.workspaceKey)}
        inStatusGroup={false}
        shortcutNumber={statusShortcutIndex.get(workspace.workspaceKey) ?? null}
        showShortcutBadge={showShortcutBadges}
        canPin={supportsPinningByServerId.get(workspace.serverId) === true}
        onToggleWorkspacePin={onToggleWorkspacePin}
        onWorkspacePress={onWorkspacePress}
        drag={input?.drag}
        isDragging={input?.isDragging}
        dragHandleProps={input?.dragHandleProps}
      />
    ),
    [
      forceShowProject,
      hostBadgeByServerId,
      onToggleWorkspacePin,
      onWorkspacePress,
      projectIconByProjectViewKey,
      showShortcutBadges,
      statusShortcutIndex,
      supportsPinningByServerId,
      topicFactsByWorkspaceKey,
    ],
  );
  const renderPinnedWorkspace = useCallback(
    ({
      item: workspace,
      drag,
      isActive,
      dragHandleProps,
    }: DraggableRenderItemInfo<SidebarWorkspaceEntry>) =>
      renderPinnedWorkspaceRow(workspace, {
        drag,
        isDragging: isActive,
        dragHandleProps,
      }),
    [renderPinnedWorkspaceRow],
  );
  return (
    <>
      {pinnedWorkspaces.length > 0 ? (
        <View style={styles.pinnedSection} testID="sidebar-pinned-section">
          <SidebarSectionHeader
            title={t("sidebar.pinned.title")}
            collapsed={pinnedCollapsed}
            onToggle={togglePinnedCollapsed}
            testID="sidebar-pinned-section-header"
          />
          {pinnedCollapsed ? null : (
            <>
              {leadingPinnedWorkspace ? renderPinnedWorkspaceRow(leadingPinnedWorkspace) : null}
              <DraggableList
                testID="sidebar-pinned-list"
                data={visiblePinnedWorkspaces}
                keyExtractor={statusWorkspaceKeyExtractor}
                renderItem={renderPinnedWorkspace}
                onDragEnd={onPinnedWorkspaceReorder}
                scrollEnabled={false}
                useDragHandle
                nestable={platformIsNative}
                simultaneousGestureRef={parentGestureRef}
                gestureHostPresented={dragGestureHostActive}
              />
              {canTogglePinnedWorkspaces ? (
                <SidebarGroupToggleRow
                  expanded={pinnedWorkspacesExpanded}
                  onPress={togglePinnedWorkspacesExpanded}
                  testID="sidebar-pinned-show-more"
                />
              ) : null}
            </>
          )}
        </View>
      ) : null}
      {listHeaderComponent}
      {renderStatusWorkspaceBody({
        sidebarFilterEmpty,
        groups,
        pinnedWorkspaces,
        emptyStateComponent,
        collapsedWorkspaceGroupKeys,
        projectIconByProjectViewKey,
        shortcutIndex: statusShortcutIndex,
        showShortcutBadges,
        onWorkspacePress,
        hostBadgeByServerId,
        supportsPinningByServerId,
        onToggleWorkspacePin,
        forceShowProject,
        topicFactsByWorkspaceKey,
      })}
      {listFooterComponent}
    </>
  );
}

function renderStatusWorkspaceBody(input: {
  sidebarFilterEmpty: boolean;
  groups: SidebarWorkspaceGroup[];
  pinnedWorkspaces: SidebarWorkspaceEntry[];
  emptyStateComponent: ReactNode;
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  shortcutIndex: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  forceShowProject: boolean;
  topicFactsByWorkspaceKey?: ReadonlyMap<string, TopicWorkspaceFacts>;
}): ReactNode {
  if (input.sidebarFilterEmpty) {
    return <SidebarFilterEmptyState />;
  }
  if (
    input.groups.length === 0 &&
    input.pinnedWorkspaces.length === 0 &&
    input.emptyStateComponent
  ) {
    return input.emptyStateComponent;
  }
  return (
    <StatusGroupList
      groups={input.groups}
      collapsedWorkspaceGroupKeys={input.collapsedWorkspaceGroupKeys}
      projectIconByProjectViewKey={input.projectIconByProjectViewKey}
      shortcutIndex={input.shortcutIndex}
      showShortcutBadges={input.showShortcutBadges}
      onWorkspacePress={input.onWorkspacePress}
      hostBadgeByServerId={input.hostBadgeByServerId}
      supportsPinningByServerId={input.supportsPinningByServerId}
      onToggleWorkspacePin={input.onToggleWorkspacePin}
      forceShowProject={input.forceShowProject}
      topicFactsByWorkspaceKey={input.topicFactsByWorkspaceKey}
    />
  );
}

function StatusGroupList({
  groups,
  collapsedWorkspaceGroupKeys,
  projectIconByProjectViewKey,
  shortcutIndex,
  showShortcutBadges,
  onWorkspacePress,
  hostBadgeByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
  forceShowProject,
  topicFactsByWorkspaceKey,
}: {
  groups: SidebarWorkspaceGroup[];
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  shortcutIndex: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  forceShowProject: boolean;
  topicFactsByWorkspaceKey?: ReadonlyMap<string, TopicWorkspaceFacts>;
}) {
  return (
    <>
      {groups.map((group) => (
        <StatusGroupRows
          key={group.key}
          group={group}
          collapsed={collapsedWorkspaceGroupKeys.has(group.key)}
          projectIconByProjectViewKey={projectIconByProjectViewKey}
          shortcutIndex={shortcutIndex}
          showShortcutBadges={showShortcutBadges}
          onWorkspacePress={onWorkspacePress}
          hostBadgeByServerId={hostBadgeByServerId}
          supportsPinningByServerId={supportsPinningByServerId}
          onToggleWorkspacePin={onToggleWorkspacePin}
          forceShowProject={forceShowProject}
          topicFactsByWorkspaceKey={topicFactsByWorkspaceKey}
        />
      ))}
    </>
  );
}

const STATUS_GROUP_VISIBILITY = {
  kind: "workspaces" as const,
  getStatusBucket: (workspace: SidebarWorkspaceEntry) => workspace.statusBucket,
};

function StatusGroupRows({
  group,
  collapsed,
  projectIconByProjectViewKey,
  shortcutIndex,
  showShortcutBadges,
  onWorkspacePress,
  hostBadgeByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
  forceShowProject,
  topicFactsByWorkspaceKey,
}: {
  group: SidebarWorkspaceGroup;
  collapsed: boolean;
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  shortcutIndex: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  forceShowProject: boolean;
  topicFactsByWorkspaceKey?: ReadonlyMap<string, TopicWorkspaceFacts>;
}) {
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const [workspacesExpanded, setWorkspacesExpanded] = useState(false);
  const toggleWorkspacesExpanded = useCallback(
    () => setWorkspacesExpanded((current) => !current),
    [],
  );
  const {
    leadingItem: leadingWorkspace,
    visibleItems: visibleWorkspaces,
    canToggle: canToggleWorkspaces,
  } = useLimitedSidebarGroup({
    items: group.rows,
    selection: activeWorkspaceSelection,
    expanded: workspacesExpanded,
    policy: STATUS_GROUP_VISIBILITY,
  });

  function renderWorkspaceRow(workspace: SidebarWorkspaceEntry) {
    return (
      <StatusWorkspaceRow
        key={workspace.workspaceKey}
        workspace={workspace}
        {...buildStatusRowProjectPresentation({
          workspace,
          projectIconByProjectViewKey,
          hostBadgeByServerId,
        })}
        forceShowProject={forceShowProject}
        topicFacts={topicFactsByWorkspaceKey?.get(workspace.workspaceKey)}
        shortcutNumber={shortcutIndex.get(workspace.workspaceKey) ?? null}
        showShortcutBadge={showShortcutBadges}
        canPin={supportsPinningByServerId.get(workspace.serverId) === true}
        onToggleWorkspacePin={onToggleWorkspacePin}
        onWorkspacePress={onWorkspacePress}
      />
    );
  }

  return (
    <View style={collapsed ? undefined : styles.statusGroupBlockExpanded}>
      <StatusGroupHeader group={group} collapsed={collapsed} />
      {!collapsed ? (
        <View
          style={styles.statusWorkspaceListContainer}
          testID={`sidebar-status-group-rows-${group.key}`}
        >
          {leadingWorkspace ? renderWorkspaceRow(leadingWorkspace) : null}
          {visibleWorkspaces.map(renderWorkspaceRow)}
          {canToggleWorkspaces ? (
            <SidebarGroupToggleRow
              expanded={workspacesExpanded}
              onPress={toggleWorkspacesExpanded}
              indented
              testID={`sidebar-status-group-show-more-${group.key}`}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

interface StatusRowProjectPresentation {
  hostBadge: HostBadgeModel | null;
  projectName: string;
  projectIconDataUri: string | null;
}

function buildStatusRowProjectPresentation({
  workspace,
  projectIconByProjectViewKey,
  hostBadgeByServerId,
}: {
  workspace: SidebarWorkspaceEntry;
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
}): StatusRowProjectPresentation {
  return {
    hostBadge: hostBadgeByServerId.get(workspace.serverId) ?? null,
    projectName: workspace.projectName,
    projectIconDataUri: projectIconByProjectViewKey.get(workspace.projectViewKey) ?? null,
  };
}

function StatusGroupHeader({
  group,
  collapsed,
}: {
  group: SidebarWorkspaceGroup;
  collapsed: boolean;
}) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const toggleWorkspaceGroupCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleWorkspaceGroupCollapsed,
  );
  const handlePress = useCallback(() => {
    toggleWorkspaceGroupCollapsed(group.key);
  }, [group.key, toggleWorkspaceGroupCollapsed]);
  const rowStyle = useMemo(
    () => [styles.statusGroupRow, isHovered && styles.statusGroupRowHovered],
    [isHovered],
  );
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);

  return (
    <HoverEnvelope onHoverChange={setIsHovered}>
      <Pressable
        accessibilityRole={platformIsWeb ? undefined : "button"}
        accessibilityLabel={t("sidebar.statusGroupAccessibility", { label: group.label })}
        accessibilityState={accessibilityState}
        style={rowStyle}
        highlightStyle={styles.statusGroupRowPressed}
        onPress={handlePress}
        testID={`sidebar-status-group-${group.key}`}
      >
        <View style={styles.statusGroupRowLeft}>
          <View style={styles.statusGroupLeadingVisualSlot}>
            <StatusGroupLeadingVisual
              leading={group.leading}
              collapsed={collapsed}
              showChevron={isHovered}
            />
          </View>
          <View style={styles.statusGroupTitleGroup}>
            <Text style={styles.statusGroupTitle} numberOfLines={1}>
              {group.label}
            </Text>
            {typeof group.count === "number" ? (
              <Text style={styles.statusGroupCount}>{group.count}</Text>
            ) : null}
          </View>
        </View>
      </Pressable>
    </HoverEnvelope>
  );
}

function StatusGroupLeadingVisual({
  leading,
  collapsed,
  showChevron,
}: {
  leading: SidebarGroupLeading;
  collapsed: boolean;
  showChevron: boolean;
}) {
  if (!showChevron) {
    return <StatusGroupIcon leading={leading} />;
  }
  if (collapsed) {
    return <ThemedChevronRight uniProps={mutedGroupIconProps} />;
  }
  return <ThemedChevronDown uniProps={mutedGroupIconProps} />;
}

function StatusGroupIcon({ leading }: { leading: SidebarGroupLeading }) {
  if (leading.kind === "topic") {
    switch (leading.bucket) {
      case "pending_action":
        return <ThemedCircleAlert uniProps={needsInputGroupIconProps} />;
      case "in_progress":
        return <ThemedCircleDot uniProps={runningGroupIconProps} />;
      case "completed":
        return <ThemedCircleCheck uniProps={mutedGroupIconProps} />;
    }
  }
  switch (leading.bucket) {
    case "needs_input":
      return <ThemedCircleAlert uniProps={needsInputGroupIconProps} />;
    case "failed":
      return <ThemedCircleX uniProps={failedGroupIconProps} />;
    case "attention":
      return <ThemedCircleCheck uniProps={attentionGroupIconProps} />;
    case "running":
      return <ThemedCircleDot uniProps={runningGroupIconProps} />;
    case "done":
      return <ThemedCircleCheck uniProps={mutedGroupIconProps} />;
  }
}

const StatusWorkspaceRow = memo(function StatusWorkspaceRow({
  workspace,
  hostBadge,
  projectName,
  projectIconDataUri,
  forceShowProject = false,
  topicFacts,
  shortcutNumber,
  showShortcutBadge,
  canPin,
  onToggleWorkspacePin,
  reserveIdleStatusIndicatorSpace = true,
  inStatusGroup = true,
  onWorkspacePress,
  drag,
  isDragging = false,
  dragHandleProps,
}: {
  workspace: SidebarWorkspaceEntry;
  hostBadge: HostBadgeModel | null;
  projectName: string;
  projectIconDataUri: string | null;
  forceShowProject?: boolean;
  topicFacts?: TopicWorkspaceFacts;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  canPin: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  reserveIdleStatusIndicatorSpace?: boolean;
  /**
   * Whether the row sits under a status header, which is what it indents from. Pinned rows
   * are a flat list under their own header and sit flush.
   */
  inStatusGroup?: boolean;
  onWorkspacePress?: () => void;
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}) {
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const selected =
    activeWorkspaceSelection?.serverId === workspace.serverId &&
    activeWorkspaceSelection?.workspaceId === workspace.workspaceId;

  const handlePress = useCallback(() => {
    if (!workspace.serverId) return;
    onWorkspacePress?.();
    navigateToWorkspace({ serverId: workspace.serverId, workspaceId: workspace.workspaceId });
  }, [onWorkspacePress, workspace.serverId, workspace.workspaceId]);

  return (
    <StatusWorkspaceRowWithMenu
      workspace={workspace}
      hostBadge={hostBadge}
      projectName={projectName}
      projectIconDataUri={projectIconDataUri}
      forceShowProject={forceShowProject}
      topicFacts={topicFacts}
      selected={selected}
      shortcutNumber={shortcutNumber}
      showShortcutBadge={showShortcutBadge}
      canPin={canPin}
      onToggleWorkspacePin={onToggleWorkspacePin}
      reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
      inStatusGroup={inStatusGroup}
      onPress={handlePress}
      drag={drag}
      isDragging={isDragging}
      dragHandleProps={dragHandleProps}
    />
  );
});

function canOfferMarkTopicCompleted(
  workspace: Pick<SidebarWorkspaceEntry, "statusBucket">,
  topicFacts: TopicWorkspaceFacts | undefined,
): boolean {
  if (!topicFacts?.isTopic || topicFacts.completedAt !== null) return false;
  const classification = deriveTopicStatusClassification(workspace, topicFacts);
  if (classification.isActivelyWorking) return false;
  return (
    classification.pendingReason !== "approval" &&
    classification.pendingReason !== "failed" &&
    classification.pendingReason !== "awaiting_first_prompt"
  );
}

function useTopicRowActions(
  workspace: SidebarWorkspaceEntry,
  topicFacts: TopicWorkspaceFacts | undefined,
  t: ReturnType<typeof useTranslation>["t"],
): {
  onMarkCompleted: (() => void) | undefined;
  onReopenTopic: (() => void) | undefined;
  pendingApprovalLabel: string | null;
} {
  const { workspaceKey } = workspace;
  const markTopicCompleted = useSidebarTopicCompletionStore((state) => state.markTopicCompleted);
  const reopenTopic = useSidebarTopicCompletionStore((state) => state.reopenTopic);
  const handleMarkCompleted = useCallback(() => {
    markTopicCompleted(workspaceKey);
  }, [markTopicCompleted, workspaceKey]);
  const handleReopenTopic = useCallback(() => {
    reopenTopic(workspaceKey);
  }, [reopenTopic, workspaceKey]);

  const isTopic = Boolean(topicFacts?.isTopic);
  const isTopicCompleted = Boolean(topicFacts?.completedAt);
  const pendingCount = (topicFacts?.pendingDurableCount ?? 0) + (topicFacts?.pendingTodoCount ?? 0);

  return {
    onMarkCompleted: canOfferMarkTopicCompleted(workspace, topicFacts)
      ? handleMarkCompleted
      : undefined,
    onReopenTopic: isTopic && isTopicCompleted ? handleReopenTopic : undefined,
    pendingApprovalLabel:
      pendingCount > 0
        ? t("topicWorkbench.sidebar.pendingApprovalCount", { count: pendingCount })
        : null,
  };
}

function StatusWorkspaceRowWithMenu({
  workspace,
  hostBadge,
  projectName,
  projectIconDataUri,
  forceShowProject = false,
  topicFacts,
  selected,
  shortcutNumber,
  showShortcutBadge,
  canPin,
  onToggleWorkspacePin,
  reserveIdleStatusIndicatorSpace = true,
  inStatusGroup = true,
  onPress,
  drag,
  isDragging = false,
  dragHandleProps,
}: {
  workspace: SidebarWorkspaceEntry;
  hostBadge: HostBadgeModel | null;
  projectName: string;
  projectIconDataUri: string | null;
  forceShowProject?: boolean;
  topicFacts?: TopicWorkspaceFacts;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  canPin: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  reserveIdleStatusIndicatorSpace?: boolean;
  /**
   * Whether the row sits under a status header, which is what it indents from. Pinned rows
   * are a flat list under their own header and sit flush.
   */
  inStatusGroup?: boolean;
  onPress: () => void;
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [isHidingWorkspace, setIsHidingWorkspace] = useState(false);
  const rename = useSidebarWorkspaceRename(workspace);
  const isArchiving = workspace.archivingAt !== null || isHidingWorkspace;

  const redirectAfterArchive = useCallback(() => {
    redirectIfArchivingActiveWorkspace({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
      activeWorkspaceSelection: selected
        ? { serverId: workspace.serverId, workspaceId: workspace.workspaceId }
        : null,
    });
  }, [selected, workspace]);

  const archiveController = useWorkspaceArchive({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
    workspaceKind: workspace.workspaceKind,
    workspaceDirectory: workspace.workspaceDirectory,
    name: workspace.name,
    diffStat: workspace.diffStat,
    onArchiveStarted: redirectAfterArchive,
    onSetHiding: setIsHidingWorkspace,
  });

  const handleArchive = useCallback(() => {
    if (isArchiving) return;
    archiveController.archive();
  }, [archiveController, isArchiving]);

  const clipboard = useWorkspaceClipboardActions();
  const handleCopyPath = useCallback(() => {
    clipboard.copyPath(workspace);
  }, [clipboard, workspace]);

  const handleCopyBranchName = useCallback(() => {
    clipboard.copyBranchName(workspace);
  }, [clipboard, workspace]);

  const isPinned = workspace.pinnedAt != null;
  const handleTogglePin = useCallback(() => {
    onToggleWorkspacePin(workspace);
  }, [onToggleWorkspacePin, workspace]);
  const onTogglePin = canPin ? handleTogglePin : undefined;

  const archiveShortcutKeys = useShortcutKeys("archive-workspace");
  const { hasClearableAttention, canMarkUnread, clearAttention, markUnread } =
    useWorkspaceReadState({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
    });
  const handleMarkAsRead = useCallback(() => {
    void clearAttention().catch((error) => {
      toast.error(error instanceof Error ? error.message : "Failed to mark workspace as read");
    });
  }, [clearAttention, toast]);
  const handleMarkAsUnread = useCallback(() => {
    void markUnread().catch((error) => {
      toast.error(error instanceof Error ? error.message : "Failed to mark workspace as unread");
    });
  }, [markUnread, toast]);

  const { onMarkCompleted, onReopenTopic, pendingApprovalLabel } = useTopicRowActions(
    workspace,
    topicFacts,
    t,
  );

  return (
    <>
      <StatusWorkspaceRowInner
        workspace={workspace}
        hostBadge={hostBadge}
        projectName={projectName}
        projectIconDataUri={projectIconDataUri}
        forceShowProject={forceShowProject}
        pendingApprovalLabel={pendingApprovalLabel}
        selected={selected}
        shortcutNumber={shortcutNumber}
        showShortcutBadge={showShortcutBadge}
        onPress={onPress}
        isArchiving={isArchiving}
        archiveLabel={t("sidebar.workspace.actions.archive")}
        archiveStatus={isArchiving ? "pending" : "idle"}
        archivePendingLabel={t("sidebar.workspace.actions.archiving")}
        onArchive={handleArchive}
        onCopyBranchName={workspace.projectKind === "git" ? handleCopyBranchName : undefined}
        onCopyPath={handleCopyPath}
        onRename={rename.begin}
        onMarkCompleted={onMarkCompleted}
        onReopenTopic={onReopenTopic}
        titleEditor={rename.titleEditor}
        onMarkAsRead={hasClearableAttention ? handleMarkAsRead : undefined}
        onMarkAsUnread={canMarkUnread ? handleMarkAsUnread : undefined}
        archiveShortcutKeys={selected ? archiveShortcutKeys : null}
        isPinned={isPinned}
        onTogglePin={onTogglePin}
        reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
        inStatusGroup={inStatusGroup}
        drag={drag}
        isDragging={isDragging}
        dragHandleProps={dragHandleProps}
      />
      {rename.modal}
    </>
  );
}

interface StatusWorkspaceRowInnerProps {
  workspace: SidebarWorkspaceEntry;
  hostBadge: HostBadgeModel | null;
  projectName: string;
  projectIconDataUri: string | null;
  forceShowProject?: boolean;
  pendingApprovalLabel?: string | null;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  onPress: () => void;
  isArchiving: boolean;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  onArchive?: () => void;
  onCopyBranchName?: () => void;
  onCopyPath?: () => void;
  onRename?: () => void;
  onMarkCompleted?: () => void;
  onReopenTopic?: () => void;
  /** Present while the row is renamed in place: the row stops pressing, dragging and hovering. */
  titleEditor?: ReactNode;
  onMarkAsRead?: () => void;
  onMarkAsUnread?: () => void;
  archiveShortcutKeys?: ShortcutKey[][] | null;
  isPinned?: boolean;
  onTogglePin?: () => void;
  reserveIdleStatusIndicatorSpace?: boolean;
  /** Pinned rows are flat under their own header; status-group rows indent from theirs. */
  inStatusGroup?: boolean;
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}

function StatusWorkspaceRowInner(props: StatusWorkspaceRowInnerProps) {
  if (props.drag) {
    return <DraggableStatusWorkspaceRowInner {...props} drag={props.drag} />;
  }
  return <StatusWorkspaceRowInnerContent {...props} />;
}

function DraggableStatusWorkspaceRowInner(
  props: StatusWorkspaceRowInnerProps & { drag: () => void },
) {
  const dragInteraction = useLongPressDragInteraction({
    drag: props.drag,
    menuController: null,
  });
  return <StatusWorkspaceRowInnerContent {...props} dragInteraction={dragInteraction} />;
}

function StatusWorkspaceRowInnerContent({
  workspace,
  hostBadge,
  projectName,
  projectIconDataUri,
  forceShowProject = false,
  pendingApprovalLabel = null,
  selected,
  shortcutNumber,
  showShortcutBadge,
  onPress,
  isArchiving,
  archiveLabel,
  archiveStatus = "idle",
  archivePendingLabel,
  onArchive,
  onCopyBranchName,
  onCopyPath,
  onRename,
  onMarkCompleted,
  onReopenTopic,
  titleEditor = null,
  onMarkAsRead,
  onMarkAsUnread,
  archiveShortcutKeys,
  isPinned,
  onTogglePin,
  reserveIdleStatusIndicatorSpace = true,
  inStatusGroup = true,
  isDragging = false,
  dragHandleProps,
  dragInteraction,
}: StatusWorkspaceRowInnerProps & {
  dragInteraction?: ReturnType<typeof useLongPressDragInteraction>;
}) {
  const isCompact = useIsCompactFormFactor();
  const isTouchPlatform = platformIsNative || isCompact;
  const [isHighlighted, setIsHighlighted] = useState(false);
  const trailing = useSidebarWorkspaceTrailing();
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};

  const isDesktop = !isTouchPlatform;
  const serviceSummary = isDesktop ? selectWorkspaceServiceSummary(workspace.scripts) : null;

  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const isEditingTitle = titleEditor !== null;
  const didLongPressRef = dragInteraction?.didLongPressRef;
  const startDragPress = dragInteraction?.handlePressIn;
  const moveDragPress = dragInteraction?.handleTouchMove;
  const endDragPress = dragInteraction?.handlePressOut;
  const { onPress: handlePress, feedback } = useWorkspaceRowPress({
    didLongPressRef,
    onPress,
    selected,
  });

  return (
    <SidebarWorkspaceRowFrame
      workspace={workspace}
      isDragging={isDragging}
      isEditingTitle={isEditingTitle}
    >
      {({ isHovered, contextMenuOpen, onContextMenuOpenChange, hoverHandlers }) => {
        const showShortcut = showShortcutBadge && shortcutNumber !== null;
        const {
          trailingPresentation,
          showKebab: showKebabInSlot,
          showArchiveButton,
          showScrim,
          renderSlot,
          reserveSlotWidth,
        } = resolveTrailingActionVisibility({
          workspace,
          trailing,
          hasArchiveAction: Boolean(onArchive),
          isHovered,
          isTouchPlatform,
          showShortcut,
        });
        const workspaceRowStyle = getStatusWorkspaceRowStyle({
          selected,
          isHovered,
          inStatusGroup,
          isDragging,
        });
        const backdrop = getSidebarRowBackdrop({ isDragging, isHighlighted, selected, isHovered });
        return (
          <View
            {...dragAttributes}
            {...(isEditingTitle ? null : dragHandleProps?.listeners)}
            ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
            style={styles.workspaceRowContainer}
            {...hoverHandlers}
          >
            <SidebarWorkspaceContextMenu
              contextMenuOpen={contextMenuOpen}
              onContextMenuOpenChange={onContextMenuOpenChange}
              workspace={workspace}
              leadingProjectName={projectName}
              hostBadgeLabel={hostBadge?.label}
              serviceSummary={serviceSummary}
              workspaceKey={workspace.workspaceKey}
              onCopyPath={onCopyPath}
              onCopyBranchName={onCopyBranchName}
              onRename={onRename}
              onMarkCompleted={onMarkCompleted}
              onReopenTopic={onReopenTopic}
              onMarkAsRead={onMarkAsRead}
              onMarkAsUnread={onMarkAsUnread}
              onArchive={onArchive}
              archiveLabel={archiveLabel}
              archiveStatus={archiveStatus}
              archivePendingLabel={archivePendingLabel}
              archiveShortcutKeys={archiveShortcutKeys}
              isPinned={isPinned}
              onTogglePin={onTogglePin}
              openInFileManagerPath={workspace.workspaceDirectory}
              disabled={isArchiving}
              enabled={!isEditingTitle}
              accessibilityRole="button"
              accessibilityState={accessibilityState}
              style={workspaceRowStyle}
              highlightStyle={isEditingTitle ? undefined : styles.workspaceRowPressed}
              onHighlightChange={setIsHighlighted}
              onPressIn={isEditingTitle ? undefined : startDragPress}
              onTouchMove={isEditingTitle ? undefined : moveDragPress}
              onPressOut={isEditingTitle ? undefined : endDragPress}
              onPress={isEditingTitle ? undefined : handlePress}
              testID={`sidebar-workspace-row-${workspace.workspaceKey}`}
            >
              <SidebarWorkspaceRowContent
                workspace={workspace}
                hostBadge={hostBadge}
                leadingProjectName={projectName}
                leadingProjectIconDataUri={projectIconDataUri}
                forceShowProject={forceShowProject}
                pendingApprovalLabel={pendingApprovalLabel}
                serviceSummary={serviceSummary}
                backdrop={backdrop}
                isHovered={isHovered}
                isLoading={isArchiving}
                shortcutNumber={shortcutNumber}
                showShortcutBadge={showShortcutBadge}
                reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
                titleEditor={titleEditor}
              >
                {renderSlot ? (
                  <StatusWorkspaceActionSlot
                    workspace={workspace}
                    backdrop={backdrop}
                    trailing={trailing}
                    trailingPresentation={trailingPresentation}
                    showKebab={showKebabInSlot}
                    showArchiveButton={showArchiveButton}
                    showScrim={showScrim}
                    reserveSlotWidth={reserveSlotWidth}
                    isPinned={isPinned}
                    onTogglePin={onTogglePin}
                    onCopyPath={onCopyPath}
                    onCopyBranchName={onCopyBranchName}
                    onRename={onRename}
                    onMarkCompleted={onMarkCompleted}
                    onReopenTopic={onReopenTopic}
                    onMarkAsRead={onMarkAsRead}
                    onMarkAsUnread={onMarkAsUnread}
                    onArchive={onArchive}
                    archiveLabel={archiveLabel}
                    archiveStatus={archiveStatus}
                    archivePendingLabel={archivePendingLabel}
                    archiveShortcutKeys={archiveShortcutKeys}
                  />
                ) : null}
              </SidebarWorkspaceRowContent>
              {feedback}
            </SidebarWorkspaceContextMenu>
          </View>
        );
      }}
    </SidebarWorkspaceRowFrame>
  );
}

function StatusWorkspaceActionSlot({
  workspace,
  backdrop,
  trailing,
  trailingPresentation,
  showKebab,
  showArchiveButton,
  showScrim,
  reserveSlotWidth,
  isPinned,
  onTogglePin,
  onCopyPath,
  onCopyBranchName,
  onRename,
  onMarkCompleted,
  onReopenTopic,
  onMarkAsRead,
  onMarkAsUnread,
  onArchive,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
}: {
  workspace: SidebarWorkspaceEntry;
  backdrop: SidebarSurfaceBackdrop;
  trailing: SidebarWorkspaceTrailing;
  trailingPresentation: SidebarWorkspaceTrailingPresentation;
  showKebab: boolean;
  showArchiveButton: boolean;
  showScrim: boolean;
  reserveSlotWidth: boolean;
  isPinned?: boolean;
  onTogglePin?: () => void;
  onCopyPath?: () => void;
  onCopyBranchName?: () => void;
  onRename?: () => void;
  onMarkCompleted?: () => void;
  onReopenTopic?: () => void;
  onMarkAsRead?: () => void;
  onMarkAsUnread?: () => void;
  onArchive?: () => void;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  archiveShortcutKeys?: ShortcutKey[][] | null;
}) {
  const kebab = useOpenKebabMenuVisibility(showKebab);
  return (
    <SidebarWorkspaceTrailingActionSlot reserveWidth={reserveSlotWidth}>
      <SidebarWorkspaceTrailingActionBase presentation={trailingPresentation}>
        <SidebarWorkspaceTrailingContent
          workspace={workspace}
          trailing={trailing}
          backdrop={backdrop}
        />
      </SidebarWorkspaceTrailingActionBase>
      <SidebarWorkspaceTrailingActionOverlay
        visible={kebab.showKebab}
        scrimBackdrop={showScrim ? backdrop : undefined}
        workspaceKey={workspace.workspaceKey}
        onArchiveButtonPress={showArchiveButton ? onArchive : undefined}
      >
        {kebab.showKebab && onArchive ? (
          <SidebarWorkspaceMenu
            {...kebab.menuProps}
            workspaceKey={workspace.workspaceKey}
            serverId={workspace.serverId}
            workspaceId={workspace.workspaceId}
            workspaceLabels={workspace.labels}
            onCopyPath={onCopyPath}
            onCopyBranchName={onCopyBranchName}
            onRename={onRename}
            onMarkCompleted={onMarkCompleted}
            onReopenTopic={onReopenTopic}
            onMarkAsRead={onMarkAsRead}
            onMarkAsUnread={onMarkAsUnread}
            onArchive={onArchive}
            archiveLabel={archiveLabel}
            archiveStatus={archiveStatus}
            archivePendingLabel={archivePendingLabel}
            archiveShortcutKeys={archiveShortcutKeys}
            isPinned={isPinned}
            onTogglePin={onTogglePin}
          />
        ) : null}
      </SidebarWorkspaceTrailingActionOverlay>
    </SidebarWorkspaceTrailingActionSlot>
  );
}

function getStatusWorkspaceRowStyle({
  selected,
  isHovered,
  inStatusGroup,
  isDragging,
}: {
  selected: boolean;
  isHovered: boolean;
  inStatusGroup: boolean;
  isDragging: boolean;
}) {
  return [
    styles.workspaceRow,
    inStatusGroup && sidebarWorkspaceRowStyles.rowIndented,
    isHovered && styles.workspaceRowHovered,
    selected && styles.sidebarRowSelected,
    isDragging && styles.workspaceRowDragging,
  ];
}

const styles = StyleSheet.create((theme) => ({
  pinnedSection: {
    marginBottom: theme.spacing[1],
  },
  // Matches `projectBlockExpanded` in sidebar-workspace-list.tsx. See the note there.
  statusGroupBlockExpanded: {
    paddingBottom: theme.spacing[3],
  },
  statusWorkspaceListContainer: {},
  statusGroupRow: {
    minHeight: density.rowHeight,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  statusGroupRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  statusGroupRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  statusGroupRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  statusGroupLeadingVisualSlot: {
    position: "relative",
    width: densityIconBox("md"),
    height: densityIconBox("md"),
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  statusGroupTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  statusGroupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    minWidth: 0,
    flexShrink: 1,
  },
  statusGroupCount: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
  workspaceRowContainer: {
    position: "relative",
  },
  workspaceRow: {
    minHeight: density.rowHeight,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "flex-start",
    gap: theme.spacing[1],
    userSelect: "none",
  },
  workspaceRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  workspaceRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  workspaceRowDragging: {
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    transform: [{ scale: 1.02 }],
    zIndex: 3,
    ...theme.shadow.md,
  },
  sidebarRowSelected: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
  },
}));
