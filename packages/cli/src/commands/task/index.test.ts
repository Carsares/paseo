import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import type { WorkspaceTaskSummary } from "@getpaseo/protocol/messages";
import { expect, it, onTestFinished } from "vitest";
import { createCli } from "../../cli.js";
import { render } from "../../output/index.js";
import { runTaskCommand } from "./index.js";

const cwd = resolve("example-workspace");
const otherDirectory = resolve("example-workspace-other");
const daemonTarget = { kind: "endpoint", host: "example.test:6767" } as const;
const createdAt = "2026-11-23T10:00:00.000Z";
const updatedAt = "2026-11-23T11:00:00.000Z";
const task: WorkspaceTaskSummary = {
  taskId: "code-review",
  title: "Review CLI release",
  status: "awaiting_decision",
  tier: "T2",
  participants: [
    { agentId: "lead" },
    { agentId: "reviewer", serverId: "review-host", boundBy: "lead" },
  ],
  createdAt,
  updatedAt,
  handoffSummary: "Reproduced the issue.\nRetest after updating the runtime.",
  blockingQuestion: "Which runtime ships?",
  verificationState: "not_run",
  recentAgentStates: [
    { agentId: "lead", kind: "dispatched", at: createdAt, lifecycle: "running" },
    { agentId: "reviewer", kind: "reported_blocked", at: updatedAt },
  ],
};

type TaskCommandDeps = NonNullable<Parameters<typeof runTaskCommand>[2]>;
type TaskClient = Awaited<ReturnType<TaskCommandDeps["connect"]>>;
type WorkspacePage = Awaited<ReturnType<TaskClient["fetchWorkspaces"]>>;

function host({
  currentDirectory = cwd,
  pages = [],
  tasks = [task],
  supported = true,
  readError,
}: {
  currentDirectory?: string;
  pages?: WorkspacePage["entries"][];
  tasks?: WorkspaceTaskSummary[];
  supported?: boolean;
  readError?: Error;
} = {}) {
  const reads: string[] = [];
  const workspaceRequests: Parameters<TaskClient["fetchWorkspaces"]>[0][] = [];
  const targets: Parameters<TaskCommandDeps["connect"]>[0][] = [];
  let closed = 0;
  const deps: TaskCommandDeps = {
    cwd: () => currentDirectory,
    connect: async (options) => {
      targets.push(options);
      return {
        supportsWorkspaceTaskLedger: () => supported,
        fetchWorkspaces: async (request) => {
          workspaceRequests.push(request);
          const { page } = request;
          const index = Number(page?.cursor ?? 0);
          return {
            entries: pages[index] ?? [],
            pageInfo: { nextCursor: index + 1 < pages.length ? String(index + 1) : null },
          };
        },
        listWorkspaceTasks: async (workspaceId) => {
          reads.push(workspaceId);
          if (readError) throw readError;
          return tasks;
        },
        close: async () => {
          closed++;
        },
      };
    },
  };
  return { deps, reads, workspaceRequests, targets, closed: () => closed };
}

async function linkedWorkspace() {
  const temp = await mkdtemp(resolve(tmpdir(), "paseo-task-"));
  onTestFinished(() => rm(temp, { recursive: true, force: true }));
  const root = await realpath(temp);
  const directory = resolve(root, "workspace");
  const alias = resolve(root, "workspace-link");
  const child = resolve(directory, "src");
  await mkdir(child, { recursive: true });
  await symlink(directory, alias, "junction");
  return { root, directory, alias, child };
}

it("registers both subcommands and parses workspace, host and JSON flags", async () => {
  for (const args of [["ls"], ["show", task.taskId]]) {
    const cli = createCli();
    const stop = new Error("Stop before connecting");
    cli.hook("preAction", (_program, command) => {
      expect(command.name()).toBe(args[0]);
      expect(command.parent?.name()).toBe("task");
      expect(command.args).toEqual(args.slice(1));
      expect(command.optsWithGlobals()).toMatchObject({
        workspace: "selected",
        host: daemonTarget.host,
        json: true,
      });
      throw stop;
    });
    await expect(
      cli.parseAsync(
        ["task", ...args, "--workspace", "selected", "--host", daemonTarget.host, "--json"],
        {
          from: "user",
        },
      ),
    ).rejects.toBe(stop);
  }
});

it("uses the same activity-independent sort on every workspace page", async () => {
  const daemon = host({
    pages: [
      [
        { id: "outer-1", workspaceDirectory: resolve(cwd, "..") },
        { id: "outer-2", workspaceDirectory: resolve(cwd, "..") },
      ],
      [{ id: "current", workspaceDirectory: cwd }],
    ],
  });
  const result = await runTaskCommand({ daemonTarget }, { kind: "list" }, daemon.deps);
  const table = render(result, { noColor: true });
  expect(table).toMatch(/awaiting decision +Review CLI release +code-review +T2 +2/);
  expect(table).toContain("Blocked: Which runtime ships?");
  expect(JSON.parse(render(result, { format: "json" }))).toEqual([task]);
  expect(daemon.targets).toEqual([{ target: daemonTarget }]);
  expect(daemon.workspaceRequests).toEqual([
    { sort: [{ key: "project_id", direction: "asc" }], page: { limit: 200, cursor: undefined } },
    { sort: [{ key: "project_id", direction: "asc" }], page: { limit: 200, cursor: "1" } },
  ]);
  expect(daemon.reads).toEqual(["current"]);
  expect(daemon.closed()).toBe(1);
});

