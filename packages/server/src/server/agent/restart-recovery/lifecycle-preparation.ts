import { withTimeout } from "../../../utils/promise-timeout.js";

interface Dependencies {
  assertStartupRecoverySettled?(): void;
  pauseDelivery(): { drained: Promise<void>; release(): void } | undefined;
  pauseRunAdmission(): () => void;
  waitForAdmittedRunsToStart(): Promise<void>;
  capture(force: boolean): Promise<void>;
  report?(error: unknown): void;
}

const ADMISSION_DRAIN_TIMEOUT_MS = 5_000;

export function createLifecyclePreparation(deps: Dependencies) {
  let current: { force: boolean; prepared: Promise<{ deliveryDrained: boolean }> } | undefined;

  async function capture(force: boolean): Promise<{ deliveryDrained: boolean }> {
    // A recovery still opening its provider session has not reached run admission yet.
    if (force) deps.assertStartupRecoverySettled?.();
    const drainStarted = performance.now();
    const delivery = deps.pauseDelivery();
    let deliveryDrained = true;
    const remainingBudget = () =>
      Math.max(0, Math.ceil(ADMISSION_DRAIN_TIMEOUT_MS - (performance.now() - drainStarted)));
    const reportOrThrow = (error: unknown) => {
      if (force) throw error;
      deps.report?.(error);
    };
    let releaseRuns: (() => void) | undefined;
    try {
      if (delivery) {
        await withTimeout({
          promise: delivery.drained,
          timeoutMs: ADMISSION_DRAIN_TIMEOUT_MS,
          label: "dispatch queued agent messages",
        }).catch((error) => {
          deliveryDrained = false;
          reportOrThrow(error);
        });
      }
      releaseRuns = deps.pauseRunAdmission();
      await withTimeout({
        promise: deps.waitForAdmittedRunsToStart(),
        // Ordinary requests and shutdown share the same budget.
        timeoutMs: force ? ADMISSION_DRAIN_TIMEOUT_MS : remainingBudget(),
        label: "settle agent run admissions",
      }).catch(reportOrThrow);
      // Keep both admission barriers up after success, including the gap before IPC.
      await deps.capture(force).catch(reportOrThrow);
      return { deliveryDrained };
    } catch (error) {
      releaseRuns?.();
      delivery?.release();
      throw error;
    }
  }

  function startPreparation(force: boolean) {
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
    async prepare(force: boolean): Promise<void> {
      await startPreparation(force);
    },
    async beforeStop(force: boolean) {
      if (!current) return startPreparation(force);
      if (force && !current.force) {
        throw new Error("Daemon shutdown was already prepared without agent resume");
      }
      return current.prepared;
    },
  };
}
