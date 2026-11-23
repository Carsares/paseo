import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  getOpenAgentTabLabel,
  getParentAgentIdFromLabels,
  PARENT_AGENT_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { deferred } from "../test-fixtures/reconciliation-registries.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { AgentManager, type ManagedAgent } from "./agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "./agent-storage.js";
import {
  archiveAgentCommand,
  cancelAgentRunCommand,
  detachAgentCommand,
  moveAgentToWorkspaceCommand,
  setAgentModeCommand,
  updateAgentCommand,
  type LifecycleAgentSnapshot,
  type LifecycleAgentManager,
  type LifecycleAgentStorage,
} from "./lifecycle-command.js";

class FakeLifecycleAgentStorage implements LifecycleAgentStorage {
  readonly records = new Map<string, StoredAgentRecord>();
  readonly upserts: StoredAgentRecord[] = [];

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    return this.records.get(agentId) ?? null;
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    this.upserts.push(record);
    this.records.set(record.id, record);
  }
}

class FakeLifecycleAgentManager implements LifecycleAgentManager {
  readonly liveAgents = new Map<string, LifecycleAgentSnapshot>();
  readonly cancelledAgentIds: string[] = [];
  readonly clearedAttentionAgentIds: string[] = [];
  readonly archivedAgentIds: string[] = [];
  readonly closedAgentIds: string[] = [];
  readonly metadataUpdates: Array<{
    agentId: string;
    updates: { title?: string; labels?: Record<string, string> };
  }> = [];
  readonly labelUpdates: Array<{ agentId: string; labels: Record<string, string> }> = [];
  readonly notifiedAgentIds: string[] = [];
  readonly modeUpdates: Array<{ agentId: string; modeId: string }> = [];
  readonly detachedAgentIds: string[] = [];
  inFlightAgentIds = new Set<string>();
  readonly settledDuringCancellationAgentIds = new Set<string>();
  readonly rejectedCancellationAgentIds = new Set<string>();

  constructor(private readonly storage: FakeLifecycleAgentStorage) {}

  getAgent(agentId: string): LifecycleAgentSnapshot | null {
    return this.liveAgents.get(agentId) ?? null;
  }

  hasInFlightRun(agentId: string): boolean {
    return this.inFlightAgentIds.has(agentId);
  }

  async cancelAgentRun(agentId: string) {
    this.cancelledAgentIds.push(agentId);
    if (this.settledDuringCancellationAgentIds.delete(agentId)) {
      this.inFlightAgentIds.delete(agentId);
      return { status: "not_running" } as const;
    }
    if (this.rejectedCancellationAgentIds.has(agentId)) {
      return { status: "refused" } as const;
    }
    return this.inFlightAgentIds.delete(agentId)
      ? ({ status: "settled" } as const)
      : ({ status: "not_running" } as const);
  }

  async clearAgentAttention(agentId: string): Promise<void> {
    this.clearedAttentionAgentIds.push(agentId);
  }

  async archiveAgent(
    agentId: string,
    _archivedAt?: string,
    options?: { cancelActiveRun?: boolean },
  ): Promise<{ archivedAt: string }> {
    if (options?.cancelActiveRun) {
      if (this.hasInFlightRun(agentId)) await this.cancelAgentRun(agentId);
      await this.clearAgentAttention(agentId);
    }
    this.archivedAgentIds.push(agentId);
    this.liveAgents.delete(agentId);
    const archivedAt = "2026-05-10T10:00:00.000Z";
    const existing = this.storage.records.get(agentId) ?? storedAgent(agentId);
    this.storage.records.set(agentId, {
      ...existing,
      archivedAt,
    });
    return { archivedAt };
  }

  async archiveAgentInWorkspace(): Promise<never> {
    throw new Error("Guarded archive requires a real AgentManager");
  }

  async archiveSnapshot(agentId: string, archivedAt: string): Promise<StoredAgentRecord> {
    const existing = this.storage.records.get(agentId);
    if (!existing) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const archived = {
      ...existing,
      archivedAt,
    };
    this.storage.records.set(agentId, archived);
    return archived;
  }

  async closeAgent(agentId: string): Promise<void> {
    this.closedAgentIds.push(agentId);
    this.liveAgents.delete(agentId);
  }

