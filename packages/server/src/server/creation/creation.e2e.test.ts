import { execFileSync } from "node:child_process";
import type { z } from "zod";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import {
  AGENT_PROFILE_ID_LABEL,
  PARENT_AGENT_ID_LABEL,
  WORKSPACE_ROLE_LABEL,
  WORKSPACE_MAIN_ROLE,
} from "@getpaseo/protocol/agent-labels";
import { WebSocket } from "ws";
import { SessionInboundMessageSchema, WSOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import pino from "pino";
import type { CreationSnapshot, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { isPaseoToolEnabled } from "../agent/paseo-tool-policy.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { createFakeCodexAppServer } from "../agent/providers/codex/test-utils/fake-app-server.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("creates a silent Main Session and scopes summary and history to the new workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "creation-main-session-"));
  const opened: string[] = [];
  const daemon = await createCreationDaemon({
    agentClients: createTestAgentClients({
      beforeCreateSession: async (config) => {
        if (!config.internal) opened.push(config.provider);
      },
    }),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.16.0",
    clientId: "creation-main-session",
  });
  try {
    await client.connect();
    const source = { kind: "directory", path: directory } as const;
    const legacy = await client.createWorkspace({
      source,
      agent: { config: { provider: "codex", cwd: directory } },
    });
    expect(legacy.error).toBeNull();
    expect(legacy.mainAgent).toBeUndefined();
    const empty = await client.createWorkspace({
      source,
      mainAgent: { config: { provider: "claude", cwd: directory } },
    });
    expect(empty.error).toBeNull();
    expect(empty.agent).toBeUndefined();
    expect(empty.mainAgent).toMatchObject({
      workspaceId: empty.workspace?.id,
      status: "closed",
      labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
    });
    expect(opened).toEqual(["codex"]);
    const input = {
      source,
      idempotencyKey: "default-main",
      mainAgent: { config: { provider: "claude", cwd: directory } },
      agent: { config: { provider: "codex", cwd: directory }, initialPrompt: "Write a test" },
    };
    const created = await client.createWorkspace(input);
    expect(created.error).toBeNull();
    if (!created.workspace || !created.agent || !created.mainAgent) {
      throw new Error("Expected the workspace, Main Session, and coding session");
    }
    const { workspace, agent, mainAgent } = created;
    expect(mainAgent).toMatchObject({
      workspaceId: workspace.id,
      status: "closed",
      labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
    });
    expect(agent.labels).toMatchObject({ [PARENT_AGENT_ID_LABEL]: mainAgent.id });
    expect(created.creation?.mainAgent?.id).toBe(mainAgent.id);
    const duplicate = await client.createWorkspace(input);
    expect(duplicate.mainAgent?.id).toBe(mainAgent.id);
    expect(duplicate.agent?.id).toBe(agent.id);
    const history = await client.fetchAgentHistory({ filter: { workspaceIds: [workspace.id] } });
    expect(history.entries.map(({ agent: entry }) => entry.id).sort()).toEqual(
      [mainAgent.id, agent.id].sort(),
    );
    const emptyHistory = await client.fetchAgentHistory({ filter: { workspaceIds: [] } });
    expect(emptyHistory.entries).toEqual([]);
    const summary = await client.summarizeWorkspaceAgents({ workspaceId: workspace.id });
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0]).toMatchObject({
      agentId: agent.id,
      parentAgentId: mainAgent.id,
      relationship: "level1",
      firstUserPrompt: "Write a test",
    });
    expect(summary.attachment.type).toBe("text");
    expect(daemon.daemon.agentManager.getAgent(mainAgent.id)).toBeNull();
    expect(opened).toEqual(["codex", "codex"]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60_000);

function createCreationDaemon(options: Parameters<typeof createTestPaseoDaemon>[0] = {}) {
  const agentClients = options.agentClients ?? createTestAgentClients();
  return createTestPaseoDaemon({
    ...options,
    agentClients,
    // Installed provider CLIs must not change when background naming starts.
    providerOverrides: Object.fromEntries(
      BUILTIN_PROVIDER_IDS.map((id) => [id, { enabled: id in agentClients }]),
    ),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("explicit Main creation admits one root and preserves the first turn and receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "creation-explicit-main-"));
  const releaseTurn = deferred<void>();
  const opening = deferred<void>();
  const releaseOpening = deferred<void>();
  const prompts: unknown[] = [];
  const daemon = await createCreationDaemon({
    agentProfiles: [
      { id: "review", name: "Reviewer", provider: "claude", defaultResident: true },
      { id: "ordinary", name: "Ordinary", provider: "claude" },
    ],
    agentClients: createTestAgentClients({
      beforeCreateSession: async (config) => {
        if (config.internal || config.title !== "Review lead") return;
        opening.resolve();
        await releaseOpening.promise;
      },
      onStartTurn: (prompt, config) => {
        if (!config.internal) prompts.push(prompt);
      },
      beforeTurnComplete: () => releaseTurn.promise,
    }),
  });
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  const client = new DaemonClient({ url, clientId: "explicit-main-creator" });
  const observer = new DaemonClient({ url, clientId: "explicit-main-observer" });
  const peer = await connectCreationPeer(daemon.port);
  const updates: SessionOutboundMessage[] = [];
  const unsubscribe = observer.subscribeRawMessages((message) => updates.push(message));
  const mainAgentId = randomUUID();
  try {
    await client.connect();
    await observer.connect();
    expect(client.getLastServerInfoMessage()?.features?.agentCreateAsMain).toBe(true);
    await client.patchDaemonConfig({ mainControlAppendSystemPrompt: "Frozen test policy" });
    const { workspace } = await client.createWorkspace({
      source: { kind: "directory", path: directory },
    });
    if (!workspace) throw new Error("Missing workspace");
    const observed = await observer.fetchWorkspaces({
      subscribe: {},
      filter: { query: workspace.id },
    });
    expect(observed.entries.find(({ id }) => id === workspace.id)?.hasActiveMainAgent).toBe(false);
    const { workspace: otherWorkspace } = await client.createWorkspace({
      source: { kind: "directory", path: directory },
    });
    if (!otherWorkspace) throw new Error("Missing other workspace");
    const request = {
      workspaceId: workspace.id,
      workspaceRole: "main" as const,
      agentId: mainAgentId,
      idempotencyKey: "explicit-main",
      clientMessageId: "explicit-main-message",
      initialPrompt: "Review the changes",
      config: {
        provider: "codex",
        cwd: directory,
        model: "gpt-5.4",
        modeId: "default",
        thinkingOptionId: "high",
        title: "Review lead",
      },
      metadata: { feature: "test" },
      labels: { [AGENT_PROFILE_ID_LABEL]: "main-preset" },
      attachments: [
        { type: "text" as const, mimeType: "text/plain" as const, text: "Review context" },
      ],
    };
    const first = client.createAgent(request);
    void first.catch(() => undefined);
    await opening.promise;
    const denied = await observer
      .createAgent({
        ...request,
        agentId: randomUUID(),
        idempotencyKey: "competing-main",
      })
      .catch((error: unknown) => error);
    expect(denied).toMatchObject({ code: "workspace_main_exists", outcome: "rejected" });
    const otherMain = await observer.createAgent({
      workspaceId: otherWorkspace.id,
      workspaceRole: "main",
      config: { provider: "codex", cwd: directory, title: "Other main" },
    });
    expect(otherMain.labels[WORKSPACE_ROLE_LABEL]).toBe(WORKSPACE_MAIN_ROLE);
    expect(await daemon.daemon.agentStorage.get(mainAgentId)).toBeNull();
    releaseOpening.resolve();
    await expect.poll(() => prompts.length).toBe(1);
    const receipt = await peer.request({
      type: "creation.subscribe.request",
      requestId: "competing-main-receipt",
      kind: "agent",
      idempotencyKey: "competing-main",
      subscribe: false,
    });
    if (receipt.type !== "creation.subscribe.response") throw new Error("Missing creation receipt");
    expect(receipt.payload.snapshot).toMatchObject({
      phase: "failed",
      failedStage: "agent",
      errorCode: "workspace_main_exists",
      outcomeUnknown: false,
    });
    await expect
      .poll(() =>
        updates.some(
          (message) =>
            message.type === "workspace_update" &&
            message.payload.kind === "upsert" &&
            message.payload.workspace.id === workspace.id &&
            message.payload.workspace.hasActiveMainAgent === true,
        ),
      )
      .toBe(true);
    const created = await first;
    releaseTurn.resolve();
    const retry = await observer.createAgent(request);
    expect(retry.id).toBe(created.id);
    await observer.sendAgentMessage(mainAgentId, request.initialPrompt, {
      messageId: request.clientMessageId,
      attachments: request.attachments,
    });
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).toContain("Review context");
    expect(JSON.stringify(prompts[0])).toContain("Reviewer");
    expect(created).toMatchObject({
      id: mainAgentId,
      title: "Review lead",
      workspaceId: workspace.id,
      labels: {
        [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE,
        [AGENT_PROFILE_ID_LABEL]: "main-preset",
      },
      metadata: { feature: "test" },
    });
    expect(created.labels?.[PARENT_AGENT_ID_LABEL]).toBeUndefined();
    expect(
      isPaseoToolEnabled(
        daemon.daemon.agentManager.getPaseoToolPolicy(mainAgentId),
        "archive_workspace",
      ),
    ).toBe(false);
    await client.patchDaemonConfig({ mainControlAppendSystemPrompt: "Changed policy" });
    expect(await daemon.daemon.agentStorage.get(mainAgentId)).toMatchObject({
      mainControlSystemPrompt: "Frozen test policy",
      config: { model: "gpt-5.4", modeId: "default", thinkingOptionId: "high" },
    });
    const records = await daemon.daemon.agentStorage.listByWorkspaces([workspace.id]);
    expect(records.map((record) => record.labels)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          [PARENT_AGENT_ID_LABEL]: mainAgentId,
          [AGENT_PROFILE_ID_LABEL]: "review",
        }),
      ]),
    );
    expect(records).toHaveLength(2);
  } finally {
    releaseOpening.resolve();
    releaseTurn.resolve();
    unsubscribe();
    peer.close();
    await client.close();
    await observer.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60_000);

test("explicit Main creation starts its first turn before a concurrent archive", async () => {
  const residentRequested = deferred<void>();
  const releaseResident = deferred<void>();
  const events: string[] = [];
  const daemon = await createCreationDaemon({
    agentProfiles: [{ id: "review", name: "Reviewer", provider: "claude", defaultResident: true }],
    agentClients: createTestAgentClients({
      onStartTurn: (_prompt, config) => {
        if (config.title === "Review lead") events.push("turn started");
      },
    }),
  });
  const { agentManager, agentStorage } = daemon.daemon;
  const createResident = agentManager.createSilentResidentSubagent.bind(agentManager);
  const residentSpy = vi
    .spyOn(agentManager, "createSilentResidentSubagent")
    .mockImplementationOnce(async (input) => {
      residentRequested.resolve();
      await releaseResident.promise;
      const result = await createResident(input);
      if (result.created) events.push("resident created");
      return result;
    });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: "explicit-main-archive-race",
  });
  const config = { provider: "codex", cwd: daemon.staticDir };
  const source = { kind: "directory", path: config.cwd } as const;
  const mainAgentId = randomUUID();
  try {
    await client.connect();
    const { workspace } = await client.createWorkspace({ source });
    const { workspace: otherWorkspace, agent: otherAgent } = await client.createWorkspace({
      source,
      agent: { config },
    });
    if (!workspace || !otherWorkspace || !otherAgent)
      throw new Error("Missing workspaces or agent");
    const creation = client.createAgent({
      config: { ...config, title: "Review lead" },
      agentId: mainAgentId,
      workspaceId: workspace.id,
      workspaceRole: "main",
      initialPrompt: "Review the changes",
    });
    void creation.catch(() => undefined);
    await residentRequested.promise;
    expect(await agentStorage.get(mainAgentId)).toMatchObject({
      labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
    });

    const archivedAt = new Date().toISOString();
    const archive = agentManager.archiveSnapshot(mainAgentId, archivedAt).then((record) => {
      events.push("archived");
      return record;
    });
    void archive.catch(() => undefined);
    // The unrelated promotion must pass the queued archive while creation is paused.
    await agentManager.setAgentMainControl(otherAgent.id, true);
    expect(await agentStorage.get(otherAgent.id)).toMatchObject({
      labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
    });
    expect((await agentStorage.get(mainAgentId))?.archivedAt).toBeFalsy();
    expect(events).toEqual([]);

    releaseResident.resolve();
    await expect(creation).resolves.toMatchObject({ id: mainAgentId });
    await expect(archive).resolves.toMatchObject({ archivedAt });
    expect(events).toEqual(["resident created", "turn started", "archived"]);
  } finally {
    releaseResident.resolve();
    residentSpy.mockRestore();
    await client.close();
    await daemon.close();
  }
}, 60_000);

