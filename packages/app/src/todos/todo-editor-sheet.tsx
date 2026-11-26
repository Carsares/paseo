import type { WorkspaceTodoChecklistItem, WorkspaceTodoItem } from "@getpaseo/protocol/messages";
import { Check, Plus, Square, Trash2 } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useHostFeature } from "@/runtime/host-features";
import { useTopicStreamViewStore, type TodoEditorRequest } from "@/stores/topic-stream-view-store";
import type { Theme } from "@/styles/theme";
import { buildQuickDueAt, type QuickDuePreset } from "./model";
import { useDeleteWorkspaceTodo, useUpsertWorkspaceTodo } from "./queries";

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const ThemedPlus = withUnistyles(Plus, mutedIconMapping);
const ThemedSquare = withUnistyles(Square, mutedIconMapping);
const ThemedCheck = withUnistyles(Check, successIconMapping);
const ThemedTrash = withUnistyles(Trash2, dangerIconMapping);

const CHECKED_STATE = { checked: true } as const;
const UNCHECKED_STATE = { checked: false } as const;
const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;

type DueSelection = "none" | QuickDuePreset | "custom";

const DUE_OPTIONS: ReadonlyArray<readonly [DueSelection, string]> = [
  ["none", "topicWorkbench.todos.dueNone"],
  ["1h", "topicWorkbench.todos.due1h"],
  ["today18", "topicWorkbench.todos.dueToday18"],
  ["tomorrow10", "topicWorkbench.todos.dueTomorrow10"],
  ["custom", "topicWorkbench.todos.dueCustom"],
];

function formatLocalDateTimeInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLocalDateTimeInput(raw: string): string | null {
  const local = raw.trim().replace("T", " ");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(local)) return null;
  const parsed = new Date(local.replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) return null;
  const iso = parsed.toISOString();
  return formatLocalDateTimeInput(iso) === local ? iso : null;
}

function resolveDueAtForSave(
  dueSelection: DueSelection,
  customDueText: string,
  dueIso: string | null,
  original: string | null | undefined,
): string | null {
  if (dueSelection === "none") return null;
  if (dueSelection !== "custom") return dueIso;
  const local = customDueText.trim().replace("T", " ");
  if (original && local === formatLocalDateTimeInput(original)) return original;
  return parseLocalDateTimeInput(local);
}

function buildDeadlineUpdate(
  existing: WorkspaceTodoItem | undefined,
  dueAt: string | null,
  remindMinutes: number | null,
  reminderEdited: boolean,
): Partial<Pick<WorkspaceTodoItem, "dueAt" | "remindBeforeMinutes">> {
  const remindBeforeMinutes = dueAt ? (remindMinutes ?? 0) : null;
  if (!existing) return { dueAt, remindBeforeMinutes };
  const update: Partial<Pick<WorkspaceTodoItem, "dueAt" | "remindBeforeMinutes">> = {};
  if (dueAt !== existing.dueAt) update.dueAt = dueAt;
  const changedDueAvailability = Boolean(existing.dueAt) !== Boolean(dueAt);
  if (
    changedDueAvailability ||
    (reminderEdited && remindBeforeMinutes !== existing.remindBeforeMinutes)
  ) {
    update.remindBeforeMinutes = remindBeforeMinutes;
  }
  return update;
}

function toggleStepInList(
  list: readonly WorkspaceTodoChecklistItem[],
  itemId: string,
): WorkspaceTodoChecklistItem[] {
  return list.map((step) =>
    step.itemId === itemId ? { ...step, completed: !step.completed } : step,
  );
}

function removeStepFromList(
  list: readonly WorkspaceTodoChecklistItem[],
  itemId: string,
): WorkspaceTodoChecklistItem[] {
  return list.filter((step) => step.itemId !== itemId);
}