it("uses the deepest workspace enclosing a subdirectory across pages", async () => {
  const nestedWorkspace = resolve(cwd, "packages", "app");
  const daemon = host({
    currentDirectory: resolve(nestedWorkspace, "src"),
    pages: [
      [{ id: "outer", workspaceDirectory: cwd }],
      [{ id: "nested", workspaceDirectory: nestedWorkspace }],
    ],
  });
  await runTaskCommand({ daemonTarget }, { kind: "list" }, daemon.deps);
  expect(daemon.reads).toEqual(["nested"]);
});

it("finds a local workspace recorded with a symlink from its real subdirectory", async () => {
  const { root, alias, child } = await linkedWorkspace();
  const daemon = host({
    currentDirectory: child,
    pages: [[{ id: "linked", workspaceDirectory: alias }]],
  });
  const localOptions = { daemonTarget: { kind: "instance" as const, home: root } };
  await runTaskCommand(localOptions, { kind: "list" }, daemon.deps);
  expect(daemon.reads).toEqual(["linked"]);
});

it("rejects different local workspace IDs that resolve to the same real directory", async () => {
  const { root, directory, alias, child } = await linkedWorkspace();
  const daemon = host({
    currentDirectory: child,
    pages: [
      [{ id: "real", workspaceDirectory: directory }],
      [{ id: "linked", workspaceDirectory: alias }],
    ],
  });
  const localOptions = { daemonTarget: { kind: "instance" as const, home: root } };
  await expect(runTaskCommand(localOptions, { kind: "list" }, daemon.deps)).rejects.toMatchObject({
    code: "WORKSPACE_AMBIGUOUS",
    details: "Pass --workspace <id> to select one.",
  });
  expect(daemon.reads).toEqual([]);
  expect(daemon.closed()).toBe(1);
});

it.each([daemonTarget.host, "127.0.0.1:6767", "unix:///tmp/paseo-task.sock"])(
  "matches workspace paths from --host %s as text even when a local symlink exists",
  async (endpoint) => {
    const { directory, alias, child } = await linkedWorkspace();
    const daemon = host({
      currentDirectory: child,
      pages: [
        [
          { id: "remote-actual", workspaceDirectory: directory },
          { id: "remote-link", workspaceDirectory: alias },
        ],
      ],
    });
    await runTaskCommand(
      { daemonTarget: { kind: "endpoint", host: endpoint } },
      { kind: "list" },
      daemon.deps,
    );
    expect(daemon.reads).toEqual(["remote-actual"]);
  },
);

it("asks for an ID when the deepest enclosing directory has multiple workspaces", async () => {
  const nestedWorkspace = resolve(cwd, "packages", "app");
  const daemon = host({
    currentDirectory: resolve(nestedWorkspace, "src"),
    pages: [
      [
        { id: "outer", workspaceDirectory: cwd },
        { id: "nested-1", workspaceDirectory: nestedWorkspace },
      ],
      [{ id: "nested-2", workspaceDirectory: nestedWorkspace }],
    ],
  });
  await expect(
    runTaskCommand({ daemonTarget }, { kind: "list" }, daemon.deps),
  ).rejects.toMatchObject({
    code: "WORKSPACE_AMBIGUOUS",
    details: "Pass --workspace <id> to select one.",
  });
  expect(daemon.reads).toEqual([]);
  expect(daemon.closed()).toBe(1);
});

