import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { taskEvent } from "./agent/task-ledger/events.js";
import { WorkspaceTaskLedgerStore } from "./agent/task-ledger/index.js";
import { acquirePidLock, releasePidLock } from "./pid-lock.js";
import { DaemonClient, createTestPaseoDaemon } from "./test-utils/index.js";

test("workspace tasks reach the authorized requesting socket and CLI", async () => {
  const daemon = await createTestPaseoDaemon();
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  const clientId = "workspace-task-reader";
  const setup = new DaemonClient({ url });
  const reader = new DaemonClient({ url, clientId, sessionPermissions: ["workspace.read"] });
  const sibling = new DaemonClient({ url, clientId, sessionPermissions: ["workspace.read"] });
  const denied = new DaemonClient({ url, clientId, sessionPermissions: ["daemon.read"] });

  try {
    await setup.connect();
    const agent = await setup.createAgent({ provider: "codex", cwd: daemon.staticDir });
    const workspaceId = (await daemon.daemon.agentStorage.get(agent.id))?.workspaceId;
    if (!workspaceId) throw new Error("Agent workspace was not created");

    const ledger = new WorkspaceTaskLedgerStore(daemon.paseoHome);
    const saved = await ledger.upsert(workspaceId, {
      taskId: "check-build",
      title: "Check the build",
      status: "verifying",
      participants: [{ agentId: agent.id }],
    });
    const report = taskEvent(agent.id, "reported_blocked", 0);
    await ledger.recordAgentEvent(workspaceId, report, daemon.daemon.getServerId(), "main");

    await denied.connect();
    await reader.connect();
    await sibling.connect();
    const siblingReplies: string[] = [];
    sibling.on("workspace.tasks.list.response", (reply) => {
      siblingReplies.push(reply.payload.requestId);
    });

    expect(reader.supportsWorkspaceTaskLedger()).toBe(true);
    const summary = {
      taskId: "check-build",
      title: "Check the build",
      status: "verifying",
      tier: "T1",
      participants: [{ agentId: agent.id }],
      recentAgentStates: [],
      latestProgress: { agentId: agent.id, kind: "reported_blocked", at: report.at },
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    };
    await expect(reader.listWorkspaceTasks(workspaceId)).resolves.toEqual([summary]);
    await sibling.fetchWorkspaces();
    expect(siblingReplies).toEqual([]);

    await expect(denied.listWorkspaceTasks(workspaceId)).rejects.toThrow(
      "Session is not authorized for workspace.tasks.list.request",
    );

    const cwd = join(daemon.staticDir, "src");
    await mkdir(cwd);
    await acquirePidLock(daemon.paseoHome, `127.0.0.1:${daemon.port}`);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)),
        "--home",
        daemon.paseoHome,
        "task",
        "show",
        "check-build",
        "--json",
      ],
      {
        cwd,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
          ),
          PASEO_HOME: daemon.paseoHome,
        },
        timeout: 15_000,
      },
    );
    expect(JSON.parse(stdout)).toEqual(summary);
  } finally {
    await Promise.allSettled([setup.close(), reader.close(), sibling.close(), denied.close()]);
    await releasePidLock(daemon.paseoHome);
    await daemon.close();
  }
});
