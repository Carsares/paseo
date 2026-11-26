import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getOpenAgentTabLabel } from "@getpaseo/protocol/agent-labels";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { PARENT_AGENT_ID_LABEL, PARENT_REPORTING_LABEL } from "@getpaseo/protocol/agent-labels";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  WSOutboundMessageSchema,
  type SessionOutboundMessage,
  type WorkspaceCreateRequest,
} from "@getpaseo/protocol/messages";
import { expect, test, vi, type TestContext } from "vitest";
import { createTestLogger } from "../test-utils/test-logger.js";
import { WebSocket, type RawData } from "ws";
import type { AgentPromptInput } from "./agent/agent-sdk-types.js";
import { AgentManager } from "./agent/agent-manager.js";
import { ensureAgentLoaded } from "./agent/agent-loading.js";
import { QueuedPromptLoadError } from "./agent/agent-prompt.js";
import { TASK_ID_LABEL } from "./agent/hierarchy-policy.js";
import { WorkspaceTaskLedgerStore } from "./agent/task-ledger/index.js";
import { openDurableItemStore } from "./durable-items/requests.js";
import { resetInMemoryPeerDispatchStateForTest } from "./agent/agent-messages/envelope.js";
import { MessageReceipts } from "./message-receipts/index.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { TopicThreadStore } from "./topic-threads/store.js";
import { FileUploadStore } from "./file-upload/index.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import { FileBackedWorkspaceRegistry } from "./workspace-registry.js";

const LEGACY_CLIENT = "topic-tests-legacy";
const CURRENT_CLIENT = "topic-tests-current";
const CURRENT_APP_VERSION = "0.18.0";
const TEST_TIMEOUT = 25_000;

type Response<T extends SessionOutboundMessage["type"]> = Extract<
  SessionOutboundMessage,
  { type: T }
>;

test(
  "keeps image-only topic questions and replies readable from a cold WebSocket timeline",
  async (context) => {
    const onStartTurn = vi.fn();
    const daemon = await startDaemon(context, {
      agentClients: createTestAgentClients({ onStartTurn }),
    });
    const { socket } = await daemon.connect(CURRENT_CLIENT, CURRENT_APP_VERSION);
    const workspace = await createWorkspace(
      socket,
      directoryWorkspace(daemon, {
        title: "Topic image upload",
        topic: { summary: "Topic image upload" },
        mainAgent: { config: { provider: "codex", cwd: daemon.staticDir } },
      }),
    );
    const mainAgentId = workspace.mainAgent?.id;
    if (!mainAgentId) throw new Error("Expected a Main Control agent");
    const mimeType = "image/png";
    const data =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
    const bytes = Buffer.from(data, "base64");
    const rootMessageId = randomUUID();
    const root = await request(
      socket,
      {
        type: "send_agent_message_request",
        agentId: mainAgentId,
        messageId: rootMessageId,
        text: "",
        images: [{ data, mimeType }],
      },
      "send_agent_message_response",
    );
    expect(root.payload.accepted).toBe(true);
    await vi.waitFor(() =>
      expect(daemon.daemon.agentManager.hasInFlightRun(mainAgentId)).toBe(false),
    );

    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "topic-image-upload",
      appVersion: CURRENT_APP_VERSION,
    });
    context.onTestFinished(() => client.close());
    await client.connect();
    const uploaded = await client.uploadFile({
      fileName: "build-output.png",
      mimeType,
      bytes,
    });
    if (!uploaded.file) throw new Error(uploaded.error ?? "Expected a completed upload");
    const followupId = randomUUID();
    const address = {
      workspaceId: workspace.workspace.id,
      mainAgentId,
      topicKey: `msg:${rootMessageId}`,
    };
    await expect(
      client.replyWorkspaceTopic({
        ...address,
        rootMessageId,
        clientMessageId: followupId,
        text: " ",
        attachments: [uploaded.file],
      }),
    ).resolves.toMatchObject({ entry: { text: " " }, error: null });
    await vi.waitFor(() => {
      expect(onStartTurn).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining(`root-message-id="${rootMessageId}"`),
          }),
          { type: "image", data, mimeType },
        ]),
        expect.anything(),
      );
    });
    await vi.waitFor(async () => {
      const list = await client.listWorkspaceTopicEntries(address);
      expect(list.entries[0]?.status).toBe("completed");
    });
    await daemon.daemon.agentManager.closeAgent(mainAgentId);
    await client.close();
    const cold = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "topic-image-cold",
      appVersion: CURRENT_APP_VERSION,
    });
    context.onTestFinished(() => cold.close());
    await cold.connect();

    const list = await cold.listWorkspaceTopicEntries(address);
    const rootImage = list.anchors[0]?.imageAttachments?.[0];
    const { id, fileName, size } = uploaded.file;
    const replyImage = { id, fileName, mimeType, size };
    expect(rootImage).toEqual({
      id: expect.stringMatching(/^upload_/),
      fileName: "image.png",
      mimeType,
      size: bytes.length,
    });
    expect(list.entries[0]?.imageAttachments).toEqual([replyImage]);
    expect(JSON.stringify(list)).not.toContain(daemon.paseoHome);
    expect(JSON.stringify(list)).not.toContain('"delivery"');

    const timeline = await cold.fetchAgentTimeline(mainAgentId, { direction: "tail" });
    expect(timeline.entries.map(({ item }) => item)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "user_message",
          messageId: rootMessageId,
          imageAttachments: [rootImage],
        }),
        expect.objectContaining({
          type: "user_message",
          messageId: followupId,
          imageAttachments: [replyImage],
        }),
      ]),
    );
    for (const reference of [rootImage!, replyImage]) {
      const path = `paseo-attachment:${reference.id}`;
      const file = await cold.readFile(daemon.staticDir, path);
      expect(file).toMatchObject({
        kind: "image",
        mime: mimeType,
        path,
        bytes: new Uint8Array(bytes),
      });
    }
    const foreignImage = await new FileUploadStore({
      paseoHome: daemon.paseoHome,
    }).persistMessageImage({
      owner: "different-principal",
      bytes,
      mimeType,
    });
    await expect(
      cold.readFile(daemon.staticDir, `paseo-attachment:${foreignImage.id}`),
    ).rejects.toThrow("Image attachment is unavailable.");
    const reset = await request(
      socket,
      { type: "agent.session.reset.request", agentId: mainAgentId, clearVisibleTimeline: true },
      "agent.session.reset.response",
    );
    expect(reset.payload.accepted).toBe(true);
    const refreshed = await cold.listWorkspaceTopicEntries(address);
    expect(refreshed.anchors[0]?.imageAttachments).toEqual([rootImage]);
    expect(refreshed.entries[0]?.imageAttachments).toEqual([replyImage]);
  },
  TEST_TIMEOUT,
);

test(
  "rejects an old blocking question version over WebSocket without starting Main Control",
  async (context) => {
    const start = vi.fn();
    const daemon = await startDaemon(context, {
      agentClients: createTestAgentClients({ onStartTurn: start }),
    });
    const { socket } = await daemon.connect(CURRENT_CLIENT, CURRENT_APP_VERSION, {
      [CLIENT_CAPS.workspaceButlerV1]: true,
    });
    const topic = await createWorkspace(
      socket,
      directoryWorkspace(daemon, {
        title: "Blocking question",
        topic: { summary: "Blocking question" },
        mainAgent: { config: { provider: "codex", cwd: daemon.staticDir } },
      }),
    );
    const mainAgentId = topic.mainAgent?.id;
    if (!mainAgentId) throw new Error("Expected a Main Control agent");
    const workspaceId = topic.workspace.id;
    const taskId = "blocked-task";
    const blockingQuestion = "Which day?";
    const ledger = new WorkspaceTaskLedgerStore(daemon.paseoHome);
    const first = await ledger.upsert(workspaceId, {
      taskId,
      title: "Pick a date",
      status: "awaiting_decision",
      blockingQuestion,
    });
    const current = await ledger.syncFromTurnOutcome(workspaceId, taskId, { blockingQuestion });
    const result = await request(
      socket,
      {
        type: "workspace.topic.decide.request",
        workspaceId,
        mainAgentId,
        topicKey: `task:${taskId}`,
        taskId,
        resolutionKind: "task_blocking_question",
        expectedBlockingQuestionGeneration: first.blockingQuestionGeneration,
        clientMessageId: randomUUID(),
        note: "Friday",
      },
      "workspace.topic.decide.response",
    );
    expect(result.payload).toMatchObject({
      accepted: false,
      errorCode: "stale_blocking_question",
      task: {
        blockingQuestion,
        blockingQuestionGeneration: current?.blockingQuestionGeneration,
      },
      routedTo: "none",
      entry: null,
    });
    expect(await ledger.list(workspaceId)).toEqual([current]);
    expect(await new TopicThreadStore(daemon.paseoHome).list({ workspaceId, mainAgentId })).toEqual(
      [],
    );
    expect(start).not.toHaveBeenCalled();
  },
  TEST_TIMEOUT,
);