it("only selects a workspace at home when the current directory matches home exactly", async () => {
  const workspaceDirectory = homedir();
  const pages = [[{ id: "home", workspaceDirectory }]];
  const child = host({ currentDirectory: resolve(workspaceDirectory, "child"), pages });
  await expect(
    runTaskCommand({ daemonTarget }, { kind: "list" }, child.deps),
  ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  expect(child.reads).toEqual([]);

  const exact = host({ currentDirectory: workspaceDirectory, pages });
  await runTaskCommand({ daemonTarget }, { kind: "list" }, exact.deps);
  expect(exact.reads).toEqual(["home"]);
});

it("uses an explicit workspace without directory lookup and shows the complete task", async () => {
  const daemon = host();
  const result = await runTaskCommand(
    { daemonTarget, workspace: "selected" },
    { kind: "show", taskId: task.taskId },
    daemon.deps,
  );
  const detail = render(result, { noColor: true });
  expect(detail).toContain("Workspace: selected");
  expect(detail).toContain("reviewer (server: review-host) (bound by: lead)");
  expect(detail).toContain("Handoff: Reproduced the issue.\n  Retest after updating the runtime.");
  expect(detail).toContain("Blocking question: Which runtime ships?");
  expect(detail).toContain("Verification: not run");
  expect(detail).toContain(`${createdAt} lead: dispatched (running)`);
  expect(detail).toContain(`${updatedAt} reviewer: reported_blocked`);
  expect(JSON.parse(render(result, { format: "json" }))).toEqual(task);
  expect(daemon.workspaceRequests).toEqual([]);
  expect(daemon.reads).toEqual(["selected"]);
  expect(daemon.closed()).toBe(1);
});

it("reads older summaries without agent events", async () => {
  const { taskId, title, status, tier } = task;
  const legacyTask = { taskId, title, status, tier, participants: [], createdAt, updatedAt };
  const daemon = host({ tasks: [legacyTask] });
  const result = await runTaskCommand(
    { daemonTarget, workspace: "selected" },
    { kind: "show", taskId },
    daemon.deps,
  );
  expect(render(result, { noColor: true })).toContain("Participants: none");
  expect(JSON.parse(render(result, { format: "json" }))).toEqual(legacyTask);
});

it("shows server-selected progress even if a participant state has a later timestamp", async () => {
  const latestProgress = {
    agentId: "reviewer",
    kind: "turn_completed",
    at: createdAt,
    lifecycle: "idle",
  };
  const taskWithProgress = { ...task, latestProgress } satisfies WorkspaceTaskSummary;
  const daemon = host({ tasks: [taskWithProgress] });
  const options = { daemonTarget, workspace: "selected" };
  const list = await runTaskCommand(options, { kind: "list" }, daemon.deps);
  expect(render(list, { noColor: true })).toContain("turn completed (idle)");

  const show = await runTaskCommand(options, { kind: "show", taskId: task.taskId }, daemon.deps);
  const detail = render(show, { noColor: true });
  expect(detail).toContain(`\nLatest progress: turn completed (idle) at ${createdAt}\n`);
  expect(detail).toContain(`${updatedAt} reviewer: reported_blocked`);
  expect(detail).toContain("reviewer (server: review-host)");
  expect(JSON.parse(render(show, { format: "json" }))).toEqual(taskWithProgress);
});

it("does not turn participant history into task progress when older hosts omit latestProgress", async () => {
  const taskWithoutProgress = {
    ...task,
    blockingQuestion: undefined,
    handoffSummary: undefined,
    verificationState: undefined,
  };
  const daemon = host({ tasks: [taskWithoutProgress] });
  const result = await runTaskCommand(
    { daemonTarget, workspace: "selected" },
    { kind: "list" },
    daemon.deps,
  );
  const table = render(result, { noColor: true });
  expect(table).toMatch(/—\s*$/u);
  expect(table).not.toContain("reported blocked");
});

it("offers an update on an older host before requesting any workspace data", async () => {
  const daemon = host({ supported: false });
  await expect(runTaskCommand({ daemonTarget }, { kind: "list" }, daemon.deps)).rejects.toEqual({
    code: "DAEMON_UPDATE_REQUIRED",
    message: "Update the host to view workspace tasks.",
  });
  expect(daemon.workspaceRequests).toEqual([]);
  expect(daemon.reads).toEqual([]);
  expect(daemon.closed()).toBe(1);
});

it("rejects two matching workspace IDs even when they are on different pages", async () => {
  const daemon = host({
    pages: [
      [{ id: "first", workspaceDirectory: cwd }],
      [{ id: "second", workspaceDirectory: cwd }],
    ],
  });
  await expect(
    runTaskCommand({ daemonTarget }, { kind: "list" }, daemon.deps),
  ).rejects.toMatchObject({
    code: "WORKSPACE_AMBIGUOUS",
    details: "Pass --workspace <id> to select one.",
  });
  expect(daemon.reads).toEqual([]);
  expect(daemon.closed()).toBe(1);
});

it("rejects a directory sharing a workspace's name prefix", async () => {
  const currentDirectory = resolve(otherDirectory, "src");
  const daemon = host({
    currentDirectory,
    pages: [[{ id: "other", workspaceDirectory: cwd }]],
  });
  await expect(
    runTaskCommand({ daemonTarget }, { kind: "list" }, daemon.deps),
  ).rejects.toMatchObject({
    code: "WORKSPACE_NOT_FOUND",
    message: `No Paseo workspace found for ${currentDirectory}.`,
  });
  expect(daemon.reads).toEqual([]);
  expect(daemon.closed()).toBe(1);
});

it("reports a missing exact task ID in the selected workspace", async () => {
  const daemon = host();
  await expect(
    runTaskCommand(
      { daemonTarget, workspace: "selected" },
      { kind: "show", taskId: "code" },
      daemon.deps,
    ),
  ).rejects.toMatchObject({
    code: "TASK_NOT_FOUND",
    message: "Task code was not found in workspace selected.",
  });
  expect(daemon.closed()).toBe(1);
});

it("preserves the host's read error and closes the connection", async () => {
  const daemon = host({ readError: new Error("Task ledger is not accessible") });
  await expect(
    runTaskCommand({ daemonTarget, workspace: "selected" }, { kind: "list" }, daemon.deps),
  ).rejects.toMatchObject({
    code: "TASK_LIST_FAILED",
    message: "Cannot load tasks for workspace selected: Task ledger is not accessible",
  });
  expect(daemon.closed()).toBe(1);
});
