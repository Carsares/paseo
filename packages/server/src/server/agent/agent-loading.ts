import type { Logger } from "pino";

import type { AgentProvider } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import {
  buildConfigOverrides,
  extractAttention,
  extractTimestamps,
  isStoredAgentProviderAvailable,
  toAgentPersistenceHandle,
} from "../persistence-hooks.js";

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = "AgentNotFoundError";
  }
}

interface PendingAgentInitialization {
  promise: Promise<ManagedAgent>;
  state: { broadcastTimeline: boolean; session: ManagedAgent["session"]; failed: boolean };
}

const pendingByManager = new WeakMap<AgentLoaderManager, Map<string, PendingAgentInitialization>>();

export type AgentLoaderManager = Pick<
  AgentManager,
  | "createAgentFromRecord"
  | "getAgent"
  | "getRegisteredProviderIds"
  | "hydrateTimelineFromProvider"
  | "resumeAgentFromPersistence"
> &
  Partial<Pick<AgentManager, "waitForAgentClose">>;

export interface EnsureAgentLoadedDeps {
  agentManager: AgentLoaderManager;
  agentStorage: AgentStorage;
  validProviders?: Iterable<AgentProvider>;
  broadcastTimeline?: boolean;
  purpose?: "history" | "interactive";
  logger: Logger;
}

export async function ensureUnarchivedAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps & {
    agentManager: AgentLoaderManager & Pick<AgentManager, "closeAgent">;
  },
): Promise<ManagedAgent> {
  const record = await deps.agentStorage.get(agentId);
  if (record?.archivedAt) {
    throw new Error(`Agent is archived: ${agentId}`);
  }

  const agent = await ensureAgentLoaded(agentId, deps);
  const latestRecord = await deps.agentStorage.get(agentId);
  if (latestRecord?.archivedAt) {
    await deps.agentManager.closeAgent(agentId).catch((error: unknown) => {
      deps.logger.warn({ err: error, agentId }, "Failed to close concurrently archived agent");
    });
    throw new Error(`Agent is archived: ${agentId}`);
  }

  return agent;
}

export async function ensureAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
): Promise<ManagedAgent> {
  let pendingAgentInitializations = pendingByManager.get(deps.agentManager);
  if (!pendingAgentInitializations) {
    pendingAgentInitializations = new Map();
    pendingByManager.set(deps.agentManager, pendingAgentInitializations);
  }

  // A caller can arrive during the hydration part of initialization, which also
  // occupies the lifecycle lane. Record its broadcast need before waiting.
  const observed = pendingAgentInitializations.get(agentId);
  if (observed) observed.state.broadcastTimeline ||= deps.broadcastTimeline === true;
  await deps.agentManager.waitForAgentClose?.(agentId);
  // A failed attempt can close its temporary history reader before the lane
  // releases. Callers already waiting on that attempt share its error.
  if (observed?.state.failed) return observed.promise;

  let inflight = pendingAgentInitializations.get(agentId);
  let existing = deps.agentManager.getAgent(agentId);
  if (!inflight && !existing) {
    // A close can start after the first barrier and remove the runtime before
    // the lookup. Recheck after it finishes before opening the persisted session.
    await deps.agentManager.waitForAgentClose?.(agentId);
    inflight = pendingAgentInitializations.get(agentId);
    existing = deps.agentManager.getAgent(agentId);
  }

  if (inflight) {
    inflight.state.broadcastTimeline ||= deps.broadcastTimeline === true;
    return inflight.promise;
  }

  // Concurrent callers share the outcome even if the initialization finished
  // while they waited. A close/reopen may instead have installed a new runtime.
  if (existing?.session && existing.session === observed?.state.session) {
    return observed.promise;
  }
  if (existing && existing.historyPrimed !== false) return existing;

  const state: PendingAgentInitialization["state"] = {
    broadcastTimeline: deps.broadcastTimeline === true,
    session: null,
    failed: false,
  };
  const openStoredAgent = async () => {
    const record = await deps.agentStorage.get(agentId);
    if (!record) {
      throw new AgentNotFoundError(agentId);
    }

    const validProviders = deps.validProviders ?? deps.agentManager.getRegisteredProviderIds();
    if (!isStoredAgentProviderAvailable(record, validProviders)) {
      throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
    }

    const handle = toAgentPersistenceHandle(validProviders, record.persistence);

    if (handle) {
      const snapshot = await deps.agentManager.resumeAgentFromPersistence(
        handle,
        buildConfigOverrides(record),
        agentId,
        { ...extractTimestamps(record), attention: extractAttention(record) },
        deps.purpose ? { purpose: deps.purpose } : undefined,
      );
      deps.logger.info({ agentId, provider: record.provider }, "Agent resumed from persistence");
      return snapshot;
    }

    // No provider handle: the manager rereads the record in its lifecycle lane to
    // preserve any intervening metadata writes while starting the first session.
    const snapshot = await deps.agentManager.createAgentFromRecord(agentId);
    deps.logger.info({ agentId, provider: record.provider }, "Agent created from stored config");
    return snapshot;
  };
  const initPromise = (async () => {
    const snapshot = existing ?? (await openStoredAgent());
    state.session = snapshot.session;
    await deps.agentManager.hydrateTimelineFromProvider(agentId, {
      broadcast: () => state.broadcastTimeline,
      whileRegistered: true,
    });
    return deps.agentManager.getAgent(agentId) ?? snapshot;
  })().catch((error: unknown) => {
    state.failed = true;
    throw error;
  });

  const pending: PendingAgentInitialization = { promise: initPromise, state };
  pendingAgentInitializations.set(agentId, pending);

  try {
    return await initPromise;
  } finally {
    const current = pendingAgentInitializations.get(agentId);
    if (current === pending) {
      pendingAgentInitializations.delete(agentId);
    }
  }
}