for (const closed of [false, true]) {
  test(
    `preserves legacy topic questions through WebSocket reset (closed=${closed})`,
    async (context) => {
      const daemon = await startDaemon(context);
      const { socket } = await daemon.connect(CURRENT_CLIENT, CURRENT_APP_VERSION, {
        [CLIENT_CAPS.workspaceButlerV1]: true,
      });
      const topic = await createWorkspace(
        socket,
        directoryWorkspace(daemon, {
          title: "Legacy topic history",
          topic: { summary: "Legacy topic history" },
          mainAgent: { config: { provider: "codex", cwd: daemon.staticDir } },
        }),
      );
      const agentId = topic.mainAgent?.id;
      if (!agentId) throw new Error("Expected a Main Control agent");
      const workspaceId = topic.workspace.id;
      const scope = { workspaceId, mainAgentId: agentId };
      const manager = daemon.daemon.agentManager;
      await ensureAgentLoaded(agentId, {
        agentManager: manager,
        agentStorage: daemon.daemon.agentStorage,
        logger: createTestLogger(),
      });
      const boundRoot = randomUUID();
      const boundProviderId = randomUUID();
      const unboundRoot = randomUUID();
      const followupId = randomUUID();
      await manager.appendTimelineItem(agentId, {
        type: "user_message",
        text: "Original bound question",
        messageId: boundProviderId,
        clientMessageId: boundRoot,
      });
      await manager.appendTimelineItem(agentId, {
        type: "user_message",
        text: "Original unbound question",
        messageId: unboundRoot,
      });
      await manager.appendTimelineItem(agentId, {
        type: "user_message",
        text: "Follow-up already on the topic",
        messageId: followupId,
      });
      const ledger = new WorkspaceTaskLedgerStore(daemon.paseoHome);
      await ledger.upsert(workspaceId, {
        taskId: "historic",
        rootMessageId: boundRoot,
        title: "Task title",
        leadAgentId: "lead",
      });
      if (closed) await manager.closeAgent(agentId);
      const list = async () =>
        (
          await request(
            socket,
            { type: "workspace.topic.list_entries.request", ...scope },
            "workspace.topic.list_entries.response",
          )
        ).payload;
      const reset = async () =>
        (
          await request(
            socket,
            { type: "agent.session.reset.request", agentId, clearVisibleTimeline: true },
            "agent.session.reset.response",
          )
        ).payload;
      const visibleRootIds = async () =>
        (closed
          ? (
              await manager.readStoredTimeline((await daemon.daemon.agentStorage.get(agentId))!, {
                limit: 0,
              })
            ).rows
          : manager.fetchTimeline(agentId, { limit: 0 }).rows
        ).flatMap(({ item }) => (item.type === "user_message" ? [item.messageId] : []));
      expect((await list()).anchors).toEqual([]);
      expect(await visibleRootIds()).toEqual([boundProviderId, unboundRoot, followupId]);

      const path = join(daemon.paseoHome, "topic-threads", `${workspaceId}.json`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "{invalid");
      expect(await reset()).toMatchObject({ accepted: false });
      expect(await visibleRootIds()).toEqual([boundProviderId, unboundRoot, followupId]);
      await rm(path);

      const followup = await new TopicThreadStore(daemon.paseoHome).begin({
        ...scope,
        topicKey: `msg:${boundRoot}`,
        rootMessageId: boundRoot,
        routedAgentId: agentId,
        sourceMessageId: followupId,
        text: "Follow-up already on the topic",
      });
      followup.release?.();

      const deletion = vi
        .spyOn(manager, "deleteCommittedTimeline")
        .mockRejectedValueOnce(new Error("Timeline delete failed"));
      try {
        expect(await reset()).toMatchObject({ accepted: false, error: "Timeline delete failed" });
        expect(await visibleRootIds()).toEqual([boundProviderId, unboundRoot, followupId]);
      } finally {
        deletion.mockRestore();
      }
      const anchors = (await list()).anchors;
      expect(anchors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            topicKey: "task:historic",
            rootMessageId: boundRoot,
            rootPromptText: "Original bound question",
            title: "Task title",
            leadAgentId: "lead",
          }),
          expect.objectContaining({
            topicKey: `msg:${unboundRoot}`,
            rootMessageId: unboundRoot,
            rootPromptText: "Original unbound question",
          }),
        ]),
      );
      expect(anchors).toHaveLength(2);
      expect(await reset()).toMatchObject({ accepted: true, error: null });
      expect(await visibleRootIds()).toEqual([]);
      expect(await list()).toMatchObject({
        anchors,
        entries: [{ topicKey: "task:historic", sourceMessageId: followupId }],
      });
    },
    TEST_TIMEOUT,
  );
}

