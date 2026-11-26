import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PARENT_AGENT_ID_LABEL,
  PARENT_SERVER_ID_LABEL,
  TASK_ID_LABEL,
  WORKSPACE_MAIN_ROLE,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { FileTransferOpcode } from "@getpaseo/protocol/binary-frames/index";
import type {
  UploadedFileAttachment,
  WorkspaceTopicReplyRequest,
  WorkspaceTopicThreadUpdatedMessage,
} from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "../agent/agent-manager.js";
import type { AgentSession } from "../agent/agent-sdk-types.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { WorkspaceTaskLedgerStore } from "../agent/task-ledger/index.js";
import { FileUploadStore } from "../file-upload/index.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTopicPromptDispatcher, createTopicReplyRouter } from "./reply-router.js";
import { TopicThreadStore } from "./store.js";
import type { TopicUploadAccess } from "./uploaded-attachments.js";

const pngData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

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

async function uploadFile(fileName: string, mimeType: string, bytes: Buffer, owner?: string) {
  const uploads = new FileUploadStore({ paseoHome: home });
  const requestId = "upload-request";
  const size = bytes.byteLength;
  const modifiedAt = new Date(0).toISOString();
  uploads.beginUpload(
    {
      type: "file.upload.request",
      requestId,
      fileName,
      mimeType,
      size,
      modifiedAt,
    },
    undefined,
    undefined,
    owner,
  );
  const empty = new Uint8Array();
  await uploads.receiveFrame({
    opcode: FileTransferOpcode.FileBegin,
    requestId,
    metadata: { mime: mimeType, fileName, size, modifiedAt, encoding: "binary" },
    payload: empty,
  });
  await uploads.receiveFrame({ opcode: FileTransferOpcode.FileChunk, requestId, payload: bytes });
  const result = await uploads.receiveFrame({
    opcode: FileTransferOpcode.FileEnd,
    requestId,
    payload: empty,
  });
  const file = result?.payload.file;
  if (!file) throw new Error(result?.payload.error ?? "Upload failed.");
  return file;
}

function uploadAccess(...registered: UploadedFileAttachment[]): TopicUploadAccess {
  return {
    uploadsRoot: join(home, "uploads"),
    lookup: async (id) => registered.find((file) => file.id === id) ?? null,
  };
}

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
  const dispatch = vi.fn<Dispatch>(async ({ validate, onHandoff, onStarted }) => {
    await validate();
    await onHandoff(true);
    await onStarted();
    return {
      reply: { text: "The final answer.", sourceMessageId: "answer-message", authorTitle: "Role" },
      touchedFiles: [],
    };
  });
  router = createTopicReplyRouter({
    serverId: "local",
    store,
    taskLedger: ledger,
    readAgent: async (agentId) => {
      if (agentId === "main" || agentId === "other-main")
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
  { ingress: undefined, marked: false },
  { ingress: false, marked: false },
  { ingress: true, marked: true },
])(
  "passes ordinary reply ingress $ingress as humanInitiated $marked",
  async ({ ingress, marked }) => {
    const { dispatch } = setup();
    await ledger.upsert(request.workspaceId, {
      taskId: "task",
      title: "Task",
      rootMessageId: "root",
      leadAgentId: "lead",
    });
    expect((await router.reply(request, undefined, ingress)).payload).toMatchObject({
      error: null,
    });
    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agentId: "lead",
          scope: {
            workspaceId: "workspace",
            mainAgentId: "main",
            taskId: "task",
            humanInitiated: marked,
          },
        }),
      ),
    );
  },
);

test.each(["decision_reply", "butler_dispatch"] as const)(
  "dispatches %s without human authority even when ingress is true",
  async (origin) => {
    const { dispatch } = setup();
    const task = await ledger.upsert(request.workspaceId, {
      taskId: "task",
      title: "Task",
      rootMessageId: "root",
      leadAgentId: "lead",
      status: "in_progress",
    });
    const record = await store.reserveDecision({
      input: { ...request, resolutionKind: "task_blocking_question", note: request.text },
      origin,
      taskCreatedAt: task.createdAt,
      status: "awaiting_decision",
      desiredStatus: task.status,
      taskId: task.taskId,
      rootMessageId: task.rootMessageId,
    });
    await store.saveDecisionProgress(record, { task });
    const response = await router.reply(
      request,
      { origin, promptText: request.text, taskCreatedAt: task.createdAt },
      true,
    );
    expect(response.payload).toMatchObject({ error: null, entry: { origin } });
    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agentId: "lead",
          scope: {
            workspaceId: "workspace",
            mainAgentId: "main",
            taskId: "task",
            humanInitiated: false,
          },
        }),
      ),
    );
  },
);

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

