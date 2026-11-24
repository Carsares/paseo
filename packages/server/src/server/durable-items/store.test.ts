import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { WorkspaceDeferral } from "../workspace-deferral/deferral.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { DurableItemConflictError, DurableItemStore } from "./store.js";

const serverId = "host";
const workspaceId = "topic";
const requestId = "accept-release";
const sourceAgentId = "lead";
const now = new Date("2026-11-01T00:00:00.000Z").toISOString();

async function scenario(cwd?: string) {
  const dir = await mkdtemp(join(tmpdir(), "paseo-durable-items-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const logger = createTestLogger();
  const registry = new FileBackedWorkspaceRegistry(join(dir, "workspaces.json"), logger);
  const agents = new AgentStorage(join(dir, "agents"), logger);
  const workspace = createPersistedWorkspaceRecord({
    workspaceId,
    projectId: "project",
    cwd: cwd ?? dir,
    kind: "directory",
    displayName: "Topic",
    createdAt: now,
    updatedAt: now,
  });
  await registry.upsert(workspace);
  await agents.upsert({
    id: sourceAgentId,
    workspaceId,
    cwd: workspace.cwd,
    provider: "claude",
    title: null,
    labels: {},
    metadata: {},
    createdAt: now,
    updatedAt: now,
    lastStatus: "closed",
  });
  const filePath = join(dir, "items.json");
  const openStore = (host = serverId) =>
    new DurableItemStore({
      filePath,
      serverId: host,
      getWorkspace: (id) => registry.get(id),
      getSourceAgent: (id) => agents.get(id),
      now: () => Date.parse(now),
    });
  return {
    dir,
    filePath,
    registry,
    workspace,
    openStore,
    deferral: new WorkspaceDeferral(registry, logger),
    create: {
      serverId,
      workspaceId,
      requestId,
      sourceAgentId,
      sourceTurnId: "turn-1",
      kind: "acceptance",
      title: "Accept release",
    } as const,
    decide: {
      serverId,
      workspaceId,
      durableItemRequestId: requestId,
      expectedRevision: 0,
      principalId: "principal-a",
      decision: "approve",
    } as const,
  };
}

test("competing decisions commit once, preserve the real principal, and never restore a parked workspace", async () => {
  const { dir, filePath, registry, deferral, openStore, create, decide } = await scenario();
  await writeFile(join(dir, "trace.txt"), "Verified trace");
  await deferral.set({ workspaceId, action: "park" });
  const parked = await registry.get(workspaceId);
  const first = openStore();
  const second = openStore();
  await expect(
    first.create({ ...create, evidence: [{ type: "file", path: "trace.txt" }] }),
  ).resolves.toMatchObject({ status: "pending", revision: 0 });
  await expect(second.create({ ...create, evidence: [] })).rejects.toBeInstanceOf(
    DurableItemConflictError,
  );
  const recovered = openStore();
  await expect(recovered.list({ serverId, statusFilter: "pending" })).resolves.toMatchObject({
    items: [{ requestId, sourceTurnId: "turn-1", status: "pending" }],
  });
  const results = await Promise.allSettled([
    first.decide(decide),
    second.decide({ ...decide, principalId: "principal-b", decision: "reject" }),
  ]);
  expect(results).toEqual([
    {
      status: "fulfilled",
      value: expect.objectContaining({ status: "decided", decision: "approve", revision: 1 }),
    },
    { status: "rejected", reason: expect.any(DurableItemConflictError) },
  ]);
  await expect(openStore().list({ serverId })).resolves.toMatchObject({
    items: [{ status: "decided", decision: "approve", revision: 1 }],
  });
  expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
    items: [{ decidedByPrincipalId: "principal-a" }],
  });
  expect(await registry.get(workspaceId)).toEqual(parked);
});

