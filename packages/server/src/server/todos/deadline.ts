import type {
  WorkspaceTodoDueTriggeredMessage,
  WorkspaceTodoItem,
} from "@getpaseo/protocol/messages";

export type TodoDeadlineKind = WorkspaceTodoDueTriggeredMessage["payload"]["kind"];

export interface TodoDeadline {
  kind: TodoDeadlineKind;
  fireAtMs: number;
}

export function nextTodoDeadline(
  item: WorkspaceTodoItem,
  lastReminderNotifiedAt: string | null,
  nowMs: number,
): TodoDeadline | null {
  if (item.status !== "pending" || item.dueAt === null || item.lastDueNotifiedAt === item.dueAt) {
    return null;
  }
  const dueMs = Date.parse(item.dueAt);
  const snoozedUntilMs = item.snoozedUntil === null ? -Infinity : Date.parse(item.snoozedUntil);
  if (snoozedUntilMs >= dueMs || dueMs <= nowMs) {
    return { kind: "due", fireAtMs: Math.max(dueMs, snoozedUntilMs) };
  }
  if (item.remindBeforeMinutes === null || lastReminderNotifiedAt !== null) {
    return { kind: "due", fireAtMs: dueMs };
  }

  const reminderMs = dueMs - item.remindBeforeMinutes * 60_000;
  const fireAtMs = Math.max(reminderMs, snoozedUntilMs);
  if (fireAtMs >= dueMs) return { kind: "due", fireAtMs: dueMs };
  return { kind: "remind_before", fireAtMs };
}
