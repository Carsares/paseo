import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import { SessionDelivery } from "./session/owned-subscriptions/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server as HTTPServer } from "http";
import type pino from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { ScheduleService } from "./schedule/service.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import type { PushNotificationSender, PushPayload } from "./push/index.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";
import type { ClaimedTodoDeadline } from "./todos/store.js";

const WORKSPACE_ID = "workspace-1";

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    readonly handlers = new Map<string, (...args: unknown[]) => void>();

    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      // no-op
    }
  }

  return { MockWebSocketServer };
});

vi.mock("ws", () => ({
  WebSocketServer: wsModuleMock.MockWebSocketServer,
}));

vi.mock("./session.js", () => ({
  Session: function Session() {
    return {};
  },
}));

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";

interface WebSocketServerInternals {
  sessions: Map<unknown, unknown>;
  handleTodoDue(trigger: ClaimedTodoDeadline): Promise<void>;
  broadcastAgentAttention(params: {
    agentId: string;
    reason: string;
    preview?: string;
    providerId?: string;
    timestamp?: string;
  }): Promise<void>;
}

function createLogger() {
  const logger = {
    child: vi.fn(() => logger),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function createWorkspaceAutoNameStub(): WorkspaceAutoName {
  return createStub<WorkspaceAutoName>({
    scheduleForWorktree: () => {},
    scheduleForDirectory: () => {},
  });
}

class RecordingPushNotificationSender implements PushNotificationSender {
  readonly sent: PushPayload[] = [];

  async send(payload: PushPayload): Promise<void> {
    this.sent.push(payload);
  }
}

function createServer(agentManagerOverrides?: Record<string, unknown>) {
  const pushNotifications = new RecordingPushNotificationSender();
  const agentManager = {
    subscribe: vi.fn(() => () => {}),
    onStop: () => () => {},
    configureRewindCheckpoints: vi.fn(),
    setAgentAttentionCallback: vi.fn(),
    getAgent: vi.fn(() => ({ workspaceId: WORKSPACE_ID, pendingPermissions: new Map() })),
    getLastAssistantMessage: vi.fn(async () => null),
    getMetricsSnapshot: vi.fn(() => ({
      total: 0,
      byLifecycle: {},
      withActiveForegroundTurn: 0,
      timelineStats: {
        totalItems: 0,
        maxItemsPerAgent: 0,
      },
    })),
    ...agentManagerOverrides,
  };
  const daemonConfigStore = {
    onApply: vi.fn(() => () => {}),
    onChange: vi.fn(() => () => {}),
  };

  const server = new VoiceAssistantWebSocketServer(
    createStub<HTTPServer>({}),
    createStub<pino.Logger>(createLogger()),
    "srv-test",
    createStub<AgentManager>(agentManager),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    "/tmp/paseo-test",
    createStub<DaemonConfigStore>(daemonConfigStore),
    null,
    { allowedOrigins: new Set() },
    createWorkspaceAutoNameStub(),
    createWorkspaceRuntimeStore(),
    undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    undefined,
    undefined,
    createStub<ScheduleService>({}),
    createStub<CheckoutDiffManager>({
      subscribe: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      getMetrics: vi.fn(() => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      })),
      dispose: vi.fn(),
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    pushNotifications,
    createProviderSnapshotManagerStub().manager,
  );

  return { server, agentManager, pushNotifications };
}

function createOpenSocket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  };
}

function createSessionWithActivity(
  activity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
  } | null,
  subscribed = true,
  workspaceTodos = false,
) {
  return {
    getClientActivity: vi.fn(() => activity),
    supports: () => false,
    supportsForSource: () => workspaceTodos,
    getPermissions: () => ["workspace.read"],
    subscribesToAgent: vi.fn(async () => subscribed),
  };
}

function connectClient(
  server: VoiceAssistantWebSocketServer,
  activity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
  } | null,
  options: { subscribed?: boolean; workspaceTodos?: boolean; workspaceRead?: boolean } = {},
) {
  const ws = createOpenSocket();
  const delivery = new SessionDelivery(() => {});
  delivery.attach(ws, false);
  const session = {
    ...createSessionWithActivity(
      activity,
      options.subscribed ?? true,
      options.workspaceTodos ?? false,
    ),
    getPermissions: () => (options.workspaceRead === false ? [] : ["workspace.read"]),
    emitCapabilityMessageToSource: vi.fn(
      (_capability: string, source: object, message: unknown) => {
        (source as ReturnType<typeof createOpenSocket>).send(
          JSON.stringify({ type: "session", message }),
        );
      },
    ),
    delivery,
    wantsSourceNotification: () => true,
  };
  asInternals<WebSocketServerInternals>(server).sessions.set(ws, {
    kind: "trusted",
    session,
    clientId: "client-test",
    appVersion: null,
    connectionLogger: createLogger(),
    sockets: new Set([ws]),
    externalDisconnectCleanupTimeout: null,
  });
  return ws;
}

