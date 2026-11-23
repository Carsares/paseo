import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOpenAgentTabLabel, PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { deferred } from "../test-fixtures/reconciliation-registries.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import { buildArchivedAgentRecord } from "./agent-archive.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "./agent-storage.js";
import { createPaseoToolCatalog } from "./tools/paseo-tools.js";

const BASE_RECORD: StoredAgentRecord = {
  id: "agent-1",
  provider: "codex",
  cwd: "/workspace/project",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-02T00:00:00.000Z",
  labels: {},
  lastStatus: "idle",
  config: null,
};

const ARCHIVE = {
  archivedAt: "2025-01-03T00:00:00.000Z",
  updatedAt: "2025-01-03T00:00:00.000Z",
};

test("archives a stored agent without changing terminal statuses", () => {
  const statuses: Array<StoredAgentRecord["lastStatus"]> = ["idle", "error", "closed"];

  for (const status of statuses) {
    const archived = buildArchivedAgentRecord({ ...BASE_RECORD, lastStatus: status }, ARCHIVE);

    expect(archived.lastStatus).toBe(status);
    expect(archived.archivedAt).toBe("2025-01-03T00:00:00.000Z");
  }
});

test("archives busy stored agents as idle", () => {
  const statuses: Array<StoredAgentRecord["lastStatus"]> = ["initializing", "running"];

  for (const status of statuses) {
    const archived = buildArchivedAgentRecord({ ...BASE_RECORD, lastStatus: status }, ARCHIVE);

    expect(archived.lastStatus).toBe("idle");
  }
});

test("clears persisted attention when archiving", () => {
  const archived = buildArchivedAgentRecord(
    {
      ...BASE_RECORD,
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: "2025-01-02T12:00:00.000Z",
    },
    ARCHIVE,
  );

  expect(archived).toMatchObject({
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
  });
});

test("moves updatedAt to the archive time", () => {
  const archived = buildArchivedAgentRecord(BASE_RECORD, ARCHIVE);

  expect(archived.updatedAt).toBe("2025-01-03T00:00:00.000Z");
});

test("keeps a later updatedAt when the archive time is earlier", () => {
  // Putting an original archive back after a failed unarchive must not move updatedAt backwards.
  const archived = buildArchivedAgentRecord(
    { ...BASE_RECORD, updatedAt: "2025-01-04T00:00:00.000Z" },
    ARCHIVE,
  );

  expect(archived.archivedAt).toBe("2025-01-03T00:00:00.000Z");
  expect(archived.updatedAt).toBe("2025-01-04T00:00:00.000Z");
});

