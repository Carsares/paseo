import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
