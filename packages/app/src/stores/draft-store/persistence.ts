import type { PersistStorage } from "zustand/middleware";

export const DRAFT_PERSIST_INTERVAL_MS = 200;
export interface PersistenceScheduler {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
}

export interface DraftPersistStorage<T> extends PersistStorage<T> {
  flush: () => Promise<void>;
  hasPendingWrite: () => boolean;
  pauseWrites: () => (discardPending?: boolean) => void;
}

let nextSystemTimerId = 0;
const systemTimers = new Map<number, ReturnType<typeof setTimeout>>();
const systemScheduler: PersistenceScheduler = {
  now: Date.now,
  schedule: (callback, delayMs) => {
    const id = nextSystemTimerId++;
    systemTimers.set(
      id,
      setTimeout(() => {
        systemTimers.delete(id);
        callback();
      }, delayMs),
    );
    return id;
  },
  cancel: (handle) => {
    if (typeof handle !== "number") return;
    const timer = systemTimers.get(handle);
    if (timer === undefined) return;
    clearTimeout(timer);
    systemTimers.delete(handle);
  },
};

export function createDraftPersistStorage<T>(
  storage: PersistStorage<T>,
  scheduler?: PersistenceScheduler,
): DraftPersistStorage<T>;
export function createDraftPersistStorage<T>(
  storage: PersistStorage<T> | undefined,
  scheduler?: PersistenceScheduler,
): DraftPersistStorage<T> | undefined;
export function createDraftPersistStorage<T>(
  storage: PersistStorage<T> | undefined,
  scheduler: PersistenceScheduler = systemScheduler,
): DraftPersistStorage<T> | undefined {
  if (!storage) {
    return undefined;
  }

  let pending: { name: string; value: Parameters<typeof storage.setItem>[1] } | null = null;
  let inFlight: Promise<void> | null = null;
  let timer: unknown = null;
  let lastWriteAt = -Infinity;
  let writesPaused: Promise<void> | null = null;

  const cancelTimer = () => {
    if (timer !== null) {
      scheduler.cancel(timer);
      timer = null;
    }
  };
  const warnWriteFailure = (error: unknown) => {
    console.warn("[DraftStore] Failed to persist draft checkpoint", error);
  };
  const writePending = (): Promise<void> | undefined => {
    const write = pending;
    if (!write) return;
    pending = null;
    lastWriteAt = scheduler.now();
    try {
      const result = storage.setItem(write.name, write.value);
      if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") {
        inFlight = Promise.resolve(result)
          .then(() => undefined, warnWriteFailure)
          .finally(() => {
            inFlight = null;
            scheduleWrite();
          });
        return inFlight;
      }
    } catch (error) {
      warnWriteFailure(error);
    }
  };
  const scheduleWrite = () => {
    if (writesPaused || inFlight || !pending) return;
    const delay = DRAFT_PERSIST_INTERVAL_MS - (scheduler.now() - lastWriteAt);
    if (delay <= 0) {
      cancelTimer();
      return writePending();
    }
    timer ??= scheduler.schedule(() => {
      timer = null;
      void writePending();
    }, delay);
  };
  const flush = async (): Promise<void> => {
    for (;;) {
      if (!pending && !inFlight) return;
      cancelTimer();
      await (writesPaused ?? inFlight ?? writePending());
    }
  };

  return {
    getItem: (name) =>
      inFlight ? inFlight.then(() => storage.getItem(name)) : storage.getItem(name),
    setItem: (name, value) => {
      pending = { name, value };
      return scheduleWrite();
    },
    removeItem: (name) => {
      cancelTimer();
      pending = null;
      lastWriteAt = scheduler.now();
      return storage.removeItem(name);
    },
    flush,
    hasPendingWrite: () => pending !== null,
    pauseWrites: () => {
      cancelTimer();
      let resume = () => {};
      writesPaused = new Promise<void>((resolve) => {
        resume = resolve;
      });
      return (discardPending) => {
        if (discardPending) pending = null;
        writesPaused = null;
        resume();
        scheduleWrite();
      };
    },
  };
}
