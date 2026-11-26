import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  WorkspaceTodoItemSchema,
  type WorkspaceTodoItem,
  type WorkspaceTodoSetStatusRequest,
  type WorkspaceTodoUpsertRequest,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { nextTodoDeadline, type TodoDeadlineKind } from "./deadline.js";

const StoredTodoSchema = WorkspaceTodoItemSchema.extend({
  lastReminderNotifiedAt: z.iso.datetime().nullable().default(null),
});
const TodoFileSchema = z.object({ items: z.array(StoredTodoSchema) });
const WorkspaceIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);

type StoredTodo = z.infer<typeof StoredTodoSchema>;
type UpsertInput = Omit<WorkspaceTodoUpsertRequest, "type" | "requestId">;
type SetStatusInput = Omit<WorkspaceTodoSetStatusRequest, "type" | "requestId">;
type TodoKey = Pick<WorkspaceTodoItem, "workspaceId" | "todoId">;

interface ListOptions {
  workspaceIds: readonly string[];
  statusFilter?: WorkspaceTodoItem["status"];
}

export interface TodoDeadlineRecord extends TodoKey {
  item: WorkspaceTodoItem;
  lastReminderNotifiedAt: string | null;
}

type DeadlineChange = (change: TodoDeadlineRecord | (TodoKey & { item: null })) => void;

export interface ClaimedTodoDeadline {
  item: WorkspaceTodoItem;
  kind: TodoDeadlineKind;
}

const writeTails = new Map<string, Promise<void>>();

export class TodoStoreError extends Error {
  constructor(
    readonly code: "todo_not_found" | "todo_revision_conflict" | "todo_invalid_checklist",
    readonly currentRevision?: number,
  ) {
    super(code);
    this.name = "TodoStoreError";
  }
}

function publicItem({
  lastReminderNotifiedAt: _lastReminder,
  ...item
}: StoredTodo): WorkspaceTodoItem {
  return item;
}

function compareItems(left: WorkspaceTodoItem, right: WorkspaceTodoItem): number {
  if (left.status !== right.status) return left.status === "pending" ? -1 : 1;
  if (left.status === "pending") {
    if (left.dueAt !== null && right.dueAt === null) return -1;
    if (left.dueAt === null && right.dueAt !== null) return 1;
    if (left.dueAt !== null && right.dueAt !== null) {
      const dueOrder = Date.parse(left.dueAt) - Date.parse(right.dueAt);
      if (dueOrder !== 0) return dueOrder;
    }
  }
  return (
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
    left.todoId.localeCompare(right.todoId)
  );
}

function updateChecklist(current: StoredTodo, input: SetStatusInput): StoredTodo["checklist"] {
  const { checklistItemId, checklistCompleted } = input;
  if (checklistItemId === undefined && checklistCompleted === undefined) return current.checklist;
  if (checklistItemId === undefined || checklistCompleted === undefined) {
    throw new TodoStoreError("todo_invalid_checklist");
  }
  if (!current.checklist.some((entry) => entry.itemId === checklistItemId)) {
    throw new TodoStoreError("todo_invalid_checklist");
  }
  return current.checklist.map((entry) =>
    entry.itemId === checklistItemId ? { ...entry, completed: checklistCompleted } : entry,
  );
}

