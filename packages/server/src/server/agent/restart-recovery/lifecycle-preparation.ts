import { withTimeout } from "../../../utils/promise-timeout.js";

interface Dependencies {
  pauseDelivery(): { drained: Promise<void>; release(): void } | undefined;
  pauseRunAdmission(): () => void;
  waitForAdmittedRunsToStart(): Promise<void>;
  capture(force: boolean): Promise<void>;
}

const ADMISSION_DRAIN_TIMEOUT_MS = 5_000;

export function createLifecyclePreparation(deps: Dependencies) {
  let current: { force: boolean; prepared: Promise<void> } | undefined;

  async function capture(force: boolean): Promise<void> {
    const delivery = deps.pauseDelivery();
    let releaseRuns: (() => void) | undefined;
    try {
      if (delivery) {
        await withTimeout({
          promise: delivery.drained,
          timeoutMs: ADMISSION_DRAIN_TIMEOUT_MS,
          label: "dispatch queued agent messages",
        });
      }
      releaseRuns = deps.pauseRunAdmission();
      await withTimeout({
        promise: deps.waitForAdmittedRunsToStart(),
        timeoutMs: ADMISSION_DRAIN_TIMEOUT_MS,
        label: "settle agent run admissions",
      });
      // Keep both admission barriers up after success, including the gap before IPC.
      await deps.capture(force);
    } catch (error) {
      releaseRuns?.();
      delivery?.release();
      throw error;
    }
  }

  function prepare(force: boolean): Promise<void> {
    if (current) {
      return Promise.reject(new Error("A daemon lifecycle request is already in progress"));
    }
    // Claim before starting any async work. Only the owning request may acknowledge and dispatch.
    const prepared = Promise.resolve()
      .then(() => capture(force))
      .catch((error) => {
        current = undefined;
        throw error;
      });
    current = { force, prepared };
    return prepared;
  }

  return {
    prepare,
    async beforeStop(force: boolean): Promise<void> {
      if (!current) {
        await prepare(force);
        return;
      }
      if (force && !current.force) {
        throw new Error("Daemon shutdown was already prepared without agent resume");
      }
      await current.prepared;
    },
  };
}
