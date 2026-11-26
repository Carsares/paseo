import type { WorkspaceTodoItem } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  applyWorkspaceTodoUpdate,
  buildQuickDueAt,
  countPendingTodosByWorkspace,
  groupWorkspaceTodos,
  sortWorkspaceTodos,
} from "./model";

function makeTodo(overrides: Partial<WorkspaceTodoItem> & { todoId: string }): WorkspaceTodoItem {
  return {
    workspaceId: "ws-1",
    title: overrides.todoId,
    status: "pending",
    checklist: [],
    dueAt: null,
    remindBeforeMinutes: null,
    snoozedUntil: null,
    lastDueNotifiedAt: null,
    source: null,
    assignedAgentId: null,
    revision: 1,
    createdAt: "2026-06-01T08:00:00.000Z",
    updatedAt: "2026-06-01T08:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

describe("todos model", () => {
  const nowMs = Date.parse("2026-06-01T12:00:00.000Z");

  it("sorts overdue -> due_today -> upcoming -> no_due -> completed", () => {
    const items = [
      makeTodo({ todoId: "done", status: "completed", completedAt: "2026-06-01T11:00:00.000Z" }),
      makeTodo({ todoId: "no-due" }),
      makeTodo({ todoId: "upcoming", dueAt: "2026-06-03T10:00:00.000Z" }),
      makeTodo({ todoId: "today", dueAt: "2026-06-01T14:00:00.000Z" }),
      makeTodo({ todoId: "overdue-later", dueAt: "2026-06-01T11:00:00.000Z" }),
      makeTodo({ todoId: "overdue-earlier", dueAt: "2026-06-01T09:00:00.000Z" }),
    ];

    const sorted = sortWorkspaceTodos(items, nowMs);
    expect(sorted.map((item) => item.todoId)).toEqual([
      "overdue-earlier",
      "overdue-later",
      "today",
      "upcoming",
      "no-due",
      "done",
    ]);

    const grouped = groupWorkspaceTodos(items, nowMs);
    expect(grouped.overdue.map((item) => item.todoId)).toEqual([
      "overdue-earlier",
      "overdue-later",
    ]);
    expect(grouped.dueTodayAndPending.map((item) => item.todoId)).toEqual([
      "today",
      "upcoming",
      "no-due",
    ]);
    expect(grouped.completed.map((item) => item.todoId)).toEqual(["done"]);
  });

  it("reconciles live todo updates by revision and deletion", () => {
    const base = [makeTodo({ todoId: "t-1", title: "Old", revision: 2 })];
    // Stale lower revision is ignored
    const afterStale = applyWorkspaceTodoUpdate(base, {
      item: makeTodo({ todoId: "t-1", title: "Stale", revision: 1 }),
    });
    expect(afterStale[0]!.title).toBe("Old");

    // Higher revision updates
    const afterUpdate = applyWorkspaceTodoUpdate(base, {
      item: makeTodo({ todoId: "t-1", title: "Updated", revision: 3 }),
    });
    expect(afterUpdate[0]!.title).toBe("Updated");

    // Deletion removes item
    const afterDelete = applyWorkspaceTodoUpdate(afterUpdate, {
      item: null,
      deletedTodoId: "t-1",
    });
    expect(afterDelete).toHaveLength(0);
  });

  it("counts pending and overdue todos per workspace and builds quick due presets", () => {
    const stats = countPendingTodosByWorkspace(
      [
        {
          serverId: "srv-1",
          item: makeTodo({
            todoId: "t-over",
            workspaceId: "ws-a",
            dueAt: "2026-06-01T10:00:00.000Z",
          }),
        },
        {
          serverId: "srv-1",
          item: makeTodo({ todoId: "t-open", workspaceId: "ws-a" }),
        },
        {
          serverId: "srv-1",
          item: makeTodo({ todoId: "t-done", workspaceId: "ws-a", status: "completed" }),
        },
      ],
      nowMs,
    );
    expect(stats.get("srv-1\0ws-a")).toEqual({ pendingCount: 2, overdueCount: 1 });

    const oneHour = Date.parse(buildQuickDueAt("1h", nowMs));
    expect(oneHour).toBe(nowMs + 60 * 60 * 1000);
    expect(Date.parse(buildQuickDueAt("today18", nowMs))).toBeGreaterThan(nowMs);
    expect(Date.parse(buildQuickDueAt("tomorrow10", nowMs))).toBeGreaterThan(nowMs);
  });
});
