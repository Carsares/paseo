import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { MessageReceipts } from "../message-receipts/index.js";
import type { PaseoToolCatalog } from "./tools/types.js";
import {
  getOpenAgentTabLabel,
  PARENT_AGENT_ID_LABEL,
  RESIDENT_AGENT_LABEL,
  SIDE_CHAT_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { type WSOutboundMessage, WSOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { deferred } from "../test-fixtures/reconciliation-registries.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import {
  createTestAgentClient,
  type TestAgentClientOptions,
} from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { topicAnchorsBeforeReset } from "../topic-threads/anchors.js";
import { TopicThreadStore } from "../topic-threads/store.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";
import {
  AgentManager,
  directHumanPromptRunOptions,
  topicFollowupRunOptions,
} from "./agent-manager.js";
import { formatAgentMessage } from "./agent-messages/index.js";
import { sendPreparedPromptToAgent, sendPromptToAgent, startAgentRun } from "./agent-prompt.js";
import type {
  AgentPermissionRequest,
  AgentPromptInput,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import { AgentStorage } from "./agent-storage.js";
import { createJsonFinishSubscriptionStore } from "./finish-subscriptions/index.js";
import { TopicMainArchiveError } from "./hierarchy-policy.js";
import { archiveAgentCommand } from "./lifecycle-command.js";
import { mergeProviderOptions } from "./provider-options.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { WorkspaceTaskLedgerStore } from "./task-ledger/index.js";

const WORKSPACE_ID = "workspace";
const provider = "antigravity";
const frozenInstructions = "Fixed role instructions";
const topicName = "User's startup topic";
const topicSummary = "Look at the boot trace first";

async function topicScenario(
  options: TestAgentClientOptions & {
    legacy?: boolean;
    useDisplayName?: boolean;
    secondProvider?: TestAgentClientOptions;
  } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-topic-manager-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(cwd, "agents"), logger);
  const topicThreads = new TopicThreadStore(cwd);
  const workspaces = new FileBackedWorkspaceRegistry(join(cwd, "workspaces.json"), logger);
  const now = new Date().toISOString();
  await workspaces.upsert(
    createPersistedWorkspaceRecord({
      workspaceId: WORKSPACE_ID,
      projectId: "project",
      cwd,
      kind: "directory",
      displayName: options.useDisplayName ? topicName : "Folder name",
      title: options.useDisplayName ? null : topicName,
      createdAt: now,
      updatedAt: now,
      ...(options.legacy || options.useDisplayName ? {} : { topic: { summary: topicSummary } }),
    }),
  );
  const firstClient = createTestAgentClient(provider, options);
  const secondClient =
    options.secondProvider && createTestAgentClient("codex", options.secondProvider);
  const manager = new AgentManager({
    clients: {
      [provider]: firstClient,
      ...(secondClient && { codex: secondClient }),
    },
    registry: storage,
    workspaceRegistry: workspaces,
    preserveTopicHistory: async (scope, rows) => {
      const { anchors } = await topicThreads.listWithAnchors(scope);
      for (const anchor of topicAnchorsBeforeReset(scope, rows, [], anchors, new Set()))
        await topicThreads.upsertAnchor(anchor);
    },
    logger,
  });
  manager.setMainControlAppendSystemPrompt(frozenInstructions);
  onTestFinished(async () => {
    await manager.flush();
    await rm(cwd, { recursive: true, force: true });
  });
  const config: AgentSessionConfig = { provider, cwd, modeId: "full-access" };
  return {
    manager,
    storage,
    workspaces,
    topicThreads,
    firstClient,
    secondClient,
    config,
    createSilentMain: () =>
      manager.createSilentWorkspaceMainAgent({ config, workspaceId: WORKSPACE_ID }),
    send: {
      agentManager: manager,
      agentStorage: storage,
      logger,
    },
  };
}

test("a legacy archive queued behind topic upgrade never cancels a running main", async () => {
  const turnEnd = deferred();
  const upgradeMayPersist = deferred();
  const upgradeInsideLock = deferred();
  const interrupt = vi.fn();
  const { manager, storage, workspaces, createSilentMain, send } = await topicScenario({
    legacy: true,
    onInterrupt: interrupt,
    beforeTurnComplete: () => turnEnd.promise,
  });
  const record = await createSilentMain();
  try {
    const started = await sendPromptToAgent({
      ...send,
      agentId: record.id,
      prompt: "First question",
    });
    expect(started.disposition).toBe("turn_started");
    if (started.disposition !== "turn_started") throw new Error("Expected a foreground turn");
    await started.started;
    const upgrade = manager.updateWorkspaceTopic(
      { workspaceId: WORKSPACE_ID, upgradeToTopic: true, mainAgentId: record.id },
      {
        get: (id) => workspaces.get(id),
        update: async (id, updater) => {
          upgradeInsideLock.resolve();
          await upgradeMayPersist.promise;
          return workspaces.update(id, updater);
        },
      },
    );
    await upgradeInsideLock.promise;
    const cancel = vi.spyOn(manager, "cancelAgentRun");
    const archiveEntered = deferred();
    const archiveAgent = manager.archiveAgent.bind(manager);
    vi.spyOn(manager, "archiveAgent").mockImplementation((...args) => {
      const result = archiveAgent(...args);
      archiveEntered.resolve();
      return result;
    });
    const archive = archiveAgentCommand(send, record.id);
    const rejects = expect(archive).rejects.toBeInstanceOf(TopicMainArchiveError);
    // Reaching this path proves preflight read the legacy workspace before the update committed.
    await archiveEntered.promise;
    upgradeMayPersist.resolve();
    await expect(upgrade).resolves.toMatchObject({
      mainAgentId: record.id,
      workspace: { topic: { revision: 1 } },
    });
    await rejects;
    expect(cancel).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(manager.hasInFlightRun(record.id)).toBe(true);
    expect((await storage.get(record.id))?.archivedAt).toBeFalsy();
  } finally {
    upgradeMayPersist.resolve();
    turnEnd.resolve();
    await manager.closeAgent(record.id);
  }
});

test("scoped, stored-only and agent tool archives protect the topic main and permit workspace archive", async () => {
  const { manager, storage, createSilentMain } = await topicScenario();
  const record = await createSilentMain();
  const archivedAt = new Date().toISOString();
  await expect(manager.archiveAgentInWorkspace(record.id, WORKSPACE_ID)).rejects.toBeInstanceOf(
    TopicMainArchiveError,
  );
  await expect(manager.archiveSnapshot(record.id, archivedAt)).rejects.toBeInstanceOf(
    TopicMainArchiveError,
  );
  const authorized = vi.fn(async () => undefined);
  await expect(manager.archiveAgentFromAgentTool(record.id, authorized)).rejects.toBeInstanceOf(
    TopicMainArchiveError,
  );
  expect(authorized).toHaveBeenCalledOnce();
  expect(await storage.get(record.id)).toMatchObject({ lastStatus: "closed" });
  expect((await storage.get(record.id))?.archivedAt).toBeFalsy();
  await manager.archiveAgentForWorkspace(record.id, WORKSPACE_ID, archivedAt);
  expect((await storage.get(record.id))?.archivedAt).toBe(archivedAt);
  await expect(manager.unarchiveSnapshot(record.id)).resolves.toBe(true);
  await manager.restoreArchivedSnapshot(record.id, archivedAt, WORKSPACE_ID);
  expect((await storage.get(record.id))?.archivedAt).toBe(archivedAt);
});

test("idle cleanup refuses unread tasks, background work, and active stored or internal subagents", async () => {
  const { manager, config, storage, createSilentMain } = await topicScenario();
  const main = await createSilentMain();
  const task = await manager.createAgent(config, undefined, {
    workspaceId: WORKSPACE_ID,
    labels: { [PARENT_AGENT_ID_LABEL]: main.id },
  });
  const archive = () => manager.archiveIdleTaskAgentInWorkspace(task.id, WORKSPACE_ID);
  const createChild = (internal: boolean) =>
    manager.createAgent({ ...config, internal }, undefined, {
      workspaceId: WORKSPACE_ID,
      labels: { [PARENT_AGENT_ID_LABEL]: task.id },
    });

  await manager.markAgentUnread(task.id);
  await expect(archive()).rejects.toThrow("unread");
  await manager.clearAgentAttention(task.id);

  const backgroundWork = { agentId: task.id, namespace: "heartbeat", id: "periodic" } as const;
  manager.setDaemonBackgroundWork({
    ...backgroundWork,
    kind: "heartbeat",
    description: null,
    startedAt: new Date().toISOString(),
    stop: async () => {},
  });
  await expect(archive()).rejects.toThrow("active");
  manager.removeDaemonBackgroundWork(backgroundWork);

  const internal = await createChild(true);
  const stored = await createChild(false);
  await manager.closeAgent(stored.id);
  try {
    await expect(archive()).rejects.toThrow("unarchived subagents");
    expect(manager.getAgent(internal.id)).not.toBeNull();
    expect((await storage.get(stored.id))?.archivedAt).toBeFalsy();
    await manager.archiveAgentInWorkspace(stored.id, WORKSPACE_ID);
    await expect(archive()).rejects.toThrow("unarchived subagents");
    expect(manager.getAgent(internal.id)).not.toBeNull();
    await manager.closeAgent(internal.id);
    await expect(archive()).resolves.toMatchObject({ archivedAt: expect.any(String) });
  } finally {
    await Promise.all([task, internal].map(({ id }) => manager.closeAgent(id)));
  }
});

test("WebSocket idle cleanup refuses a turn started by another client while manual archive interrupts it", async () => {
  const turnEnd = deferred();
  const onInterrupt = vi.fn(() => turnEnd.resolve());
  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    agentClients: {
      codex: createTestAgentClient("codex", {
        beforeTurnComplete: () => turnEnd.promise,
        onInterrupt,
      }),
    },
  });
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  const sender = new DaemonClient({ url });
  const cleaner = new DaemonClient({ url });
  const { agentManager, agentStorage } = daemon.daemon;
  try {
    await Promise.all([sender.connect(), cleaner.connect()]);
    expect(cleaner.getLastServerInfoMessage()?.features?.agentIdleArchiveV1).toBe(true);
    const { workspace, mainAgent } = await sender.createWorkspace({
      source: { kind: "directory", path: daemon.staticDir },
      title: "Archive cleanup",
      topic: { hideFromModel: true },
      mainAgent: { config: { provider: "codex", cwd: daemon.staticDir } },
    });
    if (!workspace || !mainAgent) throw new Error("Expected a topic with a main agent");
    const createTask = () =>
      agentManager.createAgent({ provider: "codex", cwd: daemon.staticDir }, undefined, {
        workspaceId: workspace.id,
        labels: { [PARENT_AGENT_ID_LABEL]: mainAgent.id },
      });
    const task = await createTask();
    await sender.sendMessage(task.id, "Leave this task running", { waitForDispatch: true });
    expect(agentManager.hasInFlightRun(task.id)).toBe(true);

    await expect(
      cleaner.archiveAgent(task.id, workspace.id, { onlyIfIdle: true }),
    ).rejects.toMatchObject({ code: "agent_not_idle" });
    expect(onInterrupt).not.toHaveBeenCalled();
    expect((await agentStorage.get(task.id))?.archivedAt).toBeFalsy();
    expect(agentManager.hasInFlightRun(task.id)).toBe(true);

    const manual = await cleaner.archiveAgent(task.id, workspace.id);
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect((await agentStorage.get(task.id))?.archivedAt).toBe(manual.archivedAt);

    const idleTask = await createTask();
    await expect(
      cleaner.archiveAgent(idleTask.id, "another-workspace", { onlyIfIdle: true }),
    ).rejects.toThrow("no longer in workspace");
    const cleanup = await cleaner.archiveAgent(idleTask.id, workspace.id, { onlyIfIdle: true });
    expect((await agentStorage.get(idleTask.id))?.archivedAt).toBe(cleanup.archivedAt);
    expect(onInterrupt).toHaveBeenCalledOnce();
  } finally {
    turnEnd.resolve();
    await Promise.allSettled([sender.close(), cleaner.close()]);
    await daemon.close();
  }
}, 30_000);