test("rejects missing, changed, expired and foreign-host evidence on approval", async () => {
  const { dir, openStore, create, decide } = await scenario();
  const store = openStore();
  const path = join(dir, "trace.txt");
  await writeFile(path, "Original trace");
  await store.create({ ...create, evidence: [{ type: "file", path: "trace.txt" }] });
  await writeFile(path, "Edited trace");
  const stale = { errorCode: "DURABLE_ITEM_STALE_EVIDENCE" };
  await expect(store.decide(decide)).rejects.toMatchObject(stale);
  await rm(path);
  await expect(store.decide(decide)).rejects.toMatchObject(stale);
  await expect(openStore("other").decide(decide)).rejects.toMatchObject(stale);
  await expect(openStore("other").decide({ ...decide, serverId: "other" })).rejects.toMatchObject(
    stale,
  );
  await store.expire({ serverId, workspaceId, requestId, expectedRevision: 0 });
  await expect(store.decide({ ...decide, expectedRevision: 1 })).rejects.toMatchObject({
    item: { status: "expired", revision: 1 },
  });
  await store.create({ ...create, requestId: "empty", evidence: [] });
  await expect(store.decide({ ...decide, durableItemRequestId: "empty" })).rejects.toMatchObject(
    stale,
  );
  await expect(
    store.decide({
      ...decide,
      durableItemRequestId: "empty",
      decision: "request_changes",
    }),
  ).resolves.toMatchObject({ status: "decided", decision: "request_changes" });
});

test("binds Git file evidence to the current checkout HEAD and worktree fingerprint", async () => {
  const repoRoot = await realpath(fileURLToPath(new URL("../../../../..", import.meta.url)));
  const { openStore, create, decide, filePath } = await scenario(repoRoot);
  const store = openStore();
  const item = await store.create({
    ...create,
    evidence: [{ type: "git", repoRoot, path: "packages/server/CLAUDE.md" }],
  });
  expect(item.evidence).toEqual([
    {
      type: "git",
      path: "packages/server/CLAUDE.md",
      repoRoot,
      headSha: expect.stringMatching(/^[a-f0-9]{40,64}$/),
      blobOrIndexFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  ]);
  const expected = item.evidence[0];
  if (expected?.type !== "git") throw new Error("Expected Git evidence");
  for (const stale of [
    { ...expected, headSha: "outdated-head" },
    { ...expected, blobOrIndexFingerprint: "outdated-worktree" },
  ]) {
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, serverId, items: [{ item: { ...item, evidence: [stale] } }] }),
    );
    await expect(store.decide(decide)).rejects.toMatchObject({
      errorCode: "DURABLE_ITEM_STALE_EVIDENCE",
    });
  }
  await writeFile(filePath, JSON.stringify({ version: 1, serverId, items: [{ item }] }));
  await expect(store.decide(decide)).resolves.toMatchObject({ status: "decided" });
});

test("isolates workspaces sharing a directory and pages only matching active items", async () => {
  const { workspace, registry, openStore, create, decide } = await scenario();
  const other = "other-workspace";
  await registry.upsert({ ...workspace, workspaceId: other });
  const store = openStore();
  await expect(store.create({ ...create, workspaceId: other, evidence: [] })).rejects.toThrow(
    "source is unavailable",
  );
  await store.create({ ...create, evidence: [] });
  await store.create({ ...create, requestId: "second", evidence: [] });
  await expect(store.decide({ ...decide, workspaceId: other })).rejects.toThrow("does not exist");
  const first = await store.list({ serverId, workspaceId, limit: 1 });
  expect(first).toMatchObject({ items: [{ requestId }], nextCursor: expect.any(String) });
  await expect(
    store.list({ serverId, workspaceId, cursor: first.nextCursor! }),
  ).resolves.toMatchObject({
    items: [{ requestId: "second" }],
    nextCursor: null,
  });
  await registry.update(workspaceId, (entry) => ({ ...entry, archivedAt: now }));
  await expect(store.list({ serverId, workspaceId })).resolves.toEqual({
    items: [],
    nextCursor: null,
  });
  await expect(store.decide(decide)).rejects.toThrow("Workspace is unavailable");
});
