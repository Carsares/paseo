import { nextTodoDeadline } from "./deadline.js";
import type { ClaimedTodoDeadline, TodoDeadlineRecord, WorkspaceTodoStore } from "./store.js";

const MAX_TIMEOUT_MS = 2_147_483_647;
const STORAGE_RETRY_MS = 1_000;

interface SchedulerOptions {
  store: WorkspaceTodoStore;
  onDue: (trigger: ClaimedTodoDeadline) => void | Promise<void>;
  onError: (error: unknown) => void;
  now?: () => number;
}

interface ScheduledTodo {
  key: string;
  record: TodoDeadlineRecord;
  fireAtMs: number;
}

class DeadlineQueue {
  private readonly jobs: ScheduledTodo[] = [];
  private readonly positions = new Map<string, number>();

  peek(): ScheduledTodo | undefined {
    return this.jobs[0];
  }

  get(key: string): ScheduledTodo | undefined {
    const position = this.positions.get(key);
    return position === undefined ? undefined : this.jobs[position];
  }

  set(job: ScheduledTodo): void {
    const position = this.positions.get(job.key) ?? this.jobs.length;
    this.jobs[position] = job;
    this.positions.set(job.key, position);
    this.restoreOrder(position);
  }

  delete(key: string): void {
    const position = this.positions.get(key);
    if (position === undefined) return;
    const last = this.jobs.pop()!;
    this.positions.delete(key);
    if (position === this.jobs.length) return;
    this.jobs[position] = last;
    this.positions.set(last.key, position);
    this.restoreOrder(position);
  }

  clear(): void {
    this.jobs.length = 0;
    this.positions.clear();
  }

  private restoreOrder(position: number): void {
    const job = this.jobs[position]!;
    const move = (from: number): number => {
      const displaced = this.jobs[from]!;
      this.jobs[position] = displaced;
      this.positions.set(displaced.key, position);
      return from;
    };
    const original = position;
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (this.jobs[parent]!.fireAtMs <= job.fireAtMs) break;
      position = move(parent);
    }
    if (position === original) {
      while (position * 2 + 1 < this.jobs.length) {
        const left = position * 2 + 1;
        const right = this.jobs[left + 1];
        const child = right && right.fireAtMs < this.jobs[left]!.fireAtMs ? left + 1 : left;
        if (job.fireAtMs <= this.jobs[child]!.fireAtMs) break;
        position = move(child);
      }
    }
    this.jobs[position] = job;
    this.positions.set(job.key, position);
  }
}

interface SchedulerRun {
  changedWhileLoading: Set<string> | null;
  deadlines: DeadlineQueue;
  timer: ReturnType<typeof setTimeout> | null;
  timerAtMs: number | null;
  inFlight: Promise<void> | null;
  unsubscribe: () => void;
  ready: Promise<void>;
}

function deadlineKey({
  workspaceId,
  todoId,
}: Pick<TodoDeadlineRecord, "workspaceId" | "todoId">): string {
  return JSON.stringify([workspaceId, todoId]);
}

/** One entry per pending deadline and one timer for the nearest entry. */
export class TodoDeadlineScheduler {
  private run: SchedulerRun | null = null;
  private readonly now: () => number;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): Promise<void> {
    if (this.run) return this.run.ready;
    const run: SchedulerRun = {
      changedWhileLoading: new Set(),
      deadlines: new DeadlineQueue(),
      timer: null,
      timerAtMs: null,
      inFlight: null,
      unsubscribe: () => {},
      ready: Promise.resolve(),
    };
    this.run = run;
    run.unsubscribe = this.options.store.subscribeDeadlines((change) => {
      const key = deadlineKey(change);
      run.changedWhileLoading?.add(key);
      if (change.item === null) run.deadlines.delete(key);
      else this.track(run, key, change);
      this.arm(run);
    });
    run.ready = this.load(run);
    return run.ready;
  }

  async stop(): Promise<void> {
    const run = this.run;
    if (!run) return;
    this.run = null;
    run.unsubscribe();
    this.clearTimer(run);
    run.deadlines.clear();
    await run.inFlight;
  }

  private async load(run: SchedulerRun): Promise<void> {
    try {
      const records = await this.options.store.listDeadlines();
      if (this.run !== run) return;
      for (const record of records) {
        const key = deadlineKey(record);
        if (!run.changedWhileLoading?.has(key)) this.track(run, key, record);
      }
      run.changedWhileLoading = null;
      this.arm(run);
    } catch (error) {
      if (this.run !== run) return;
      await this.stop();
      throw error;
    }
  }

  private track(run: SchedulerRun, key: string, record: TodoDeadlineRecord): void {
    const deadline = nextTodoDeadline(record.item, record.lastReminderNotifiedAt, this.now());
    if (deadline) run.deadlines.set({ key, record, fireAtMs: deadline.fireAtMs });
    else run.deadlines.delete(key);
  }

  private clearTimer(run: SchedulerRun): void {
    if (run.timer !== null) clearTimeout(run.timer);
    run.timer = null;
    run.timerAtMs = null;
  }

  private arm(run: SchedulerRun): void {
    if (this.run !== run || run.changedWhileLoading || run.inFlight) return;
    const next = run.deadlines.peek();
    if (!next) {
      this.clearTimer(run);
      return;
    }

    const now = this.now();
    const delay = Math.min(Math.max(0, next.fireAtMs - now), MAX_TIMEOUT_MS);
    const timerAtMs = now + delay;
    if (run.timerAtMs === timerAtMs) return;
    this.clearTimer(run);
    run.timerAtMs = timerAtMs;
    // Re-select from the live map when the timer fires; an edit may leave the same earliest time.
    run.timer = setTimeout(() => this.wake(run), delay);
    run.timer.unref();
  }

  private wake(run: SchedulerRun): void {
    this.clearTimer(run);
    if (this.run !== run) return;
    run.inFlight = this.fireReady(run).finally(() => {
      run.inFlight = null;
      this.arm(run);
    });
  }

  private async fireReady(run: SchedulerRun): Promise<void> {
    while (this.run === run) {
      const job = run.deadlines.peek();
      if (!job || job.fireAtMs > this.now()) return;
      const { key } = job;
      let claimed: ClaimedTodoDeadline | null;
      try {
        claimed = await this.options.store.claimDeadline(job.record);
      } catch (error) {
        if (run.deadlines.get(key) === job) {
          run.deadlines.set({ ...job, fireAtMs: this.now() + STORAGE_RETRY_MS });
        }
        this.options.onError(error);
        continue;
      }
      if (run.deadlines.get(key) === job) run.deadlines.delete(key);
      if (!claimed) continue;
      try {
        // Finish a committed claim even if stop() is waiting for the current delivery.
        await this.options.onDue(claimed);
      } catch (error) {
        this.options.onError(error);
      }
    }
  }
}
