import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { createHostClient } from "@getpaseo/client/node";
import {
  EXPLICIT_PARENT_REPORTING,
  isExplicitParentReportingLabels,
  PARENT_AGENT_ID_LABEL,
  PARENT_REPORTING_LABEL,
  PARENT_SERVER_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../../test-utils/paseo-daemon.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { createJsonFinishSubscriptionStore } from "../finish-subscriptions/index.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import { createAgentCommand } from "./create.js";
import { ForegroundPromptStart } from "../agent-run-state.js";
import type { ManagedAgent } from "../agent-manager.js";

const logger = createTestLogger();

test("SDK WebSocket creation persists explicit reporting only for a valid child", async () => {
  const finishInitial = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const instance = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: (prompt) =>
        String(prompt).includes("Work and report the result explicitly")
          ? finishInitial.promise
          : finish.promise,
    }),
  });
  const client = createHostClient(`127.0.0.1:${instance.port}`, {
    clientId: "explicit-parent-reporting-test",
    reconnect: { enabled: false },
  });
  const paseo = createPaseoApi(client);
  try {
    await client.connect();
    const workspace = await paseo.workspaces.create({
      source: { kind: "directory", path: instance.staticDir },
    });
    const config = { provider: "claude/claude-test" };
    const main = await workspace.agents.create({ config });
    const child = await workspace.agents.create({
      config,
      parent: main.id,
      parentReporting: "explicit",
      prompt: "Work and report the result explicitly",
    });
    const listSubscriptions = () => createJsonFinishSubscriptionStore(instance.paseoHome).list();
    const storedLabels = async (id: string) => (await instance.daemon.agentStorage.get(id))?.labels;
    expect(await storedLabels(child.id)).toMatchObject({
      [PARENT_AGENT_ID_LABEL]: main.id,
      [PARENT_REPORTING_LABEL]: EXPLICIT_PARENT_REPORTING,
    });

    finishInitial.resolve();
    expect((await child.waitForFinish(5000)).status).toBe("idle");
    expect(await listSubscriptions()).toEqual([]);
    await child.send("A follow-up from the user");
    expect(await listSubscriptions()).toEqual([]);

    const ordinary = await workspace.agents.create({
      config,
      parent: main.id,
      prompt: "Use default completion notifications",
    });
    expect(await storedLabels(ordinary.id)).not.toHaveProperty(PARENT_REPORTING_LABEL);
    await expect
      .poll(listSubscriptions)
      .toEqual([expect.objectContaining({ childAgentId: ordinary.id, callerAgentId: main.id })]);

    const invalid = await workspace.agents.create({
      config,
      parent: main.id,
      labels: { [PARENT_REPORTING_LABEL]: "invalid" },
    });
    expect(await storedLabels(invalid.id)).toMatchObject({ [PARENT_AGENT_ID_LABEL]: main.id });
    expect(await storedLabels(invalid.id)).not.toHaveProperty(PARENT_REPORTING_LABEL);

    const root = await workspace.agents.create({ config, parentReporting: "explicit" });
    expect(await storedLabels(root.id)).not.toHaveProperty(PARENT_REPORTING_LABEL);
    const forged = await client.createAgent({
      config: { provider: "claude", model: "claude-test", cwd: instance.staticDir },
      workspaceId: workspace.id,
      labels: {
        [PARENT_AGENT_ID_LABEL]: main.id,
        [PARENT_REPORTING_LABEL]: EXPLICIT_PARENT_REPORTING,
      },
    });
    expect(await storedLabels(forged.id)).not.toHaveProperty(PARENT_REPORTING_LABEL);
    expect(await storedLabels(forged.id)).not.toHaveProperty(PARENT_AGENT_ID_LABEL);

    const remoteParent = { agentId: main.id, serverId: "other-host" };
    const remoteChild = await workspace.agents.create({
      config,
      parent: remoteParent,
      parentReporting: "explicit",
    });
    expect(await storedLabels(remoteChild.id)).toMatchObject({
      [PARENT_AGENT_ID_LABEL]: remoteParent.agentId,
      [PARENT_REPORTING_LABEL]: EXPLICIT_PARENT_REPORTING,
      [PARENT_SERVER_ID_LABEL]: remoteParent.serverId,
    });
  } finally {
    finishInitial.resolve();
    finish.resolve();
    await paseo.dispose();
    await client.close();
    await instance.close();
  }
}, 20000);

