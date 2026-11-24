import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type {
  DaemonClient,
  FetchWorkspacesEntry,
  FetchWorkspacesOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceTaskSummary } from "@getpaseo/protocol/messages";
import { Command } from "commander";
import {
  withOutput,
  type CommandError,
  type CommandOptions,
  type CommandResult,
} from "../../output/index.js";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { taskListSchema, taskDetailSchema } from "./presentation.js";

interface TaskOptions extends CommandOptions {
  workspace?: string;
}

type TaskSelection = { kind: "list" } | { kind: "show"; taskId: string };

interface WorkspacePage {
  entries: Pick<FetchWorkspacesEntry, "id" | "workspaceDirectory">[];
  pageInfo: { nextCursor: string | null };
}

interface TaskClient extends Pick<
  DaemonClient,
  "close" | "supportsWorkspaceTaskLedger" | "listWorkspaceTasks"
> {
  fetchWorkspaces(options: FetchWorkspacesOptions): Promise<WorkspacePage>;
}

interface TaskCommandDeps {
  connect(options: ConnectOptions): Promise<TaskClient>;
  cwd(): string;
}

function resolveLocalDirectory(path: string): Promise<string> {
  const directory = resolve(path);
  // Keep matching by the recorded path if a directory cannot be read or no longer exists.
  return realpath(directory).catch(() => directory);
}

function matchesWorkspaceDirectory(directory: string, workspaceDirectory: string, home: string) {
  if (directory === workspaceDirectory) return true;
  if (workspaceDirectory === home) return false;
  const prefix = workspaceDirectory.endsWith(sep) ? workspaceDirectory : workspaceDirectory + sep;
  return directory.startsWith(prefix);
}

async function resolveTaskWorkspaceId(
  client: TaskClient,
  options: TaskOptions,
  cwd: () => string,
): Promise<string> {
  if (options.workspace !== undefined) {
    const id = options.workspace.trim();
    if (id) return id;
    throw {
      code: "INVALID_WORKSPACE_ID",
      message: "--workspace requires a workspace ID.",
    } satisfies CommandError;
  }

  const resolveDirectory =
    options.daemonTarget.kind === "instance" ? resolveLocalDirectory : resolve;
  const [directory, home] = await Promise.all([
    resolveDirectory(cwd()),
    resolveDirectory(homedir()),
  ]);
  let bestDirectory: string | undefined;
  const bestIds = new Set<string>();
  let cursor: string | undefined;
  do {
    const payload = await client.fetchWorkspaces({
      // The directory pager uses workspace ID to break ties within each project.
      sort: [{ key: "project_id", direction: "asc" }],
      page: { limit: 200, cursor },
    });
    const workspaces = await Promise.all(
      payload.entries.map(async ({ id, workspaceDirectory }) => ({
        id,
        directory: await resolveDirectory(workspaceDirectory),
      })),
    );
    for (const { id, directory: workspaceDirectory } of workspaces) {
      if (!matchesWorkspaceDirectory(directory, workspaceDirectory, home)) continue;
      // All matches lie on one path, so the longest directory is the most specific.
      if (bestDirectory === undefined || workspaceDirectory.length > bestDirectory.length) {
        bestDirectory = workspaceDirectory;
        bestIds.clear();
      }
      if (workspaceDirectory === bestDirectory) bestIds.add(id);
    }
    cursor = payload.pageInfo.nextCursor ?? undefined;
  } while (cursor);

  if (bestIds.size > 1) {
    throw {
      code: "WORKSPACE_AMBIGUOUS",
      message: `Multiple workspaces use ${bestDirectory}.`,
      details: "Pass --workspace <id> to select one.",
    } satisfies CommandError;
  }
  const [workspaceId] = bestIds;
  if (workspaceId !== undefined) return workspaceId;
  throw {
    code: "WORKSPACE_NOT_FOUND",
    message: `No Paseo workspace found for ${directory}.`,
    details: "Run from a workspace directory or pass --workspace <id>.",
  } satisfies CommandError;
}

export async function runTaskCommand(
  options: TaskOptions,
  selection: TaskSelection,
  deps: TaskCommandDeps = { connect: connectToDaemon, cwd: process.cwd },
): Promise<CommandResult<WorkspaceTaskSummary>> {
  const client = await deps.connect({ target: options.daemonTarget });
  try {
    if (!client.supportsWorkspaceTaskLedger()) {
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to view workspace tasks.",
      } satisfies CommandError;
    }
    const workspaceId = await resolveTaskWorkspaceId(client, options, deps.cwd);
    const tasks = await client.listWorkspaceTasks(workspaceId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw {
        code: "TASK_LIST_FAILED",
        message: `Cannot load tasks for workspace ${workspaceId}: ${message}`,
      } satisfies CommandError;
    });
    if (selection.kind === "list") {
      return { type: "list", data: tasks, schema: taskListSchema };
    }

    const task = tasks.find((entry) => entry.taskId === selection.taskId);
    if (!task) {
      throw {
        code: "TASK_NOT_FOUND",
        message: `Task ${selection.taskId} was not found in workspace ${workspaceId}.`,
      } satisfies CommandError;
    }
    return { type: "single", data: task, schema: taskDetailSchema(workspaceId) };
  } finally {
    await client.close().catch(() => {});
  }
}

function addTaskOptions(command: Command): Command {
  return addJsonAndDaemonHostOptions(command).option(
    "--workspace <id>",
    "Workspace ID (default: workspace containing the current directory)",
  );
}

export function createTaskCommand(): Command {
  const task = new Command("task").description("View workspace tasks");

  addTaskOptions(task.command("ls").description("List workspace tasks")).action(
    withOutput((options: TaskOptions, _command: Command) =>
      runTaskCommand(options, { kind: "list" }),
    ),
  );
  addTaskOptions(
    task
      .command("show")
      .description("Show the complete summary of a workspace task")
      .argument("<task-id>", "Exact task ID")
      .allowExcessArguments(false),
  ).action(
    withOutput((taskId: string, options: TaskOptions, _command: Command) =>
      runTaskCommand(options, { kind: "show", taskId }),
    ),
  );
  return task;
}
