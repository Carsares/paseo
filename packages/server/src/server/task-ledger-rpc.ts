import type { Logger } from "pino";
import type {
  SessionInboundMessage,
  SessionOutboundMessage,
  WorkspaceTaskFileConflict,
  WorkspaceTaskSummary,
} from "@getpaseo/protocol/messages";
import { compareTaskEvents, type TaskEvent } from "./agent/task-ledger/events.js";
import type { WorkspaceTask, WorkspaceTaskLedgerStore } from "./agent/task-ledger/index.js";
import { computeWorkspaceTaskFileConflicts } from "./agent/task-ledger/touched-files.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";

type ListRequest = Extract<SessionInboundMessage, { type: "workspace.tasks.list.request" }>;
type ListResponse = Extract<SessionOutboundMessage, { type: "workspace.tasks.list.response" }>;

function summarizeEvent({ agentId, kind, at, lifecycle }: TaskEvent) {
  return { agentId, kind, at, lifecycle };
}

function findLatestTaskProgress(task: WorkspaceTask): TaskEvent | undefined {
  let latest: TaskEvent | undefined;
  // Reports can lack a lifecycle. Retain their order across daemon restarts and clock changes.
  for (const event of [...(task.events ?? []), ...(task.recentAgentStates ?? [])]) {
    if (!latest || compareTaskEvents(event, latest) > 0) latest = event;
  }
  return latest;
}

export function taskSummary(
  task: WorkspaceTask,
  fileConflicts?: WorkspaceTaskFileConflict[],
): WorkspaceTaskSummary {
  const latest = findLatestTaskProgress(task);
  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    tier: task.tier,
    participants: task.participants.map(({ agentId, serverId, boundBy }) => ({
      agentId,
      serverId,
      boundBy,
    })),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    handoffSummary: task.handoffSummary,
    blockingQuestion: task.blockingQuestion,
    ...(task.blockingQuestion !== undefined && task.blockingQuestionGeneration !== undefined
      ? { blockingQuestionGeneration: task.blockingQuestionGeneration }
      : {}),
    verificationState: task.closure?.verification?.state,
    recentAgentStates: task.recentAgentStates?.map(summarizeEvent),
    latestProgress: latest ? summarizeEvent(latest) : undefined,
    rootMessageId: task.rootMessageId,
    leadAgentId: task.leadAgentId,
    leadServerId: task.leadServerId,
    conclusionMessageId: task.conclusionMessageId,
    latestReplyPreview: task.latestReplyPreview,
    ...(task.touchedFiles?.length ? { touchedFiles: task.touchedFiles } : {}),
    ...(fileConflicts?.length ? { fileConflicts } : {}),
  };
}

export function summarizeWorkspaceTasks(tasks: readonly WorkspaceTask[]): WorkspaceTaskSummary[] {
  const conflicts = computeWorkspaceTaskFileConflicts(tasks);
  return tasks.toReversed().map((task) => taskSummary(task, conflicts.get(task.taskId)));
}

export async function listWorkspaceTaskSummaries(
  { requestId, workspaceId }: ListRequest,
  {
    workspaceRegistry,
    taskLedger,
    logger,
  }: {
    workspaceRegistry: Pick<WorkspaceRegistry, "get">;
    taskLedger: Pick<WorkspaceTaskLedgerStore, "list">;
    logger: Pick<Logger, "warn">;
  },
): Promise<ListResponse> {
  const reply = (tasks: WorkspaceTaskSummary[], error: string | null): ListResponse => ({
    type: "workspace.tasks.list.response",
    payload: { requestId, workspaceId, tasks, error },
  });
  try {
    if (!(await workspaceRegistry.get(workspaceId))) {
      return reply([], "Workspace not found");
    }
    const tasks = await taskLedger.list(workspaceId);
    return reply(summarizeWorkspaceTasks(tasks), null);
  } catch (error) {
    logger.warn(
      { workspaceId, errorName: error instanceof Error ? error.name : "unknown" },
      "Failed to read workspace task ledger",
    );
    return reply([], "Could not read the workspace task ledger");
  }
}
