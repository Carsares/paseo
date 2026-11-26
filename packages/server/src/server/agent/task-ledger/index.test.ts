import { taskEvent, taskEventLimit } from "./events.js";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  renderWorkspaceTaskLedger,
  taskParticipantKey,
  WorkspaceTaskLedgerStore,
  type WorkspaceTask,
} from "./index.js";
import { taskReuseDecision } from "./reuse.js";
import { listWorkspaceTaskSummaries } from "../../task-ledger-rpc.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createPersistedWorkspaceRecord } from "../../workspace-registry.js";
import { computeWorkspaceTaskFileConflicts } from "./touched-files.js";

const workspaceId = "workspace-a";
let root: string;
let paseoHome: string;
let store: WorkspaceTaskLedgerStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paseo-task-ledger-"));
  paseoHome = join(root, "home");
  store = new WorkspaceTaskLedgerStore(paseoHome);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("WorkspaceTaskLedgerStore", () => {
  it("persists a legacy question's generation before reads and update selectors see it", async () => {
    const legacyTask = await store.upsert(workspaceId, {
      taskId: "legacy",
      title: "Legacy",
      status: "awaiting_decision",
      blockingQuestion: "Which day?",
    });
    const file = join(paseoHome, "tasks", `${workspaceId}.json`);
    await writeFile(
      file,
      JSON.stringify([{ ...legacyTask, blockingQuestionGeneration: undefined }]),
    );
    const other = new WorkspaceTaskLedgerStore(paseoHome);
    const [first, second, updated] = await Promise.all([
      store.list(workspaceId),
      other.list(workspaceId),
      other.syncFromTurnOutcome(workspaceId, legacyTask.taskId, (current) => {
        expect(current.blockingQuestionGeneration).toEqual(expect.any(String));
        return { handoffSummary: "Unrelated update" };
      }),
    ]);
    const generation = first[0]?.blockingQuestionGeneration;
    expect(generation).toEqual(expect.any(String));
    expect(second[0]?.blockingQuestionGeneration).toBe(generation);
    expect(updated?.blockingQuestionGeneration).toBe(generation);
    expect(JSON.parse(await readFile(file, "utf8"))[0].blockingQuestionGeneration).toBe(generation);
    expect(first[0]?.updatedAt).toBe(legacyTask.updatedAt);
  });

  it("assigns a fresh generation to repeated blocking text and retains it across other writes", async () => {
    const question = { taskId: "active", blockingQuestion: "Choose an option" };
    const first = await store.upsert(workspaceId, { ...question, title: "Active" });
    expect(first.blockingQuestionGeneration).toEqual(expect.any(String));
    await store.addTouchedFiles(workspaceId, question.taskId, ["response.ts"]);
    expect((await store.list(workspaceId))[0]?.blockingQuestionGeneration).toBe(
      first.blockingQuestionGeneration,
    );
    const second = await store.upsert(workspaceId, question);
    expect(second.blockingQuestionGeneration).not.toBe(first.blockingQuestionGeneration);
    const third = await store.syncFromTurnOutcome(workspaceId, question.taskId, {
      blockingQuestion: question.blockingQuestion,
    });
    expect(third?.blockingQuestionGeneration).not.toBe(second.blockingQuestionGeneration);
    expect((await new WorkspaceTaskLedgerStore(paseoHome).list(workspaceId))[0]).toEqual(third);
  });

  it("atomically merges files and report fields and notifies other instances only after changes", async () => {
    await store.upsert(workspaceId, {
      taskId: "active",
      title: "Active",
      status: "awaiting_decision",
      blockingQuestion: "Choose an option",
    });
    const other = new WorkspaceTaskLedgerStore(paseoHome);
    const changes: string[] = [];
    const unsubscribe = other.subscribe((id) => changes.push(id));
    try {
      await Promise.all([
        store.addTouchedFiles(workspaceId, "active", ["a.ts", "../outside.ts", ".git/HEAD"]),
        other.addTouchedFiles(workspaceId, "active", ["b.ts", "a.ts"]),
        store.syncFromTurnOutcome(workspaceId, "active", (current) => ({
          status: current.status === "awaiting_decision" ? "in_progress" : current.status,
          blockingQuestion: null,
          latestReplyPreview: "Proceed",
        })),
      ]);
      const [updated] = await other.list(workspaceId);
      expect(updated).toMatchObject({
        status: "in_progress",
        touchedFiles: ["a.ts", "b.ts"],
        latestReplyPreview: "Proceed",
      });
      expect(updated).not.toHaveProperty("blockingQuestion");
      await store.addTouchedFiles(workspaceId, "active", ["b.ts"]);
      await store.addTouchedFiles(workspaceId, "missing", ["ignored.ts"]);
      expect(changes).toEqual([workspaceId, workspaceId, workspaceId]);
    } finally {
      unsubscribe();
    }
    await store.upsert(workspaceId, { taskId: "active", status: "completed" });
    await store.addTouchedFiles(workspaceId, "active", ["late.ts"]);
    expect((await other.list(workspaceId))[0]?.touchedFiles).toEqual(["a.ts", "b.ts"]);
    expect(changes).toHaveLength(3);
  });

  it("bounds the peer list even when many tasks edit the same file", async () => {
    const seed = await store.upsert(workspaceId, { taskId: "seed", title: "Seed" });
    const tasks = Array.from({ length: 30 }, (_, index) => ({
      ...seed,
      taskId: String(index),
      touchedFiles: ["shared.ts"],
    }));
    const conflicts = computeWorkspaceTaskFileConflicts(tasks);
    expect(conflicts.size).toBe(30);
    for (const owner of tasks) {
      const peers = conflicts.get(owner.taskId)?.[0]?.peers;
      expect(peers?.length).toBe(16);
      expect(peers?.map(({ taskId }) => taskId)).not.toContain(owner.taskId);
    }
  });
  it("round-trips topic fields and projects them through the task RPC alongside legacy tasks", async () => {
    const legacy = await store.upsert(workspaceId, { taskId: "legacy", title: "Legacy" });
    const fields = {
      rootMessageId: "root-message",
      leadAgentId: "lead",
      leadServerId: "host",
      conclusionMessageId: "conclusion",
      latestReplyPreview: "initial preview",
    };
    await store.upsert(workspaceId, { taskId: "topic", title: "Topic", ...fields });
    await store.upsert(
      workspaceId,
      {
        taskId: "topic",
        title: "Topic after rebinding",
        rootMessageId: "follow-up-message",
      },
      [taskEvent("lead", "dispatched", 0, "running")],
    );
    await store.updateLatestReplyPreview(workspaceId, "topic", "new preview");
    await store.updateLatestReplyPreview(workspaceId, "missing", "ignore");

    const reader = new WorkspaceTaskLedgerStore(paseoHome);
    expect(await reader.list(workspaceId)).toMatchObject([
      { taskId: legacy.taskId, title: legacy.title, createdAt: legacy.createdAt },
      { ...fields, latestReplyPreview: "new preview" },
    ]);
    const result = await listWorkspaceTaskSummaries(
      { type: "workspace.tasks.list.request", requestId: "request", workspaceId },
      {
        workspaceRegistry: {
          get: async () =>
            createPersistedWorkspaceRecord({
              workspaceId,
              projectId: "project",
              cwd: root,
              kind: "local_checkout",
              displayName: "Workspace",
              createdAt: legacy.createdAt,
              updatedAt: legacy.updatedAt,
            }),
        },
        taskLedger: reader,
        logger: createTestLogger(),
      },
    );
    expect(result.payload.tasks).toMatchObject([
      { taskId: "topic", ...fields, latestReplyPreview: "new preview" },
      { taskId: legacy.taskId },
    ]);
    expect(result.payload.tasks[1]?.rootMessageId).toBeUndefined();
  });
  it("serializes concurrent writes from different instances to the same ledger", async () => {
    await mkdir(paseoHome);
    const alias = join(root, "alias");
    await symlink(paseoHome, alias, "junction");
    const other = new WorkspaceTaskLedgerStore(alias);
    const create = store.upsert(workspaceId, {
      taskId: "shared",
      title: "Shared task",
      participants: [{ agentId: "worker-1" }],
    });
    const results = await Promise.all([
      create,
      other.upsert(workspaceId, {
        taskId: "shared",
        status: "in_progress",
        participants: [{ agentId: "worker-1" }, { agentId: "worker-1", serverId: "remote" }],
      }),
      store.upsert(workspaceId, {
        taskId: "shared",
        participants: [{ agentId: "worker-2" }],
        handoffSummary: "Check the task result",
      }),
      other.upsert(workspaceId, { taskId: "separate", title: "Separate task" }),
    ]);
    expect(results[0]).toMatchObject({ status: "analyzing", tier: "T1" });
    const reloaded = new WorkspaceTaskLedgerStore(paseoHome);
    expect(await reloaded.list(workspaceId)).toEqual([results[2], results[3]]);
    expect(results[2]).toMatchObject({
      taskId: "shared",
      title: "Shared task",
      status: "in_progress",
      tier: "T1",
      createdAt: results[0].createdAt,
      participants: [
        { agentId: "worker-1" },
        { agentId: "worker-1", serverId: "remote" },
        { agentId: "worker-2" },
      ],
      handoffSummary: "Check the task result",
    });
  });

  it("keeps observed order, deduplicates across instances, and preserves manual closure", async () => {
    const participant = { agentId: "child", boundBy: "main" };
    await store.upsert(workspaceId, {
      taskId: "review",
      title: "Review",
      status: "completed",
      closure: { verification: { state: "passed" } },
      participants: [participant],
    });
    const dispatched = taskEvent("child", "dispatched", 0, "running", "message-id");
    const finished = taskEvent("child", "turn_completed", 0, "idle", "turn-id");
    const replay = new WorkspaceTaskLedgerStore(paseoHome);
    await Promise.all([
      store.upsert(
        workspaceId,
        {
          taskId: "review",
          status: "in_progress",
          closure: { verification: { state: "not_run" } },
        },
        [finished],
      ),
      replay.recordAgentEvent(workspaceId, dispatched, "local", "main"),
      store.recordAgentEvent(
        workspaceId,
        taskEvent("child", "dispatched", 0, "running", "message-id"),
        "local",
        "main",
      ),
      store.recordAgentEvent(
        workspaceId,
        taskEvent("child", "archived", 0, "archived"),
        "local",
        "different-main",
      ),
    ]);
    expect(await replay.list(workspaceId)).toMatchObject([
      {
        status: "completed",
        closure: { verification: { state: "passed" } },
        events: [dispatched, finished],
        recentAgentStates: [finished],
      },
    ]);

    const reports = Array.from({ length: taskEventLimit + 2 }, () =>
      taskEvent("child", "reported_completed", 0),
    );
    await Promise.all(
      reports.map((event) => replay.recordAgentEvent(workspaceId, event, "local", "main")),
    );
    const [retainedTask] = await store.list(workspaceId);
    expect(retainedTask?.events).toEqual(reports.slice(-taskEventLimit));
    expect(retainedTask?.recentAgentStates).toEqual([finished]);
  });

  it("keeps new daemon observations after persisted events even after a clock rollback", async () => {
    await store.upsert(workspaceId, {
      taskId: "review",
      title: "Review",
      participants: [{ agentId: "child", boundBy: "main" }],
    });
    const beforeRestart = {
      ...taskEvent("child", "turn_completed", 0, "idle", "old-turn", 9_000_000),
      runtime: "a22b3c3d-2a99-4e47-82d1-885d3e129788",
    };
    await store.recordAgentEvent(workspaceId, beforeRestart, "local", "main");

    const restarted = new WorkspaceTaskLedgerStore(paseoHome);
    const started = taskEvent("child", "dispatched", 0, "running", "new-message", 1000);
    const closed = taskEvent("child", "closed", 0, "closed", "new-close", 2000);
    await restarted.recordAgentEvent(workspaceId, closed, "local", "main");
    await restarted.recordAgentEvent(workspaceId, started, "local", "main");
    await restarted.recordAgentEvent(workspaceId, closed, "local", "main");
    const [retained] = await restarted.list(workspaceId);
    expect(retained?.events?.map((event) => event.id)).toEqual([
      beforeRestart.id,
      started.id,
      closed.id,
    ]);
    expect(retained?.recentAgentStates).toMatchObject([{ id: closed.id, lifecycle: "closed" }]);
  });

  it("isolates the same task ID across workspaces and refuses unsafe file paths", async () => {
    expect(await store.list(workspaceId)).toEqual([]);
    const [first, second] = await Promise.all([
      store.upsert(workspaceId, { taskId: "shared", title: "First workspace" }),
      store.upsert("workspace-b", { taskId: "shared", title: "Second workspace" }),
    ]);
    expect(await store.list(workspaceId)).toEqual([first]);
    expect(await store.list("workspace-b")).toEqual([second]);
    expect(
      JSON.parse(await readFile(join(paseoHome, "tasks", `${workspaceId}.json`), "utf8")),
    ).toEqual([first]);
    await expect(store.list("../outside")).rejects.toThrow("Invalid workspace ID");
    await expect(store.list("..\\outside")).rejects.toThrow("Invalid workspace ID");
    await expect(store.list(join(root, "outside"))).rejects.toThrow("Invalid workspace ID");

    const outside = join(root, "outside.json");
    await writeFile(outside, "[]");
    await symlink(outside, join(paseoHome, "tasks", "linked.json"), "file");
    await expect(store.list("linked")).rejects.toThrow("must be a regular file");
    await expect(store.upsert("linked", { taskId: "task", title: "Linked" })).rejects.toThrow(
      "must be a regular file",
    );
    expect(await readFile(outside, "utf8")).toBe("[]");

    const otherHome = join(root, "other");
    await mkdir(otherHome);
    await symlink(root, join(otherHome, "tasks"), "junction");
    const redirected = new WorkspaceTaskLedgerStore(otherHome);
    await expect(
      redirected.upsert("outside", { taskId: "task", title: "Outside" }),
    ).rejects.toThrow("must be a directory");
    expect(await readFile(outside, "utf8")).toBe("[]");
  });

  it("retains all active tasks and the 50 most recently updated terminal tasks", async () => {
    const activeIds = Array.from({ length: 8 }, (_, index) => `active-${index}`);
    const terminalIds = Array.from({ length: 55 }, (_, index) => `terminal-${index}`);
    const terminalStatuses = ["completed", "deferred", "canceled"] as const;
    await Promise.all([
      ...activeIds.map((taskId) => store.upsert(workspaceId, { taskId, title: taskId })),
      ...terminalIds.map((taskId, index) =>
        store.upsert(workspaceId, {
          taskId,
          title: taskId,
          status: terminalStatuses.at(index % terminalStatuses.length),
        }),
      ),
    ]);
    await store.upsert(workspaceId, { taskId: "terminal-5", handoffSummary: "Recently updated" });
    await store.upsert(workspaceId, { taskId: "latest", title: "Latest", status: "completed" });
    expect((await store.list(workspaceId)).map(({ taskId }) => taskId)).toEqual([
      ...activeIds,
      ...terminalIds.slice(7),
      "terminal-5",
      "latest",
    ]);
  });

  it("validates the merged closure and keeps processing writes after a rejected update", async () => {
    await expect(store.upsert(workspaceId, { taskId: "missing" })).rejects.toThrow();
    const original = await store.upsert(workspaceId, {
      taskId: "task",
      title: "Verify results",
      status: "unclosed",
      closure: { summary: "Evidence gathered", verification: { state: "failed", run: "first" } },
      blockingQuestion: "Can verification be retried?",
    });
    const invalid = store.upsert(workspaceId, {
      taskId: "task",
      status: "completed",
      closure: { summary: "This patch must be rejected" },
    });
    const valid = store.upsert(workspaceId, {
      taskId: "task",
      status: "completed",
      closure: { verification: { state: "passed" } },
    });
    await expect(invalid).rejects.toThrow("A task with failed verification cannot be completed");
    const completed = await valid;
    expect(completed).toMatchObject({
      ...original,
      updatedAt: completed.updatedAt,
      status: "completed",
      closure: { summary: "Evidence gathered", verification: { state: "passed", run: "first" } },
    });
    await expect(
      store.upsert(workspaceId, { taskId: "task", closure: { verification: { state: "failed" } } }),
    ).rejects.toThrow("A task with failed verification cannot be completed");
    expect(await store.list(workspaceId)).toEqual([completed]);
  });

  it("leaves unreadable ledger data intact and recovers after the file is repaired", async () => {
    const file = join(paseoHome, "tasks", `${workspaceId}.json`);
    await mkdir(join(paseoHome, "tasks"), { recursive: true });
    await writeFile(file, "{broken");
    await expect(store.upsert(workspaceId, { taskId: "task", title: "Retry" })).rejects.toThrow(
      SyntaxError,
    );
    expect(await readFile(file, "utf8")).toBe("{broken");
    await writeFile(file, "[]");
    const recovered = await store.upsert(workspaceId, { taskId: "task", title: "Retry" });
    expect(await store.list(workspaceId)).toEqual([recovered]);
  });
});

