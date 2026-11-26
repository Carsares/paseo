import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DurableItemStore } from "../durable-items/store.js";
import { WorkspaceTodoStore } from "../todos/store.js";
import { createPersistedWorkspaceRecord } from "../workspace-registry.js";
import { handleTopicReadRequest } from "./requests.js";
import { TopicReadStateStore } from "./store.js";

const scope = { workspaceId: "ws-1", mainAgentId: "main-1", epoch: "epoch-1", headSeq: 30 };
const key = { workspaceId: scope.workspaceId, mainAgentId: scope.mainAgentId };
const now = Date.parse("2026-11-26T12:00:00.000Z");
let dir: string;
let store: TopicReadStateStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paseo-topic-read-"));
  store = new TopicReadStateStore(join(dir, "topic-read"), () => now);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("TopicReadStateStore", () => {
  it("preserves card and workspace boundaries during concurrent writes", async () => {
    const secondScope = { ...scope, mainAgentId: "main-2", epoch: "other-epoch" };
    await Promise.all([
      store.mark(scope, { ...key, topicKey: "high", mode: "read", seq: 25, timestampMs: 250 }),
      store.mark(scope, { ...key, topicKey: "high", mode: "read", seq: 20, timestampMs: 200 }),
      store.mark(scope, { ...key, topicKey: "low", mode: "unread", seq: 8, timestampMs: 80 }),
      store.mark(secondScope, { ...secondScope, topicKey: "high", mode: "read", seq: 2 }),
    ]);
    const { snapshot } = await store.markAll(scope, {
      epoch: scope.epoch,
      maxSeq: 10,
      maxTimestampMs: 100,
    });
    expect(snapshot).toMatchObject({
      watermarkEpoch: scope.epoch,
      watermarkSeq: 10,
      watermarkTimestampMs: 100,
      revision: 4,
      topics: [
        { topicKey: "high", readUpToSeq: 25, readUpToTimestampMs: 250 },
        { topicKey: "low", markedUnreadAtMs: null },
      ],
    });
    const reloaded = new TopicReadStateStore(join(dir, "topic-read"));
    expect(await reloaded.getState(scope)).toEqual(snapshot);
    expect(await reloaded.getState(secondScope)).toMatchObject({
      revision: 1,
      watermarkSeq: -1,
      topics: [{ readUpToSeq: 2 }],
    });
  });

  it("keeps an unread override outside the client snapshot, even if an older watermark is higher", async () => {
    await store.markAll(scope, { epoch: scope.epoch, maxSeq: 20, maxTimestampMs: 200 });
    await store.mark(scope, { ...key, topicKey: "new", mode: "unread", seq: 18, timestampMs: 180 });
    const { snapshot } = await store.markAll(scope, {
      epoch: scope.epoch,
      maxSeq: 10,
      maxTimestampMs: 100,
    });
    expect(snapshot).toMatchObject({
      watermarkSeq: 20,
      watermarkTimestampMs: 200,
      topics: [{ readUpToSeq: 17, markedUnreadAtMs: now }],
    });
    const covered = await store.markAll(scope, {
      epoch: scope.epoch,
      maxSeq: 18,
      maxTimestampMs: 180,
    });
    expect(covered.snapshot.topics[0]?.markedUnreadAtMs).toBeNull();
  });

  it("ignores obsolete epochs and keeps sequence and time bounds at the observation", async () => {
    const initial = await store.markAll(scope, {
      epoch: scope.epoch,
      maxSeq: 12,
      maxTimestampMs: 120,
    });
    expect(initial.snapshot).toMatchObject({ watermarkSeq: 12, watermarkTimestampMs: 120 });
    const rebased = { ...scope, epoch: "epoch-2", headSeq: 100 };
    const stale = await store.markAll(rebased, {
      epoch: scope.epoch,
      maxSeq: 95,
      maxTimestampMs: 950,
    });
    expect(stale).toEqual({ snapshot: initial.snapshot, applied: false, changed: false });
    const next = await store.markAll(rebased, {
      epoch: rebased.epoch,
      maxSeq: 4,
      maxTimestampMs: 140,
    });
    expect(next.snapshot).toMatchObject({
      watermarkEpoch: "epoch-2",
      watermarkSeq: 4,
      watermarkTimestampMs: 140,
    });
  });

  it("keeps sequence zero beyond an empty snapshot and uses timestamps without a shared epoch", async () => {
    await store.mark(scope, { ...key, topicKey: "first", mode: "unread", seq: 0, timestampMs: 20 });
    await store.mark(scope, { ...key, topicKey: "seen", mode: "unread", seq: 1, timestampMs: 10 });
    const empty = await store.markAll(scope, { epoch: scope.epoch, maxSeq: -1 });
    expect(empty.snapshot.topics.map((topic) => topic.markedUnreadAtMs)).toEqual([now, now]);
    const byTimestamp = await store.markAll(scope, { maxTimestampMs: 10 });
    expect(byTimestamp.snapshot).toMatchObject({
      watermarkSeq: -1,
      watermarkTimestampMs: 10,
      topics: [
        { topicKey: "first", markedUnreadAtMs: now },
        { topicKey: "seen", markedUnreadAtMs: null },
      ],
    });
  });

  it("loads empty and prior flat files and evicts the least recently marked card", async () => {
    const topicDir = join(dir, "topic-read");
    await mkdir(topicDir);
    const file = join(topicDir, "ws-1.json");
    await writeFile(file, "");
    expect(await store.getState(scope)).toMatchObject({ revision: 0, topics: [] });
    const topics = Array.from({ length: 500 }, (_, index) => ({
      topicKey: `topic-${index}`,
      readUpToSeq: index,
      readUpToTimestampMs: 0,
      markedUnreadAtMs: null,
      updatedAt: new Date(now).toISOString(),
    }));
    await writeFile(
      file,
      JSON.stringify({ mainAgentId: scope.mainAgentId, topics, watermarkEpoch: scope.epoch }),
    );
    await store.mark(scope, { ...key, topicKey: "topic-0", mode: "read", seq: 12 });
    await store.mark(scope, { ...key, topicKey: "new", mode: "read", seq: 13 });
    const reloaded = await store.getState(scope);
    expect(reloaded.topics).toHaveLength(500);
    expect(reloaded.topics.map((topic) => topic.topicKey)).not.toContain("topic-1");
    expect(reloaded.topics.slice(-2).map((topic) => topic.topicKey)).toEqual(["topic-0", "new"]);
  });

  it("reconciles attention only for bounded bulk reads and leaves durable items and Todos intact", async () => {
    const todoStore = new WorkspaceTodoStore(join(dir, "todos"));
    const todo = await todoStore.upsert({ workspaceId: scope.workspaceId, title: "Follow up" });
    const nowIso = new Date(now).toISOString();
    const durableItems = new DurableItemStore({
      filePath: join(dir, "durable-items.json"),
      serverId: "local",
      getWorkspace: async () =>
        createPersistedWorkspaceRecord({
          workspaceId: scope.workspaceId,
          projectId: "project",
          cwd: dir,
          kind: "directory",
          displayName: "Workspace",
          createdAt: nowIso,
          updatedAt: nowIso,
        }),
      getSourceAgent: async () => ({
        id: scope.mainAgentId,
        workspaceId: scope.workspaceId,
        cwd: dir,
        provider: "claude",
        title: null,
        labels: {},
        metadata: {},
        createdAt: nowIso,
        updatedAt: nowIso,
        lastStatus: "closed",
      }),
      now: () => now,
    });
    const item = await durableItems.create({
      serverId: "local",
      workspaceId: scope.workspaceId,
      requestId: "decision-1",
      sourceAgentId: scope.mainAgentId,
      sourceTurnId: "turn-1",
      kind: "acceptance",
      title: "Accept release",
      evidence: [],
    });
    const emitUpdated = vi.fn();
    const reconcileFinishedAttention = vi.fn(async () => {});
    const deps = {
      store,
      resolveScopes: async () => [scope],
      emitUpdated,
      reconcileFinishedAttention,
    };
    const type = "workspace.topic_read.mark_all.request";
    const unbounded = await handleTopicReadRequest({ type, requestId: "unbounded" }, deps);
    expect(unbounded.payload).toMatchObject({ snapshots: [{ watermarkSeq: -1 }], error: null });
    expect(reconcileFinishedAttention).not.toHaveBeenCalled();
    const bounded = await handleTopicReadRequest(
      { type, requestId: "bounded", ...key, epoch: scope.epoch, maxSeq: 8, maxTimestampMs: 80 },
      deps,
    );
    expect(bounded.payload).toMatchObject({ snapshots: [{ watermarkSeq: 8 }], error: null });
    expect(emitUpdated).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "workspace.topic_read.updated" }),
    );
    expect(reconcileFinishedAttention).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ watermarkSeq: 8 }),
    );
    expect(await todoStore.list({ workspaceIds: [scope.workspaceId] })).toEqual([todo]);
    expect(await durableItems.list({ serverId: "local" })).toMatchObject({ items: [item] });
  });
});