test("a failed reopen rollback cannot archive a main protected by a later topic upgrade", async () => {
  const { manager, storage, workspaces, createSilentMain } = await topicScenario({ legacy: true });
  const main = await createSilentMain();
  const archivedAt = new Date().toISOString();
  await manager.archiveAgentForWorkspace(main.id, WORKSPACE_ID, archivedAt);
  await expect(manager.unarchiveSnapshot(main.id)).resolves.toBe(true);
  await manager.updateWorkspaceTopic(
    { workspaceId: WORKSPACE_ID, upgradeToTopic: true },
    workspaces,
  );
  await expect(manager.restoreArchivedSnapshot(main.id, archivedAt)).resolves.toBeNull();
  expect((await storage.get(main.id))?.archivedAt).toBeFalsy();
});

test("a failed provider open during send restores the topic main's original archive", async () => {
  const { manager, storage, createSilentMain, send } = await topicScenario({
    beforeCreateSession: async () => {
      throw new Error("Provider unavailable");
    },
  });
  const record = await createSilentMain();
  const archivedAt = new Date().toISOString();
  await manager.archiveAgentForWorkspace(record.id, WORKSPACE_ID, archivedAt);

  await expect(
    sendPromptToAgent({ ...send, agentId: record.id, prompt: "Read the boot trace" }),
  ).rejects.toThrow("Provider unavailable");
  expect((await storage.get(record.id))?.archivedAt).toBe(archivedAt);
});

test.each([false, true])(
  "legacy close removes only the requesting client's topic member tab (retry=%s)",
  async (retry) => {
    const { manager, config, storage } = await topicScenario();
    const requester = getOpenAgentTabLabel("requester");
    const other = getOpenAgentTabLabel("other");
    const agent = await manager.createAgent(config, undefined, {
      workspaceId: WORKSPACE_ID,
      labels: { [requester]: "true", [other]: "true" },
    });
    try {
      if (retry) {
        const save = vi
          .spyOn(storage, "applySnapshot")
          .mockRejectedValueOnce(new Error("Disk write failed"));
        try {
          await expect(
            manager.archiveAgentForLegacyClose(agent.id, { clientId: "requester" }),
          ).rejects.toThrow("Disk write failed");
          expect((await storage.get(agent.id))?.labels?.[requester]).toBe("true");
        } finally {
          save.mockRestore();
        }
      }
      await expect(
        manager.archiveAgentForLegacyClose(agent.id, { clientId: "requester" }),
      ).resolves.toBeNull();
      expect(manager.getAgent(agent.id)?.labels).toEqual({ [other]: "true" });
      expect((await storage.get(agent.id))?.labels).toEqual({ [other]: "true" });
      expect((await storage.get(agent.id))?.archivedAt).toBeFalsy();
    } finally {
      await manager.closeAgent(agent.id);
    }
  },
);

test("legacy close still archives the main in a workspace that has not upgraded", async () => {
  const { manager, storage, createSilentMain } = await topicScenario({ legacy: true });
  const record = await createSilentMain();
  const result = await manager.archiveAgentForLegacyClose(record.id, { clientId: "requester" });
  expect(result).toMatchObject({ archivedAt: expect.any(String), record: { id: record.id } });
  expect((await storage.get(record.id))?.archivedAt).toBe(result?.archivedAt);
});

test("retrying an unscoped legacy close preserves an already archived resident record", async () => {
  const { manager, storage, createSilentMain } = await topicScenario({ legacy: true });
  const record = await createSilentMain();
  const archivedAt = record.createdAt;
  await storage.upsert({
    ...record,
    archivedAt,
    labels: { [RESIDENT_AGENT_LABEL]: "true" },
  });
  const before = await storage.get(record.id);
  await expect(manager.archiveAgentForLegacyClose(record.id, {})).resolves.toEqual({
    archivedAt,
    record: before,
  });
  expect(await storage.get(record.id)).toEqual(before);
});

test.each([false, true])(
  "closing a live legacy-workspace tab clears attention and keeps fork context only with a workspace match (%s)",
  async (scoped) => {
    const { manager, config, storage } = await topicScenario({ legacy: true });
    const agent = await manager.createAgent(config, undefined, { workspaceId: WORKSPACE_ID });
    try {
      await manager.appendTimelineItem(agent.id, {
        type: "user_message",
        text: "Explain the startup sequence.",
      });
      await manager.appendTimelineItem(agent.id, {
        type: "assistant_message",
        text: "Start at the bootstrap entry.",
      });
      await manager.markAgentUnread(agent.id);
      expect((await storage.get(agent.id))?.requiresAttention).toBe(true);
      const result = await manager.archiveAgentForLegacyClose(agent.id, {
        expectedWorkspaceId: scoped ? WORKSPACE_ID : undefined,
      });
      if (!result) throw new Error("Expected the legacy agent to archive");
      expect(result.record).toMatchObject({
        archivedAt: result.archivedAt,
        requiresAttention: false,
      });
      const context = manager.readArchivedForkContext(agent.id, result.archivedAt);
      expect(context?.itemCount ?? 0).toBe(scoped ? 2 : 0);
    } finally {
      if (manager.getAgent(agent.id)) await manager.closeAgent(agent.id);
    }
  },
);

test("topic upgrade selects an eligible root and rejects side chats or delegated agents", async () => {
  const { manager, config, storage, workspaces } = await topicScenario({ legacy: true });
  const options = { workspaceId: WORKSPACE_ID };
  const root = await manager.createAgent(config, undefined, options);
  const side = await manager.createAgent(config, undefined, {
    ...options,
    labels: { [SIDE_CHAT_LABEL]: "true" },
  });
  const child = await manager.createAgent(config, undefined, {
    ...options,
    labels: { [PARENT_AGENT_ID_LABEL]: root.id },
  });
  const upgrade = (mainAgentId: string) =>
    manager.updateWorkspaceTopic(
      { workspaceId: WORKSPACE_ID, mainAgentId, upgradeToTopic: true },
      workspaces,
    );
  try {
    await expect(upgrade(side.id)).rejects.toThrow("Only an active workspace root");
    await expect(upgrade(child.id)).rejects.toThrow("Only an active workspace root");
    expect((await workspaces.get(WORKSPACE_ID))?.topic).toBeUndefined();
    await expect(upgrade(root.id)).resolves.toMatchObject({ mainAgentId: root.id });
    expect((await storage.get(root.id))?.mainControlSystemPrompt).toBe(frozenInstructions);
  } finally {
    await Promise.all([root, side, child].map(({ id }) => manager.closeAgent(id)));
  }
});

test("silent timeline reads retained history without opening or replacing a live timeline", async () => {
  const opening = deferred();
  const mayOpen = deferred();
  const beforeCreateSession = vi.fn(() => {
    opening.resolve();
    return mayOpen.promise;
  });
  const { manager, storage, createSilentMain } = await topicScenario({ beforeCreateSession });
  const record = await createSilentMain();
  const empty = await manager.readSilentTopicTimeline(record.id);
  expect(empty).toMatchObject({ record: { id: record.id }, timeline: { rows: [] } });
  expect(beforeCreateSession).not.toHaveBeenCalled();
  const item = { type: "user_message", text: "Retained question" } as const;
  await storage.timelinePrefixes.save(record.id, {
    version: 1,
    rows: [{ seq: 1, item, timestamp: new Date().toISOString() }],
  });
  const loaded = manager.createAgentFromRecord(record.id);
  try {
    await opening.promise;
    const disk = await manager.readSilentTopicTimeline(record.id);
    expect(disk?.timeline.rows.map((row) => row.item)).toEqual([item]);
    expect(manager.getLoadedTimelineHead(record.id)).toBeNull();
    expect(beforeCreateSession).toHaveBeenCalledOnce();
    mayOpen.resolve();
    await loaded;
    expect(manager.getTimeline(record.id)).toEqual([item]);
    await expect(manager.readSilentTopicTimeline(record.id)).resolves.toBeNull();
  } finally {
    mayOpen.resolve();
    await loaded;
    await manager.closeAgent(record.id);
  }
});

