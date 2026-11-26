import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { normalizePathForIdentity } from "../../../utils/path.js";
import { writeJsonFileAtomic } from "../../atomic-file.js";
import {
  compareTaskEvents,
  mergeTaskEvents,
  orderTaskEvents,
  taskEventLimit,
  type TaskEvent,
  TaskEventSchema,
} from "./events.js";
import { isTaskParticipantAddress, type TaskReuseDecision } from "./reuse.js";
import {
  isActiveWorkspaceTask,
  isNormalizedTouchedFile,
  mergeTouchedFiles,
  TASK_TOUCHED_FILE_LIMIT,
} from "./touched-files.js";

const TaskStatusSchema = z.enum([
  "analyzing",
  "awaiting_decision",
  "in_progress",
  "verifying",
  "unclosed",
  "completed",
  "deferred",
  "canceled",
]);
const TaskTierSchema = z.enum(["T1", "T2", "T3"]);
const TaskTitleSchema = z.string().trim().min(1);

export const WorkspaceTaskParticipantSchema = z.object({
  agentId: z.string().min(1),
  serverId: z.string().min(1).optional(),
  boundBy: z.string().min(1).optional(),
});

const TaskVerificationSchema = z
  .object({ state: z.enum(["failed", "passed", "not_run", "blocked", "skipped"]) })
  .catchall(z.json());
const TaskClosureSchema = z
  .object({ verification: TaskVerificationSchema.optional() })
  .catchall(z.json());

export const WorkspaceTaskUpsertSchema = z.object({
  taskId: z.string().min(1),
  title: TaskTitleSchema.optional(),
  status: TaskStatusSchema.optional(),
  tier: TaskTierSchema.optional(),
  participants: z.array(WorkspaceTaskParticipantSchema).optional(),
  closure: TaskClosureSchema.optional(),
  handoffSummary: z.string().optional(),
  blockingQuestion: z.string().optional(),
  rootMessageId: z.string().min(1).optional(),
  leadAgentId: z.string().min(1).optional(),
  leadServerId: z.string().min(1).optional(),
  conclusionMessageId: z.string().min(1).optional(),
  latestReplyPreview: z.string().optional(),
});

const boundedText = (bytes: number) =>
  z
    .string()
    .refine((text) => Buffer.byteLength(text) <= bytes, `Must be at most ${bytes} UTF-8 bytes`);

export const WorkspaceTaskToolInputSchema = WorkspaceTaskUpsertSchema.omit({
  participants: true,
  rootMessageId: true,
  leadAgentId: true,
  leadServerId: true,
  conclusionMessageId: true,
  latestReplyPreview: true,
})
  .extend({
    taskId: boundedText(128).pipe(z.string().min(1)),
    title: boundedText(512).pipe(TaskTitleSchema).optional(),
    handoffSummary: boundedText(1024).optional(),
    blockingQuestion: boundedText(1024).optional(),
    closure: TaskClosureSchema.refine(
      (closure) => Buffer.byteLength(JSON.stringify(closure)) <= 4096,
      "Closure must be at most 4096 UTF-8 bytes",
    ).optional(),
  })
  .strict();

export const TASK_PENDING_SILENT_REPORT_LIMIT = 32;

const WorkspaceTaskSchema = WorkspaceTaskUpsertSchema.extend({
  title: TaskTitleSchema,
  status: TaskStatusSchema,
  tier: TaskTierSchema,
  participants: z.array(WorkspaceTaskParticipantSchema),
  events: z.array(TaskEventSchema).optional(),
  recentAgentStates: z.array(TaskEventSchema).optional(),
  blockingQuestionGeneration: z.uuid().optional(),
  silentReportIds: z.array(z.string().min(1)).max(TASK_PENDING_SILENT_REPORT_LIMIT).optional(),
  touchedFiles: z
    .array(z.string().refine(isNormalizedTouchedFile))
    .max(TASK_TOUCHED_FILE_LIMIT)
    .optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).refine((task) => task.status !== "completed" || task.closure?.verification?.state !== "failed", {
  path: ["closure", "verification", "state"],
  message: "A task with failed verification cannot be completed",
});

export type WorkspaceTask = z.infer<typeof WorkspaceTaskSchema>;
type WorkspaceTaskUpsert = z.input<typeof WorkspaceTaskUpsertSchema>;
type WorkspaceTaskParticipant = z.infer<typeof WorkspaceTaskParticipantSchema>;

const TurnOutcomePatchSchema = WorkspaceTaskUpsertSchema.pick({
  status: true,
  handoffSummary: true,
  latestReplyPreview: true,
})
  .extend({
    blockingQuestion: z.string().nullable().optional(),
    blockingQuestionClearedBy: z.uuid().optional(),
    silentReportId: z.string().min(1).optional(),
    touchedFiles: z.array(z.string()).optional(),
  })
  .refine(
    (patch) => patch.blockingQuestionClearedBy === undefined || patch.blockingQuestion === null,
    "A blocking question must be cleared to record its resolution",
  );
export type WorkspaceTaskTurnOutcomePatch = z.input<typeof TurnOutcomePatchSchema>;
type SelectTurnOutcomePatch = (
  task: Readonly<WorkspaceTask>,
  tasks: readonly Readonly<WorkspaceTask>[],
) => WorkspaceTaskTurnOutcomePatch | null;

const WorkspaceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (id) => !/[^a-z\d_-]/i.test(id) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id),
    "Invalid workspace ID for a task ledger file",
  );
