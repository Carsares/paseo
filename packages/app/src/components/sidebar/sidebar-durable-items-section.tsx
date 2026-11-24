import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SidebarGroupToggleRow } from "@/components/sidebar/sidebar-group-toggle-row";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { DurableItemCard } from "@/durable-items/card";
import { durableItemKey, type HostedDurableItem } from "@/durable-items/model";
import { useGlobalDurableItems } from "@/durable-items/queries";
import { useSessionStore } from "@/stores/session-store";
import { density } from "@/styles/density";

const VISIBLE_ROWS = 5;

function keyFor({ serverId, item }: HostedDurableItem): string {
  return durableItemKey({ serverId, workspaceId: item.workspaceId, requestId: item.requestId });
}

export function SidebarDurableItemsSection() {
  const { t } = useTranslation();
  const { items, labels, incomplete, checking, canRefresh, refresh } = useGlobalDurableItems();
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [selection, selectItem] = useState<HostedDurableItem | null>(null);
  const toggleCollapsed = useCallback(() => setCollapsed((value) => !value), []);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const closeDetails = useCallback(() => selectItem(null), []);
  const toggleDetails = useCallback(
    (row: HostedDurableItem) =>
      selectItem((previous) => (previous && keyFor(previous) === keyFor(row) ? null : row)),
    [],
  );
  if (items.length === 0 && !incomplete && !selection) return null;

  const selectedKey = selection ? keyFor(selection) : null;
  const visible = expanded ? items : items.slice(0, VISIBLE_ROWS);
  const selected = selection && (items.find((item) => keyFor(item) === selectedKey) ?? selection);
  return (
    <View style={styles.section} testID="sidebar-durable-items-section">
      <SidebarSectionHeader
        title={t("topicWorkbench.durableItems.inbox", { count: items.length })}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        testID="sidebar-durable-items-section-header"
      />
      {collapsed ? null : (
        <>
          {incomplete ? (
            <Text style={styles.status} accessibilityLiveRegion="polite">
              {t(
                checking
                  ? "topicWorkbench.durableItems.inboxLoading"
                  : "topicWorkbench.durableItems.inboxPartial",
              )}
            </Text>
          ) : null}
          {canRefresh ? (
            <Button size="sm" variant="ghost" onPress={refresh}>
              {t("topicWorkbench.durableItems.refresh")}
            </Button>
          ) : null}
          {visible.map((row) => {
            const key = keyFor(row);
            const open = key === selectedKey;
            return (
              <SidebarDurableItemRow
                key={key}
                row={row}
                hostLabel={labels.get(row.serverId) ?? row.serverId}
                open={open}
                onPress={toggleDetails}
              />
            );
          })}
          {items.length > VISIBLE_ROWS ? (
            <SidebarGroupToggleRow
              expanded={expanded}
              onPress={toggleExpanded}
              testID="sidebar-durable-items-show-more"
            />
          ) : null}
          {selected ? (
            <View style={styles.detail}>
              <DurableItemCard
                key={keyFor(selected)}
                serverId={selected.serverId}
                item={selected.item}
              />
              <Button size="sm" variant="ghost" onPress={closeDetails}>
                {t("topicWorkbench.durableItems.closeDetails")}
              </Button>
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

function SidebarDurableItemRow({
  row,
  hostLabel,
  open,
  onPress,
}: {
  row: HostedDurableItem;
  hostLabel: string;
  open: boolean;
  onPress: (row: HostedDurableItem) => void;
}) {
  const { serverId, item } = row;
  const handlePress = useCallback(() => onPress(row), [onPress, row]);
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  const workspaceName = useSessionStore((state) => {
    const workspace = state.sessions[serverId]?.workspaces.get(item.workspaceId);
    return workspace?.title || workspace?.name || item.workspaceId;
  });

  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${workspaceName}, ${hostLabel}`}
      accessibilityState={accessibilityState}
      onPress={handlePress}
      style={open ? [styles.row, styles.rowOpen] : styles.row}
      highlightStyle={styles.rowOpen}
      testID="sidebar-durable-item-row"
    >
      <Text style={styles.title} numberOfLines={1}>
        {item.title}
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        {workspaceName} · {hostLabel}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    marginBottom: theme.spacing[1],
  },
  row: {
    minHeight: density.rowHeight,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowOpen: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  detail: {
    paddingHorizontal: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
}));