test("an archived quiet main still reads history from storage", async () => {
  const beforeCreateSession = vi.fn(async () => {});
  const { manager, createSilentMain } = await topicScenario({ beforeCreateSession });
  const main = await createSilentMain();
  const archivedAt = new Date().toISOString();
  await manager.archiveAgentForWorkspace(main.id, WORKSPACE_ID, archivedAt);
  await expect(manager.readSilentTopicTimeline(main.id)).resolves.toMatchObject({
    record: { id: main.id, archivedAt },
    timeline: { rows: [] },
  });
  expect(beforeCreateSession).not.toHaveBeenCalled();
});

test("model receives topic context for human turns and steer, with privacy changes on the next request", async () => {
  const turnEnd = deferred();
  const providerPrompts: AgentPromptInput[] = [];
  const steer = vi.fn(async (_prompt: AgentPromptInput) => ({ status: "accepted" as const }));
  const { manager, storage, workspaces, createSilentMain, send } = await topicScenario({
    useDisplayName: true,
    onStartTurn: (prompt) => providerPrompts.push(prompt),
    beforeTurnComplete: () => turnEnd.promise,
    steerActiveTurn: steer,
  });
  await manager.updateWorkspaceTopic(
    { workspaceId: WORKSPACE_ID, upgradeToTopic: true, summary: topicSummary },
    workspaces,
  );
  const record = await createSilentMain();
  const readWorkspace = vi.spyOn(workspaces, "get");
  try {
    const first = await sendPromptToAgent({
      ...send,
      agentId: record.id,
      prompt: "First question",
      messageId: "first",
    });
    if (first.disposition !== "turn_started") throw new Error("Expected a foreground turn");
    await first.started;
    expect(providerPrompts).toEqual([expect.stringContaining(topicName)]);
    expect(providerPrompts[0]).toContain(topicSummary);
    expect(providerPrompts[0]).toContain(frozenInstructions);
    const followUp = (prompt: string, messageId: string) =>
      sendPromptToAgent({
        ...send,
        agentId: record.id,
        prompt,
        messageId,
        activeTurnBehavior: "steer",
      });
    await expect(followUp("Second question", "second")).resolves.toEqual({
      disposition: "steered",
    });
    expect(steer).toHaveBeenLastCalledWith(
      expect.stringContaining(topicSummary),
      expect.anything(),
    );
    await manager.updateWorkspaceTopic(
      { workspaceId: WORKSPACE_ID, hideFromModel: true },
      workspaces,
    );
    await expect(followUp("Private follow-up", "third")).resolves.toEqual({
      disposition: "steered",
    });
    expect(steer).toHaveBeenLastCalledWith("Private follow-up", expect.anything());

    readWorkspace.mockClear();
    await expect(
      sendPreparedPromptToAgent({
        ...send,
        agentId: record.id,
        prompt: "Daemon context",
        activeTurnBehavior: "steer",
        runOptions: { clientMessageId: "fourth" },
      }),
    ).resolves.toEqual({ disposition: "steered" });
    expect(readWorkspace).not.toHaveBeenCalled();
    expect(steer).toHaveBeenLastCalledWith("Daemon context", expect.anything());
    const userMessages = (await manager.getTimelineRows(record.id)).flatMap(({ item }) =>
      item.type === "user_message" ? [item.text] : [],
    );
    expect(userMessages).toEqual([
      "First question",
      "Second question",
      "Private follow-up",
      "Daemon context",
    ]);
    expect((await storage.get(record.id))?.mainControlSystemPrompt).toBe(frozenInstructions);
  } finally {
    turnEnd.resolve();
    await manager.closeAgent(record.id);
  }
});

test("active turn human authority requires a verified prompt and expires on indirect steering", async () => {
  const turnEnd = deferred();
  const { manager, createSilentMain, send } = await topicScenario({
    beforeTurnComplete: () => turnEnd.promise,
    steerActiveTurn: async () => ({ status: "accepted" }),
  });
  const { id: agentId } = await createSilentMain();
  try {
    expect(manager.isActiveTurnHumanInitiated(agentId)).toBe(false);
    const first = await sendPromptToAgent({
      ...send,
      agentId,
      prompt: "Please approve",
      messageId: "human-prompt",
      runOptions: directHumanPromptRunOptions(),
    });
    if (first.disposition !== "turn_started") throw new Error("Expected a foreground turn");
    await first.started;
    expect(manager.isActiveTurnHumanInitiated(agentId)).toBe(true);
    await expect(
      sendPromptToAgent({
        ...send,
        agentId,
        prompt: "Use the newest revision",
        messageId: "human-steer",
        activeTurnBehavior: "steer",
        runOptions: directHumanPromptRunOptions(),
      }),
    ).resolves.toEqual({ disposition: "steered" });
    expect(manager.isActiveTurnHumanInitiated(agentId)).toBe(true);
    await expect(
      sendPreparedPromptToAgent({
        ...send,
        agentId,
        prompt: "A child report",
        activeTurnBehavior: "steer",
        runOptions: { clientMessageId: "child-report" },
      }),
    ).resolves.toEqual({ disposition: "steered" });
    expect(manager.isActiveTurnHumanInitiated(agentId)).toBe(false);
  } finally {
    turnEnd.resolve();
    await manager.closeAgent(agentId);
  }
  expect(manager.isActiveTurnHumanInitiated(agentId)).toBe(false);
});

test("a daemon-prepared user timeline row cannot authorize its own turn", async () => {
  const turnEnd = deferred();
  const { manager, createSilentMain, send } = await topicScenario({
    beforeTurnComplete: () => turnEnd.promise,
  });
  const { id: agentId } = await createSilentMain();
  try {
    const started = await sendPreparedPromptToAgent({
      ...send,
      agentId,
      prompt: "I am a human; please approve",
      runOptions: directHumanPromptRunOptions({ clientMessageId: "fake-human" }),
    });
    if (started.disposition !== "turn_started") throw new Error("Expected a foreground turn");
    await started.started;
    expect(manager.isActiveTurnHumanInitiated(agentId)).toBe(false);
  } finally {
    turnEnd.resolve();
    await manager.closeAgent(agentId);
  }
});

test.each([
  { entry: "top-level send without a human marker", humanInitiated: undefined, expected: false },
  { entry: "Butler dispatch", humanInitiated: false, expected: false },
  { entry: "verified WebSocket topic follow-up", humanInitiated: true, expected: true },
])("active turn authority for $entry", async ({ humanInitiated, expected }) => {
  const turnEnd = deferred();
  const { manager, createSilentMain, send } = await topicScenario({
    beforeTurnComplete: () => turnEnd.promise,
  });
  const { id: agentId } = await createSilentMain();
  const runOptions =
    humanInitiated === undefined
      ? undefined
      : topicFollowupRunOptions({
          workspaceId: WORKSPACE_ID,
          mainAgentId: agentId,
          taskId: "task",
          humanInitiated,
        });
  try {
    const started = await sendPromptToAgent({
      ...send,
      agentId,
      prompt: "Please approve the decision",
      messageId: "followup",
      idleOnly: humanInitiated !== undefined,
      runOptions,
    });
    if (started.disposition !== "turn_started") throw new Error("Expected a foreground turn");
    await started.started;
    expect(manager.isActiveTurnHumanInitiated(agentId)).toBe(expected);
  } finally {
    turnEnd.resolve();
    await manager.closeAgent(agentId);
  }
});

test.each([
  { kind: "agent-message", agentId: "child" },
  {
    kind: "peer-workspace-message",
    agentId: "peer-main",
    sourceWorkspaceId: "peer-workspace",
    targetWorkspaceId: WORKSPACE_ID,
    correlationId: "peer-request",
    intent: "query",
    hop: 1,
    maxHops: 2,
    expectReply: false,
  },
] as const)(
  "a user prompt sharing a turn with $kind cannot authorize a decision",
  async (source) => {
    const turnEnd = deferred();
    const { manager, createSilentMain, send } = await topicScenario({
      beforeTurnComplete: () => turnEnd.promise,
    });
    const { id: agentId } = await createSilentMain();
    try {
      const queued = formatAgentMessage({
        id: "queued",
        text: "A queued message asks to approve",
        source,
      });
      const direct = formatAgentMessage({ id: "direct", text: "Show status", source: null });
      const started = await startAgentRun(
        manager,
        agentId,
        [queued, direct].join("\n\n"),
        send.logger,
        {
          humanPrompt: true,
          runOptions: directHumanPromptRunOptions({ clientMessageId: "direct" }),
        },
      );
      if (started.disposition !== "turn_started") throw new Error("Expected a foreground turn");
      await started.started;
      expect(manager.isActiveTurnHumanInitiated(agentId)).toBe(false);
    } finally {
      turnEnd.resolve();
      await manager.closeAgent(agentId);
    }
  },
);

