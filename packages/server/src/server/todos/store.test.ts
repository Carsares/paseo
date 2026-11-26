import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleTodoRequest } from "./requests.js";
import { WorkspaceTodoStore } from "./store.js";

const workspaceId = "ws-1";
const now = Date.parse("2026-11-26T12:00:00.000Z");
let dir: string;
let store: WorkspaceTodoStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paseo-todos-"));
  store = new WorkspaceTodoStore(dir, () => now);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("WorkspaceTodoStore", () => {
  it("serializes optimistic edits and preserves checklist and source data after reopening", async () => {
    const source = { mainAgentId: "main-1", topicKey: "topic-1", topicTitlePreview: "Discuss" };
    const checklist = [{ itemId: "check-1", text: "Review", completed: false }];
    const item = await store.upsert({ workspaceId, title: "Review", source, checklist });
    const key = { workspaceId, todoId: item.todoId, expectedRevision: item.revision };
    const writes = await Promise.allSettled([
      store.setStatus({ ...key, checklistItemId: "check-1", checklistCompleted: true }),
      store.upsert({ ...key, title: "Concurrent change" }),
    ]);
    expect(writes[0]).toMatchObject({
      status: "fulfilled",
      value: { revision: item.revision + 1 },
    });
    expect(writes[1]).toMatchObject({
      status: "rejected",
      reason: { code: "todo_revision_conflict", currentRevision: item.revision + 1 },
    });
    const reopened = new WorkspaceTodoStore(dir, () => now);
    expect(await reopened.list({ workspaceIds: [workspaceId] })).toMatchObject([
      {
        source,
        title: "Review",
        status: "pending",
        checklist: [{ ...checklist[0], completed: true }],
      },
    ]);
    const completed = await reopened.setStatus({
      ...key,
      expectedRevision: item.revision + 1,
      status: "completed",
    });
    expect(completed.completedAt).toBe(new Date(now).toISOString());
    const pending = await reopened.setStatus({
      ...key,
      expectedRevision: completed.revision,
      status: "pending",
    });
    expect(pending.completedAt).toBeNull();
    expect(pending.checklist[0]?.completed).toBe(true);
  });

  it("sorts active deadlines, supports rescheduling and scopes global RPC operations", async () => {
    const earlier = new Date(now + 60_000).toISOString();
    const later = new Date(now + 120_000).toISOString();
    const after = new Date(now + 180_000).toISOString();
    const first = await store.upsert({
      workspaceId,
      title: "First",
      dueAt: earlier,
      snoozedUntil: later,
    });
    const second = await store.upsert({ workspaceId, title: "Second", dueAt: later });
    const undated = await store.upsert({ workspaceId, title: "Undated" });
    const hidden = await store.upsert({ workspaceId: "hidden", title: "Different workspace" });
    const updated = await store.upsert({
      workspaceId,
      todoId: first.todoId,
      title: first.title,
      expectedRevision: first.revision,
      dueAt: after,
    });
    expect(updated).toMatchObject({ dueAt: after, snoozedUntil: null });
    const options = { store, resolveWorkspaceIds: async () => [workspaceId] };
    const response = await handleTodoRequest(
      { type: "workspace.todo.list.request", requestId: "list" },
      options,
    );
    expect(response.payload).toMatchObject({ items: [second, updated, undated], error: null });
    const deleteHidden = await handleTodoRequest(
      {
        type: "workspace.todo.delete.request",
        requestId: "delete",
        workspaceId: hidden.workspaceId,
        todoId: hidden.todoId,
      },
      options,
    );
    expect(deleteHidden.payload).toMatchObject({ deleted: false, error: "workspace_unavailable" });
    expect(await store.delete({ workspaceId, todoId: first.todoId })).toBe(true);
    expect(await store.list({ workspaceIds: [workspaceId] })).toEqual([second, undated]);
  });
});
