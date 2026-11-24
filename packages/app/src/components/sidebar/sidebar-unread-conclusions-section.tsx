import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Check, CheckCheck } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { SidebarGroupToggleRow } from "@/components/sidebar/sidebar-group-toggle-row";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import {
  areSidebarAttentionItemsEqual,
  selectSidebarUnreadConclusions,
  type SidebarAttentionItem,
} from "@/components/sidebar/sidebar-unread-conclusions";
import { useLimitedSidebarGroup } from "@/components/sidebar/use-limited-sidebar-group";
import { mutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { useSidebarRowItems } from "@/components/sidebar/display-preferences/model";
import { HostBadge } from "@/hosts/host-badge";
import { useHostBadges } from "@/hosts/use-host-badges";
import type { HostBadgeModel } from "@/hosts/appearance";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { density, densityIconBox } from "@/styles/density";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";

const ThemedCheck = withUnistyles(Check);
const ThemedCheckCheck = withUnistyles(CheckCheck);

const UNREAD_CONCLUSIONS_POLICY = { kind: "unreadConclusions" } as const;

// The title's line height, shared with the dot so the dot centres on the first line.
const TITLE_LINE_HEIGHT = 20;

export function useSidebarUnreadConclusions(): SidebarAttentionItem[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectSidebarUnreadConclusions(state.sessions),
    areSidebarAttentionItemsEqual,
  );
}

/**
 * Marks every item read on its own host. One host being offline or rejecting the call must not
 * stop the others, so each call settles independently.
 */
export async function clearSidebarAttention(items: readonly SidebarAttentionItem[]): Promise<void> {
  const runtime = getHostRuntimeStore();
  await Promise.allSettled(
    items.map(async (item) => {
      const client = runtime.getSnapshot(item.serverId)?.client;
      if (client) await client.clearAgentAttention(item.agentId);
    }),
  );
}

export interface SidebarUnreadConclusionsSectionProps {
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  /** Closes the drawer or mobile panel before the conversation opens. */
  onWorkspacePress?: () => void;
}

/**
 * The "Unread conclusions" section that sits above Pinned in both sidebar groupings. It renders
 * nothing, not even a gap, while there is nothing to read.
 */
export function SidebarUnreadConclusionsSection(props: SidebarUnreadConclusionsSectionProps) {
  const items = useSidebarUnreadConclusions();
  if (items.length === 0) return null;
  return <UnreadConclusionsContent items={items} {...props} />;
}

function UnreadConclusionsContent({
  items,
  hostBadgeByServerId,
  onWorkspacePress,
}: SidebarUnreadConclusionsSectionProps & { items: SidebarAttentionItem[] }) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const rowItems = useSidebarRowItems();
  const hasMultipleItemHosts = useMemo(() => {
    let firstServerId: string | null = null;
    for (const item of items) {
      if (firstServerId === null) {
        firstServerId = item.serverId;
      } else if (item.serverId !== firstServerId) {
        return true;
      }
    }
    return false;
  }, [items]);
  // Unread conclusions span every host even when the workspace list below is filtered to one host.
  // Enable badges whenever the section itself mixes hosts (respecting the user's host badge toggle).
  const sectionHostBadgeByServerId = useHostBadges({
    enabled: rowItems.host && hasMultipleItemHosts,
  });
  const effectiveHostBadgeByServerId =
    hostBadgeByServerId.size > 0 ? hostBadgeByServerId : sectionHostBadgeByServerId;
  const collapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedUnreadConclusions);
  const toggleCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleUnreadConclusionsCollapsed,
  );
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);
  const { visibleItems, canToggle } = useLimitedSidebarGroup({
    items,
    selection: null,
    expanded,
    policy: UNREAD_CONCLUSIONS_POLICY,
  });
  const handleMarkAllRead = useCallback(() => {
    void clearSidebarAttention(items);
  }, [items]);

  return (
    <View style={styles.section} testID="sidebar-unread-conclusions-section">
      <SidebarSectionHeader
        title={t("sidebar.unreadConclusions.title")}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        testID="sidebar-unread-conclusions-header"
      >
        <ToolbarButton
          label={t("sidebar.unreadConclusions.markAllRead")}
          compact
          onPress={handleMarkAllRead}
          testID="sidebar-unread-conclusions-mark-all-read"
        >
          <ThemedCheckCheck
            size={paneContentToolbarIconSize(isCompact)}
            uniProps={mutedIconColorMapping}
          />
        </ToolbarButton>
      </SidebarSectionHeader>
      {collapsed ? null : (
        <>
          {visibleItems.map((item) => (
            <UnreadConclusionRow
              key={`${item.serverId}:${item.agentId}`}
              item={item}
              hostBadge={effectiveHostBadgeByServerId.get(item.serverId) ?? null}
              onWorkspacePress={onWorkspacePress}
            />
          ))}
          {canToggle ? (
            <SidebarGroupToggleRow
              expanded={expanded}
              onPress={toggleExpanded}
              testID="sidebar-unread-conclusions-show-more"
            />
          ) : null}
        </>
      )}
    </View>
  );
}

