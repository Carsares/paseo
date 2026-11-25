import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Check, CheckCheck, Send } from "lucide-react-native";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { DurableItemCard } from "@/durable-items/card";
import {
  useTopicInboxReadStore,
  type MarkAllInboxReadSnapshot,
} from "@/stores/topic-inbox-read-store";
import type { Theme } from "@/styles/theme";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { useOptionalTeamMessageJumpStore } from "./message-jump-store";
import type { TeamDirectoryMessagesProjection, TeamInboxMessageItem } from "./messages-model";

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedCheck = withUnistyles(Check, mutedIconMapping);
const ThemedCheckCheck = withUnistyles(CheckCheck, mutedIconMapping);
const ThemedSend = withUnistyles(Send, mutedIconMapping);

function resolveToneStyle(tone: SidebarStateBucket) {
  switch (tone) {
    case "needs_input":
      return styles.dotNeedsInput;
    case "failed":
      return styles.dotFailed;
    case "running":
      return styles.dotRunning;
    case "attention":
      return styles.dotAttention;
    default:
      return styles.dotDone;
  }
}

export interface DirectoryMessagesViewProps {
  serverId: string;
  workspaceId: string;
  mainAgentId: string | null;
  readScopeKey: string;
  client: DaemonClient | null;
  projection: TeamDirectoryMessagesProjection;
  onFocusAgentById: (agentId: string) => void;
}