function readAttentionRequiredMessage(ws: ReturnType<typeof createOpenSocket>) {
  const rawMessage = ws.send.mock.calls[0]?.[0];
  expect(typeof rawMessage).toBe("string");
  if (typeof rawMessage !== "string") throw new Error("Expected string WebSocket frame");
  const message = JSON.parse(rawMessage);
  expect(message.type).toBe("session");
  expect(message.message.type).toBe("agent_stream");
  expect(message.message.payload.event.type).toBe("attention_required");
  return message.message.payload.event;
}

describe("VoiceAssistantWebSocketServer notification payloads", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not emit attention or include presence without an agent-directory subscription", async () => {
    const { server, pushNotifications } = createServer();
    const now = new Date();
    const unsubscribed = connectClient(
      server,
      {
        deviceType: "web",
        appVisible: true,
        focusedAgentId: "agent-1",
        lastActivityAt: now,
      },
      { subscribed: false },
    );

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
      attentionTimestamp: new Date(),
    });

    expect(unsubscribed.send).not.toHaveBeenCalled();
    expect(pushNotifications.sent).toHaveLength(1);
  });

  it("uses assistant preview text for push notifications with markdown removed", async () => {
    const getLastAssistantMessage = vi.fn(
      async () => "**Done**. Updated `README.md` and [link](https://example.com).",
    );
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
      attentionTimestamp: new Date(),
    });

    expect(pushNotifications.sent).toEqual([
      {
        title: "Agent finished",
        body: "Done. Updated README.md and link.",
        data: {
          serverId: "srv-test",
          workspaceId: WORKSPACE_ID,
          agentId: "agent-1",
          reason: "finished",
        },
      },
    ]);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-1");
  });

  it("sends push notifications regardless of UI label presence", async () => {
    const getLastAssistantMessage = vi.fn(async () => "Done.");
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        labels: {},
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-2",
      provider: "claude",
      reason: "finished",
      attentionTimestamp: new Date(),
    });

    expect(pushNotifications.sent).toHaveLength(1);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-2");
  });

  it("routes a hidden stale focused browser tab's notification to the present Electron web client", async () => {
    const { server, pushNotifications } = createServer();
    const nowMs = Date.now();
    const electronWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-Y",
      lastActivityAt: new Date(nowMs - 5_000),
    });
    const firefoxWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-X",
      lastActivityAt: new Date(nowMs - 300_000),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-X",
      provider: "claude",
      reason: "finished",
      attentionTimestamp: new Date(),
    });

    expect(readAttentionRequiredMessage(electronWs).shouldNotify).toBe(true);
    expect(readAttentionRequiredMessage(firefoxWs).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });

  it("pushes non-error attention when the only connected client has never sent a heartbeat", async () => {
    const { server, pushNotifications } = createServer();
    const ws = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "finished",
      attentionTimestamp: new Date(),
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toHaveLength(1);
  });

  it("does not push error attention when the only connected client has never sent a heartbeat", async () => {
    const { server, pushNotifications } = createServer();
    const ws = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "error",
      attentionTimestamp: new Date(),
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });

  it("routes a todo due notification to one present client and does not push", async () => {
    const { server, pushNotifications } = createServer();
    const now = Date.now();
    const recentWs = connectClient(
      server,
      {
        deviceType: "web",
        appVisible: false,
        focusedAgentId: null,
        lastActivityAt: new Date(now - 5_000),
      },
      { workspaceTodos: true },
    );
    const staleWs = connectClient(
      server,
      {
        deviceType: "mobile",
        appVisible: false,
        focusedAgentId: null,
        lastActivityAt: new Date(now - 300_000),
      },
      { workspaceTodos: true },
    );
    const focusedButIneligible = {
      deviceType: "web" as const,
      appVisible: true,
      focusedAgentId: "main-1",
      lastActivityAt: new Date(now),
    };
    const legacy = connectClient(server, focusedButIneligible);
    const restricted = connectClient(server, focusedButIneligible, {
      workspaceTodos: true,
      workspaceRead: false,
    });

    await asInternals<WebSocketServerInternals>(server).handleTodoDue({
      kind: "due",
      item: {
        todoId: "todo-1",
        workspaceId: WORKSPACE_ID,
        title: "Review the result",
        status: "pending",
        checklist: [],
        dueAt: new Date(now - 1_000).toISOString(),
        remindBeforeMinutes: null,
        snoozedUntil: null,
        lastDueNotifiedAt: null,
        source: {
          mainAgentId: "main-1",
          topicKey: "topic-1",
          topicTitlePreview: "Review thread",
        },
        assignedAgentId: null,
        revision: 1,
        createdAt: new Date(now - 10_000).toISOString(),
        updatedAt: new Date(now - 10_000).toISOString(),
        completedAt: null,
      },
    });

    const readTodoMessage = (ws: ReturnType<typeof createOpenSocket>) => {
      const raw = ws.send.mock.calls[0]?.[0];
      expect(typeof raw).toBe("string");
      if (typeof raw !== "string") throw new Error("Expected todo session frame");
      return JSON.parse(raw).message;
    };
    expect(readTodoMessage(recentWs).payload.shouldNotify).toBe(true);
    expect(readTodoMessage(staleWs).payload.shouldNotify).toBe(false);
    expect(legacy.send).not.toHaveBeenCalled();
    expect(restricted.send).not.toHaveBeenCalled();
    expect(pushNotifications.sent).toEqual([]);
  });

  it.each([{ mainAgentId: "main-2", topicKey: "task-2", topicTitlePreview: "Release task" }, null])(
    "pushes the complete mobile routing contract for a todo with source %j",
    async (source) => {
      const { server, pushNotifications } = createServer();
      await asInternals<WebSocketServerInternals>(server).handleTodoDue({
        kind: "remind_before",
        item: {
          todoId: "todo-2",
          workspaceId: WORKSPACE_ID,
          title: "Prepare the release",
          status: "pending",
          checklist: [],
          dueAt: "2026-11-26T10:00:00.000Z",
          remindBeforeMinutes: 15,
          snoozedUntil: null,
          lastDueNotifiedAt: null,
          source,
          assignedAgentId: null,
          revision: 3,
          createdAt: "2026-11-26T09:00:00.000Z",
          updatedAt: "2026-11-26T09:30:00.000Z",
          completedAt: null,
        },
      });

      expect(pushNotifications.sent).toEqual([
        {
          title: "Todo reminder",
          body: "Prepare the release",
          data: {
            serverId: "srv-test",
            reason: "todo_due",
            type: "workspace.todo.due_triggered",
            workspaceId: WORKSPACE_ID,
            todoId: "todo-2",
            agentId: source?.mainAgentId ?? "",
            topicKey: source?.topicKey ?? "",
          },
        },
      ]);
    },
  );

  it("notifies once while an agent's finish stays unread", async () => {
    const { server, pushNotifications } = createServer();
    const broadcast = (attentionTimestamp: Date) =>
      asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
        agentId: "agent-1",
        provider: "claude",
        reason: "finished",
        attentionTimestamp,
      });
    const firstUnreadFinish = new Date(1_000);

    await broadcast(firstUnreadFinish);
    await broadcast(firstUnreadFinish);
    await broadcast(firstUnreadFinish);
    expect(pushNotifications.sent).toHaveLength(1);

    // After the user reads the agent (or marks it unread), its next unread finish is new.
    await broadcast(new Date(2_000));
    expect(pushNotifications.sent).toHaveLength(2);
  });

  it("notifies a repeated finish when the user had the agent on screen for the first one", async () => {
    const { server, pushNotifications } = createServer();
    const activity = {
      deviceType: "web" as const,
      appVisible: true,
      focusedAgentId: "agent-1" as string | null,
      lastActivityAt: new Date(),
    };
    connectClient(server, activity);
    const unreadFinish = new Date(1_000);
    const broadcast = () =>
      asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
        agentId: "agent-1",
        provider: "claude",
        reason: "finished",
        attentionTimestamp: unreadFinish,
      });

    await broadcast();
    expect(pushNotifications.sent).toEqual([]);

    // The user leaves; the agent keeps finishing turns it starts on its own.
    activity.appVisible = false;
    activity.focusedAgentId = null;
    activity.lastActivityAt = new Date(Date.now() - 600_000);
    await broadcast();
    await broadcast();
    expect(pushNotifications.sent).toHaveLength(1);
  });
});