test.each([
  { raisedDuringReply: false, status: "in_progress", blockingQuestion: undefined },
  { raisedDuringReply: true, status: "awaiting_decision", blockingQuestion: "Same question" },
] as const)(
  "writes files to the actual topic task and preserves a new blocking generation ($raisedDuringReply)",
  async ({ raisedDuringReply, status, blockingQuestion }) => {
    const { dispatch } = setup();
    await ledger.upsert(request.workspaceId, {
      taskId: "task",
      title: "Topic task",
      rootMessageId: "root",
      leadAgentId: "lead",
      status: "awaiting_decision",
      blockingQuestion: "Question at queue time",
    });
    const unrelated = await ledger.upsert(request.workspaceId, {
      taskId: "unrelated",
      title: "Other task of the same lead",
      leadAgentId: "lead",
      status: "awaiting_decision",
      blockingQuestion: "Same question",
    });
    dispatch.mockImplementationOnce(async ({ validate, onHandoff, onStarted }) => {
      await validate();
      await ledger.syncFromTurnOutcome(request.workspaceId, "task", {
        blockingQuestion: "Same question",
      });
      await onHandoff(true);
      await onStarted();
      if (raisedDuringReply)
        await ledger.syncFromTurnOutcome(request.workspaceId, "task", {
          blockingQuestion: "Same question",
        });
      return { reply: { text: "Here is the outcome" }, touchedFiles: ["src/reply.ts"] };
    });
    expect((await router.reply(request)).payload).toMatchObject({ error: null, routedTo: "lead" });
    await vi.waitFor(async () => {
      const tasks = await ledger.list(request.workspaceId);
      const actual = tasks.find(({ taskId }) => taskId === "task");
      expect(actual).toMatchObject({
        status,
        latestReplyPreview: "Here is the outcome",
        touchedFiles: ["src/reply.ts"],
      });
      expect(actual?.blockingQuestion).toBe(blockingQuestion);
      expect(tasks.find(({ taskId }) => taskId === "unrelated")).toEqual(unrelated);
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          workspaceId: "workspace",
          mainAgentId: "main",
          taskId: "task",
          humanInitiated: false,
        },
      }),
    );
  },
);

function provideStructuredEditEvents(session: AgentSession) {
  const subscribe = session.subscribe.bind(session);
  vi.spyOn(session, "subscribe").mockImplementation((receive) =>
    subscribe((event) => {
      if (
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.name === "Edit"
      ) {
        receive({
          ...event,
          item: { ...event.item, detail: { type: "edit", filePath: "test.txt" } },
        });
      } else {
        receive(event);
      }
    }),
  );
}