const UnreadConclusionRow = memo(function UnreadConclusionRow({
  item,
  hostBadge,
  onWorkspacePress,
}: {
  item: SidebarAttentionItem;
  hostBadge: HostBadgeModel | null;
  onWorkspacePress?: () => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const [isActionFocused, setIsActionFocused] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleActionFocus = useCallback(() => setIsActionFocused(true), []);
  const handleActionBlur = useCallback(() => setIsActionFocused(false), []);
  const rowKey = `${item.serverId}-${item.agentId}`;

  const handlePress = useCallback(() => {
    onWorkspacePress?.();
    navigateToAgent({
      serverId: item.serverId,
      agentId: item.agentId,
      workspaceId: item.workspaceId,
      asTab: true,
    });
  }, [item.agentId, item.serverId, item.workspaceId, onWorkspacePress]);
  const handleMarkRead = useCallback(() => {
    void clearSidebarAttention([item]);
  }, [item]);

  const meta =
    item.projectName && item.projectName !== item.workspaceName
      ? `${item.projectName} / ${item.workspaceName}`
      : item.workspaceName;
  const actionVisible = isHovered || isActionFocused || isNative || isCompact;

  return (
    <View
      style={styles.rowContainer}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID={`sidebar-unread-conclusion-row-${rowKey}`}
    >
      <PressHighlight
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={`${item.title}, ${meta}`}
        onPress={handlePress}
        style={isHovered ? [styles.row, styles.rowHovered] : styles.row}
        highlightStyle={styles.rowPressed}
        testID={`sidebar-unread-conclusion-press-${rowKey}`}
      >
        <View style={styles.dotSlot}>
          <View style={styles.dot} />
        </View>
        <View style={styles.content}>
          <View style={styles.titleRow}>
            <Text style={styles.title} numberOfLines={1}>
              {item.title}
            </Text>
            <ConclusionTimestamp timestampMs={item.timestampMs} />
            <View style={styles.actionSlot} />
          </View>
          <View style={styles.metaRow}>
            <Text style={styles.meta} numberOfLines={1}>
              {meta}
            </Text>
            {hostBadge ? <HostBadge badge={hostBadge} /> : null}
          </View>
        </View>
      </PressHighlight>
      <View
        style={actionVisible ? styles.actionOverlay : styles.actionOverlayHidden}
        pointerEvents={actionVisible ? "auto" : "none"}
        testID={`sidebar-unread-conclusion-mark-read-overlay-${rowKey}`}
      >
        <ToolbarButton
          label={t("sidebar.unreadConclusions.markRead")}
          compact
          onPress={handleMarkRead}
          onFocus={handleActionFocus}
          onBlur={handleActionBlur}
          testID={`sidebar-unread-conclusion-mark-read-${rowKey}`}
        >
          <ThemedCheck
            size={paneContentToolbarIconSize(isCompact)}
            uniProps={mutedIconColorMapping}
          />
        </ToolbarButton>
      </View>
    </View>
  );
});

// The clock stops here, so a minute tick re-renders one Text and not the row.
function ConclusionTimestamp({ timestampMs }: { timestampMs: number }) {
  const date = useMemo(() => new Date(timestampMs), [timestampMs]);
  const label = useCompactTimeAgo(date);
  return (
    <Text style={styles.timestamp} numberOfLines={1}>
      {label}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    marginBottom: theme.spacing[1],
  },
  // Hover lives on this plain View; the press lives on the inner PressHighlight (docs/hover.md).
  rowContainer: {
    position: "relative",
  },
  // Kept in step with the workspace row's geometry so the section reads as the same list.
  row: {
    minHeight: density.rowHeight,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  dotSlot: {
    width: densityIconBox("md"),
    height: TITLE_LINE_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  dot: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: getStatusDotColor({ theme, bucket: "attention" }) ?? undefined,
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    lineHeight: TITLE_LINE_HEIGHT,
    flex: 1,
    minWidth: 0,
  },
  timestamp: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: TITLE_LINE_HEIGHT,
    flexShrink: 0,
  },
  // Holds the mark-read button's width, so revealing it never moves the title or the time.
  actionSlot: {
    width: theme.spacing[6],
    flexShrink: 0,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
    minWidth: 0,
  },
  actionOverlay: {
    position: "absolute",
    top: theme.spacing[1],
    right: theme.spacing[1],
    opacity: 1,
  },
  actionOverlayHidden: {
    position: "absolute",
    top: theme.spacing[1],
    right: theme.spacing[1],
    opacity: 0,
  },
}));
