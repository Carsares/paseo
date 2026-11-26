import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodoDeadlineScheduler } from "./deadline-scheduler.js";
import { WorkspaceTodoStore, type ClaimedTodoDeadline } from "./store.js";

const workspaceId = "ws-1";
const start = Date.parse("2026-11-26T12:00:00.000Z");
let dir: string;
let store: WorkspaceTodoStore;
let scheduler: TodoDeadlineScheduler;
let delivered: ClaimedTodoDeadline[];
let nextDelivery: ((event: ClaimedTodoDeadline) => void) | undefined;
let errors: unknown[];

function launch(): Promise<void> {
  scheduler = new TodoDeadlineScheduler({
    store,
    onDue(event) {
      delivered.push(event);
      nextDelivery?.(event);
    },
    onError(error) {
      errors.push(error);
    },
  });
  return scheduler.start();
}

function at(offsetMs: number): string {
  return new Date(start + offsetMs).toISOString();
}

async function fireAfter(offsetMs: number): Promise<ClaimedTodoDeadline> {
  const notification = new Promise<ClaimedTodoDeadline>((resolve) => {
    nextDelivery = resolve;
  });
  await vi.advanceTimersByTimeAsync(offsetMs);
  const event = await notification;
  nextDelivery = undefined;
  return event;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paseo-deadline-"));
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(start);
  store = new WorkspaceTodoStore(dir);
  delivered = [];
  errors = [];
});

afterEach(async () => {
  try {
    await scheduler?.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  }
});

describe("TodoDeadlineScheduler", () => {
  it("persists early reminders separately and sends the due notification after restarting", async () => {
    const item = await store.upsert({
      workspaceId,
      title: "Review",
      dueAt: at(120_000),
      remindBeforeMinutes: 1,
    });
    await launch();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(delivered).toEqual([]);
    const early = await fireAfter(1);
    expect(early).toMatchObject({
      kind: "remind_before",
      item: { todoId: item.todoId, lastDueNotifiedAt: null, revision: item.revision },
    });
    await scheduler.stop();
    store = new WorkspaceTodoStore(dir);
    await launch();
    const due = await fireAfter(60_000);
    expect(due).toMatchObject({
      kind: "due",
      item: { todoId: item.todoId, lastDueNotifiedAt: at(120_000) },
    });
    expect(delivered.map((event) => event.kind)).toEqual(["remind_before", "due"]);
    await scheduler.stop();
    await launch();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("catches up once after an offline deadline without replaying the missed early reminder", async () => {
    await store.upsert({
      workspaceId,
      title: "Overdue",
      dueAt: at(120_000),
      remindBeforeMinutes: 1,
    });
    vi.setSystemTime(start + 180_000);
    await launch();
    const event = await fireAfter(1);
    expect(event).toMatchObject({ kind: "due", item: { lastDueNotifiedAt: at(120_000) } });
    await scheduler.stop();
    store = new WorkspaceTodoStore(dir);
    await launch();
    expect(vi.getTimerCount()).toBe(0);
    expect(delivered).toHaveLength(1);
  });

  it("uses one timer to order committed edits, snoozes, completions and deletions", async () => {
    await launch();
    const first = await store.upsert({
      workspaceId,
      title: "Postponed",
      dueAt: at(2_000),
      remindBeforeMinutes: 1,
      snoozedUntil: at(5_000),
    });
    const second = await store.upsert({ workspaceId, title: "Moved earlier", dueAt: at(4_000) });
    const removed = await store.upsert({ workspaceId, title: "Removed", dueAt: at(500) });
    const completed = await store.upsert({ workspaceId, title: "Finished", dueAt: at(800) });
    await store.delete({ workspaceId, todoId: removed.todoId });
    await store.setStatus({
      workspaceId,
      todoId: completed.todoId,
      expectedRevision: completed.revision,
      status: "completed",
    });
    await store.upsert({
      workspaceId,
      todoId: second.todoId,
      title: second.title,
      expectedRevision: second.revision,
      dueAt: at(1_000),
    });
    expect(vi.getTimerCount()).toBe(1);
    expect((await fireAfter(1_000)).item.todoId).toBe(second.todoId);
    expect((await fireAfter(4_000)).item.todoId).toBe(first.todoId);
    expect(delivered.map((event) => event.kind)).toEqual(["due", "due"]);
    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows another notice after snoozing or rescheduling a notified deadline", async () => {
    const item = await store.upsert({ workspaceId, title: "Follow up", dueAt: at(1_000) });
    await launch();
    const due = await fireAfter(1_000);
    const snoozed = await store.upsert({
      workspaceId,
      todoId: item.todoId,
      title: item.title,
      expectedRevision: due.item.revision,
      snoozedUntil: at(2_000),
    });
    expect(snoozed.lastDueNotifiedAt).toBeNull();
    const afterSnooze = await fireAfter(1_000);
    expect(afterSnooze.item.lastDueNotifiedAt).toBe(at(1_000));
    await store.upsert({
      workspaceId,
      todoId: item.todoId,
      title: item.title,
      expectedRevision: afterSnooze.item.revision,
      dueAt: at(3_000),
    });
    const rescheduled = await fireAfter(1_000);
    expect(rescheduled.item).toMatchObject({
      dueAt: at(3_000),
      lastDueNotifiedAt: at(3_000),
      snoozedUntil: null,
    });
  });

  it("continues to the exact deadline after a wait past the Node timer limit", async () => {
    const maxDelay = 2_147_483_647;
    await store.upsert({ workspaceId, title: "Far away", dueAt: at(maxDelay + 5_000) });
    await launch();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(maxDelay);
    expect(delivered).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(delivered).toEqual([]);
    expect((await fireAfter(1)).item.lastDueNotifiedAt).toBe(at(maxDelay + 5_000));
    await store.upsert({ workspaceId, title: "Stop before firing", dueAt: at(maxDelay + 10_000) });
    expect(vi.getTimerCount()).toBe(1);
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(delivered).toHaveLength(1);
  });
});