test("records an actual follow-up turn edit on the topic task even when the agent has another task label", async () => {
  const logger = createTestLogger();
  const agentStorage = new AgentStorage(join(home, "agents"), logger);
  const clients = createTestAgentClients();
  const client = clients.claude;
  const createSession = client.createSession.bind(client);
  vi.spyOn(client, "createSession").mockImplementation(async (...args) => {
    const session = await createSession(...args);
    provideStructuredEditEvents(session);
    return session;
  });
  const agentManager = new AgentManager({
    clients,
    registry: agentStorage,
    taskLedger: ledger,
    serverId: "local",
    logger,
  });
  const config = { provider: "claude", cwd: home, modeId: "bypassPermissions" } as const;
  const main = await agentManager.createAgent(config, undefined, {
    workspaceId: request.workspaceId,
    labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
  });
  const lead = await agentManager.createAgent(config, undefined, {
    workspaceId: request.workspaceId,
    labels: { [PARENT_AGENT_ID_LABEL]: main.id, [TASK_ID_LABEL]: "unrelated" },
  });
  await ledger.upsert(request.workspaceId, {
    taskId: "task",
    title: "Follow-up task",
    leadAgentId: lead.id,
    rootMessageId: "root",
  });
  await ledger.upsert(request.workspaceId, {
    taskId: "unrelated",
    title: "Previous lead assignment",
    leadAgentId: lead.id,
  });
  const edited = join(home, "test.txt");
  await writeFile(edited, "hello");
  router = createTopicReplyRouter({
    serverId: "local",
    store,
    taskLedger: ledger,
    readAgent: async (id) => agentManager.getAgent(id) ?? null,
    dispatch: createTopicPromptDispatcher({ agentManager, agentStorage, logger }),
    broadcast: () => {},
    logger,
  });
  try {
    const followup = {
      ...request,
      mainAgentId: main.id,
      text: "Edit the file test.txt and change hello to goodbye",
    };
    expect((await router.reply(followup)).payload).toMatchObject({
      error: null,
      targetAgentId: lead.id,
    });
    await vi.waitFor(async () => {
      expect(await store.list(followup)).toMatchObject([
        { status: "completed", role: "user_followup" },
        { role: "agent_reply", authorAgentId: lead.id },
      ]);
      const tasks = await ledger.list(request.workspaceId);
      expect(tasks.find(({ taskId }) => taskId === "task")).toMatchObject({
        touchedFiles: ["test.txt"],
        latestReplyPreview: expect.any(String),
      });
      expect(tasks.find(({ taskId }) => taskId === "unrelated")?.touchedFiles).toBeUndefined();
    });
    expect(await readFile(edited, "utf8")).toBe("goodbye");
  } finally {
    await router.close();
    await agentManager.flush();
  }
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

test("dispatches the registered image to the agent and does not resend an accepted turn", async () => {
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
    const attachment = await uploadFile(
      "screenshot.png",
      "image/png",
      Buffer.from(pngData, "base64"),
    );
    const { id, fileName, mimeType, size } = attachment;
    const imageAttachments = [{ id, fileName, mimeType, size }];
    expect(
      (
        await router.reply(
          { ...followup, attachments: [attachment] },
          undefined,
          true,
          uploadAccess(attachment),
        )
      ).payload,
    ).toMatchObject({
      error: null,
      targetAgentId: lead.id,
    });
    await vi.waitFor(async () => {
      const entries = await store.list(followup, followup.topicKey);
      expect(entries).toMatchObject([
        { role: "user_followup", status: "completed", imageAttachments },
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
        imageAttachments,
        text: expect.stringContaining(
          '<paseo-topic-context task-id="task" root-message-id="root">',
        ),
      }),
    );
    expect(onStartTurn).toHaveBeenCalledWith(
      [
        {
          type: "text",
          text: expect.stringContaining(
            '<paseo-topic-context task-id="task" root-message-id="root">',
          ),
        },
        { type: "image", mimeType: "image/png", data: pngData },
      ],
      expect.anything(),
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

test("backfills a historical stand-alone first question from the reply request without the main timeline", async () => {
  const { broadcast } = setup();
  const first = {
    ...request,
    taskId: undefined,
    topicKey: "msg:old-root",
    rootMessageId: "old-root",
    rootPromptPreview: "What should the original task cover?",
  };
  expect((await router.reply(first)).payload).toMatchObject({ error: null, routedTo: "main" });
  const listed = await router.list({
    type: "workspace.topic.list_entries.request",
    requestId: "list-historical",
    workspaceId: first.workspaceId,
    mainAgentId: first.mainAgentId,
    topicKey: first.topicKey,
  });
  const [anchor] = listed.payload.anchors ?? [];
  expect(anchor).toMatchObject({
    topicKey: first.topicKey,
    rootMessageId: first.rootMessageId,
    rootPromptText: first.rootPromptPreview,
  });
  expect(broadcast).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        anchor,
        entry: expect.objectContaining({ role: "user_followup", origin: "topic_reply" }),
      }),
    }),
  );
});

test.each([
  "unregistered",
  "path mismatch",
  "symlink",
  "size mismatch",
  "oversized image",
  "wrong contents",
] as const)("does not dispatch an upload with %s", async (reason) => {
  const { dispatch } = setup();
  const bytes = Buffer.from(pngData, "base64");
  let file = await uploadFile(
    "picture.png",
    "image/png",
    reason === "wrong contents" ? Buffer.from("not an image") : bytes,
  );
  const outside = join(home, "not-an-upload.png");
  await writeFile(outside, bytes);
  if (reason === "symlink") {
    const dir = dirname(file.path);
    const replacement = join(home, "not-an-upload-dir");
    await mkdir(replacement);
    await writeFile(join(replacement, file.fileName), bytes);
    await rm(dir, { recursive: true });
    await symlink(replacement, dir, "junction");
  }
  if (reason === "size mismatch") await truncate(file.path, file.size + 1);
  if (reason === "oversized image") {
    file = { ...file, size: 50 * 1024 * 1024 + 1 };
    await truncate(file.path, file.size);
  }
  const claimed = reason === "path mismatch" ? { ...file, path: outside } : file;
  const access = reason === "unregistered" ? uploadAccess() : uploadAccess(file);

  expect(
    (await router.reply({ ...request, attachments: [claimed] }, undefined, true, access)).payload
      .entry,
  ).toBeTruthy();
  await vi.waitFor(async () => expect((await store.list(request))[0]?.status).toBe("error"));
  expect(dispatch).not.toHaveBeenCalled();
});

test("retries only a confirmed rejected operation, using its stored attachments and route", async () => {
  const { dispatch, broadcast } = setup();
  await ledger.upsert(request.workspaceId, {
    taskId: "task",
    title: "Task",
    rootMessageId: "root",
    leadAgentId: "lead",
  });
  const attachment = await uploadFile("notes.txt", "text/plain", Buffer.from("notes"));
  const image = await uploadFile("retained-image.png", "image/png", Buffer.from(pngData, "base64"));
  const access = uploadAccess(attachment, image);
  dispatch.mockImplementationOnce(async ({ onHandoff }) => {
    await onHandoff(true);
    await onHandoff(false);
    throw new Error("Provider declined");
  });
  const original = await router.reply(
    {
      ...request,
      text: "[attachment]",
      routeMode: "lead",
      attachments: [attachment, image],
    },
    undefined,
    true,
    access,
  );
  const originalId = original.payload.entry?.entryId;
  if (!originalId) throw new Error("Missing original entry");
  await vi.waitFor(async () =>
    expect((await store.list(request))[0]).toMatchObject({ status: "error", retryable: true }),
  );
  await router.close();
  const { dispatch: restarted } = setup();
  const retry = {
    ...request,
    retryOfEntryId: originalId,
    clientMessageId: "retry-one",
    text: "Ignore this text",
    routeMode: "main" as const,
    taskId: "different",
    attachments: [{ ...attachment, path: "/uploads/other.png" }],
  };
  const retryReply = (payload: WorkspaceTopicReplyRequest) =>
    router.reply(payload, undefined, true, access);
  expect(
    (await retryReply({ ...retry, topicKey: "a-different-topic" })).payload.error,
  ).toBeTruthy();
  restarted.mockRejectedValueOnce(new Error("Could not open the provider"));
  const [first, repeat] = await Promise.all([retryReply(retry), retryReply(retry)]);
  expect(first.payload.entry?.entryId).toBeTruthy();
  expect(repeat.payload.entry?.entryId).toBe(first.payload.entry?.entryId);
  await vi.waitFor(async () => expect((await store.list(request))[0]?.retryable).toBe(true));
  expect((await retryReply({ ...retry, clientMessageId: "retry-two" })).payload.error).toBeNull();
  await vi.waitFor(async () => expect((await store.list(request))[2]?.status).toBe("completed"));
  expect(
    (await retryReply({ ...retry, clientMessageId: "retry-three" })).payload.error,
  ).toBeTruthy();
  expect(restarted).toHaveBeenCalledTimes(2);
  for (const [send] of restarted.mock.calls) {
    expect(send.agentId).toBe("lead");
    expect(send.prompt).toContainEqual(attachment);
    expect(send.prompt).toContainEqual({ type: "image", mimeType: "image/png", data: pngData });
    expect(JSON.stringify(send.prompt)).not.toContain("Ignore this text");
  }
  expect(JSON.stringify(broadcast.mock.calls)).not.toContain(attachment.path);
  expect(JSON.stringify(await store.list(request))).not.toContain(attachment.path);
});

test.each(["missing receipt", "other owner"] as const)(
  "only replaces attachments without a host receipt (%s)",
  async (scenario) => {
    const { dispatch } = setup();
    const png = Buffer.from(pngData, "base64");
    const legacy = await uploadFile(
      "picture.png",
      "image/png",
      png,
      scenario === "other owner" ? "other-owner" : undefined,
    );
    const kept = await uploadFile("notes.txt", "text/plain", Buffer.from("notes"), "owner");
    const uploads = new FileUploadStore({ paseoHome: home });
    const owner = uploads.getUploadAccess("owner");
    const original = await store.begin(
      {
        ...request,
        sourceMessageId: request.clientMessageId,
        routedAgentId: "main",
        origin: "topic_reply",
      },
      undefined,
      undefined,
      { attachments: [legacy, kept] },
    );
    await store.update(request.workspaceId, original.entry.entryId, "error");
    original.release?.();

    const retry = {
      ...request,
      retryOfEntryId: original.entry.entryId,
      clientMessageId: "retry-upload",
      text: "Ignore replacement text",
    };
    const send = (changes?: Partial<WorkspaceTopicReplyRequest>) =>
      router.reply({ ...retry, ...changes }, undefined, true, owner);
    const missing = await send();
    expect(missing.payload.entry).toBeNull();
    expect(missing.payload.error).toBe(
      scenario === "missing receipt"
        ? 'topic_attachments_reupload_required:["picture.png"]'
        : "Could not queue topic reply.",
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(await store.list(request)).toHaveLength(1);

    const replacement = await uploadFile("picture.png", "image/png", png, "owner");
    if (scenario === "other owner") {
      expect((await send({ attachments: [replacement] })).payload.error).toBeTruthy();
      expect(dispatch).not.toHaveBeenCalled();
      return;
    }
    expect((await send({ attachments: [replacement, kept] })).payload.error).toBe(
      missing.payload.error,
    );
    expect((await send({ attachments: [kept] })).payload.error).toBe(missing.payload.error);
    expect(
      (await send({ attachments: [{ ...replacement, path: legacy.path }] })).payload.error,
    ).toBeTruthy();
    const invalid = await uploadFile("picture.png", "image/png", Buffer.alloc(png.length), "owner");
    expect((await send({ attachments: [invalid] })).payload.entry).toBeNull();
    expect(await store.list(request)).toHaveLength(1);

    const hold = Promise.withResolvers<void>();
    dispatch.mockImplementationOnce(async ({ onStarted }) => {
      await hold.promise;
      await onStarted();
      return { touchedFiles: [] };
    });
    const [first, duplicate] = await Promise.all([
      send({ attachments: [replacement] }),
      send({ attachments: [replacement] }),
    ]);
    hold.resolve();
    expect(first.payload.entry).toMatchObject({
      text: request.text,
      rootMessageId: request.rootMessageId,
    });
    expect(duplicate.payload.entry?.entryId).toBe(first.payload.entry?.entryId);
    await vi.waitFor(async () => expect((await store.list(request))[1]?.status).toBe("completed"));
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0].prompt).toEqual([
      { type: "text", text: expect.stringContaining(request.text) },
      { type: "image", mimeType: "image/png", data: pngData },
      kept,
    ]);
    expect((await send()).payload.entry?.entryId).toBe(first.payload.entry?.entryId);
    expect(dispatch).toHaveBeenCalledOnce();
  },
);