const ChecklistStepRow = memo(function ChecklistStepRow({
  step,
  onToggle,
  onRemove,
}: {
  step: WorkspaceTodoChecklistItem;
  onToggle: (itemId: string) => void;
  onRemove: (itemId: string) => void;
}) {
  const handleToggle = useCallback(() => onToggle(step.itemId), [onToggle, step.itemId]);
  const handleRemove = useCallback(() => onRemove(step.itemId), [onRemove, step.itemId]);
  return (
    <View style={styles.checklistRow}>
      <PressHighlight
        accessibilityRole="checkbox"
        accessibilityState={step.completed ? CHECKED_STATE : UNCHECKED_STATE}
        onPress={handleToggle}
        style={styles.checklistToggle}
      >
        {step.completed ? <ThemedCheck size={14} /> : <ThemedSquare size={14} />}
      </PressHighlight>
      <Text
        style={[styles.checklistText, step.completed && styles.checklistTextDone]}
        numberOfLines={2}
      >
        {step.text}
      </Text>
      <PressHighlight
        accessibilityRole="button"
        onPress={handleRemove}
        style={styles.checklistDelete}
      >
        <ThemedTrash size={13} />
      </PressHighlight>
    </View>
  );
});

const DuePillButton = memo(function DuePillButton({
  selectionKey,
  labelKey,
  selected,
  onSelect,
}: {
  selectionKey: DueSelection;
  labelKey: string;
  selected: boolean;
  onSelect: (selection: DueSelection) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(selectionKey), [onSelect, selectionKey]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityState={selected ? SELECTED_STATE : UNSELECTED_STATE}
      onPress={handlePress}
      style={[styles.duePill, selected && styles.duePillSelected]}
      testID={`todo-editor-due-${selectionKey}`}
    >
      <Text style={[styles.duePillText, selected && styles.duePillTextSelected]}>
        {t(labelKey)}
      </Text>
    </PressHighlight>
  );
});

const RemindOptionSection = memo(function RemindOptionSection({
  remindMinutes,
  onSelectOnTime,
  onSelectBefore15m,
}: {
  remindMinutes: number | null;
  onSelectOnTime: () => void;
  onSelectBefore15m: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{t("topicWorkbench.todos.remindBeforeLabel")}</Text>
      <View style={styles.duePills}>
        <PressHighlight
          accessibilityRole="button"
          accessibilityState={!remindMinutes ? SELECTED_STATE : UNSELECTED_STATE}
          onPress={onSelectOnTime}
          style={[styles.duePill, !remindMinutes && styles.duePillSelected]}
        >
          <Text style={[styles.duePillText, !remindMinutes && styles.duePillTextSelected]}>
            {t("topicWorkbench.todos.remindOnTime")}
          </Text>
        </PressHighlight>
        <PressHighlight
          accessibilityRole="button"
          accessibilityState={remindMinutes === 15 ? SELECTED_STATE : UNSELECTED_STATE}
          onPress={onSelectBefore15m}
          style={[styles.duePill, remindMinutes === 15 && styles.duePillSelected]}
          testID="todo-editor-remind-15m"
        >
          <Text style={[styles.duePillText, remindMinutes === 15 && styles.duePillTextSelected]}>
            {t("topicWorkbench.todos.remindBefore15m")}
          </Text>
        </PressHighlight>
      </View>
    </View>
  );
});

export const TodoEditorSheet = memo(function TodoEditorSheet() {
  const request = useTopicStreamViewStore((state) => state.todoEditorRequest);
  return request ? <TodoEditorForm request={request} /> : null;
});

