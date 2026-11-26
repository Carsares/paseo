import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  WorkspaceDurableItem,
  WorkspaceTodoChecklistItem,
  WorkspaceTodoItem,
} from "@getpaseo/protocol/messages";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  CornerUpLeft,
  Pencil,
  Plus,
  Square,
} from "lucide-react-native";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HoverEnvelope } from "@/agent-stream/topic-card/hover-envelope";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { DurableItemCard } from "@/durable-items/card";
import { buildTopicAgentKey, useTopicStreamViewStore } from "@/stores/topic-stream-view-store";
import type { Theme } from "@/styles/theme";
import {
  buildSnoozeOneHourIso,
  computeTodoChecklistProgress,
  formatTodoDueTimestamp,
  groupWorkspaceTodos,
  isTodoOverdue,
} from "@/todos/model";
import {
  useSetWorkspaceTodoStatus,
  useUpsertWorkspaceTodo,
  useWorkspaceTodos,
} from "@/todos/queries";
import { generateMessageId } from "@/types/stream";

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const ThemedPlus = withUnistyles(Plus, mutedIconMapping);
const ThemedSquare = withUnistyles(Square, mutedIconMapping);
const ThemedCheck = withUnistyles(Check, successIconMapping);
const ThemedClock = withUnistyles(Clock, dangerIconMapping);
const ThemedCornerUpLeft = withUnistyles(CornerUpLeft, mutedIconMapping);
const ThemedBot = withUnistyles(Bot, mutedIconMapping);
const ThemedPencil = withUnistyles(Pencil, mutedIconMapping);
const ThemedChevronDown = withUnistyles(ChevronDown, mutedIconMapping);
const ThemedChevronRight = withUnistyles(ChevronRight, mutedIconMapping);

const CHECKED_STATE = { checked: true } as const;
const UNCHECKED_STATE = { checked: false } as const;
const EXPANDED_STATE = { expanded: true } as const;
const COLLAPSED_STATE = { expanded: false } as const;

export interface DirectoryTodosViewProps {
  serverId: string;
  workspaceId: string;
  mainAgentId: string | null;
  client: DaemonClient | null;
  durableItems: readonly WorkspaceDurableItem[];
  onFocusAgentById: (agentId: string) => void;
}