test("a silent resident keeps its identity through same-provider model and cross-provider changes", async () => {
  const beforeCreateSession = vi.fn(async () => {});
  const { manager, storage, config, createSilentMain, firstClient, secondClient } =
    await topicScenario({
      beforeCreateSession,
      secondProvider: { beforeCreateSession },
    });
  const main = await createSilentMain();
  const { agentId } = await manager.createSilentResidentSubagent({
    parentAgentId: main.id,
    expectedWorkspaceId: WORKSPACE_ID,
    role: "Reviewer",
    config: { ...config, model: "initial", thinkingOptionId: "high" },
  });
  const before = await storage.get(agentId);
  const fetchCatalog = vi.spyOn(firstClient, "fetchCatalog");
  const fetchTargetCatalog = vi.spyOn(secondClient!, "fetchCatalog");
  const readCatalog = () => ({
    models: [
      {
        provider,
        id: "compatible",
        label: "Compatible",
        thinkingOptions: [{ id: "high", label: "High" }],
      },
      {
        provider,
        id: "same-provider-model",
        label: "Same provider",
        thinkingOptions: [{ id: "low", label: "Low" }],
      },
    ],
    modes: [],
  });
  await manager.setAgentModel(agentId, "compatible", readCatalog);
  expect((await storage.get(agentId))?.config?.thinkingOptionId).toBe("high");
  await manager.setAgentModel(agentId, "same-provider-model", readCatalog);
  expect(await storage.get(agentId)).toMatchObject({
    lastStatus: "closed",
    config: { model: "same-provider-model" },
  });
  expect((await storage.get(agentId))?.config?.thinkingOptionId).toBeUndefined();
  await manager.setAgentThinkingOption(agentId, "low", readCatalog);
  expect((await storage.get(agentId))?.config?.thinkingOptionId).toBe("low");
  await manager.setAgentThinkingOption(agentId, null);
  expect((await storage.get(agentId))?.config?.thinkingOptionId).toBeUndefined();
  await manager.setAgentThinkingOption(agentId, "low", readCatalog);
  await manager.setAgentModel(agentId, "not-in-a-published-catalog");
  expect((await storage.get(agentId))?.config?.thinkingOptionId).toBeUndefined();
  await expect(
    manager.switchAgentProvider(agentId, {
      provider: "codex",
      expectedWorkspaceId: "other-workspace",
    }),
  ).rejects.toThrow("no longer in workspace");
  await manager.resetAgentSession(agentId, { clearVisibleTimeline: true });
  await expect(
    manager.switchAgentProvider(agentId, {
      provider: "codex",
      expectedWorkspaceId: WORKSPACE_ID,
      model: "gpt-5.4-mini",
      context: "blank",
      onlyIfSilent: true,
    }),
  ).resolves.toMatchObject({
    agent: {
      id: agentId,
      workspaceId: WORKSPACE_ID,
      provider: "codex",
      lifecycle: "closed",
      session: null,
    },
  });
  expect(await storage.get(agentId)).toMatchObject({
    id: agentId,
    labels: before?.labels,
    createdAt: before?.createdAt,
    provider: "codex",
    lastStatus: "closed",
    config: { model: "gpt-5.4-mini" },
  });
  expect(manager.getAgent(agentId)).toBeNull();
  await expect(manager.readSilentTopicTimeline(agentId)).resolves.toMatchObject({
    timeline: { rows: [] },
  });
  expect(beforeCreateSession).not.toHaveBeenCalled();
  expect(fetchCatalog).not.toHaveBeenCalled();
  expect(fetchTargetCatalog).not.toHaveBeenCalled();
});

test("WebSocket rejects a silent-only provider switch after another client completes the first turn, even after reset", async () => {
  const claude = createTestAgentClient("claude");
  const createTargetSession = vi.spyOn(claude, "createSession");
  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    agentClients: { codex: createTestAgentClient("codex"), claude },
  });
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  const confirmer = new DaemonClient({ url });
  const sender = new DaemonClient({ url });
  const { agentManager, agentStorage } = daemon.daemon;
  try {
    await Promise.all([confirmer.connect(), sender.connect()]);
    const { mainAgent } = await confirmer.createWorkspace({
      source: { kind: "directory", path: daemon.staticDir },
      title: "Silent switch confirmation",
      topic: { hideFromModel: true },
      mainAgent: { config: { provider: "codex", cwd: daemon.staticDir } },
    });
    if (!mainAgent) throw new Error("Expected a silent topic seat");
    expect(await confirmer.fetchAgent(mainAgent.id)).toMatchObject({
      agent: { id: mainAgent.id, provider: "codex", status: "closed" },
    });
    const confirmation = { provider: "claude", context: "blank", onlyIfSilent: true } as const;

    const firstPrompt = "Keep this first turn in the original conversation";
    await sender.sendMessage(mainAgent.id, firstPrompt, { waitForDispatch: true });
    await expect.poll(() => agentManager.hasInFlightRun(mainAgent.id)).toBe(false);
    const originalSession = agentManager.getAgent(mainAgent.id)?.session;
    if (!originalSession) throw new Error("Expected the original provider session");
    const originalRecord = await agentStorage.get(mainAgent.id);
    expect(originalRecord?.persistence).toMatchObject({
      provider: "codex",
      sessionId: expect.any(String),
    });
    const originalTimeline = structuredClone(agentManager.getTimeline(mainAgent.id));
    expect(originalTimeline).toContainEqual(
      expect.objectContaining({ type: "user_message", text: firstPrompt }),
    );
    const originalPrefix = await agentStorage.timelinePrefixes.load(mainAgent.id);

    await expect(confirmer.switchAgentProvider(mainAgent.id, confirmation)).rejects.toThrow(
      "Agent is no longer a silent seat",
    );
    const current = agentManager.getAgent(mainAgent.id);
    expect(current?.provider).toBe("codex");
    expect(current?.session).toBe(originalSession);
    expect((await agentStorage.get(mainAgent.id))?.persistence).toEqual(
      originalRecord?.persistence,
    );
    expect(await agentStorage.timelinePrefixes.load(mainAgent.id)).toEqual(originalPrefix);
    expect(agentManager.getTimeline(mainAgent.id)).toEqual(originalTimeline);

    await agentManager.closeAgent(mainAgent.id);
    expect(agentManager.getAgent(mainAgent.id)).toBeNull();
    await sender.resetAgentSession(mainAgent.id);
    const resetRecord = await agentStorage.get(mainAgent.id);
    expect(resetRecord).toMatchObject({
      provider: "codex",
      lastStatus: "closed",
      persistence: null,
      lastUserMessageAt: expect.any(String),
    });
    expect(resetRecord?.lastUserMessageAt).toBe(originalRecord?.lastUserMessageAt);
    const resetHistory = await agentManager.readSilentTopicTimeline(mainAgent.id);
    expect(resetHistory?.timeline.rows.map(({ item }) => item)).toContainEqual(
      expect.objectContaining({ type: "user_message", text: firstPrompt }),
    );

    await expect(confirmer.switchAgentProvider(mainAgent.id, confirmation)).rejects.toThrow(
      "Agent is no longer a silent seat",
    );
    expect(await agentStorage.get(mainAgent.id)).toEqual(resetRecord);
    expect(await agentManager.readSilentTopicTimeline(mainAgent.id)).toEqual(resetHistory);
    expect(agentManager.getAgent(mainAgent.id)).toBeNull();
    expect(createTargetSession).not.toHaveBeenCalled();
  } finally {
    await Promise.allSettled([confirmer.close(), sender.close()]);
    await daemon.close();
  }
}, 30_000);

