import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { getOpenAgentTabLabel } from "@getpaseo/protocol/agent-labels";
import {
  WSOutboundMessageSchema,
  type SessionOutboundMessage,
  type WorkspaceCreateRequest,
} from "@getpaseo/protocol/messages";
import { expect, test, vi, type TestContext } from "vitest";
import { WebSocket, type RawData } from "ws";
import type { AgentPromptInput } from "./agent/agent-sdk-types.js";
import { AgentManager } from "./agent/agent-manager.js";
import { resetInMemoryPeerDispatchStateForTest } from "./agent/agent-messages/envelope.js";
import { MessageReceipts } from "./message-receipts/index.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";

const LEGACY_CLIENT = "topic-tests-legacy";
const CURRENT_CLIENT = "topic-tests-current";
const CURRENT_APP_VERSION = "0.18.0";
const TEST_TIMEOUT = 25_000;

type Response<T extends SessionOutboundMessage["type"]> = Extract<
  SessionOutboundMessage,
  { type: T }
>;

function send(socket: WebSocket, message: object): void {
  socket.send(JSON.stringify({ type: "session", message }));
}

function waitForSession<T>(
  socket: WebSocket,
  description: string,
  select: (message: SessionOutboundMessage) => T | undefined,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${description}`));
    }, 6_000);
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
    async connect(clientId: string, appVersion?: string) {
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
    const title = "Private startup topic";
    const summary = "Review the private notes";
    const agent = {
      config: { provider: "codex" as const, cwd: daemon.staticDir },
      workspaceRole: "main" as const,
      initialPrompt: question,
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
      ).toEqual([expect.objectContaining({ text: question, clientMessageId })]);
      expect(prompts).toHaveLength(1);
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
  },
  TEST_TIMEOUT,
);