const WorkspaceTasksSchema = z.array(WorkspaceTaskSchema);
const pendingByFile = new Map<string, Promise<void>>();
type TaskLedgerListener = (workspaceId: string) => void;
const listenersByDirectory = new Map<string, Set<TaskLedgerListener>>();
const terminalLimit = 50;

function serializeFile<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const result = (pendingByFile.get(file) ?? Promise.resolve()).then(operation);
  const settle = () => {
    if (pendingByFile.get(file) === pending) pendingByFile.delete(file);
  };
  const pending = result.then(settle, settle);
  pendingByFile.set(file, pending);
  return result;
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readTasks(file: string): Promise<WorkspaceTask[]> {
  const directory = await statIfPresent(dirname(file));
  if (!directory) return [];
  if (!directory.isDirectory()) throw new Error("Task ledger directory must be a directory");

  const entry = await statIfPresent(file);
  if (!entry) return [];
  if (!entry.isFile()) throw new Error("Task ledger file must be a regular file");
  const tasks = WorkspaceTasksSchema.parse(JSON.parse(await readFile(file, "utf8")));
  // COMPAT(blockingQuestionGeneration): added in v0.18.0. Keep until unversioned ledgers are migrated.
  // All callers hold the file lane. Persist the ID before any reader or selector can see it.
  const unversioned = tasks.filter(
    (task) => task.blockingQuestion !== undefined && task.blockingQuestionGeneration === undefined,
  );
  if (unversioned.length) {
    for (const task of unversioned) task.blockingQuestionGeneration = randomUUID();
    await writeJsonFileAtomic(file, tasks);
  }
  return tasks;
}

function mergeParticipants(
  participants: WorkspaceTaskParticipant[],
  updates: WorkspaceTaskParticipant[],
): WorkspaceTaskParticipant[] {
  const byIdentity = new Map<string, WorkspaceTaskParticipant>();
  for (const participant of [...participants, ...updates]) {
    byIdentity.set(JSON.stringify([participant.serverId, participant.agentId]), participant);
  }
  return [...byIdentity.values()];
}

function mergeClosure(current: WorkspaceTask["closure"], update: WorkspaceTaskUpsert["closure"]) {
  if (!update) return current;
  const verification = update.verification
    ? { ...current?.verification, ...update.verification }
    : current?.verification;
  return { ...current, ...update, verification };
}

function mergeTask(current: WorkspaceTask | undefined, update: WorkspaceTaskUpsert): WorkspaceTask {
  const now = new Date().toISOString();
  const {
    title,
    status = "analyzing",
    tier = "T1",
    participants = [],
    closure,
    handoffSummary,
    blockingQuestion,
    blockingQuestionGeneration,
    rootMessageId,
    leadAgentId,
    leadServerId,
    conclusionMessageId,
    latestReplyPreview,
    createdAt = now,
  } = current ?? {};
  const next = WorkspaceTaskSchema.parse({
    taskId: update.taskId,
    title: update.title ?? title,
    status: update.status ?? status,
    tier: update.tier ?? tier,
    participants: mergeParticipants(participants, update.participants ?? []),
    closure: mergeClosure(closure, update.closure),
    handoffSummary: update.handoffSummary ?? handoffSummary,
    blockingQuestion,
    blockingQuestionGeneration,
    rootMessageId: update.rootMessageId ?? rootMessageId,
    leadAgentId: update.leadAgentId ?? leadAgentId,
    leadServerId: update.leadServerId ?? leadServerId,
    conclusionMessageId: update.conclusionMessageId ?? conclusionMessageId,
    latestReplyPreview: update.latestReplyPreview ?? latestReplyPreview,
    events: current?.events,
    recentAgentStates: current?.recentAgentStates,
    touchedFiles: current?.touchedFiles,
    silentReportIds: current?.silentReportIds,
    createdAt,
    updatedAt: now,
  });
  applyBlockingQuestionPatch(next, { blockingQuestion: update.blockingQuestion });
  return next;
}