test.each(["same request ID", "saved attempt ID"] as const)(
  "restores a reuploaded attachment from disk after reopening (%s)",
  async (resumeBy) => {
    const { dispatch } = setup();
    const png = Buffer.from(pngData, "base64");
    const legacy = await uploadFile("picture.png", "image/png", png);
    const replacement = await uploadFile("picture.png", "image/png", png, "owner");
    const otherReplacement = await uploadFile("picture.png", "image/png", png, "owner");
    const kept = await uploadFile("notes.txt", "text/plain", Buffer.from("notes"), "owner");
    const original = await store.begin(
      {
        ...request,
        sourceMessageId: request.clientMessageId,
        routedAgentId: "main",
        origin: "topic_reply",
      },
      undefined,
      undefined,
      { attachments: [legacy, kept] },
    );
    await store.update(request.workspaceId, original.entry.entryId, "error");
    original.release?.();

    const beforeHandoff = Promise.withResolvers<void>();
    dispatch.mockImplementationOnce(async ({ signal }) => {
      beforeHandoff.resolve();
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      signal.throwIfAborted();
      return { touchedFiles: [] };
    });
    const retryRequest = {
      ...request,
      retryOfEntryId: original.entry.entryId,
      clientMessageId: "recover-upload",
      text: "Ignore new text",
    };
    const first = await router.reply(
      { ...retryRequest, attachments: [replacement] },
      undefined,
      true,
      new FileUploadStore({ paseoHome: home }).getUploadAccess("owner"),
    );
    expect(first.payload.entry).toMatchObject({ status: "queued" });
    const attempt = first.payload.entry!;
    await beforeHandoff.promise;
    await router.close();

    store = new TopicThreadStore(home);
    ledger = new WorkspaceTaskLedgerStore(home);
    const { dispatch: restarted, broadcast } = setup();
    Object.assign(restarted, { wasAccepted: vi.fn(async () => false) });
    const access = new FileUploadStore({ paseoHome: home }).getUploadAccess("owner");
    const lookup = vi.spyOn(access, "lookup");
    const resume =
      resumeBy === "same request ID"
        ? retryRequest
        : {
            ...retryRequest,
            retryOfEntryId: attempt.entryId,
            clientMessageId: "new-click",
            attachments: [otherReplacement],
          };
    expect(restarted).not.toHaveBeenCalled();
    const results = await Promise.all([
      router.reply(resume, undefined, true, access),
      router.reply(resume, undefined, true, access),
    ]);
    for (const { payload } of results) {
      expect(payload.error).toBeNull();
      expect(payload.entry).toMatchObject({
        entryId: attempt.entryId,
        sourceMessageId: "recover-upload",
        text: request.text,
      });
    }
    await vi.waitFor(async () => expect((await store.list(request))[1]?.status).toBe("completed"));
    expect(restarted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        messageId: "recover-upload",
        prompt: [
          { type: "text", text: expect.stringContaining('root-message-id="root"') },
          { type: "image", mimeType: "image/png", data: pngData },
          kept,
        ],
      }),
    );
    expect(lookup).toHaveBeenCalledWith(replacement.id);
    expect(lookup).not.toHaveBeenCalledWith(otherReplacement.id);
    expect(lookup).not.toHaveBeenCalledWith(legacy.id);
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain(replacement.path);
  },
);