  async setLabels(agentId: string, labels: Record<string, string>): Promise<void> {
    this.labelUpdates.push({ agentId, labels });
  }

  async detachAgent(agentId: string): Promise<{
    record: StoredAgentRecord;
    live: boolean;
    previousParentAgentId: string | null;
  }> {
    this.detachedAgentIds.push(agentId);
    const existing = this.storage.records.get(agentId);
    if (!existing) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const previousParentAgentId = getParentAgentIdFromLabels(existing.labels);
    if (!previousParentAgentId) {
      return {
        record: existing,
        live: this.liveAgents.has(agentId),
        previousParentAgentId: null,
      };
    }
    const labels = { ...existing.labels };
    delete labels[PARENT_AGENT_ID_LABEL];
    const record = {
      ...existing,
      labels,
      updatedAt: "2026-05-10T10:30:00.000Z",
    };
    this.storage.records.set(agentId, record);
    return {
      record,
      live: this.liveAgents.has(agentId),
      previousParentAgentId,
    };
  }

  readonly moveSubagentToWorkspace: LifecycleAgentManager["moveSubagentToWorkspace"] = async () => {
    throw new Error("Move requires a real AgentManager in these tests");
  };

  notifyAgentState(agentId: string): void {
    this.notifiedAgentIds.push(agentId);
  }

  async setAgentMode(agentId: string, modeId: string) {
    this.modeUpdates.push({ agentId, modeId });
    return null;
  }

  async updateAgentMetadata(
    agentId: string,
    updates: {
      title?: string;
      labels?: Record<string, string>;
    },
  ): Promise<void> {
    this.metadataUpdates.push({ agentId, updates });
  }
}

const logger = createTestLogger();