function applyBlockingQuestionPatch(next: WorkspaceTask, update: WorkspaceTaskTurnOutcomePatch) {
  if (update.blockingQuestion === undefined) return;
  if (update.blockingQuestion !== null) {
    next.blockingQuestion = update.blockingQuestion;
    next.blockingQuestionGeneration = randomUUID();
    return;
  }
  if (next.blockingQuestion === undefined && update.blockingQuestionClearedBy === undefined) return;
  delete next.blockingQuestion;
  next.blockingQuestionGeneration = update.blockingQuestionClearedBy ?? randomUUID();
}

function* retainedTaskEvents(tasks: WorkspaceTask[]) {
  for (const task of tasks) {
    yield* task.events ?? [];
    yield* task.recentAgentStates ?? [];
  }
}

function applyTaskEvents(task: WorkspaceTask, updates: readonly TaskEvent[]): WorkspaceTask {
  if (!updates.length) return task;
  const events = mergeTaskEvents(task.events ?? [], updates);
  if (events.every((event, index) => event === task.events?.[index])) return task;
  const states = new Map(task.recentAgentStates?.map((event) => [event.agentId, event]));
  for (const event of events) {
    const previous = states.get(event.agentId);
    if (event.lifecycle && (!previous || compareTaskEvents(previous, event) < 0)) {
      states.set(event.agentId, event);
    }
  }
  return {
    ...task,
    events,
    recentAgentStates: [...states.values()]
      .sort((a, b) => compareTaskEvents(b, a))
      .slice(0, taskEventLimit),
  };
}

function retainTasks(tasks: WorkspaceTask[]): WorkspaceTask[] {
  let terminalCount = 0;
  return tasks
    .toReversed()
    .filter(
      (task) =>
        isActiveWorkspaceTask(task) ||
        ++terminalCount <= terminalLimit ||
        !!task.silentReportIds?.length,
    )
    .toReversed();
}

function replaceTask(tasks: WorkspaceTask[], next: WorkspaceTask): WorkspaceTask[] {
  return retainTasks([...tasks.filter((task) => task.taskId !== next.taskId), next]);
}

export class WorkspaceTaskLedgerStore {
  private readonly tasksDirectory: string;

  constructor(paseoHome: string) {
    this.tasksDirectory = resolve(normalizePathForIdentity(resolve(paseoHome)), "tasks");
  }

  async list(workspaceId: string): Promise<WorkspaceTask[]> {
    const file = this.filePath(workspaceId);
    return serializeFile(file, () => readTasks(file));
  }

  /** Keep the snapshot current through a related write. The callback must not re-enter the ledger. */
  withTaskSnapshot<T>(
    workspaceId: string,
    use: (tasks: readonly WorkspaceTask[]) => Promise<T>,
  ): Promise<T> {
    const file = this.filePath(workspaceId);
    return serializeFile(file, async () => use(await readTasks(file)));
  }

  subscribe(listener: TaskLedgerListener): () => void {
    const directory = this.tasksDirectory;
    const listeners = listenersByDirectory.get(directory) ?? new Set<TaskLedgerListener>();
    const registration: TaskLedgerListener = (workspaceId) => listener(workspaceId);
    listeners.add(registration);
    listenersByDirectory.set(directory, listeners);
    return () => {
      if (listeners.delete(registration) && !listeners.size) listenersByDirectory.delete(directory);
    };
  }

  private async writeTasks(
    workspaceId: string,
    file: string,
    tasks: WorkspaceTask[],
  ): Promise<void> {
    await writeJsonFileAtomic(file, tasks);
    const listeners = Array.from(listenersByDirectory.get(this.tasksDirectory) ?? []);
    for (const listener of listeners) {
      try {
        listener(workspaceId);
      } catch {
        // A publisher failure must never report an already committed write as failed.
        process.emitWarning("Workspace task ledger change listener failed");
      }
    }
  }

