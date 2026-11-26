import { Check, Clock, Plus, Square } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SidebarGroupToggleRow } from "@/components/sidebar/sidebar-group-toggle-row";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { DurableItemCard } from "@/durable-items/card";
import { durableItemKey, type HostedDurableItem } from "@/durable-items/model";
import { useGlobalDurableItems } from "@/durable-items/queries";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { buildTopicAgentKey, useTopicStreamViewStore } from "@/stores/topic-stream-view-store";
import { density } from "@/styles/density";
import type { Theme } from "@/styles/theme";
import { formatTodoDueTimestamp, isTodoOverdue, type HostedWorkspaceTodoItem } from "@/todos/model";
import { useGlobalTodos, useSetWorkspaceTodoStatus } from "@/todos/queries";
import { navigateToAgent } from "@/utils/navigate-to-agent";

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const ThemedPlus = withUnistyles(Plus, mutedIconMapping);
const ThemedSquare = withUnistyles(Square, mutedIconMapping);
const ThemedCheck = withUnistyles(Check, successIconMapping);
const ThemedClock = withUnistyles(Clock, dangerIconMapping);
const CHECKED_STATE = { checked: true } as const;
const UNCHECKED_STATE = { checked: false } as const;

const VISIBLE_ROWS = 5;

function keyFor({ serverId, item }: HostedDurableItem): string {
  return durableItemKey({ serverId, workspaceId: item.workspaceId, requestId: item.requestId });
}

export function SidebarDurableItemsSection() {
  const { t } = useTranslation();
  const { items, labels, incomplete, checking, canRefresh, refresh } = useGlobalDurableItems();
  const { items: todoItems, labels: todoLabels, anySupported: supportsTodos } = useGlobalTodos();
  const activeWorkspace = useActiveWorkspaceSelection();
  const openTodoEditor = useTopicStreamViewStore((state) => state.openTodoEditor);
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
  const handleQuickCreateTodo = useCallback(() => {
    if (!activeWorkspace) return;
    openTodoEditor({
      serverId: activeWorkspace.serverId,
      workspaceId: activeWorkspace.workspaceId,
    });
  }, [activeWorkspace, openTodoEditor]);

  const totalCount = items.length + todoItems.length;
  if (totalCount === 0 && !incomplete && !selection) return null;

  const selectedKey = selection ? keyFor(selection) : null;
  const visible = expanded ? items : items.slice(0, VISIBLE_ROWS);
  const remainingSlots = expanded ? todoItems.length : Math.max(0, VISIBLE_ROWS - visible.length);
  const visibleTodos = expanded ? todoItems : todoItems.slice(0, Math.max(remainingSlots, 3));
  const selected = selection && (items.find((item) => keyFor(item) === selectedKey) ?? selection);
  const sectionTitle =
    todoItems.length > 0
      ? t("topicWorkbench.todos.sidebarActionInbox", { count: totalCount })
      : t("topicWorkbench.durableItems.inbox", { count: items.length });

  return (
    <View style={styles.section} testID="sidebar-durable-items-section">
      <SidebarSectionHeader
        title={sectionTitle}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        testID="sidebar-durable-items-section-header"
      >
        {supportsTodos && activeWorkspace ? (
          <ToolbarButton
            compact
            label={t("topicWorkbench.todos.addTodo")}
            onPress={handleQuickCreateTodo}
            testID="sidebar-durable-items-add-todo"
          >
            <ThemedPlus size={14} />
          </ToolbarButton>
        ) : null}
      </SidebarSectionHeader>
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
          {visibleTodos.map((row) => (
            <SidebarTodoItemRow
              key={`${row.serverId}:${row.item.todoId}`}
              row={row}
              hostLabel={todoLabels.get(row.serverId) ?? row.serverId}
            />
          ))}
          {items.length > VISIBLE_ROWS || todoItems.length > visibleTodos.length ? (
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

function SidebarTodoItemRow({
  row,
  hostLabel,
}: {
  row: HostedWorkspaceTodoItem;
  hostLabel: string;
}) {
  const { i18n } = useTranslation();
  const { serverId, item } = row;
  const setStatusMutation = useSetWorkspaceTodoStatus(serverId);
  const workspaceName = useSessionStore((state) => {
    const workspace = state.sessions[serverId]?.workspaces.get(item.workspaceId);
    return workspace?.title || workspace?.name || item.workspaceId;
  });
  const overdue = isTodoOverdue(item);
  const completed = item.status === "completed";

  const handleToggle = useCallback(() => {
    setStatusMutation.mutate({
      workspaceId: item.workspaceId,
      todoId: item.todoId,
      expectedRevision: item.revision,
      status: completed ? "pending" : "completed",
    });
  }, [completed, item.revision, item.todoId, item.workspaceId, setStatusMutation]);

  const handleOpen = useCallback(() => {
    if (item.source?.mainAgentId) {
      const store = useTopicStreamViewStore.getState();
      const agentKey = buildTopicAgentKey(serverId, item.source.mainAgentId);
      store.setViewMode(agentKey, "topics");
      store.requestScrollToTopic(agentKey, item.source.topicKey, true, {
        taskId: item.source.taskId,
        rootMessageId: item.source.rootMessageId,
      });
      navigateToAgent({
        serverId,
        agentId: item.source.mainAgentId,
        workspaceId: item.workspaceId,
        asTab: true,
      });
      return;
    }
    useTopicStreamViewStore.getState().openTodoEditor({
      serverId,
      workspaceId: item.workspaceId,
      existingTodo: item,
    });
  }, [item, serverId]);

  return (
    <View style={styles.todoRowContainer} testID={`sidebar-todo-row-${item.todoId}`}>
      <PressHighlight
        accessibilityRole="checkbox"
        accessibilityState={completed ? CHECKED_STATE : UNCHECKED_STATE}
        onPress={handleToggle}
        style={styles.todoCheckSlot}
        testID={`sidebar-todo-toggle-${item.todoId}`}
      >
        {completed ? <ThemedCheck size={14} /> : <ThemedSquare size={14} />}
      </PressHighlight>
      <PressHighlight
        accessibilityRole="button"
        accessibilityLabel={`${item.title}, ${workspaceName}, ${hostLabel}`}
        onPress={handleOpen}
        style={styles.todoContentButton}
        highlightStyle={styles.rowOpen}
      >
        <Text style={styles.title} numberOfLines={1}>
          {item.title}
        </Text>
        <View style={styles.todoMetaLine}>
          <Text style={styles.meta} numberOfLines={1}>
            {workspaceName}
          </Text>
          {item.dueAt ? (
            <View style={styles.todoDueChip}>
              {overdue ? <ThemedClock size={11} /> : null}
              <Text style={[styles.meta, overdue && styles.overdueMeta]} numberOfLines={1}>
                {formatTodoDueTimestamp(item.dueAt, i18n.resolvedLanguage)}
              </Text>
            </View>
          ) : null}
        </View>
      </PressHighlight>
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
  todoRowContainer: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: theme.spacing[1.5],
    gap: theme.spacing[1],
  },
  todoCheckSlot: {
    padding: theme.spacing[1.5],
    marginTop: 2,
    borderRadius: theme.borderRadius.sm,
  },
  todoContentButton: {
    flex: 1,
    minWidth: 0,
    minHeight: density.rowHeight,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.lg,
  },
  todoMetaLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  todoDueChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0.5],
    flexShrink: 0,
  },
  overdueMeta: {
    color: theme.colors.statusDanger,
    fontWeight: theme.fontWeight.medium,
  },
}));