export const DirectoryMessagesView = memo(function DirectoryMessagesView({
  serverId,
  workspaceId,
  mainAgentId,
  readScopeKey,
  client,
  projection,
  onFocusAgentById,
}: DirectoryMessagesViewProps) {
  const { t } = useTranslation();
  const markItemRead = useTopicInboxReadStore((state) => state.markItemRead);
  const markAllRead = useTopicInboxReadStore((state) => state.markAllRead);
  const jumpStore = useOptionalTeamMessageJumpStore();
  const [expandedDurableId, setExpandedDurableId] = useState<string | null>(null);
  const [flushingInbox, setFlushingInbox] = useState(false);

  const handleFlushInbox = useCallback(() => {
    if (!client || !mainAgentId || flushingInbox) return;
    setFlushingInbox(true);
    void client
      .flushAgentInbox(mainAgentId)
      .catch(() => undefined)
      .finally(() => setFlushingInbox(false));
  }, [client, flushingInbox, mainAgentId]);

  const handleMarkAllRead = useCallback(
    (snapshot: MarkAllInboxReadSnapshot, hasUnreadMainConclusion: boolean) => {
      markAllRead(readScopeKey, snapshot);
      if (hasUnreadMainConclusion && client) {
        void client.clearWorkspaceAttention?.(workspaceId)?.catch(() => undefined);
      }
    },
    [client, markAllRead, readScopeKey, workspaceId],
  );

  const hasMarkableUnread = (projection.markAllSnapshot.itemIds?.length ?? 0) > 0;
  const hasUnreadMainConclusion = projection.unread.some((item) => item.kind === "main_conclusion");
  const onMarkAllPress = useCallback(() => {
    handleMarkAllRead(projection.markAllSnapshot, hasUnreadMainConclusion);
  }, [handleMarkAllRead, hasUnreadMainConclusion, projection.markAllSnapshot]);

  const handleSelectItem = useCallback(
    (item: TeamInboxMessageItem) => {
      if (item.kind === "durable_item") {
        setExpandedDurableId((current) => (current === item.id ? null : item.id));
        return;
      }
      if (item.readCandidate) {
        markItemRead(readScopeKey, item.readCandidate.id, item.mainConclusionSnapshot);
      }
      if (item.kind === "main_conclusion" && client) {
        void client.clearWorkspaceAttention?.(workspaceId)?.catch(() => undefined);
      }
      if (item.targetAgentId) {
        onFocusAgentById(item.targetAgentId);
      }
      if (item.jumpTarget) {
        jumpStore?.requestJump({
          serverId,
          ...item.jumpTarget,
        });
      }
    },
    [client, jumpStore, markItemRead, onFocusAgentById, readScopeKey, serverId, workspaceId],
  );

  const handleMarkSingleRead = useCallback(
    (item: TeamInboxMessageItem) => {
      if (item.readCandidate) {
        markItemRead(readScopeKey, item.readCandidate.id, item.mainConclusionSnapshot);
      }
      if (item.kind === "main_conclusion" && client) {
        void client.clearWorkspaceAttention?.(workspaceId)?.catch(() => undefined);
      }
    },
    [client, markItemRead, readScopeKey, workspaceId],
  );

  if (projection.unread.length === 0 && projection.read.length === 0) {
    return (
      <View style={styles.emptyCard} testID="team-directory-messages-empty">
        <Text style={styles.emptyTitle}>{t("topicWorkbench.directory.messagesEmptyTitle")}</Text>
        <Text style={styles.emptyDescription}>
          {t("topicWorkbench.directory.messagesEmptyDescription")}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="team-directory-messages-view">
      <View style={styles.section} testID="team-directory-unread-section">
        <View style={styles.sectionHeader}>
          <Text accessibilityRole="header" numberOfLines={1} style={styles.sectionTitle}>
            {t("topicWorkbench.directory.unreadSection", { count: projection.unread.length })}
          </Text>
          <View style={styles.headerActions}>
            {projection.hasPendingInboxToFlush ? (
              <ToolbarButton
                compact
                disabled={flushingInbox}
                label={t("topicWorkbench.directory.flushPendingInbox")}
                onPress={handleFlushInbox}
                testID="team-directory-flush-inbox"
              >
                <ThemedSend size={13} />
              </ToolbarButton>
            ) : null}
            {hasMarkableUnread ? (
              <ToolbarButton
                compact
                label={t("topicWorkbench.directory.markAllRead")}
                onPress={onMarkAllPress}
                testID="team-directory-mark-all-read"
              >
                <ThemedCheckCheck size={14} />
              </ToolbarButton>
            ) : null}
          </View>
        </View>

        {projection.unread.length === 0 ? (
          <Text style={styles.emptySectionHint}>
            {t("topicWorkbench.directory.unreadEmptyHint")}
          </Text>
        ) : (
          projection.unread.map((item) => (
            <MessageItemRow
              key={item.id}
              serverId={serverId}
              item={item}
              expandedDurable={expandedDurableId === item.id}
              onPress={handleSelectItem}
              onMarkRead={item.readCandidate ? handleMarkSingleRead : undefined}
            />
          ))
        )}
      </View>

      {projection.read.length > 0 ? (
        <View style={styles.section} testID="team-directory-read-section">
          <View style={styles.sectionHeader}>
            <Text accessibilityRole="header" numberOfLines={1} style={styles.sectionTitle}>
              {t("topicWorkbench.directory.readSection", { count: projection.read.length })}
            </Text>
          </View>
          {projection.read.map((item) => (
            <MessageItemRow
              key={item.id}
              serverId={serverId}
              item={item}
              expandedDurable={expandedDurableId === item.id}
              onPress={handleSelectItem}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
});

const MessageItemRow = memo(function MessageItemRow({
  serverId,
  item,
  expandedDurable,
  onPress,
  onMarkRead,
}: {
  serverId: string;
  item: TeamInboxMessageItem;
  expandedDurable: boolean;
  onPress: (item: TeamInboxMessageItem) => void;
  onMarkRead?: (item: TeamInboxMessageItem) => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handlePress = useCallback(() => onPress(item), [item, onPress]);
  const handleMarkRead = useCallback(() => onMarkRead?.(item), [item, onMarkRead]);
  const handleCloseDurable = useCallback(() => onPress(item), [item, onPress]);
  const showAction = Boolean(onMarkRead) && (isHovered || isNative || isCompact);
  const tagLabel = t(item.tagI18nKey);
  const expandedState = useMemo(
    () => (item.kind === "durable_item" ? { expanded: expandedDurable } : undefined),
    [expandedDurable, item.kind],
  );

  return (
    <View style={styles.itemBlock}>
      <View
        style={[styles.rowOuter, isHovered && styles.rowOuterHovered]}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <PressHighlight
          accessibilityRole="button"
          accessibilityLabel={`${item.senderTitle}, ${tagLabel}, ${item.preview}`}
          accessibilityState={expandedState}
          style={styles.row}
          highlightStyle={styles.rowHighlight}
          onPress={handlePress}
          testID={`team-directory-message-${item.id}`}
        >
          <View style={styles.topLine}>
            <View style={[styles.dot, resolveToneStyle(item.tone)]} />
            <Text numberOfLines={1} style={item.isRead ? styles.senderRead : styles.senderUnread}>
              {item.senderTitle}
            </Text>
            {!showAction ? (
              <Text numberOfLines={1} style={styles.tagText}>
                {tagLabel}
              </Text>
            ) : null}
          </View>
          {item.preview ? (
            <Text numberOfLines={2} style={item.isRead ? styles.previewRead : styles.previewUnread}>
              {item.preview}
            </Text>
          ) : null}
        </PressHighlight>
        {onMarkRead ? (
          <View
            style={[styles.actionSlot, showAction ? styles.actionVisible : styles.actionHidden]}
            pointerEvents={showAction ? "auto" : "none"}
          >
            <ToolbarButton
              compact
              label={t("topicWorkbench.directory.markItemRead")}
              onPress={handleMarkRead}
              testID={`team-directory-mark-read-${item.id}`}
            >
              <ThemedCheck size={13} />
            </ToolbarButton>
          </View>
        ) : null}
      </View>
      {expandedDurable && item.durableItem ? (
        <View style={styles.durableDetail}>
          <DurableItemCard serverId={serverId} item={item.durableItem} />
          <Button size="sm" variant="ghost" onPress={handleCloseDurable}>
            {t("topicWorkbench.durableItems.closeDetails")}
          </Button>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
  },
  section: {
    gap: theme.spacing[0.5],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 28,
    paddingHorizontal: theme.spacing[1.5],
    gap: theme.spacing[1],
  },
  sectionTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0.5],
  },
  emptyCard: {
    marginTop: theme.spacing[2],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    gap: theme.spacing[1],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptySectionHint: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  itemBlock: {
    gap: theme.spacing[1],
  },
  rowOuter: {
    position: "relative",
    flexDirection: "row",
    alignItems: "flex-start",
    borderRadius: theme.borderRadius.md,
  },
  rowOuterHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  row: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[1.5],
    gap: 2,
    borderRadius: theme.borderRadius.md,
  },
  rowHighlight: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  topLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
  },
  senderUnread: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  senderRead: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  tagText: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  previewUnread: {
    paddingLeft: theme.spacing[3],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  previewRead: {
    paddingLeft: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  actionSlot: {
    paddingTop: 2,
    paddingRight: 2,
    flexShrink: 0,
  },
  actionVisible: {
    opacity: 1,
  },
  actionHidden: {
    opacity: 0,
  },
  durableDetail: {
    paddingHorizontal: theme.spacing[1.5],
    gap: theme.spacing[1],
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
  },
  dotNeedsInput: {
    backgroundColor:
      getStatusDotColor({ theme, bucket: "needs_input", showDoneAsInactive: true }) ??
      theme.colors.border,
  },
  dotFailed: {
    backgroundColor:
      getStatusDotColor({ theme, bucket: "failed", showDoneAsInactive: true }) ??
      theme.colors.border,
  },
  dotRunning: {
    backgroundColor:
      getStatusDotColor({ theme, bucket: "running", showDoneAsInactive: true }) ??
      theme.colors.border,
  },
  dotAttention: {
    backgroundColor:
      getStatusDotColor({ theme, bucket: "attention", showDoneAsInactive: true }) ??
      theme.colors.border,
  },
  dotDone: {
    backgroundColor:
      getStatusDotColor({ theme, bucket: "done", showDoneAsInactive: true }) ?? theme.colors.border,
  },
}));
