// oxlint-disable-next-line paseo/no-sync-io -- Consume the startup marker before dispatching any recovery.
import { rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { writeFileAtomic } from "../../atomic-file.js";
import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
interface Dependencies {
  storage: AgentStorage;
  oneShotMarkerPath?: string;
  settings(): { enabled: boolean; prompt: string };
  eligible(record: StoredAgentRecord): Promise<boolean>;
  dispatch(agentId: string, prompt: string): Promise<unknown>;
  report(agentId: string, error: unknown): void;
}
export function createRestartRecovery(deps: Dependencies) {
  // Candidates are chosen at startup; each settles once its resume was sent or abandoned.
  const resuming = new Map<string, { promise: Promise<void>; resolve(): void; forced: boolean }>();
  const eligible = async (record: StoredAgentRecord) =>
    !record.archivedAt && !record.internal && !record.owner && (await deps.eligible(record));
  async function hasOneShotMarker(): Promise<boolean> {
    const markerPath = deps.oneShotMarkerPath;
    if (!markerPath) return false;
    try {
      await stat(markerPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
    return true;
  }
  async function resume(agentId: string, forced: boolean) {
    const record = await deps.storage.get(agentId);
    if (!record?.resumeOnStartup) return;
    await deps.storage.upsert({ ...record, resumeOnStartup: false });
    if ((!forced && !deps.settings().enabled) || !(await eligible(record))) return;
    await deps.dispatch(agentId, deps.settings().prompt);
  }
  return {
    /** Choose candidates before anything else reads or repairs persisted running status. */
    async prepareStartup() {
      const forcedOnce = await hasOneShotMarker();
      // Startup recovery repairs persisted running status once before agents are restored.
      for (const record of await deps.storage.listAll()) {
        const forced = forcedOnce && record.resumeOnStartup === true;
        const pending =
          (deps.settings().enabled
            ? record.resumeOnStartup === true || record.lastStatus === "running"
            : forced) && (await eligible(record));
        await deps.storage.upsert({
          ...record,
          resumeOnStartup: pending,
          lastStatus:
            record.lastStatus === "running" || record.lastStatus === "initializing"
              ? "closed"
              : record.lastStatus,
        });
        if (pending) {
          let resolve!: () => void;
          const promise = new Promise<void>((settle) => {
            resolve = settle;
          });
          resuming.set(record.id, { promise, resolve, forced });
        }
      }
    },
    async captureRunningAgents(options?: { force?: boolean }) {
      const force = options?.force === true;
      const shouldResume = force || deps.settings().enabled;
      await deps.storage.flush();
      // Shutdown recovery captures running state once before the daemon exits.
      for (const record of await deps.storage.listAll()) {
        if (record.lastStatus === "running" && (await eligible(record)))
          await deps.storage.upsert({ ...record, resumeOnStartup: shouldResume });
      }
      await deps.storage.flush();
      if (force && deps.oneShotMarkerPath) {
        await writeFileAtomic(deps.oneShotMarkerPath, JSON.stringify({ version: 1 }));
      }
    },
    /** Resume every candidate in the background; a slow provider holds back only its agent. */
    resumePending() {
      if (deps.oneShotMarkerPath) rmSync(deps.oneShotMarkerPath, { force: true });
      for (const [agentId, settled] of resuming) {
        void resume(agentId, settled.forced)
          .catch((error) => deps.report(agentId, error))
          .finally(() => {
            resuming.delete(agentId);
            settled.resolve();
          });
      }
    },
    /** Wait until this agent's resume was sent or abandoned. Others return at once. */
    async waitForResume(agentId: string, signal: AbortSignal) {
      const settled = resuming.get(agentId);
      if (!settled) return;
      let abort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
      try {
        await Promise.race([settled.promise, aborted]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