function TodoEditorForm({ request }: { request: TodoEditorRequest }) {
  const { t, i18n } = useTranslation();
  const { serverId, workspaceId, existingTodo } = request;
  const closeTodoEditor = useCallback(() => {
    const state = useTopicStreamViewStore.getState();
    if (state.todoEditorRequest === request) state.closeTodoEditor();
  }, [request]);
  const supportsTodos = useHostFeature(serverId, "workspaceTodos");
  const upsertMutation = useUpsertWorkspaceTodo(serverId);
  const deleteMutation = useDeleteWorkspaceTodo(serverId);

  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [checklist, setChecklist] = useState<WorkspaceTodoChecklistItem[]>([]);
  const [newStepText, setNewStepText] = useState("");
  const [dueSelection, setDueSelection] = useState<DueSelection>("none");
  const [dueIso, setDueIso] = useState<string | null>(null);
  const [customDueText, setCustomDueText] = useState("");
  const [remindMinutes, setRemindMinutes] = useState<number | null>(null);
  const [reminderEdited, setReminderEdited] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [formResetKey, setFormResetKey] = useState(0);
  const [stepResetKey, setStepResetKey] = useState(0);
  const [dueResetKey, setDueResetKey] = useState(0);

  useEffect(() => {
    const existing = request.existingTodo;
    if (existing) {
      setTitle(existing.title);
      setNote(existing.note ?? "");
      setChecklist(existing.checklist);
      setDueIso(existing.dueAt);
      setDueSelection(existing.dueAt ? "custom" : "none");
      setCustomDueText(formatLocalDateTimeInput(existing.dueAt));
      setRemindMinutes(existing.remindBeforeMinutes);
    } else {
      setTitle(request.initialTitle ?? "");
      setNote(request.initialNote ?? "");
      setChecklist([]);
      setDueIso(null);
      setDueSelection("none");
      setCustomDueText("");
      setRemindMinutes(null);
    }
    setReminderEdited(false);
    setNewStepText("");
    setErrorText(null);
    setFormResetKey((k) => k + 1);
    setStepResetKey((k) => k + 1);
    setDueResetKey((k) => k + 1);
  }, [request]);

  const handleSelectDue = useCallback((selection: DueSelection) => {
    setDueSelection(selection);
    if (selection === "none") {
      setDueIso(null);
      setCustomDueText("");
      setDueResetKey((k) => k + 1);
    } else if (selection === "custom") {
      setCustomDueText((current) => current || formatLocalDateTimeInput(buildQuickDueAt("1h")));
      setDueResetKey((k) => k + 1);
    } else {
      const iso = buildQuickDueAt(selection);
      setDueIso(iso);
      setCustomDueText(formatLocalDateTimeInput(iso));
      setDueResetKey((k) => k + 1);
    }
  }, []);

  const handleAddChecklistStep = useCallback(() => {
    const trimmed = newStepText.trim();
    if (!trimmed) return;
    setChecklist((current) => [
      ...current,
      {
        itemId: `chk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        text: trimmed,
        completed: false,
      },
    ]);
    setNewStepText("");
    setStepResetKey((k) => k + 1);
  }, [newStepText]);

  const handleToggleChecklistStep = useCallback((itemId: string) => {
    setChecklist((current) => toggleStepInList(current, itemId));
  }, []);

  const handleRemoveChecklistStep = useCallback((itemId: string) => {
    setChecklist((current) => removeStepFromList(current, itemId));
  }, []);

  const handleSelectRemindOnTime = useCallback(() => {
    setRemindMinutes(0);
    setReminderEdited(true);
  }, []);
  const handleSelectRemindBefore15m = useCallback(() => {
    setRemindMinutes(15);
    setReminderEdited(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!supportsTodos) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    const resolvedDueAt = resolveDueAtForSave(
      dueSelection,
      customDueText,
      dueIso,
      existingTodo?.dueAt,
    );
    if (dueSelection === "custom" && !resolvedDueAt) {
      setErrorText(
        t("topicWorkbench.todos.invalidDueDate", {
          defaultValue: i18n.resolvedLanguage?.startsWith("zh")
            ? "请输入有效的日期和时间（YYYY-MM-DD HH:mm）。"
            : "Enter a valid date and time (YYYY-MM-DD HH:mm).",
        }),
      );
      return;
    }
    setErrorText(null);
    try {
      await upsertMutation.mutateAsync({
        workspaceId,
        ...(request.existingTodo
          ? {
              todoId: request.existingTodo.todoId,
              expectedRevision: request.existingTodo.revision,
            }
          : {}),
        title: trimmedTitle,
        ...(note.trim() ? { note: note.trim() } : {}),
        checklist,
        ...buildDeadlineUpdate(existingTodo, resolvedDueAt, remindMinutes, reminderEdited),
        source: request.existingTodo ? request.existingTodo.source : (request.source ?? null),
      });
      closeTodoEditor();
    } catch (err) {
      if (useTopicStreamViewStore.getState().todoEditorRequest === request) {
        setErrorText(err instanceof Error ? err.message : String(err));
      }
    }
  }, [
    checklist,
    closeTodoEditor,
    customDueText,
    dueIso,
    dueSelection,
    existingTodo,
    i18n.resolvedLanguage,
    note,
    remindMinutes,
    reminderEdited,
    request,
    supportsTodos,
    t,
    title,
    upsertMutation,
    workspaceId,
  ]);

  const handleDelete = useCallback(async () => {
    if (!request.existingTodo) return;
    setErrorText(null);
    try {
      await deleteMutation.mutateAsync({
        workspaceId,
        todoId: request.existingTodo.todoId,
      });
      closeTodoEditor();
    } catch (err) {
      if (useTopicStreamViewStore.getState().todoEditorRequest === request) {
        setErrorText(err instanceof Error ? err.message : String(err));
      }
    }
  }, [closeTodoEditor, deleteMutation, request, workspaceId]);

  const handleSavePress = useCallback(() => {
    void handleSave();
  }, [handleSave]);

  const handleDeletePress = useCallback(() => {
    void handleDelete();
  }, [handleDelete]);

  const isEditing = Boolean(request?.existingTodo);
  const header = useMemo<SheetHeader>(
    () => ({
      title: t(
        isEditing
          ? "topicWorkbench.todos.editorEditTitle"
          : "topicWorkbench.todos.editorCreateTitle",
      ),
    }),
    [isEditing, t],
  );

  const sourcePreview =
    request?.existingTodo?.source?.topicTitlePreview ?? request?.source?.topicTitlePreview ?? null;

  const isSaveDisabled = upsertMutation.isPending || title.trim().length === 0;
  const footer = useMemo(() => {
    if (!supportsTodos) {
      return (
        <View style={styles.footerRight}>
          <Button size="sm" variant="secondary" onPress={closeTodoEditor}>
            {t("topicWorkbench.todos.cancel")}
          </Button>
        </View>
      );
    }
    return (
      <View style={styles.footerRow}>
        {isEditing ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={deleteMutation.isPending}
            onPress={handleDeletePress}
            testID="todo-editor-delete"
          >
            {t("topicWorkbench.todos.delete")}
          </Button>
        ) : (
          <View />
        )}
        <View style={styles.footerRight}>
          <Button size="sm" variant="ghost" onPress={closeTodoEditor} testID="todo-editor-cancel">
            {t("topicWorkbench.todos.cancel")}
          </Button>
          <Button
            size="sm"
            variant="default"
            disabled={isSaveDisabled}
            onPress={handleSavePress}
            testID="todo-editor-save"
          >
            {t("topicWorkbench.todos.save")}
          </Button>
        </View>
      </View>
    );
  }, [
    closeTodoEditor,
    deleteMutation.isPending,
    handleDeletePress,
    handleSavePress,
    isEditing,
    isSaveDisabled,
    supportsTodos,
    t,
  ]);

  return (
    <AdaptiveModalSheet
      visible
      onClose={closeTodoEditor}
      header={header}
      footer={footer}
      desktopMaxWidth={480}
      testID="todo-editor-sheet"
    >
      {!supportsTodos ? (
        <View style={styles.upgradeNotice} testID="todo-editor-upgrade-host">
          <Text style={styles.upgradeText}>{t("topicWorkbench.todos.upgradeHost")}</Text>
        </View>
      ) : (
        <View style={styles.formBody}>
          {sourcePreview ? (
            <View style={styles.sourceChip}>
              <Text style={styles.sourceChipText} numberOfLines={1}>
                {t("topicWorkbench.todos.sourceTopicLabel", { preview: sourcePreview })}
              </Text>
            </View>
          ) : null}

          <View style={styles.field}>
            <Text style={styles.label}>{t("topicWorkbench.todos.titleLabel")}</Text>
            <AdaptiveTextInput
              initialValue={title}
              resetKey={formResetKey}
              onChangeText={setTitle}
              placeholder={t("topicWorkbench.todos.titlePlaceholder")}
              style={styles.input}
              testID="todo-editor-title-input"
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{t("topicWorkbench.todos.noteLabel")}</Text>
            <AdaptiveTextInput
              initialValue={note}
              resetKey={formResetKey}
              onChangeText={setNote}
              placeholder={t("topicWorkbench.todos.notePlaceholder")}
              multiline
              style={[styles.input, styles.noteInput]}
              testID="todo-editor-note-input"
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{t("topicWorkbench.todos.checklistLabel")}</Text>
            {checklist.map((step) => (
              <ChecklistStepRow
                key={step.itemId}
                step={step}
                onToggle={handleToggleChecklistStep}
                onRemove={handleRemoveChecklistStep}
              />
            ))}
            <View style={styles.checklistAddRow}>
              <AdaptiveTextInput
                initialValue=""
                resetKey={stepResetKey}
                onChangeText={setNewStepText}
                placeholder={t("topicWorkbench.todos.checklistAddPlaceholder")}
                style={[styles.input, styles.checklistAddInput]}
                onSubmitEditing={handleAddChecklistStep}
                returnKeyType="done"
                testID="todo-editor-checklist-input"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={newStepText.trim().length === 0}
                onPress={handleAddChecklistStep}
                testID="todo-editor-checklist-add"
              >
                <ThemedPlus size={13} />
              </Button>
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{t("topicWorkbench.todos.dueLabel")}</Text>
            <View style={styles.duePills}>
              {DUE_OPTIONS.map(([key, labelKey]) => (
                <DuePillButton
                  key={key}
                  selectionKey={key}
                  labelKey={labelKey}
                  selected={dueSelection === key}
                  onSelect={handleSelectDue}
                />
              ))}
            </View>
            {dueSelection === "custom" ? (
              <AdaptiveTextInput
                initialValue={customDueText}
                resetKey={dueResetKey}
                onChangeText={setCustomDueText}
                placeholder={t("topicWorkbench.todos.dueCustomPlaceholder")}
                style={styles.input}
                testID="todo-editor-due-custom-input"
              />
            ) : null}
          </View>

          {dueSelection !== "none" ? (
            <RemindOptionSection
              remindMinutes={remindMinutes}
              onSelectOnTime={handleSelectRemindOnTime}
              onSelectBefore15m={handleSelectRemindBefore15m}
            />
          ) : null}

          {errorText ? (
            <Text accessibilityRole="alert" style={styles.errorText} testID="todo-editor-error">
              {errorText}
            </Text>
          ) : null}
        </View>
      )}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  formBody: {
    gap: theme.spacing[3],
  },
  upgradeNotice: {
    paddingVertical: theme.spacing[4],
  },
  upgradeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  sourceChip: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  sourceChipText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  field: {
    gap: theme.spacing[1.5],
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    minHeight: 38,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  noteInput: {
    minHeight: 68,
    textAlignVertical: "top",
  },
  checklistRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  checklistToggle: {
    padding: theme.spacing[0.5],
  },
  checklistText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  checklistTextDone: {
    color: theme.colors.foregroundMuted,
    textDecorationLine: "line-through",
  },
  checklistDelete: {
    padding: theme.spacing[1],
  },
  checklistAddRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  checklistAddInput: {
    flex: 1,
  },
  duePills: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  duePill: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  duePillSelected: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
  },
  duePillText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  duePillTextSelected: {
    color: theme.colors.foreground,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
  },
  footerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginLeft: "auto",
  },
  errorText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));