test("reopens an uncertain handoff without offering a new execution", async () => {
  const { dispatch } = setup();
  const waiting = Promise.withResolvers<void>();
  dispatch.mockImplementationOnce(async ({ onHandoff, signal }) => {
    await onHandoff(true);
    waiting.resolve();
    if (!signal.aborted)
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    throw new Error("Daemon stopped during handoff");
  });
  const first = await router.reply(request);
  const originalId = first.payload.entry?.entryId;
  if (!originalId) throw new Error("Missing original entry");
  await waiting.promise;
  await router.close();
  const { dispatch: restarted } = setup();
  expect((await router.reply(request)).payload.entry).toMatchObject({ status: "error" });
  expect((await store.list(request))[0]?.retryable).not.toBe(true);
  expect(
    (await router.reply({ ...request, retryOfEntryId: originalId, clientMessageId: "retry" }))
      .payload.error,
  ).toBeTruthy();
  const olderClient = await router.reply({ ...request, clientMessageId: `retry:${originalId}` });
  expect(olderClient.payload.error).toBeTruthy();
  expect(restarted).not.toHaveBeenCalled();
});

test.each([
  "unsubmitted",
  "bound-after-restart",
  "received",
  "late-receipt",
  "pending",
  "legacy",
] as const)(
  "only resumes an acknowledged retry after restart when it is known to be unsubmitted (%s)",
  async (state) => {
    const { dispatch } = setup();
    const bindsAfterRestart = state === "bound-after-restart";
    const canResume = state === "unsubmitted" || bindsAfterRestart;
    const initial = bindsAfterRestart
      ? { ...request, topicKey: "msg:root", taskId: undefined }
      : request;
    const attachment = await uploadFile("retained.txt", "text/plain", Buffer.from("notes"));
    const retryReply = (payload: WorkspaceTopicReplyRequest) =>
      router.reply(payload, undefined, true, uploadAccess(attachment));
    dispatch.mockRejectedValueOnce(new Error("Provider declined before handoff"));
    const original = (await retryReply({ ...initial, attachments: [attachment] })).payload.entry!;
    await vi.waitFor(async () => expect((await store.list(request))[0]?.retryable).toBe(true));
    const paused = Promise.withResolvers<void>();
    dispatch.mockImplementationOnce(async ({ onHandoff, signal }) => {
      if (state === "pending") await onHandoff(true);
      paused.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new Error("Daemon stopped");
    });
    const retryRequest = {
      ...initial,
      retryOfEntryId: original.entryId,
      clientMessageId: "persisted-retry",
    };
    const queued = (await retryReply(retryRequest)).payload.entry!;
    expect(queued).toMatchObject({ status: "queued", sourceMessageId: "persisted-retry" });
    expect(
      (await store.getDelivery(initial, { entryId: queued.entryId }))?.retryAttachments,
    ).toBeUndefined();
    await paused.promise;
    const listRequest = {
      workspaceId: request.workspaceId,
      mainAgentId: request.mainAgentId,
      requestId: "list",
      type: "workspace.topic.list_entries.request",
    } as const;
    expect((await router.list(listRequest)).payload.entries[1]?.retryable).not.toBe(true);
    await router.close();

    if (state === "legacy") {
      const file = join(home, "topic-threads", "workspace.json");
      const data = JSON.parse(await readFile(file, "utf8"));
      delete data.entries[1].handoffPending;
      await writeFile(file, JSON.stringify(data));
    }
    store = new TopicThreadStore(home);
    ledger = new WorkspaceTaskLedgerStore(home);
    if (bindsAfterRestart)
      await ledger.upsert(request.workspaceId, {
        taskId: "task",
        title: "Bound task",
        rootMessageId: "root",
      });
    const { dispatch: restarted } = setup();
    const wasAccepted = vi.fn(async () => state === "received" || state === "late-receipt");
    if (state === "late-receipt") wasAccepted.mockResolvedValueOnce(false);
    Object.assign(restarted, { wasAccepted });
    const listed = (await router.list(listRequest)).payload.entries;
    expect(listed[0]?.retryable).toBe(false);
    expect(listed[1]?.retryable === true).toBe(canResume || state === "late-receipt");
    const resume = {
      ...retryRequest,
      topicKey: bindsAfterRestart ? "task:task" : request.topicKey,
      retryOfEntryId: queued.entryId,
      text: "Discard this text",
    };

    if (canResume) {
      const results = await Promise.all(
        ["new-click", "repeat-click"].map((clientMessageId) =>
          retryReply({ ...resume, clientMessageId }),
        ),
      );
      for (const { payload } of results) {
        expect(payload.error).toBeNull();
        expect(payload.entry?.entryId).toBe(queued.entryId);
      }
      await vi.waitFor(async () =>
        expect((await store.list(request))[1]?.status).toBe("completed"),
      );
      expect(restarted).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ messageId: "persisted-retry" }),
      );
      const [send] = restarted.mock.calls[0];
      expect(send.scope.taskId).toBe(bindsAfterRestart ? "task" : undefined);
      expect(send.prompt).toContainEqual(attachment);
      expect(JSON.stringify(send.prompt)).toContain(request.text);
      expect(JSON.stringify(send.prompt)).not.toContain(resume.text);
    } else {
      await retryReply({ ...resume, clientMessageId: "new-click" });
      await retryReply(retryRequest);
      expect(restarted).not.toHaveBeenCalled();
    }
    expect(
      (await store.list(request)).filter((entry) => entry.role === "user_followup"),
    ).toHaveLength(2);
  },
);

