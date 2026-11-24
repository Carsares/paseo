import {
  getOpenAgentTabLabel,
  PARENT_AGENT_ID_LABEL,
  RESIDENT_AGENT_LABEL,
  SIDE_CHAT_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { deferred } from "../test-fixtures/reconciliation-registries.js";
import {
  createTestAgentClient,
  type TestAgentClientOptions,
} from "../test-utils/fake-agent-client.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";
import { AgentManager } from "./agent-manager.js";
import { sendPreparedPromptToAgent, sendPromptToAgent } from "./agent-prompt.js";
import type { AgentPromptInput, AgentSessionConfig } from "./agent-sdk-types.js";
import { AgentStorage } from "./agent-storage.js";
import { TopicMainArchiveError } from "./hierarchy-policy.js";
import { archiveAgentCommand } from "./lifecycle-command.js";

const WORKSPACE_ID = "workspace";
const provider = "antigravity";
const frozenInstructions = "Fixed role instructions";
const topicName = "User's startup topic";
const topicSummary = "Look at the boot trace first";

async function topicScenario(
  options: TestAgentClientOptions & { legacy?: boolean; useDisplayName?: boolean } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-topic-manager-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(cwd, "agents"), logger);
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
  const manager = new AgentManager({
    clients: { [provider]: createTestAgentClient(provider, options) },
    registry: storage,
    workspaceRegistry: workspaces,
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