  async upsert(
    workspaceId: string,
    input: WorkspaceTaskUpsert,
    bindingEvents: readonly TaskEvent[] = [],
  ): Promise<WorkspaceTask> {
    const file = this.filePath(workspaceId);
    const update = WorkspaceTaskUpsertSchema.parse(input);
    return serializeFile(file, async () => {
      const tasks = await readTasks(file);
      const current = tasks.find((task) => task.taskId === update.taskId);
      // A queued binding can settle after a human closes the task. Reopening
      // or changing its closure is an explicit upsert, outside dispatch.
      const patch = bindingEvents.length
        ? {
            ...update,
            ...(current && !isActiveWorkspaceTask(current)
              ? { status: undefined, closure: undefined }
              : {}),
            rootMessageId: current?.rootMessageId ?? update.rootMessageId,
          }
        : update;
      const next = applyTaskEvents(
        mergeTask(current, patch),
        orderTaskEvents(bindingEvents, retainedTaskEvents(tasks)),
      );

      // Keep records in write order so equal timestamps cannot evict a newer terminal task.
      await this.writeTasks(workspaceId, file, replaceTask(tasks, next));
      return next;
    });
  }

  async addTouchedFiles(
    workspaceId: string,
    taskId: string,
    paths: readonly string[],
  ): Promise<void> {
    if (!paths.length) return;
    await this.syncFromTurnOutcome(workspaceId, taskId, (task) =>
      isActiveWorkspaceTask(task) ? { touchedFiles: [...paths] } : null,
    );
  }

  async syncFromTurnOutcome(
    workspaceId: string,
    taskId: string,
    patch: WorkspaceTaskTurnOutcomePatch | SelectTurnOutcomePatch,
  ): Promise<WorkspaceTask | null> {
    const file = this.filePath(workspaceId);
    return serializeFile(file, async () => {
      const tasks = await readTasks(file);
      const current = tasks.find((task) => task.taskId === taskId);
      if (!current) return null;
      const selected = typeof patch === "function" ? patch(current, tasks) : patch;
      if (!selected) return null;
      const update = TurnOutcomePatchSchema.parse(selected);
      const touchedFiles = mergeTouchedFiles(current.touchedFiles ?? [], update.touchedFiles ?? []);
      const next = { ...current };
      if (update.status !== undefined) next.status = update.status;
      if (update.handoffSummary !== undefined) next.handoffSummary = update.handoffSummary;
      if (update.latestReplyPreview !== undefined)
        next.latestReplyPreview = update.latestReplyPreview;
      applyBlockingQuestionPatch(next, update);
      if (update.silentReportId && !current.silentReportIds?.includes(update.silentReportId)) {
        next.silentReportIds = [...(current.silentReportIds ?? []), update.silentReportId];
      }
      if (touchedFiles.length) next.touchedFiles = touchedFiles;
      if (JSON.stringify(current) === JSON.stringify(next)) return current;
      next.updatedAt = new Date().toISOString();
      const validated = WorkspaceTaskSchema.parse(next);
      await this.writeTasks(workspaceId, file, replaceTask(tasks, validated));
      return validated;
    });
  }

  async acknowledgeSilentReport(
    workspaceId: string,
    taskId: string,
    messageId: string,
  ): Promise<void> {
    const file = this.filePath(workspaceId);
    await serializeFile(file, async () => {
      const tasks = await readTasks(file);
      const task = tasks.find((candidate) => candidate.taskId === taskId);
      if (!task?.silentReportIds?.includes(messageId)) return;
      const pending = task.silentReportIds.filter((id) => id !== messageId);
      if (pending.length) task.silentReportIds = pending;
      else delete task.silentReportIds;
      await this.writeTasks(workspaceId, file, retainTasks(tasks));
    });
  }

  async updateLatestReplyPreview(workspaceId: string, taskId: string, text: string): Promise<void> {
    const file = this.filePath(workspaceId);
    await serializeFile(file, async () => {
      const tasks = await readTasks(file);
      const current = tasks.find((task) => task.taskId === taskId);
      if (!current || current.latestReplyPreview === text) return;
      current.latestReplyPreview = text;
      await this.writeTasks(workspaceId, file, tasks);
    });
  }

  async recordAgentEvent(
    workspaceId: string,
    event: TaskEvent,
    serverId: string,
    parentId: string,
    include?: (task: WorkspaceTask) => boolean,
  ): Promise<void> {
    const file = this.filePath(workspaceId);
    await serializeFile(file, async () => {
      const tasks = await readTasks(file);
      const ordered = orderTaskEvents([event], retainedTaskEvents(tasks));
      const updated = tasks.map((task) =>
        (!include || include(task)) &&
        task.participants.some(
          (participant) =>
            participant.agentId === event.agentId &&
            isTaskParticipantAddress(participant, parentId, serverId),
        )
          ? applyTaskEvents(task, ordered)
          : task,
      );
      if (updated.some((task, index) => task !== tasks[index])) {
        await this.writeTasks(workspaceId, file, updated);
      }
    });
  }