test.each(["Main", "unrelated session"])(
  "explicit Main creation coordinates public archive of %s",
  async (target) => {
    const preparingTurn = deferred<void>();
    const releaseStart = deferred<void>();
    const releaseTurn = deferred<void>();
    const events: string[] = [];
    const agentClients = createTestAgentClients({
      beforeTurnComplete: () => releaseTurn.promise,
      onInterrupt: () => events.push("interrupted"),
    });
    const codex = agentClients.codex!;
    const createSession = codex.createSession.bind(codex);
    vi.spyOn(codex, "createSession").mockImplementation(async (...args) => {
      const agent = await createSession(...args);
      if (args[0].title === "Review lead") {
        const startTurn = agent.startTurn.bind(agent);
        agent.startTurn = async (...turnArgs) => {
          preparingTurn.resolve();
          await releaseStart.promise;
          events.push("turn started");
          return startTurn(...turnArgs);
        };
      }
      return agent;
    });
    const daemon = await createCreationDaemon({ agentClients });
    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    const creator = new DaemonClient({ url });
    const peer = new DaemonClient({ url });
    const mainId = randomUUID();
    const manager = daemon.daemon.agentManager;
    const archiveAgent = manager.archiveAgent.bind(manager);
    vi.spyOn(manager, "archiveAgent").mockImplementation((...args) => {
      if (args[0] === mainId) events.push("archive entered");
      return archiveAgent(...args);
    });
    try {
      await Promise.all([creator.connect(), peer.connect()]);
      const config = { provider: "codex", cwd: daemon.staticDir };
      const { workspace, agent: regular } = await creator.createWorkspace({
        source: { kind: "directory", path: config.cwd },
        agent: { config },
      });
      if (!workspace || !regular) throw new Error("Missing workspace or regular agent");
      const creation = creator.createAgent({
        config: { ...config, title: "Review lead" },
        workspaceId: workspace.id,
        workspaceRole: "main",
        agentId: mainId,
        clientMessageId: "first-main-message",
        initialPrompt: "Review the changes",
      });
      void creation.catch(() => undefined);
      await preparingTurn.promise;

      const archive = peer.archiveAgent(target === "Main" ? mainId : regular.id);
      void archive.catch(() => undefined);
      if (target === "Main") {
        // Detect the first action of the public archive while provider startup is paused.
        await vi.waitFor(() => expect(events).toEqual(["archive entered"]));
        expect((await daemon.daemon.agentStorage.get(mainId))?.archivedAt).toBeFalsy();
        releaseStart.resolve();
        await expect(creation).resolves.toMatchObject({ id: mainId });
        await archive;
        expect(events).toEqual(["archive entered", "turn started", "interrupted"]);
      } else {
        await expect
          .poll(async () => (await daemon.daemon.agentStorage.get(regular.id))?.archivedAt)
          .toEqual(expect.any(String));
        await archive;
        expect(events).toEqual([]);
        releaseStart.resolve();
        await expect(creation).resolves.toMatchObject({ id: mainId });
      }
    } finally {
      releaseStart.resolve();
      releaseTurn.resolve();
      await Promise.all([creator.close(), peer.close()]);
      await daemon.close();
    }
  },
  60_000,
);

