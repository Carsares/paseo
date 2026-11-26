import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PARENT_AGENT_ID_LABEL,
  PARENT_SERVER_ID_LABEL,
  WORKSPACE_MAIN_ROLE,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type {
  WorkspaceTopicReplyRequest,
  WorkspaceTopicThreadUpdatedMessage,
} from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "../agent/agent-manager.js";
import type { AgentSession } from "../agent/agent-sdk-types.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { WorkspaceTaskLedgerStore } from "../agent/task-ledger/index.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTopicPromptDispatcher, createTopicReplyRouter } from "./reply-router.js";
import { TopicThreadStore } from "./store.js";

const request: WorkspaceTopicReplyRequest = {
  type: "workspace.topic.reply.request",
  requestId: "request",
  workspaceId: "workspace",
  mainAgentId: "main",
  topicKey: "the-topic",
  taskId: "task",
  rootMessageId: "root",
  clientMessageId: "follow-up",
  text: "What did we decide?",
};

let home: string;
let store: TopicThreadStore;
let ledger: WorkspaceTaskLedgerStore;
let router: ReturnType<typeof createTopicReplyRouter>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "paseo-topic-threads-"));
  store = new TopicThreadStore(home);
  ledger = new WorkspaceTaskLedgerStore(home);
});

afterEach(async () => {
  await router?.close();
  await rm(home, { recursive: true, force: true });
});

function setup(
  options: {
    archivedAt?: string;
    leadWorkspaceId?: string;
    leadParentId?: string;
    leadParentServerId?: string;
  } = {},
) {
  const broadcast = vi.fn<(event: WorkspaceTopicThreadUpdatedMessage) => void>();
  type Dispatch = Parameters<typeof createTopicReplyRouter>[0]["dispatch"];
  const dispatch = vi.fn<Dispatch>(async ({ validate, onStarted }) => {
    await validate();
    await onStarted();
    return { text: "The final answer.", sourceMessageId: "answer-message", authorTitle: "Role" };
  });
  router = createTopicReplyRouter({
    serverId: "local",
    store,
    taskLedger: ledger,
    readAgent: async (agentId) => {
      if (agentId === "main")
        return {
          workspaceId: "workspace",
          labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
        };
      if (agentId === "lead")
        return {
          workspaceId: options.leadWorkspaceId ?? "workspace",
          archivedAt: options.archivedAt,
          labels: {
            [PARENT_AGENT_ID_LABEL]: options.leadParentId ?? "main",
            [PARENT_SERVER_ID_LABEL]: options.leadParentServerId ?? "local",
          },
        };
      return null;
    },
    dispatch,
    broadcast,
    logger: createTestLogger(),
  });
  return { dispatch, broadcast };
}

