import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TopicThreadStore } from "./store.js";

const followup = {
  workspaceId: "workspace",
  mainAgentId: "main",
  topicKey: "topic",
  sourceMessageId: "client-message",
  routedAgentId: "lead",
  text: "Follow up",
};

let home: string;
let store: TopicThreadStore;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "paseo-topic-store-"));
  store = new TopicThreadStore(home);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("only one store can claim an active follow-up, and a declined handoff can retry", async () => {
  const otherStore = new TopicThreadStore(home);
  const first = await store.begin(followup);
  try {
    expect(first.release).toBeTypeOf("function");
    expect(await otherStore.begin(followup)).toEqual({ entry: first.entry, changed: false });
    await store.setHandoffPending(followup.workspaceId, first.entry.entryId, true);
    await store.setHandoffPending(followup.workspaceId, first.entry.entryId, false);
  } finally {
    first.release?.();
  }
  const retry = await otherStore.begin({ ...followup, routedAgentId: "main" });
  try {
    expect(retry.release).toBeTypeOf("function");
    expect(retry.entry).toMatchObject({
      entryId: first.entry.entryId,
      sourceMessageId: followup.sourceMessageId,
      status: "queued",
      routedAgentId: "main",
      seq: first.entry.seq,
    });
    expect(retry.entry).not.toHaveProperty("handoffPending");
    await expect(store.begin({ ...followup, text: "Changed" })).rejects.toThrow("already used");
  } finally {
    retry.release?.();
  }
});

test.each(["queued", "running"] as const)(
  "does not resend an interrupted %s entry after a possible provider handoff",
  async (status) => {
    const first = await store.begin(followup);
    try {
      await store.setHandoffPending(followup.workspaceId, first.entry.entryId, true);
      if (status === "running")
        await store.update(followup.workspaceId, first.entry.entryId, status);
      const [listed] = await store.list(followup);
      expect(listed).toMatchObject({ status });
      expect(listed).not.toHaveProperty("handoffPending");
    } finally {
      first.release?.();
    }

    const restarted = new TopicThreadStore(home);
    const checkAccepted = vi.fn(async () => false);
    const recovered = await restarted.begin({ ...followup, routedAgentId: "main" }, checkAccepted);
    expect(recovered.changed).toBe(true);
    expect(recovered.release).toBeUndefined();
    expect(recovered.entry).toMatchObject({
      entryId: first.entry.entryId,
      sourceMessageId: followup.sourceMessageId,
      status: "error",
      routedAgentId: "lead",
    });
    expect(checkAccepted).not.toHaveBeenCalled();
    expect(await restarted.begin(followup)).toEqual({ entry: recovered.entry, changed: false });
  },
);

test.each(["completed", "error"] as const)(
  "keeps a terminal %s entry idempotent",
  async (status) => {
    const first = await store.begin(followup);
    try {
      await store.update(followup.workspaceId, first.entry.entryId, status);
    } finally {
      first.release?.();
    }
    const restarted = new TopicThreadStore(home);
    const retry = await restarted.begin({ ...followup, routedAgentId: "main" });
    expect(retry).toEqual({
      entry: expect.objectContaining({
        entryId: first.entry.entryId,
        status,
        routedAgentId: "lead",
      }),
      changed: false,
    });
  },
);

test("persists one stable reply ID when the dispatcher returns no message ID", async () => {
  const { entry, release } = await store.begin(followup);
  const answer = { text: "Answer without a provider ID" };
  try {
    const changes = await store.update(followup.workspaceId, entry.entryId, "completed", answer);
    expect(changes).toMatchObject([
      { role: "user_followup", sourceMessageId: followup.sourceMessageId },
      { role: "agent_reply", sourceMessageId: `topic-reply:${entry.entryId}`, ...answer },
    ]);
    const restarted = new TopicThreadStore(home);
    expect(
      await restarted.update(followup.workspaceId, entry.entryId, "completed", answer),
    ).toEqual([]);
    expect(await restarted.list(followup)).toEqual(changes);
  } finally {
    release?.();
  }
});

test("recovers legacy running entries without resending a turn that already started", async () => {
  const first = await store.begin(followup);
  first.release?.();
  await writeFile(
    join(home, "topic-threads", `${followup.workspaceId}.json`),
    JSON.stringify([{ ...first.entry, status: "running" }]),
  );
  const recovered = await new TopicThreadStore(home).begin(followup);
  expect(recovered.entry).toMatchObject({ entryId: first.entry.entryId, status: "error" });
  expect(recovered.release).toBeUndefined();
});