test(
  "preserves legacy topics before conversation rewind removes their visible messages",
  async (context) => {
    const daemon = await startDaemon(context);
    const { socket } = await daemon.connect(CURRENT_CLIENT, CURRENT_APP_VERSION, {
      [CLIENT_CAPS.workspaceButlerV1]: true,
    });
    const topic = await createWorkspace(
      socket,
      directoryWorkspace(daemon, {
        title: "Rewindable topic",
        topic: { summary: "Rewindable topic" },
        mainAgent: { config: { provider: "codex", cwd: daemon.staticDir } },
      }),
    );
    const agentId = topic.mainAgent?.id;
    if (!agentId) throw new Error("Expected a Main Control agent");
    const workspaceId = topic.workspace.id;
    const manager = daemon.daemon.agentManager;
    await ensureAgentLoaded(agentId, {
      agentManager: manager,
      agentStorage: daemon.daemon.agentStorage,
      logger: createTestLogger(),
    });
    const session = manager.getAgent(agentId)?.session;
    if (!session) throw new Error("Expected an interactive provider session");
    session.capabilities.supportsRewindConversation = true;
    session.revertConversation = vi.fn(async () => {});
    vi.spyOn(session, "streamHistory").mockImplementation(async function* () {});
    const root = randomUUID();
    await manager.appendTimelineItem(agentId, {
      type: "user_message",
      text: "A question that predates topic anchors",
      messageId: root,
    });
    const rewind = async () =>
      (
        await request(
          socket,
          {
            type: "agent.rewind.request",
            agentId,
            messageId: root,
            mode: "conversation",
          },
          "agent.rewind.response",
        )
      ).payload;
    const path = join(daemon.paseoHome, "topic-threads", `${workspaceId}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{invalid");
    expect(await rewind()).toMatchObject({ ok: false });
    expect(session.revertConversation).not.toHaveBeenCalled();
    expect(manager.getTimeline(agentId)).toContainEqual(
      expect.objectContaining({ messageId: root }),
    );
    await rm(path);
    expect(await rewind()).toMatchObject({ ok: true });
    expect(session.revertConversation).toHaveBeenCalledTimes(1);
    expect(manager.getTimeline(agentId)).not.toContainEqual(
      expect.objectContaining({ messageId: root }),
    );
    expect(
      (
        await new TopicThreadStore(daemon.paseoHome).listWithAnchors({
          workspaceId,
          mainAgentId: agentId,
        })
      ).anchors,
    ).toMatchObject([
      {
        topicKey: `msg:${root}`,
        rootMessageId: root,
        rootPromptText: "A question that predates topic anchors",
      },
    ]);
  },
  TEST_TIMEOUT,
);

function send(socket: WebSocket, message: object): void {
  socket.send(JSON.stringify({ type: "session", message }));
}

function waitForSession<T>(
  socket: WebSocket,
  description: string,
  select: (message: SessionOutboundMessage) => T | undefined,
  timeoutMs = 6_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${description}`));
    }, timeoutMs);
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success || parsed.data.type !== "session") return;
      const selected = select(parsed.data.message);
      if (selected === undefined) return;
      cleanup();
      resolve(selected);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`WebSocket closed while waiting for ${description}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

function request<T extends SessionOutboundMessage["type"]>(
  socket: WebSocket,
  message: { type: string; requestId?: string } & Record<string, unknown>,
  responseType: T,
): Promise<Response<T>> {
  const requestId = message.requestId ?? randomUUID();
  const response = waitForSession<Response<T> | Response<"rpc_error">>(
    socket,
    `${responseType} for ${message.type}`,
    (candidate) => {
      if (!("payload" in candidate)) return;
      const { payload } = candidate;
      if (!payload || typeof payload !== "object" || !("requestId" in payload)) return;
      if (payload.requestId !== requestId) return;
      if (candidate.type === responseType) return candidate as Response<T>;
      if (candidate.type === "rpc_error") return candidate;
    },
  ).then((candidate) => {
    if (candidate.type !== responseType) {
      throw new Error(
        `Unexpected RPC error for ${message.type}: ${JSON.stringify(candidate.payload)}`,
      );
    }
    return candidate as Response<T>;
  });
  send(socket, { ...message, requestId });
  return response;
}

async function startDaemon(
  context: TestContext,
  options: Parameters<typeof createTestPaseoDaemon>[0] = {},
) {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false, ...options });
  const sockets = new Set<WebSocket>();
  context.onTestFinished(async () => {
    for (const socket of sockets) socket.terminate();
    await daemon.close();
  });
  return {
    ...daemon,
    async connect(clientId: string, appVersion?: string, capabilities?: Record<string, boolean>) {
      const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      await once(socket, "open");
      const info = waitForSession(socket, "server_info", (message) =>
        message.type === "status" && message.payload.status === "server_info"
          ? message.payload
          : undefined,
      );
      socket.send(
        JSON.stringify({
          type: "hello",
          clientId,
          clientType: "browser",
          protocolVersion: 1,
          ...(appVersion ? { appVersion } : {}),
          ...(capabilities ? { capabilities } : {}),
        }),
      );
      return { socket, info: await info };
    },
  };
}

function directoryWorkspace(
  daemon: TestPaseoDaemon,
  options: Omit<WorkspaceCreateRequest, "type" | "source" | "requestId"> = {},
): WorkspaceCreateRequest {
  return {
    type: "workspace.create.request",
    requestId: randomUUID(),
    source: { kind: "directory", path: daemon.staticDir },
    ...options,
  };
}

async function createWorkspace(socket: WebSocket, input: WorkspaceCreateRequest) {
  const { payload } = await request(socket, input, "workspace.create.response");
  expect(payload.error).toBeNull();
  if (!payload.workspace) throw new Error("The daemon returned no workspace");
  return { ...payload, workspace: payload.workspace };
}

async function fetchDirectory(socket: WebSocket) {
  const { payload } = await request(
    socket,
    { type: "fetch_workspaces_request" },
    "fetch_workspaces_response",
  );
  return payload.entries;
}

async function openInteractiveAgent(socket: WebSocket, agentId: string): Promise<void> {
  const requestId = randomUUID();
  const refreshed = waitForSession(socket, "agent_refreshed", (event) =>
    event.type === "status" &&
    event.payload.status === "agent_refreshed" &&
    event.payload.requestId === requestId
      ? event.payload
      : undefined,
  );
  send(socket, { type: "refresh_agent_request", agentId, requestId });
  await refreshed;
}

async function createEmptySideChat(
  daemon: Awaited<ReturnType<typeof startDaemon>>,
  socket: WebSocket,
) {
  const config = { provider: "codex", cwd: daemon.staticDir };
  const { mainAgent, workspace } = await createWorkspace(
    socket,
    directoryWorkspace(daemon, { mainAgent: { config } }),
  );
  if (!mainAgent) throw new Error("Expected a main control agent");
  await openInteractiveAgent(socket, mainAgent.id);
  const manager = daemon.daemon.agentManager;
  await manager.appendTimelineItem(mainAgent.id, {
    type: "user_message",
    text: "Fork from this turn",
  });
  const timeline = manager.fetchTimeline(mainAgent.id);
  const { payload } = await request(
    socket,
    {
      type: "agent.create.request",
      config,
      workspaceId: workspace.id,
      sideChatFromAgentId: mainAgent.id,
      forkFrom: {
        sourceAgentId: mainAgent.id,
        boundaryCursor: { epoch: timeline.epoch, seq: 1 },
      },
    },
    "agent.create.response",
  );
  expect(payload.error).toBeNull();
  const side = payload.agent;
  if (!side) throw new Error("Expected a side chat");
  return side;
}

test(
  "an empty side chat can be discarded in the same daemon after a delete write fails",
  async (context) => {
    const daemon = await startDaemon(context);
    const { socket } = await daemon.connect(CURRENT_CLIENT, CURRENT_APP_VERSION);
    const side = await createEmptySideChat(daemon, socket);
    const storage = daemon.daemon.agentStorage;
    const prefix = await storage.timelinePrefixes.load(side.id);
    expect(prefix?.rows).toHaveLength(1);
    const digest = createHash("sha256").update(side.id).digest("hex");
    const intentPath = join(daemon.paseoHome, "agents", `.delete-${digest}.intent`);
    await mkdir(intentPath);
    const discard = { type: "delete_agent_request", agentId: side.id, onlyIfEmptySideChat: true };
    expect((await request(socket, discard, "rpc_error")).payload.code).toBe("agent_delete_failed");
    expect(await storage.timelinePrefixes.load(side.id)).toEqual(prefix);
    await rm(intentPath, { recursive: true });
    const record = await storage.get(side.id);
    if (!record) throw new Error("The side chat snapshot was lost");
    await storage.setTitle(side.id, "Still available");
    expect((await storage.get(side.id))?.title).toBe("Still available");
    expect((await request(socket, discard, "agent_deleted")).payload.agentId).toBe(side.id);
    await storage.upsert(record);
    expect(await storage.get(side.id)).toBeNull();
    expect(await storage.timelinePrefixes.load(side.id)).toBeNull();
    expect(await storage.hasDeletedAgent(side.id)).toBe(true);
  },
  TEST_TIMEOUT,
);

test(
  "a side chat archive protects its snapshot from a later discard after an unreadable delete",
  async (context) => {
    const daemon = await startDaemon(context);
    const { socket } = await daemon.connect(CURRENT_CLIENT, CURRENT_APP_VERSION);
    const side = await createEmptySideChat(daemon, socket);
    const storage = daemon.daemon.agentStorage;
    const prefix = await storage.timelinePrefixes.load(side.id);
    expect(prefix?.rows).toHaveLength(1);
    const isSnapshot = (file: unknown) =>
      typeof file === "string" && basename(file) === `${side.id}.json`;
    const inaccessible = Object.assign(new Error("Snapshot temporarily inaccessible"), {
      code: "EACCES",
    });
    const originalUnlink = fs.unlink;
    const originalRead = fs.readFile;
    const unlink = vi
      .spyOn(fs, "unlink")
      .mockImplementation((...args) =>
        isSnapshot(args[0]) ? Promise.reject(inaccessible) : originalUnlink(...args),
      );
    const read = vi
      .spyOn(fs, "readFile")
      .mockImplementation((...args) =>
        isSnapshot(args[0]) ? Promise.reject(inaccessible) : originalRead(...args),
      );
    const discard = { type: "delete_agent_request", agentId: side.id, onlyIfEmptySideChat: true };
    const archive = {
      type: "archive_agent_request",
      agentId: side.id,
      explicitSideChatArchive: true,
    };
    const update = { type: "update_agent_request", agentId: side.id, labels: { color: "blue" } };
    try {
      expect((await request(socket, discard, "rpc_error")).payload.code).toBe(
        "agent_delete_failed",
      );
      expect((await request(socket, archive, "rpc_error")).payload.error).toContain(
        "Refresh and retry",
      );
      expect((await request(socket, update, "update_agent_response")).payload.accepted).toBe(false);
      expect((await storage.get(side.id))?.labels.color).toBeUndefined();
    } finally {
      read.mockRestore();
      unlink.mockRestore();
    }

    const { payload } = await request(socket, archive, "agent_archived");
    expect((await request(socket, update, "update_agent_response")).payload.accepted).toBe(true);
    expect((await request(socket, discard, "rpc_error")).payload.code).toBe("side_chat_not_empty");
    const archived = await storage.get(side.id);
    expect(archived).toMatchObject({ archivedAt: payload.archivedAt, labels: { color: "blue" } });
    expect(await storage.timelinePrefixes.load(side.id)).toEqual(prefix);
    expect(await storage.hasDeletedAgent(side.id)).toBe(false);
  },
  TEST_TIMEOUT,
);

test.for(["archive", "delete", "interrupted delete", "missing delete evidence", "active"] as const)(
  "Stop preserves a durable peer message until recipient disposition is known (%s)",
  async (scenario, context) => {
    const factorySpy = vi.spyOn(AgentManager.prototype, "setPaseoToolCatalogFactory");
    context.onTestFinished(() => factorySpy.mockRestore());
    const firstTurn = vi.fn();
    let finishFirstTurn!: () => void;
    const unfinished = new Promise<void>((resolve) => {
      finishFirstTurn = resolve;
    });
    context.onTestFinished(finishFirstTurn);
    const first = await startDaemon(context, {
      cleanup: false,
      mcpEnabled: true,
      agentClients: createTestAgentClients({
        onStartTurn: firstTurn,
        beforeTurnComplete: (prompt) =>
          prompt === "Start a human turn" ? unfinished : Promise.resolve(),
      }),
    });
    const { socket } = await first.connect(CURRENT_CLIENT, CURRENT_APP_VERSION);
    const makeWorkspaceWithAgent = async (name: string) => {
      const cwd = join(first.staticDir, name);
      await mkdir(cwd);
      return createWorkspace(socket, {
        ...directoryWorkspace(first, { mainAgent: { config: { provider: "codex", cwd } } }),
        source: { kind: "directory", path: cwd },
      });
    };
    const { mainAgent: sender } = await makeWorkspaceWithAgent("sender");
    const { mainAgent: recipient, workspace } = await makeWorkspaceWithAgent("recipient");
    if (!sender || !recipient) throw new Error("Expected main control agents");
    await openInteractiveAgent(socket, recipient.id);
    const humanPrompt = (client: WebSocket, prompt: string) =>
      request(
        client,
        {
          type: "send_agent_message_request",
          agentId: recipient.id,
          text: prompt,
          messageId: randomUUID(),
          activeTurnBehavior: "steer",
        },
        "send_agent_message_response",
      );
    expect((await humanPrompt(socket, "Start a human turn")).payload.accepted).toBe(true);
    await vi.waitFor(() => expect(firstTurn).toHaveBeenCalledOnce());
    const factory = factorySpy.mock.lastCall?.[0];
    if (!factory) throw new Error("Daemon did not install its tool catalog");
    const catalog = await factory({ callerAgentId: sender.id, verifiedCallerAgentId: sender.id });
    const sent = await catalog.executeTool("send_peer_message", {
      targetWorkspaceId: workspace.id,
      intent: "query",
      message: "Inspect the current design",
    });
    expect(sent.structuredContent).toMatchObject({
      success: true,
      deliveryStatus: "queued",
      messageId: expect.any(String),
    });
    const { messageId } = sent.structuredContent as { messageId: string };
    const { payload: stop } = await request(
      socket,
      { type: "cancel_agent_request", agentId: recipient.id },
      "cancel_agent_response",
    );
    expect(stop.error).toBeNull();
    finishFirstTurn();

    const directory = join(first.paseoHome, "agent-requests");
    let receipts = new MessageReceipts(directory);
    let statePath = join(first.paseoHome, "agents", "peer-workspace-state.json");
    const checkHeld = async () =>
      expect(await receipts.queuedMessages()).toMatchObject([
        {
          agentId: recipient.id,
          queued: { message: { messageId, heldAfterStop: true } },
        },
      ]);
    const checkRejected = async () => {
      expect(await receipts.queuedMessages()).toEqual([]);
      const state = JSON.parse(await readFile(statePath, "utf8"));
      expect(state.messages).toEqual([]);
      expect(state.threads).toEqual([]);
    };
    await vi.waitFor(checkHeld);
    // Preserve the exact queue bytes to simulate a daemon stopping after the archive write.
    const savedReceipts = await Promise.all(
      (await readdir(directory))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const path = join(directory, name);
          return [path, await readFile(path)] as const;
        }),
    );
    const savedState = await readFile(statePath);
    let restartRoot = dirname(first.paseoHome);
    if (scenario === "archive") {
      await request(
        socket,
        { type: "archive_agent_request", agentId: recipient.id },
        "agent_archived",
      );
      expect((await first.daemon.agentStorage.get(recipient.id))?.archivedAt).toEqual(
        expect.any(String),
      );
    } else if (scenario === "delete") {
      await request(
        socket,
        { type: "delete_agent_request", agentId: recipient.id },
        "agent_deleted",
      );
      expect(await first.daemon.agentStorage.get(recipient.id)).toBeNull();
    } else if (scenario === "interrupted delete" || scenario === "missing delete evidence") {
      let reachedHistoryCleanup!: () => void;
      let failHistoryCleanup!: () => void;
      const deletingHistory = new Promise<void>((resolve) => {
        reachedHistoryCleanup = resolve;
      });
      const completeDelete = new Promise<void>((resolve) => {
        failHistoryCleanup = resolve;
      });
      const notify = vi.spyOn(first.daemon.agentManager, "notifyAgentRemoved");
      const deleteState = vi
        .spyOn(first.daemon.agentManager, "deleteAgentState")
        .mockImplementationOnce(async () => {
          reachedHistoryCleanup();
          await completeDelete;
          throw new Error("Simulated history cleanup failure");
        });
      const deletion = request(
        socket,
        { type: "delete_agent_request", agentId: recipient.id },
        "agent_deleted",
      );
      try {
        await Promise.race([
          deletingHistory,
          deletion.then(() => {
            throw new Error("Request completed before history cleanup");
          }),
        ]);
        expect(deleteState).toHaveBeenCalledExactlyOnceWith(recipient.id);
        expect(notify).not.toHaveBeenCalled();
        expect(await first.daemon.agentStorage.get(recipient.id)).toBeNull();
        await checkHeld();
        expect(await readFile(statePath)).toEqual(savedState);
        restartRoot = await mkdtemp(join(tmpdir(), "paseo-delete-restart-"));
        const copiedHome = join(restartRoot, ".paseo");
        await cp(first.paseoHome, copiedHome, { recursive: true });
        if (scenario === "missing delete evidence") {
          const agents = join(copiedHome, "agents");
          const intent = (await readdir(agents)).find((name) => name.endsWith(".intent"));
          if (!intent) throw new Error("The interrupted deletion did not leave a marker");
          await rm(join(agents, intent));
        }
      } finally {
        failHistoryCleanup();
        await deletion;
        deleteState.mockRestore();
        notify.mockRestore();
      }
    }
    if (scenario !== "active") await vi.waitFor(checkRejected);
    expect(firstTurn).toHaveBeenCalledOnce();
    await first.close();
    if (scenario === "archive") {
      await writeFile(statePath, savedState);
      for (const [path, bytes] of savedReceipts) await writeFile(path, bytes);
      await checkHeld();
    }
    if (restartRoot !== dirname(first.paseoHome)) {
      receipts = new MessageReceipts(join(restartRoot, ".paseo", "agent-requests"));
      statePath = join(restartRoot, ".paseo", "agents", "peer-workspace-state.json");
    }
    resetInMemoryPeerDispatchStateForTest();

    const resume = vi.fn(async () => {});
    const starts = vi.fn();
    const agentClients = createTestAgentClients({
      beforeResumeSession: resume,
      onStartTurn: starts,
    });
    const codex = agentClients.codex!;
    const resumeSession = codex.resumeSession.bind(codex);
    const handoff = vi.fn();
    codex.resumeSession = async (...args) => {
      const session = await resumeSession(...args);
      const start = session.startTurn.bind(session);
      return Object.assign(session, {
        capabilities: {
          ...session.capabilities,
          supportsPeerReadOnlyTurn: true as const,
          defersPromptHandoff: true,
        },
        async startTurn(...[prompt, options]: Parameters<typeof session.startTurn>) {
          await options?.beforeProviderDispatch?.();
          options?.assertProviderDispatchAllowed?.();
          if (options?.turnAuthorization) handoff(options.clientMessageId);
          options?.onPeerPromptSubmitting?.();
          const turn = await start(prompt, options);
          await options?.onPeerPromptAccepted?.();
          return turn;
        },
      });
    };
    const restarted = await startDaemon(context, {
      mcpEnabled: true,
      paseoHomeRoot: restartRoot,
      staticDir: first.staticDir,
      resumeOnStartup: false,
      agentClients,
    });
    if (scenario === "missing delete evidence") {
      expect(await restarted.daemon.agentStorage.get(recipient.id)).toBeNull();
      expect(await restarted.daemon.agentStorage.hasDeletedAgent(recipient.id)).toBe(false);
      await checkHeld();
      expect(await readFile(statePath)).toEqual(savedState);
    } else if (scenario === "active") await checkHeld();
    else await vi.waitFor(checkRejected);
    expect(resume).not.toHaveBeenCalled();
    expect(starts).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
    if (scenario === "active") {
      const { socket: client } = await restarted.connect(CURRENT_CLIENT, CURRENT_APP_VERSION);
      await openInteractiveAgent(client, recipient.id);
      await checkHeld();
      expect(starts).not.toHaveBeenCalled();
      expect((await humanPrompt(client, "Continue after Stop")).payload.accepted).toBe(true);
      await vi.waitFor(
        async () => expect(await receipts.outcome(recipient.id, messageId)).toBe("accepted"),
        { timeout: 6_000 },
      );
      expect(handoff.mock.calls).toEqual([[messageId]]);
      expect(starts).toHaveBeenCalledTimes(2);
    }
  },
  TEST_TIMEOUT,
);

test.for(["deliver", "sender archived", "recipient archived", "unsupported provider"] as const)(
  "durable peer messages resume after the recipient is opened (%s)",
  async (scenario, context) => {
    const factorySpy = vi.spyOn(AgentManager.prototype, "setPaseoToolCatalogFactory");
    context.onTestFinished(() => factorySpy.mockRestore());
    const first = await startDaemon(context, { cleanup: false, mcpEnabled: true });
    const { socket } = await first.connect(CURRENT_CLIENT, CURRENT_APP_VERSION);
    const senderDir = join(first.staticDir, "sender");
    const recipientDir = join(first.staticDir, "recipient");
    await Promise.all([mkdir(senderDir), mkdir(recipientDir)]);
    const makeWorkspaceWithAgent = (cwd: string) =>
      createWorkspace(socket, {
        ...directoryWorkspace(first, { mainAgent: { config: { provider: "codex", cwd } } }),
        source: { kind: "directory", path: cwd },
      });
    const { mainAgent: sender } = await makeWorkspaceWithAgent(senderDir);
    const { mainAgent: recipient, workspace } = await makeWorkspaceWithAgent(recipientDir);
    if (!sender || !recipient) throw new Error("Expected main control agents");
    await openInteractiveAgent(socket, recipient.id);
    await first.daemon.agentManager.closeAgent(recipient.id);
    expect((await first.daemon.agentStorage.get(recipient.id))?.persistence?.sessionId).toEqual(
      expect.any(String),
    );

    const factory = factorySpy.mock.lastCall?.[0];
    if (!factory) throw new Error("Daemon did not install its tool catalog");
    const catalog = await factory({ callerAgentId: sender.id, verifiedCallerAgentId: sender.id });
    const sent = await catalog.executeTool("send_peer_message", {
      targetWorkspaceId: workspace.id,
      intent: "query",
      expectReply: false,
      message: "Inspect the current design",
    });
    expect(sent.structuredContent).toMatchObject({
      success: true,
      deliveryStatus: "queued",
      messageId: expect.any(String),
    });
    const messageId = (sent.structuredContent as { messageId: string }).messageId;
    const receipts = new MessageReceipts(join(first.paseoHome, "agent-requests"));
    const statePath = join(first.paseoHome, "agents", "peer-workspace-state.json");
    const readReservation = async () => {
      const { messages } = JSON.parse(await readFile(statePath, "utf8")) as {
        messages: Array<
          [string, { recipientAgentId: string; activeAttemptId?: string; lastAttemptId?: string }]
        >;
      };
      return messages.find(([, entry]) => entry.recipientAgentId === recipient.id);
    };
    await first.close();
    resetInMemoryPeerDispatchStateForTest();
    const queued = await receipts.queuedMessages();
    expect(queued.map((entry) => entry.queued.message.messageId)).toEqual([messageId]);
    const beforeRestart = await readReservation();
    expect(beforeRestart).toBeDefined();

    const resume = vi.fn(async () => {});
    const handoff = vi.fn();
    const nativeTurns = vi.fn();
    const agentClients = createTestAgentClients({
      beforeResumeSession: resume,
      onStartTurn: nativeTurns,
    });
    const codex = agentClients.codex!;
    const resumeSession = codex.resumeSession.bind(codex);
    codex.resumeSession = async (...args) => {
      const session = await resumeSession(...args);
      if (scenario === "unsupported provider") return session;
      const start = session.startTurn.bind(session);
      return Object.assign(session, {
        capabilities: {
          ...session.capabilities,
          supportsPeerReadOnlyTurn: true as const,
          defersPromptHandoff: true,
        },
        async startTurn(...[prompt, options]: Parameters<typeof session.startTurn>) {
          await options?.beforeProviderDispatch?.();
          options?.assertProviderDispatchAllowed?.();
          handoff(options?.clientMessageId, options?.turnAuthorization);
          options?.onPeerPromptSubmitting?.();
          const run = await start(prompt, options);
          await options?.onPeerPromptAccepted?.();
          return run;
        },
      });
    };
    const restarted = await startDaemon(context, {
      mcpEnabled: true,
      paseoHomeRoot: dirname(first.paseoHome),
      staticDir: first.staticDir,
      resumeOnStartup: false,
      agentClients,
    });
    await vi.waitFor(
      async () => {
        const current = await readReservation();
        expect(current?.[0]).toBe(beforeRestart?.[0]);
        expect(current?.[1].lastAttemptId).toEqual(expect.any(String));
        expect(current?.[1].lastAttemptId).not.toBe(beforeRestart?.[1].lastAttemptId);
        expect(current?.[1].activeAttemptId).toBeUndefined();
      },
      { timeout: 6_000 },
    );
    expect(restarted.daemon.agentManager.getAgent(recipient.id)).toBeNull();
    expect(resume).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
    expect(nativeTurns).not.toHaveBeenCalled();
    expect(await receipts.queuedMessages()).toEqual(queued);

    if (scenario === "sender archived") {
      await restarted.daemon.agentManager.archiveSnapshot(sender.id, new Date().toISOString());
    }
    if (scenario === "recipient archived") {
      await restarted.daemon.agentManager.archiveSnapshot(recipient.id, new Date().toISOString());
      expect(resume).not.toHaveBeenCalled();
    } else {
      const { socket: client } = await restarted.connect(CURRENT_CLIENT, CURRENT_APP_VERSION);
      await openInteractiveAgent(client, recipient.id);
      expect(resume).toHaveBeenCalledOnce();
    }
    if (scenario === "deliver") {
      await vi.waitFor(async () => {
        expect(await receipts.outcome(recipient.id, messageId)).toBe("accepted");
      });
      expect(handoff.mock.calls).toEqual([[messageId, "peer-read-only"]]);
      expect(nativeTurns).toHaveBeenCalledOnce();
    } else {
      await vi.waitFor(async () => {
        expect(await receipts.queuedMessages()).toEqual([]);
        expect(await readReservation()).toBeUndefined();
      });
      expect(handoff).not.toHaveBeenCalled();
      expect(nativeTurns).not.toHaveBeenCalled();
    }
    expect(await receipts.queuedMessages()).toEqual([]);
  },
  TEST_TIMEOUT,
);

test(
  "legacy and current sockets see the directory while legacy closes respect topic protection",
  async (context) => {
    const daemon = await startDaemon(context);
    const { socket: current } = await daemon.connect(CURRENT_CLIENT, CURRENT_APP_VERSION);
    const { socket: legacy } = await daemon.connect(LEGACY_CLIENT);
    const mainAgent = { config: { provider: "codex", cwd: daemon.staticDir } };
    const topic = await createWorkspace(
      current,
      directoryWorkspace(daemon, {
        title: "Startup topic",
        topic: { summary: "Check the startup trace" },
        mainAgent,
      }),
    );
    const ordinary = await createWorkspace(
      legacy,
      directoryWorkspace(daemon, {
        title: "Traditional workspace",
        mainAgent,
      }),
    );
    const topicMain = topic.mainAgent?.id;
    const ordinaryMain = ordinary.mainAgent?.id;
    if (!topicMain || !ordinaryMain) throw new Error("The test needs both silent main agents");

    for (const socket of [legacy, current]) {
      const workspaces = await fetchDirectory(socket);
      expect(workspaces.find(({ id }) => id === ordinary.workspace.id)?.topic).toBeUndefined();
      expect(workspaces.find(({ id }) => id === topic.workspace.id)).toMatchObject({
        title: "Startup topic",
        hasActiveMainAgent: true,
        topic: { mainAgentId: topicMain, revision: 1 },
      });
    }

    const rejected = await request(
      legacy,
      { type: "archive_agent_request", agentId: topicMain },
      "rpc_error",
    );
    expect(rejected.payload).toMatchObject({
      requestType: "archive_agent_request",
      code: "TOPIC_MAIN_ARCHIVE_PROTECTED",
    });
    const storage = daemon.daemon.agentStorage;
    const stored = await storage.get(topicMain);
    if (!stored) throw new Error("The topic main was not saved");
    const oldTab = getOpenAgentTabLabel(LEGACY_CLIENT);
    const newTab = getOpenAgentTabLabel(CURRENT_CLIENT);
    await storage.upsert({
      ...stored,
      labels: { ...stored.labels, [oldTab]: "true", [newTab]: "true" },
    });
    const closed = await request(
      legacy,
      {
        type: "close_items_request",
        agentIds: [topicMain, ordinaryMain],
        terminalIds: [],
      },
      "close_items_response",
    );
    expect(closed.payload.agents).toEqual([
      { agentId: ordinaryMain, archivedAt: expect.any(String) },
    ]);
    const protectedMain = await storage.get(topicMain);
    expect(protectedMain).toMatchObject({ lastStatus: "closed", labels: { [newTab]: "true" } });
    expect(protectedMain?.labels).not.toHaveProperty([oldTab]);
    expect(protectedMain?.archivedAt ?? null).toBeNull();
    expect((await storage.get(ordinaryMain))?.archivedAt).toBe(
      closed.payload.agents[0]?.archivedAt,
    );
  },
  TEST_TIMEOUT,
);

test(
  "creating and reading quiet topics with and without a preset makes zero model calls",
  async (context) => {
    const createSession = vi.fn(async () => {});
    const resumeSession = vi.fn(async () => {});
    const startTurn = vi.fn();
    const autoName = vi.spyOn(WorkspaceAutoName.prototype, "scheduleForDirectory");
    context.onTestFinished(() => {
      autoName.mockRestore();
    });
    const daemon = await startDaemon(context, {
      agentClients: createTestAgentClients({
        beforeCreateSession: createSession,
        beforeResumeSession: resumeSession,
        onStartTurn: startTurn,
      }),
    });
    const { socket } = await daemon.connect(CURRENT_CLIENT, CURRENT_APP_VERSION);
    const quiet = await createWorkspace(
      socket,
      directoryWorkspace(daemon, {
        title: "Quiet topic with preset",
        topic: { summary: "Check plans", hideFromModel: true },
        mainAgent: { config: { provider: "codex", cwd: daemon.staticDir } },
      }),
    );
    const unbound = await createWorkspace(
      socket,
      directoryWorkspace(daemon, {
        title: "Quiet topic without preset",
        topic: {},
      }),
    );
    const agentId = quiet.mainAgent?.id;
    if (!agentId) throw new Error("The preset did not register a main agent");
    expect(quiet.mainAgent).toMatchObject({ status: "closed" });
    expect(unbound.mainAgent ?? null).toBeNull();
    expect(quiet.workspace.id).not.toBe(unbound.workspace.id);
    expect(unbound.workspace.topic?.mainAgentId).toBeNull();
    const { payload: updated } = await request(
      socket,
      {
        type: "workspace.topic.update.request",
        workspaceId: quiet.workspace.id,
        summary: "Updated direction",
        hideFromModel: true,
      },
      "workspace.topic.update.response",
    );
    expect(updated).toMatchObject({
      error: null,
      topic: {
        summary: "Updated direction",
        revision: 2,
        hideFromModel: true,
        mainAgentId: agentId,
      },
    });
    const listed = await fetchDirectory(socket);
    expect(listed.find(({ id }) => id === quiet.workspace.id)?.topic).toEqual(updated.topic);
    const { payload: timeline } = await request(
      socket,
      {
        type: "fetch_agent_timeline_request",
        agentId,
        direction: "tail",
      },
      "fetch_agent_timeline_response",
    );
    expect(timeline).toMatchObject({ error: null, entries: [], agent: { status: "closed" } });
    expect(createSession).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
    expect(autoName).not.toHaveBeenCalled();
  },
  TEST_TIMEOUT,
);

test.for(["workspace", "agent"] as const)(
  "a new WebSocket reconciles an interrupted topic first question (%s creation)",
  async (kind, context) => {
    const release = Promise.withResolvers<void>();
    let providerOpening = false;
    const prompts: AgentPromptInput[] = [];
    const daemon = await startDaemon(context, {
      agentClients: createTestAgentClients({
        async beforeCreateSession() {
          providerOpening = true;
          await release.promise;
        },
        onStartTurn(prompt) {
          prompts.push(prompt);
        },
      }),
    });
    const idempotencyKey = randomUUID();
    const clientMessageId = randomUUID();
    const question = "Where should we start?";
    const image = {
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    };
    const title = "Private startup topic";
    const summary = "Review the private notes";
    const agent = {
      config: { provider: "codex" as const, cwd: daemon.staticDir },
      workspaceRole: "main" as const,
      initialPrompt: question,
      images: [image],
      clientMessageId,
    };
    const topic = { summary, hideFromModel: true };
    let delayedWorkspaceId: string | undefined;
    try {
      const { socket: original } = await daemon.connect(CURRENT_CLIENT, CURRENT_APP_VERSION);
      if (kind === "workspace") {
        send(original, directoryWorkspace(daemon, { idempotencyKey, title, topic, agent }));
      } else {
        const unbound = await createWorkspace(
          original,
          directoryWorkspace(daemon, { title, topic }),
        );
        delayedWorkspaceId = unbound.workspace.id;
        send(original, {
          type: "agent.create.request",
          requestId: randomUUID(),
          idempotencyKey,
          workspaceId: unbound.workspace.id,
          ...agent,
        });
      }
      await expect.poll(() => providerOpening, { timeout: 5500 }).toBe(true);
      const disconnected = once(original, "close");
      original.terminate();
      await disconnected;

      const { socket } = await daemon.connect(CURRENT_CLIENT, CURRENT_APP_VERSION);
      const snapshot = async () =>
        (
          await request(
            socket,
            {
              type: "creation.subscribe.request",
              kind,
              idempotencyKey,
              subscribe: false,
            },
            "creation.subscribe.response",
          )
        ).payload.snapshot;
      const pending = await snapshot();
      expect(pending).toMatchObject({
        kind,
        idempotencyKey,
        error: null,
        workspaceId: expect.any(String),
      });
      expect(pending?.phase).not.toBe("completed");
      expect(prompts).toEqual([]);
      if (delayedWorkspaceId) {
        const { payload: competing } = await request(
          socket,
          {
            ...agent,
            type: "agent.create.request",
            workspaceId: delayedWorkspaceId,
            idempotencyKey: randomUUID(),
            clientMessageId: randomUUID(),
            initialPrompt: "A second question from another client",
          },
          "agent.create.response",
        );
        expect(competing).toMatchObject({
          errorCode: "workspace_main_exists",
          agent: null,
          creation: { phase: "failed", failedStage: "agent", outcomeUnknown: false },
        });
      }
      release.resolve();
      await expect.poll(snapshot, { timeout: 6500 }).toMatchObject({
        phase: "completed",
        initialPromptStarted: true,
        error: null,
        workspaceId: pending?.workspaceId,
      });
      const settled = await snapshot();
      const agentId = settled?.agentId;
      if (!settled?.workspaceId || !agentId)
        throw new Error("Creation did not retain its workspace and agent IDs");
      expect(
        (await fetchDirectory(socket)).find(({ id }) => id === settled.workspaceId)?.topic,
      ).toEqual({
        summary,
        hideFromModel: true,
        mainAgentId: agentId,
        revision: 1,
      });
      const { payload: timeline } = await request(
        socket,
        {
          type: "fetch_agent_timeline_request",
          agentId,
          direction: "tail",
        },
        "fetch_agent_timeline_response",
      );
      expect(timeline.error).toBeNull();
      expect(
        timeline.entries.flatMap(({ item }) => (item.type === "user_message" ? [item] : [])),
      ).toEqual([
        expect.objectContaining({
          text: question,
          clientMessageId,
          imageAttachments: [
            {
              id: expect.stringMatching(/^upload_/),
              fileName: "image.png",
              mimeType: image.mimeType,
              size: Buffer.from(image.data, "base64").byteLength,
            },
          ],
        }),
      ]);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContainEqual({ type: "image", ...image });
      const providerPrompt = JSON.stringify(prompts[0]);
      expect(providerPrompt).toContain(question);
      expect(providerPrompt).not.toContain(title);
      expect(providerPrompt).not.toContain(summary);
    } finally {
      release.resolve();
    }
  },
  TEST_TIMEOUT,
);

test(
  "advertises the topic workbench capability in the real WebSocket handshake",
  async (context) => {
    const daemon = await startDaemon(context);
    const { info } = await daemon.connect(CURRENT_CLIENT, CURRENT_APP_VERSION);
    expect(info.features?.topicWorkbenchV1).toBe(true);
    expect(info.features?.workspaceButlerV1).toBe(true);
  },
  TEST_TIMEOUT,
);

test(
  "persists the first question and only pushes its anchor to capable connections",
  async (context) => {
    const daemon = await startDaemon(context);
    const { socket } = await daemon.connect(CURRENT_CLIENT, CURRENT_APP_VERSION, {
      [CLIENT_CAPS.workspaceButlerV1]: true,
    });
    const { socket: legacy } = await daemon.connect(LEGACY_CLIENT);
    const topic = await createWorkspace(
      socket,
      directoryWorkspace(daemon, {
        title: "Self-contained question",
        topic: { summary: "Self-contained question" },
        mainAgent: { config: { provider: "codex", cwd: daemon.staticDir } },
      }),
    );
    const mainAgentId = topic.mainAgent?.id;
    if (!mainAgentId) throw new Error("Expected a Main Control agent");
    const workspaceId = topic.workspace.id;
    const messageId = randomUUID();
    const rootPromptText = "What can we finish this week?";
    const onLegacyMessage = vi.fn((data: RawData, isBinary: boolean) => {
      if (isBinary) return undefined;
      const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
      return parsed.success && parsed.data.type === "session"
        ? parsed.data.message.type
        : undefined;
    });
    legacy.on("message", onLegacyMessage);
    const anchorUpdate = waitForSession(socket, "workspace.topic.anchor.updated", (message) =>
      message.type === "workspace.topic.anchor.updated" &&
      message.payload.anchor.rootMessageId === messageId
        ? message.payload.anchor
        : undefined,
    );
    const sent = await request(
      socket,
      { type: "send_agent_message_request", agentId: mainAgentId, messageId, text: rootPromptText },
      "send_agent_message_response",
    );
    expect(sent.payload.accepted).toBe(true);
    const anchor = await anchorUpdate;
    expect(anchor).toMatchObject({
      workspaceId,
      mainAgentId,
      rootPromptText,
      topicKey: `msg:${messageId}`,
    });
    const list = await request(
      legacy,
      { type: "workspace.topic.list_entries.request", workspaceId, mainAgentId },
      "workspace.topic.list_entries.response",
    );
    expect(list.payload.anchors).toContainEqual(anchor);
    expect(onLegacyMessage.mock.results.map((result) => result.value)).not.toContain(
      "workspace.topic.anchor.updated",
    );

    const taskId = "direct-topic-decision";
    const ledger = new WorkspaceTaskLedgerStore(daemon.paseoHome);
    const observedTask = await ledger.upsert(workspaceId, {
      taskId,
      title: "Choose a deadline",
      status: "awaiting_decision",
      blockingQuestion: "Which day?",
      rootMessageId: messageId,
    });
    const decision = {
      type: "workspace.topic.decide.request",
      workspaceId,
      mainAgentId,
      topicKey: `task:${taskId}`,
      taskId,
      rootMessageId: messageId,
      clientMessageId: randomUUID(),
      resolutionKind: "task_blocking_question",
      note: "Friday",
      expectedBlockingQuestionGeneration: observedTask.blockingQuestionGeneration,
      dispatchFollowup: false,
    };
    const denied = await request(legacy, decision, "workspace.topic.decide.response");
    expect(denied.payload).toMatchObject({
      accepted: false,
      error: expect.stringContaining("unavailable on this connection"),
    });
    const result = await request(socket, decision, "workspace.topic.decide.response");
    expect(result.payload).toMatchObject({
      accepted: true,
      error: null,
      routedTo: "none",
      task: { taskId, status: "in_progress" },
      entry: { origin: "decision_reply", text: "Friday" },
    });
    expect(result.payload.task?.blockingQuestion).toBeUndefined();
    expect(onLegacyMessage.mock.results.map((item) => item.value)).not.toContain(
      "workspace.tasks.updated",
    );
  },
  TEST_TIMEOUT,
);

test(
  "keeps Main Control attention until both topic cards have been read over WebSocket",
  async (context) => {
    const daemon = await startDaemon(context);
    const { socket } = await daemon.connect(CURRENT_CLIENT, CURRENT_APP_VERSION);
    const topic = await createWorkspace(
      socket,
      directoryWorkspace(daemon, {
        title: "Read both conclusions",
        topic: { summary: "Read both conclusions" },
        mainAgent: { config: { provider: "codex", cwd: daemon.staticDir } },
      }),
    );
    const mainAgentId = topic.mainAgent?.id;
    if (!mainAgentId) throw new Error("Expected a Main Control agent");
    await openInteractiveAgent(socket, mainAgentId);
    const manager = daemon.daemon.agentManager;
    const mark = async (messageId: string, turnId: string, reportCallId?: string) => {
      const { rows, epoch } = manager.fetchTimeline(mainAgentId, { limit: 0 });
      const reply = rows.findLast((row) =>
        reportCallId
          ? row.item.type === "tool_call" && row.item.callId === reportCallId
          : row.turnId === turnId && row.item.type === "assistant_message",
      );
      if (!reply) throw new Error(`No assistant reply for ${messageId}`);
      const { payload } = await request(
        socket,
        {
          type: "workspace.topic_read.mark.request",
          workspaceId: topic.workspace.id,
          mainAgentId,
          topicKey: `msg:${messageId}`,
          mode: "read",
          epoch,
          seq: reply.seqEnd,
          timestampMs: Date.parse(reply.timestamp),
        },
        "workspace.topic_read.mark.response",
      );
      expect(payload.error).toBeNull();
    };
    const run = async (clientMessageId: string, reportFor?: string) => {
      for await (const event of manager.streamAgent(mainAgentId, clientMessageId, {
        clientMessageId,
      })) {
        if (reportFor && event.type === "turn_started") {
          await manager.appendTimelineItem(mainAgentId, {
            type: "tool_call",
            callId: "cross-turn-report-a",
            name: "agent_message",
            status: "completed",
            error: null,
            detail: { type: "plain_text", text: "A's specialist report" },
            agentMessage: {
              event: "message",
              sender: { id: "specialist-a" },
              rootMessageId: reportFor,
              text: "A's specialist report",
            },
          });
        }
      }
      const user = manager
        .fetchTimeline(mainAgentId, { limit: 0 })
        .rows.find(
          ({ item }) => item.type === "user_message" && item.clientMessageId === clientMessageId,
        );
      if (!user?.turnId || user.item.type !== "user_message") throw new Error("Missing turn ID");
      return { root: user.item.messageId ?? clientMessageId, turnId: user.turnId };
    };
    const a = await run("read-a");
    const b = await run("read-b", a.root);
    expect(manager.getAgent(mainAgentId)?.attention).toMatchObject({
      requiresAttention: true,
      attentionReason: "finished",
    });
    await mark(b.root, b.turnId);
    expect(manager.getAgent(mainAgentId)?.attention.requiresAttention).toBe(true);
    await mark(a.root, a.turnId);
    expect(manager.getAgent(mainAgentId)?.attention.requiresAttention).toBe(true);
    await mark(a.root, a.turnId, "cross-turn-report-a");
    expect(manager.getAgent(mainAgentId)?.attention).toEqual({ requiresAttention: false });
  },
  TEST_TIMEOUT,
);

const completedReportCases = [
  "sole lead",
  "multiple tracks",
  "new blocker",
  "existing blocker",
  "pending acceptance",
  "unbound follow-up",
  "bound recovery",
  "interrupted card write",
  "terminal retention during interrupted card write",
  "interruption after the report receipt commits",
] as const;
const wakeupCases = new Set<string>([
  "multiple tracks",
  "new blocker",
  "existing blocker",
  "pending acceptance",
  "unbound follow-up",
]);

async function prepareCompletedReport(
  scenario: (typeof completedReportCases)[number],
  context: TestContext,
) {
  const multiTrack = scenario === "multiple tracks";
  const newBlocker = scenario === "new blocker";
  const existingBlocker = scenario === "existing blocker";
  const pendingAcceptance = scenario === "pending acceptance";
  const unbound = scenario === "unbound follow-up";
  const boundRecovery = scenario === "bound recovery";
  const needsWakeup = wakeupCases.has(scenario);
  const childTurnEnd = Promise.withResolvers<void>();
  context.onTestFinished(() => childTurnEnd.resolve());
  const push = vi.fn(async () => {});
  const daemon = await startDaemon(context, {
    mcpEnabled: true,
    pushNotificationSender: { send: push },
    ...(unbound || boundRecovery
      ? {
          agentClients: createTestAgentClients({
            beforeTurnComplete: async (prompt) => {
              if (typeof prompt === "string" && prompt.includes("Continue the selected work"))
                await childTurnEnd.promise;
            },
          }),
        }
      : {}),
  });
  const { socket } = await daemon.connect(CURRENT_CLIENT, CURRENT_APP_VERSION, {
    [CLIENT_CAPS.workspaceButlerV1]: true,
    [CLIENT_CAPS.workspaceTopicThreads]: true,
  });
  const config = { provider: "codex" as const, cwd: daemon.staticDir };
  const topic = await createWorkspace(
    socket,
    directoryWorkspace(daemon, {
      title: "Report progress",
      topic: { summary: "Report progress" },
      mainAgent: { config },
    }),
  );
  const mainAgentId = topic.mainAgent?.id;
  if (!mainAgentId) throw new Error("Expected a Main Control agent");
  const workspaceId = topic.workspace.id;
  const taskId = "sole-lead-report";
  if (needsWakeup) {
    await openInteractiveAgent(socket, mainAgentId);
    const started = await request(
      socket,
      {
        type: "send_agent_message_request",
        agentId: mainAgentId,
        text: "Coordinate both tracks.",
        messageId: randomUUID(),
      },
      "send_agent_message_response",
    );
    expect(started.payload.accepted).toBe(true);
    await vi.waitFor(() =>
      expect(daemon.daemon.agentManager.getAgent(mainAgentId)?.lifecycle).toBe("idle"),
    );
  }
  const ledger = new WorkspaceTaskLedgerStore(daemon.paseoHome);
  const child = await daemon.daemon.agentManager.createAgent(config, undefined, {
    workspaceId,
    labels: {
      [PARENT_AGENT_ID_LABEL]: mainAgentId,
      [PARENT_REPORTING_LABEL]: "explicit",
      [TASK_ID_LABEL]: taskId,
    },
  });
  const sibling = multiTrack
    ? await daemon.daemon.agentManager.createAgent(config, undefined, {
        workspaceId,
        labels: { [PARENT_AGENT_ID_LABEL]: mainAgentId, [TASK_ID_LABEL]: taskId },
      })
    : null;
  await ledger.upsert(workspaceId, {
    taskId,
    title: "Publish the sole lead's report",
    status: existingBlocker ? "awaiting_decision" : "in_progress",
    blockingQuestion: existingBlocker ? "Review the existing risk?" : undefined,
    leadAgentId: child.id,
    participants: [
      { agentId: child.id, boundBy: mainAgentId },
      ...(sibling ? [{ agentId: sibling.id, boundBy: mainAgentId }] : []),
    ],
  });
  if (pendingAcceptance) {
    const serverId = daemon.daemon.getServerId();
    const items = openDurableItemStore({
      paseoHome: daemon.paseoHome,
      serverId,
      workspaceRegistry: new FileBackedWorkspaceRegistry(
        join(daemon.paseoHome, "projects", "workspaces.json"),
        createTestLogger(),
      ),
      agentStorage: daemon.daemon.agentStorage,
    });
    await items.create({
      serverId,
      workspaceId,
      requestId: "awaiting-acceptance",
      sourceAgentId: child.id,
      sourceTurnId: "acceptance-source",
      kind: "acceptance",
      title: "Review output",
      taskId,
      topicKey: `task:${taskId}`,
      evidence: [],
    });
  }
  async function startChildTurn() {
    const stream = daemon.daemon.agentManager.streamAgent(
      child.id,
      "Continue the selected work",
      boundRecovery ? { recoveryIntent: "automatic" } : undefined,
    );
    const completed = (async () => {
      for await (const event of stream) {
        if (event.type === "turn_failed") throw new Error("Expected a child turn");
      }
    })();
    context.onTestFinished(async () => {
      childTurnEnd.resolve();
      await completed;
    });
    await vi.waitFor(() =>
      expect(daemon.daemon.agentManager.getAgent(child.id)?.activeForegroundTurnId).toBeTruthy(),
    );
    expect(daemon.daemon.agentManager.captureTaskReport(child.id)?.explicitlyUnbound === true).toBe(
      unbound,
    );
  }
  if (unbound || boundRecovery) await startChildTurn();
  const tools = new Client({ name: "lead", version: "1" });
  context.onTestFinished(() => tools.close());
  await tools.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${daemon.port}/mcp/agents?callerAgentId=${child.id}`),
    ),
  );
  const summary = "Sole lead finished the requested work.";
  const report = (status: "completed" | "blocked" = "completed", text = summary) =>
    tools.callTool({ name: "report_to_parent", arguments: { status, summary: text } });
  const manager = daemon.daemon.agentManager;
  return {
    daemon,
    socket,
    push,
    mainAgentId,
    workspaceId,
    taskId,
    ledger,
    sibling,
    manager,
    report,
    summary,
    needsWakeup,
    newBlocker,
    existingBlocker,
  };
}