test.each([
  { description: "default auto", target: "lead", reason: "none" },
  { description: "explicit lead mode", mode: "lead", target: "lead", reason: "none" },
  { description: "explicit main mode", mode: "main", target: "main", reason: "explicit_main" },
  { description: "Chinese mention", text: "@主控接着说", target: "main", reason: "explicit_main" },
  {
    description: "English mention",
    text: "@main explain",
    target: "main",
    reason: "explicit_main",
  },
  { description: "unbound task", noLead: true, target: "main", reason: "no_lead_bound" },
  {
    description: "archived lead",
    archivedAt: "2026-01-01",
    target: "main",
    reason: "lead_archived",
  },
  { description: "lead on another host", host: "remote", target: "main", reason: "remote_lead" },
  {
    description: "wrong workspace",
    leadWorkspaceId: "other-workspace",
    target: "main",
    reason: "lead_archived",
  },
  {
    description: "lead moved under another parent in the same workspace",
    leadParentId: "other-parent",
    target: "main",
    reason: "lead_archived",
  },
  {
    description: "lead whose parent is on another host",
    leadParentServerId: "other-host",
    target: "main",
    reason: "lead_archived",
  },
] as const)("routes $description and persists the exchange", async (scenario) => {
  const { dispatch, broadcast } = setup({
    archivedAt: "archivedAt" in scenario ? scenario.archivedAt : undefined,
    leadWorkspaceId: "leadWorkspaceId" in scenario ? scenario.leadWorkspaceId : undefined,
    leadParentId: "leadParentId" in scenario ? scenario.leadParentId : undefined,
    leadParentServerId: "leadParentServerId" in scenario ? scenario.leadParentServerId : undefined,
  });
  await ledger.upsert(request.workspaceId, {
    taskId: "task",
    title: "Task",
    rootMessageId: "root",
    leadAgentId: "noLead" in scenario ? undefined : "lead",
    leadServerId: "host" in scenario ? scenario.host : "local",
  });
  const input = {
    ...request,
    routeMode: "mode" in scenario ? scenario.mode : undefined,
    text: "text" in scenario ? scenario.text : request.text,
  };
  const [response, duplicate] = await Promise.all([
    router.reply(input),
    router.reply({ ...input, requestId: "retry" }),
  ]);
  expect(response.payload).toMatchObject({
    error: null,
    fallbackReason: scenario.reason,
    targetAgentId: scenario.target,
    entry: { role: "user_followup", topicKey: "the-topic", sourceMessageId: "follow-up" },
  });
  expect(duplicate.payload.entry?.entryId).toBe(response.payload.entry?.entryId);
  await vi.waitFor(async () => {
    expect((await ledger.list("workspace"))[0]?.latestReplyPreview).toBe("The final answer.");
  });
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      agentId: scenario.target,
      prompt: expect.stringContaining(
        '<paseo-topic-context task-id="task" root-message-id="root">',
      ),
    }),
  );
  const entries = await new TopicThreadStore(home).list(request, request.topicKey);
  expect(entries).toMatchObject([
    { role: "user_followup", status: "completed", seq: 1, text: input.text },
    {
      role: "agent_reply",
      status: "completed",
      seq: 2,
      authorAgentId: scenario.target,
      text: "The final answer.",
      sourceMessageId: "answer-message",
    },
  ]);
  expect(broadcast.mock.calls.map(([event]) => event.payload.entry.status)).toEqual([
    "queued",
    "running",
    "completed",
    "completed",
  ]);
});

test("scopes list and reply to the named workspace Main Control", async () => {
  const { dispatch } = setup();
  const wrong = { ...request, workspaceId: "other-workspace" };
  expect((await router.reply(wrong)).payload).toMatchObject({ entry: null, targetAgentId: null });
  const result = await router.list({
    type: "workspace.topic.list_entries.request",
    requestId: wrong.requestId,
    workspaceId: wrong.workspaceId,
    mainAgentId: wrong.mainAgentId,
  });
  expect(result.payload).toMatchObject({ entries: [], error: expect.any(String) });
  expect(dispatch).not.toHaveBeenCalled();
});

test("reroutes to Main Control if the lead is reparented after the reply is queued", async () => {
  const options = { leadParentId: "main" };
  const { dispatch } = setup(options);
  await ledger.upsert(request.workspaceId, {
    taskId: "task",
    title: "Task",
    rootMessageId: "root",
    leadAgentId: "lead",
  });
  const deliverToLead = vi.fn();
  dispatch.mockImplementationOnce(async ({ validate }) => {
    options.leadParentId = "other-parent";
    await validate();
    deliverToLead();
    return undefined;
  });
  expect((await router.reply(request)).payload).toMatchObject({ targetAgentId: "lead" });
  await vi.waitFor(async () => {
    expect(await new TopicThreadStore(home).list(request, request.topicKey)).toMatchObject([
      { role: "user_followup", status: "completed", routedAgentId: "main" },
      { role: "agent_reply", authorAgentId: "main" },
    ]);
  });
  expect(deliverToLead).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "main" }));
});