export const DirectoryTodosView = memo(function DirectoryTodosView({
  serverId,
  workspaceId,
  mainAgentId,
  client,
  durableItems,
  onFocusAgentById,
}: DirectoryTodosViewProps) {
  const { t } = useTranslation();
  const { items: todos, isSupported } = useWorkspaceTodos(serverId, workspaceId);
  const upsertMutation = useUpsertWorkspaceTodo(serverId);
  const setStatusMutation = useSetWorkspaceTodoStatus(serverId);
  const openTodoEditor = useTopicStreamViewStore((state) => state.openTodoEditor);
  const requestScrollToTopic = useTopicStreamViewStore((state) => state.requestScrollToTopic);
  const setViewMode = useTopicStreamViewStore((state) => state.setViewMode);

  const [quickTitle, setQuickTitle] = useState("");
  const [quickResetKey, setQuickResetKey] = useState(0);
  const [completedExpanded, setCompletedExpanded] = useState(false);

  const pendingDurableItems = useMemo(
    () => durableItems.filter((item) => item.status === "pending"),
    [durableItems],
  );
  const grouped = useMemo(() => groupWorkspaceTodos(todos), [todos]);

  const handleQuickAdd = useCallback(async () => {
    const trimmed = quickTitle.trim();
    if (!trimmed || !isSupported || upsertMutation.isPending) return;
    await upsertMutation.mutateAsync({
      workspaceId,
      title: trimmed,
      checklist: [],
      dueAt: null,
      remindBeforeMinutes: null,
      source: null,
    });
    setQuickTitle("");
    setQuickResetKey((k) => k + 1);
  }, [isSupported, quickTitle, upsertMutation, workspaceId]);

  const handleQuickAddSubmit = useCallback(() => {
    void handleQuickAdd();
  }, [handleQuickAdd]);

  const handleToggleCompletedSection = useCallback(() => {
    setCompletedExpanded((value) => !value);
  }, []);

  const handleOpenNewModal = useCallback(() => {
    openTodoEditor({ serverId, workspaceId });
  }, [openTodoEditor, serverId, workspaceId]);

  const handleToggleTodo = useCallback(
    (todo: WorkspaceTodoItem) => {
      setStatusMutation.mutate({
        workspaceId,
        todoId: todo.todoId,
        expectedRevision: todo.revision,
        status: todo.status === "completed" ? "pending" : "completed",
      });
    },
    [setStatusMutation, workspaceId],
  );

  const handleToggleChecklistItem = useCallback(
    (todo: WorkspaceTodoItem, itemId: string, nextCompleted: boolean) => {
      setStatusMutation.mutate({
        workspaceId,
        todoId: todo.todoId,
        expectedRevision: todo.revision,
        checklistItemId: itemId,
        checklistCompleted: nextCompleted,
      });
    },
    [setStatusMutation, workspaceId],
  );

  const handleSnoozeOneHour = useCallback(
    (todo: WorkspaceTodoItem) => {
      upsertMutation.mutate({
        workspaceId,
        todoId: todo.todoId,
        expectedRevision: todo.revision,
        title: todo.title,
        snoozedUntil: buildSnoozeOneHourIso(),
      });
    },
    [upsertMutation, workspaceId],
  );

  const handleJumpToSource = useCallback(
    (todo: WorkspaceTodoItem) => {
      const targetAgentId = todo.source?.mainAgentId ?? mainAgentId;
      if (!targetAgentId) return;
      if (todo.source?.topicKey) {
        const key = buildTopicAgentKey(serverId, targetAgentId);
        setViewMode(key, "topics");
        requestScrollToTopic(key, todo.source.topicKey, true, {
          taskId: todo.source.taskId,
          rootMessageId: todo.source.rootMessageId,
        });
      }
      onFocusAgentById(targetAgentId);
    },
    [mainAgentId, onFocusAgentById, requestScrollToTopic, serverId, setViewMode],
  );

  const handleDelegateToMain = useCallback(
    (todo: WorkspaceTodoItem) => {
      if (!client || !mainAgentId) return;
      const lines = [
        `请跟进待办事项：${todo.title}`,
        todo.note ? `备注：${todo.note}` : null,
        todo.source?.topicTitlePreview ? `关联话题：${todo.source.topicTitlePreview}` : null,
      ].filter(Boolean);
      void client
        .sendAgentMessage(mainAgentId, lines.join("\n"), {
          messageId: generateMessageId(),
        })
        .catch(() => undefined);
      onFocusAgentById(mainAgentId);
    },
    [client, mainAgentId, onFocusAgentById],
  );

  const handleEditTodo = useCallback(
    (todo: WorkspaceTodoItem) => {
      openTodoEditor({ serverId, workspaceId, existingTodo: todo });
    },
    [openTodoEditor, serverId, workspaceId],
  );

  const hasAnyItem =
    grouped.overdue.length > 0 ||
    grouped.dueTodayAndPending.length > 0 ||
    pendingDurableItems.length > 0 ||
    grouped.completed.length > 0;

  return (
    <View style={styles.container} testID="team-directory-todos-view">
      {isSupported ? (
        <View style={styles.quickAddRow}>
          <AdaptiveTextInput
            initialValue=""
            resetKey={quickResetKey}
            onChangeText={setQuickTitle}
            placeholder={t("topicWorkbench.todos.quickAddPlaceholder")}
            style={styles.quickAddInput}
            onSubmitEditing={handleQuickAddSubmit}
            returnKeyType="done"
            testID="team-directory-todo-quick-add"
          />
          <ToolbarButton
            compact
            label={t("topicWorkbench.todos.addTodo")}
            onPress={handleOpenNewModal}
            testID="team-directory-todo-open-editor"
          >
            <ThemedPlus size={14} />
          </ToolbarButton>
        </View>
      ) : (
        <View style={styles.upgradeBanner} testID="team-directory-todos-upgrade">
          <Text style={styles.upgradeText}>{t("topicWorkbench.todos.upgradeHost")}</Text>
        </View>
      )}

      {!hasAnyItem ? (
        <View style={styles.emptyCard} testID="team-directory-todos-empty">
          <Text style={styles.emptyTitle}>{t("topicWorkbench.todos.emptyTitle")}</Text>
          <Text style={styles.emptyDescription}>{t("topicWorkbench.todos.emptyDescription")}</Text>
        </View>
      ) : null}

      {grouped.overdue.length > 0 ? (
        <View style={styles.section} testID="team-directory-todos-overdue">
          <Text style={[styles.sectionTitle, styles.sectionTitleDanger]}>
            {t("topicWorkbench.todos.overdueSection", { count: grouped.overdue.length })}
          </Text>
          {grouped.overdue.map((todo) => (
            <TodoListItemRow
              key={todo.todoId}
              todo={todo}
              canDelegate={Boolean(client && mainAgentId)}
              onToggle={handleToggleTodo}
              onToggleChecklistItem={handleToggleChecklistItem}
              onSnooze={handleSnoozeOneHour}
              onJumpToSource={handleJumpToSource}
              onDelegate={handleDelegateToMain}
              onEdit={handleEditTodo}
            />
          ))}
        </View>
      ) : null}

      {grouped.dueTodayAndPending.length > 0 ? (
        <View style={styles.section} testID="team-directory-todos-pending">
          <Text style={styles.sectionTitle}>
            {t("topicWorkbench.todos.pendingSection", {
              count: grouped.dueTodayAndPending.length,
            })}
          </Text>
          {grouped.dueTodayAndPending.map((todo) => (
            <TodoListItemRow
              key={todo.todoId}
              todo={todo}
              canDelegate={Boolean(client && mainAgentId)}
              onToggle={handleToggleTodo}
              onToggleChecklistItem={handleToggleChecklistItem}
              onSnooze={handleSnoozeOneHour}
              onJumpToSource={handleJumpToSource}
              onDelegate={handleDelegateToMain}
              onEdit={handleEditTodo}
            />
          ))}
        </View>
      ) : null}

      {pendingDurableItems.length > 0 ? (
        <View style={styles.section} testID="team-directory-todos-durable">
          <Text style={styles.sectionTitle}>
            {t("topicWorkbench.todos.durableSection", { count: pendingDurableItems.length })}
          </Text>
          {pendingDurableItems.map((item) => (
            <DurableItemCard key={item.requestId} serverId={serverId} item={item} />
          ))}
        </View>
      ) : null}

      {grouped.completed.length > 0 ? (
        <View style={styles.section} testID="team-directory-todos-completed">
          <PressHighlight
            accessibilityRole="button"
            accessibilityState={completedExpanded ? EXPANDED_STATE : COLLAPSED_STATE}
            onPress={handleToggleCompletedSection}
            style={styles.collapseHeader}
          >
            {completedExpanded ? <ThemedChevronDown size={14} /> : <ThemedChevronRight size={14} />}
            <Text style={styles.sectionTitle}>
              {t("topicWorkbench.todos.completedSection", { count: grouped.completed.length })}
            </Text>
          </PressHighlight>
          {completedExpanded
            ? grouped.completed.map((todo) => (
                <TodoListItemRow
                  key={todo.todoId}
                  todo={todo}
                  canDelegate={false}
                  onToggle={handleToggleTodo}
                  onToggleChecklistItem={handleToggleChecklistItem}
                  onSnooze={handleSnoozeOneHour}
                  onJumpToSource={handleJumpToSource}
                  onDelegate={handleDelegateToMain}
                  onEdit={handleEditTodo}
                />
              ))
            : null}
        </View>
      ) : null}
    </View>
  );
});