function createTodo(input: UpsertInput, now: string): StoredTodo {
  return {
    workspaceId: input.workspaceId,
    todoId: randomUUID(),
    title: input.title,
    ...(input.note === undefined ? {} : { note: input.note }),
    status: "pending",
    checklist: input.checklist ?? [],
    dueAt: input.dueAt ?? null,
    remindBeforeMinutes: input.remindBeforeMinutes ?? null,
    snoozedUntil: input.snoozedUntil ?? null,
    lastDueNotifiedAt: null,
    lastReminderNotifiedAt: null,
    source: input.source ?? null,
    assignedAgentId: input.assignedAgentId ?? null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

function provided<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

function editTodo(current: StoredTodo, input: UpsertInput, now: string): StoredTodo {
  const dueAt = provided(input.dueAt, current.dueAt);
  const dateChanged = current.dueAt !== dueAt;
  const defaultSnooze = dateChanged ? null : current.snoozedUntil;
  const snoozedUntil = provided(input.snoozedUntil, defaultSnooze);
  const remindBeforeMinutes = provided(input.remindBeforeMinutes, current.remindBeforeMinutes);
  const resetDue = dateChanged || current.snoozedUntil !== snoozedUntil;
  const resetReminder = resetDue || current.remindBeforeMinutes !== remindBeforeMinutes;
  const checklist = input.checklist ?? current.checklist;
  const note = input.note ?? current.note;
  return {
    ...current,
    title: input.title,
    ...(note === undefined ? {} : { note }),
    checklist,
    dueAt,
    remindBeforeMinutes,
    snoozedUntil,
    lastDueNotifiedAt: resetDue ? null : current.lastDueNotifiedAt,
    lastReminderNotifiedAt: resetReminder ? null : current.lastReminderNotifiedAt,
    source: provided(input.source, current.source),
    assignedAgentId: provided(input.assignedAgentId, current.assignedAgentId),
    revision: current.revision + 1,
    updatedAt: now,
  };
}

/** One daemon-owned store; every mutation serializes the complete workspace file update. */
export class WorkspaceTodoStore {
  private readonly deadlineListeners = new Set<DeadlineChange>();

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  async list(options: ListOptions): Promise<WorkspaceTodoItem[]> {
    const files = await Promise.all(
      Array.from(new Set(options.workspaceIds), (id) => this.read(id)),
    );
    const items = files.flat().map(publicItem);
    return items
      .filter((item) => !options.statusFilter || item.status === options.statusFilter)
      .sort(compareItems);
  }

  upsert(input: UpsertInput): Promise<WorkspaceTodoItem> {
    return this.write(input.workspaceId, async (items, commit) => {
      const index = items.findIndex((item) => item.todoId === input.todoId);
      const current = items[index];
      if (!current && input.todoId !== undefined) throw new TodoStoreError("todo_not_found");
      if (input.expectedRevision !== undefined && current?.revision !== input.expectedRevision) {
        throw new TodoStoreError("todo_revision_conflict", current?.revision);
      }

      const now = new Date(this.now()).toISOString();
      const todo = StoredTodoSchema.parse(
        current ? editTodo(current, input, now) : createTodo(input, now),
      );
      if (new Set(todo.checklist.map((entry) => entry.itemId)).size !== todo.checklist.length) {
        throw new TodoStoreError("todo_invalid_checklist");
      }
      if (index < 0) items.push(todo);
      else items[index] = todo;
      await commit();
      return this.publishDeadline(todo);
    });
  }

  setStatus(input: SetStatusInput): Promise<WorkspaceTodoItem> {
    return this.write(input.workspaceId, async (items, commit) => {
      const index = items.findIndex((item) => item.todoId === input.todoId);
      const current = items[index];
      if (!current) throw new TodoStoreError("todo_not_found");
      if (current.revision !== input.expectedRevision) {
        throw new TodoStoreError("todo_revision_conflict", current.revision);
      }

      const checklist = updateChecklist(current, input);
      const status = input.status ?? current.status;
      if (status === current.status && checklist === current.checklist) return publicItem(current);
      const now = new Date(this.now()).toISOString();
      const completedAt = status === "completed" ? (current.completedAt ?? now) : null;
      const todo = {
        ...current,
        status,
        checklist,
        completedAt,
        revision: current.revision + 1,
        updatedAt: now,
      };
      items[index] = todo;
      await commit();
      return this.publishDeadline(todo);
    });
  }

  delete(key: TodoKey): Promise<boolean> {
    return this.write(key.workspaceId, async (items, commit) => {
      const index = items.findIndex((item) => item.todoId === key.todoId);
      if (index < 0) return false;
      items.splice(index, 1);
      await commit();
      for (const listener of this.deadlineListeners) listener({ ...key, item: null });
      return true;
    });
  }

  async listDeadlines(): Promise<TodoDeadlineRecord[]> {
    const entries = await readdir(this.dir, { withFileTypes: true }).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    const workspaceIds = entries
      .filter((entry) => entry.isFile() && /^[a-zA-Z0-9_-]+\.json$/.test(entry.name))
      .map((entry) => entry.name.slice(0, -".json".length));
    const files = await Promise.all(workspaceIds.map((id) => this.read(id)));
    return files
      .flat()
      .filter((item) => item.status === "pending" && item.dueAt !== null)
      .map(deadlineRecord);
  }

  subscribeDeadlines(listener: DeadlineChange): () => void {
    this.deadlineListeners.add(listener);
    return () => this.deadlineListeners.delete(listener);
  }

  claimDeadline(key: TodoKey): Promise<ClaimedTodoDeadline | null> {
    return this.write(key.workspaceId, async (items, commit) => {
      const index = items.findIndex((item) => item.todoId === key.todoId);
      const current = items[index];
      if (!current) return null;
      const now = this.now();
      const deadline = nextTodoDeadline(current, current.lastReminderNotifiedAt, now);
      if (!deadline || deadline.fireAtMs > now) return null;

      // The cutoff is persisted before handing delivery to prevent a restart from replaying it.
      const todo =
        deadline.kind === "due"
          ? {
              ...current,
              lastDueNotifiedAt: current.dueAt,
              revision: current.revision + 1,
              updatedAt: new Date(now).toISOString(),
            }
          : { ...current, lastReminderNotifiedAt: new Date(now).toISOString() };
      items[index] = todo;
      await commit();
      return { item: this.publishDeadline(todo), kind: deadline.kind };
    });
  }

  private publishDeadline(todo: StoredTodo): WorkspaceTodoItem {
    const record = deadlineRecord(todo);
    for (const listener of this.deadlineListeners) {
      listener(structuredClone(record));
    }
    return record.item;
  }

  private filePath(workspaceId: string): string {
    return resolve(this.dir, `${WorkspaceIdSchema.parse(workspaceId)}.json`);
  }

  private async read(workspaceId: string): Promise<StoredTodo[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(workspaceId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const file = TodoFileSchema.parse(JSON.parse(raw));
    if (file.items.some((item) => item.workspaceId !== workspaceId)) {
      throw new Error("Todo file belongs to a different workspace");
    }
    return file.items;
  }

  private async write<T>(
    workspaceId: string,
    update: (items: StoredTodo[], commit: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const filePath = this.filePath(workspaceId);
    const prior = writeTails.get(filePath) ?? Promise.resolve();
    const operation = prior.then(async () => {
      const items = await this.read(workspaceId);
      return update(items, () => writeJsonFileAtomic(filePath, { items }));
    });
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    writeTails.set(filePath, tail);
    try {
      return await operation;
    } finally {
      if (writeTails.get(filePath) === tail) writeTails.delete(filePath);
    }
  }
}

function deadlineRecord(todo: StoredTodo): TodoDeadlineRecord {
  return {
    workspaceId: todo.workspaceId,
    todoId: todo.todoId,
    item: publicItem(todo),
    lastReminderNotifiedAt: todo.lastReminderNotifiedAt,
  };
}