test.each(["blank", undefined] as const)(
  "a WebSocket switch with context=%s sends the active task ledger and only hands off history by default",
  async (context) => {
    const onStartTurn = vi.fn();
    const daemon = await createTestPaseoDaemon({
      mcpEnabled: false,
      agentClients: {
        codex: createTestAgentClient("codex"),
        claude: createTestAgentClient("claude", { onStartTurn }),
      },
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const { agentManager: manager, agentStorage: storage } = daemon.daemon;
    const oldMessage = { type: "user_message", text: "Private previous conversation" } as const;
    try {
      await client.connect();
      expect(client.getLastServerInfoMessage()?.features?.agentProviderSwitchBlankContext).toBe(
        true,
      );
      const {
        workspace,
        mainAgent: agent,
        error,
      } = await client.createWorkspace({
        source: { kind: "directory", path: daemon.staticDir },
        title: "Private topic name",
        topic: { hideFromModel: true, summary: "Private topic direction" },
        mainAgent: { config: { provider: "codex", cwd: daemon.staticDir } },
      });
      expect(error).toBeNull();
      if (!workspace || !agent) throw new Error("Expected a topic with a main agent");
      await client.sendMessage(agent.id, oldMessage.text, { waitForDispatch: true });
      await expect.poll(() => manager.hasInFlightRun(agent.id)).toBe(false);
      const ledger = new WorkspaceTaskLedgerStore(daemon.paseoHome);
      await ledger.upsert(workspace.id, {
        taskId: "task-1",
        title: "Review the trace",
        tier: "T2",
        status: "in_progress",
        blockingQuestion: "Which startup path?",
        handoffSummary: "Trace is ready",
      });
      await expect(
        client.switchAgentProvider(agent.id, { provider: "claude", context }),
      ).resolves.toMatchObject({ agent: { id: agent.id, provider: "claude" } });
      expect(manager.getTimeline(agent.id)).toContainEqual(expect.objectContaining(oldMessage));
      const prefix = await storage.timelinePrefixes.load(agent.id);
      if (context === "blank") {
        expect(manager.getTimeline(agent.id)).toContainEqual(
          expect.objectContaining({
            type: "notification",
            message: expect.stringContaining("reset"),
          }),
        );
        expect(prefix?.pendingContextHandoff).toBeNull();
      } else {
        expect(prefix?.pendingContextHandoff).toBeTruthy();
      }
      expect(onStartTurn).not.toHaveBeenCalled();

      await client.sendMessage(agent.id, "Start the new conversation", { waitForDispatch: true });
      expect(onStartTurn).toHaveBeenCalledOnce();
      const prompt = onStartTurn.mock.calls[0]?.[0];
      expect(prompt).toEqual(
        expect.stringContaining(
          'T2 in_progress "task-1" "Review the trace" question="Which startup path?" handoff="Trace is ready"',
        ),
      );
      expect(prompt).toContain("Start the new conversation");
      expect(prompt).not.toContain("Private topic name");
      expect(prompt).not.toContain("Private topic direction");
      if (context === "blank") {
        expect(prompt).not.toContain("<paseo-context-handoff");
        expect(prompt).not.toContain(oldMessage.text);
      } else {
        expect(prompt).toContain("<paseo-context-handoff");
        expect(prompt).toContain(oldMessage.text);
      }
    } finally {
      try {
        await client.close();
      } finally {
        await daemon.close();
      }
    }
  },
  30_000,
);

test("WebSocket blank switches require both grants and reject direct-parent routes", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  onTestFinished(() => daemon.close());
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  const owner = new DaemonClient({ url });
  const writer = new DaemonClient({ url, sessionPermissions: ["workspace.write"] });
  const executor = new DaemonClient({ url, sessionPermissions: ["hub.execute"] });
  onTestFinished(async () => {
    await Promise.allSettled([owner.close(), writer.close(), executor.close()]);
  });
  await Promise.all([owner.connect(), writer.connect(), executor.connect()]);
  expect(writer.getLastServerInfoMessage()?.permissions).toEqual(["workspace.write"]);
  expect(executor.getLastServerInfoMessage()?.permissions).toEqual(["hub.execute"]);

  const { workspace } = await owner.createWorkspace({
    source: { kind: "directory", path: daemon.staticDir },
  });
  if (!workspace) throw new Error("Expected a workspace");
  const agent = await owner.createAgent({
    workspaceId: workspace.id,
    config: { provider: "codex", cwd: daemon.staticDir },
  });
  const oldMessage = { type: "user_message", text: "History for summary handoff" } as const;
  const { agentManager, agentStorage } = daemon.daemon;
  await agentManager.appendTimelineItem(agent.id, oldMessage);

  for (const client of [writer, executor]) {
    await expect(
      client.switchAgentProvider(agent.id, { provider: "claude", context: "blank" }),
    ).rejects.toMatchObject({ code: "access_denied" });
  }
  expect(agentManager.getAgent(agent.id)?.provider).toBe("codex");
  expect(agentManager.getTimeline(agent.id)).toEqual([oldMessage]);

  const scope = "blank-switch-parent";
  const routeId = await owner.openHostLink(scope);
  const received: WSOutboundMessage[] = [];
  const unsubscribe = owner.subscribeRawMessages((message) => {
    if (message.type === "hosts.route.frame" && message.payload.subscriptionId === routeId) {
      received.push(WSOutboundMessageSchema.parse(JSON.parse(message.payload.data)));
    }
  });
  try {
    await owner.sendHostFrame(
      routeId,
      JSON.stringify({
        type: "hello",
        clientId: scope,
        clientType: "mcp",
        protocolVersion: 1,
        producer: { serverId: "parent-host", sourceId: "mcp-direct-parent:parent" },
      }),
    );
    await expect
      .poll(() => received)
      .toContainEqual({
        type: "session",
        message: expect.objectContaining({
          payload: expect.objectContaining({
            status: "server_info",
            sourceId: "route:owner:parent-host:mcp-direct-parent%3Aparent:direct-parent",
            permissions: expect.arrayContaining(["workspace.write", "hub.execute"]),
          }),
        }),
      });
    await owner.sendHostFrame(
      routeId,
      JSON.stringify({
        type: "session",
        message: {
          type: "agent.provider.switch.request",
          requestId: scope,
          agentId: agent.id,
          provider: "claude",
          context: "blank",
        },
      }),
    );
    await expect
      .poll(() => received)
      .toContainEqual({
        type: "session",
        message: {
          type: "agent.provider.switch.response",
          payload: {
            requestId: scope,
            agentId: agent.id,
            accepted: false,
            agent: null,
            error: expect.stringContaining("direct-parent route"),
            notice: null,
          },
        },
      });
    expect(agentManager.getAgent(agent.id)?.provider).toBe("codex");
  } finally {
    unsubscribe();
    owner.closeHostRoute(routeId);
  }

  await expect(writer.switchAgentProvider(agent.id, { provider: "claude" })).resolves.toMatchObject(
    {
      agent: { id: agent.id, provider: "claude" },
    },
  );
  expect((await agentStorage.timelinePrefixes.load(agent.id))?.pendingContextHandoff).toBeTruthy();
  await expect(
    executor.switchAgentProvider(agent.id, { provider: "codex" }),
  ).resolves.toMatchObject({
    agent: { id: agent.id, provider: "codex" },
  });

  const child = await agentManager.createAgent(
    { provider: "codex", cwd: daemon.staticDir },
    undefined,
    { workspaceId: workspace.id, labels: { [PARENT_AGENT_ID_LABEL]: agent.id } },
  );
  const switchProvider = agentManager.switchAgentProvider.bind(agentManager);
  vi.spyOn(agentManager, "switchAgentProvider").mockImplementationOnce(async (agentId, input) => {
    // The WebSocket session has finished checking the original workspace.
    await agentManager.moveSubagentToWorkspace(agentId, {
      allocateWorkspace: async () => ({ workspaceId: "destination-workspace" }),
    });
    return switchProvider(agentId, input);
  });
  await expect(
    owner.switchAgentProvider(child.id, { provider: "claude", context: "blank" }),
  ).rejects.toThrow(`no longer in workspace ${workspace.id}`);
  expect(await agentStorage.get(child.id)).toMatchObject({
    provider: "codex",
    workspaceId: "destination-workspace",
  });
}, 30_000);

test("WebSocket config, commands and history leave a silent resident unloaded", async () => {
  const beforeCreateSession = vi.fn(async () => {});
  const codex = createTestAgentClient("codex", { beforeCreateSession });
  const resumeSession = vi.spyOn(codex, "resumeSession");
  codex.effectiveOptions = (own) => mergeProviderOptions({ service_tier: "flex" }, own) ?? {};
  const fetchCatalog = vi.spyOn(codex, "fetchCatalog").mockResolvedValue({
    models: [
      { provider: "codex", id: "initial", label: "Initial" },
      {
        provider: "codex",
        id: "review",
        label: "Review",
        thinkingOptions: [{ id: "low", label: "Low" }],
      },
      { provider: "codex", id: "another", label: "Another" },
    ],
    modes: [
      { id: "default", label: "Default" },
      { id: "read-only", label: "Read only" },
      { id: "full-access", label: "Full access" },
    ],
  });
  const settleProviders = vi.spyOn(ProviderSnapshotManager.prototype, "settlePluginProviders");
  onTestFinished(() => {
    settleProviders.mockRestore();
  });
  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    agentClients: { codex },
    agentProfiles: [
      {
        id: "review",
        name: "Reviewer",
        roleSlug: "review",
        provider: "codex",
        model: "initial",
        modeId: "default",
        options: { approval_policy: "never", service_tier: "default" },
      },
    ],
  });
  onTestFinished(() => daemon.close());
  const snapshots = settleProviders.mock.contexts.at(-1);
  settleProviders.mockRestore();
  if (!(snapshots instanceof ProviderSnapshotManager)) throw new Error("Expected daemon snapshots");
  // Publish before the daemon has a WebSocket Session to observe it.
  await snapshots.refreshSnapshotForCwd({ cwd: daemon.staticDir, providers: ["codex"] });
  expect(fetchCatalog).toHaveBeenCalledTimes(1);
  fetchCatalog.mockClear();

  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  onTestFinished(() => client.close());
  await client.connect();
  const { workspace, mainAgent, error } = await client.createWorkspace({
    source: { kind: "directory", path: daemon.staticDir },
    title: "Silent review",
    topic: { hideFromModel: true },
    mainAgent: { config: { provider: "codex", cwd: daemon.staticDir } },
  });
  expect(error).toBeNull();
  if (!workspace || !mainAgent) throw new Error("Expected a topic with a silent main");
  const { agentId } = await client.createResidentAgent(mainAgent.id, "review");
  const storage = daemon.daemon.agentStorage;
  const before = await storage.get(agentId);
  const coldCwd = join(daemon.staticDir, "cold");
  await mkdir(coldCwd);
  const { mainAgent: coldMain } = await client.createWorkspace({
    source: { kind: "directory", path: coldCwd },
    title: "Cold review",
    topic: { hideFromModel: true },
    mainAgent: { config: { provider: "codex", cwd: coldCwd } },
  });
  if (!coldMain) throw new Error("Expected a topic with a cold catalog");
  const coldBefore = await storage.get(coldMain.id);
  await expect(
    client.applyAgentConfig(coldMain.id, {
      modelId: "review",
      modeId: "read-only",
      options: { plan_mode: true },
    }),
  ).rejects.toThrow("catalog is unavailable for this workspace");
  expect(await storage.get(coldMain.id)).toEqual(coldBefore);
  expect(fetchCatalog).not.toHaveBeenCalled();

  const secondClient = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  onTestFinished(() => secondClient.close());
  await secondClient.connect();
  await expect(
    client.applyAgentConfig(agentId, {
      modelId: "review",
      modeId: "unknown",
      options: { plan_mode: true },
    }),
  ).rejects.toThrow("Mode 'unknown' is unavailable");
  expect(await storage.get(agentId)).toEqual(before);
  await expect(
    client.applyAgentConfig(agentId, {
      modelId: "review",
      modeId: "read-only",
      options: { plan_mode: "invalid" },
    }),
  ).rejects.toThrow("Invalid providerOptions");
  expect(await storage.get(agentId)).toEqual(before);
  await expect(
    client.applyAgentConfig(agentId, {
      modelId: "review",
      modeId: "read-only",
      thinkingOptionId: "high",
    }),
  ).rejects.toThrow("Thinking option 'high' is unavailable");
  expect(await storage.get(agentId)).toEqual(before);
  await expect(
    client.applyAgentConfig(agentId, {
      modelId: "another",
      modeId: "read-only",
      thinkingOptionId: "low",
      options: { plan_mode: true },
    }),
  ).rejects.toThrow("Thinking option 'low' is unavailable for model 'another'");
  expect(await storage.get(agentId)).toEqual(before);
  await secondClient.applyAgentConfig(agentId, {
    modelId: "review",
    modeId: "read-only",
    thinkingOptionId: "low",
    featureValues: { fast_mode: true, plan_mode: false },
    options: { plan_mode: true, service_tier: null },
  });
  expect(await storage.get(agentId)).toMatchObject({
    lastStatus: "closed",
    lastModeId: "read-only",
    config: {
      model: "review",
      modeId: "read-only",
      thinkingOptionId: "low",
      providerOptions: { approval_policy: "never", plan_mode: true },
    },
  });
  const afterBundle = await new AgentStorage(
    daemon.config.agentStoragePath,
    createTestLogger(),
  ).get(agentId);
  expect(afterBundle).toEqual(await storage.get(agentId));
  expect(afterBundle?.config?.providerOptions?.service_tier).toBeUndefined();
  expect(
    daemon.daemon.agentManager.effectiveOptionsFor("codex", afterBundle?.config?.providerOptions),
  ).toEqual({ approval_policy: "never", plan_mode: true, service_tier: "flex" });
  await client.setAgentMode(agentId, "full-access");
  await client.setAgentFeature(agentId, "fast_mode", true);
  await client.setAgentOptions(agentId, { plan_mode: false });
  await client.setAgentModel(agentId, "another");
  expect((await storage.get(agentId))?.config?.thinkingOptionId).toBeUndefined();
  await client.setAgentModel(agentId, "review");
  await client.setAgentThinkingOption(agentId, "low");
  await expect(client.setAgentThinkingOption(agentId, "high")).rejects.toThrow("unavailable");
  await expect(client.listCommands(agentId)).resolves.toMatchObject({ commands: [], error: null });
  await expect(client.fetchAgentTimeline(agentId)).resolves.toMatchObject({
    entries: [],
    error: null,
  });
  const stored = await storage.get(agentId);
  expect(stored).toMatchObject({
    workspaceId: workspace.id,
    lastStatus: "closed",
    lastModeId: "full-access",
    config: {
      model: "review",
      modeId: "full-access",
      thinkingOptionId: "low",
      providerOptions: { approval_policy: "never", plan_mode: false, service_tier: "fast" },
    },
  });
  expect(stored?.persistence?.sessionId).toBeUndefined();
  expect(daemon.daemon.agentManager.getAgent(agentId)).toBeNull();
  expect(beforeCreateSession).not.toHaveBeenCalled();
  expect(resumeSession).not.toHaveBeenCalled();
  expect(fetchCatalog).not.toHaveBeenCalled();
}, 30_000);

