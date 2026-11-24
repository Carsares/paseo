import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { FileBackedWorkspaceRegistry } from "../workspace-registry.js";
import { openDurableItemStore } from "./requests.js";

test("two connected clients can decide a persisted item once without restoring its workspace", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-durable-wire-"));
  try {
    const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
    try {
      const url = `ws://127.0.0.1:${daemon.port}/ws`;
      const first = new DaemonClient({ url });
      const second = new DaemonClient({ url });
      try {
        await Promise.all([first.connect(), second.connect()]);
        expect(first.getLastServerInfoMessage()?.features?.workspaceDurableItemsV1).toBe(true);
        const { workspace, mainAgent, error } = await first.createWorkspace({
          source: { kind: "directory", path: cwd },
          title: "Review the trace",
          topic: { hideFromModel: true },
          mainAgent: { config: { provider: "codex", cwd } },
        });
        expect(error).toBeNull();
        if (!workspace || !mainAgent) throw new Error("Expected a topic with a silent main agent");

        const workspaceId = workspace.id;
        const serverId = daemon.daemon.getServerId();
        const openRegistry = () =>
          new FileBackedWorkspaceRegistry(
            join(daemon.paseoHome, "projects", "workspaces.json"),
            createTestLogger(),
          );
        const registry = openRegistry();
        const store = openDurableItemStore({
          paseoHome: daemon.paseoHome,
          serverId,
          workspaceRegistry: registry,
          agentStorage: daemon.daemon.agentStorage,
        });
        const tracePath = join(cwd, "trace.txt");
        await writeFile(tracePath, "Original trace\n");
        await store.create({
          serverId,
          workspaceId,
          requestId: "accept-trace",
          sourceAgentId: mainAgent.id,
          sourceTurnId: "trace-turn",
          kind: "acceptance",
          title: "Accept trace",
          evidence: [{ type: "file", path: "trace.txt" }],
        });
        await first.setWorkspaceDeferral({ workspaceId, action: "park" });

        const list = await second.listWorkspaceDurableItems({
          workspaceId,
          statusFilter: "pending",
        });
        expect(list).toMatchObject({
          error: null,
          items: [{ requestId: "accept-trace", status: "pending", revision: 0 }],
          nextCursor: null,
        });

        const input = { workspaceId, durableItemRequestId: "accept-trace", expectedRevision: 0 };
        await writeFile(tracePath, "Replaced trace\n");
        const stale = await first.decideWorkspaceDurableItem({ ...input, decision: "approve" });
        expect(stale.errorCode).toBe("DURABLE_ITEM_STALE_EVIDENCE");
        await writeFile(tracePath, "Original trace\n");

        const outcomes = await Promise.all([
          first.decideWorkspaceDurableItem({ ...input, decision: "approve" }),
          second.decideWorkspaceDurableItem({ ...input, decision: "request_changes" }),
        ]);
        const successes = outcomes.filter(({ error: responseError }) => responseError === null);
        expect(successes).toHaveLength(1);
        expect(successes[0]?.item).toMatchObject({ status: "decided", revision: 1 });
        expect(await first.listWorkspaceDurableItems({ workspaceId })).toMatchObject({
          error: null,
          items: [successes[0]?.item],
        });
        expect((await openRegistry().get(workspaceId))?.parkedAt).toEqual(expect.any(String));
        expect((await daemon.daemon.agentStorage.get(mainAgent.id))?.lastStatus).toBe("closed");
      } finally {
        await Promise.allSettled([first.close(), second.close()]);
      }
    } finally {
      await daemon.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);
