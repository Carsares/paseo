import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { TopicDelegationStore, mergeTopicDelegationAnchors } from "./topic-delegation.js";

test("an early explicit report survives turn acknowledgement and store reconstruction", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-topic-dispatch-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const scope = { workspaceId: "workspace", mainAgentId: "main" };
  const first = {
    ...scope,
    messageId: "dispatch",
    rootMessageId: "first",
    rootPromptText: "First",
    serverId: "local",
    agentId: "resident",
  };
  const second = { ...first, rootMessageId: "second", rootPromptText: "Second", serverId: "other" };
  const store = new TopicDelegationStore(home);
  await store.admit(first);
  await store.admit(second);
  await store.submitting(first);
  await store.associateRun(first, "pending-turn");
  expect(await store.forReport({ ...first, turnId: "pending-turn" })).toMatchObject(first);
  expect(await store.forReport({ ...second, turnId: "pending-turn" })).toBeUndefined();
  await store.recordReport({ ...first, turnId: "pending-turn" }, "report", "completed");
  await store.start({ ...first, turnId: "accepted-turn" });
  await store.finish({ ...first, turnId: "accepted-turn" }, "ended");
  await store.start({ ...second, turnId: "accepted-turn" });
  const restarted = new TopicDelegationStore(home);
  expect(await restarted.anchors(scope)).toMatchObject([
    {
      topicKey: "msg:first",
      delegations: [{ status: "completed", reportIds: ["report"], turnId: "accepted-turn" }],
    },
    { topicKey: "msg:second", delegations: [{ status: "interrupted", serverId: "other" }] },
  ]);
});

test("sibling tasks under one root keep their own dispatches when the message anchor is promoted", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-topic-task-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const scope = { workspaceId: "workspace", mainAgentId: "main" };
  const common = {
    ...scope,
    rootMessageId: "root",
    rootPromptText: "Review two files",
    serverId: "local",
    agentId: "resident",
  };
  const store = new TopicDelegationStore(home);
  await store.admit({ ...common, messageId: "first", taskId: "task-a" });
  await store.admit({ ...common, messageId: "second", taskId: "task-b" });
  await store.admit({ ...common, messageId: "unbound" });
  const summaries = await store.anchors(scope);
  const taskAnchors = summaries
    .filter(({ taskId }) => taskId)
    .map((anchor) => Object.assign({}, anchor, { delegations: undefined }));
  expect(mergeTopicDelegationAnchors(taskAnchors, summaries)).toMatchObject([
    { taskId: "task-a", delegations: [{ messageId: "first" }, { messageId: "unbound" }] },
    { taskId: "task-b", delegations: [{ messageId: "second" }] },
  ]);
});