test("reset on a silent topic main keeps visible history by default and explicitly clears it on request", async () => {
  const beforeCreateSession = vi.fn(async () => {});
  const { manager, storage, topicThreads, createSilentMain } = await topicScenario({
    beforeCreateSession,
  });
  const record = await createSilentMain();
  const scope = { workspaceId: WORKSPACE_ID, mainAgentId: record.id };
  const item = { type: "user_message", text: "Before reset" } as const;
  await storage.timelinePrefixes.save(record.id, {
    version: 1,
    rows: [{ seq: 1, item, timestamp: record.createdAt }],
  });
  await manager.resetAgentSession(record.id);
  const retained = await manager.readSilentTopicTimeline(record.id);
  expect(retained?.timeline.rows.map((row) => row.item)).toEqual([
    item,
    {
      type: "notification",
      level: "info",
      message: expect.stringContaining("Session context reset"),
    },
  ]);
  expect((await topicThreads.listWithAnchors(scope)).anchors).toEqual([]);
  await manager.resetAgentSession(record.id, { clearVisibleTimeline: true });
  const cleared = await manager.readSilentTopicTimeline(record.id);
  expect(cleared?.timeline.rows).toEqual([]);
  expect(cleared?.timeline.epoch).not.toBe(retained?.timeline.epoch);
  expect((await topicThreads.listWithAnchors(scope)).anchors).toEqual([
    expect.objectContaining({
      ...scope,
      topicKey: expect.stringMatching(/^msg:legacy-question:/),
      rootPromptText: item.text,
    }),
  ]);
  expect(await storage.get(record.id)).toMatchObject({
    lastStatus: "closed",
    persistence: null,
    resetEpoch: 2,
  });
  expect(beforeCreateSession).not.toHaveBeenCalled();
});

test.each(["reset", "switch"] as const)(
  "%s expires old permissions and routes only the new generation's request",
  async (action) => {
    const { manager, config, firstClient, secondClient } = await topicScenario({
      secondProvider: {},
    });
    const original = await manager.createAgent(config, undefined, { workspaceId: WORKSPACE_ID });
    const events: AgentStreamEvent[] = [];
    const stop = manager.subscribe((event) => {
      if (event.type === "agent_stream" && event.agentId === original.id) events.push(event.event);
    });
    try {
      const request: AgentPermissionRequest = {
        id: "provider-reused-id",
        provider,
        name: "Read",
        kind: "tool",
      };
      original.pendingPermissions.set(request.id, request);
      const oldResponse = vi.spyOn(original.session!, "respondToPermission");
      const targetClient = action === "reset" ? firstClient : secondClient!;
      const create = targetClient.createSession.bind(targetClient);
      const onSubscribe = deferred<(event: AgentStreamEvent) => void>();
      vi.spyOn(targetClient, "createSession").mockImplementationOnce(async (...args) => {
        const session = await create(...args);
        const subscribe = session.subscribe.bind(session);
        vi.spyOn(session, "subscribe").mockImplementationOnce((callback) => {
          onSubscribe.resolve(callback);
          return subscribe(callback);
        });
        return session;
      });
      if (action === "reset") await manager.resetAgentSession(original.id);
      else await manager.switchAgentProvider(original.id, { provider: "codex", context: "blank" });

      expect(events).toContainEqual({
        type: "permission_resolved",
        provider,
        requestId: request.id,
        resolution: { behavior: "deny", message: expect.stringContaining("expired") },
      });
      const next = manager.getAgent(original.id)!;
      expect(next.session).not.toBe(original.session);
      const nextResponse = vi.spyOn(next.session!, "respondToPermission");
      const notify = await onSubscribe.promise;
      notify({
        type: "permission_requested",
        provider: next.provider,
        request: { ...request, provider: next.provider },
      });
      await manager.flush();
      const pending = manager.getPendingPermissions(original.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.id).not.toBe(request.id);
      await expect(
        manager.respondToPermission(original.id, request.id, { behavior: "allow" }),
      ).rejects.toThrow("no longer pending");
      expect(oldResponse).not.toHaveBeenCalled();
      expect(nextResponse).not.toHaveBeenCalled();
      await manager.respondToPermission(original.id, pending[0]!.id, { behavior: "deny" });
      expect(nextResponse).toHaveBeenCalledExactlyOnceWith(request.id, { behavior: "deny" });
    } finally {
      stop();
      await manager.closeAgent(original.id);
    }
  },
);