async function expectCompletedReportWakeup(
  setup: Awaited<ReturnType<typeof prepareCompletedReport>>,
  context: TestContext,
) {
  const {
    daemon,
    mainAgentId,
    workspaceId,
    taskId,
    ledger,
    sibling,
    manager,
    report,
    newBlocker,
    existingBlocker,
  } = setup;
  if (sibling) expect(manager.hasInFlightRun(sibling.id)).toBe(false);
  if (newBlocker) {
    const original = WorkspaceTaskLedgerStore.prototype.syncFromTurnOutcome;
    const beforeCommit = vi.spyOn(WorkspaceTaskLedgerStore.prototype, "syncFromTurnOutcome");
    context.onTestFinished(() => beforeCommit.mockRestore());
    beforeCommit.mockImplementationOnce(
      async function (this: WorkspaceTaskLedgerStore, id, task, patch, coordination) {
        expect({ id, task }).toEqual({ id: workspaceId, task: taskId });
        await original.call(this, id, task, {
          status: "awaiting_decision",
          blockingQuestion: "Who should review the newly discovered risk?",
        });
        return original.call(this, id, task, patch, coordination);
      },
    );
  }
  expect((await report()).isError).not.toBe(true);
  await vi.waitFor(
    async () => {
      const stored = await daemon.daemon.agentStorage.get(mainAgentId);
      const timeline = manager.getAgent(mainAgentId)
        ? manager.getTimeline(mainAgentId)
        : stored &&
          (await manager.readStoredTimeline(stored, { limit: 0 })).rows.map(({ item }) => item);
      expect(timeline).toContainEqual(
        expect.objectContaining({
          type: "tool_call",
          agentMessage: expect.objectContaining({ reportStatus: "completed" }),
        }),
      );
    },
    { timeout: 8_000 },
  );
  let question: string | undefined;
  if (newBlocker) question = "Who should review the newly discovered risk?";
  if (existingBlocker) question = "Review the existing risk?";
  const expected = question
    ? { taskId, status: "awaiting_decision", blockingQuestion: question }
    : { taskId, status: "in_progress" };
  expect(await ledger.list(workspaceId)).toContainEqual(expect.objectContaining(expected));
}