test("rechecks an automatic Main Control fallback before delivering", async () => {
  const { dispatch } = setup();
  const deliverToMain = vi.fn();
  dispatch.mockImplementationOnce(async ({ validate }) => {
    await ledger.upsert(request.workspaceId, {
      taskId: "task",
      title: "Task",
      rootMessageId: "root",
      leadAgentId: "lead",
      leadServerId: "local",
    });
    await validate();
    deliverToMain();
    return undefined;
  });
  const { payload } = await router.reply({ ...request, taskId: undefined });
  expect(payload).toMatchObject({ targetAgentId: "main", fallbackReason: "no_lead_bound" });
  await vi.waitFor(async () => {
    expect(await store.list(request)).toMatchObject([
      { entryId: payload.entry?.entryId, status: "completed", routedAgentId: "lead" },
      { role: "agent_reply", authorAgentId: "lead" },
    ]);
  });
  expect(deliverToMain).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "lead" }));
});

test.each(["queued", "running"] as const)(
  "retries a stale %s follow-up using the same client message ID",
  async (status) => {
    const stamp = "2026-01-01T00:00:00.000Z";
    const directory = join(home, "topic-threads");
    await mkdir(directory);
    await writeFile(
      join(directory, `${request.workspaceId}.json`),
      JSON.stringify([
        {
          workspaceId: request.workspaceId,
          mainAgentId: request.mainAgentId,
          topicKey: request.topicKey,
          taskId: request.taskId,
          rootMessageId: request.rootMessageId,
          sourceMessageId: request.clientMessageId,
          text: request.text,
          entryId: "old-entry",
          routedAgentId: "lead",
          role: "user_followup",
          status,
          ...(status === "running" ? { handoffPending: false } : {}),
          seq: 1,
          createdAt: stamp,
          updatedAt: stamp,
        },
      ]),
    );
    const { dispatch } = setup();
    expect(dispatch).not.toHaveBeenCalled();
    const [retry, duplicate] = await Promise.all([
      router.reply(request),
      router.reply({ ...request, requestId: "concurrent-retry" }),
    ]);
    for (const response of [retry, duplicate]) {
      expect(response.payload).toMatchObject({
        targetAgentId: "main",
        error: null,
        entry: { entryId: "old-entry", sourceMessageId: request.clientMessageId },
      });
    }
    await vi.waitFor(async () => {
      expect(await store.list(request)).toMatchObject([
        { entryId: "old-entry", status: "completed", routedAgentId: "main", seq: 1 },
        { role: "agent_reply", authorAgentId: "main", seq: 2 },
      ]);
    });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agentId: "main",
        messageId: request.clientMessageId,
      }),
    );
  },
);

test("atomic follow-up and reply writes keep distinct exchanges from concurrent store instances", async () => {
  const otherStore = new TopicThreadStore(home);
  const followup = { ...request, routedAgentId: "main" };
  const results = await Promise.all([
    store.begin({ ...followup, sourceMessageId: "first" }),
    otherStore.begin({ ...followup, sourceMessageId: "second" }),
  ]);
  await Promise.all([
    store.update(request.workspaceId, results[0].entry.entryId, "completed", { text: "one" }),
    otherStore.update(request.workspaceId, results[1].entry.entryId, "completed", { text: "two" }),
  ]);
  const entries = await new TopicThreadStore(home).list(request, request.topicKey);
  expect(entries.map(({ role, status, seq, text }) => [role, status, seq, text])).toEqual([
    ["user_followup", "completed", 1, request.text],
    ["user_followup", "completed", 2, request.text],
    ["agent_reply", "completed", 3, "one"],
    ["agent_reply", "completed", 4, "two"],
  ]);
});

function giveFirstAssistantChunkId(session: AgentSession, messageId: string) {
  const subscribe = session.subscribe.bind(session);
  let isFirstChunk = true;
  vi.spyOn(session, "subscribe").mockImplementation((receive) =>
    subscribe((event) => {
      if (isFirstChunk && event.type === "timeline" && event.item.type === "assistant_message") {
        isFirstChunk = false;
        receive({ ...event, item: { ...event.item, messageId } });
      } else {
        receive(event);
      }
    }),
  );
}