test.each(["accepted", "rejected", "unknown"] as const)(
  "explicit Main creation records a first Codex command with %s outcome",
  async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), "creation-main-command-"));
    const commandReceived = deferred<void>();
    const reply = deferred<void>();
    let commandCount = 0;
    const codex = new CodexAppServerAgentClient(
      pino({ level: "silent" }),
      { command: { mode: "replace", argv: [process.execPath] }, env: { CODEX_HOME: root } },
      {
        appServerProcess: {
          resolvePrefix: async () => ({ command: process.execPath, args: [] }),
          spawn: () =>
            createFakeCodexAppServer({
              "thread/loaded/list": () => ({ data: ["thread-1"] }),
              "thread/compact/start": async () => {
                commandCount += 1;
                if (commandCount > 1) return {};
                commandReceived.resolve();
                await reply.promise;
                if (outcome === "accepted") return {};
                return {
                  __jsonRpcError: {
                    code: outcome === "rejected" ? -32602 : -32603,
                    message: `Compaction ${outcome}`,
                  },
                };
              },
            }).child,
        },
      },
    );
    const daemon = await createCreationDaemon({ agentClients: { codex }, mcpEnabled: false });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const observer = await connectCreationPeer(daemon.port);
    const messageId = "initial-compact";
    const key = "create-main-with-compact";
    const phases: string[] = [];
    try {
      await client.connect();
      const { workspace } = await client.createWorkspace({
        source: { kind: "directory", path: root },
      });
      if (!workspace) throw new Error("Missing workspace");
      const creation = client.createAgent({
        config: { provider: "codex", cwd: root },
        workspaceId: workspace.id,
        workspaceRole: "main",
        idempotencyKey: key,
        clientMessageId: messageId,
        initialPrompt: "/compact",
        onEvent: (snapshot) => phases.push(snapshot.phase),
      });
      void creation.catch(() => undefined);
      await commandReceived.promise;
      const status = await observer.request({
        type: "creation.subscribe.request",
        requestId: "compact-creation-status",
        kind: "agent",
        idempotencyKey: key,
        subscribe: false,
      });
      expect(status).toMatchObject({ payload: { snapshot: { phase: "agent_ready" } } });
      reply.resolve();
      const { id } = await creation;
      if (outcome === "accepted") expect(phases).toContain("prompt_started");
      else expect(phases).not.toContain("prompt_started");

      const retry = client.sendAgentMessage(id, "/compact", { messageId, waitForDispatch: true });
      if (outcome === "unknown") {
        await expect(retry).rejects.toThrow("agent_request_outcome_unknown");
      } else {
        await retry;
      }
      if (outcome === "rejected") await expect.poll(() => commandCount).toBe(2);
      else expect(commandCount).toBe(1);
    } finally {
      reply.resolve();
      observer.close();
      await client.close();
      await daemon.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test("explicit Main occupancy survives closing and follows archive, promotion and restore", async () => {
  const daemon = await createCreationDaemon();
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  const client = new DaemonClient({ url, clientId: "main-lifecycle-creator" });
  const observer = new DaemonClient({ url, clientId: "main-lifecycle-observer" });
  const updates: SessionOutboundMessage[] = [];
  const unsubscribe = observer.subscribeRawMessages((message) => updates.push(message));
  const { agentManager, agentStorage } = daemon.daemon;
  const config = { provider: "codex", cwd: daemon.staticDir };
  const source = { kind: "directory", path: config.cwd } as const;
  try {
    await client.connect();
    await observer.connect();
    const created = await client.createWorkspace({
      source,
      agent: { config, workspaceRole: "main" },
    });
    if (!created.workspace || !created.agent)
      throw new Error(created.error ?? "Missing workspace or Main");
    expect(created.mainAgent).toBeUndefined();
    expect(created.workspace.hasActiveMainAgent).toBe(true);
    expect(created.agent.labels[WORKSPACE_ROLE_LABEL]).toBe(WORKSPACE_MAIN_ROLE);

    const { workspace } = await client.createWorkspace({ source });
    if (!workspace) throw new Error("Missing second workspace");
    const main = await client.createAgent({
      config,
      workspaceId: workspace.id,
      workspaceRole: "main",
      background: true,
    });
    expect(main.background).toBe(true);
    await agentManager.closeAgent(main.id);
    expect((await agentStorage.get(main.id))?.lastStatus).toBe("closed");
    const observed = await observer.fetchWorkspaces({
      subscribe: {},
      filter: { query: workspace.id },
    });
    expect(observed.entries.find(({ id }) => id === workspace.id)?.hasActiveMainAgent).toBe(true);
    await expect(
      client.createAgent({ config, workspaceId: workspace.id, workspaceRole: "main" }),
    ).rejects.toMatchObject({ code: "workspace_main_exists" });

    const waitForOccupancy = async (after: number, occupied: boolean) =>
      expect
        .poll(() =>
          updates
            .slice(after)
            .some(
              (message) =>
                message.type === "workspace_update" &&
                message.payload.kind === "upsert" &&
                message.payload.workspace.id === workspace.id &&
                message.payload.workspace.hasActiveMainAgent === occupied,
            ),
        )
        .toBe(true);
    let before = updates.length;
    await agentManager.archiveSnapshot(main.id, new Date().toISOString());
    await waitForOccupancy(before, false);

    const regular = await client.createAgent({ config, workspaceId: workspace.id });
    await agentManager.closeAgent(regular.id);
    before = updates.length;
    await client.setAgentMainControl(regular.id, true);
    await waitForOccupancy(before, true);

    await agentManager.unarchiveSnapshot(main.id);
    expect((await agentStorage.get(main.id))?.labels[WORKSPACE_ROLE_LABEL]).toBeUndefined();
    expect((await agentStorage.get(regular.id))?.labels[WORKSPACE_ROLE_LABEL]).toBe(
      WORKSPACE_MAIN_ROLE,
    );

    before = updates.length;
    await agentManager.archiveSnapshot(regular.id, new Date().toISOString());
    await waitForOccupancy(before, false);
    before = updates.length;
    await agentManager.unarchiveSnapshot(regular.id);
    await waitForOccupancy(before, true);

    await client.createAgent({ config, workspaceId: workspace.id });
    before = updates.length;
    const moved = await client.moveAgentToWorkspace(regular.id, {
      expectedWorkspaceId: workspace.id,
    });
    await waitForOccupancy(before, false);
    expect((await observer.findWorkspace(moved.workspaceId))?.hasActiveMainAgent).toBe(true);
    await expect(
      client.createAgent({ config, workspaceId: moved.workspaceId, workspaceRole: "main" }),
    ).rejects.toMatchObject({ code: "workspace_main_exists" });
  } finally {
    unsubscribe();
    await client.close();
    await observer.close();
    await daemon.close();
  }
}, 60_000);

test("creation progresses before agent readiness and continues after the disconnected Session is cleaned up", async () => {
  const provider = deferred<void>();
  const ready = deferred<CreationSnapshot>();
  const disconnected = deferred<void>();
  const cleaned = deferred<void>();
  const directory = await mkdtemp(join(tmpdir(), "creation-wire-"));
  let agents = 0;
  let prompts = 0;
  const daemon = await createCreationDaemon({
    logger: pino(
      { level: "trace" },
      {
        write(line) {
          const { msg } = JSON.parse(line);
          if (msg === "Client disconnected; waiting for reconnect") disconnected.resolve();
          if (msg === "agent.session.lifecycle.cleanup") cleaned.resolve();
        },
      },
    ),
    agentClients: createTestAgentClients({
      beforeCreateSession: async (config) => {
        if (config.internal) return;
        agents++;
        await provider.promise;
      },
      onStartTurn: (_prompt, config) => {
        if (config.internal) return;
        prompts++;
      },
    }),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.7.2",
    clientId: "creation-subscriber",
  });
  const observer = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.7.2",
    clientId: "creation-independent-observer",
  });
  const observerMessages: SessionOutboundMessage[] = [];
  const unsubscribe = observer.subscribeRawMessages((message) => observerMessages.push(message));
  const workspaceId = "wks_0123456789abcdef";
  const agentId = randomUUID();
  const request = {
    idempotencyKey: "workspace-one",
    workspaceId,
    source: { kind: "directory" as const, path: directory },
    agent: {
      agentId,
      provider: "codex",
      cwd: directory,
      initialPrompt: "Create once",
      clientMessageId: "initial-one",
    },
  };
  try {
    await client.connect();
    await observer.connect();
    const first = client.createWorkspace({
      ...request,
      onEvent: (snapshot) => {
        if (snapshot.phase === "workspace_ready") ready.resolve(snapshot);
      },
    });
    void first.catch(() => undefined);
    const snapshot = await ready.promise;
    expect(snapshot).toMatchObject({ workspaceId, agentId, phase: "workspace_ready" });
    expect((await observer.fetchAgents()).entries).toHaveLength(0);
    expect(
      observerMessages.filter((message) => message.type === "workspace.create.update"),
    ).toHaveLength(0);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await client.close();
    await disconnected.promise;
    await vi.advanceTimersByTimeAsync(90_000);
    await cleaned.promise;
    vi.useRealTimers();
    await expect(first).rejects.toThrow("closed");
    // A disconnected form cannot prevent the provider or initial prompt from starting.
    provider.resolve();
    await expect.poll(() => prompts).toBe(1);
    const replay = await observer.createWorkspace(request);
    expect(replay.error).toBeNull();
    expect(replay.workspace?.id).toBe(workspaceId);
    expect(replay.agent?.id).toBe(agentId);
    expect(replay.agent?.title).toBe("Create once");
    expect(agents).toBe(1);
    expect(prompts).toBe(1);
    const conflict = await observer.createWorkspace({
      ...request,
      idempotencyKey: "another-intent",
    });
    expect(conflict.error).toBe("workspace_id_conflict");
    expect(agents).toBe(1);
  } finally {
    vi.useRealTimers();
    provider.resolve();
    unsubscribe();
    await client.close();
    await observer.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60000);

async function connectCreationPeer(port: number) {
  const timeout = 30_000;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: SessionOutboundMessage[] = [];
  socket.on("message", (data) => {
    const frame = WSOutboundMessageSchema.parse(JSON.parse(data.toString()));
    if (frame.type === "session") frames.push(frame.message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      clientType: "browser",
      clientId: randomUUID(),
      protocolVersion: 1,
      appVersion: "0.8.0",
    }),
  );
  await expect
    .poll(() => frames.some((m) => m.type === "status" && m.payload.status === "server_info"), {
      timeout,
    })
    .toBe(true);
  return {
    close: () => socket.close(),
    request: async (
      message: z.input<typeof SessionInboundMessageSchema> & { requestId: string },
    ) => {
      socket.send(JSON.stringify({ type: "session", message }));
      const response = () =>
        frames.find(
          (m) =>
            "payload" in m && "requestId" in m.payload && m.payload.requestId === message.requestId,
        );
      await expect.poll(response, { timeout }).toBeDefined();
      return response()!;
    },
  };
}

test.each([false, true])(
  "workspace identity does not depend on subscribing (first subscribe=%s)",
  async (subscribe) => {
    const directory = await mkdtemp(join(tmpdir(), "creation-identity-"));
    const daemon = await createCreationDaemon();
    const peer = await connectCreationPeer(daemon.port);
    try {
      const request = {
        type: "workspace.create.request" as const,
        source: { kind: "directory" as const, path: directory },
        idempotencyKey: "same-workspace",
      };
      const first = await peer.request({ ...request, requestId: "first", subscribe });
      const replay = await peer.request({ ...request, requestId: "replay", subscribe: !subscribe });
      if (first.type !== "workspace.create.response" || replay.type !== "workspace.create.response")
        throw new Error("Expected workspace responses");
      expect(first.payload.error).toBeNull();
      expect(replay.payload.error).toBeNull();
      expect(replay.payload.workspace?.id).toBe(first.payload.workspace?.id);
    } finally {
      peer.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  60000,
);

test.each(["create_agent_request", "agent.create.request"] as const)(
  "legacy and modern agent RPCs share one creation identity (first %s)",
  async (type) => {
    const directory = await mkdtemp(join(tmpdir(), "creation-agent-identity-"));
    let creations = 0;
    const daemon = await createCreationDaemon({
      agentClients: createTestAgentClients({
        beforeCreateSession: async (config) => {
          if (config.internal) return;
          creations++;
          // A real provider or Git checkout may take longer than Vitest's default 1s poll budget.
          await new Promise((resolve) => setTimeout(resolve, 1_200));
        },
      }),
    });
    const peer = await connectCreationPeer(daemon.port);
    try {
      const request = {
        config: { provider: "codex", cwd: directory },
        idempotencyKey: "same-agent",
      };
      const first = await peer.request({ ...request, type, requestId: "first" });
      const replay = await peer.request({
        ...request,
        type: type === "agent.create.request" ? "create_agent_request" : "agent.create.request",
        requestId: "replay",
      });
      const createdAgent = (message: SessionOutboundMessage) => {
        if (message.type === "agent.create.response") {
          expect(message.payload.error).toBeNull();
          return message.payload.agent;
        }
        if (message.type === "status" && message.payload.status === "agent_created")
          return message.payload.agent;
        throw new Error(`Unexpected creation result ${JSON.stringify(message)}`);
      };
      expect(createdAgent(replay)?.id).toBe(createdAgent(first)?.id);
      const agentId = createdAgent(first)!.id;
      await daemon.daemon.agentManager.setTitle(agentId, "Updated after creation");
      await daemon.daemon.agentManager.flush();
      const legacyReplay = await peer.request({
        ...request,
        type: "create_agent_request",
        requestId: "legacy-after-update",
      });
      expect(createdAgent(legacyReplay)?.title).toBe("Updated after creation");
      expect(creations).toBe(1);
    } finally {
      peer.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  60000,
);

test("legacy keyed creation preserves checkout error codes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "creation-checkout-error-"));
  execFileSync("git", ["init", "-b", "main", directory], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd: directory, stdio: "pipe" },
  );
  const daemon = await createCreationDaemon({ agentClients: createTestAgentClients() });
  const peer = await connectCreationPeer(daemon.port);
  try {
    const result = await peer.request({
      type: "create_agent_request",
      requestId: "missing-branch",
      idempotencyKey: "missing-branch",
      config: { provider: "codex", cwd: directory },
      worktree: { mode: "checkout-branch", branch: "does-not-exist" },
    });
    expect(result).toMatchObject({
      type: "status",
      payload: { status: "agent_create_failed", errorCode: "unknown_branch" },
    });
  } finally {
    peer.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60000);

test.each(["agent", "workspace"] as const)(
  "%s creation succeeds when the provider rejects its initial prompt",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "creation-prompt-rejected-"));
    const rejection = "Input exceeds the maximum length of 1048576 characters.";
    let sessions = 0;
    let prompts = 0;
    const daemon = await createCreationDaemon({
      agentClients: createTestAgentClients({
        beforeCreateSession: async (config) => {
          if (config.internal) return;
          sessions++;
        },
        onStartTurn: (_prompt, config) => {
          if (config.internal) return;
          prompts++;
          throw new Error(rejection);
        },
      }),
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.11.1",
    });
    const snapshots: CreationSnapshot[] = [];
    const agent = {
      config: { provider: "codex", cwd: directory },
      initialPrompt: "Continue the attached conversation.",
      clientMessageId: "draft:initial-message",
    };
    const streamed: AgentTimelineItem[] = [];
    const unsubscribe = daemon.daemon.agentManager.subscribe((event) => {
      if (event.type === "agent_stream" && event.event.type === "timeline") {
        streamed.push(event.event.item);
      }
    });
    try {
      await client.connect();
      const submit = async () => {
        const common = {
          idempotencyKey: "rejected-first-prompt",
          onEvent: (snapshot: CreationSnapshot) => snapshots.push(snapshot),
        };
        if (kind === "agent") return client.createAgent({ ...common, ...agent });
        const result = await client.createWorkspace({
          ...common,
          source: { kind: "directory", path: directory },
          agent,
        });
        expect(result.error).toBeNull();
        return result.agent!;
      };
      const created = await submit();
      expect(created).toMatchObject({ status: "error", lastError: rejection });
      expect(snapshots.map((snapshot) => snapshot.phase)).not.toContain("prompt_started");
      expect(snapshots.at(-1)).toMatchObject({
        phase: "completed",
        error: null,
        agent: { id: created.id },
      });
      const expectedTimeline = [
        {
          type: "user_message",
          text: agent.initialPrompt,
          clientMessageId: agent.clientMessageId,
          messageId: agent.clientMessageId,
        },
        { type: "assistant_message", text: `[System Error] ${rejection}` },
      ];
      expect(
        (await client.fetchAgentTimeline(created.id)).entries.map((entry) => entry.item),
      ).toEqual(expectedTimeline);
      expect(streamed).toEqual(expectedTimeline);
      expect((await submit()).id).toBe(created.id);
      expect(
        (await client.fetchAgentTimeline(created.id)).entries.map((entry) => entry.item),
      ).toEqual(expectedTimeline);
      expect((await client.fetchAgents()).entries).toHaveLength(1);
      expect({ sessions, prompts }).toEqual({ sessions: 1, prompts: 1 });
    } finally {
      unsubscribe();
      await client.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  60000,
);

test("combined worktree and agent creation owns setup on the workspace and replays one identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-owned-setup-"));
  const daemon = await createCreationDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await initializeSetupRepository(directory);
    await client.connect();
    const input = {
      idempotencyKey: "combined-workspace-setup",
      source: { kind: "worktree" as const, cwd: directory, worktreeSlug: "combined-setup" },
      agent: { config: { provider: "codex", cwd: directory } },
    };
    const first = await client.createWorkspace(input);
    const replay = await client.createWorkspace(input);
    expect(first.error).toBeNull();
    expect(replay.error).toBeNull();
    expect(replay.workspace?.id).toBe(first.workspace?.id);
    expect(replay.agent?.id).toBe(first.agent?.id);
    if (!first.workspace || !first.agent) throw new Error("Expected combined creation resources");
    const observation = client.observeWorkspaceSetup(first.workspace.id);
    await observation.ready;
    await expect
      .poll(async () => (await client.fetchWorkspaceSetupStatus(first.workspace!.id)).snapshot, {
        timeout: 10000,
      })
      .toMatchObject({
        status: "completed",
        detail: {
          log: "",
          commands: [
            expect.objectContaining({
              log: expect.stringContaining("workspace setup output\n"),
              status: "completed",
            }),
          ],
        },
      });
    await observation.release();
    expect(await readFile(join(first.workspace.workspaceDirectory!, "setup-runs"), "utf8")).toBe(
      "once\n",
    );
    const timeline = await client.fetchAgentTimeline(first.agent.id);
    expect(
      timeline.entries.map((entry) => entry.item).filter((item) => item.type === "tool_call"),
    ).toEqual([]);
    expect(first.agent.workspaceId).toBe(first.workspace.id);
    const conflict = await client.createWorkspace({
      ...input,
      source: { ...input.source, worktreeSlug: "different-intent" },
    });
    expect(conflict.error).toBe("workspace_request_key_conflict");
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60000);

test.each(["create_agent_request", "agent.create.request"] as const)(
  "%s rejects agent worktree placement at the wire boundary",
  async (type) => {
    const directory = await mkdtemp(join(tmpdir(), "agent-worktree-rejected-"));
    const daemon = await createCreationDaemon();
    const peer = await connectCreationPeer(daemon.port);
    try {
      for (const placement of [{ git: { createWorktree: true } }, { worktreeName: "legacy" }]) {
        const response = await peer.request({
          type,
          requestId: randomUUID(),
          config: { provider: "codex", cwd: directory },
          ...placement,
        });
        if (response.type !== "agent.create.response" && response.type !== "status")
          throw new Error("Expected agent creation response");
        const error = response.payload.error;
        expect(error).toContain("createWorkspace");
      }
    } finally {
      peer.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

async function initializeSetupRepository(directory: string): Promise<void> {
  execFileSync("git", ["init", "-b", "main", directory], { stdio: "pipe" });
  await writeFile(
    join(directory, "paseo.json"),
    JSON.stringify({
      worktree: {
        setup: [
          "node -e \"require('fs').appendFileSync('setup-runs', 'once\\n'); console.log('workspace setup output')\"",
        ],
      },
    }),
  );
  execFileSync("git", ["add", "paseo.json"], { cwd: directory });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "setup fixture",
    ],
    { cwd: directory, stdio: "pipe" },
  );
}

test("Hub-shaped keyed agent worktree creation uses workspace setup and preserves resource identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keyed-agent-workspace-setup-"));
  const daemon = await createCreationDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const peer = await connectCreationPeer(daemon.port);
  try {
    await initializeSetupRepository(directory);
    await client.connect();
    const input = {
      type: "create_agent_request" as const,
      idempotencyKey: "keyed-agent-worktree",
      config: { provider: "codex", cwd: directory },
      worktree: { mode: "branch-off" as const, newBranch: "keyed-agent-setup", base: "main" },
    };
    const first = await peer.request({ ...input, requestId: "first" });
    const replay = await peer.request({ ...input, requestId: "replay" });
    if (
      first.type !== "status" ||
      first.payload.status !== "agent_created" ||
      replay.type !== "status" ||
      replay.payload.status !== "agent_created"
    )
      throw new Error("Expected agent creation responses");
    expect(replay.payload.agent.id).toBe(first.payload.agent.id);
    expect(replay.payload.agent.workspaceId).toBe(first.payload.agent.workspaceId);
    const agent = first.payload.agent;
    if (!agent.workspaceId) throw new Error("Expected agent workspace ownership");
    await expect
      .poll(async () => (await client.fetchWorkspaceSetupStatus(agent.workspaceId!)).snapshot, {
        timeout: 10000,
      })
      .toMatchObject({
        status: "completed",
        detail: {
          log: "",
          commands: [
            expect.objectContaining({ log: expect.stringContaining("workspace setup output\n") }),
          ],
        },
      });
    expect(await readFile(join(agent.cwd, "setup-runs"), "utf8")).toBe("once\n");
    expect(
      (await client.fetchAgentTimeline(agent.id)).entries
        .map((entry) => entry.item)
        .filter((item) => item.type === "tool_call"),
    ).toEqual([]);
    const conflict = await peer.request({
      ...input,
      requestId: "conflict",
      worktree: { ...input.worktree, newBranch: "different-intent" },
    });
    expect(conflict).toMatchObject({
      type: "status",
      payload: { status: "agent_create_failed", error: "agent_request_key_conflict" },
    });
  } finally {
    peer.close();
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60000);
