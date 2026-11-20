import { withTimeout } from "../../../utils/promise-timeout.js";

interface Dependencies {
  assertStartupRecoverySettled?(): void;
  pauseDelivery(): { drained: Promise<void>; release(): void } | undefined;
  pauseRunAdmission(): () => void;
  waitForAdmittedRunsToStart(): Promise<void>;
  capture(force: boolean): Promise<void>;
}

const ADMISSION_DRAIN_TIMEOUT_MS = 5_000;

export function createLifecyclePreparation(deps: Dependencies) {
  let current: { force: boolean; prepared: Promise<void> } | undefined;

  async function capture(force: boolean, stopping: boolean): Promise<void> {
    // A recovery still opening its provider session has not reached run admission yet.
    if (force) deps.assertStartupRecoverySettled?.();
    const drainStarted = performance.now();
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
        // Once an ordinary stop has started, both waits share one budget to leave time for cleanup.
        timeoutMs: stopping
          ? Math.max(0, Math.ceil(ADMISSION_DRAIN_TIMEOUT_MS - (performance.now() - drainStarted)))
          : ADMISSION_DRAIN_TIMEOUT_MS,
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

  function startPreparation(force: boolean, stopping = false): Promise<void> {
    if (current) {
      return Promise.reject(new Error("A daemon lifecycle request is already in progress"));
    }
    // Claim before starting any async work. Only the owning request may acknowledge and dispatch.
    const prepared = Promise.resolve()
      .then(() => capture(force, stopping))
      .catch((error) => {
        current = undefined;
        throw error;
      });
    current = { force, prepared };
    return prepared;
  }

  return {
    prepare: (force: boolean) => startPreparation(force),
    async beforeStop(force: boolean): Promise<void> {
      if (!current) {
        await startPreparation(force, !force);
        return;
      }
      if (force && !current.force) {
        throw new Error("Daemon shutdown was already prepared without agent resume");
      }
      await current.prepared;
    },
  };
}