test("mirrors an accepted turn and does not resend it when recovering a legacy queued entry", async () => {
  const logger = createTestLogger();
  const agentStorage = new AgentStorage(join(home, "agents"), logger);
  const onStartTurn = vi.fn();
  const clients = createTestAgentClients({ onStartTurn });
  const client = clients.claude;
  const createSession = client.createSession.bind(client);
  vi.spyOn(client, "createSession").mockImplementation(async (...args) => {
    const session = await createSession(...args);
    giveFirstAssistantChunkId(session, "assistant-from-timeline");
    return session;
  });
  const agentManager = new AgentManager({
    clients,
    agentStreamCoalesceWindowMs: 0,
    registry: agentStorage,
    logger,
  });
  const main = await agentManager.createAgent({ provider: "claude", cwd: home }, undefined, {
    workspaceId: request.workspaceId,
  });
  const lead = await agentManager.createAgent({ provider: "claude", cwd: home }, undefined, {
    workspaceId: request.workspaceId,
    labels: { [PARENT_AGENT_ID_LABEL]: main.id },
  });
  const followup = { ...request, mainAgentId: main.id };
  await ledger.upsert(request.workspaceId, {
    taskId: "task",
    title: "Task",
    rootMessageId: "root",
    leadAgentId: lead.id,
  });
  const openRouter = () =>
    createTopicReplyRouter({
      serverId: "local",
      store: new TopicThreadStore(home),
      taskLedger: ledger,
      readAgent: async (id) => {
        const agent = agentManager.getAgent(id);
        if (!agent) return null;
        return id === main.id
          ? { ...agent, labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE } }
          : agent;
      },
      dispatch: createTopicPromptDispatcher({ agentManager, agentStorage, logger }),
      broadcast: () => {},
      logger,
    });
  router = openRouter();
  try {
    expect((await router.reply(followup)).payload).toMatchObject({
      error: null,
      targetAgentId: lead.id,
    });
    await vi.waitFor(async () => {
      const entries = await store.list(followup, followup.topicKey);
      expect(entries).toMatchObject([
        { role: "user_followup", status: "completed" },
        {
          role: "agent_reply",
          authorAgentId: lead.id,
          text: expect.stringMatching(/\S/),
          sourceMessageId: "assistant-from-timeline",
        },
      ]);
      expect((await ledger.list(request.workspaceId))[0]?.latestReplyPreview).toMatch(/\S/);
    });
    expect(agentManager.getTimeline(lead.id)).toContainEqual(
      expect.objectContaining({
        type: "user_message",
        text: expect.stringContaining(
          '<paseo-topic-context task-id="task" root-message-id="root">',
        ),
      }),
    );
    await router.close();
    const [accepted] = await store.list(followup);
    await writeFile(
      join(home, "topic-threads", `${request.workspaceId}.json`),
      JSON.stringify([{ ...accepted, status: "queued" }]),
    );
    router = openRouter();
    expect((await router.reply(followup)).payload.entry).toMatchObject({
      entryId: accepted.entryId,
      status: "error",
    });
    await router.close();
    expect(onStartTurn).toHaveBeenCalledTimes(1);
  } finally {
    await router.close();
    await Promise.all([agentManager.closeAgent(lead.id), agentManager.closeAgent(main.id)]);
  }
});