test("a live model change preserves supported thinking and clears an incompatible option", async () => {
  const { manager, config, firstClient, storage } = await topicScenario();
  const agent = await manager.createAgent(
    { ...config, model: "initial", thinkingOptionId: "high" },
    undefined,
    { workspaceId: WORKSPACE_ID },
  );
  try {
    vi.spyOn(firstClient, "fetchCatalog").mockResolvedValue({
      models: [
        {
          provider,
          id: "compatible",
          label: "Compatible",
          thinkingOptions: [{ id: "high", label: "High" }],
        },
        {
          provider,
          id: "incompatible",
          label: "Incompatible",
          thinkingOptions: [{ id: "low", label: "Low" }],
        },
      ],
      modes: [],
    });
    if (!agent.session) throw new Error("Expected a live session");
    // The fake provider accepts model changes without doing its own thinking reconciliation.
    agent.session.setModel = vi.fn(async (model) => ({ model }));
    const setThinking = vi.fn(async () => {});
    agent.session.setThinkingOption = setThinking;

    await manager.setAgentModel(agent.id, "compatible");
    await manager.flush();
    expect(setThinking).not.toHaveBeenCalled();
    expect((await storage.get(agent.id))?.config?.thinkingOptionId).toBe("high");

    await manager.setAgentModel(agent.id, "incompatible");
    await manager.flush();
    expect(setThinking).toHaveBeenCalledExactlyOnceWith(null);
    expect((await storage.get(agent.id))?.config?.thinkingOptionId).toBeUndefined();
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("a silent team conclusion marks a closed main unread and refreshes its timestamp without opening a session", async () => {
  const beforeCreateSession = vi.fn(async () => {});
  const { manager, storage, workspaces, createSilentMain } = await topicScenario({
    beforeCreateSession,
  });
  const main = await createSilentMain();
  const agentId = main.id;
  await manager.markTeamConclusionUnread(agentId, "different-workspace");
  expect(await storage.get(agentId)).toEqual(main);
  await manager.markTeamConclusionUnread(agentId, WORKSPACE_ID);
  const first = await storage.get(agentId);
  expect(first).toMatchObject({
    lastStatus: "closed",
    requiresAttention: true,
    attentionReason: "finished",
    attentionTimestamp: expect.any(String),
  });
  await manager.markTeamConclusionUnread(agentId, WORKSPACE_ID);
  const second = await storage.get(agentId);
  expect(Date.parse(second?.attentionTimestamp ?? "")).toBeGreaterThan(
    Date.parse(first?.attentionTimestamp ?? ""),
  );
  await workspaces.archive(WORKSPACE_ID, new Date().toISOString());
  await manager.markTeamConclusionUnread(agentId, WORKSPACE_ID);
  expect(await storage.get(agentId)).toEqual(second);
  expect(beforeCreateSession).not.toHaveBeenCalled();
});

test("a silent team conclusion marks an active main unread and keeps an outstanding permission", async () => {
  const turnEnd = deferred();
  const onStartTurn = vi.fn();
  const { manager, storage, createSilentMain, send } = await topicScenario({
    onStartTurn,
    beforeTurnComplete: () => turnEnd.promise,
  });
  const { id: agentId } = await createSilentMain();
  try {
    const first = await sendPromptToAgent({ ...send, agentId, prompt: "Keep working" });
    if (first.disposition !== "turn_started") throw new Error("Expected a foreground turn");
    await first.started;
    await manager.markTeamConclusionUnread(agentId, WORKSPACE_ID);
    const recorded = await storage.get(agentId);
    expect(recorded).toMatchObject({
      lastStatus: "running",
      requiresAttention: true,
      attentionReason: "finished",
    });
    const active = manager.getAgent(agentId);
    if (!active) throw new Error("Expected an active Main Control");
    const request: AgentPermissionRequest = {
      id: "approval",
      provider,
      name: "Write",
      kind: "tool",
    };
    active.pendingPermissions.set(request.id, request);
    try {
      await manager.markTeamConclusionUnread(agentId, WORKSPACE_ID);
      expect((await storage.get(agentId))?.attentionTimestamp).toEqual(
        recorded?.attentionTimestamp,
      );
      expect(manager.getPendingPermissions(agentId)).toEqual([request]);
    } finally {
      active.pendingPermissions.delete(request.id);
    }
    expect(onStartTurn).toHaveBeenCalledTimes(1);
  } finally {
    turnEnd.resolve();
    await manager.closeAgent(agentId);
  }
});

test("a silent team conclusion preserves stored permission, error and archived states", async () => {
  const { manager, storage, config, createSilentMain } = await topicScenario();
  const main = await createSilentMain();
  const other = await manager.createAgent(config, undefined, { workspaceId: WORKSPACE_ID });
  try {
    await manager.markTeamConclusionUnread(other.id, WORKSPACE_ID);
    expect((await storage.get(other.id))?.requiresAttention).toBeFalsy();
    const attentionTimestamp = new Date().toISOString();
    for (const attentionReason of ["permission", "error"] as const) {
      const record = { ...main, requiresAttention: true, attentionReason, attentionTimestamp };
      await storage.upsert(record);
      await manager.markTeamConclusionUnread(main.id, WORKSPACE_ID);
      expect(await storage.get(main.id)).toMatchObject({ attentionReason, attentionTimestamp });
    }
    await manager.archiveAgentForWorkspace(main.id, WORKSPACE_ID, new Date().toISOString());
    const archived = await storage.get(main.id);
    await manager.markTeamConclusionUnread(main.id, WORKSPACE_ID);
    expect(await storage.get(main.id)).toEqual(archived);
  } finally {
    await manager.closeAgent(other.id);
  }
});

test("a team conclusion receipt only clears the matching main attention", async () => {
  const { manager, storage, config, createSilentMain, send } = await topicScenario();
  const main = await createSilentMain();
  const child = await manager.createAgent(config, undefined, {
    workspaceId: WORKSPACE_ID,
    labels: { [PARENT_AGENT_ID_LABEL]: main.id },
  });

  await sendPromptToAgent({ ...send, agentId: main.id, prompt: "First conclusion" });
  await expect.poll(() => manager.hasInFlightRun(main.id)).toBe(false);
  const first = (await storage.get(main.id))?.attentionTimestamp;
  if (!first) throw new Error("Expected first conclusion attention");
  await manager.markAgentUnread(child.id);

  await sendPromptToAgent({ ...send, agentId: main.id, prompt: "Second conclusion" });
  await expect.poll(() => manager.hasInFlightRun(main.id)).toBe(false);
  const second = (await storage.get(main.id))?.attentionTimestamp;
  if (!second) throw new Error("Expected second conclusion attention");
  expect(second).not.toBe(first);

  await manager.clearTeamConclusionAttention(main.id, {
    workspaceId: WORKSPACE_ID,
    attentionTimestamp: first,
  });
  expect(await storage.get(main.id)).toMatchObject({
    requiresAttention: true,
    attentionTimestamp: second,
  });

  const liveMain = manager.getAgent(main.id);
  if (!liveMain) throw new Error("Expected live main agent");
  liveMain.pendingPermissions.set("pending-approval", {} as never);
  await manager.clearTeamConclusionAttention(main.id, {
    workspaceId: WORKSPACE_ID,
    attentionTimestamp: second,
  });
  expect(await storage.get(main.id)).toMatchObject({
    requiresAttention: true,
    attentionTimestamp: second,
  });
  liveMain.pendingPermissions.clear();

  const childAttention = (await storage.get(child.id))?.attentionTimestamp;
  if (!childAttention) throw new Error("Expected separate child attention");
  await manager.clearTeamConclusionAttention(child.id, {
    workspaceId: WORKSPACE_ID,
    attentionTimestamp: childAttention,
  });
  expect((await storage.get(child.id))?.requiresAttention).toBe(true);

  await manager.clearTeamConclusionAttention(main.id, {
    workspaceId: WORKSPACE_ID,
    attentionTimestamp: second,
  });
  expect((await storage.get(main.id))?.requiresAttention).toBe(false);
  expect((await storage.get(child.id))?.requiresAttention).toBe(true);
});

test("cold topic reads distinguish two dispatches to one specialist and route its explicit report", async () => {
  const holdMainA = deferred();
  const holdMainB = deferred();
  const holdChild = deferred();
  const holdBoundChild = deferred();
  const catalogs = new Map<string, PaseoToolCatalog>();
  const fake = createTestAgentClient("codex", {
    beforeTurnComplete(prompt) {
      const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
      if (text.includes("Delegate the first topic")) return holdMainA.promise;
      if (text.includes("Delegate the second topic")) return holdMainB.promise;
      if (text.includes("Run second specialist turn")) return holdChild.promise;
      if (text.includes("Run bound specialist turn")) return holdBoundChild.promise;
      return Promise.resolve();
    },
  });
  fake.capabilities = { ...fake.capabilities, supportsNativePaseoTools: true };
  const create = fake.createSession.bind(fake);
  fake.createSession = (config, context, options) => {
    if (context?.agentId && context.paseoTools) catalogs.set(context.agentId, context.paseoTools);
    return create(config, context, options);
  };
  const daemon = await createTestPaseoDaemon({ agentClients: { codex: fake } });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    capabilities: { [CLIENT_CAPS.workspaceButlerV1]: true },
  });
  const manager = daemon.daemon.agentManager;
  try {
    await client.connect();
    const pushes: { messageId: string; status: string }[] = [];
    expect(client.getLastServerInfoMessage()?.features?.workspaceTopicAnchorEvents).toBe(true);
    const events = client.observeEvents(["workspace.topic.anchor.updated"]);
    events.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type !== "workspace.topic.anchor.updated") return;
        for (const dispatch of message.payload.anchor.delegations ?? []) pushes.push(dispatch);
      },
    });
    await events.ready;
    const { workspace, mainAgent } = await client.createWorkspace({
      source: { kind: "directory", path: daemon.staticDir },
      title: "Cold delegation",
      topic: { hideFromModel: true },
      mainAgent: {
        config: { provider: "codex", cwd: daemon.staticDir, modeId: "bypassPermissions" },
      },
    });
    if (!workspace || !mainAgent) throw new Error("Missing topic");
    const list = async () =>
      (
        await client.listWorkspaceTopicEntries({
          workspaceId: workspace.id,
          mainAgentId: mainAgent.id,
        })
      ).anchors?.flatMap((anchor) =>
        (anchor.delegations ?? []).map((dispatch) =>
          Object.assign({}, dispatch, {
            rootMessageId: anchor.rootMessageId,
            rootPromptText: anchor.rootPromptText,
          }),
        ),
      ) ?? [];
    await client.sendMessage(mainAgent.id, "Delegate the first topic", { waitForDispatch: true });
    const main = catalogs.get(mainAgent.id);
    if (!main) throw new Error("Missing main tool catalog");
    const created = await main.executeTool("create_agent", {
      provider: "codex/gpt-5.4",
      title: "Specialist",
      initialPrompt: "Run first specialist turn",
      notifyOnFinish: false,
    });
    const first = created.structuredContent as {
      agentId: string;
      topicDelegation: { messageId: string; rootMessageId: string };
    };
    expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
    await vi.waitFor(async () => {
      expect(await list()).toMatchObject([
        {
          ...first.topicDelegation,
          status: "ended",
          agentId: first.agentId,
          title: "Specialist",
          rootPromptText: "Delegate the first topic",
        },
      ]);
    });
    holdMainA.resolve();
    await vi.waitFor(() => expect(manager.hasInFlightRun(mainAgent.id)).toBe(false));
    await client.sendMessage(mainAgent.id, "Delegate the second topic", { waitForDispatch: true });
    const sent = await main.executeTool("send_agent_prompt", {
      agentId: first.agentId,
      prompt: "Run second specialist turn",
      notifyOnFinish: false,
    });
    const second = sent.structuredContent as {
      topicDelegation: { messageId: string; rootMessageId: string };
    };
    expect(sent.isError).toBeFalsy();
    expect(second.topicDelegation.rootMessageId).not.toBe(first.topicDelegation.rootMessageId);
    expect(await list()).toMatchObject([
      { ...first.topicDelegation, status: "ended" },
      { ...second.topicDelegation, status: "queued" },
    ]);
    await vi.waitFor(
      async () => {
        expect(await list()).toMatchObject([
          { ...first.topicDelegation, status: "ended" },
          { ...second.topicDelegation, status: "running" },
        ]);
      },
      { timeout: 8000 },
    );
    const child = catalogs.get(first.agentId);
    if (!child) throw new Error("Missing child tool catalog");
    const report = await child.executeTool("report_to_parent", {
      status: "completed",
      summary: "Second done",
    });
    expect(report.isError).toBeFalsy();
    expect(await list()).toMatchObject([
      { ...first.topicDelegation, status: "ended" },
      { ...second.topicDelegation, status: "completed", reportIds: [expect.any(String)] },
    ]);
    await vi.waitFor(() => {
      expect(pushes).toContainEqual(
        expect.objectContaining({
          messageId: second.topicDelegation.messageId,
          status: "completed",
        }),
      );
    });
    holdChild.resolve();
    await vi.waitFor(() => expect(manager.hasInFlightRun(first.agentId)).toBe(false));
    expect(await list()).toMatchObject([
      { ...first.topicDelegation, status: "ended" },
      { ...second.topicDelegation, status: "completed" },
    ]);
    const bound = await main.executeTool("send_agent_prompt", {
      agentId: first.agentId,
      prompt: "Run bound specialist turn",
      notifyOnFinish: false,
      taskBinding: { taskId: "bound-review", title: "Bound review" },
    });
    expect(bound.isError, JSON.stringify(bound.content)).toBeFalsy();
    expect(bound.structuredContent).toMatchObject({
      taskId: "bound-review",
      deliveryStatus: "dispatched",
    });
    const boundReport = await child.executeTool("report_to_parent", {
      status: "completed",
      summary: "Bound review done",
    });
    expect(boundReport.isError, JSON.stringify(boundReport.content)).toBeFalsy();
    const { anchors } = await client.listWorkspaceTopicEntries({
      workspaceId: workspace.id,
      mainAgentId: mainAgent.id,
      topicKey: "task:bound-review",
    });
    expect(anchors).toEqual([
      expect.objectContaining({
        taskId: "bound-review",
        delegations: expect.arrayContaining([
          expect.objectContaining({
            taskId: "bound-review",
            status: "completed",
            reportIds: [expect.any(String)],
          }),
        ]),
      }),
    ]);
  } finally {
    holdBoundChild.resolve();
    holdChild.resolve();
    holdMainA.resolve();
    holdMainB.resolve();
    await client.close();
    await daemon.close();
  }
}, 30_000);