function createRealAgentManager(storage: AgentStorage): AgentManager {
  return new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });
}

async function removeRealAgentManagerWorkdir({
  agentManager,
  storage,
  workdir,
}: {
  agentManager: AgentManager;
  storage: AgentStorage;
  workdir: string;
}): Promise<void> {
  agentManager.prepareForShutdown();
  await Promise.all(agentManager.listAgents().map((agent) => agentManager.closeAgent(agent.id)));
  await agentManager.flushForShutdown();
  await storage.flush();
  rmSync(workdir, { recursive: true, force: true });
}

// Creates a worktree directory under repoRoot and reports it back as a fresh
// workspace so the command can stamp the agent with it (mirrors the production
// worktree service).
function fakeWorktreeCreator(args: { repoRoot: string; createdWorkspaceId: string }) {
  const worktreePath = join(args.repoRoot, "worktree");
  const workspaceCwd = join(worktreePath, "packages", "app");
  mkdirSync(workspaceCwd, { recursive: true });
  return async (): Promise<CreatePaseoWorktreeWorkflowResult> =>
    ({
      worktree: { worktreePath },
      intent: {},
      workspace: { workspaceId: args.createdWorkspaceId, cwd: workspaceCwd },
      repoRoot: args.repoRoot,
      created: true,
    }) as unknown as CreatePaseoWorktreeWorkflowResult;
}

test("session create forwards clientMessageId to the initial prompt run options", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const streamAgent = vi.fn(() => (async function* noop() {})());
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent: vi.fn(async () => snapshot),
      getAgent: vi.fn(() => snapshot),
      tryRunOutOfBand: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
      reloadStalePluginSession: async () => {},
      streamAgent,
      waitForAgentRunStart: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
    workspaceId: "ws-create-test",
    initialPrompt: "hello from create",
    clientMessageId: "msg-create-1",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
  });

  expect(streamAgent).toHaveBeenCalledWith(
    "agent-1",
    "hello from create",
    { clientMessageId: "msg-create-1" },
    expect.any(ForegroundPromptStart),
  );
});

test("session create validates the requested mode against the provider's modes", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockRejectedValue(
    new Error("Invalid mode 'plan' for provider 'opencode'. Available modes: build, myplan"),
  );
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "session",
      config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "plan" },
      workspaceId: "ws-create-test",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
    }),
  ).rejects.toThrow("Invalid mode 'plan'");

  expect(stub.resolveCreateConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "opencode",
      cwd: "/tmp/paseo-create-test",
      requestedMode: "plan",
    }),
  );
  expect(createAgent).not.toHaveBeenCalled();
});

test("session create applies the resolved mode from the provider create config", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockResolvedValue({
    modeId: "build",
    providerOptions: { auto_accept: true },
  });
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "build" },
    workspaceId: "ws-create-test",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      modeId: "build",
      providerOptions: { auto_accept: true },
    }),
    undefined,
    expect.anything(),
  );
});

test("mcp create accepts provider-only internal input and leaves model undefined", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: {
      resolveCreateConfig: vi.fn(async (input) => {
        expect(input.provider).toBe("claude");
        return {};
      }),
    } as Parameters<typeof createAgentCommand>[0]["providerSnapshotManager"],
  };

  await createAgentCommand(dependencies, {
    kind: "mcp",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    workspaceId: "ws-create-test",
    title: "provider default",
    initialPrompt: "hello",
    notifyOnFinish: false,
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "claude",
      model: undefined,
    }),
    undefined,
    expect.objectContaining({
      workspaceId: "ws-create-test",
    }),
  );
});