test.each([
  "unique",
  "already-promoted",
  "recreated-after-promotion",
  "ambiguous",
  "wrong-main",
  "wrong-root",
  "delivered",
] as const)(
  "validates the live task binding when retrying a message reply from a task card (%s)",
  async (state) => {
    const { dispatch } = setup();
    if (state !== "delivered")
      dispatch.mockRejectedValueOnce(new Error("Provider declined before handoff"));
    const beforeBinding = { ...request, topicKey: "msg:root", taskId: undefined };
    const original = (await router.reply(beforeBinding)).payload.entry!;
    await vi.waitFor(async () => {
      const [entry] = await store.list(request, "msg:root");
      expect(entry?.status).toBe(state === "delivered" ? "completed" : "error");
    });
    await router.close();
    const bound = await ledger.upsert(request.workspaceId, {
      taskId: "task",
      title: "Bound task",
      rootMessageId: state === "wrong-root" ? "other-root" : "root",
      leadAgentId: "lead",
      ...(state === "recreated-after-promotion" ? { status: "completed" } : {}),
    });
    if (state === "ambiguous")
      await ledger.upsert(request.workspaceId, {
        taskId: "second",
        title: "Conflicting task",
        rootMessageId: "root",
      });
    if (state === "already-promoted" || state === "recreated-after-promotion")
      await store.upsertAnchor(
        {
          ...request,
          topicKey: "task:task",
          rootPromptText: "First question",
        },
        undefined,
        await ledger.list(request.workspaceId),
      );
    if (state === "recreated-after-promotion") {
      expect(await store.list(request, "task:task")).toMatchObject([
        { entryId: original.entryId, retryable: true },
      ]);
      for (let i = 0; i < 50; i++) {
        await ledger.upsert(request.workspaceId, {
          taskId: `closed-${i}`,
          title: `Closed ${i}`,
          status: "completed",
        });
      }
      expect((await ledger.list(request.workspaceId)).some(({ taskId }) => taskId === "task")).toBe(
        false,
      );
      const replacement = await ledger.upsert(request.workspaceId, {
        taskId: "task",
        title: "Replacement task",
        rootMessageId: "root",
        leadAgentId: "lead",
      });
      expect(replacement.createdAt).not.toBe(bound.createdAt);
    }
    const { dispatch: afterBinding } = setup();
    const retry = {
      ...request,
      mainAgentId: state === "wrong-main" ? "other-main" : request.mainAgentId,
      topicKey: "task:task",
      retryOfEntryId: original.entryId,
      clientMessageId: "new-attempt",
      taskId: "ignore-client-task",
      rootMessageId: "ignore-client-root",
    };
    const [first, repeat] = await Promise.all([router.reply(retry), router.reply(retry)]);
    if (state === "unique" || state === "already-promoted") {
      expect(first.payload.error).toBeNull();
      expect(repeat.payload.entry?.entryId).toBe(first.payload.entry?.entryId);
      await vi.waitFor(async () =>
        expect((await store.list(request, "task:task"))[1]?.status).toBe("completed"),
      );
      expect(await store.list(request, "msg:root")).toEqual([]);
      expect(await store.list(request, "task:task")).toMatchObject([
        { entryId: original.entryId, status: "error", retryable: false, taskId: "task" },
        { sourceMessageId: "new-attempt", status: "completed", taskId: "task" },
        { role: "agent_reply", taskId: "task" },
      ]);
      expect(afterBinding).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agentId: "lead",
          scope: expect.objectContaining({ taskId: "task" }),
        }),
      );
    } else {
      for (const { payload } of [first, repeat]) {
        expect(payload.entry).toBeNull();
        expect(payload.error).toBe("Could not queue topic reply.");
      }
      expect(afterBinding).not.toHaveBeenCalled();
      const entries = await store.list(request);
      if (state === "delivered") {
        expect(entries.filter((entry) => entry.role === "user_followup")).toMatchObject([
          { entryId: original.entryId, status: "completed" },
        ]);
      } else {
        const sourceKey = state === "recreated-after-promotion" ? "task:task" : "msg:root";
        expect(entries.filter((entry) => entry.topicKey === sourceKey)).toMatchObject([
          { entryId: original.entryId, retryable: true },
        ]);
      }
    }
  },
);

