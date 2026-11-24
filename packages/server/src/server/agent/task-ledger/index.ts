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
});

const boundedText = (bytes: number) =>
  z
    .string()
    .refine((text) => Buffer.byteLength(text) <= bytes, `Must be at most ${bytes} UTF-8 bytes`);

export const WorkspaceTaskToolInputSchema = WorkspaceTaskUpsertSchema.omit({ participants: true })
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

const WorkspaceTaskSchema = WorkspaceTaskUpsertSchema.extend({
  title: TaskTitleSchema,
  status: TaskStatusSchema,
  tier: TaskTierSchema,
  participants: z.array(WorkspaceTaskParticipantSchema),
  events: z.array(TaskEventSchema).optional(),
  recentAgentStates: z.array(TaskEventSchema).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).refine((task) => task.status !== "completed" || task.closure?.verification?.state !== "failed", {
  path: ["closure", "verification", "state"],
  message: "A task with failed verification cannot be completed",
});

export type WorkspaceTask = z.infer<typeof WorkspaceTaskSchema>;
type WorkspaceTaskUpsert = z.input<typeof WorkspaceTaskUpsertSchema>;
type WorkspaceTaskParticipant = z.infer<typeof WorkspaceTaskParticipantSchema>;

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
const terminalStatuses = new Set<WorkspaceTask["status"]>(["completed", "deferred", "canceled"]);
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
  return WorkspaceTasksSchema.parse(JSON.parse(await readFile(file, "utf8")));
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
    createdAt = now,
  } = current ?? {};
  return WorkspaceTaskSchema.parse({
    taskId: update.taskId,
    title: update.title ?? title,
    status: update.status ?? status,
    tier: update.tier ?? tier,
    participants: mergeParticipants(participants, update.participants ?? []),
    closure: mergeClosure(closure, update.closure),
    handoffSummary: update.handoffSummary ?? handoffSummary,
    blockingQuestion: update.blockingQuestion ?? blockingQuestion,
    events: current?.events,
    recentAgentStates: current?.recentAgentStates,
    createdAt,
    updatedAt: now,
  });
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

export class WorkspaceTaskLedgerStore {
  private readonly tasksDirectory: string;

  constructor(paseoHome: string) {
    this.tasksDirectory = resolve(normalizePathForIdentity(resolve(paseoHome)), "tasks");
  }

  async list(workspaceId: string): Promise<WorkspaceTask[]> {
    const file = this.filePath(workspaceId);
    return serializeFile(file, () => readTasks(file));
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
      const patch =
        bindingEvents.length && current && terminalStatuses.has(current.status)
          ? { ...update, status: undefined, closure: undefined }
          : update;
      const next = applyTaskEvents(
        mergeTask(current, patch),
        orderTaskEvents(bindingEvents, retainedTaskEvents(tasks)),
      );

      // Keep records in write order so equal timestamps cannot evict a newer terminal task.
      const updated = tasks.filter((task) => task.taskId !== next.taskId);
      updated.push(next);
      let terminalCount = 0;
      const retained = updated
        .toReversed()
        .filter((task) => !terminalStatuses.has(task.status) || ++terminalCount <= terminalLimit)
        .toReversed();
      await writeJsonFileAtomic(file, retained);
      return next;
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
        await writeJsonFileAtomic(file, updated);
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
    .filter((task) => !terminalStatuses.has(task.status))
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