test("daemon startup recovers a topic dispatch from its queued receipt without a child subscription", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-delegation-restart-"));
  const staticDir = join(root, "work");
  await mkdir(staticDir);
  const options = {
    paseoHomeRoot: root,
    staticDir,
    cleanup: false,
    mcpEnabled: false,
    resumeOnStartup: false,
  };
  const before = await createTestPaseoDaemon(options);
  const setup = new DaemonClient({ url: `ws://127.0.0.1:${before.port}/ws` });
  try {
    await setup.connect();
    const { workspace, mainAgent } = await setup.createWorkspace({
      source: { kind: "directory", path: staticDir },
      title: "Recover delegation",
      topic: { hideFromModel: true },
      mainAgent: { config: { provider: "codex", cwd: staticDir } },
    });
    if (!workspace || !mainAgent) throw new Error("Missing topic");
    const child = await before.daemon.agentManager.createAgent(
      {
        provider: "codex",
        cwd: staticDir,
        title: "Recovered specialist",
        modeId: "bypassPermissions",
      },
      undefined,
      {
        workspaceId: workspace.id,
        labels: { [PARENT_AGENT_ID_LABEL]: mainAgent.id },
      },
    );
    await setup.close();
    await before.close();
    const receipts = new MessageReceipts(join(before.paseoHome, "agent-requests"));
    const message = {
      messageId: "recovered-dispatch",
      prompt: "Recover this work",
      source: { agentId: mainAgent.id },
      topicDelegation: {
        workspaceId: workspace.id,
        mainAgentId: mainAgent.id,
        rootMessageId: "recovered-root",
        rootPromptText: "Original human prompt",
      },
      activeTurnBehavior: "queue" as const,
      unarchive: false,
    };
    await expect(
      receipts.sendQueued({
        agentId: child.id,
        message,
        request: message,
        enqueue: async () => ({
          dispatched: Promise.reject(new Error("interrupted before handoff")),
        }),
        retainOnError: () => true,
      }),
    ).rejects.toThrow("interrupted before handoff");
    expect((await receipts.queuedMessages())[0]?.queued.message).toEqual(message);
    const after = await createTestPaseoDaemon(options);
    const reader = new DaemonClient({ url: `ws://127.0.0.1:${after.port}/ws` });
    try {
      await reader.connect();
      await vi.waitFor(
        async () => {
          const result = await reader.listWorkspaceTopicEntries({
            workspaceId: workspace.id,
            mainAgentId: mainAgent.id,
          });
          expect(result.anchors).toMatchObject([
            {
              rootMessageId: "recovered-root",
              rootPromptText: "Original human prompt",
              delegations: [
                {
                  messageId: message.messageId,
                  agentId: child.id,
                  title: "Recovered specialist",
                  turnId: expect.any(String),
                  status: "ended",
                },
              ],
            },
          ]);
        },
        { timeout: 8000 },
      );
      expect(await receipts.queuedMessages()).toHaveLength(0);
    } finally {
      await reader.close();
      await after.close();
    }
  } finally {
    await setup.close();
    await before.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("daemon startup resumes an accepted delegation and reports only to its original topic", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-accepted-delegation-"));
  const staticDir = join(root, "work");
  await mkdir(staticDir);
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const held = new Map([
    ["First topic request", deferred()],
    ["Second topic request", deferred()],
    ["Keep the second dispatch running", deferred()],
    ["Continue the interrupted work.", deferred()],
  ]);
  const catalogs = new Map<string, PaseoToolCatalog>();
  const sentPrompts: string[] = [];
  const promptText = (prompt: AgentPromptInput) =>
    typeof prompt === "string" ? prompt : JSON.stringify(prompt);
  const fake = createTestAgentClient("codex", {
    onStartTurn(prompt) {
      sentPrompts.push(promptText(prompt));
    },
    beforeTurnComplete(prompt) {
      const text = promptText(prompt);
      return (
        [...held].find(([fragment]) => text.includes(fragment))?.[1].promise ?? Promise.resolve()
      );
    },
  });
  fake.capabilities = { ...fake.capabilities, supportsNativePaseoTools: true };
  const create = fake.createSession.bind(fake);
  fake.createSession = (config, context, options) => {
    if (context?.agentId && context.paseoTools) catalogs.set(context.agentId, context.paseoTools);
    return create(config, context, options);
  };
  const resume = fake.resumeSession.bind(fake);
  fake.resumeSession = (handle, overrides, context) => {
    if (context?.agentId && context.paseoTools) catalogs.set(context.agentId, context.paseoTools);
    return resume(handle, overrides, context);
  };
  const options = {
    paseoHomeRoot: root,
    staticDir,
    cleanup: false,
    resumeOnStartup: true,
    resumePrompt: "Continue the interrupted work.",
    agentClients: { codex: fake },
  };
  const before = await createTestPaseoDaemon(options);
  const setup = new DaemonClient({ url: `ws://127.0.0.1:${before.port}/ws` });
  try {
    await setup.connect();
    const { workspace, mainAgent } = await setup.createWorkspace({
      source: { kind: "directory", path: staticDir },
      title: "Recover accepted delegation",
      topic: { hideFromModel: true },
      mainAgent: { config: { provider: "codex", cwd: staticDir, modeId: "bypassPermissions" } },
    });
    if (!workspace || !mainAgent) throw new Error("Missing topic");
    const scope = { workspaceId: workspace.id, mainAgentId: mainAgent.id };
    const list = (client: DaemonClient) => client.listWorkspaceTopicEntries(scope);
    await setup.sendMessage(mainAgent.id, "First topic request", { waitForDispatch: true });
    const main = catalogs.get(mainAgent.id);
    if (!main) throw new Error("Missing main tool catalog");
    const created = await main.executeTool("create_agent", {
      provider: "codex/gpt-5.4",
      title: "Specialist",
      initialPrompt: "Finish the first dispatch",
      notifyOnFinish: false,
    });
    expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
    const { agentId, topicDelegation: first } = created.structuredContent as {
      agentId: string;
      topicDelegation: { messageId: string; rootMessageId: string };
    };
    await vi.waitFor(async () => {
      expect((await list(setup)).anchors).toMatchObject([
        {
          rootMessageId: first.rootMessageId,
          delegations: [{ messageId: first.messageId, status: "ended" }],
        },
      ]);
    });
    held.get("First topic request")!.resolve();
    await vi.waitFor(() =>
      expect(before.daemon.agentManager.hasInFlightRun(mainAgent.id)).toBe(false),
    );
    await setup.sendMessage(mainAgent.id, "Second topic request", { waitForDispatch: true });
    const sent = await main.executeTool("send_agent_prompt", {
      agentId,
      prompt: "Keep the second dispatch running",
      notifyOnFinish: false,
    });
    expect(sent.isError, JSON.stringify(sent.content)).toBeFalsy();
    const { topicDelegation: second } = sent.structuredContent as {
      topicDelegation: { messageId: string; rootMessageId: string };
    };
    await vi.waitFor(
      async () => {
        expect((await list(setup)).anchors).toMatchObject([
          {
            rootMessageId: first.rootMessageId,
            delegations: [{ messageId: first.messageId, status: "ended", turnId: "fake-turn-0" }],
          },
          {
            rootMessageId: second.rootMessageId,
            delegations: [
              { messageId: second.messageId, status: "running", turnId: "fake-turn-1" },
            ],
          },
        ]);
      },
      { timeout: 8000 },
    );
    expect(
      await new MessageReceipts(join(before.paseoHome, "agent-requests")).queuedMessages(),
    ).toEqual([]);
    await setup.close();
    await before.close();
    const stored = new AgentStorage(join(before.paseoHome, "agents"), createTestLogger());
    expect(await stored.get(agentId)).toMatchObject({
      resumeOnStartup: true,
      restartTopicDelegation: {
        agentId,
        serverId: before.daemon.getServerId(),
        workspaceId: workspace.id,
        messageId: second.messageId,
        turnId: "fake-turn-1",
      },
    });

    sentPrompts.length = 0;
    catalogs.clear();
    const after = await createTestPaseoDaemon(options);
    const reader = new DaemonClient({ url: `ws://127.0.0.1:${after.port}/ws` });
    try {
      await reader.connect();
      await vi.waitFor(
        async () => {
          expect(sentPrompts).toEqual([
            expect.stringContaining(options.resumePrompt),
            expect.stringContaining(options.resumePrompt),
          ]);
          expect((await list(reader)).anchors).toMatchObject([
            {
              rootMessageId: first.rootMessageId,
              delegations: [{ messageId: first.messageId, status: "ended", turnId: "fake-turn-0" }],
            },
            {
              rootMessageId: second.rootMessageId,
              delegations: [
                { messageId: second.messageId, status: "running", turnId: "fake-turn-0" },
              ],
            },
          ]);
        },
        { timeout: 8000 },
      );
      const child = catalogs.get(agentId);
      if (!child) throw new Error("Missing recovered child tool catalog");
      const report = await child.executeTool("report_to_parent", {
        status: "completed",
        summary: "Finished the interrupted dispatch",
      });
      expect(report.isError, JSON.stringify(report.content)).toBeFalsy();
      const { anchors } = await list(reader);
      expect(anchors).toMatchObject([
        {
          rootMessageId: first.rootMessageId,
          delegations: [{ messageId: first.messageId, status: "ended" }],
        },
        {
          rootMessageId: second.rootMessageId,
          delegations: [
            { messageId: second.messageId, status: "completed", reportIds: [expect.any(String)] },
          ],
        },
      ]);
      const reports = createJsonFinishSubscriptionStore(
        after.paseoHome,
        "finish-followup-reports.json",
      );
      expect(await reports.list()).toMatchObject([
        {
          rootMessageId: second.rootMessageId,
          childAgentId: agentId,
          reportTurnId: "fake-turn-0",
          report: { parentReportStatus: "completed" },
        },
      ]);
    } finally {
      await reader.close();
      await after.close();
    }
  } finally {
    for (const gate of held.values()) gate.resolve();
    await setup.close();
    await before.close();
  }
}, 30_000);