test.each([
  "archived",
  "reassigned",
  "reassigned to another host",
  "reassigned to a missing agent",
] as const)("delivers a queued follow-up once when the busy lead is %s", async (scenario) => {
  const logger = createTestLogger();
  const agentStorage = new AgentStorage(join(home, "agents"), logger);
  const holdLead = Promise.withResolvers<void>();
  const onStartTurn = vi.fn();
  const agentManager = new AgentManager({
    clients: createTestAgentClients({
      onStartTurn,
      beforeTurnComplete: async (prompt) => {
        if (prompt === "existing run") await holdLead.promise;
      },
    }),
    registry: agentStorage,
    logger,
  });
  const main = await agentManager.createAgent({ provider: "claude", cwd: home }, undefined, {
    workspaceId: request.workspaceId,
  });
  const createLead = () =>
    agentManager.createAgent({ provider: "claude", cwd: home }, undefined, {
      workspaceId: request.workspaceId,
      labels: { [PARENT_AGENT_ID_LABEL]: main.id },
    });
  const lead = await createLead();
  const replacement = await createLead();
  const recipient = scenario === "reassigned" ? replacement : main;
  const followup = { ...request, mainAgentId: main.id };
  await ledger.upsert(request.workspaceId, {
    taskId: "task",
    title: "Task",
    rootMessageId: "root",
    leadAgentId: lead.id,
    leadServerId: "local",
  });
  router = createTopicReplyRouter({
    serverId: "local",
    store,
    taskLedger: ledger,
    readAgent: async (id) => {
      const stored = await agentStorage.get(id);
      const live = agentManager.getAgent(id);
      const agent = live ?? stored;
      return (
        agent && {
          ...agent,
          archivedAt: stored?.archivedAt,
          labels: id === main.id ? { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE } : agent.labels,
        }
      );
    },
    dispatch: createTopicPromptDispatcher({ agentManager, agentStorage, logger }),
    broadcast: () => {},
    logger,
  });
  const subscribe = vi.spyOn(agentManager, "subscribe");
  const leadRun = (async () => {
    for await (const _event of agentManager.streamAgent(lead.id, "existing run")) {
      // Drain the occupied turn.
    }
  })();
  try {
    await vi.waitFor(() => expect(onStartTurn).toHaveBeenCalledTimes(1));
    const reply = await router.reply(followup);
    expect(reply.payload).toMatchObject({ targetAgentId: lead.id, entry: { status: "queued" } });
    await vi.waitFor(() => {
      expect(
        subscribe.mock.calls.filter(([, options]) => options?.agentId === lead.id),
      ).toHaveLength(2);
    });
    const queuedDuplicate = await router.reply({ ...followup, requestId: "duplicate-in-queue" });
    expect(queuedDuplicate.payload.entry).toEqual(reply.payload.entry);
    const archived = scenario === "archived" ? agentManager.archiveAgent(lead.id) : null;
    try {
      if (archived) {
        await vi.waitFor(async () => {
          expect((await agentStorage.get(lead.id))?.archivedAt).toBeTruthy();
        });
      } else {
        await ledger.upsert(request.workspaceId, {
          taskId: "task",
          leadAgentId:
            scenario === "reassigned to a missing agent" ? "missing-lead" : replacement.id,
          leadServerId: scenario === "reassigned to another host" ? "remote" : "local",
        });
        holdLead.resolve();
        await leadRun;
      }
      await vi.waitFor(async () => {
        expect(await store.list(followup)).toMatchObject([
          {
            entryId: reply.payload.entry?.entryId,
            status: "completed",
            routedAgentId: recipient.id,
          },
          { role: "agent_reply", topicKey: followup.topicKey, authorAgentId: recipient.id },
        ]);
      });
    } finally {
      holdLead.resolve();
      await archived;
    }
    const timeline = await agentManager.getTimelineRows(recipient.id);
    expect(timeline.map(({ item }) => item)).toEqual([
      expect.objectContaining({
        type: "user_message",
        clientMessageId: followup.clientMessageId,
        messageId: followup.clientMessageId,
      }),
      expect.objectContaining({ type: "assistant_message", text: expect.any(String) }),
    ]);
    expect(timeline[1].item).not.toHaveProperty("messageId");
    const exchange = await store.list(followup);
    expect(exchange).toMatchObject([
      { role: "user_followup", sourceMessageId: followup.clientMessageId },
      { role: "agent_reply", sourceMessageId: `topic-reply:${exchange[0].entryId}` },
    ]);
    expect(timeline[1].item).toMatchObject({ text: exchange[1].text });
    const duplicate = await router.reply({ ...followup, requestId: "duplicate-after-reroute" });
    expect(duplicate.payload).toMatchObject({
      targetAgentId: recipient.id,
      entry: exchange[0],
    });
    expect(await new TopicThreadStore(home).list(followup)).toEqual(exchange);
    expect(onStartTurn.mock.calls.map(([prompt]) => prompt)).toEqual([
      "existing run",
      expect.stringContaining(followup.text),
    ]);
  } finally {
    holdLead.resolve();
    await router.close();
    await leadRun;
    await Promise.all([lead, main, replacement].map(({ id }) => agentManager.closeAgent(id)));
  }
});