describe("agent-scoped archive_agent", () => {
  const openOnA = getOpenAgentTabLabel("client-a");
  const openOnB = getOpenAgentTabLabel("client-b");
  const logger = createTestLogger();
  let cwd: string;
  let storage: AgentStorage;
  let manager: AgentManager;
  let callerId: string;
  let finishTurn: ReturnType<typeof deferred>;
  const interrupt = vi.fn();
  const close = vi.fn(async () => {});

  async function create(labels: Record<string, string> = {}, workspaceId?: string) {
    return manager.createAgent({ provider: "codex", cwd }, undefined, {
      labels,
      workspaceId,
    });
  }

  function toolCatalog(scope: "agent" | "top-level" = "agent") {
    return createPaseoToolCatalog({
      callerAgentId: scope === "agent" ? callerId : undefined,
      agentManager: manager,
      agentStorage: storage,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      logger,
    });
  }

  function archive(agentId: string, scope: "agent" | "top-level" = "agent") {
    return toolCatalog(scope).executeTool("archive_agent", { agentId });
  }

  async function archiveQueuedBehindHierarchyChange(
    agentId: string,
    change: () => Promise<unknown>,
  ) {
    const changeStarted = deferred();
    const commitChange = deferred();
    const listActive = storage.listActive.bind(storage);
    vi.spyOn(storage, "listActive").mockImplementationOnce(async () => {
      changeStarted.resolve();
      await commitChange.promise;
      return listActive();
    });
    const archiveQueued = deferred();
    const guardedArchive = manager.archiveAgentFromAgentTool.bind(manager);
    vi.spyOn(manager, "archiveAgentFromAgentTool").mockImplementationOnce((...args) => {
      const result = guardedArchive(...args);
      archiveQueued.resolve();
      return result;
    });
    const changing = change();
    await Promise.race([changeStarted.promise, changing]);
    const outcome = archive(agentId).then(
      () => ({ success: true }),
      (error: unknown) => error,
    );
    try {
      // The tool's initial authorization must finish before the hierarchy change commits.
      await Promise.race([
        archiveQueued.promise,
        outcome.then(() => {
          throw new Error("Archive finished before entering the hierarchy queue");
        }),
      ]);
    } finally {
      commitChange.resolve();
      await changing;
    }
    return outcome;
  }

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "paseo-guarded-archive-"));
    storage = new AgentStorage(join(cwd, "agents"), logger);
    finishTurn = deferred();
    interrupt.mockClear();
    close.mockClear();
    manager = new AgentManager({
      registry: storage,
      logger,
      clients: {
        codex: createTestAgentClient("codex", {
          onInterrupt: interrupt,
          closeSession: close,
          beforeTurnComplete: () => finishTurn.promise,
        }),
      },
    });
    callerId = (await create()).id;
  });

  afterEach(async () => {
    try {
      finishTurn.resolve();
      await Promise.all(manager.listAgents().map(({ id }) => manager.closeAgent(id)));
      await manager.flush();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("reserves client tab labels at scoped creation and update", async () => {
    const { id } = await create({ [openOnA]: "true" });
    const tools = toolCatalog();
    await expect(
      tools.executeTool("create_agent", {
        title: "Child",
        provider: "codex/gpt-5.4",
        initialPrompt: "Review",
        labels: { [openOnA]: "true" },
      }),
    ).rejects.toThrow("Only clients can set open-tab labels");
    await expect(
      tools.executeTool("update_agent", {
        agentId: id,
        labels: { [openOnA]: "false" },
      }),
    ).rejects.toThrow("Only clients can set open-tab labels");
    await expect(archive(id)).rejects.toThrow("tab is open");
  });

  test("refuses a running target before interrupting it, while top-level archive still works", async () => {
    const { id } = await create({ [openOnA]: "true" });
    const run = manager.runAgent(id, "Keep running");
    try {
      await manager.waitForAgentRunStart(id);
      await expect(archive(id)).rejects.toThrow("running, initializing, or has an active turn");
      expect(interrupt).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(manager.getAgent(id)?.lifecycle).toBe("running");
      expect((await storage.get(id))?.archivedAt ?? null).toBeNull();

      await expect(archive(id, "top-level")).resolves.toMatchObject({
        structuredContent: { success: true },
      });
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect((await storage.get(id))?.archivedAt).toEqual(expect.any(String));
    } finally {
      finishTurn.resolve();
      await run;
    }
  });

  test.each(["live", "cold"] as const)("checks all client labels on a %s target", async (state) => {
    const { id } = await create({ [openOnA]: "false", [openOnB]: "true" });
    if (state === "cold") await manager.closeAgent(id);
    const before = await storage.get(id);
    await expect(archive(id)).rejects.toThrow("its tab is open in a client");
    expect(await storage.get(id)).toEqual(before);

    await manager.updateAgentMetadata(id, { labels: { [openOnB]: "false" } });
    const archiveCalls = [archive(id), archive(id)];
    await expect(Promise.all(archiveCalls)).resolves.toEqual([
      { content: [], structuredContent: { success: true } },
      { content: [], structuredContent: { success: true } },
    ]);
    const archived = await storage.get(id);
    expect(archived?.archivedAt).toEqual(expect.any(String));
    await archive(id);
    expect(await storage.get(id)).toEqual(archived);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("rechecks direct ownership after an earlier reparent commits", async () => {
    const workspaceId = "ws-archive";
    const root = await create({}, workspaceId);
    const caller = await create({ [PARENT_AGENT_ID_LABEL]: root.id }, workspaceId);
    callerId = caller.id;
    const target = await create({ [PARENT_AGENT_ID_LABEL]: caller.id }, workspaceId);
    const nextParent = await create({}, workspaceId);

    const outcome = await archiveQueuedBehindHierarchyChange(target.id, () =>
      manager.setAgentParent(target.id, nextParent.id),
    );
    expect(outcome).toMatchObject({
      message: expect.stringContaining("You can only manage your direct subagents"),
    });
    const record = await storage.get(target.id);
    expect(record?.labels[PARENT_AGENT_ID_LABEL]).toBe(nextParent.id);
    expect(record?.archivedAt ?? null).toBeNull();
  });

  test("rechecks caller permissions after an earlier Main Control change commits", async () => {
    const workspaceId = "ws-archive";
    const caller = await create({}, workspaceId);
    callerId = caller.id;
    const target = await create({}, workspaceId);
    await manager.closeAgent(caller.id);

    const outcome = await archiveQueuedBehindHierarchyChange(target.id, () =>
      manager.setAgentMainControl(caller.id, true),
    );
    expect(outcome).toMatchObject({
      message: expect.stringContaining("You can only manage your direct subagents"),
    });
    expect(manager.getAgent(target.id)?.lifecycle).toBe("idle");
    expect((await storage.get(target.id))?.archivedAt ?? null).toBeNull();
  });

  test("can archive an agent after its active turn completes", async () => {
    const { id } = await create();
    const run = manager.runAgent(id, "Complete a turn");
    try {
      await manager.waitForAgentRunStart(id);
      expect(manager.getAgent(id)?.activeTurnId).toEqual(expect.any(String));
      finishTurn.resolve();
      await run;
      expect(manager.getAgent(id)).toMatchObject({ lifecycle: "idle", activeTurnId: null });
      await expect(archive(id)).resolves.toMatchObject({ structuredContent: { success: true } });
    } finally {
      finishTurn.resolve();
      await run;
    }
  });

  test("waits for an earlier cold open-tab write before deciding", async () => {
    const { id } = await create();
    await manager.closeAgent(id);
    await manager.flush();
    const writeStarted = deferred();
    const finishWrite = deferred();
    const upsert = storage.upsert.bind(storage);
    vi.spyOn(storage, "upsert").mockImplementationOnce(async (record) => {
      writeStarted.resolve();
      await finishWrite.promise;
      await upsert(record);
    });
    const label = manager.updateAgentMetadata(id, { labels: { [openOnB]: "true" } });
    await Promise.race([writeStarted.promise, label]);
    const read = vi.spyOn(storage, "get");
    const refused = expect(manager.archiveAgentFromAgentTool(id, async () => {})).rejects.toThrow(
      "its tab is open in a client",
    );
    try {
      // Let scheduled work run while the first write still holds the lifecycle queue.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(read).not.toHaveBeenCalledWith(id);
    } finally {
      finishWrite.resolve();
      await label;
      await refused;
    }
    expect(await storage.get(id)).toMatchObject({ labels: { [openOnB]: "true" } });
    expect((await storage.get(id))?.archivedAt ?? null).toBeNull();
  });

  test("refuses an already reserved turn before the runtime changes to running", async () => {
    const { id } = await create();
    const prompt = manager.streamAgent(id, "Waiting to start");
    try {
      expect(manager.getAgent(id)?.lifecycle).toBe("idle");
      await expect(archive(id)).rejects.toThrow("has an active turn");
      expect(interrupt).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect((await storage.get(id))?.archivedAt ?? null).toBeNull();
    } finally {
      finishTurn.resolve();
      for await (const _event of prompt) {
        // Drain the original reservation.
      }
    }
  });

  test("an admitted archive excludes new foreground reservations and serializes later tab updates", async () => {
    const { id } = await create();
    await manager.flush();
    const writeStarted = deferred();
    const finishWrite = deferred();
    const snapshot = storage.applySnapshot.bind(storage);
    vi.spyOn(storage, "applySnapshot").mockImplementationOnce(async (agent, options) => {
      writeStarted.resolve();
      await finishWrite.promise;
      await snapshot(agent, options);
    });
    const archiving = archive(id);
    let label: Promise<void> | undefined;
    try {
      await Promise.race([writeStarted.promise, archiving]);
      expect(() => manager.streamAgent(id, "Start a new turn")).toThrow("Agent is being archived");
      label = manager.updateAgentMetadata(id, { labels: { [openOnB]: "true" } });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(manager.getAgent(id)?.labels[openOnB]).toBeUndefined();
    } finally {
      finishWrite.resolve();
      await archiving;
      await label;
    }
    expect(await storage.get(id)).toMatchObject({
      archivedAt: expect.any(String),
      labels: { [openOnB]: "true" },
    });
    expect(interrupt).not.toHaveBeenCalled();
  });

  test("applies existing cascade rules after admitting the direct target", async () => {
    const { id: parentId } = await create({}, "workspace");
    const { id } = await create({ [PARENT_AGENT_ID_LABEL]: parentId });
    const { id: openChildId } = await create({
      [PARENT_AGENT_ID_LABEL]: parentId,
      [openOnB]: "true",
    });
    const run = (async () => {
      const events: string[] = [];
      for await (const event of manager.streamAgent(id, "Keep running")) events.push(event.type);
      return events;
    })();
    try {
      await manager.waitForAgentRunStart(id);
      await archive(parentId);
      const archivedAt = (await storage.get(parentId))?.archivedAt;
      expect(archivedAt).toEqual(expect.any(String));
      expect(await storage.get(id)).toMatchObject({
        archivedAt,
        labels: { [PARENT_AGENT_ID_LABEL]: parentId },
      });
      expect(manager.getAgent(id)).toBeNull();
      const openChild = await storage.get(openChildId);
      expect(openChild?.archivedAt ?? null).toBeNull();
      expect(openChild?.labels[PARENT_AGENT_ID_LABEL]).toBeUndefined();
      expect(interrupt).not.toHaveBeenCalled();
      expect(await run).toContain("turn_canceled");
    } finally {
      finishTurn.resolve();
      await run;
    }
  });
});