  private filePath(workspaceId: string): string {
    return resolve(this.tasksDirectory, `${WorkspaceIdSchema.parse(workspaceId)}.json`);
  }
}

export const WORKSPACE_TASK_LEDGER_HEADER = "[Workspace Task Ledger]";

export function workspaceTaskLedgerEnd(agentId: string): string {
  return `\n[/Workspace Task Ledger: ${agentId}]`;
}

export function emptyWorkspaceTaskLedgerPrompt(agentId: string): string {
  return `${WORKSPACE_TASK_LEDGER_HEADER}\nNo active tasks.${workspaceTaskLedgerEnd(agentId)}`;
}
const promptByteLimit = 500;
const promptTaskLimit = 8;
const statusPriority: Record<WorkspaceTask["status"], number> = {
  awaiting_decision: 0,
  unclosed: 1,
  verifying: 2,
  in_progress: 3,
  analyzing: 4,
  completed: 5,
  deferred: 5,
  canceled: 5,
};

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function quoteForPrompt(value: string): string {
  return JSON.stringify(value)
    .replaceAll("[", "\\u005b")
    .replaceAll("]", "\\u005d")
    .replace(
      /[\u0085\u2028\u2029]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

function truncateUtf8(line: string, budget: number): string {
  if (Buffer.byteLength(line) <= budget) return line;
  const suffix = "…";
  let remaining = budget - Buffer.byteLength(suffix);
  let end = 0;
  for (const character of line) {
    remaining -= Buffer.byteLength(character);
    if (remaining < 0) break;
    end += character.length;
  }
  return `${line.slice(0, end)}${suffix}`;
}

export function taskParticipantKey(participant: WorkspaceTaskParticipant): string {
  return JSON.stringify([participant.serverId, participant.agentId, participant.boundBy]);
}

export function projectTaskParticipantReuse(
  tasks: WorkspaceTask[],
  reuse: ReadonlyMap<string, TaskReuseDecision>,
) {
  return tasks.map((task) => {
    const participantReuse = task.participants.map((participant) => ({
      ...participant,
      ...reuse.get(taskParticipantKey(participant)),
    }));
    return Object.assign({}, task, { participantReuse });
  });
}

export function renderWorkspaceTaskLedger(
  tasks: readonly WorkspaceTask[],
  agentId: string,
  participantReuse?: ReadonlyMap<string, TaskReuseDecision>,
): string {
  const active = tasks
    .filter(isActiveWorkspaceTask)
    .sort(
      (left, right) =>
        statusPriority[left.status] - statusPriority[right.status] ||
        compareText(left.tier, right.tier) ||
        compareText(right.updatedAt, left.updatedAt) ||
        compareText(left.taskId, right.taskId),
    )
    .slice(0, promptTaskLimit);
  if (active.length === 0) return "";

  const end = workspaceTaskLedgerEnd(agentId);
  let remaining = promptByteLimit - Buffer.byteLength(WORKSPACE_TASK_LEDGER_HEADER + end);
  const lineLimit = Math.max(120, Math.floor(remaining / active.length));
  const lines = [WORKSPACE_TASK_LEDGER_HEADER];
  for (const task of active) {
    const prefix = `${task.tier} ${task.status} `;
    const budget = Math.min(lineLimit, remaining - 1);
    if (budget < Buffer.byteLength(prefix) + 6) break;

    const fields = [quoteForPrompt(task.taskId), quoteForPrompt(task.title)];
    if (task.blockingQuestion) fields.push(`question=${quoteForPrompt(task.blockingQuestion)}`);
    let line = truncateUtf8(prefix + fields.join(" "), budget);
    for (const participant of task.participants) {
      const reuse = participantReuse?.get(taskParticipantKey(participant));
      if (!reuse) continue;
      const epoch = reuse.resetEpoch ? ` reset ${reuse.resetEpoch}` : "";
      const field = ` ${quoteForPrompt(`${reuse.description} (${participant.agentId}${epoch})`)}`;
      if (Buffer.byteLength(line + field) <= budget) line += field;
    }
    if (task.handoffSummary) {
      line = truncateUtf8(`${line} handoff=${quoteForPrompt(task.handoffSummary)}`, budget);
    }
    remaining -= Buffer.byteLength(line) + 1;
    lines.push(line);
  }
  return lines.join("\n") + end;
}
