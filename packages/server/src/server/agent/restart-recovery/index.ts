import { readFile, rm } from "node:fs/promises";
import { writeFileAtomic } from "../../atomic-file.js";
import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";

type RecoveryCandidate = Pick<
  StoredAgentRecord,
  "id" | "internal" | "owner" | "workspaceId" | "archivedAt"
>;

interface Dependencies {
  storage: AgentStorage;
  oneShotMarkerPath?: string;
  automaticMarkerPath?: string;
  settings(): { enabled: boolean; prompt: string };
  eligible(record: RecoveryCandidate): Promise<boolean>;
  /** Resolves once the provider has accepted the continuation. */
  dispatch(agentId: string, prompt: string): Promise<void>;
  report(agentId: string, error: unknown): void;
}
export function createRestartRecovery(deps: Dependencies) {
  const resuming = new Map<
    string,
    { promise: Promise<void>; resolve(): void; forced: boolean; dispatched: boolean }
  >();
  const oneShot = { path: deps.oneShotMarkerPath, agentIds: new Set<string>() };
  // Opening a session or failing to start its turn can persist an idle/error
  // snapshot before confirmation. Keep automatic intent outside that snapshot.
  const automatic = { path: deps.automaticMarkerPath, agentIds: new Set<string>() };
  let markerWrites = Promise.resolve();
  const eligible = async (record: RecoveryCandidate) =>
    !record.archivedAt && !record.internal && !record.owner && (await deps.eligible(record));

  function needsAutomaticRecovery(
    record: StoredAgentRecord,
    pendingIds: ReadonlySet<string> | undefined,
  ): boolean {
    return (
      deps.settings().enabled &&
      (record.resumeOnStartup === true ||
        record.lastStatus === "running" ||
        pendingIds?.has(record.id) === true)
    );
  }

  async function readMarker(markerPath: string | undefined): Promise<{
    allAgents: boolean;
    agentIds: ReadonlySet<string>;
  } | null> {
    if (!markerPath) return null;
    let raw: string;
    try {
      raw = await readFile(markerPath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { allAgents: false, agentIds: new Set() };
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      parsed.version === 1
    ) {
      // COMPAT(restartRecoveryMarkerV1): consume legacy global markers through 2027-05-19.
      return { allAgents: true, agentIds: new Set() };
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 2 ||
      !("agentIds" in parsed) ||
      !Array.isArray(parsed.agentIds)
    ) {
      return { allAgents: false, agentIds: new Set() };
    }
    const agentIds = parsed.agentIds.filter(
      (agentId): agentId is string => typeof agentId === "string" && agentId.length > 0,
    );
    return { allAgents: false, agentIds: new Set(agentIds) };
  }

  async function writeRemainingMarker(markerPath: string | undefined, agentIds: Set<string>) {
    if (!markerPath) return;
    if (agentIds.size === 0) {
      await rm(markerPath, { force: true });
    } else {
      await writeFileAtomic(markerPath, JSON.stringify({ version: 2, agentIds: [...agentIds] }));
    }
  }

  function consumeMarkerAgent(marker: typeof oneShot, agentId: string): Promise<void> {
    if (!marker.agentIds.has(agentId)) return Promise.resolve();
    // Dispatches run independently, but each marker write must see every prior removal.
    async function consume() {
      const remaining = new Set(marker.agentIds);
      if (!remaining.delete(agentId)) return;
      await writeRemainingMarker(marker.path, remaining);
      marker.agentIds = remaining;
    }
    const write = markerWrites.then(consume);
    markerWrites = write.catch(() => {});
    return write;
  }

  async function resume(agentId: string, forced: boolean) {
    const record = await deps.storage.get(agentId);
    const marker = forced ? oneShot : automatic;
    if (record && (forced || record.resumeOnStartup || automatic.agentIds.has(agentId))) {
      if ((forced || deps.settings().enabled) && (await eligible(record))) {
        await deps.dispatch(agentId, deps.settings().prompt);
      }
      // With recovery disabled the one-shot marker remains authoritative even
      // if clearing the agent's persisted flag fails.
      await consumeMarkerAgent(marker, agentId);
      // Dispatch can load and update the agent. Clear the flag on its latest record.
      await deps.storage.flush();
      const latest = await deps.storage.get(agentId);
      if (latest?.resumeOnStartup) {
        await deps.storage.upsert({ ...latest, resumeOnStartup: false });
      }
    } else {
      await consumeMarkerAgent(marker, agentId);
    }
  }
  return {
    assertStartupRecoverySettled() {
      if (resuming.size > 0) {
        throw new Error(
          "Cannot preserve agents while startup recovery is still in progress. Retry after it finishes.",
        );
      }
    },
    /** Choose candidates before anything else reads or repairs persisted running status. */
    async prepareStartup() {
      const [oneShotMarker, automaticMarker] = await Promise.all([
        readMarker(oneShot.path),
        readMarker(automatic.path),
      ]);
      // Startup recovery repairs persisted running status once before agents are restored.
      const records = await deps.storage.listAll();
      for (const record of records) {
        // A provider can persist an idle snapshot while dispatch is still
        // loading the session. The per-agent marker remains valid in that window.
        const forced =
          oneShotMarker?.agentIds.has(record.id) === true ||
          (oneShotMarker?.allAgents === true && record.resumeOnStartup === true);
        const pending =
          (forced || needsAutomaticRecovery(record, automaticMarker?.agentIds)) &&
          (await eligible(record));
        await deps.storage.upsert({
          ...record,
          resumeOnStartup: pending,
          lastStatus:
            record.lastStatus === "running" || record.lastStatus === "initializing"
              ? "closed"
              : record.lastStatus,
        });
        if (pending) {
          if (forced) oneShot.agentIds.add(record.id);
          else if (automatic.path) automatic.agentIds.add(record.id);
          let resolve!: () => void;
          const promise = new Promise<void>((settle) => {
            resolve = settle;
          });
          resuming.set(record.id, { promise, resolve, forced, dispatched: false });
        }
      }
      // Convert legacy global markers and drop missing or ineligible agents.
      if (
        oneShotMarker &&
        (oneShotMarker.allAgents ||
          oneShot.agentIds.size === 0 ||
          oneShot.agentIds.size !== oneShotMarker.agentIds.size)
      ) {
        await writeRemainingMarker(oneShot.path, oneShot.agentIds);
      }
      if (automaticMarker || automatic.agentIds.size) {
        await writeRemainingMarker(automatic.path, automatic.agentIds);
      }
    },
    async captureRunningAgents(options?: {
      force?: boolean;
      listRunningAgents?: () => readonly RecoveryCandidate[];
    }) {
      const force = options?.force === true;
      const shouldResume = force || deps.settings().enabled;
      await deps.storage.flush();
      const capturedAgentIds: string[] = [];
      const records = await deps.storage.listAll();
      if (shouldResume && options?.listRunningAgents) {
        // Snapshot writes are best effort elsewhere. A missing running record must
        // fail this request instead of being silently skipped by the storage scan.
        const byId = new Map(records.map((record) => [record.id, record]));
        for (const live of options.listRunningAgents()) {
          const record = byId.get(live.id);
          if (record?.lastStatus !== "running" && (await eligible(record ?? live))) {
            if (!options.listRunningAgents().some((agent) => agent.id === live.id)) continue;
            throw new Error(`Could not persist running agent ${live.id} for recovery`);
          }
        }
      }
      // Shutdown recovery captures running state once before the daemon exits.
      for (const record of records) {
        if (record.lastStatus !== "running" || !(await eligible(record))) continue;
        const captured = await deps.storage.setRunningAgentRecovery(record.id, shouldResume);
        if (force && captured) capturedAgentIds.push(record.id);
      }
      await deps.storage.flush();
      if (force && deps.oneShotMarkerPath) {
        // A failed startup dispatch can still be pending when the daemon stops again.
        await writeFileAtomic(
          deps.oneShotMarkerPath,
          JSON.stringify({
            version: 2,
            agentIds: [...new Set([...oneShot.agentIds, ...capturedAgentIds])],
          }),
        );
      }
    },
    /** Resume every candidate in the background; a slow provider holds back only its agent. */
    resumePending() {
      for (const [agentId, settled] of resuming) {
        if (settled.dispatched) continue;
        settled.dispatched = true;
        void resume(agentId, settled.forced)
          .catch((error) => deps.report(agentId, error))
          .finally(() => {
            resuming.delete(agentId);
            settled.resolve();
          });
      }
    },
    /** Wait until this agent's resume was confirmed or abandoned. Others return at once. */
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