test("reads an old array and merges a UI first question into its task without losing history or crossing scope", async () => {
  const first = {
    workspaceId: followup.workspaceId,
    mainAgentId: followup.mainAgentId,
    topicKey: "msg:root",
    rootMessageId: "root",
    rootPromptText: "Actual first question from the UI",
  };
  const legacy = { ...followup, topicKey: first.topicKey, rootMessageId: first.rootMessageId };
  const old = await store.begin(legacy);
  old.release?.();
  const file = join(home, "topic-threads", "workspace.json");
  await writeFile(file, JSON.stringify([old.entry]));
  expect(await store.listWithAnchors(first)).toEqual({ entries: [old.entry], anchors: [] });
  const original = await store.upsertAnchor(first);
  const other = await store.upsertAnchor({
    ...first,
    mainAgentId: "other",
    rootPromptText: "Other main",
  });
  const bound = await store.upsertAnchor({
    ...first,
    topicKey: "task:task",
    taskId: "task",
    title: "Title",
    leadAgentId: "lead",
    rootPromptText: "Fallback task title",
  });
  expect(bound).toMatchObject({
    topicKey: "task:task",
    taskId: "task",
    rootMessageId: "root",
    rootPromptText: first.rootPromptText,
    createdAt: original.createdAt,
    leadAgentId: "lead",
  });
  const reopened = new TopicThreadStore(home);
  expect(await reopened.listWithAnchors(first, first.topicKey)).toEqual({
    entries: [],
    anchors: [],
  });
  expect(await reopened.listWithAnchors(first, bound.topicKey)).toEqual({
    entries: [{ ...old.entry, topicKey: bound.topicKey, taskId: "task" }],
    anchors: [bound],
  });
  const secondTask = await reopened.upsertAnchor({
    ...first,
    topicKey: "task:second",
    taskId: "second",
    title: "Second task",
    rootPromptText: "Second task fallback",
  });
  expect(secondTask.rootPromptText).toBe(first.rootPromptText);
  expect(await reopened.listWithAnchors(first, secondTask.topicKey)).toEqual({
    entries: [],
    anchors: [secondTask],
  });
  expect(await reopened.listWithAnchors(other)).toEqual({ entries: [], anchors: [other] });
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 2 });
  await expect(reopened.upsertAnchor({ ...bound, rootMessageId: "different" })).rejects.toThrow(
    "different first message",
  );
  await expect(reopened.upsertAnchor({ ...bound, taskId: "different" })).rejects.toThrow(
    "does not belong",
  );
});

test("keeps explicit legacy reply ownership and leaves ambiguous replies under the message key", async () => {
  const root = {
    workspaceId: followup.workspaceId,
    mainAgentId: followup.mainAgentId,
    topicKey: "msg:root",
    rootMessageId: "root",
    rootPromptText: "One question for two tasks",
  };
  await store.upsertAnchor(root);
  const bound = await store.begin({ ...followup, ...root, taskId: "B" });
  bound.release?.();
  await store.update(root.workspaceId, bound.entry.entryId, "completed");
  const unbound = await store.begin({
    ...followup,
    ...root,
    sourceMessageId: "unbound",
  });
  unbound.release?.();

  await store.upsertAnchor({ ...root, topicKey: "task:A", taskId: "A" });
  const reopened = new TopicThreadStore(home);
  expect(await reopened.list(root, "task:A")).toEqual([]);
  expect(await reopened.list(root, root.topicKey)).toEqual([
    { ...bound.entry, status: "completed" },
    unbound.entry,
  ]);

  await reopened.upsertAnchor({ ...root, topicKey: "task:B", taskId: "B" });
  const readBack = new TopicThreadStore(home);
  expect(await readBack.list(root, "task:B")).toEqual([
    { ...bound.entry, status: "completed", topicKey: "task:B", taskId: "B" },
  ]);
  expect(await readBack.list(root, root.topicKey)).toEqual([unbound.entry]);
  expect(await readBack.list(root, "task:A")).toEqual([]);
});

test("uses known task bindings before their anchors are written", async () => {
  const root = {
    workspaceId: followup.workspaceId,
    mainAgentId: followup.mainAgentId,
    topicKey: "msg:root",
    rootMessageId: "root",
    rootPromptText: "One question for two tasks",
  };
  await store.upsertAnchor(root);
  const legacy = await store.begin({ ...followup, ...root });
  legacy.release?.();
  const a = { ...root, topicKey: "task:A", taskId: "A" };
  const b = { ...root, topicKey: "task:B", taskId: "B" };
  for (const task of [a, b]) await store.upsertAnchor(task, undefined, [a, b]);
  expect(await new TopicThreadStore(home).list(root, root.topicKey)).toEqual([legacy.entry]);
});

test("keeps the 500 most recently updated anchors without pruning the thread history", async () => {
  const { entry, release } = await store.begin(followup);
  release?.();
  const anchors = Array.from({ length: 500 }, (_, index) => ({
    workspaceId: followup.workspaceId,
    mainAgentId: followup.mainAgentId,
    topicKey: `msg:r-${index}`,
    rootMessageId: `r-${index}`,
    rootPromptText: "Original prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }));
  const file = join(home, "topic-threads", "workspace.json");
  await writeFile(file, JSON.stringify({ version: 2, anchors, entries: [entry] }));
  const extra = await store.upsertAnchor({
    ...anchors[0]!,
    topicKey: "msg:new",
    rootMessageId: "new",
  });
  const latest = await new TopicThreadStore(home).listWithAnchors(followup);
  expect(latest).toEqual({ entries: [entry], anchors: [...anchors.slice(1), extra] });
});

test("persists one silent report per source message across concurrent stores and restart", async () => {
  const report = {
    workspaceId: followup.workspaceId,
    mainAgentId: followup.mainAgentId,
    topicKey: "task:ship",
    taskId: "ship",
    rootMessageId: "root",
    text: "Ready for acceptance",
    sourceMessageId: "report-id",
    authorAgentId: "lead",
    authorTitle: "Implementer",
    reportStatus: "completed",
  } as const;
  const [first, duplicate] = await Promise.all([
    store.appendReportEntry(report),
    new TopicThreadStore(home).appendReportEntry(report),
  ]);
  expect(first).toMatchObject({
    changed: true,
    entry: {
      ...report,
      origin: "subagent_report",
      role: "agent_reply",
      routedAgentId: "lead",
      status: "completed",
    },
  });
  expect(duplicate).toEqual({ changed: false, entry: first.entry });
  const reopened = new TopicThreadStore(home);
  expect(await reopened.appendReportEntry(report)).toEqual(duplicate);
  expect(await reopened.list(report)).toEqual([first.entry]);
  await expect(
    reopened.appendReportEntry({ ...report, topicKey: "task:else", taskId: "else" }),
  ).rejects.toThrow("already used");
});