test.for(completedReportCases)(
  "routes a completed topic report with %s",
  async (scenario, context) => {
    const setup = await prepareCompletedReport(scenario, context);
    if (setup.needsWakeup) return expectCompletedReportWakeup(setup, context);
    const {
      daemon,
      socket,
      push,
      mainAgentId,
      workspaceId,
      taskId,
      ledger,
      manager,
      report,
      summary,
    } = setup;
    const terminalChurn = scenario === "terminal retention during interrupted card write";
    const newBlockerAfterCompletion = scenario === "interrupted card write";
    const interruptedCardWrite = terminalChurn || newBlockerAfterCompletion;
    const interruptedAfterReceipt = scenario === "interruption after the report receipt commits";
    if (terminalChurn) {
      const acknowledge = vi.spyOn(WorkspaceTaskLedgerStore.prototype, "acknowledgeSilentReport");
      context.onTestFinished(() => acknowledge.mockRestore());
      acknowledge.mockRejectedValueOnce(new Error("The first marker cleanup did not reach disk."));
    }
    if (interruptedAfterReceipt) {
      const sendReceipt = MessageReceipts.prototype.send;
      const sendSpy = vi.spyOn(MessageReceipts.prototype, "send");
      context.onTestFinished(() => sendSpy.mockRestore());
      let interrupted = false;
      sendSpy.mockImplementation(async function (this: MessageReceipts, input) {
        await sendReceipt.call(this, input);
        if (interrupted || input.agentId !== mainAgentId || !input.confirmPendingSilentDelivery)
          return;
        interrupted = true;
        expect(push).not.toHaveBeenCalled();
        expect(await this.outcome(input.agentId, input.messageId)).toBe("accepted");
        throw new Error("Interrupted after committing the report receipt.");
      });
    }
    if (interruptedCardWrite) {
      const append = vi.spyOn(TopicThreadStore.prototype, "appendReportEntry");
      context.onTestFinished(() => append.mockRestore());
      append.mockImplementationOnce(async () => {
        expect(await ledger.list(workspaceId)).toContainEqual(
          expect.objectContaining({ taskId, status: "completed" }),
        );
        if (terminalChurn) {
          for (let index = 0; index < 50; index++) {
            await ledger.upsert(workspaceId, {
              taskId: `completed-${index}`,
              title: `Completed ${index}`,
              status: "completed",
            });
          }
          expect(await ledger.list(workspaceId)).toContainEqual(
            expect.objectContaining({
              taskId,
              silentReportIds: expect.arrayContaining([expect.any(String)]),
            }),
          );
        } else {
          await ledger.syncFromTurnOutcome(workspaceId, taskId, {
            status: "awaiting_decision",
            blockingQuestion: "Is the follow-up required?",
          });
        }
        throw new Error("The first card write did not reach disk.");
      });
    }
    const thread = waitForSession(
      socket,
      "silent report",
      (message) =>
        message.type === "workspace.topic.thread.updated" && message.payload.entry.taskId === taskId
          ? message.payload.entry
          : undefined,
      // The report handler backs off for five seconds after an interrupted write.
      interruptedCardWrite ? 12_000 : undefined,
    );
    const taskUpdate = waitForSession(socket, "completed task", (message) =>
      message.type === "workspace.tasks.updated" && message.payload.workspaceId === workspaceId
        ? message.payload.tasks.find(
            (task) =>
              task.taskId === taskId &&
              task.status === (newBlockerAfterCompletion ? "awaiting_decision" : "completed"),
          )
        : undefined,
    );
    const result = await report();
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const [entry, task] = await Promise.all([thread, taskUpdate]);
    expect(entry).toMatchObject({
      role: "agent_reply",
      origin: "subagent_report",
      reportStatus: "completed",
      text: summary,
    });
    expect(task).toMatchObject(
      newBlockerAfterCompletion
        ? { status: "awaiting_decision", blockingQuestion: "Is the follow-up required?" }
        : { status: "completed", handoffSummary: summary },
    );
    expect(manager.hasInFlightRun(mainAgentId)).toBe(false);
    await vi.waitFor(
      () =>
        expect(push).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            body: summary,
            data: expect.objectContaining({
              agentId: mainAgentId,
              workspaceId,
              reason: "finished",
              topicKey: `task:${taskId}`,
            }),
          }),
        ),
      { timeout: 8_000 },
    );
    const stored = await daemon.daemon.agentStorage.get(mainAgentId);
    expect(stored).toMatchObject({ requiresAttention: true, attentionReason: "finished" });
    expect(stored && (await manager.readStoredTimeline(stored, { limit: 0 })).rows).toEqual([]);
    const { sourceMessageId } = entry;
    if (!sourceMessageId) throw new Error("Missing report message ID");
    const receipts = new MessageReceipts(join(daemon.paseoHome, "parent-report-receipts"));
    await expect(receipts.outcome(mainAgentId, sourceMessageId)).resolves.toBe("accepted");
    const savedEntries = await new TopicThreadStore(daemon.paseoHome).list(
      { workspaceId, mainAgentId },
      `task:${taskId}`,
    );
    expect(
      savedEntries.filter((candidate) => candidate.sourceMessageId === sourceMessageId),
    ).toHaveLength(1);
    await vi.waitFor(
      async () => {
        const savedTask = (await ledger.list(workspaceId)).find(
          (candidate) => candidate.taskId === taskId,
        );
        if (terminalChurn) expect(savedTask).toBeUndefined();
        else expect(savedTask?.silentReportIds).toBeUndefined();
        if (newBlockerAfterCompletion) {
          expect(savedTask).toMatchObject({
            status: "awaiting_decision",
            blockingQuestion: "Is the follow-up required?",
          });
        }
      },
      { timeout: 8_000 },
    );
    expect(push).toHaveBeenCalledTimes(1);
  },
  TEST_TIMEOUT,
);

