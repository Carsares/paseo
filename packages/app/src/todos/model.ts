import type { WorkspaceTodoItem } from "@getpaseo/protocol/messages";

export type TodoDueBucket = "overdue" | "due_today" | "upcoming" | "no_due" | "completed";

export interface HostedWorkspaceTodoItem {
  serverId: string;
  item: WorkspaceTodoItem;
}

export interface WorkspaceTodoGroups {
  overdue: WorkspaceTodoItem[];
  dueTodayAndPending: WorkspaceTodoItem[];
  completed: WorkspaceTodoItem[];
}

export interface WorkspaceTodoStats {
  pendingCount: number;
  overdueCount: number;
}

const BUCKET_RANK: Record<TodoDueBucket, number> = {
  overdue: 0,
  due_today: 1,
  upcoming: 2,
  no_due: 3,
  completed: 4,
};

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function isSameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function resolveEffectiveDueMs(item: WorkspaceTodoItem): number | null {
  const snoozed = parseMs(item.snoozedUntil);
  const due = parseMs(item.dueAt);
  if (snoozed !== null && due !== null) {
    return Math.max(snoozed, due);
  }
  return due ?? snoozed;
}

export function isTodoOverdue(item: WorkspaceTodoItem, nowMs = Date.now()): boolean {
  if (item.status === "completed") return false;
  const dueMs = resolveEffectiveDueMs(item);
  return dueMs !== null && dueMs <= nowMs;
}

export function resolveTodoDueBucket(item: WorkspaceTodoItem, nowMs = Date.now()): TodoDueBucket {
  if (item.status === "completed") return "completed";
  const dueMs = resolveEffectiveDueMs(item);
  if (dueMs === null) return "no_due";
  if (dueMs <= nowMs) return "overdue";
  if (isSameLocalDay(dueMs, nowMs)) return "due_today";
  return "upcoming";
}

export function compareWorkspaceTodos(
  left: WorkspaceTodoItem,
  right: WorkspaceTodoItem,
  nowMs = Date.now(),
): number {
  const leftBucket = resolveTodoDueBucket(left, nowMs);
  const rightBucket = resolveTodoDueBucket(right, nowMs);
  if (leftBucket !== rightBucket) {
    return BUCKET_RANK[leftBucket] - BUCKET_RANK[rightBucket];
  }
  if (leftBucket === "completed") {
    const leftDone = parseMs(left.completedAt) ?? parseMs(left.updatedAt) ?? 0;
    const rightDone = parseMs(right.completedAt) ?? parseMs(right.updatedAt) ?? 0;
    if (leftDone !== rightDone) return rightDone - leftDone;
  } else if (leftBucket !== "no_due") {
    const leftDue = resolveEffectiveDueMs(left) ?? Number.MAX_SAFE_INTEGER;
    const rightDue = resolveEffectiveDueMs(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftDue !== rightDue) return leftDue - rightDue;
  }
  const leftUpdated = parseMs(left.updatedAt) ?? 0;
  const rightUpdated = parseMs(right.updatedAt) ?? 0;
  if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;
  return left.todoId.localeCompare(right.todoId);
}

export function sortWorkspaceTodos(
  items: readonly WorkspaceTodoItem[],
  nowMs = Date.now(),
): WorkspaceTodoItem[] {
  return [...items].sort((left, right) => compareWorkspaceTodos(left, right, nowMs));
}

export function groupWorkspaceTodos(
  items: readonly WorkspaceTodoItem[],
  nowMs = Date.now(),
): WorkspaceTodoGroups {
  const sorted = sortWorkspaceTodos(items, nowMs);
  const overdue: WorkspaceTodoItem[] = [];
  const dueTodayAndPending: WorkspaceTodoItem[] = [];
  const completed: WorkspaceTodoItem[] = [];
  for (const item of sorted) {
    const bucket = resolveTodoDueBucket(item, nowMs);
    if (bucket === "completed") {
      completed.push(item);
    } else if (bucket === "overdue") {
      overdue.push(item);
    } else {
      dueTodayAndPending.push(item);
    }
  }
  return { overdue, dueTodayAndPending, completed };
}

export function applyWorkspaceTodoUpdate(
  items: readonly WorkspaceTodoItem[],
  payload: { item: WorkspaceTodoItem | null; deletedTodoId?: string },
): WorkspaceTodoItem[] {
  if (payload.deletedTodoId) {
    const next = items.filter((entry) => entry.todoId !== payload.deletedTodoId);
    return next.length === items.length ? [...items] : next;
  }
  const incoming = payload.item;
  if (!incoming) return [...items];
  const index = items.findIndex((entry) => entry.todoId === incoming.todoId);
  if (index < 0) {
    return [incoming, ...items];
  }
  const existing = items[index]!;
  if (incoming.revision < existing.revision) {
    return [...items];
  }
  const next = [...items];
  next[index] = incoming;
  return next;
}

export function computeTodoChecklistProgress(item: WorkspaceTodoItem): {
  completed: number;
  total: number;
} {
  const total = item.checklist.length;
  let completed = 0;
  for (const step of item.checklist) {
    if (step.completed) completed += 1;
  }
  return { completed, total };
}

export type QuickDuePreset = "1h" | "today18" | "tomorrow10";

export function buildQuickDueAt(preset: QuickDuePreset, nowMs = Date.now()): string {
  const now = new Date(nowMs);
  if (preset === "1h") {
    return new Date(nowMs + 60 * 60 * 1000).toISOString();
  }
  if (preset === "today18") {
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0, 0);
    if (target.getTime() <= nowMs) {
      target.setDate(target.getDate() + 1);
    }
    return target.toISOString();
  }
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 10, 0, 0, 0);
  return tomorrow.toISOString();
}

export function buildSnoozeOneHourIso(nowMs = Date.now()): string {
  return new Date(nowMs + 60 * 60 * 1000).toISOString();
}

export function countPendingTodosByWorkspace(
  items: readonly HostedWorkspaceTodoItem[],
  nowMs = Date.now(),
): Map<string, WorkspaceTodoStats> {
  const stats = new Map<string, WorkspaceTodoStats>();
  for (const { serverId, item } of items) {
    if (item.status !== "pending") continue;
    const key = `${serverId}\0${item.workspaceId}`;
    const overdue = isTodoOverdue(item, nowMs) ? 1 : 0;
    const current = stats.get(key);
    if (current) {
      current.pendingCount += 1;
      current.overdueCount += overdue;
    } else {
      stats.set(key, { pendingCount: 1, overdueCount: overdue });
    }
  }
  return stats;
}

export function formatTodoDueTimestamp(iso: string | null | undefined, locale?: string): string {
  const ms = parseMs(iso);
  if (ms === null) return "";
  try {
    return new Intl.DateTimeFormat(locale, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}
