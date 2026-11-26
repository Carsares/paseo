import { promises as fs, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import type { AgentUsage, JsonValue } from "@getpaseo/protocol/agent-types";
import {
  hasOpenAgentTab,
  isMainControlAgentLabels,
  isSideChatAgentLabels,
} from "@getpaseo/protocol/agent-labels";

import { FailedConversationLimitSchema } from "../workspace-deferral/agent-limit-evidence.js";
import {
  AgentLimitContinuationSchema,
  type AgentLimitContinuation,
} from "../workspace-deferral/continuation-state.js";
import { writeFileAtomic, writeJsonFileAtomic } from "../atomic-file.js";
import {
  AgentFeatureSchema,
  AgentMetricSchema,
  AgentOptionControlSchema,
  AgentStatusSchema,
} from "../messages.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { AgentOwnerSchema, daemonExecutionKey, type DaemonAgentOwner } from "./agent-owner.js";
import { controlsFromFeatures } from "@getpaseo/protocol/option-controls";
import { foldFeatureValues } from "./option-controls.js";
import { isTimelinePrefixFilename, TimelinePrefixStore } from "./timeline-prefix-store.js";
import { worktreeIdentitySchema } from "./checkpoints/worktree.js";
import { topicDelegationTurnSchema } from "./tools/topic-delegation.js";

const confirmedRewindSchema = z.object({
  operationId: z.uuid(),
  agentId: z.string(),
  workspaceId: z.string(),
  messageId: z.string(),
  checkpointId: z.uuid(),
  worktree: worktreeIdentitySchema,
});

export type ConfirmedRewind = z.infer<typeof confirmedRewindSchema>;

function projectRestartTopicDelegation(agent: ManagedAgent, existing: StoredAgentRecord | null) {
  if (agent.lifecycle === "running") return agent.activeForegroundDelegation;
  if (
    !existing ||
    (!existing.resumeOnStartup && existing.lastStatus === "running") ||
    existing.workspaceId !== agent.workspaceId ||
    existing.resetEpoch !== agent.resetEpoch
  ) {
    return undefined;
  }
  // Recovery can open an idle session before the provider accepts a turn.
  // Keep the original dispatch through that window and shutdown closure.
  return existing.restartTopicDelegation;
}

function appendConfirmedRewind(
  agent: ManagedAgent,
  existing: StoredAgentRecord | null,
  confirmed: ConfirmedRewind,
): ConfirmedRewind[] {
  if (
    existing?.archivedAt ||
    agent.id !== confirmed.agentId ||
    agent.workspaceId !== confirmed.workspaceId ||
    agent.cwd !== confirmed.worktree.root
  ) {
    throw new Error("Agent changed during conversation rewind");
  }
  return [
    ...(existing?.confirmedRewinds ?? []).filter(
      (item) => item.operationId !== confirmed.operationId,
    ),
    confirmed,
  ];
}

const SERIALIZABLE_CONFIG_SCHEMA = z
  .object({
    modeId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    thinkingOptionId: z.string().nullable().optional(),
    // COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01. Read-only; folded on parse.
    featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
    providerOptions: z.record(z.string(), z.unknown()).nullable().optional(),
    toolPolicy: z
      .object({
        preapproved: z.array(
          z.object({ kind: z.literal("mcp"), server: z.string(), tool: z.string() }).strict(),
        ),
      })
      .strict()
      .nullable()
      .optional(),
    systemPrompt: z.string().nullable().optional(),
    mcpServers: z.record(z.string(), z.any()).nullable().optional(),
  })
  .nullable()
  .optional();

const PERSISTENCE_HANDLE_SCHEMA = z
  .object({
    provider: z.string(),
    sessionId: z.string(),
    nativeHandle: z.any().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .nullable()
  .optional();

const STORED_AGENT_USAGE_SCHEMA = z.object({
  inputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalCostUsd: z.number().optional(),
  contextWindowMaxTokens: z.number().optional(),
  contextWindowUsedTokens: z.number().optional(),
} satisfies Record<keyof AgentUsage, z.ZodOptional<z.ZodNumber>>);

const RAW_STORED_AGENT_SCHEMA = z.object({
  id: z.string(),
  provider: z.string(),
  cwd: z.string(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string().optional(),
  lastUserMessageAt: z.string().nullable().optional(),
  sideChatPromptAccepted: z.literal(true).optional(),
  title: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).default({}),
  mainControlSystemPrompt: z.string().optional(),
  metadata: z.record(z.string(), z.custom<JsonValue>()).default({}),
  lastStatus: AgentStatusSchema.default("closed"),
  lastUsage: STORED_AGENT_USAGE_SCHEMA.optional(),
  lastTurnCompletedAt: z.iso.datetime().optional(),
  resetEpoch: z.number().int().nonnegative().optional(),
  consecutiveErrors: z.number().int().nonnegative().optional(),
  resumeOnStartup: z.boolean().optional(),
  restartTopicDelegation: topicDelegationTurnSchema.optional(),
  lastModeId: z.string().nullable().optional(),
  config: SERIALIZABLE_CONFIG_SCHEMA,
  launchEnv: z.record(z.string(), z.string()).optional(),
  runtimeInfo: z
    .object({
      provider: z.string(),
      sessionId: z.string().nullable(),
      model: z.string().nullable().optional(),
      thinkingOptionId: z.string().nullable().optional(),
      modeId: z.string().nullable().optional(),
      extra: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  controls: z.array(AgentOptionControlSchema).optional(),
  // COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01. Read-only; becomes controls.
  features: z.array(AgentFeatureSchema).optional(),
  persistence: PERSISTENCE_HANDLE_SCHEMA,
  confirmedRewinds: z.array(confirmedRewindSchema).optional(),
  timelinePrefixSwitchId: z.string().nullable().optional(),
  sessionMetrics: z.array(AgentMetricSchema).optional(),
  lastError: z.string().nullable().optional(),
  failedConversationLimit: FailedConversationLimitSchema.optional(),
  limitContinuation: AgentLimitContinuationSchema.optional(),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: z.string().nullable().optional(),
  internal: z.boolean().optional(),
  background: z.boolean().optional(),
  archivedAt: z.string().nullable().optional(),
  owner: AgentOwnerSchema.optional(),
});

export type SerializableAgentConfig = Pick<
  AgentSessionConfig,
  | "modeId"
  | "model"
  | "thinkingOptionId"
  | "providerOptions"
  | "toolPolicy"
  | "systemPrompt"
  | "mcpServers"
>;

type RawStoredAgentRecord = z.infer<typeof RAW_STORED_AGENT_SCHEMA>;
type RawStoredAgentConfig = NonNullable<RawStoredAgentRecord["config"]>;

/** Records carry `providerOptions` and `controls` only; legacy fields are folded when read. */
export type StoredAgentRecord = Omit<RawStoredAgentRecord, "config" | "features"> & {
  config?: Omit<RawStoredAgentConfig, "featureValues"> | null;
};

export type StoredAgentTurnState = Pick<
  StoredAgentRecord,
  "lastUsage" | "lastTurnCompletedAt" | "resetEpoch" | "consecutiveErrors"
>;

// COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
function foldLegacyRecordFields(record: RawStoredAgentRecord): StoredAgentRecord {
  const { features, config, controls, ...rest } = record;
  return {
    ...rest,
    ...(config ? { config: foldFeatureValues(config) } : { config }),
    ...((controls ?? features) ? { controls: controls ?? controlsFromFeatures(features) } : {}),
  };
}

const STORED_AGENT_SCHEMA = RAW_STORED_AGENT_SCHEMA.transform(foldLegacyRecordFields);

export function parseStoredAgentRecord(value: unknown): StoredAgentRecord {
  return STORED_AGENT_SCHEMA.parse(value);
}

function activeMainWorkspaceId(record: StoredAgentRecord | undefined): string | undefined {
  if (record && !record.archivedAt && !record.internal && isMainControlAgentLabels(record.labels)) {
    return record.workspaceId;
  }
  return undefined;
}

const DELETE_INTENT = "paseo-agent-delete-v1\n";
const DELETE_INTENT_FILENAME = /^\.delete-[a-f0-9]{64}\.intent$/;

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function syncPath(filePath: string, flags: "r" | "r+" = "r"): Promise<void> {
  const handle = await fs.open(filePath, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class SideChatDeleteRefusedError extends Error {}

interface AgentDeleteOptions {
  onlyIfEmptySideChat?: () => boolean;
  prepare?: () => Promise<void>;
}

export class AgentStorage {
  readonly timelinePrefixes: TimelinePrefixStore;
  private cache: Map<string, StoredAgentRecord> = new Map();
  private pathById: Map<string, string> = new Map();
  private pathsById: Map<string, Set<string>> = new Map();
  private pendingWrites: Map<string, Promise<void>> = new Map();
  private readonly pendingDeletes = new Map<string, Promise<void>>();
  private deleting: Set<string> = new Set();
  private readonly deleteIntents = new Set<string>();
  private registryScanComplete = true;
  private readonly unreadableRecordIds = new Set<string>();
  private readonly sideChatInitialPrompts = new Map<string, number>();
  private daemonAgentIdsByExecution: Map<string, string> = new Map();
  private daemonExecutionKeysByAgentId: Map<string, string> = new Map();
  private readonly idsByWorkspace = new Map<string, Set<string>>();
  private readonly workspaceById = new Map<string, string>();
  private readonly activeIds = new Set<string>();
  private readonly mainWorkspaceListeners = new Set<(workspaceIds: readonly string[]) => void>();
  private readonly promptTimeByAgent = new Map<string, string>();
  private readonly promptTimes = new Map<string, string>();
  private loaded = false;
  private baseDir: string;
  private loadPromise: Promise<void> | null = null;
  private logger: Logger;

  constructor(baseDir: string, logger: Logger) {
    this.baseDir = baseDir;
    this.timelinePrefixes = new TimelinePrefixStore(
      baseDir,
      async (agentId) => (await this.get(agentId))?.timelinePrefixSwitchId,
    );
    this.logger = logger.child({ module: "agent", component: "agent-storage" });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  subscribeToMainWorkspaceChanges(listener: (workspaceIds: readonly string[]) => void): () => void {
    this.mainWorkspaceListeners.add(listener);
    return () => this.mainWorkspaceListeners.delete(listener);
  }

  private publishMainWorkspaceChange(before?: string, after?: string): void {
    if (before === after) return;
    const workspaceIds = [before, after].filter((id): id is string => id !== undefined);
    for (const listener of this.mainWorkspaceListeners) listener(workspaceIds);
  }

  async listAll(): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  async listActive(options?: { includeArchived?: boolean }): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(
      options?.includeArchived ? this.cache.keys() : this.activeIds,
      (id) => this.cache.get(id)!,
    );
  }

  async listByWorkspaces(
    workspaceIds: Iterable<string>,
    options?: { includeArchived?: boolean },
  ): Promise<StoredAgentRecord[]> {
    await this.load();
    const records: StoredAgentRecord[] = [];
    for (const workspaceId of new Set(workspaceIds)) {
      for (const id of this.idsByWorkspace.get(workspaceId) ?? []) {
        const record = this.cache.get(id)!;
        if (options?.includeArchived || !record.archivedAt) records.push(record);
      }
    }
    return records;
  }

  async lastUserMessageAtByWorkspace(
    workspaceIds?: Iterable<string>,
    options?: { excludeAgentIds?: Iterable<string> },
  ): Promise<ReadonlyMap<string, string>> {
    await this.load();
    const times = new Map<string, string>();
    const excluded = new Set(options?.excludeAgentIds);
    const affected = new Set(Array.from(excluded, (id) => this.workspaceById.get(id)));
    for (const id of workspaceIds ?? this.promptTimes.keys()) {
      let at = this.promptTimes.get(id);
      if (affected.has(id)) {
        at = undefined;
        for (const agentId of this.idsByWorkspace.get(id) ?? []) {
          const record = this.cache.get(agentId)!;
          if (
            !excluded.has(agentId) &&
            !record.internal &&
            !record.background &&
            record.lastUserMessageAt &&
            record.lastUserMessageAt > (at ?? "")
          ) {
            at = record.lastUserMessageAt;
          }
        }
      }
      if (at) times.set(id, at);
    }
    return times;
  }

  private indexWorkspace(record: StoredAgentRecord): void {
    const previous = this.workspaceById.get(record.id);
    if (previous) this.idsByWorkspace.get(previous)?.delete(record.id);
    this.workspaceById.delete(record.id);
    this.activeIds.delete(record.id);
    if (!record.archivedAt) this.activeIds.add(record.id);
    if (record.workspaceId) {
      const ids = this.idsByWorkspace.get(record.workspaceId) ?? new Set<string>();
      ids.add(record.id);
      this.idsByWorkspace.set(record.workspaceId, ids);
      this.workspaceById.set(record.id, record.workspaceId);
    }
    this.indexPromptTime(record, previous);
  }

  private indexPromptTime(record: StoredAgentRecord, previous: string | undefined): void {
    const previousTime = this.promptTimeByAgent.get(record.id);
    const nextTime =
      !record.internal && !record.background ? (record.lastUserMessageAt ?? undefined) : undefined;
    if (nextTime) this.promptTimeByAgent.set(record.id, nextTime);
    else this.promptTimeByAgent.delete(record.id);
    if (previous === record.workspaceId && previousTime === nextTime) return;
    if (
      previous &&
      previousTime &&
      this.promptTimes.get(previous) === previousTime &&
      (previous !== record.workspaceId || !nextTime || nextTime < previousTime)
    ) {
      this.refreshPromptTime(previous);
    }
    if (
      record.workspaceId &&
      nextTime &&
      nextTime > (this.promptTimes.get(record.workspaceId) ?? "")
    ) {
      this.promptTimes.set(record.workspaceId, nextTime);
    }
  }

  private refreshPromptTime(workspaceId: string): void {
    this.promptTimes.delete(workspaceId);
    let latest = "";
    for (const id of this.idsByWorkspace.get(workspaceId) ?? []) {
      const record = this.cache.get(id)!;
      if (
        !record.internal &&
        !record.background &&
        record.lastUserMessageAt &&
        record.lastUserMessageAt > latest
      )
        latest = record.lastUserMessageAt;
    }
    if (latest) this.promptTimes.set(workspaceId, latest);
  }

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    await this.load();
    return this.cache.get(agentId) ?? null;
  }

  async hasDeletedAgent(agentId: string): Promise<boolean> {
    await this.load();
    if (
      !this.registryScanComplete ||
      this.cache.has(agentId) ||
      this.unreadableRecordIds.has(agentId)
    )
      return false;
    const name = this.deleteIntentName(agentId);
    if (!this.deleteIntents.has(name)) return false;
    try {
      const marker = await fs.readFile(path.join(this.baseDir, name), "utf8");
      return (
        marker === DELETE_INTENT &&
        this.deleteIntents.has(name) &&
        !this.cache.has(agentId) &&
        !this.pendingWrites.has(agentId)
      );
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      return false;
    }
  }

  async listByProviderSession(
    provider: string,
    providerHandleId: string,
  ): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values()).filter(
      (record) =>
        record.persistence?.provider === provider &&
        (record.persistence.sessionId === providerHandleId ||
          record.persistence.nativeHandle === providerHandleId),
    );
  }

  async listByWorkspace(workspaceId: string): Promise<StoredAgentRecord[]> {
    return this.listByWorkspaces([workspaceId], { includeArchived: true });
  }

  async findByDaemonExecution(owner: DaemonAgentOwner): Promise<StoredAgentRecord | null> {
    await this.load();
    const agentId = this.daemonAgentIdsByExecution.get(daemonExecutionKey(owner));
    return agentId ? (this.cache.get(agentId) ?? null) : null;
  }

  async upsert(record: StoredAgentRecord, options?: { requireWritable?: boolean }): Promise<void> {
    await this.load();
    if (options?.requireWritable) await this.recheckDeleteBeforeWrite(record.id);
    await this.queueRecordWrite(record, options?.requireWritable);
  }

  async updateLimitContinuation(
    agentId: string,
    mutate: (record: StoredAgentRecord) => AgentLimitContinuation | null,
  ): Promise<StoredAgentRecord | null> {
    await this.load();
    let updated: StoredAgentRecord | null = null;
    await this.queueRecordMutation(agentId, (record) => {
      if (!record) return null;
      const next = mutate(record);
      if (!next) return null;
      updated = { ...record, limitContinuation: next };
      return updated;
    });
    return updated;
  }

  async setRunningAgentRecovery(agentId: string, resumeOnStartup: boolean): Promise<boolean> {
    await this.load();
    let captured = false;
    await this.queueRecordMutation(agentId, (record) => {
      if (
        record?.lastStatus !== "running" ||
        record.archivedAt ||
        record.internal ||
        record.owner
      ) {
        return null;
      }
      captured = true;
      return { ...record, resumeOnStartup };
    });
    return captured;
  }

  async clearAgentRecovery(agentId: string): Promise<void> {
    await this.load();
    await this.queueRecordMutation(agentId, (record) => {
      if (!record) return null;
      const keepActiveDelegation = record.lastStatus === "running";
      if (!record.resumeOnStartup && (keepActiveDelegation || !record.restartTopicDelegation))
        return null;
      return {
        ...record,
        resumeOnStartup: false,
        restartTopicDelegation: keepActiveDelegation ? record.restartTopicDelegation : undefined,
      };
    });
  }

  private queueRecordWrite(record: StoredAgentRecord, requireWritable?: boolean): Promise<void> {
    return this.queueRecordMutation(
      record.id,
      (existing) => ({
        ...record,
        limitContinuation: existing?.limitContinuation,
        ...(existing?.confirmedRewinds && { confirmedRewinds: existing.confirmedRewinds }),
      }),
      requireWritable,
    );
  }

  private queueRecordMutation(
    agentId: string,
    mutate: (existing: StoredAgentRecord | null) => StoredAgentRecord | null,
    requireWritable = false,
  ): Promise<void> {
    if (this.deleting.has(agentId)) {
      return requireWritable ? Promise.reject(this.deleteBlockedWrite(agentId)) : Promise.resolve();
    }
    const prev = this.pendingWrites.get(agentId) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (this.deleting.has(agentId)) {
        if (requireWritable) throw this.deleteBlockedWrite(agentId);
        return undefined;
      }

      const existing = this.cache.get(agentId) ?? null;
      const record = mutate(existing);
      if (record) {
        if (!record.confirmedRewinds && existing?.confirmedRewinds) {
          record.confirmedRewinds = existing.confirmedRewinds;
        }
        // Provider snapshots and lifecycle updates cannot clear first-prompt evidence.
        record.limitContinuation ??= existing?.limitContinuation;
        if (record.archivedAt) {
          record.failedConversationLimit = undefined;
          if (record.limitContinuation?.status === "scheduled") {
            record.limitContinuation = { ...record.limitContinuation, status: "cancelled" };
          }
        }
        await this.writeRecord(
          existing?.sideChatPromptAccepted ? { ...record, sideChatPromptAccepted: true } : record,
        );
      }
      return undefined;
    });

    const tracked = next.finally(() => {
      if (this.pendingWrites.get(agentId) === tracked) {
        this.pendingWrites.delete(agentId);
      }
    });

    this.pendingWrites.set(agentId, tracked);
    return tracked;
  }

  private deleteBlockedWrite(agentId: string): Error {
    return new Error(
      `Could not update agent ${agentId} during or after deletion. Refresh and retry.`,
    );
  }

  private async writeRecord(record: StoredAgentRecord): Promise<void> {
    const agentId = record.id;
    const nextPath = this.buildRecordPath(record);
    const previousPath = this.pathById.get(agentId);

    await this.clearDeleteIntent(agentId);
    await writeJsonFileAtomic(nextPath, record);
    this.addIndexedPath(agentId, nextPath);

    if (previousPath && previousPath !== nextPath) {
      try {
        // Compare the entries after the atomic replacement. On a case-insensitive
        // volume both spellings can now address the file we just wrote.
        const [previous, next] = await Promise.all([
          fs.lstat(previousPath, { bigint: true }),
          fs.lstat(nextPath, { bigint: true }),
        ]);
        if (previous.dev !== next.dev || previous.ino !== next.ino) {
          await fs.unlink(previousPath);
        }
        this.removeIndexedPath(agentId, previousPath);
      } catch (error) {
        // Keep an unsuccessfully removed copy in the set that an explicit delete must remove.
        if (isMissingFile(error)) this.removeIndexedPath(agentId, previousPath);
      }
    }

    const previousMainWorkspaceId = activeMainWorkspaceId(this.cache.get(agentId));
    this.cache.set(agentId, record);
    this.indexOwner(record);
    this.pathById.set(agentId, nextPath);
    this.publishMainWorkspaceChange(previousMainWorkspaceId, activeMainWorkspaceId(record));
  }

  private deleteIntentName(agentId: string): string {
    return `.delete-${createHash("sha256").update(agentId).digest("hex")}.intent`;
  }

  private async persistDeleteIntent(agentId: string): Promise<void> {
    const name = this.deleteIntentName(agentId);
    const filePath = path.join(this.baseDir, name);
    await writeFileAtomic(filePath, DELETE_INTENT);
    this.deleteIntents.add(name);
    await syncPath(filePath, "r+");
    if (process.platform !== "win32") await syncPath(this.baseDir);
  }

  private async clearDeleteIntent(agentId: string): Promise<void> {
    if (!this.deleteIntents.size) return;
    const name = this.deleteIntentName(agentId);
    if (!this.deleteIntents.has(name)) return;
    await fs.rm(path.join(this.baseDir, name), { force: true });
    if (process.platform !== "win32") await syncPath(this.baseDir);
    this.deleteIntents.delete(name);
  }

  reserveSideChatInitialPrompt(agentId: string): () => void {
    this.sideChatInitialPrompts.set(agentId, (this.sideChatInitialPrompts.get(agentId) ?? 0) + 1);
    return () => {
      const remaining = (this.sideChatInitialPrompts.get(agentId) ?? 1) - 1;
      if (remaining) this.sideChatInitialPrompts.set(agentId, remaining);
      else this.sideChatInitialPrompts.delete(agentId);
    };
  }

  async acceptSideChatPrompt(agentId: string): Promise<void> {
    await this.load();
    let accepted = false;
    await this.queueRecordMutation(agentId, (record) => {
      if (!record || !isSideChatAgentLabels(record.labels)) return null;
      accepted = true;
      return record.sideChatPromptAccepted ? null : { ...record, sideChatPromptAccepted: true };
    });
    if (!accepted) throw new Error("The side chat is no longer available.");
  }

  private async beginEmptySideChatDelete(
    agentId: string,
    hasLivePrompt: () => boolean,
  ): Promise<boolean> {
    let deleting = false;
    await this.queueRecordMutation(agentId, (record) => {
      if (
        record &&
        isSideChatAgentLabels(record.labels) &&
        !record.archivedAt &&
        !record.sideChatPromptAccepted &&
        !hasOpenAgentTab(record.labels) &&
        !this.sideChatInitialPrompts.has(agentId) &&
        !record.lastUserMessageAt &&
        !hasLivePrompt()
      ) {
        // Set the fence while holding the same write queue that accepts prompts.
        this.deleting.add(agentId);
        deleting = true;
      }
      return null;
    });
    return deleting;
  }

  async remove(agentId: string, options?: AgentDeleteOptions): Promise<void> {
    await this.load();
    await this.serializeDelete(agentId, () => this.removeOnce(agentId, options));
  }

  private async serializeDelete(agentId: string, run: () => Promise<void>): Promise<void> {
    const previous = this.pendingDeletes.get(agentId) ?? Promise.resolve();
    const removal = previous.catch(() => undefined).then(run);
    this.pendingDeletes.set(agentId, removal);
    try {
      await removal;
    } finally {
      if (this.pendingDeletes.get(agentId) === removal) this.pendingDeletes.delete(agentId);
    }
  }

  private async recheckDeleteBeforeWrite(agentId: string): Promise<void> {
    // A delete may be waiting for the same lifecycle operation that is writing.
    // Only recheck a previous failure. The write queue checks the fence again.
    if (
      this.deleting.has(agentId) &&
      !this.pendingDeletes.has(agentId) &&
      this.pathsById.has(agentId)
    ) {
      await this.serializeDelete(agentId, () => this.restoreAfterFailedDelete(agentId));
    }
  }

  private async removeOnce(agentId: string, options?: AgentDeleteOptions): Promise<void> {
    if (options?.onlyIfEmptySideChat) {
      // A previous delete can leave writes blocked while its snapshots are unreadable.
      if (this.deleting.has(agentId) && this.pathsById.has(agentId)) {
        await this.restoreAfterFailedDelete(agentId);
        if (this.deleting.has(agentId) && this.pathsById.has(agentId)) {
          throw new Error("Could not verify the stored side chat after an incomplete delete");
        }
      }
      if (!(await this.beginEmptySideChatDelete(agentId, options.onlyIfEmptySideChat)))
        throw new SideChatDeleteRefusedError("This side chat cannot be discarded.");
    } else {
      this.deleting.add(agentId);
    }

    try {
      await options?.prepare?.();
      await this.pendingWrites.get(agentId);
      await this.removeRecordFiles(agentId);
    } catch (error) {
      try {
        await this.restoreAfterFailedDelete(agentId);
      } catch (recoveryError) {
        this.logger.warn(
          { err: recoveryError, agentId },
          "Failed to recover agent after incomplete delete",
        );
      }
      throw error;
    }

    this.forgetDeletedAgent(agentId);
    try {
      await this.timelinePrefixes.delete(agentId);
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Failed to remove deleted agent timeline prefix");
    }
  }

  private async removeRecordFiles(agentId: string): Promise<void> {
    const paths = Array.from(this.pathsById.get(agentId) ?? []);
    // Keep the record of the user's delete as long as its ID is retired. A later
    // snapshot for that ID clears it. A plan alone cannot prove all copies are gone.
    if (paths.length) await this.persistDeleteIntent(agentId);
    // Keep the current snapshot until every other indexed copy is gone.
    const current = this.pathById.get(agentId);
    const unlinks = await Promise.allSettled(
      paths
        .filter((filePath) => filePath !== current)
        .map((filePath) => this.unlinkRecord(agentId, filePath)),
    );
    const failed = unlinks.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    if (current) await this.unlinkRecord(agentId, current);
  }

  private async unlinkRecord(agentId: string, filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (!isMissingFile(error)) {
        this.logger.warn({ err: error, agentId, filePath }, "Failed to remove agent record file");
        throw error;
      }
    }
    this.removeIndexedPath(agentId, filePath);
  }

  private async restoreAfterFailedDelete(agentId: string): Promise<void> {
    // Preparation can fail before the flush finishes. Keep the fence until the
    // existing write settles and the remaining records can be checked on disk.
    await this.waitForPendingWrite(agentId);
    const current = this.pathById.get(agentId);
    const paths = Array.from(this.pathsById.get(agentId) ?? []);
    let survivor: string | undefined;
    for (const filePath of paths) {
      try {
        const record = parseStoredAgentRecord(JSON.parse(await fs.readFile(filePath, "utf8")));
        if (record.id === agentId && (!survivor || filePath === current)) survivor = filePath;
      } catch (error) {
        if (isMissingFile(error)) this.removeIndexedPath(agentId, filePath);
        else
          this.logger.warn(
            { err: error, agentId, filePath },
            "Could not verify remaining agent snapshot",
          );
      }
    }
    if (!survivor) {
      if (!this.pathsById.has(agentId)) this.forgetDeletedAgent(agentId);
      return;
    }

    this.pathById.set(agentId, survivor);
    try {
      await this.clearDeleteIntent(agentId);
    } finally {
      // A verified snapshot wins over an intent. If its cleanup failed, the next
      // write will retry clearing it before replacing the snapshot.
      this.deleting.delete(agentId);
    }
  }

  private forgetDeletedAgent(agentId: string): void {
    const workspaceId = this.workspaceById.get(agentId);
    this.workspaceById.delete(agentId);
    this.promptTimeByAgent.delete(agentId);
    this.activeIds.delete(agentId);
    if (workspaceId) {
      this.idsByWorkspace.get(workspaceId)?.delete(agentId);
      this.refreshPromptTime(workspaceId);
    }
    const previousMainWorkspaceId = activeMainWorkspaceId(this.cache.get(agentId));
    this.cache.delete(agentId);
    this.removeOwnerIndex(agentId);
    this.pathById.delete(agentId);
    this.pathsById.delete(agentId);
    this.publishMainWorkspaceChange(previousMainWorkspaceId);
  }

  async applySnapshot(
    agent: ManagedAgent,
    options?: {
      title?: string | null;
      internal?: boolean;
      requireWritable?: boolean;
      timelinePrefixSwitchId?: string | null;
      confirmedRewind?: ConfirmedRewind;
    },
  ): Promise<void> {
    await this.load();
    if (options?.requireWritable) await this.recheckDeleteBeforeWrite(agent.id);
    const hasTitleOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "title");
    const hasInternalOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "internal");
    const switchId = options?.timelinePrefixSwitchId;
    const titleOverride = options?.title ?? null;
    const internalOverride = options?.internal;
    const confirmed = options?.confirmedRewind;
    await this.queueRecordMutation(
      agent.id,
      (existing) => {
        if (switchId !== undefined && !existing) {
          throw new Error(`Agent ${agent.id} disappeared during provider switch`);
        }
        const record = toStoredAgentRecord(agent, {
          title: hasTitleOverride ? titleOverride : (existing?.title ?? null),
          createdAt: existing?.createdAt,
          internal: hasInternalOverride ? internalOverride : (agent.internal ?? existing?.internal),
        });
        record.mainControlSystemPrompt = agent.mainControlSystemPrompt;
        if (confirmed) record.confirmedRewinds = appendConfirmedRewind(agent, existing, confirmed);

        // Preserve soft-delete/archive status across snapshot flushes. The
        // projection runs inside the per-agent write queue so it cannot commit a
        // stale pre-archive record after the archive mutation.
        record.archivedAt = existing?.archivedAt;
        record.timelinePrefixSwitchId =
          switchId === undefined ? existing?.timelinePrefixSwitchId : switchId;
        // Background is fixed at creation; a runtime opened without it cannot clear it.
        if (existing?.background) record.background = true;
        record.resumeOnStartup =
          existing?.resumeOnStartup && agent.lifecycle !== "idle" && agent.lifecycle !== "error";
        record.restartTopicDelegation = projectRestartTopicDelegation(agent, existing);
        return record;
      },
      options?.requireWritable,
    );
    if (confirmed && !this.cache.get(agent.id)?.confirmedRewinds?.includes(confirmed)) {
      throw new Error("Could not persist conversation rewind confirmation");
    }
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    await this.load();
    await this.waitForPendingWrite(agentId);
    const record = await this.get(agentId);
    if (!record) {
      throw new Error(`Agent ${agentId} not found`);
    }
    await this.upsert({ ...record, title }, { requireWritable: true });
  }

  async flush(): Promise<void> {
    await this.load().catch(() => undefined);
    const writes = Array.from(this.pendingWrites.values());
    await Promise.allSettled(writes);
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
    }

    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    this.cache.clear();
    this.pathById.clear();
    this.pathsById.clear();
    this.daemonAgentIdsByExecution.clear();
    this.daemonExecutionKeysByAgentId.clear();

    try {
      await this.scanDisk();
      this.loaded = true;
    } catch (error) {
      if (isMissingFile(error)) {
        this.loaded = true;
        return;
      }
      this.registryScanComplete = false;
      this.logger.error({ err: error }, "Failed to load agents");
      this.loaded = true;
    }
  }

  private async scanDisk(): Promise<void> {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (entry.isFile() && DELETE_INTENT_FILENAME.test(entry.name))
        this.deleteIntents.add(entry.name);
    }

    const rootRecordPaths = entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith(".json") && !isTimelinePrefixFilename(entry.name),
      )
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectFileLists = await Promise.all(
      projectDirs.map(async (projectDir) => {
        try {
          const files = await fs.readdir(projectDir, { withFileTypes: true });
          return files
            .filter((file) => file.isFile() && file.name.endsWith(".json"))
            .map((file) => path.join(projectDir, file.name));
        } catch (error) {
          if (!isMissingFile(error)) this.registryScanComplete = false;
          return [];
        }
      }),
    );

    const allFilePaths = [...rootRecordPaths, ...projectFileLists.flat()];
    const loaded = await Promise.all(
      allFilePaths.map(async (filePath) => {
        const record = await this.readRecordFile(filePath);
        return record ? { record, filePath } : null;
      }),
    );

    for (const item of loaded) {
      if (!item) continue;
      const { record, filePath } = item;
      this.cache.set(record.id, record);
      this.indexOwner(record);
      this.pathById.set(record.id, filePath);
      this.addIndexedPath(record.id, filePath);
    }
  }

  private async readRecordFile(filePath: string): Promise<StoredAgentRecord | null> {
    let parsed: unknown;
    try {
      const content = await fs.readFile(filePath, "utf8");
      parsed = JSON.parse(content);
      return parseStoredAgentRecord(parsed);
    } catch (error) {
      if (parsed === undefined && !isMissingFile(error)) this.registryScanComplete = false;
      // Schema failures with a readable identity also count as remaining copies.
      if (parsed && typeof parsed === "object" && "id" in parsed && typeof parsed.id === "string")
        this.unreadableRecordIds.add(parsed.id);
      this.unreadableRecordIds.add(path.basename(filePath, ".json"));
      this.logger.error({ err: error, filePath }, "Skipping invalid agent record");
      return null;
    }
  }

  private buildRecordPath(record: StoredAgentRecord): string {
    const projectDir = projectDirNameFromCwd(record.cwd);
    return path.join(this.baseDir, projectDir, `${record.id}.json`);
  }

  private addIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId) ?? new Set<string>();
    paths.add(filePath);
    this.pathsById.set(agentId, paths);
  }

  private removeIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId);
    if (!paths) {
      return;
    }
    paths.delete(filePath);
    if (paths.size === 0) {
      this.pathsById.delete(agentId);
    }
  }

  private indexOwner(record: StoredAgentRecord): void {
    this.indexWorkspace(record);
    this.removeOwnerIndex(record.id);
    if (record.owner?.kind === "daemon") {
      const key = daemonExecutionKey(record.owner);
      const previousAgentId = this.daemonAgentIdsByExecution.get(key);
      if (previousAgentId && previousAgentId !== record.id) {
        this.daemonExecutionKeysByAgentId.delete(previousAgentId);
      }
      this.daemonAgentIdsByExecution.set(key, record.id);
      this.daemonExecutionKeysByAgentId.set(record.id, key);
    }
  }

  private removeOwnerIndex(agentId: string): void {
    const key = this.daemonExecutionKeysByAgentId.get(agentId);
    if (!key) return;
    if (this.daemonAgentIdsByExecution.get(key) === agentId) {
      this.daemonAgentIdsByExecution.delete(key);
    }
    this.daemonExecutionKeysByAgentId.delete(agentId);
  }

  private async waitForPendingWrite(agentId: string): Promise<void> {
    await (this.pendingWrites.get(agentId) ?? Promise.resolve()).catch(() => undefined);
  }
}

function projectDirNameFromCwd(cwd: string): string {
  // path.win32.parse handles drive letters, UNC roots, and Unix roots on all platforms
  const { root } = path.win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  // Sanitize root: strip colons and separators, keep letters (e.g. "C:\" → "C", "\\server\share\" → "server-share")
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? sanitizedRoot + "-" : "";
  if (!withoutRoot) {
    return sanitizedRoot || "root";
  }
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}