test("refuses a retry if a second task binds the root between validation and handoff", async () => {
  const { dispatch } = setup();
  dispatch.mockRejectedValueOnce(new Error("Provider declined before handoff"));
  const original = (
    await router.reply({
      ...request,
      topicKey: "msg:root",
      taskId: undefined,
    })
  ).payload.entry!;
  await vi.waitFor(async () => expect((await store.list(request))[0]?.retryable).toBe(true));
  await ledger.upsert(request.workspaceId, {
    taskId: "task",
    title: "Bound task",
    rootMessageId: "root",
  });
  const handedOff = vi.fn();
  dispatch.mockImplementationOnce(async ({ validate, onHandoff }) => {
    await validate();
    await ledger.upsert(request.workspaceId, {
      taskId: "second",
      title: "Conflicting task",
      rootMessageId: "root",
    });
    await onHandoff(true);
    handedOff();
  });
  const retry = {
    ...request,
    topicKey: "task:task",
    retryOfEntryId: original.entryId,
    clientMessageId: "retry-before-conflict",
  };
  expect((await router.reply(retry)).payload.error).toBeNull();
  await vi.waitFor(async () =>
    expect(await store.list(request, "task:task")).toMatchObject([
      { entryId: original.entryId, retryable: true },
      { sourceMessageId: "retry-before-conflict", status: "error" },
    ]),
  );
  expect(handedOff).not.toHaveBeenCalled();
  expect(
    (await router.reply({ ...retry, clientMessageId: "retry-after-conflict" })).payload.error,
  ).toBe("Could not queue topic reply.");
  expect(dispatch).toHaveBeenCalledTimes(2);
});