const TodoChecklistItemRow = memo(function TodoChecklistItemRow({
  todo,
  step,
  onToggleChecklistItem,
}: {
  todo: WorkspaceTodoItem;
  step: WorkspaceTodoChecklistItem;
  onToggleChecklistItem: (todo: WorkspaceTodoItem, itemId: string, completed: boolean) => void;
}) {
  const handlePress = useCallback(
    () => onToggleChecklistItem(todo, step.itemId, !step.completed),
    [onToggleChecklistItem, step.completed, step.itemId, todo],
  );
  return (
    <PressHighlight
      accessibilityRole="checkbox"
      accessibilityState={step.completed ? CHECKED_STATE : UNCHECKED_STATE}
      onPress={handlePress}
      style={styles.checklistRow}
    >
      {step.completed ? <ThemedCheck size={12} /> : <ThemedSquare size={12} />}
      <Text
        style={[styles.checklistText, step.completed && styles.todoTitleDone]}
        numberOfLines={1}
      >
        {step.text}
      </Text>
    </PressHighlight>
  );
});

const TodoListItemRow = memo(function TodoListItemRow({
  todo,
  canDelegate,
  onToggle,
  onToggleChecklistItem,
  onSnooze,
  onJumpToSource,
  onDelegate,
  onEdit,
}: {
  todo: WorkspaceTodoItem;
  canDelegate: boolean;
  onToggle: (todo: WorkspaceTodoItem) => void;
  onToggleChecklistItem: (todo: WorkspaceTodoItem, itemId: string, completed: boolean) => void;
  onSnooze: (todo: WorkspaceTodoItem) => void;
  onJumpToSource: (todo: WorkspaceTodoItem) => void;
  onDelegate: (todo: WorkspaceTodoItem) => void;
  onEdit: (todo: WorkspaceTodoItem) => void;
}) {
  const { t, i18n } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handleToggle = useCallback(() => onToggle(todo), [onToggle, todo]);
  const handleEdit = useCallback(() => onEdit(todo), [onEdit, todo]);
  const handleJump = useCallback(() => onJumpToSource(todo), [onJumpToSource, todo]);
  const handleSnooze = useCallback(() => onSnooze(todo), [onSnooze, todo]);
  const handleDelegate = useCallback(() => onDelegate(todo), [onDelegate, todo]);
  const showActions = isHovered || isNative || isCompact;

  const completed = todo.status === "completed";
  const overdue = isTodoOverdue(todo);
  const progress = computeTodoChecklistProgress(todo);

  return (
    <HoverEnvelope
      style={styles.rowEnvelope}
      onHoverChange={setIsHovered}
      testID={`team-directory-todo-row-${todo.todoId}`}
    >
      <View style={[styles.todoCard, overdue && styles.todoCardOverdue]}>
        <View style={styles.todoTopRow}>
          <PressHighlight
            accessibilityRole="checkbox"
            accessibilityState={completed ? CHECKED_STATE : UNCHECKED_STATE}
            onPress={handleToggle}
            style={styles.checkBtn}
            testID={`team-directory-todo-toggle-${todo.todoId}`}
          >
            {completed ? <ThemedCheck size={14} /> : <ThemedSquare size={14} />}
          </PressHighlight>
          <PressHighlight accessibilityRole="button" onPress={handleEdit} style={styles.titleBtn}>
            <Text style={[styles.todoTitle, completed && styles.todoTitleDone]} numberOfLines={2}>
              {todo.title}
            </Text>
          </PressHighlight>
          <View
            style={[styles.rowActions, showActions ? styles.actionsVisible : styles.actionsHidden]}
            pointerEvents={showActions ? "auto" : "none"}
          >
            <ToolbarButton compact label={t("topicWorkbench.todos.editTodo")} onPress={handleEdit}>
              <ThemedPencil size={12} />
            </ToolbarButton>
          </View>
        </View>

        <View style={styles.metaRow}>
          {todo.dueAt ? (
            <View style={styles.dueTag}>
              {overdue ? <ThemedClock size={12} /> : null}
              <Text style={[styles.metaText, overdue && styles.overdueText]}>
                {t("topicWorkbench.todos.dueAtLabel", {
                  time: formatTodoDueTimestamp(todo.dueAt, i18n.resolvedLanguage),
                })}
              </Text>
            </View>
          ) : null}
          {progress.total > 0 ? (
            <Text style={styles.metaText}>
              {progress.completed}/{progress.total}
            </Text>
          ) : null}
        </View>

        {todo.checklist.length > 0 && !completed ? (
          <View style={styles.checklistGroup}>
            {todo.checklist.map((step) => (
              <TodoChecklistItemRow
                key={step.itemId}
                todo={todo}
                step={step}
                onToggleChecklistItem={onToggleChecklistItem}
              />
            ))}
          </View>
        ) : null}

        {!completed ? (
          <View style={styles.footerActions}>
            {todo.source ? (
              <Button size="sm" variant="ghost" onPress={handleJump}>
                <ThemedCornerUpLeft size={12} />
                {t("topicWorkbench.todos.jumpToTopic")}
              </Button>
            ) : null}
            {overdue ? (
              <Button size="sm" variant="ghost" onPress={handleSnooze}>
                {t("topicWorkbench.todos.snoozeOneHour")}
              </Button>
            ) : null}
            {canDelegate ? (
              <Button size="sm" variant="ghost" onPress={handleDelegate}>
                <ThemedBot size={12} />
                {t("topicWorkbench.todos.delegateToMain")}
              </Button>
            ) : null}
          </View>
        ) : null}
      </View>
    </HoverEnvelope>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
  },
  quickAddRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  quickAddInput: {
    flex: 1,
    minHeight: 34,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  upgradeBanner: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  upgradeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  section: {
    gap: theme.spacing[1.5],
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  sectionTitleDanger: {
    color: theme.colors.statusDanger,
  },
  collapseHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
  },
  emptyCard: {
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
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
  rowEnvelope: {
    position: "relative",
  },
  todoCard: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    gap: theme.spacing[1.5],
  },
  todoCardOverdue: {
    borderColor: theme.colors.statusDanger,
  },
  todoTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[1.5],
    minHeight: 24,
  },
  checkBtn: {
    padding: theme.spacing[0.5],
    marginTop: 1,
  },
  titleBtn: {
    flex: 1,
    minWidth: 0,
  },
  todoTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  todoTitleDone: {
    color: theme.colors.foregroundMuted,
    textDecorationLine: "line-through",
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
  },
  actionsVisible: {
    opacity: 1,
  },
  actionsHidden: {
    opacity: 0,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[6],
  },
  dueTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  metaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  overdueText: {
    color: theme.colors.statusDanger,
    fontWeight: theme.fontWeight.medium,
  },
  checklistGroup: {
    paddingLeft: theme.spacing[6],
    gap: theme.spacing[1],
  },
  checklistRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingVertical: theme.spacing[0.5],
  },
  checklistText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  footerActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[4],
  },
}));