test("session create stamps the requested workspaceId when no worktree setup runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-source");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create stamps the new worktree's workspaceId, not the parent's", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;

  try {
    const { snapshot: parent } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-parent",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
      },
    );

    const { snapshot: child } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager,
        createPaseoWorktree: fakeWorktreeCreator({
          repoRoot: workdir,
          createdWorkspaceId: "ws-new-worktree",
        }),
      },
      {
        kind: "mcp",
        provider: "codex/gpt-5.4",
        title: "child",
        initialPrompt: "do the thing",
        notifyOnFinish: false,
        callerAgentId: parent.id,
        worktree: { worktreeName: "feature", baseBranch: "main" },
      },
    );

    const storedChild = await storage.get(child.id);
    expect(storedChild?.workspaceId).toBe("ws-new-worktree");
    expect(storedChild?.labels).not.toHaveProperty(PARENT_REPORTING_LABEL);
    expect(child.cwd).toBe(join(workdir, "worktree", "packages", "app"));
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test.each([
  { parentReporting: "explicit", detached: false, expected: true },
  { parentReporting: "explicit", detached: true, expected: false },
  { parentReporting: "auto", detached: false, expected: false },
] as const)(
  "persists $parentReporting MCP reporting only for an explicit subagent (detached: $detached)",
  async ({ parentReporting, detached, expected }) => {
    const workdir = mkdtempSync(join(tmpdir(), "create-agent-reporting-test-"));
    const agentStorage = new AgentStorage(join(workdir, "agents"), logger);
    const agentManager = createRealAgentManager(agentStorage);
    const workspaceId = "ws-parent";
    try {
      const parent = await agentManager.createAgent(
        { provider: "codex", cwd: workdir },
        undefined,
        { workspaceId },
      );
      if (parentReporting === "auto") await agentManager.setAgentMainControl(parent.id, true);
      const { snapshot, initialPromptStarted } = await createAgentCommand(
        {
          agentManager,
          agentStorage,
          logger,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        },
        {
          kind: "mcp",
          provider: "codex/gpt-5.4",
          title: "Worker",
          callerAgentId: parent.id,
          initialPrompt: "Complete the task",
          notifyOnFinish: parentReporting === "explicit",
          parentReporting,
          detached,
          labels: { [PARENT_REPORTING_LABEL]: EXPLICIT_PARENT_REPORTING },
        },
      );
      expect(initialPromptStarted).toBe(true);
      const stored = await agentStorage.get(snapshot.id);
      expect(stored?.labels[PARENT_AGENT_ID_LABEL]).toBe(detached ? undefined : parent.id);
      expect(isExplicitParentReportingLabels(stored?.labels)).toBe(expected);
    } finally {
      await removeRealAgentManagerWorkdir({ agentManager, storage: agentStorage, workdir });
    }
  },
);

test("mcp create exposes the created worktree before dispatching the initial prompt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-worktree-callback-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const createdWorktree = await fakeWorktreeCreator({
    repoRoot: workdir,
    createdWorkspaceId: "ws-created-worktree",
  })();
  let observed:
    | {
        createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
        lifecycle: ManagedAgent["lifecycle"] | null;
      }
    | undefined;

  try {
    await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: {
          async resolveCreateConfig() {
            return {};
          },
        },
        createPaseoWorktree: async () => createdWorktree,
      },
      {
        kind: "mcp",
        provider: "codex",
        cwd: workdir,
        title: "worktree callback",
        initialPrompt: "Say done.",
        notifyOnFinish: false,
        worktree: { worktreeName: "feature", baseBranch: "main" },
        onCreated: ({ agentId, createdWorktree: callbackWorktree }) => {
          observed = {
            createdWorktree: callbackWorktree,
            lifecycle: agentManager.getAgent(agentId)?.lifecycle ?? null,
          };
        },
      },
    );

    expect(observed).toEqual({ createdWorktree, lifecycle: "idle" });
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create keeps the prompt title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Implement auth retries with backoff";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-title-source",
        initialPrompt: `${title}\n\ninclude tests`,
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create keeps an explicit title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-explicit-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Explicit override";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir, title },
        workspaceId: "ws-explicit-title-source",
        initialPrompt: "Implement auth retries with backoff",
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create with an internal config skips provider session persistence", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };
  const input = {
    kind: "session" as const,
    workspaceId: "ws-create-test",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
  };

  await createAgentCommand(dependencies, {
    ...input,
    config: { provider: "codex", cwd: "/tmp/paseo-create-test", internal: true },
  });
  await createAgentCommand(dependencies, {
    ...input,
    config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
  });

  expect(createAgent).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ provider: "codex", internal: true }),
    undefined,
    expect.objectContaining({ persistSession: false }),
  );
  expect(createAgent.mock.calls[1]?.[0]).not.toHaveProperty("internal");
  expect(createAgent.mock.calls[1]?.[2]).not.toHaveProperty("persistSession");
});
