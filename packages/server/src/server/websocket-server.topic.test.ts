import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { getOpenAgentTabLabel } from "@getpaseo/protocol/agent-labels";
import {
  WSOutboundMessageSchema,
  type SessionOutboundMessage,
  type WorkspaceCreateRequest,
} from "@getpaseo/protocol/messages";
import { expect, test, vi, type TestContext } from "vitest";
import { WebSocket, type RawData } from "ws";
import type { AgentPromptInput } from "./agent/agent-sdk-types.js";
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
