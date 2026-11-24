import { expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import type { SessionInboundMessage, WSOutboundMessage } from "../messages.js";
import { createDaemonTestContext } from "../test-utils/index.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

test("workspace deferral RPC publishes durable state through the workspace directory", async () => {
  const ctx = await createDaemonTestContext({
    mcpEnabled: false,
    agentClients: {},
  });
  try {
    const workspace = await ctx.client.createWorkspace({
      source: { kind: "directory", path: ctx.daemon.staticDir },
    });
    if (!workspace.workspace) throw new Error(workspace.error ?? "Missing workspace");
    const { id: workspaceId } = workspace.workspace;
    const socket = new WebSocket(`ws://127.0.0.1:${ctx.daemon.port}/ws`);
    try {
      const frames: WSOutboundMessage[] = [];
      socket.on("message", (data, binary) => {
        if (!binary) frames.push(JSON.parse(data.toString()));
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.send(
        JSON.stringify({
          type: "hello",
          clientId: "workspace-deferral-peer",
          clientType: "browser",
          appVersion: "0.17.0",
          protocolVersion: 1,
          capabilities: { owned_subscriptions: true },
        }),
      );
      await expect
        .poll(() =>
          frames.some(
            (frame) =>
              frame.type === "session" &&
              frame.message.type === "status" &&
              frame.message.payload.status === "server_info",
          ),
        )
        .toBe(true);

      async function request(message: SessionInboundMessage) {
        socket.send(JSON.stringify({ type: "session", message }));
        if (!("requestId" in message)) throw new Error("A request ID is required");
        const reply = () =>
          frames.find(
            (frame) =>
              frame.type === "session" &&
              "payload" in frame.message &&
              "requestId" in frame.message.payload &&
              frame.message.payload.requestId === message.requestId,
          );
        await expect.poll(reply).toBeTruthy();
        const frame = reply();
        return frame?.type === "session" ? frame.message : undefined;
      }

      const listing = await request({
        type: "fetch_workspaces_request",
        requestId: "subscribe",
        subscribe: {},
      });
      expect(listing).toMatchObject({
        type: "fetch_workspaces_response",
        payload: { entries: [expect.objectContaining({ id: workspaceId })] },
      });

      expect(
        await request({
          type: "workspace.deferral.set.request",
          workspaceId,
          action: "park",
          requestId: "park",
        }),
      ).toEqual({
        type: "workspace.deferral.set.response",
        payload: { requestId: "park", success: true, error: null },
      });
      const latest = () =>
        frames
          .flatMap((frame) =>
            frame.type === "session" &&
            frame.message.type === "workspace_update" &&
            frame.message.payload.kind === "upsert" &&
            frame.message.payload.workspace.id === workspaceId
              ? [frame.message.payload.workspace]
              : [],
          )
          .at(-1);
      await expect.poll(() => latest()?.parkedAt).toBeTruthy();
      expect(latest()).not.toHaveProperty("snoozedUntil");

      expect(
        await request({
          type: "workspace.deferral.set.request",
          workspaceId,
          action: "restore",
          requestId: "restore",
        }),
      ).toMatchObject({ payload: { requestId: "restore", success: true } });
      await expect.poll(() => latest()?.parkedAt).toBeUndefined();
      expect(latest()).not.toHaveProperty("parkedAt");

      expect(
        await request({
          type: "agent.limit.recovery.request",
          workspaceId,
          agentId: "missing-agent",
          turnId: "old-turn",
          action: "continue",
          requestId: "missing",
        }),
      ).toMatchObject({
        type: "agent.limit.recovery.response",
        payload: { requestId: "missing", success: false },
      });
    } finally {
      socket.terminate();
    }
  } finally {
    await ctx.cleanup();
  }
});

test("a real manual send withdraws a delayed continuation before provider handoff", async () => {
  const resetsAt = new Date(Date.now() + 60_000).toISOString();
  const originalPrompt = "Emit a turn failure";
  const automaticPrompt = "Continue from where you left off.";
  const manualPrompt = "Continue manually from the client";
  const manualMessageId = "manual-message";
  const model = "test-quota-model";
  const reachedHandoff = Promise.withResolvers<void>();
  const releaseHandoff = Promise.withResolvers<void>();
  const received: string[] = [];
  const clients = createTestAgentClients({
    onStartTurn: (prompt) => received.push(String(prompt)),
  });
  const provider = clients.codex!;
  const createSession = provider.createSession.bind(provider);
  vi.spyOn(provider, "createSession").mockImplementation(async (...args) => {
    const session = await createSession(...args);
    Object.defineProperty(session, "capabilities", {
      value: { ...session.capabilities, defersPromptHandoff: true },
    });
    const subscribe = session.subscribe.bind(session);
    session.subscribe = (callback) =>
      subscribe((event) => {
        if (event.type !== "turn_failed") return callback(event);
        callback({
          ...event,
          conversationLimit: {
            limitId: "conversation",
            providerTurnId: event.turnId,
            model,
            resetsAt,
          },
        });
      });
    const startTurn = session.startTurn.bind(session);
    session.startTurn = async (prompt, options) => {
      if (prompt === automaticPrompt) {
        reachedHandoff.resolve();
        await releaseHandoff.promise;
      }
      await options?.beforeProviderDispatch?.();
      return startTurn(prompt, options);
    };
    return session;
  });
  const ctx = await createDaemonTestContext({ mcpEnabled: false, agentClients: clients });
  try {
    const workspace = await ctx.client.createWorkspace({
      source: { kind: "directory", path: ctx.daemon.staticDir },
    });
    if (!workspace.workspace) throw new Error(workspace.error ?? "Missing workspace");
    const workspaceId = workspace.workspace.id;
    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd: ctx.daemon.staticDir,
      model,
      workspaceId,
    });
    await ctx.client.sendMessage(agent.id, originalPrompt, { messageId: "original-message" });
    const { agentStorage, agentManager } = ctx.daemon.daemon;
    const failureTurnId = async () =>
      (await agentStorage.get(agent.id))?.failedConversationLimit?.turnId;
    await expect.poll(failureTurnId).toEqual(expect.any(String));
    const turnId = (await failureTurnId())!;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(Date.parse(resetsAt) - 100);
    await ctx.client.setAgentLimitRecovery({
      agentId: agent.id,
      workspaceId,
      turnId,
      action: "continue",
    });
    const scheduled = (await agentStorage.get(agent.id))?.limitContinuation;
    expect(scheduled).toMatchObject({ status: "scheduled", turnId, runAt: resetsAt });
    await vi.advanceTimersByTimeAsync(101);
    await reachedHandoff.promise;
    const manual = ctx.client.sendMessage(agent.id, manualPrompt, { messageId: manualMessageId });
    void manual.catch(() => undefined);
    await expect
      .poll(async () => (await agentStorage.get(agent.id))?.limitContinuation?.status)
      .toBe("cancelled");
    releaseHandoff.resolve();
    await manual;
    expect(received).toEqual([originalPrompt, manualPrompt]);
    const messages = agentManager
      .getTimeline(agent.id)
      .filter((entry) => entry.type === "user_message")
      .map((entry) => entry.messageId);
    expect(messages).toContain(manualMessageId);
    expect(messages).not.toContain(scheduled?.messageId);
  } finally {
    releaseHandoff.resolve();
    vi.useRealTimers();
    await ctx.cleanup();
  }
}, 20_000);
