import { expect, test, vi } from "vitest";
import type { AgentMessageDelivery } from "../../agent-messages/index.js";
import type { ManagedAgent } from "../../agent-manager.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { createFinishObservation } from "./observation.js";

function agent(lifecycle: ManagedAgent["lifecycle"]): ManagedAgent {
  return {
    id: "child",
    provider: "codex",
    cwd: "/tmp",
    config: { provider: "codex", cwd: "/tmp", title: "Live title" },
    capabilities: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    availableModes: [],
    currentModeId: null,
    pendingPermissions: new Map(),
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence: null,
    historyPrimed: true,
    lastUserMessageAt: null,
    activeTurnId: null,
    activeTurnStartedAt: null,
    attention: { requiresAttention: false },
    foregroundTurnWaiters: new Set(),
    finalizedForegroundTurnIds: new Set(),
    unsubscribeSession: null,
    labels: {},
    metadata: {},
    lifecycle,
    activeForegroundTurnId: null,
    session: null,
  } as ManagedAgent;
}

test("an initially idle child falls back to its live title when the stored title is a UUID", async () => {
  const current = agent("idle");
  const manager = {
    getAgent: () => current,
    subscribe: () => () => {},
    waitForAgentEvent: async () => ({
      status: "idle" as const,
      completionSnapshot: current,
      lastMessage: "Finished",
      permission: null,
    }),
  };
  const storage = { get: async () => ({ title: "ABCDEF12-3456-7890-ABCD-EF1234567890" }) };
  const observation = createFinishObservation({
    agentManager: manager as unknown as import("../../agent-manager.js").AgentManager,
    agentStorage: storage as unknown as import("../../agent-storage.js").AgentStorage,
    waitForResume: async () => {},
    messages: () => ({ waitForDispatch: async () => {} }) as unknown as AgentMessageDelivery,
    hosts: () => ({}) as import("../../host-operations/index.js").ToolHosts,
    serverId: "origin",
    logger: createTestLogger(),
  });
  const session = await observation.open(
    { id: "watch", callerAgentId: "parent", childAgentId: "child" },
    new AbortController().signal,
  );
  try {
    await expect(session.next()).resolves.toMatchObject({ final: { title: "Live title" } });
  } finally {
    await session.close();
  }
});

test("a closed event retains its config title after the live agent is removed", async () => {
  let current: ManagedAgent | undefined = agent("idle");
  let subscriber: ((event: unknown) => void) | undefined;
  const waitStarted = Promise.withResolvers<void>();
  const manager = {
    getAgent: () => current,
    subscribe: (handler: (event: unknown) => void) => {
      subscriber = handler;
      return () => {};
    },
    getCompletionAssistantMessage: async () => "Finished",
    waitForAgentEvent: () => {
      waitStarted.resolve();
      return new Promise<never>(() => {});
    },
  };
  const observation = createFinishObservation({
    agentManager: manager as unknown as import("../../agent-manager.js").AgentManager,
    agentStorage: {
      get: async () => ({ title: "ABCDEF12-3456-7890-ABCD-EF1234567890" }),
    } as unknown as import("../../agent-storage.js").AgentStorage,
    waitForResume: async () => {},
    messages: () => ({ waitForDispatch: async () => {} }) as unknown as AgentMessageDelivery,
    hosts: () => ({}) as import("../../host-operations/index.js").ToolHosts,
    serverId: "origin",
    logger: createTestLogger(),
  });
  const session = await observation.open(
    { id: "watch", callerAgentId: "parent", childAgentId: "child" },
    new AbortController().signal,
  );
  try {
    await waitStarted.promise;
    const closed = agent("closed");
    current = undefined;
    subscriber?.({ type: "agent_state", agent: closed });
    await expect(session.next()).resolves.toMatchObject({
      final: { status: "closed", title: "Live title" },
      lastMessage: "Finished",
    });
  } finally {
    await session.close();
  }
});

test.each([
  { updated: "Updated title", expected: "Updated title" },
  { updated: "ABCDEF12-3456-7890-ABCD-EF1234567890", expected: "Live title" },
  { updated: "CHILD", expected: "Live title" },
])(
  "reads the latest valid title after the completion message resolves: $updated",
  async ({ updated, expected }) => {
    let current = agent("idle");
    let stored = { title: "Initial title" };
    let subscriber: ((event: unknown) => void) | undefined;
    const message = Promise.withResolvers<string | null>();
    const manager = {
      getAgent: () => current,
      subscribe: (handler: (event: unknown) => void) => {
        subscriber = handler;
        return () => {};
      },
      getCompletionAssistantMessage: vi.fn(() => message.promise),
      waitForAgentEvent: vi.fn(async () => ({
        status: "running" as const,
        completionSnapshot: { status: "running" } as never,
        lastMessage: null,
        permission: null,
      })),
      effectiveOptionsFor: () => ({}),
    };
    const storage = { get: vi.fn(async () => stored) };
    const messages = {
      waitForDispatch: async () => {},
    } as unknown as AgentMessageDelivery;
    const observation = createFinishObservation({
      agentManager: manager as unknown as import("../../agent-manager.js").AgentManager,
      agentStorage: storage as unknown as import("../../agent-storage.js").AgentStorage,
      waitForResume: async () => {},
      messages: () => messages,
      hosts: () => ({}) as import("../../host-operations/index.js").ToolHosts,
      serverId: "origin",
      logger: createTestLogger(),
    });
    const session = await observation.open(
      { id: "watch", callerAgentId: "parent", childAgentId: "child" },
      new AbortController().signal,
    );

    current = agent("closed");
    subscriber?.({ type: "agent_state", agent: current });
    stored = { title: updated };
    message.resolve("Finished");

    await expect(session.next()).resolves.toMatchObject({
      final: { title: expected },
      lastMessage: "Finished",
    });
    await session.close();
  },
);
