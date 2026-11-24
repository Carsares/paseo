import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskEvent } from "./agent/task-ledger/events.js";
import { WorkspaceTaskLedgerStore } from "./agent/task-ledger/index.js";
import { listWorkspaceTaskSummaries } from "./task-ledger-rpc.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "./workspace-registry.js";

describe("workspace task ledger RPC", () => {
  const workspaceId = "workspace-a";
  const logger = pino({ level: "silent" });
  let root: string;
  let workspaceRegistry: FileBackedWorkspaceRegistry;
  let taskLedger: WorkspaceTaskLedgerStore;

  async function registerWorkspace(id: string) {
    const now = new Date().toISOString();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: id,
        projectId: "project",
        cwd: join(root, id),
        kind: "local_checkout",
        displayName: id,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  function list(id = workspaceId) {
    return listWorkspaceTaskSummaries(
      { type: "workspace.tasks.list.request", requestId: "request-1", workspaceId: id },
      { workspaceRegistry, taskLedger, logger },
    );
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paseo-task-ledger-rpc-"));
    workspaceRegistry = new FileBackedWorkspaceRegistry(join(root, "workspaces.json"), logger);
    await workspaceRegistry.initialize();
    taskLedger = new WorkspaceTaskLedgerStore(root);
    await registerWorkspace(workspaceId);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns only the selected workspace's task summaries, including recent agent progress", async () => {
    const otherId = "workspace-b";
    await registerWorkspace(otherId);
    await taskLedger.upsert(otherId, { taskId: "other", title: "Other workspace" });
    const child = { agentId: "child", serverId: "host", boundBy: "main" };
    const event = taskEvent(child.agentId, "turn_completed", 0, "idle");
    const first = await taskLedger.upsert(workspaceId, { taskId: "first", title: "First" });
    const current = await taskLedger.upsert(
      workspaceId,
      {
        taskId: "current",
        title: "Current",
        status: "verifying",
        tier: "T2",
        participants: [child],
        handoffSummary: "Check the review output",
        blockingQuestion: "Which workspace should host the report?",
        closure: { verification: { state: "not_run", privateDetail: "Do not expose" } },
      },
      [event],
    );

    expect(await list()).toEqual({
      type: "workspace.tasks.list.response",
      payload: {
        requestId: "request-1",
        workspaceId,
        error: null,
        tasks: [
          {
            taskId: "current",
            title: "Current",
            status: "verifying",
            tier: "T2",
            participants: [child],
            handoffSummary: "Check the review output",
            blockingQuestion: "Which workspace should host the report?",
            verificationState: "not_run",
            recentAgentStates: [
              { agentId: child.agentId, kind: event.kind, at: event.at, lifecycle: "idle" },
            ],
            latestProgress: {
              agentId: child.agentId,
              kind: event.kind,
              at: event.at,
              lifecycle: "idle",
            },
            createdAt: current.createdAt,
            updatedAt: current.updatedAt,
          },
          {
            taskId: "first",
            title: "First",
            status: "analyzing",
            tier: "T1",
            participants: [],
            createdAt: first.createdAt,
            updatedAt: first.updatedAt,
          },
        ],
      },
    });
  });

  it("reports progress from a completion report without lifecycle across a clock rollback", async () => {
    const child = { agentId: "child", serverId: "host", boundBy: "main" };
    const dispatched = taskEvent(child.agentId, "dispatched", 0, "running", "dispatch", 2_000);
    const report = {
      ...taskEvent(child.agentId, "reported_blocked", 0, undefined, "report", 1_000),
      runtime: "00000000-0000-4000-8000-000000000001",
    };
    await taskLedger.upsert(
      workspaceId,
      { taskId: "current", title: "Current", participants: [child] },
      [dispatched],
    );
    await taskLedger.recordAgentEvent(workspaceId, report, "host", "main");

    expect((await list()).payload.tasks).toMatchObject([
      {
        recentAgentStates: [
          { agentId: child.agentId, kind: "dispatched", at: dispatched.at, lifecycle: "running" },
        ],
        latestProgress: { agentId: child.agentId, kind: "reported_blocked", at: report.at },
      },
    ]);
  });

  it("distinguishes an empty ledger from an unknown workspace with orphaned tasks", async () => {
    const missing = "workspace-missing";
    await taskLedger.upsert(missing, { taskId: "orphan", title: "Orphaned task" });

    expect((await list()).payload).toEqual({
      requestId: "request-1",
      workspaceId,
      tasks: [],
      error: null,
    });
    expect((await list(missing)).payload).toEqual({
      requestId: "request-1",
      workspaceId: missing,
      tasks: [],
      error: "Workspace not found",
    });
  });

  it("returns a stable read error when persisted data is unreadable", async () => {
    await taskLedger.upsert(workspaceId, { taskId: "current", title: "Current" });
    await writeFile(join(root, "tasks", `${workspaceId}.json`), "{ invalid JSON");

    expect((await list()).payload).toEqual({
      requestId: "request-1",
      workspaceId,
      tasks: [],
      error: "Could not read the workspace task ledger",
    });
  });
});