test(
  "retries delivery of a blocked report without reapplying an answered question",
  async (context) => {
    const { ledger, manager, mainAgentId, workspaceId, taskId, report } =
      await prepareCompletedReport("existing blocker", context);
    const applied = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    const original = WorkspaceTaskLedgerStore.prototype.syncFromTurnOutcome;
    const sync = vi.spyOn(WorkspaceTaskLedgerStore.prototype, "syncFromTurnOutcome");
    context.onTestFinished(() => {
      release.resolve();
      sync.mockRestore();
    });
    let failed = false;
    sync.mockImplementation(
      async function (this: WorkspaceTaskLedgerStore, id, task, patch, coordination) {
        const updated = await original.call(this, id, task, patch, coordination);
        if (!failed && coordination?.reportId && updated?.blockingQuestionGeneration) {
          failed = true;
          applied.resolve(updated.blockingQuestionGeneration);
          await release.promise;
          throw new QueuedPromptLoadError("Main Control could not open before handoff");
        }
        return updated;
      },
    );
    const question = "Which rollout should we use?";
    expect((await report("blocked", question)).isError).not.toBe(true);
    const generation = await applied.promise;
    const cleared = await ledger.syncFromTurnOutcome(workspaceId, taskId, {
      status: "in_progress",
      blockingQuestion: null,
    });
    release.resolve();
    await vi.waitFor(
      () =>
        expect(manager.getTimeline(mainAgentId)).toContainEqual(
          expect.objectContaining({
            type: "tool_call",
            agentMessage: expect.objectContaining({
              reportStatus: "blocked",
              text: expect.stringContaining(question),
            }),
          }),
        ),
      { timeout: 12_000 },
    );
    const [saved] = await ledger.list(workspaceId);
    expect(saved.status).toBe("in_progress");
    expect(saved.blockingQuestion).toBeUndefined();
    expect(saved.blockingQuestionGeneration).toBe(cleared?.blockingQuestionGeneration);
    expect(saved.blockingQuestionGeneration).not.toBe(generation);
  },
  TEST_TIMEOUT,
);