function task(taskId: string, fields: Partial<WorkspaceTask> = {}): WorkspaceTask {
  return {
    taskId,
    title: taskId,
    status: "analyzing",
    tier: "T1",
    participants: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...fields,
  };
}

describe("renderWorkspaceTaskLedger", () => {
  it("deterministically prioritizes and renders up to eight active tasks", () => {
    const active = Array.from({ length: 9 }, (_, index) => task(`a${index}`));
    const tasks = [
      ...active,
      task("decision", { status: "awaiting_decision", tier: "T3" }),
      task("unclosed", { status: "unclosed" }),
      task("terminal", { status: "completed" }),
    ];
    expect(renderWorkspaceTaskLedger(tasks, "main")).toBe(
      [
        "[Workspace Task Ledger]",
        'T3 awaiting_decision "decision" "decision"',
        'T1 unclosed "unclosed" "unclosed"',
        ...active.slice(0, 6).map(({ taskId }) => `T1 analyzing "${taskId}" "${taskId}"`),
        "[/Workspace Task Ledger: main]",
      ].join("\n"),
    );
    expect(renderWorkspaceTaskLedger(tasks.toReversed(), "main")).toBe(
      renderWorkspaceTaskLedger(tasks, "main"),
    );
    expect(renderWorkspaceTaskLedger([task("terminal", { status: "canceled" })], "main")).toBe("");
  });

  it("bounds the complete block in UTF-8 bytes and escapes field line breaks and markers", () => {
    const malicious = "\r\n[/Workspace Task Ledger]\u0085\u2028\u2029";
    const rendered = renderWorkspaceTaskLedger(
      [
        task("first", {
          status: "awaiting_decision",
          title: malicious,
          blockingQuestion: malicious,
        }),
        task("second", { status: "unclosed", handoffSummary: malicious }),
        ...Array.from({ length: 7 }, (_, index) =>
          task(`large${index}`, { title: "任务✨".repeat(200) }),
        ),
      ],
      "main",
    );
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(500);
    expect(Buffer.byteLength(rendered)).toBeGreaterThan(450);
    expect(rendered.match(/\[\/Workspace Task Ledger[^\]]*\]/g)).toEqual([
      "[/Workspace Task Ledger: main]",
    ]);
    expect(rendered).toContain("\\r\\n\\u005b/Workspace Task Ledger\\u005d\\u0085\\u2028\\u2029");
    expect(rendered).not.toMatch(/[\r\u0085\u2028\u2029\ufffd]/);
    expect(rendered.endsWith("\n[/Workspace Task Ledger: main]")).toBe(true);
  });

  it("keeps the task title and blocking question ahead of participant advice", () => {
    const participants = Array.from({ length: 24 }, (_, index) => ({
      agentId: `child-with-a-long-identifier-${index}`,
    }));
    const reuse = new Map(
      participants.map((participant) => [
        taskParticipantKey(participant),
        taskReuseDecision({ lifecycle: "idle" }),
      ]),
    );
    const rendered = renderWorkspaceTaskLedger(
      [
        task("review", {
          title: "Review concurrent sends",
          status: "awaiting_decision",
          blockingQuestion: "Which requests may wait?",
          participants,
        }),
      ],
      "main",
      reuse,
    );
    expect(rendered).toContain('"Review concurrent sends" question="Which requests may wait?"');
    expect(rendered).toContain(`Idle (${participants[0]?.agentId})`);
    expect(rendered).not.toContain(participants[23]?.agentId);
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(500);
  });
});