describe("agent lifecycle commands", () => {
  test("cancels only when the agent has an in-flight run", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.inFlightAgentIds.add("agent-1");

    const result = await cancelAgentRunCommand({ agentManager: manager, logger }, "agent-1");

    expect(result).toEqual({
      agent: manager.liveAgents.get("agent-1"),
      cancelled: true,
    });
    expect(manager.cancelledAgentIds).toEqual(["agent-1"]);
  });

  test("accepts a stop when the run settles during cancellation", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.inFlightAgentIds.add("agent-1");
    manager.settledDuringCancellationAgentIds.add("agent-1");

    await expect(
      cancelAgentRunCommand({ agentManager: manager, logger }, "agent-1"),
    ).resolves.toEqual({
      agent: manager.liveAgents.get("agent-1"),
      cancelled: false,
    });
  });

  test("archives a live agent after canceling and clearing attention", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.inFlightAgentIds.add("agent-1");
    storage.records.set("agent-1", storedAgent("agent-1"));

    const result = await archiveAgentCommand(
      { agentManager: manager, agentStorage: storage, logger },
      "agent-1",
    );

    expect(result).toEqual({
      agentId: "agent-1",
      archivedAt: "2026-05-10T10:00:00.000Z",
      record: {
        ...storedAgent("agent-1"),
        archivedAt: "2026-05-10T10:00:00.000Z",
      },
    });
    expect(manager.cancelledAgentIds).toEqual(["agent-1"]);
    expect(manager.clearedAttentionAgentIds).toEqual(["agent-1"]);
    expect(manager.archivedAgentIds).toEqual(["agent-1"]);
  });

  test("archives a live internal agent without touching storage", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", { ...managedAgent("agent-1", "idle"), internal: true });

    const result = await archiveAgentCommand(
      { agentManager: manager, agentStorage: storage, logger },
      "agent-1",
    );

    expect(result).toEqual({
      agentId: "agent-1",
      archivedAt: "2026-05-10T10:00:00.000Z",
      record: null,
    });
    expect(manager.archivedAgentIds).toEqual(["agent-1"]);
    expect(storage.upserts).toEqual([]);
  });

  test("archives a live agent when its graceful cancellation is rejected", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.inFlightAgentIds.add("agent-1");
    manager.rejectedCancellationAgentIds.add("agent-1");
    storage.records.set("agent-1", storedAgent("agent-1"));

    await expect(
      archiveAgentCommand({ agentManager: manager, agentStorage: storage, logger }, "agent-1"),
    ).resolves.toMatchObject({ agentId: "agent-1" });
    expect(manager.cancelledAgentIds).toEqual(["agent-1"]);
    expect(manager.archivedAgentIds).toEqual(["agent-1"]);
  });

  test("archives a stored agent when no live agent exists", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    storage.records.set("agent-1", storedAgent("agent-1"));

    const result = await archiveAgentCommand(
      { agentManager: manager, agentStorage: storage, logger },
      "agent-1",
    );

    expect(result.agentId).toBe("agent-1");
    expect(result.archivedAt).toEqual(expect.any(String));
    expect(result.record.archivedAt).toBe(result.archivedAt);
    expect(manager.archivedAgentIds).toEqual([]);
  });

  test("normalizes metadata updates and rejects empty updates", async () => {
    const storage = new FakeLifecycleAgentStorage();
    storage.records.set("agent-1", storedAgent("agent-1"));
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(
      updateAgentCommand(
        { agentManager: manager },
        {
          agentId: "agent-1",
          name: "  Renamed agent  ",
          labels: { team: "infra" },
        },
      ),
    ).resolves.toEqual({ accepted: true, error: null });
    await expect(
      updateAgentCommand({ agentManager: manager }, { agentId: "agent-1", name: "   " }),
    ).resolves.toEqual({
      accepted: false,
      error: "Nothing to update (provide name and/or labels)",
    });
    await expect(
      updateAgentCommand(
        { agentManager: manager },
        {
          agentId: "agent-1",
          name: "Do not apply",
          labels: { [PARENT_AGENT_ID_LABEL]: "spoofed-parent" },
        },
      ),
    ).resolves.toEqual({
      accepted: false,
      error: "Change agent hierarchy through the workspace controls.",
    });

    expect(storage.upserts).toHaveLength(0);
    expect(manager.metadataUpdates).toEqual([
      {
        agentId: "agent-1",
        updates: {
          title: "Renamed agent",
          labels: { team: "infra" },
        },
      },
    ]);
  });

  test("detaches an agent by clearing only the parent relationship", async () => {
    const storage = new FakeLifecycleAgentStorage();
    storage.records.set("agent-1", {
      ...storedAgent("agent-1"),
      labels: {
        [PARENT_AGENT_ID_LABEL]: "parent-agent",
        team: "infra",
      },
    });
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(detachAgentCommand({ agentManager: manager }, "agent-1")).resolves.toEqual({
      agentId: "agent-1",
      live: false,
      previousParentAgentId: "parent-agent",
      record: {
        ...storedAgent("agent-1"),
        labels: { team: "infra" },
        updatedAt: "2026-05-10T10:30:00.000Z",
      },
    });

    expect(manager.detachedAgentIds).toEqual(["agent-1"]);
  });

  test("detach is accepted when the agent is already detached", async () => {
    const storage = new FakeLifecycleAgentStorage();
    storage.records.set("agent-1", storedAgent("agent-1"));
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(detachAgentCommand({ agentManager: manager }, "agent-1")).resolves.toEqual({
      agentId: "agent-1",
      live: false,
      previousParentAgentId: null,
      record: storedAgent("agent-1"),
    });
  });

  test("sets an agent mode and returns the accepted mode", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(
      setAgentModeCommand({ agentManager: manager }, { agentId: "agent-1", modeId: "plan" }),
    ).resolves.toEqual({ modeId: "plan", notice: null });

    expect(manager.modeUpdates).toEqual([{ agentId: "agent-1", modeId: "plan" }]);
  });
});