test.for(["card", "butler"] as const)(
  "publishes pending and accepted durable items only to compatible connections via %s",
  async (channel, context) => {
    const humanPrompt = "Please approve the verified result.";
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const daemon = await startDaemon(context, {
      mcpEnabled: channel === "butler",
      agentClients: createTestAgentClients({
        async beforeTurnComplete(prompt) {
          if (
            typeof prompt === "string"
              ? prompt.includes(humanPrompt)
              : JSON.stringify(prompt).includes(humanPrompt)
          ) {
            started.resolve();
            await finish.promise;
          }
        },
      }),
    });
    const { socket } = await daemon.connect(CURRENT_CLIENT, CURRENT_APP_VERSION, {
      [CLIENT_CAPS.workspaceButlerV1]: true,
    });
    const { socket: legacy } = await daemon.connect(LEGACY_CLIENT);
    const topic = await createWorkspace(
      socket,
      directoryWorkspace(daemon, {
        title: "Acceptance",
        topic: { summary: "Acceptance" },
        mainAgent: { config: { provider: "codex", cwd: daemon.staticDir } },
      }),
    );
    const mainAgentId = topic.mainAgent?.id;
    if (!mainAgentId) throw new Error("Expected a Main Control agent");
    const workspaceId = topic.workspace.id;
    const taskId = "workspace-acceptance";
    const topicKey = `task:${taskId}`;
    await new WorkspaceTaskLedgerStore(daemon.paseoHome).upsert(workspaceId, {
      taskId,
      title: "Accept the result",
      status: "verifying",
    });
    const serverId = daemon.daemon.getServerId();
    const store = openDurableItemStore({
      paseoHome: daemon.paseoHome,
      serverId,
      workspaceRegistry: new FileBackedWorkspaceRegistry(
        join(daemon.paseoHome, "projects", "workspaces.json"),
        createTestLogger(),
      ),
      agentStorage: daemon.daemon.agentStorage,
    });
    await writeFile(join(daemon.staticDir, "accepted-result.txt"), "Verified output\n");
    const legacyMessages: string[] = [];
    legacy.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
      if (parsed.success && parsed.data.type === "session")
        legacyMessages.push(parsed.data.message.type);
    });
    const pendingUpdate = waitForSession(socket, "pending durable item", (message) =>
      message.type === "workspace.durable_item.updated" &&
      message.payload.item.requestId === "workspace-acceptance-item" &&
      message.payload.item.status === "pending"
        ? message.payload.item
        : undefined,
    );
    const pending = await store.create({
      serverId,
      workspaceId,
      taskId,
      topicKey,
      requestId: "workspace-acceptance-item",
      sourceAgentId: mainAgentId,
      sourceTurnId: "acceptance-turn",
      kind: "acceptance",
      title: "Accept the result",
      evidence: [{ type: "file", path: "accepted-result.txt" }],
    });
    expect(await pendingUpdate).toEqual(pending);
    const updated = waitForSession(socket, "workspace.durable_item.updated", (message) =>
      message.type === "workspace.durable_item.updated" &&
      message.payload.item.requestId === pending.requestId &&
      message.payload.item.status === "decided"
        ? message.payload.item
        : undefined,
    );
    const decision = {
      workspaceId,
      topicKey,
      taskId,
      clientMessageId: randomUUID(),
      resolutionKind: "durable_item",
      decision: "approve",
      durableItemRequestId: pending.requestId,
      expectedRevision: pending.revision,
    };
    const manager = daemon.daemon.agentManager;
    async function decide() {
      if (channel === "card") {
        const response = await request(
          socket,
          { type: "workspace.topic.decide.request", mainAgentId, ...decision },
          "workspace.topic.decide.response",
        );
        return response.payload;
      }
      const tools = new Client({ name: "butler", version: "1" });
      try {
        const sent = await request(
          socket,
          {
            type: "send_agent_message_request",
            agentId: mainAgentId,
            messageId: randomUUID(),
            text: humanPrompt,
          },
          "send_agent_message_response",
        );
        expect(sent.payload.accepted).toBe(true);
        await started.promise;
        await tools.connect(
          new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${daemon.port}/mcp/agents?callerAgentId=${mainAgentId}`),
            {
              requestInit: {
                headers: { Authorization: `Bearer ${manager.getMcpAuthToken(mainAgentId)}` },
              },
            },
          ),
        );
        const call = () => tools.callTool({ name: "dispatch_topic_decision", arguments: decision });
        const result = await call();
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        finish.resolve();
        await vi.waitFor(() => expect(manager.hasInFlightRun(mainAgentId)).toBe(false));
        const idle = await call();
        expect(idle.isError).toBe(true);
        expect(JSON.stringify(idle)).toContain("direct human turn");
        return result.structuredContent;
      } finally {
        finish.resolve();
        await tools.close();
      }
    }
    const [payload, item] = await Promise.all([decide(), updated]);
    expect(payload).toMatchObject({
      error: null,
      routedTo: "none",
      task: { status: "completed" },
      durableItem: item,
    });
    expect(item).toMatchObject({ status: "decided", decision: "approve" });
    const list = await request(
      legacy,
      { type: "workspace.durable_item.list.request", workspaceId },
      "workspace.durable_item.list.response",
    );
    expect(list.payload.items).toContainEqual(item);
    expect(legacyMessages).not.toContain("workspace.durable_item.updated");
    await vi.waitFor(() => expect(manager.hasInFlightRun(mainAgentId)).toBe(false));
  },
  TEST_TIMEOUT,
);