describe("moveAgentToWorkspaceCommand", () => {
  const sourceWorkspaceId = "ws-source";
  const workspaceId = "ws-target";
  const previousParentAgentId = "parent-agent";
  const labels = {
    [PARENT_AGENT_ID_LABEL]: previousParentAgentId,
    [getOpenAgentTabLabel("client-a")]: "true",
    [getOpenAgentTabLabel("client-b")]: "true",
    team: "test",
  };
  let cwd: string;
  let storage: AgentStorage;
  let manager: AgentManager;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "paseo-move-agent-"));
    storage = new AgentStorage(join(cwd, "agents"), logger);
    manager = new AgentManager({ registry: storage, logger });
  });

  afterEach(async () => {
    try {
      await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
      await manager.flush();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  function closedSubagent(): StoredAgentRecord {
    return { ...storedAgent(randomUUID()), cwd, workspaceId: sourceWorkspaceId, labels };
  }

  test("moves a running subagent without interrupting it for a queued close from the old workspace", async () => {
    const turnStarted = deferred();
    const finishTurn = deferred();
    const closeSession = vi.fn(async () => {});
    manager = new AgentManager({
      clients: {
        codex: createTestAgentClient("codex", {
          beforeTurnComplete: async () => {
            turnStarted.resolve();
            await finishTurn.promise;
          },
          closeSession,
        }),
      },
      registry: storage,
      logger,
    });
    await storage.upsert({
      ...storedAgent(previousParentAgentId),
      cwd,
      workspaceId: sourceWorkspaceId,
    });
    const agent = await manager.createAgent({ provider: "codex", cwd }, undefined, {
      workspaceId: sourceWorkspaceId,
      labels,
      initialTitle: "  Review notes  ",
      background: true,
    });
    const allocateWorkspace = vi.fn(async () => ({ workspaceId: ` ${workspaceId} ` }));
    const run = manager.runAgent(agent.id, "Continue the review");
    try {
      await Promise.race([turnStarted.promise, run]);
      expect(manager.getAgent(agent.id)?.lifecycle).toBe("running");
      await manager.flush();
      const writeStarted = deferred();
      const finishWrite = deferred();
      const applySnapshot = storage.applySnapshot.bind(storage);
      vi.spyOn(storage, "applySnapshot").mockImplementationOnce(async (snapshot, options) => {
        writeStarted.resolve();
        await finishWrite.promise;
        await applySnapshot(snapshot, options);
      });
      const move = moveAgentToWorkspaceCommand({ agentManager: manager }, agent.id, {
        allocateWorkspace,
      });
      let staleClose: PromiseLike<unknown> | undefined;
      try {
        await Promise.race([writeStarted.promise, move]);
        staleClose = expect(
          manager.archiveAgentInWorkspace(agent.id, sourceWorkspaceId),
        ).rejects.toThrow("is no longer in workspace");
        manager.notifyAgentState(agent.id);
      } finally {
        finishWrite.resolve();
      }
      const result = await move;
      await staleClose;
      await manager.flush();

      expect(allocateWorkspace).toHaveBeenCalledExactlyOnceWith({
        agentId: agent.id,
        cwd,
        sourceWorkspaceId,
        title: "Review notes",
        background: true,
        previousParentAgentId,
      });
      expect(result).toEqual({
        agentId: agent.id,
        live: true,
        sourceWorkspaceId,
        workspaceId,
        previousParentAgentId,
        record: expect.objectContaining({ workspaceId, labels: { team: "test" } }),
      });
      expect(manager.getAgent(agent.id)?.session).toBe(agent.session);
      expect(manager.getAgent(agent.id)).toMatchObject({ lifecycle: "running", workspaceId, cwd });
      expect(manager.getAgent(agent.id)?.labels).toEqual({ team: "test" });
      expect(closeSession).not.toHaveBeenCalled();
      const stored = await storage.get(agent.id);
      expect(stored).toMatchObject({ workspaceId, labels: { team: "test" } });
      expect((await storage.listByWorkspaces([sourceWorkspaceId])).map(({ id }) => id)).toEqual([
        previousParentAgentId,
      ]);
      expect(await storage.listByWorkspaces([workspaceId])).toEqual([stored]);
    } finally {
      finishTurn.resolve();
      expect((await run).timeline).not.toHaveLength(0);
    }
  });

  test("a close queued for the old workspace cannot archive the moved agent", async () => {
    const stored = closedSubagent();
    await storage.upsert(stored);
    const allocating = deferred();
    const release = deferred();
    const move = manager.moveSubagentToWorkspace(stored.id, {
      allocateWorkspace: async () => {
        allocating.resolve();
        await release.promise;
        return { workspaceId };
      },
    });

    await allocating.promise;
    const close = expect(
      manager.archiveAgentInWorkspace(stored.id, sourceWorkspaceId),
    ).rejects.toThrow("is no longer in workspace");
    release.resolve();
    await Promise.all([move, close]);

    expect(await storage.get(stored.id)).toMatchObject({ workspaceId });
    expect((await storage.get(stored.id))?.archivedAt).toBeFalsy();
  });

  test("serializes a detach with descendant collection for a workspace move", async () => {
    const root = closedSubagent();
    const child = { ...closedSubagent(), labels: { [PARENT_AGENT_ID_LABEL]: root.id } };
    const grandchild = { ...closedSubagent(), labels: { [PARENT_AGENT_ID_LABEL]: child.id } };
    await Promise.all([root, child, grandchild].map((record) => storage.upsert(record)));
    const listByWorkspaces = storage.listByWorkspaces.bind(storage);
    const captured = deferred();
    const release = deferred();
    vi.spyOn(storage, "listByWorkspaces").mockImplementationOnce(async (ids) => {
      const records = await listByWorkspaces(ids);
      captured.resolve();
      await release.promise;
      return records;
    });

    const move = manager.moveSubagentToWorkspace(root.id, {
      allocateWorkspace: async () => ({ workspaceId }),
    });
    await captured.promise;
    const detach = manager.detachAgent(child.id);
    release.resolve();
    await Promise.all([move, detach]);

    expect(await storage.get(root.id)).toMatchObject({ workspaceId });
    expect(await storage.get(child.id)).toMatchObject({
      workspaceId,
      labels: {},
    });
    expect(await storage.get(grandchild.id)).toMatchObject({
      workspaceId,
      labels: { [PARENT_AGENT_ID_LABEL]: child.id },
    });
  });

  test("moves a closed subagent and updates stored workspace membership", async () => {
    const stored = { ...closedSubagent(), title: "  NEW AGENT  " };
    await storage.upsert(stored);
    const allocateWorkspace = vi.fn(async () => ({ workspaceId }));

    const result = await moveAgentToWorkspaceCommand({ agentManager: manager }, stored.id, {
      allocateWorkspace,
    });

    expect(allocateWorkspace).toHaveBeenCalledWith(expect.objectContaining({ title: null }));
    expect(result).toEqual({
      agentId: stored.id,
      live: false,
      sourceWorkspaceId,
      workspaceId,
      previousParentAgentId,
      record: {
        ...stored,
        workspaceId,
        labels: { team: "test" },
        updatedAt: expect.any(String),
      },
    });
    expect(result.record.updatedAt > stored.updatedAt).toBe(true);
    expect(manager.getAgent(stored.id)).toBeNull();
    expect(await storage.get(stored.id)).toEqual(result.record);
    expect(await storage.listByWorkspaces([sourceWorkspaceId])).toEqual([]);
    expect(await storage.listByWorkspaces([workspaceId])).toEqual([result.record]);
  });

  test("rolls back the allocation if a pending deletion skips the closed subagent write", async () => {
    const stored = closedSubagent();
    await storage.upsert(stored);
    const rollback = vi.fn(async () => {});

    await expect(
      moveAgentToWorkspaceCommand({ agentManager: manager }, stored.id, {
        allocateWorkspace: async () => {
          storage.beginDelete(stored.id);
          return { workspaceId, rollback };
        },
      }),
    ).rejects.toThrow(`Agent move was not persisted: ${stored.id}`);

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(await storage.listByWorkspaces([sourceWorkspaceId])).toEqual([stored]);
    expect(await storage.listByWorkspaces([workspaceId])).toEqual([]);
  });

  test("replays the committed move and passes post-move root state to a concurrent request without the key", async () => {
    const stored = closedSubagent();
    await storage.upsert(stored);
    const allocationStarted = deferred();
    const finishAllocation = deferred();
    const allocateWorkspace = vi.fn(async () => {
      allocationStarted.resolve();
      await finishAllocation.promise;
      return { workspaceId };
    });
    const unexpectedAllocation = vi.fn(async () => ({ workspaceId: "ws-unexpected" }));
    const rejectSecondMove = vi.fn(async (source: { sourceWorkspaceId: string }) => {
      throw new Error(`Cannot move the only root agent in workspace: ${source.sourceWorkspaceId}`);
    });
    const move = (
      idempotencyKey?: string,
      customAllocate: typeof allocateWorkspace = idempotencyKey === "  move-once  "
        ? allocateWorkspace
        : unexpectedAllocation,
    ) =>
      moveAgentToWorkspaceCommand({ agentManager: manager }, stored.id, {
        idempotencyKey,
        allocateWorkspace: customAllocate,
      });

    const first = move("  move-once  ");
    await Promise.race([allocationStarted.promise, first]);
    const replay = move("move-once");
    const withoutKey = expect(move(undefined, rejectSecondMove)).rejects.toThrow(
      `Cannot move the only root agent in workspace: ${workspaceId}`,
    );
    finishAllocation.resolve();

    const result = await first;
    await expect(replay).resolves.toEqual({ ...result, replayed: true });
    await expect(move("move-once")).resolves.toEqual({ ...result, replayed: true });
    await withoutKey;
    expect(allocateWorkspace).toHaveBeenCalledTimes(1);
    expect(unexpectedAllocation).not.toHaveBeenCalled();
    expect(rejectSecondMove).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: stored.id,
        sourceWorkspaceId: workspaceId,
        previousParentAgentId: null,
      }),
    );
  });

  test("rejects missing, internal, archived, and unassigned agents before allocation", async () => {
    const archived = { ...closedSubagent(), archivedAt: "2026-05-10T10:00:00.000Z" };
    const internal = { ...closedSubagent(), internal: true };
    const unassigned = { ...closedSubagent(), workspaceId: undefined };
    const missingId = randomUUID();
    await storage.upsert(archived);
    await storage.upsert(internal);
    await storage.upsert(unassigned);
    const allocateWorkspace = vi.fn(async () => ({ workspaceId }));
    const move = (agentId: string) =>
      moveAgentToWorkspaceCommand({ agentManager: manager }, agentId, { allocateWorkspace });

    await expect(move(archived.id)).rejects.toThrow(`Agent is archived: ${archived.id}`);
    await expect(move(internal.id)).rejects.toThrow(`Agent not found: ${internal.id}`);
    await expect(move(unassigned.id)).rejects.toThrow(`Agent has no workspace: ${unassigned.id}`);
    await expect(move(missingId)).rejects.toThrow(`Agent not found: ${missingId}`);
    expect(allocateWorkspace).not.toHaveBeenCalled();
  });

  test("moves a root agent, clears open-tab labels, and returns previousParentAgentId null", async () => {
    const root: StoredAgentRecord = {
      ...storedAgent(randomUUID()),
      cwd,
      workspaceId: sourceWorkspaceId,
      title: "Root task",
      labels: {
        [getOpenAgentTabLabel("client-a")]: "true",
        [getOpenAgentTabLabel("client-b")]: "true",
        team: "test",
      },
    };
    await storage.upsert(root);
    const allocateWorkspace = vi.fn(async () => ({ workspaceId }));

    const result = await moveAgentToWorkspaceCommand({ agentManager: manager }, root.id, {
      allocateWorkspace,
    });

    expect(allocateWorkspace).toHaveBeenCalledExactlyOnceWith({
      agentId: root.id,
      cwd,
      sourceWorkspaceId,
      title: "Root task",
      background: false,
      previousParentAgentId: null,
    });
    expect(result).toEqual({
      agentId: root.id,
      live: false,
      sourceWorkspaceId,
      workspaceId,
      previousParentAgentId: null,
      record: {
        ...root,
        workspaceId,
        labels: { team: "test" },
        updatedAt: expect.any(String),
      },
    });
    expect(await storage.listByWorkspaces([sourceWorkspaceId])).toEqual([]);
    expect(await storage.listByWorkspaces([workspaceId])).toEqual([result.record]);
  });

  test("moves active same-workspace live, stored, and nested descendants while preserving parent labels", async () => {
    manager = new AgentManager({
      clients: { codex: createTestAgentClient("codex") },
      registry: storage,
      logger,
    });
    const root = await manager.createAgent({ provider: "codex", cwd }, undefined, {
      workspaceId: sourceWorkspaceId,
      labels: {
        [getOpenAgentTabLabel("client-a")]: "true",
        role: "root",
      },
      initialTitle: "Root agent",
    });
    const liveChild = await manager.createAgent({ provider: "codex", cwd }, undefined, {
      workspaceId: sourceWorkspaceId,
      labels: {
        [PARENT_AGENT_ID_LABEL]: root.id,
        [getOpenAgentTabLabel("client-b")]: "true",
        role: "live-child",
      },
    });
    const internalChild = await manager.createAgent(
      { provider: "codex", cwd, internal: true },
      undefined,
      {
        workspaceId: sourceWorkspaceId,
        labels: {
          [PARENT_AGENT_ID_LABEL]: root.id,
        },
      },
    );
    const storedChild: StoredAgentRecord = {
      ...storedAgent(randomUUID()),
      cwd,
      workspaceId: sourceWorkspaceId,
      labels: {
        [PARENT_AGENT_ID_LABEL]: root.id,
        [getOpenAgentTabLabel("client-c")]: "true",
        role: "stored-child",
      },
    };
    const storedGrandchild: StoredAgentRecord = {
      ...storedAgent(randomUUID()),
      cwd,
      workspaceId: sourceWorkspaceId,
      labels: {
        [PARENT_AGENT_ID_LABEL]: storedChild.id,
        [getOpenAgentTabLabel("client-d")]: "true",
        role: "grandchild",
      },
    };
    const crossWorkspaceChild: StoredAgentRecord = {
      ...storedAgent(randomUUID()),
      cwd,
      workspaceId: "ws-other",
      labels: {
        [PARENT_AGENT_ID_LABEL]: root.id,
        role: "cross-workspace",
      },
    };
    const archivedChild: StoredAgentRecord = {
      ...storedAgent(randomUUID()),
      cwd,
      workspaceId: sourceWorkspaceId,
      archivedAt: "2026-05-10T10:00:00.000Z",
      labels: {
        [PARENT_AGENT_ID_LABEL]: root.id,
        role: "archived",
      },
    };
    const siblingRoot: StoredAgentRecord = {
      ...storedAgent(randomUUID()),
      cwd,
      workspaceId: sourceWorkspaceId,
      labels: { role: "sibling" },
    };
    await Promise.all([
      manager.flush(),
      storage.upsert(storedChild),
      storage.upsert(storedGrandchild),
      storage.upsert(crossWorkspaceChild),
      storage.upsert(archivedChild),
      storage.upsert(siblingRoot),
    ]);

    const emittedStates: ManagedAgent[] = [];
    const unsubscribe = manager.subscribe(
      (event) => {
        if (event.type === "agent_state") emittedStates.push(event.agent);
      },
      { replayState: false },
    );

    try {
      const result = await moveAgentToWorkspaceCommand({ agentManager: manager }, root.id, {
        allocateWorkspace: async () => ({ workspaceId }),
      });
      await manager.flush();

      expect(result.previousParentAgentId).toBeNull();
      expect(result.live).toBe(true);
      expect(result.record).toMatchObject({ workspaceId, labels: { role: "root" } });
      expect(result.movedDescendantStoredRecords).toHaveLength(2);
      expect(result.movedDescendantStoredRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: storedChild.id,
            workspaceId,
            labels: { [PARENT_AGENT_ID_LABEL]: root.id, role: "stored-child" },
          }),
          expect.objectContaining({
            id: storedGrandchild.id,
            workspaceId,
            labels: { [PARENT_AGENT_ID_LABEL]: storedChild.id, role: "grandchild" },
          }),
        ]),
      );

      expect(manager.getAgent(root.id)).toMatchObject({ workspaceId, labels: { role: "root" } });
      expect(manager.getAgent(liveChild.id)).toMatchObject({
        workspaceId,
        labels: { [PARENT_AGENT_ID_LABEL]: root.id, role: "live-child" },
      });
      expect(manager.getAgent(internalChild.id)?.workspaceId).toBe(workspaceId);
      expect(emittedStates.find((agent) => agent.id === liveChild.id)).toMatchObject({
        id: liveChild.id,
        workspaceId,
        labels: { [PARENT_AGENT_ID_LABEL]: root.id, role: "live-child" },
      });
      expect(await storage.get(liveChild.id)).toMatchObject({
        workspaceId,
        labels: { [PARENT_AGENT_ID_LABEL]: root.id, role: "live-child" },
      });
      expect(await storage.get(crossWorkspaceChild.id)).toEqual(crossWorkspaceChild);
      expect(await storage.get(archivedChild.id)).toEqual(archivedChild);
      expect(await storage.get(siblingRoot.id)).toEqual(siblingRoot);
      expect((await storage.listByWorkspaces([sourceWorkspaceId])).map((r) => r.id)).toEqual([
        siblingRoot.id,
      ]);
      expect((await storage.listByWorkspaces([workspaceId])).map((r) => r.id).sort()).toEqual(
        [root.id, liveChild.id, storedChild.id, storedGrandchild.id].sort(),
      );
    } finally {
      unsubscribe();
    }
  });

  test("rolls back the allocation and restores the live agent if persistence fails", async () => {
    manager = new AgentManager({
      clients: { codex: createTestAgentClient("codex") },
      registry: storage,
      logger,
    });
    await storage.upsert({
      ...storedAgent(previousParentAgentId),
      cwd,
      workspaceId: sourceWorkspaceId,
    });
    const agent = await manager.createAgent({ provider: "codex", cwd }, undefined, {
      workspaceId: sourceWorkspaceId,
      labels,
    });
    await manager.flush();
    const before = manager.getAgent(agent.id);
    const stored = await storage.get(agent.id);
    const failure = new Error("Simulated snapshot write failure");
    const writeStarted = deferred();
    const finishWrite = deferred();
    vi.spyOn(storage, "applySnapshot").mockImplementationOnce(async () => {
      writeStarted.resolve();
      await finishWrite.promise;
      throw failure;
    });
    const rollback = vi.fn(async () => {});
    const stateUpdates: ManagedAgent[] = [];
    const unsubscribe = manager.subscribe(
      (event) => {
        if (event.type === "agent_state") stateUpdates.push(event.agent);
      },
      { agentId: agent.id, replayState: false },
    );
    const move = moveAgentToWorkspaceCommand({ agentManager: manager }, agent.id, {
      allocateWorkspace: async () => ({ workspaceId, rollback }),
    });
    const rejected = expect(move).rejects.toBe(failure);
    try {
      await Promise.race([writeStarted.promise, move]);
      expect(manager.getAgent(agent.id)).toEqual(before);
      manager.notifyAgentState(agent.id);
      expect(stateUpdates).toEqual([{ ...before, updatedAt: expect.any(Date) }]);
      expect(rollback).not.toHaveBeenCalled();
    } finally {
      finishWrite.resolve();
      unsubscribe();
      await rejected;
      await manager.flush();
    }

    expect(rollback).toHaveBeenCalledTimes(1);
    const [notified] = stateUpdates;
    expect(manager.getAgent(agent.id)).toEqual(notified);
    const updatedAt = notified.updatedAt.toISOString();
    const expected = { ...stored, updatedAt, lastActivityAt: updatedAt };
    expect(await storage.get(agent.id)).toEqual(expected);
    expect(
      (await storage.listByWorkspaces([sourceWorkspaceId])).find(({ id }) => id === agent.id),
    ).toEqual(expected);
    expect(await storage.listByWorkspaces([workspaceId])).toEqual([]);
  });

  test.each([" ", ` ${sourceWorkspaceId} `])(
    "rolls back an allocation that does not identify a different workspace (%j)",
    async (allocatedId) => {
      const stored = closedSubagent();
      await storage.upsert(stored);
      const rollback = vi.fn(async () => {});

      await expect(
        moveAgentToWorkspaceCommand({ agentManager: manager }, stored.id, {
          allocateWorkspace: async () => ({ workspaceId: allocatedId, rollback }),
        }),
      ).rejects.toThrow(`Move requires a different workspace: ${stored.id}`);

      expect(rollback).toHaveBeenCalledTimes(1);
      expect(await storage.get(stored.id)).toEqual(stored);
    },
  );
});

function managedAgent(
  id: string,
  lifecycle: LifecycleAgentSnapshot["lifecycle"],
): LifecycleAgentSnapshot {
  return {
    id,
    cwd: "/workspace/project",
    lifecycle,
  };
}

function storedAgent(id: string): StoredAgentRecord {
  return {
    id,
    provider: "codex",
    cwd: "/workspace/project",
    createdAt: "2026-05-10T09:00:00.000Z",
    updatedAt: "2026-05-10T09:00:00.000Z",
    labels: {},
    lastStatus: "closed",
    config: null,
    persistence: null,
    archivedAt: null,
  };
}
