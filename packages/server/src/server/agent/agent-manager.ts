import type { AttachedAgentTool, PluginAgentToolsRuntime } from "../plugins/agent-tools.js";
import { ProviderOptionsValidationError } from "./provider-options.js";
import type { AgentToolResult } from "@getpaseo/plugin/server";
import type { RuntimeCleanupCandidate } from "./idle-runtime-cleanup/index.js";
import { AgentNotFoundError, ensureAgentLoaded } from "./agent-loading.js";
import { continuesAssistantMessage, projectTimelineRows } from "./timeline-projection.js";
import { buildAgentForkContextAttachment } from "./activity-curator.js";
import type { PluginLifecycle } from "../plugins/lifecycle/index.js";
import { describeHookAgent, publishAgentStream } from "../plugins/lifecycle/index.js";
import { applyRecordPatch } from "../record-patch.js";
import type { FinishRegistration } from "./finish-subscriptions/index.js";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { createHash, randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  AGENT_LIFECYCLE_STATUSES,
  type AgentLifecycleStatus,
} from "@getpaseo/protocol/agent-lifecycle";
import {
  getMainPriorModeIdFromLabels,
  getParentAddressFromLabels,
  getParentAgentIdFromLabels,
  isExplicitParentReportingLabels,
  hasOpenAgentTab,
  isDelegatedAgent,
  isMainControlAgentLabels,
  isOpenAgentTabLabel,
  MAIN_PRIOR_MODE_ID_LABEL,
  PARENT_AGENT_ID_LABEL,
  PARENT_SERVER_ID_LABEL,
  WORKSPACE_MAIN_ROLE,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { Logger } from "pino";
import type { ToolPolicy } from "@getpaseo/protocol/agent-types";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";
import { z } from "zod";
import type { TerminalManager } from "../../terminal/terminal-manager.js";

import {
  AgentTurnStartCanceledError,
  AgentTurnStartRejectedError,
  type AgentCommandOutcome,
  getAgentStreamEventTurnId,
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentCreateSessionOptions,
  type AgentResumePurpose,
  type AgentResumeSessionOptions,
  type AgentDraftControls,
  type AgentOptionControl,
  type AgentLaunchContext,
  type AgentSlashCommand,
  type AgentMode,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentPermissionResult,
  type AgentPersistenceHandle,
  type AgentProviderNotice,
  type AgentPromptInput,
  type AgentProvider,
  type AgentRunOptions,
  type AgentSteerOptions,
  type AgentRunResult,
  type AgentSession,
  type AgentSessionConfig,
  type SteerResult,
  type AgentStreamEvent,
  type AgentTimelineItem,
  type AgentUsage,
  type AgentRuntimeInfo,
  type ImportedTimelineEntry,
  type ImportableProviderSession,
  type ListImportableSessionsOptions,
} from "./agent-sdk-types.js";
import { buildArchivedAgentRecord, type ArchivedStoredAgentRecord } from "./agent-archive.js";
import type { JsonValue, ProviderOptions } from "@getpaseo/protocol/agent-types";
import { buildSerializableConfig, toStoredAgentRecord } from "./agent-projections.js";
import {
  applyProviderOptionsPatch,
  exposeFeatureValuesToHook,
  convertLegacyOptions,
  convertLegacyClaudeUltracode,
  MalformedLegacyOptionError,
  resolveAdapter,
  foldFeatureValues,
  foldHookFeatureValues,
  type LegacyFeatureValues,
  type ProviderOptionsPatch,
} from "./option-controls.js";
import type { StoredAgentRecord, AgentStorage } from "./agent-storage.js";
import type { AgentWorkspaceMoveJournal } from "./agent-workspace-move-journal.js";
import type { AgentOwner } from "./agent-owner.js";
import {
  InMemoryAgentTimelineStore,
  type SeedAgentTimelineOptions,
} from "./agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";
import {
  AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS,
  AgentStreamCoalescer,
} from "./agent-stream-coalescer.js";
import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";
import {
  AgentRunState,
  type ForegroundPromptStart,
  type ForegroundTurnWaiter,
  type PendingForegroundRun,
} from "./agent-run-state.js";
import { invokeRewindCapability, type RewindMode } from "./rewind/rewind.js";
import {
  parseAgentMessage,
  parseAgentMessages,
  projectAgentMessages,
} from "./agent-messages/index.js";
import {
  extractSubmittedPromptForkContext,
  stripContextHandoffEnvelope,
} from "./agent-messages/envelope.js";
import {
  buildContextHandoffEnvelope,
  fallbackContextSummary,
  injectContextHandoffIntoPrompt,
  splitContextHandoff,
  summarizeContextHandoff,
  waitForAbort,
  waitForContextSummary,
  type ContextHandoff,
} from "./context-handoff.js";
import {
  retainTimelinePrefixRows,
  TimelinePrefixStore,
  type PersistedTimelinePrefix,
} from "./timeline-prefix-store.js";
import { isStaleProviderSessionError } from "./stale-provider-session-error.js";
import {
  PASEO_MCP_SERVER_NAME,
  stripInternalPaseoMcpServer,
  withRuntimePaseoMcpServer,
} from "./runtime-mcp-config.js";
import { resolveCreateAgentTitles } from "./create-agent-title.js";
import type { PaseoToolCatalogFactory } from "./tools/types.js";
import { isPaseoToolPolicyEnabled, resolveAgentPaseoToolPolicy } from "./paseo-tool-policy.js";
import {
  applyMainControlReadOnlyConfig,
  buildHierarchyAppendSystemPrompt,
  computeAgentDepth,
  hasReservedHierarchyLabels,
  type HierarchyAgent,
  isMainControlWritePermissionBlocked,
  MAIN_CONTROL_WRITE_DENIAL,
  MAIN_CONTROL_PROMPT_HEADER,
  mainControlPromptEnd,
  stripMainControlPromptHeader,
  MAX_SUBAGENT_DEPTH,
  readLocalSubtreeDepths,
  REMOTE_HIERARCHY_DEPTH_LABEL,
  RESERVED_HIERARCHY_LABELS_ERROR,
  validateCanSpawnChild,
  validateSetAgentParent,
} from "./hierarchy-policy.js";
import {
  ProviderSubagentStore,
  type ProviderSubagentDescriptor,
  type ProviderSubagentStoreEvent,
} from "./provider-subagents/store.js";
import {
  AgentBackgroundWorkStore,
  isDaemonBackgroundWorkItem,
  type AgentBackgroundWorkItem,
  type DaemonBackgroundWorkInput,
  type DaemonBackgroundWorkKey,
} from "./background-work/index.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import { createRealpathAwarePathMatcher } from "../../utils/path.js";
import {
  buildConfigOverrides,
  buildSessionConfig,
  extractAttention,
  toAgentPersistenceHandle,
} from "../persistence-hooks.js";

const HIERARCHY_SYSTEM_PROMPT_ADAPTERS = new Set(["claude", "codex", "opencode", "pi", "omp"]);
const RELOAD_SESSION_CLOSE_TIMEOUT_MS = 3_000;
const INTERRUPT_SESSION_TIMEOUT_MS = 2_000;
const IMPORTABLE_SESSION_LIST_TIMEOUT_MS = 90_000;
const STORED_AGENT_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

type TimeoutResult = "completed" | "timed_out";

function submittedPromptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .flatMap((block) => (block.type === "text" && !("mimeType" in block) ? [block.text] : []))
    .join("\n")
    .trim();
}

export class AgentManagerShuttingDownError extends Error {
  constructor() {
    super("Agent manager is shutting down");
    this.name = "AgentManagerShuttingDownError";
  }
}

export class AgentCommandNotDispatchedError extends Error {
  constructor(cause?: unknown) {
    super("Out-of-band command did not reach the provider", { cause });
    this.name = "AgentCommandNotDispatchedError";
  }
}

// Preserve the shutdown classification for durable queued sends while retaining a
// display message for timeline consumers.
function foregroundStartFailure(error: unknown, message: string) {
  return {
    status: "failed" as const,
    error: message,
    admissionError: error instanceof AgentManagerShuttingDownError ? error : undefined,
  };
}

export class AgentRunCancellationError extends Error {
  constructor(agentId: string, action: "reload" | "replace" | "rewind" | "stop") {
    super(
      `Cannot ${action} agent ${agentId} because its active run cancellation was not acknowledged`,
    );
    this.name = "AgentRunCancellationError";
  }
}

export type AgentRunCancellationResult =
  | { status: "not_running" }
  | { status: "settled" }
  | { status: "refused" };

/** A session that will run in a directory needs that directory to be there. */
async function assertUsableWorkingDirectory(cwd: string): Promise<void> {
  try {
    const stats = await stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: ${cwd}`);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(`Working directory does not exist: ${cwd}`, { cause: error });
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to access working directory: ${cwd}`, { cause: error });
  }
}

interface StopAgentBackgroundWorkOptions {
  agentId: string;
  itemId: string;
  stopToken: string;
  canManageAutomation?: boolean;
}

async function resolveResumePurpose(
  record: StoredAgentRecord | null,
  requested: AgentResumePurpose | undefined,
  cwd: string,
): Promise<AgentResumePurpose> {
  if (!record) return requested ?? "interactive";
  if (record.archivedAt) return "history";
  if (requested !== "history") return "interactive";
  try {
    await stat(cwd);
    return "interactive";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "history";
    throw error;
  }
}

interface PreparedSessionConfig {
  storedConfig: AgentSessionConfig;
  launchConfig: AgentSessionConfig;
  paseoToolPolicy: ProviderPaseoToolsPolicy | undefined;
}

interface NormalizeConfigOptions {
  resolveDefaultModel?: boolean;
  env?: Record<string, string>;
  /** Defaults to interactive. A history load reads persisted state and runs nothing. */
  purpose?: AgentResumePurpose;
}

interface PrepareSessionConfigOptions extends NormalizeConfigOptions {
  labels?: Record<string, string>;
  mainControlSystemPrompt?: string;
}

interface AgentRelationshipUpdate {
  record: StoredAgentRecord;
  live: boolean;
  archivedSource?: boolean;
}

interface MainControlRoleChange {
  targetRecord: StoredAgentRecord;
  enabled: boolean;
  workspaceId: string | undefined;
  previousMainIds: string[];
}

interface MainControlRoleUpdate {
  labels: Record<string, string>;
  modeId?: string;
  enabled: boolean;
  mainControlSystemPrompt?: string;
}

interface AgentParentUpdate extends AgentRelationshipUpdate {
  previousParentAgentId: string | null;
  wasRunning: boolean;
}

export const REMOTE_CHILD_RESERVATION_LABEL = "paseo.remote-child-reservation";
type CheckRemoteChildReservation = (destination: string, reservationId: string) => Promise<boolean>;

interface WorkspaceHierarchyAgent extends HierarchyAgent {
  workspaceId?: string;
}

interface TimeoutOptions {
  operation: Promise<void>;
  timeoutMs: number;
  onLateError?: (error: unknown) => void;
}

function formatProviderList(providers: readonly string[]): string {
  return providers.length > 0 ? providers.join(", ") : "none";
}

function buildStoredAgentConfig(record: StoredAgentRecord): AgentSessionConfig {
  const config: AgentSessionConfig = {
    provider: record.provider,
    cwd: record.cwd,
  };
  // lastModeId is the last live mode — it also covers provider-side switches
  // that never reach record.config.modeId.
  const modeId = record.lastModeId ?? record.config?.modeId;
  if (modeId != null) config.modeId = modeId;
  if (!record.config) {
    return config;
  }
  if (record.config.model != null) config.model = record.config.model;
  if (record.config.thinkingOptionId != null) {
    config.thinkingOptionId = record.config.thinkingOptionId;
  }
  if (record.config.providerOptions != null) {
    config.providerOptions = record.config.providerOptions;
  }
  if (record.config.toolPolicy != null) config.toolPolicy = record.config.toolPolicy;
  if (record.config.systemPrompt != null) {
    config.systemPrompt = record.config.systemPrompt;
  }
  if (record.config.mcpServers != null) config.mcpServers = record.config.mcpServers;
  return stripInternalPaseoMcpServer(config);
}

export { AGENT_LIFECYCLE_STATUSES, type AgentLifecycleStatus };
export type {
  AgentTimelineCursor,
  AgentTimelineFetchDirection,
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineWindow,
} from "./agent-timeline-store-types.js";

export type AgentManagerEvent =
  | { type: "agent_state"; agent: ManagedAgent }
  | { type: "agent_removed"; agentId: string; workspaceId?: string; internal: boolean }
  | { type: "provider_subagent"; event: ProviderSubagentStoreEvent }
  | { type: "background_work"; agentId: string; items: AgentBackgroundWorkItem[] }
  | { type: "timeline_replacement"; agentId: string; epoch: string }
  | {
      type: "agent_stream";
      agentId: string;
      event: AgentStreamEvent;
      seq?: number;
      epoch?: string;
      timestamp?: string;
    };

export type AgentSubscriber = (event: AgentManagerEvent) => void;

export interface SubscribeOptions {
  agentId?: string;
  replayState?: boolean;
  /** Receive events for internal agents too. Off by default for global subscribers. */
  includeInternal?: boolean;
}

interface HydrateTimelineOptions {
  force?: boolean;
  broadcast?: boolean | (() => boolean);
  broadcastTimeline?: boolean;
  /** The loader already opened a session. A concurrent archive may have closed it. */
  whileRegistered?: boolean;
}

export type ImportablePersistedAgentQueryOptions = ListImportableSessionsOptions & {
  /**
   * When set, only providers in this set are scanned, in addition to the
   * built-in importable allowlist + enabled + non-derived rules.
   */
  providerFilter?: Set<string>;
};

export interface ManagedImportableProviderSession extends ImportableProviderSession {
  provider: AgentProvider;
}

export interface ImportableSessionProviderError {
  provider: AgentProvider;
  message: string;
}

export interface ManagedImportableSessionsResult {
  sessions: ManagedImportableProviderSession[];
  providerErrors: ImportableSessionProviderError[];
}

export type AgentAttentionCallback = (params: {
  agentId: string;
  provider: AgentProvider;
  reason: "finished" | "error" | "permission";
  /** When the agent's current unread attention started; null when the agent is read. */
  attentionTimestamp: Date | null;
}) => void;

export type AgentArchivedCallback = (agentId: string) => Promise<void> | void;
export type AgentRunAcceptedCallback = (agentId: string) => Promise<void> | void;

export interface ProviderAvailability {
  provider: AgentProvider;
  available: boolean;
  error: string | null;
}

interface AgentManagerRescueTimeouts {
  reloadSessionCloseMs?: number;
  interruptSessionMs?: number;
}

interface ProviderEnabledFlag {
  enabled: boolean;
  derivedFromProviderId?: string | null;
  applyToolPolicy?: (
    config: AgentSessionConfig,
    toolPolicy: ToolPolicy | undefined,
  ) => AgentSessionConfig;
}
type ProviderEnabledMap = Partial<Record<AgentProvider, ProviderEnabledFlag>>;
type ProviderClientMap = Partial<Record<AgentProvider, AgentClient>>;

export interface CreateAgentOptions {
  labels?: Record<string, string>;
  metadata?: AgentMetadata;
  initialPrompt?: string;
  forkedTimelineRows?: AgentTimelineRow[];
  env?: Record<string, string>;
  persistSession?: boolean;
  initialTitle?: string | null;
  // undefined is an explicit decision: the agent never appears in the sidebar.
  workspaceId: string | undefined;
  inheritParentWorkspace?: boolean;
  owner?: AgentOwner;
  /** Background agents stay out of discovery, tabs, tracks and attention. Fixed at creation. */
  background?: boolean;
}

interface SwitchAgentProviderInput {
  provider: AgentProvider;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  options?: ProviderOptionsPatch;
}

export interface MoveSubagentToWorkspaceSource {
  agentId: string;
  cwd: string;
  sourceWorkspaceId: string;
  title: string | null;
  background: boolean;
  previousParentAgentId: string | null;
}

export interface MoveSubagentToWorkspaceAllocation {
  workspaceId: string;
  rollback?: () => Promise<void>;
}

export type MoveSubagentToWorkspaceOptions = {
  idempotencyKey?: string;
  expectedWorkspaceId?: string;
  serverId?: string;
  getWorktreeRoot?: (cwd: string) => Promise<string | null>;
} & (
  | {
      durable?: undefined;
      allocateWorkspace: (
        source: MoveSubagentToWorkspaceSource,
      ) => Promise<MoveSubagentToWorkspaceAllocation>;
    }
  | {
      durable: {
        workspaceId: string;
        journal: AgentWorkspaceMoveJournal;
        publishWorkspace: (
          source: MoveSubagentToWorkspaceSource,
          beforeSave: () => Promise<void>,
        ) => Promise<void>;
        retainWorkspaceProtection?: () => () => void;
      };
    }
);

interface CommittedWorkspaceMove {
  record: StoredAgentRecord;
  live: boolean;
  sourceWorkspaceId: string;
  workspaceId: string;
  previousParentAgentId: string | null;
  movedDescendantStoredRecords?: StoredAgentRecord[];
  replayed?: false;
}

export type MoveSubagentToWorkspaceResult =
  | CommittedWorkspaceMove
  | {
      workspaceId: string;
      replayed: true;
      record?: StoredAgentRecord;
      live?: boolean;
      sourceWorkspaceId?: string;
      previousParentAgentId?: string | null;
      movedDescendantStoredRecords?: StoredAgentRecord[];
    };

export interface AgentManagerOptions {
  pluginLifecycle?: PluginLifecycle;
  serverId?: string;
  /** An internal workspace makes every agent created inside it internal. */
  clients?: ProviderClientMap;
  providerDefinitions?: ProviderEnabledMap;
  idFactory?: () => string;
  registry?: AgentStorage;
  onAgentAttention?: AgentAttentionCallback;
  onWorkspaceStateMayHaveChanged?: (params: { cwd: string }) => void;
  onAgentRunAccepted?: AgentRunAcceptedCallback;
  timelineStore?: InMemoryAgentTimelineStore;
  durableTimelineStore?: AgentTimelineStore;
  terminalManager?: TerminalManager | null;
  mcpBaseUrl?: string;
  mcpAuthToken?: string;
  pluginAgentTools?: PluginAgentToolsRuntime;
  paseoToolsEnabled?: boolean;
  paseoToolCatalogFactory?: PaseoToolCatalogFactory;
  resolvePaseoToolPolicy?: (provider: AgentProvider) => ProviderPaseoToolsPolicy | undefined;
  appendSystemPrompt?: string;
  mainControlAppendSystemPrompt?: string;
  agentStreamCoalesceWindowMs?: number;
  rescueTimeouts?: AgentManagerRescueTimeouts;
  beforeSteerUnavailableFallback?: (input: {
    agentId: string;
    expectedTurnId: string;
  }) => Promise<void>;
  logger: Logger;
}

export type ActiveTurnSteerDispatchResult =
  | { status: "inactive" | "steered" }
  | { status: "replaced"; iterator: AsyncGenerator<AgentStreamEvent> };

function stripSteerOptions(options?: AgentSteerOptions): AgentRunOptions | undefined {
  if (!options) return undefined;
  const { clearPendingPermissions: _, ...runOptions } = options;
  return runOptions;
}

export interface WaitForAgentOptions {
  signal?: AbortSignal;
  waitForActive?: boolean;
  completionResponse?: boolean;
}

export interface WaitForAgentResult {
  status: AgentLifecycleStatus;
  permission: AgentPermissionRequest | null;
  lastMessage: string | null;
  completionSnapshot?: ManagedAgent;
}

export interface WaitForAgentStartOptions {
  signal?: AbortSignal;
}

export type AttentionState =
  | { requiresAttention: false }
  | {
      requiresAttention: true;
      attentionReason: "finished" | "error" | "permission";
      attentionTimestamp: Date;
    };

/** Private helpers and background agents report to their creator, never to the user. */
function raisesAttention(agent: Pick<ManagedAgent, "internal" | "background">): boolean {
  return !agent.internal && !agent.background;
}

/** The attention a read agent gets back when marked unread; null while it is still working. */
function unreadAttentionReason(status: AgentLifecycleStatus): "finished" | "error" | null {
  if (status === "idle" || status === "closed") return "finished";
  if (status === "error") return "error";
  return null;
}

function resolveInitialAttention(input: AttentionState | undefined): AttentionState {
  if (input == null || !input.requiresAttention) {
    return { requiresAttention: false };
  }
  return {
    requiresAttention: true,
    attentionReason: input.attentionReason,
    attentionTimestamp: new Date(input.attentionTimestamp),
  };
}

interface StreamEventFlags {
  shouldDispatchEvent: boolean;
  shouldNotifyWaiters: boolean;
}

type ActiveTurnTerminalDisposition = "closed_current" | "stale" | "untracked";

interface HandleStreamEventOptions {
  fromHistory?: boolean;
}

interface ManagedAgentBase {
  id: string;
  mainControlSystemPrompt?: string;
  provider: AgentProvider;
  providerAdapter?: AgentProvider;
  cwd: string;
  /**
   * Workspace this agent belongs to, stamped at creation. Independent of cwd:
   * cwd answers "where does it run", workspaceId answers "which workspace owns it".
   * Null/undefined for legacy agents created before ownership stamping.
   */
  workspaceId?: string;
  owner?: AgentOwner;
  capabilities: AgentCapabilityFlags;
  config: AgentSessionConfig;
  /** Explicit launch overrides, before per-opening hooks and daemon-owned variables. */
  launchEnv?: Record<string, string>;
  runtimeInfo?: AgentRuntimeInfo;
  createdAt: Date;
  updatedAt: Date;
  availableModes: AgentMode[];
  controls?: AgentOptionControl[];
  /** `config.json` defaults deep-merged with `config.providerOptions`; refreshed on every state emit. */
  effectiveOptions?: ProviderOptions;
  currentModeId: string | null;
  pendingPermissions: Map<string, AgentPermissionRequest>;
  bufferedPermissionResolutions: Map<
    string,
    Extract<AgentStreamEvent, { type: "permission_resolved" }>
  >;
  inFlightPermissionResponses: Set<string>;
  pendingReplacement: boolean;
  persistence: AgentPersistenceHandle | null;
  historyPrimed: boolean;
  lastUserMessageAt: Date | null;
  activeTurnId: string | null;
  activeTurnStartedAt: Date | null;
  lastTurnCompletion?: { event: TurnTerminalEvent; lastMessage: string | null };
  lastUsage?: AgentUsage;
  lastError?: string;
  attention: AttentionState;
  foregroundTurnWaiters: Set<ForegroundTurnWaiter>;
  finalizedForegroundTurnIds: Set<string>;
  unsubscribeSession: (() => void) | null;
  /**
   * Internal agents are hidden from listings and don't trigger notifications.
   */
  internal?: boolean;
  /**
   * Background agents are durable but hidden from default discovery and never raise attention.
   * Fixed at creation.
   */
  background?: boolean;
  /**
   * User-defined labels for categorizing agents (e.g., { surface: "workspace" }).
   */
  labels: Record<string, string>;
  /** Plugin-owned data. Paseo persists and forwards it and never reads a key. */
  metadata: AgentMetadata;
}

type ManagedAgentWithSession = ManagedAgentBase & {
  session: AgentSession;
};

type ManagedAgentInitializing = ManagedAgentWithSession & {
  lifecycle: "initializing";
  activeForegroundTurnId: null;
};

type ManagedAgentIdle = ManagedAgentWithSession & {
  lifecycle: "idle";
  activeForegroundTurnId: null;
};

type ManagedAgentRunning = ManagedAgentWithSession & {
  lifecycle: "running";
  activeForegroundTurnId: string | null;
};

type ManagedAgentError = ManagedAgentWithSession & {
  lifecycle: "error";
  activeForegroundTurnId: null;
  lastError: string;
};

type ManagedAgentClosed = ManagedAgentBase & {
  lifecycle: "closed";
  session: null;
  activeForegroundTurnId: null;
};

export type ManagedAgent =
  | ManagedAgentInitializing
  | ManagedAgentIdle
  | ManagedAgentRunning
  | ManagedAgentError
  | ManagedAgentClosed;

export interface AgentMetricsSnapshot {
  total: number;
  subscriptionCount: number;
  byLifecycle: Record<string, number>;
  withActiveForegroundTurn: number;
  timelineStats: {
    totalItems: number;
    maxItemsPerAgent: number;
  };
}

type ActiveManagedAgent =
  | ManagedAgentInitializing
  | ManagedAgentIdle
  | ManagedAgentRunning
  | ManagedAgentError;

type LiveManagedAgent = ActiveManagedAgent;
type AgentLabelPatch = Record<string, string | null>;
type AgentMetadata = Record<string, JsonValue>;

function attachManagedTurnIdentity(
  agent: ActiveManagedAgent,
  event: AgentStreamEvent,
  fromHistory: boolean,
): { event: AgentStreamEvent; turnId: string | undefined } {
  const existingTurnId = getAgentStreamEventTurnId(event);
  if (fromHistory || existingTurnId !== undefined) {
    return { event, turnId: existingTurnId };
  }
  switch (event.type) {
    case "turn_started": {
      const turnId =
        agent.activeForegroundTurnId ?? agent.activeTurnId ?? `autonomous-${randomUUID()}`;
      return { event: { ...event, turnId }, turnId };
    }
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled": {
      const turnId = agent.activeForegroundTurnId ?? agent.activeTurnId ?? undefined;
      return turnId ? { event: { ...event, turnId }, turnId } : { event, turnId };
    }
    case "assistant_messages_removed":
    case "timeline": {
      // A notice with no open run is a display turn of its own.
      const turnId =
        agent.activeForegroundTurnId ??
        agent.activeTurnId ??
        (event.type === "timeline" && event.item.type === "notification"
          ? randomUUID()
          : undefined);
      return turnId ? { event: { ...event, turnId }, turnId } : { event, turnId };
    }
    default:
      return { event, turnId: undefined };
  }
}

function limitAgentStreamEventContent(event: AgentStreamEvent, agentId: string): AgentStreamEvent {
  if (event.type !== "timeline") return event;
  const item = event.item;
  const rendered = item.type === "user_message" ? cleanProviderPromptItem(item, agentId) : item;
  return { ...event, item: limitAgentTimelineItemContent(rendered) };
}

function cleanProviderPromptItem(
  item: Extract<AgentTimelineItem, { type: "user_message" }>,
  agentId: string,
): typeof item {
  const text = stripMainControlPromptHeader(item.text, agentId);
  const clean = stripContextHandoffEnvelope(text);
  // Keep an envelope-only block recognizable so the projection can drop it.
  return { ...item, text: clean.trim() ? clean : text };
}

function replayIncludesContextHandoff(event: AgentStreamEvent, agentId: string): boolean {
  if (event.type !== "timeline" || event.item.type !== "user_message") return false;
  const text = stripMainControlPromptHeader(event.item.text, agentId);
  return stripContextHandoffEnvelope(text) !== text;
}

interface WriteLabelsResult {
  record: StoredAgentRecord | null;
  live: boolean;
}

interface AgentMetadataPatch {
  title?: string;
  labels?: AgentLabelPatch;
  metadata?: Record<string, JsonValue | null>;
}

const SYSTEM_ERROR_PREFIX = "[System Error]";

function normalizePersistenceForConfig(
  handle: AgentPersistenceHandle | null,
  config: AgentSessionConfig,
): AgentPersistenceHandle | null {
  if (!handle) {
    return null;
  }
  const {
    mcpServers: _launchMcpServers,
    pluginAppendSystemPrompt: _pluginAppendSystemPrompt,
    daemonAppendSystemPrompt: _daemonAppendSystemPrompt,
    ...metadata
  } = handle.metadata ?? {};
  return {
    ...handle,
    metadata: {
      ...metadata,
      cwd: config.cwd,
      ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),
    },
  };
}

interface SubscriptionRecord {
  callback: AgentSubscriber;
  agentId: string | null;
  includeInternal: boolean;
}

interface SteerEventBarrier {
  events: AgentStreamEvent[];
}

const BUSY_STATUSES: Set<AgentLifecycleStatus> = new Set(["initializing", "running"]);
const AgentIdSchema = z.guid();

function isAgentBusy(status: AgentLifecycleStatus): boolean {
  return BUSY_STATUSES.has(status);
}

type TurnTerminalEvent = Extract<
  AgentStreamEvent,
  { type: "turn_completed" | "turn_failed" | "turn_canceled" }
>;

function isTurnTerminalEvent(event: AgentStreamEvent): event is TurnTerminalEvent {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

function abortMessage(reason: unknown, fallbackMessage: string): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return fallbackMessage;
}

function createAbortError(signal: AbortSignal | undefined, fallbackMessage: string): Error {
  const message = abortMessage(signal?.reason, fallbackMessage);
  return Object.assign(new Error(message), { name: "AbortError" });
}

/** The user labels and plugin metadata an agent carries; both default to empty. */
function agentEntityData(source?: { labels?: Record<string, string>; metadata?: AgentMetadata }) {
  return { labels: source?.labels ?? {}, metadata: source?.metadata ?? {} };
}

// PASEO_WORKSPACE_ID lets an agent rename or archive its own workspace; several workspaces can
// share one cwd, so the agent can't work it out from PASEO_AGENT_CWD.
function agentIdentityEnv({
  agentId,
  cwd,
  opening,
}: {
  agentId: string;
  cwd: string;
  opening: { workspaceId?: string | null } | undefined;
}): Record<string, string> {
  const workspaceId = opening?.workspaceId;
  return {
    PASEO_AGENT_ID: agentId,
    PASEO_AGENT_CWD: cwd,
    ...(workspaceId ? { PASEO_WORKSPACE_ID: workspaceId } : {}),
  };
}

// Launch env and the registered agent must agree, or the next snapshot erases the stored workspace.
function resolveResumeWorkspaceId({
  options,
  record,
}: {
  options: { workspaceId?: string } | undefined;
  record: Pick<StoredAgentRecord, "workspaceId"> | null;
}): string | undefined {
  return options?.workspaceId ?? record?.workspaceId;
}

function validateAgentId(agentId: string, source: string): string {
  const result = AgentIdSchema.safeParse(agentId);
  if (!result.success) {
    throw new Error(`${source}: agentId must be a UUID`);
  }
  return result.data;
}

function buildExplicitTimelineSeedForRegister(
  now: Date,
  options:
    | {
        timeline?: AgentTimelineItem[];
        timelineRows?: AgentTimelineRow[];
        timelineNextSeq?: number;
        createdAt?: Date;
        updatedAt?: Date;
      }
    | undefined,
): SeedAgentTimelineOptions | null {
  const hasTimeline = Boolean(options?.timeline?.length);
  const hasTimelineRows = Boolean(options?.timelineRows?.length);
  const hasTimelineNextSeq = options?.timelineNextSeq !== undefined;
  if (!hasTimeline && !hasTimelineRows && !hasTimelineNextSeq) {
    return null;
  }
  return {
    items: options?.timeline,
    rows: options?.timelineRows,
    nextSeq: options?.timelineNextSeq,
    timestamp: (options?.updatedAt ?? options?.createdAt ?? now).toISOString(),
  };
}

function buildImportedTimelineRows(entries: readonly ImportedTimelineEntry[]): AgentTimelineRow[] {
  const rows: AgentTimelineRow[] = [];
  for (const entry of entries) {
    for (const item of projectAgentMessages(entry.item)) {
      rows.push({
        seq: rows.length + 1,
        timestamp: entry.timestamp ?? new Date().toISOString(),
        item: limitAgentTimelineItemContent(item),
      });
    }
  }
  return rows;
}

function resolveImportedAgentTitle(
  config: AgentSessionConfig,
  timelineRows: readonly AgentTimelineRow[],
): string | null {
  const initialPrompt = getFirstUserMessageTextFromRows(timelineRows);
  if (!initialPrompt) {
    return null;
  }
  const { explicitTitle, provisionalTitle } = resolveCreateAgentTitles({
    configTitle: config.title,
    initialPrompt,
  });
  return explicitTitle ?? provisionalTitle ?? null;
}

function getFirstUserMessageTextFromRows(rows: readonly AgentTimelineRow[]): string | null {
  for (const row of rows) {
    const item = row.item;
    if (item.type !== "user_message") {
      continue;
    }
    const text = item.text.trim();
    if (text) {
      return text;
    }
  }
  return null;
}

function shouldDetachFromArchivedParent(
  parent: Pick<StoredAgentRecord, "workspaceId">,
  child: StoredAgentRecord,
): boolean {
  const isCrossWorkspace =
    parent.workspaceId !== undefined &&
    child.workspaceId !== undefined &&
    parent.workspaceId !== child.workspaceId;
  return isCrossWorkspace || hasOpenAgentTab(child.labels);
}

function clearOpenAgentTabLabelPatch(labels: Record<string, string>): AgentLabelPatch {
  const patch: AgentLabelPatch = {};
  for (const label of Object.keys(labels)) {
    if (isOpenAgentTabLabel(label)) {
      patch[label] = null;
    }
  }
  return patch;
}

function detachedAgentLabelPatch(labels: Record<string, string>): AgentLabelPatch {
  return {
    ...clearOpenAgentTabLabelPatch(labels),
    [PARENT_AGENT_ID_LABEL]: null,
    [PARENT_SERVER_ID_LABEL]: null,
    [REMOTE_HIERARCHY_DEPTH_LABEL]: null,
  };
}

function normalizeSubagentMoveTitle(title: string | null | undefined): string | null {
  const trimmed = title?.trim();
  return trimmed && trimmed.toLowerCase() !== "new agent" ? trimmed : null;
}

function describeSubagentMoveSource(
  agentId: string,
  liveAgent: LiveManagedAgent | undefined,
  storedRecord: StoredAgentRecord | null,
  serverId: string,
): MoveSubagentToWorkspaceSource {
  const current = liveAgent ?? storedRecord;
  if (!current || current.internal || storedRecord?.internal) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  if (storedRecord?.archivedAt) {
    throw new Error(`Agent is archived: ${agentId}`);
  }
  const parent = getParentAddressFromLabels(current.labels, serverId);
  const previousParentAgentId = parent?.serverId === serverId ? parent.agentId : null;
  const sourceWorkspaceId = (current.workspaceId ?? storedRecord?.workspaceId)?.trim();
  if (!sourceWorkspaceId) {
    throw new Error(`Agent has no workspace: ${agentId}`);
  }

  return {
    agentId,
    cwd: current.cwd,
    sourceWorkspaceId,
    title: normalizeSubagentMoveTitle(storedRecord?.title ?? liveAgent?.config.title),
    background: Boolean(current.background || storedRecord?.background),
    previousParentAgentId,
  };
}

async function assertMoveSharesWorktree(
  rootCwd: string,
  memberDirectories: Iterable<string | undefined>,
  getWorktreeRoot: MoveSubagentToWorkspaceOptions["getWorktreeRoot"],
): Promise<void> {
  if (!getWorktreeRoot) return;
  const directories = new Set(memberDirectories);
  directories.delete(undefined);
  directories.delete(rootCwd);
  if (directories.size === 0) return;
  const root = await getWorktreeRoot(rootCwd);
  const matchesRoot = root ? createRealpathAwarePathMatcher(root) : null;
  for (const cwd of directories) {
    if (!cwd) continue;
    const otherRoot = await getWorktreeRoot(cwd);
    if (otherRoot ? !matchesRoot?.(otherRoot) : matchesRoot) {
      throw new Error("Cannot move agents that use different Git worktrees together.");
    }
  }
}

/**
 * How long an archived internal agent stays readable by id. Storage plays this
 * role for public agents; internal agents never reach it, and a one-shot helper
 * can finish and auto-archive before its creator's `waitForFinish` arrives.
 */
const RETIRED_INTERNAL_AGENT_TTL_MS = 10 * 60 * 1000;
const RETIRED_INTERNAL_AGENT_LIMIT = 500;
const ARCHIVED_FORK_CONTEXT_TTL_MS = 5 * 60 * 1000;
const ARCHIVED_FORK_CONTEXT_LIMIT = 16;

export interface RetiredInternalAgent {
  record: ArchivedStoredAgentRecord;
  lastMessage: string | null;
}

interface PendingContextHandoff {
  prefix: PersistedTimelinePrefix;
  context: ContextHandoff;
  controller?: AbortController;
  summary?: Promise<string>;
  compactionRow?: AgentTimelineRow;
}

function timelineMessageId(item: AgentTimelineItem): string | undefined {
  if (item.type === "user_message") {
    const id = item.clientMessageId ?? item.messageId;
    return id ? `user:${id}` : undefined;
  }
  if (item.type === "assistant_message" && item.messageId) return `assistant:${item.messageId}`;
  return undefined;
}

function timelineMessageText(item: AgentTimelineItem): string | undefined {
  if (item.type === "user_message" || item.type === "assistant_message") return item.text;
}

function maxTimelineSeq(rows: readonly AgentTimelineRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.seq), 0);
}

function projectSummaryTimelineItems(rows: AgentTimelineRow[]): AgentTimelineItem[] {
  return projectTimelineRows({ rows, mode: "projected" }).map(({ item }) => item);
}

export const SUMMARY_TIMELINE_READ_CONCURRENCY = 4;
const SUMMARY_TIMELINE_READ_TIMEOUT_MS = 5_000;

interface SummaryTimelineReadOptions {
  includeArchived?: boolean;
  retainedOnly?: boolean;
}

interface SummaryTimelineRead extends Required<SummaryTimelineReadOptions> {
  agentId: string;
  workspaceId: string;
  signal: AbortSignal;
}

class SummaryTimelineReadPool {
  private readonly active = new Map<string, AbortSignal>();
  private readonly waiters = new Set<() => void>();

  async run<T>(agentId: string, signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    while (this.active.size >= SUMMARY_TIMELINE_READ_CONCURRENCY || this.active.has(agentId)) {
      signal.throwIfAborted();
      const sameAgent = this.active.get(agentId);
      const blocked = sameAgent
        ? sameAgent.aborted
        : Array.from(this.active.values()).every((activeSignal) => activeSignal.aborted);
      if (blocked) {
        throw new Error("Timed-out workspace summary timeline readers have not finished");
      }
      await new Promise<void>((resume) => {
        const wake = () => {
          this.waiters.delete(wake);
          signal.removeEventListener("abort", wake);
          resume();
        };
        this.waiters.add(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    }

    signal.throwIfAborted();
    this.active.set(agentId, signal);
    const wakeWaiters = () => {
      for (const wake of this.waiters) wake();
    };
    signal.addEventListener("abort", wakeWaiters, { once: true });
    try {
      return await read();
    } finally {
      // Keep the slot until the read settles, even after its caller timed out.
      this.active.delete(agentId);
      signal.removeEventListener("abort", wakeWaiters);
      wakeWaiters();
    }
  }
}

export class AgentManager {
  private readonly timelinePrefixes: TimelinePrefixStore;
  private readonly contextHandoffs = new Map<string, PendingContextHandoff>();
  private readonly providerSwitches = new Set<string>();
  private readonly pluginLifecycle: PluginLifecycle | undefined;
  private readonly archivedForkContexts = new Map<
    string,
    {
      archivedAt: string;
      expiresAt: number;
      context: ReturnType<typeof buildAgentForkContextAttachment>;
    }
  >();
  private readonly retiredInternalAgents = new Map<
    string,
    RetiredInternalAgent & { expiresAt: number }
  >();
  private readonly clients = new Map<AgentProvider, AgentClient>();
  private readonly providerEnabled = new Map<AgentProvider, boolean>();
  private readonly providerDefinitions = new Map<AgentProvider, ProviderEnabledFlag>();
  private readonly agents = new Map<string, LiveManagedAgent>();
  private readonly timelineStore: InMemoryAgentTimelineStore;
  private readonly summaryLocalReads = new SummaryTimelineReadPool();
  private readonly summaryProviderReads = new SummaryTimelineReadPool();
  private readonly summaryProviderLifecycle = new Set<string>();
  private readonly summaryLifecycleWaits = new WeakMap<Promise<void>, Set<() => void>>();
  private readonly unprimedRetainedTimelines = new Set<string>();
  private readonly providerSubagents = new ProviderSubagentStore();
  private readonly backgroundWork = new AgentBackgroundWorkStore();
  private readonly agentsAwaitingInitialSnapshotPersist = new Set<string>();
  private readonly sessionEventTails = new Map<string, Promise<void>>();
  private readonly steerEventBarriers = new Map<string, SteerEventBarrier>();
  private readonly foregroundMutationTails = new Map<string, Promise<void>>();
  private readonly replacementMutationTails = new Map<string, Promise<void>>();
  private readonly runs = new AgentRunState();
  private readonly subscribers = new Set<SubscriptionRecord>();
  private readonly idFactory: () => string;
  private readonly registry?: AgentStorage;
  private readonly durableTimelineStore?: AgentTimelineStore;
  private readonly durableTimelineWriteTails = new Map<string, Promise<void>>();
  private readonly previousStatuses = new Map<string, AgentLifecycleStatus>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly agentRegistrationTasks = new Set<Promise<void>>();
  private readonly inFlightAgentCloses = new Map<string, Promise<void>>();
  private readonly historySessions = new WeakSet<AgentSession>();
  private readonly reloadedSessionCloses = new WeakMap<AgentSession, Promise<void>>();
  private readonly runtimeCleanupIdentities = new WeakMap<
    AgentSession,
    { readonly openedAt: number }
  >();
  private readonly collectingRuntimes = new Set<string>();
  private readonly lifecycleMutationTails = new Map<string, Promise<void>>();
  private readonly moveToWorkspaceReceipts = new Map<string, CommittedWorkspaceMove>();
  private readonly pendingSubagentMoveSnapshots = new Map<string, Promise<void>>();
  private readonly pendingStoredMoveSnapshots = new Map<string, StoredAgentRecord>();
  private pendingWorkspaceMoveRecovery?: { retry: () => Promise<void>; release: () => void };
  private readonly remoteChildReservations = new Map<
    string,
    { parentId: string; destination: string; uncertain: boolean }
  >();
  private readonly pendingHierarchyArchives = new Map<string, number>();
  private readonly pendingHierarchySessionReloads = new Set<string>();
  private readonly hierarchySessionUpdates = new Set<string>();
  private readonly mainControlRoleUpdates = new Set<string>();
  private readonly mainControlRoleVersions = new Map<string, number>();
  private readonly promptedMainControlRoleVersions = new Map<string, number>();
  private readonly inPlaceMainControlSessions = new WeakSet<AgentSession>();
  private readonly launchMainControlRoleVersions = new WeakMap<AgentSessionConfig, number>();
  private readonly pendingCancellations = new Map<string, Promise<unknown>>();
  private readonly agentStreamCoalescer: AgentStreamCoalescer;
  private mcpBaseUrl: string | null;
  private readonly mcpAuthToken: string | null;
  private sessionOpenGeneration = 0;
  private readonly sessionOpenGenerations = new Map<string, number>();
  private readonly attachedPluginTools = new Map<string, AttachedAgentTool[]>();
  private readonly pluginAgentTools: PluginAgentToolsRuntime | undefined;
  private readonly serverId?: string;
  private paseoToolsEnabled = true;
  private paseoToolCatalogFactory: PaseoToolCatalogFactory | null = null;
  private readonly paseoToolPolicies = new Map<string, ProviderPaseoToolsPolicy | undefined>();
  private hierarchyMutationTail = Promise.resolve();
  private readonly resolvePaseoToolPolicy: (
    provider: AgentProvider,
  ) => ProviderPaseoToolsPolicy | undefined;
  private appendSystemPrompt: string;
  private mainControlAppendSystemPrompt: string;
  private onAgentAttention?: AgentAttentionCallback;
  private onAgentArchived?: AgentArchivedCallback;
  private onAgentRunAccepted?: AgentRunAcceptedCallback;
  private onWorkspaceStateMayHaveChanged?: (params: { cwd: string }) => void;
  private logger: Logger;
  private readonly rescueTimeouts: Required<AgentManagerRescueTimeouts>;
  private readonly beforeSteerUnavailableFallback?: AgentManagerOptions["beforeSteerUnavailableFallback"];
  private acceptingAgentRegistrations = true;
  private runAdmissionPaused = false;

  constructor(options: AgentManagerOptions) {
    this.pluginLifecycle = options.pluginLifecycle;
    this.serverId = options.serverId;
    this.pluginAgentTools = options.pluginAgentTools;
    this.timelineStore = options.timelineStore ?? new InMemoryAgentTimelineStore();
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.registry = options.registry;
    this.timelinePrefixes = this.registry?.timelinePrefixes ?? new TimelinePrefixStore();
    this.durableTimelineStore = options.durableTimelineStore;
    this.onAgentAttention = options.onAgentAttention;
    this.onAgentRunAccepted = options.onAgentRunAccepted;
    this.onWorkspaceStateMayHaveChanged = options.onWorkspaceStateMayHaveChanged;
    this.mcpBaseUrl = options.mcpBaseUrl ?? null;
    this.mcpAuthToken = options.mcpAuthToken ?? null;
    this.configurePaseoTools(options);
    this.resolvePaseoToolPolicy = options.resolvePaseoToolPolicy ?? (() => undefined);
    this.appendSystemPrompt = options.appendSystemPrompt ?? "";
    this.mainControlAppendSystemPrompt = options.mainControlAppendSystemPrompt ?? "";
    this.logger = options.logger.child({ module: "agent", component: "agent-manager" });
    this.rescueTimeouts = {
      reloadSessionCloseMs:
        options.rescueTimeouts?.reloadSessionCloseMs ?? RELOAD_SESSION_CLOSE_TIMEOUT_MS,
      interruptSessionMs:
        options.rescueTimeouts?.interruptSessionMs ?? INTERRUPT_SESSION_TIMEOUT_MS,
    };
    this.beforeSteerUnavailableFallback = options.beforeSteerUnavailableFallback;
    this.agentStreamCoalescer = new AgentStreamCoalescer({
      windowMs: options.agentStreamCoalesceWindowMs ?? AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS,
      timers: { setTimeout, clearTimeout },
      onFlush: ({ agentId, item, provider, turnId }) => {
        const event = this.recordAndDispatchTimelineItem(agentId, item, provider, turnId);
        this.notifyForegroundTurnWaiters(agentId, event);
      },
    });
    this.updateProviderRegistry({
      providerDefinitions: options.providerDefinitions ?? {},
      clients: options.clients ?? {},
    });
  }

  private configurePaseoTools(options: AgentManagerOptions): void {
    this.paseoToolsEnabled = options.paseoToolsEnabled ?? true;
    this.paseoToolCatalogFactory = options.paseoToolCatalogFactory ?? null;
  }

  registerClient(provider: AgentProvider, client: AgentClient): void {
    this.clients.set(provider, client);
  }

  updateProviderRegistry(input: {
    providerDefinitions: ProviderEnabledMap;
    clients: ProviderClientMap;
    retiredProviders?: readonly AgentProvider[];
  }): void {
    this.providerEnabled.clear();
    this.providerDefinitions.clear();
    for (const [provider, definition] of Object.entries(input.providerDefinitions)) {
      if (definition) {
        this.providerEnabled.set(provider, definition.enabled);
        this.providerDefinitions.set(provider, definition);
      }
    }

    this.clients.clear();
    for (const [provider, client] of Object.entries(input.clients)) {
      if (client) {
        this.clients.set(provider, client);
      }
    }

    for (const provider of input.retiredProviders ?? []) {
      for (const agent of this.agents.values()) {
        if (agent.provider !== provider) continue;
        void this.closeAgent(agent.id).catch((error) => {
          this.logger.warn(
            { err: error, agentId: agent.id, provider },
            "Failed to close agent after provider retirement",
          );
        });
      }
    }
  }

  getRegisteredProviderIds(): AgentProvider[] {
    return Array.from(this.clients.keys());
  }

  setAgentAttentionCallback(callback: AgentAttentionCallback): void {
    this.onAgentAttention = callback;
  }

  setAgentArchivedCallback(callback: AgentArchivedCallback): void {
    this.onAgentArchived = callback;
  }

  setAgentRunAcceptedCallback(callback: AgentRunAcceptedCallback): void {
    this.onAgentRunAccepted = callback;
  }

  setMcpBaseUrl(url: string | null): void {
    this.mcpBaseUrl = url;
  }

  prepareForShutdown(): void {
    this.acceptingAgentRegistrations = false;
    for (const handoff of this.contextHandoffs.values()) handoff.controller?.abort();
  }

  pauseRunAdmission(): () => void {
    this.runAdmissionPaused = true;
    return () => {
      this.runAdmissionPaused = false;
    };
  }

  async waitForAdmittedRunsToStart(): Promise<void> {
    // The foreground lane includes steers, commands and replacements already past
    // their admission check. A replacement can reserve its new turn as it leaves the lane.
    await Promise.all(this.foregroundMutationTails.values());
    await Promise.all(Array.from(this.agents.keys(), (id) => this.runs.waitForForegroundStart(id)));
  }

  private assertAcceptingAgentRuns(): void {
    if (this.runAdmissionPaused || !this.acceptingAgentRegistrations) {
      throw new AgentManagerShuttingDownError();
    }
  }

  setPaseoToolsEnabled(enabled: boolean): void {
    this.paseoToolsEnabled = enabled;
  }

  setPaseoToolCatalogFactory(factory: PaseoToolCatalogFactory | null): void {
    this.paseoToolCatalogFactory = factory;
  }

  invalidatePluginSessions(): void {
    this.sessionOpenGeneration++;
  }

  async reloadStalePluginSession(agentId: string): Promise<void> {
    if (!this.needsPluginSessionReload(agentId)) return;
    await this.trackAgentRegistrationOperation(
      this.runLifecycleMutation(agentId, async () => {
        if (!this.needsPluginSessionReload(agentId)) return;
        await this.reloadAgentSessionInternal(agentId);
      }),
    );
  }

  private needsPluginSessionReload(agentId: string): boolean {
    const agent = this.getAgent(agentId);
    return (
      agent !== null &&
      agent.lifecycle !== "closed" &&
      this.sessionOpenGenerations.get(agentId) !== this.sessionOpenGeneration &&
      !this.hasInFlightRun(agentId)
    );
  }

  getPluginTools(agentId: string): readonly AttachedAgentTool[] {
    return (this.attachedPluginTools.get(agentId) ?? []).filter((tool) =>
      this.pluginAgentTools?.isToolPluginAvailable(tool.pluginId, tool.pluginInstanceId),
    );
  }

  async executePluginTool(
    tool: AttachedAgentTool,
    agentId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<AgentToolResult> {
    const agent = this.getAgent(agentId);
    if (!agent || agent.lifecycle === "closed") throw new Error(`Agent is not live: ${agentId}`);
    if (!this.pluginAgentTools) throw new Error("Plugin tools are unavailable");
    const record = await this.registry?.get(agentId);
    return this.pluginAgentTools.callTool(
      tool.pluginId,
      tool.pluginInstanceId,
      describeHookAgent({ ...agent, title: record?.title ?? agent.config.title }),
      tool.name,
      input,
      signal,
    );
  }

  private detachPluginTools(agentId: string): void {
    this.attachedPluginTools.delete(agentId);
    this.sessionOpenGenerations.delete(agentId);
    this.pluginAgentTools?.detachTools(agentId);
  }

  getPaseoToolPolicy(agentId: string): ProviderPaseoToolsPolicy | undefined {
    return this.paseoToolPolicies.get(agentId);
  }

  private async readHierarchyAgents() {
    const records = ((await this.registry?.listActive()) ?? []).map(
      (record) => this.pendingStoredMoveSnapshots.get(record.id) ?? record,
    );
    const agents = new Map<string, WorkspaceHierarchyAgent>(
      records.map((record) => [record.id, { ...record, lifecycle: record.lastStatus }]),
    );
    for (const agent of this.agents.values()) {
      if (agent.internal) continue;
      const record = agents.get(agent.id);
      if (!record && agent.session && this.historySessions.has(agent.session)) continue;
      agents.set(agent.id, {
        id: agent.id,
        workspaceId: agent.workspaceId,
        labels: agent.labels,
        title: record?.title ?? agent.config.title,
        lifecycle: agent.lifecycle,
      });
    }
    return agents;
  }

  private basePaseoToolPolicy(provider: AgentProvider): ProviderPaseoToolsPolicy | undefined {
    return this.paseoToolsEnabled ? this.resolvePaseoToolPolicy(provider) : { enabled: false };
  }

  private refreshHierarchyToolPolicies(
    hierarchy: Awaited<ReturnType<AgentManager["readHierarchyAgents"]>>,
  ): void {
    for (const agent of this.agents.values()) {
      this.paseoToolPolicies.set(
        agent.id,
        resolveAgentPaseoToolPolicy(
          this.basePaseoToolPolicy(agent.provider),
          agent,
          computeAgentDepth(agent.id, (id) => hierarchy.get(id)),
        ),
      );
    }
  }

  /**
   * Capability token the daemon's own MCP clients must present to the Agent MCP
   * endpoint when a daemon password is configured. Read by the per-client
   * session to authenticate its own MCP connection. Stays in the daemon — never
   * sent to remote clients.
   */
  getMcpAuthToken(): string | null {
    return this.mcpAuthToken;
  }

  setAppendSystemPrompt(prompt: string | null | undefined): void {
    this.appendSystemPrompt = prompt ?? "";
  }

  setMainControlAppendSystemPrompt(prompt: string): void {
    this.mainControlAppendSystemPrompt = prompt;
  }

  private snapshotMainControlPrompt(
    labels: Record<string, string> | undefined,
  ): string | undefined {
    return isMainControlAgentLabels(labels) && !getParentAgentIdFromLabels(labels)
      ? this.mainControlAppendSystemPrompt
      : undefined;
  }

  public getMetricsSnapshot(): AgentMetricsSnapshot {
    const byLifecycle: Record<string, number> = {};
    let withActiveForegroundTurn = 0;
    let totalItems = 0;
    let maxItemsPerAgent = 0;

    for (const agent of this.agents.values()) {
      byLifecycle[agent.lifecycle] = (byLifecycle[agent.lifecycle] ?? 0) + 1;

      if (agent.activeForegroundTurnId !== null) {
        withActiveForegroundTurn++;
      }

      if (!this.timelineStore.has(agent.id)) {
        continue;
      }

      const len = this.timelineStore.getItems(agent.id).length;
      totalItems += len;
      if (len > maxItemsPerAgent) {
        maxItemsPerAgent = len;
      }
    }

    return {
      total: this.agents.size,
      subscriptionCount: this.subscribers.size,
      byLifecycle,
      withActiveForegroundTurn,
      timelineStats: {
        totalItems,
        maxItemsPerAgent,
      },
    };
  }

  private touchUpdatedAt(agent: ManagedAgent): Date {
    const nowMs = Date.now();
    const previousMs = agent.updatedAt.getTime();
    const nextMs = nowMs > previousMs ? nowMs : previousMs + 1;
    const next = new Date(nextMs);
    agent.updatedAt = next;
    return next;
  }

  private nextStoredUpdatedAt(record: StoredAgentRecord): string {
    const previousMs = Date.parse(record.updatedAt);
    const nowMs = Date.now();
    const nextMs = nowMs > previousMs ? nowMs : previousMs + 1;
    return new Date(nextMs).toISOString();
  }

  hasPendingPermissions(agentId: string): boolean {
    return (this.agents.get(agentId)?.pendingPermissions.size ?? 0) > 0;
  }

  hasInFlightRun(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }

    return (
      agent.lifecycle === "running" ||
      Boolean(agent.activeForegroundTurnId) ||
      this.runs.hasRun(agentId)
    );
  }

  subscribe(callback: AgentSubscriber, options?: SubscribeOptions): () => void {
    const targetAgentId =
      options?.agentId == null ? null : validateAgentId(options.agentId, "subscribe");
    const record: SubscriptionRecord = {
      callback,
      agentId: targetAgentId,
      includeInternal: options?.includeInternal === true,
    };
    this.subscribers.add(record);

    if (options?.replayState !== false) {
      if (record.agentId) {
        const agent = this.agents.get(record.agentId);
        if (agent) {
          callback({
            type: "agent_state",
            agent: { ...agent },
          });
        }
      } else {
        // Global subscribers skip internal agents unless they opted in.
        for (const agent of this.agents.values()) {
          if (agent.internal && !record.includeInternal) {
            continue;
          }
          callback({
            type: "agent_state",
            agent: { ...agent },
          });
        }
      }
    }

    return () => {
      this.subscribers.delete(record);
    };
  }

  subscriptionCount(): number {
    return this.subscribers.size;
  }

  listAgents(options?: { includeInternal?: boolean }): ManagedAgent[] {
    return Array.from(this.agents.values())
      .filter((agent) => options?.includeInternal === true || !agent.internal)
      .map((agent) => Object.assign({}, agent));
  }

  /** Archived internal agents still readable by id; see getRetiredInternalAgent. */
  listRetiredInternalAgents(): RetiredInternalAgent[] {
    const now = Date.now();
    const retired: RetiredInternalAgent[] = [];
    for (const [agentId, entry] of this.retiredInternalAgents) {
      if (entry.expiresAt <= now) {
        this.retiredInternalAgents.delete(agentId);
        continue;
      }
      retired.push({ record: entry.record, lastMessage: entry.lastMessage });
    }
    return retired;
  }

  async listImportableSessions(
    options?: ImportablePersistedAgentQueryOptions,
  ): Promise<ManagedImportableSessionsResult> {
    const providerEntries = Array.from(this.clients.entries()).filter(
      ([provider, client]) =>
        client.capabilities.supportsSessionListing &&
        !!client.listImportableSessions &&
        this.isProviderImportable(provider, options?.providerFilter),
    );
    const providerResults = await Promise.all(
      providerEntries.map(async ([provider, client]) => {
        try {
          const sessions = await withTimeout(
            client.listImportableSessions!({
              limit: options?.limit,
              query: options?.query,
              scanLimit: options?.scanLimit,
              cwd: options?.cwd,
            }),
            IMPORTABLE_SESSION_LIST_TIMEOUT_MS,
            `Timed out listing importable sessions for provider '${provider}' after ${IMPORTABLE_SESSION_LIST_TIMEOUT_MS}ms`,
          );
          return {
            sessions: sessions
              .filter((session) => matchesImportableSessionQuery(session, options?.query))
              .map((session) => Object.assign(session, { provider })),
            error: null,
          };
        } catch (error) {
          this.logger.warn(
            { err: error, provider },
            "Failed to list importable sessions for provider",
          );
          return {
            sessions: [],
            error: {
              provider,
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }),
    );
    const sessions = providerResults.flatMap((result) => result.sessions);

    const limit = options?.limit ?? 20;
    return {
      sessions: sessions
        .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
        .slice(0, limit),
      providerErrors: providerResults.flatMap((result) => (result.error ? [result.error] : [])),
    };
  }

  private isProviderImportable(
    provider: AgentProvider,
    providerFilter: Set<string> | undefined,
  ): boolean {
    if (this.providerEnabled.get(provider) === false) {
      return false;
    }
    if (providerFilter && !providerFilter.has(provider)) {
      return false;
    }
    return true;
  }

  async listProviderAvailability(): Promise<ProviderAvailability[]> {
    return Promise.all(
      Array.from(this.clients.keys()).map((provider) => this.getProviderAvailability(provider)),
    );
  }

  async getProviderAvailability(provider: AgentProvider): Promise<ProviderAvailability> {
    const client = this.clients.get(provider);
    if (!client) {
      return {
        provider,
        available: false,
        error: `No client registered for provider '${provider}'`,
      };
    }

    try {
      const available = await client.isAvailable();
      return {
        provider,
        available,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, provider }, "Failed to check provider availability");
      return {
        provider,
        available: false,
        error: message,
      };
    }
  }

  async listDraftCommands(config: AgentSessionConfig): Promise<AgentSlashCommand[]> {
    const normalizedConfig = await this.normalizeConfig(config, { resolveDefaultModel: false });
    const client = this.requireClient(normalizedConfig.provider);
    if (!normalizedConfig.model) {
      return [];
    }
    const available = await client.isAvailable();
    if (!available) {
      throw new Error(
        `Provider '${normalizedConfig.provider}' is not available. Please ensure the CLI is installed.`,
      );
    }

    if (client.listCommands) {
      return await client.listCommands(normalizedConfig);
    }

    const session = await client.createSession(normalizedConfig);
    try {
      if (!session.listCommands) {
        throw new Error(
          `Provider '${normalizedConfig.provider}' does not support listing commands`,
        );
      }
      return await session.listCommands();
    } finally {
      try {
        await session.close();
      } catch (error) {
        this.logger.warn(
          { err: error, provider: normalizedConfig.provider },
          "Failed to close draft command listing session",
        );
      }
    }
  }

  async listDraftControls(config: AgentSessionConfig): Promise<AgentDraftControls> {
    const normalizedConfig = await this.normalizeConfig(config, { resolveDefaultModel: false });
    const client = this.requireClient(normalizedConfig.provider);
    const options = this.effectiveOptionsFor(
      normalizedConfig.provider,
      normalizedConfig.providerOptions,
    );
    if (!normalizedConfig.model && !client.listControls) {
      return { controls: [], options };
    }
    const available = await client.isAvailable();
    if (!available) {
      throw new Error(
        `Provider '${normalizedConfig.provider}' is not available. Please ensure the CLI is installed.`,
      );
    }

    if (client.listControls) {
      return await client.listControls(normalizedConfig);
    }

    const session = await client.createSession(normalizedConfig);
    try {
      // The options a session opens with, as create would report them, so the controls'
      // selection matches what the first turn runs with.
      return {
        controls: session.controls ?? [],
        options: this.openedEffectiveOptions({ session, launchedOptions: options }),
      };
    } finally {
      try {
        await session.close();
      } catch (error) {
        this.logger.warn(
          { err: error, provider: normalizedConfig.provider },
          "Failed to close draft feature listing session",
        );
      }
    }
  }

  usageSession(id: string) {
    const agent = this.agents.get(id);
    return agent?.session?.usageSession?.() ?? null;
  }

  getAgent(id: string): ManagedAgent | null {
    const agent = this.agents.get(id);
    return agent ? { ...agent } : null;
  }

  async waitForAgentClose(agentId: string): Promise<void> {
    // Loading during reload must wait for the replacement, not resume another writer.
    await this.lifecycleMutationTails.get(agentId);
    await this.inFlightAgentCloses?.get(agentId)?.catch(() => undefined);
  }

  getTimeline(id: string): AgentTimelineItem[] {
    this.requireAgent(id);
    return this.timelineStore.getItems(id);
  }

  /** Read the best available timeline without registering a provider runtime or changing agent state. */
  async readTimelineForSummary(
    agentId: string,
    workspaceId: string,
    { includeArchived = false, retainedOnly = false }: SummaryTimelineReadOptions = {},
  ): Promise<AgentTimelineItem[] | null> {
    const controller = new AbortController();
    const { signal } = controller;
    const request = { agentId, workspaceId, includeArchived, retainedOnly, signal };
    let checkedVisibility = false;
    const read = async () => {
      const visible = await this.getSummaryTimelineRecord(request);
      checkedVisibility = true;
      signal.throwIfAborted();
      return visible ? this.readSummaryTimeline(request) : null;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("Workspace summary timeline read timed out");
        reject(error);
        controller.abort(error);
      }, SUMMARY_TIMELINE_READ_TIMEOUT_MS);
    });
    try {
      const items = await Promise.race([read(), deadline]);
      return items !== null && (await this.getSummaryTimelineRecord(request)) ? items : null;
    } catch (error) {
      // The registry is already initialized after the initial check, so this
      // recheck can read visibility without waiting for the lifecycle lane.
      if (checkedVisibility && (await this.getSummaryTimelineRecord(request))) throw error;
      this.logger.warn(
        { err: error, agentId, workspaceId },
        "Workspace summary visibility unavailable",
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async getSummaryTimelineRecord({
    agentId,
    workspaceId,
    includeArchived,
  }: SummaryTimelineRead): Promise<{ record: StoredAgentRecord | null | undefined } | null> {
    const record = await this.registry?.get(agentId);
    const current = this.agents.get(agentId) ?? record;
    if (
      current?.workspaceId !== workspaceId ||
      (record?.workspaceId && record.workspaceId !== workspaceId) ||
      current.internal ||
      current.background ||
      record?.internal ||
      record?.background ||
      isMainControlAgentLabels(current.labels) ||
      (record?.archivedAt && !includeArchived) ||
      this.pendingSubagentMoveSnapshots.has(agentId)
    ) {
      return null;
    }
    return { record };
  }

  private async waitForSummaryLifecycle(agentId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const tail = this.lifecycleMutationTails.get(agentId);
      if (!tail) return;
      // Attach one completion callback to each lifecycle tail. Timed-out
      // readers remove their listener and leave nothing queued on that lane.
      let waiters = this.summaryLifecycleWaits.get(tail);
      if (!waiters) {
        waiters = new Set();
        this.summaryLifecycleWaits.set(tail, waiters);
        const currentWaiters = waiters;
        void tail.finally(() => {
          for (const wake of currentWaiters) wake();
        });
      }
      await new Promise<void>((resume) => {
        const wake = () => {
          waiters.delete(wake);
          signal.removeEventListener("abort", wake);
          resume();
        };
        waiters.add(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    }
    signal.throwIfAborted();
  }

  private async readSummaryTimeline(
    request: SummaryTimelineRead,
  ): Promise<AgentTimelineItem[] | null> {
    const { agentId, signal } = request;
    // Preserve the result of interactive hydration already in progress. A
    // summary's own provider replay does not update any local timeline.
    if (!this.summaryProviderLifecycle.has(agentId)) {
      await this.waitForSummaryLifecycle(agentId, signal);
    }
    const local = await this.readLocalSummaryTimeline(request);
    if (!local?.replay) return local?.items ?? null;
    const { record } = local.replay;

    return this.summaryProviderReads.run(agentId, signal, async () => {
      // Taking a provider slot does not put a read behind a stalled mutation.
      // Once started, serialize replay with normal open, close and archive.
      while (this.lifecycleMutationTails.has(agentId)) {
        await this.waitForSummaryLifecycle(agentId, signal);
      }
      signal.throwIfAborted();
      this.summaryProviderLifecycle.add(agentId);
      try {
        return await this.runLifecycleMutation(agentId, async () => {
          signal.throwIfAborted();
          const visible = await this.getSummaryTimelineRecord(request);
          signal.throwIfAborted();
          if (!visible) return null;
          const latest =
            this.timelineStore.has(agentId) || visible.record !== record
              ? await this.readLocalSummaryTimeline(request)
              : local;
          signal.throwIfAborted();
          return latest?.replay
            ? this.readStoredTimelineForSummary({ ...latest.replay, signal })
            : (latest?.items ?? null);
        });
      } finally {
        this.summaryProviderLifecycle.delete(agentId);
      }
    });
  }

  private async readLocalSummaryTimeline(request: SummaryTimelineRead) {
    const { agentId, retainedOnly, signal } = request;
    return this.summaryLocalReads.run(agentId, signal, async () => {
      const visible = await this.getSummaryTimelineRecord(request);
      signal.throwIfAborted();
      if (!visible) return null;
      if (this.timelineStore.has(agentId)) {
        return { items: await this.readLoadedTimelineForSummary(agentId), replay: null };
      }
      const committed = await this.durableTimelineStore?.getCommittedRows(agentId);
      signal.throwIfAborted();
      if (this.timelineStore.has(agentId)) {
        return { items: await this.readLoadedTimelineForSummary(agentId), replay: null };
      }
      if (committed?.length) return { items: projectSummaryTimelineItems(committed), replay: null };
      const { record } = visible;
      if (!record) return { items: [], replay: null };
      const prefix = await this.timelinePrefixes.load(agentId);
      signal.throwIfAborted();
      const handle =
        retainedOnly || record.archivedAt
          ? null
          : toAgentPersistenceHandle(this.getRegisteredProviderIds(), record.persistence);
      return {
        items: prefix?.rows.map(({ item }) => item) ?? [],
        replay: handle ? { record, handle, prefix } : null,
      };
    });
  }

  private async readLoadedTimelineForSummary(agentId: string): Promise<AgentTimelineItem[]> {
    if (this.timelineStore.getSealedThrough(agentId)) return this.timelineStore.getItems(agentId);

    const items = projectSummaryTimelineItems(this.timelineStore.getRows(agentId));
    const historyPrimed =
      this.agents.get(agentId)?.historyPrimed ?? !this.unprimedRetainedTimelines.has(agentId);
    if (historyPrimed) return items;

    // A failed replay leaves its timeline unprimed, even if the session has
    // since closed. The retained prefix is still on disk.
    const prefix = await this.timelinePrefixes.load(agentId);
    return prefix?.rows.length ? [...prefix.rows.map(({ item }) => item), ...items] : items;
  }

  private async readStoredTimelineForSummary({
    record,
    handle,
    prefix,
    signal,
  }: {
    record: StoredAgentRecord;
    handle: AgentPersistenceHandle;
    prefix: PersistedTimelinePrefix | null;
    signal: AbortSignal;
  }): Promise<AgentTimelineItem[]> {
    const agentId = record.id;

    let events: Extract<AgentStreamEvent, { type: "timeline" }>[];
    try {
      events = await this.readSummaryProviderHistory({ record, handle, signal });
    } catch (error) {
      signal.throwIfAborted();
      if (!prefix?.rows.length) throw error;
      this.logger.warn({ err: error, agentId }, "Using retained history for workspace summary");
      return prefix.rows.map(({ item }) => item);
    }

    if (!prefix?.rows.length) {
      return projectSummaryTimelineItems(
        buildImportedTimelineRows(
          events.map(({ item, timestamp }) => ({ item, timestamp: timestamp ?? record.updatedAt })),
        ),
      );
    }

    // Use the same sealed boundary as chat hydration so provider-local IDs cannot replace
    // retained tool calls or join new assistant text to a previous provider's message.
    const timeline = new InMemoryAgentTimelineStore();
    timeline.initialize(agentId, {
      rows: prefix.rows,
      sealedThrough: maxTimelineSeq(prefix.rows),
    });
    for (const { item, timestamp } of this.excludePrefixReplay(prefix, events)) {
      timeline.append(agentId, limitAgentTimelineItemContent(item), {
        timestamp: timestamp ?? record.updatedAt,
      });
    }
    return timeline.getItems(agentId);
  }

  private async readSummaryProviderHistory({
    record,
    handle,
    signal,
  }: {
    record: StoredAgentRecord;
    handle: AgentPersistenceHandle;
    signal: AbortSignal;
  }): Promise<Extract<AgentStreamEvent, { type: "timeline" }>[]> {
    const client = this.requireClient(handle.provider);
    const config = await this.normalizeConfig(
      {
        ...handle.metadata,
        ...buildConfigOverrides(record),
        provider: handle.provider,
        cwd: record.cwd,
      },
      { purpose: "history", resolveDefaultModel: false },
    );
    signal.throwIfAborted();
    const reader = await client.resumeSession(
      handle,
      config,
      { agentId: record.id, env: record.launchEnv },
      { purpose: "history" },
    );
    let closing: Promise<void> | undefined;
    const closeReader = () => (closing ??= Promise.resolve().then(() => reader.close()));
    const onAbort = () => {
      void closeReader().catch((err: unknown) => {
        this.logger.warn({ err, agentId: record.id }, "Failed to close workspace summary reader");
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      signal.throwIfAborted();
      const events: Extract<AgentStreamEvent, { type: "timeline" }>[] = [];
      for await (const rawEvent of reader.streamHistory()) {
        signal.throwIfAborted();
        const event = limitAgentStreamEventContent(rawEvent, record.id);
        if (event.type !== "timeline") continue;
        for (const item of projectAgentMessages(event.item)) {
          events.push({ ...event, item });
        }
      }
      return events;
    } finally {
      try {
        await closeReader();
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  async getTimelineRows(id: string): Promise<AgentTimelineRow[]> {
    this.requireAgent(id);
    if (this.durableTimelineStore && !this.timelineStore.getSealedThrough(id)) {
      await this.durableTimelineWriteTails.get(id);
      return projectTimelineRows({
        rows: await this.durableTimelineStore.getCommittedRows(id),
        mode: "projected",
      }).map((entry) => Object.assign({ seq: entry.seqEnd }, entry));
    }
    return this.timelineStore.getRows(id);
  }

  readArchivedForkContext(agentId: string, archivedAt: string) {
    const entry = this.archivedForkContexts.get(agentId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now() || entry.archivedAt !== archivedAt) {
      this.archivedForkContexts.delete(agentId);
      return null;
    }
    return entry.context;
  }

  private retainArchivedForkContext(record: ArchivedStoredAgentRecord): void {
    const rows = this.timelineStore.getRows(record.id);
    if (rows.length === 0) return;
    const context = buildAgentForkContextAttachment({
      rows,
      sourceAgentId: record.id,
      sourceServerId: this.serverId,
      agentTitle: record.title,
      cwd: record.cwd,
    });
    if (context.itemCount === 0) return;
    this.archivedForkContexts.delete(record.id);
    if (this.archivedForkContexts.size >= ARCHIVED_FORK_CONTEXT_LIMIT) {
      const oldest = this.archivedForkContexts.keys().next();
      if (!oldest.done) this.archivedForkContexts.delete(oldest.value);
    }
    this.archivedForkContexts.set(record.id, {
      archivedAt: record.archivedAt,
      expiresAt: Date.now() + ARCHIVED_FORK_CONTEXT_TTL_MS,
      context,
    });
  }

  /** The timeline head of a loaded agent, or null when this agent is not loaded. Never loads. */
  getLoadedTimelineHead(id: string): { epoch: string; seq: number } | null {
    return this.getAgent(id) ? this.timelineStore.getHead(id) : null;
  }

  fetchTimeline(id: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    this.requireAgent(id);
    return this.timelineStore.fetch(id, options);
  }

  listProviderSubagents(parentAgentId: string): ProviderSubagentDescriptor[] {
    this.requirePublicAgent(parentAgentId);
    return this.providerSubagents.list(parentAgentId);
  }

  listAgentBackgroundWork(agentId: string): AgentBackgroundWorkItem[] {
    const agent = this.agents.get(agentId);
    if (agent?.internal || (!agent && !this.backgroundWork.summary(agentId))) {
      throw new Error(`Unknown agent '${agentId}'`);
    }
    return this.backgroundWork.list(agentId);
  }

  setDaemonBackgroundWork(input: DaemonBackgroundWorkInput): void {
    this.publishBackgroundWork(input.agentId, this.backgroundWork.setDaemonBackgroundWork(input));
  }

  removeDaemonBackgroundWork(key: DaemonBackgroundWorkKey): void {
    this.publishBackgroundWork(key.agentId, this.backgroundWork.removeDaemonBackgroundWork(key));
  }

  async stopAgentBackgroundWork({
    agentId,
    itemId,
    stopToken,
    canManageAutomation,
  }: StopAgentBackgroundWorkOptions): Promise<void> {
    if (isDaemonBackgroundWorkItem({ id: itemId })) {
      if (this.agents.get(agentId)?.internal) throw new Error(`Unknown agent '${agentId}'`);
      if (!canManageAutomation)
        throw new Error("Managing automation is required to stop daemon background work");
      await this.backgroundWork.stopDaemon(agentId, itemId, stopToken);
      return;
    }
    this.requirePublicAgent(agentId);
    // Inventory events share the session queue; drain events already received before
    // authorizing the token, including a reconnect's ownership revocation.
    await this.sessionEventTails.get(agentId)?.catch(() => undefined);
    const { session } = this.requirePublicAgent(agentId);
    if (!session?.stopBackgroundWork) throw new Error("Background work cannot be stopped");
    const providerItemId = this.backgroundWork.authorizeProviderStop(agentId, itemId, stopToken);
    await session.stopBackgroundWork(providerItemId);
  }

  getAgentBackgroundWorkSummary(agentId: string) {
    return this.backgroundWork.summary(agentId);
  }

  private publishBackgroundWork(agentId: string, items: AgentBackgroundWorkItem[] | null): void {
    if (items) this.dispatch({ type: "background_work", agentId, items });
  }

  private clearProviderBackgroundWork(agentId: string): void {
    this.publishBackgroundWork(agentId, this.backgroundWork.clear(agentId));
  }

  listProviderSubagentActivity(): ProviderSubagentDescriptor[] {
    const publicParentIds = new Set(
      Array.from(this.agents.values())
        .filter((agent) => !agent.internal)
        .map((agent) => agent.id),
    );
    return this.providerSubagents
      .listAll()
      .filter((subagent) => publicParentIds.has(subagent.parentAgentId));
  }

  getProviderSubagent(
    parentAgentId: string,
    subagentId: string,
  ): ProviderSubagentDescriptor | null {
    this.requirePublicAgent(parentAgentId);
    return this.providerSubagents.get(parentAgentId, subagentId);
  }

  fetchProviderSubagentTimeline(
    parentAgentId: string,
    subagentId: string,
    options?: AgentTimelineFetchOptions,
  ): AgentTimelineFetchResult {
    this.requirePublicAgent(parentAgentId);
    return this.providerSubagents.fetchTimeline(parentAgentId, subagentId, options);
  }

  async createAgent(
    config: AgentSessionConfig,
    agentId: string | undefined,
    options: CreateAgentOptions,
  ): Promise<ManagedAgent> {
    const resolvedAgentId = validateAgentId(agentId ?? this.idFactory(), "createAgent");
    const createInLifecycleLane = (resolvedOptions: CreateAgentOptions = options) =>
      this.runLifecycleMutation(resolvedAgentId, () =>
        this.createAgentInternal(config, resolvedAgentId, {
          ...resolvedOptions,
          mainControlSystemPrompt: this.snapshotMainControlPrompt(resolvedOptions.labels),
        }),
      );
    const parentId = this.localHierarchyParentId(options.labels);
    return this.trackAgentRegistrationOperation(
      parentId
        ? this.runHierarchyMutation(async () => {
            const hierarchy = await this.readHierarchyAgents();
            const parent =
              hierarchy.get(parentId) ??
              (await this.registry?.get(parentId)) ??
              this.agents.get(parentId);
            if (!parent || this.pendingHierarchyArchives.has(parentId)) {
              throw new Error(`Parent agent ${parentId} is missing or archived.`);
            }
            if (this.pendingSubagentMoveSnapshots.has(parentId)) {
              throw new Error("Recover the parent's workspace move before creating a subagent.");
            }
            validateCanSpawnChild(parent, (id) => hierarchy.get(id) ?? this.agents.get(id));
            if (options.inheritParentWorkspace && !parent.workspaceId) {
              throw new Error(`Parent agent ${parentId} has no current workspace.`);
            }
            return createInLifecycleLane(
              options.inheritParentWorkspace
                ? { ...options, workspaceId: parent.workspaceId }
                : options,
            );
          })
        : createInLifecycleLane(),
    );
  }

  /**
   * Opens a stored agent whose provider left no session to resume: its first session, created
   * from the record as it is when the lane reaches it. A write queued ahead (`setMetadata`,
   * `setLabels`) is in that record; one queued behind applies to the live agent.
   */
  createAgentFromRecord(agentId: string): Promise<ManagedAgent> {
    const resolvedAgentId = validateAgentId(agentId, "createAgentFromRecord");
    return this.trackAgentRegistrationOperation(
      this.runLifecycleMutation(resolvedAgentId, async () => {
        const record = await this.requireRegistry().get(resolvedAgentId);
        if (!record) throw new AgentNotFoundError(resolvedAgentId);
        const config = buildSessionConfig(record, {
          validProviders: this.getRegisteredProviderIds(),
        });
        if (!config) {
          throw new Error(
            `Agent ${resolvedAgentId} references unavailable provider '${record.provider}'`,
          );
        }
        const prefix = await this.timelinePrefixes.load(resolvedAgentId);
        return this.createAgentInternal(
          config,
          resolvedAgentId,
          {
            labels: record.labels,
            mainControlSystemPrompt: record.mainControlSystemPrompt,
            metadata: record.metadata,
            workspaceId: record.workspaceId,
            owner: record.owner,
            background: record.background,
            env: record.launchEnv,
          },
          prefix,
        );
      }),
    );
  }

  private async createAgentInternal(
    config: AgentSessionConfig,
    resolvedAgentId: string,
    options: CreateAgentOptions & Pick<StoredAgentRecord, "mainControlSystemPrompt">,
    retainedPrefix?: PersistedTimelinePrefix | null,
  ): Promise<ManagedAgent> {
    this.assertAcceptingAgentRegistrations();
    config = this.withConvertedOptions(config);
    if (this.pluginLifecycle && !config.internal) {
      const sent = exposeFeatureValuesToHook(config);
      const request = await this.pluginLifecycle.before("agent.create.before", {
        config: sent,
        env: options.env,
        metadata: options.metadata ?? {},
      });
      // COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01. A plugin written
      // against the previous SDK edits `config.featureValues`.
      config = {
        ...foldHookFeatureValues({
          returned: request.config,
          sent,
          convert: (values) => this.convertLegacyOptions(request.config.provider, values),
        }),
        internal: config.internal,
      };
      options = { ...options, env: request.env, metadata: request.metadata ?? options.metadata };
    }
    if (!retainedPrefix) {
      await this.deleteAgentState(resolvedAgentId);
    }
    const { storedConfig, launchConfig, paseoToolPolicy } = await this.prepareSessionConfig(
      config,
      resolvedAgentId,
      {
        env: options.env,
        labels: options.labels,
        mainControlSystemPrompt: options.mainControlSystemPrompt,
      },
    );
    this.requireEnabledProvider(storedConfig.provider);
    const client = await this.requireAvailableClient({
      provider: storedConfig.provider,
    });
    this.paseoToolPolicies.set(resolvedAgentId, paseoToolPolicy);
    const launchContext = await this.buildLaunchContext(
      resolvedAgentId,
      client,
      storedConfig.cwd,
      paseoToolPolicy,
      options.env,
      {
        reason: "create",
        purpose: "interactive",
        workspaceId: options.workspaceId ?? null,
        title: options.initialTitle ?? storedConfig.title ?? null,
        background: options.background,
        labels: options.labels ?? {},
        metadata: options.metadata ?? {},
      },
    );
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);
    const createOptions = this.buildCreateSessionOptions(options);
    const launchedOptions = this.launchOptionsFor({
      client,
      own: providerLaunchConfig.providerOptions,
    });
    const session = await client.createSession(providerLaunchConfig, launchContext, createOptions);
    await this.requireExternalMcpSupport(session, providerLaunchConfig, launchContext);
    await this.assertOpeningChildHasActiveParent(options.labels, session);
    const forkPrefix = await this.prepareForkPrefix({
      session,
      agentId: resolvedAgentId,
      rows: options.forkedTimelineRows,
      retainedPrefix,
    });
    const agent = await this.registerSession(session, storedConfig, resolvedAgentId, {
      launchedOptions,
      labels: options.labels,
      mainControlSystemPrompt: options.mainControlSystemPrompt,
      metadata: options.metadata,
      initialTitle: options.initialTitle,
      workspaceId: options.workspaceId,
      owner: options.owner,
      background: options.background,
      launchEnv: options.env ? { ...options.env } : undefined,
      historyPrimed: true,
      timelineRows: forkPrefix?.rows,
      contextPrefix: forkPrefix,
    });
    if (!agent.internal) {
      this.pluginLifecycle?.emit("agent.create.after", {
        agent: describeHookAgent({ ...agent, title: agent.config.title }),
      });
    }
    return agent;
  }

  private async prepareForkPrefix(input: {
    session: AgentSession;
    agentId: string;
    rows?: AgentTimelineRow[];
    retainedPrefix?: PersistedTimelinePrefix | null;
  }): Promise<PersistedTimelinePrefix | null | undefined> {
    if (!input.rows) return input.retainedPrefix;
    const prefix = this.buildPendingTimelinePrefix(input.rows);
    try {
      await this.timelinePrefixes.save(input.agentId, prefix);
    } catch (error) {
      await this.closeUnregisteredSession(input.session);
      throw error;
    }
    return prefix;
  }

  private async assertOpeningChildHasActiveParent(
    labels: Record<string, string> | undefined,
    session: AgentSession,
  ): Promise<void> {
    const parentId = this.localHierarchyParentId(labels);
    if (!parentId) return;
    try {
      const parent = this.agents.get(parentId) ?? (await this.registry?.get(parentId));
      if (
        !parent ||
        ("archivedAt" in parent && parent.archivedAt) ||
        this.pendingHierarchyArchives.has(parentId)
      ) {
        throw new Error(`Parent agent ${parentId} is missing or archived.`);
      }
    } catch (error) {
      await this.closeUnregisteredSession(session);
      throw error;
    }
  }

  private buildCreateSessionOptions(options?: {
    persistSession?: boolean;
  }): AgentCreateSessionOptions | undefined {
    return options?.persistSession === undefined
      ? undefined
      : { persistSession: options.persistSession };
  }

  // Reconstruct an agent from provider persistence. Callers should explicitly
  // hydrate timeline history after resume.
  resumeAgentFromPersistence(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    agentId?: string,
    options?: {
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
      labels?: Record<string, string>;
      metadata?: AgentMetadata;
      workspaceId?: string;
      owner?: AgentOwner;
      background?: boolean;
      attention?: AttentionState;
    },
    resumeOptions?: AgentResumeSessionOptions,
  ): Promise<ManagedAgent> {
    const resolvedAgentId = validateAgentId(
      agentId ?? this.idFactory(),
      "resumeAgentFromPersistence",
    );
    return this.trackAgentRegistrationOperation(
      this.runLifecycleMutation(resolvedAgentId, () =>
        this.resumeAgentFromPersistenceInternal(
          handle,
          overrides,
          resolvedAgentId,
          options,
          resumeOptions,
        ),
      ),
    );
  }

  private async resumeAgentFromPersistenceInternal(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    agentId?: string,
    options?: {
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
      labels?: Record<string, string>;
      metadata?: AgentMetadata;
      workspaceId?: string;
      owner?: AgentOwner;
      background?: boolean;
      attention?: AttentionState;
    },
    resumeOptions?: AgentResumeSessionOptions,
  ): Promise<ManagedAgent> {
    this.assertAcceptingAgentRegistrations();
    const resolvedAgentId = validateAgentId(
      agentId ?? this.idFactory(),
      "resumeAgentFromPersistence",
    );
    const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    const mergedConfig = {
      ...metadata,
      ...overrides,
      provider: handle.provider,
    } as AgentSessionConfig;
    // Decide residency from durable state inside the lifecycle lane. A loader may
    // have read the record before a queued archive or restore completed. Residency is
    // settled before the config is prepared, because a history load reads an archived
    // agent whose working directory may be gone.
    const record = this.registry ? await this.registry.get(resolvedAgentId) : null;
    const purpose = await resolveResumePurpose(record, resumeOptions?.purpose, mergedConfig.cwd);
    const currentResumeOptions = { purpose } satisfies AgentResumeSessionOptions;

    const { launchEnv, mainControlSystemPrompt } = record ?? {};
    const workspaceId = resolveResumeWorkspaceId({ options, record });
    const { storedConfig, launchConfig, paseoToolPolicy } = await this.prepareSessionConfig(
      mergedConfig,
      resolvedAgentId,
      {
        purpose,
        env: launchEnv,
        labels: record?.labels ?? options?.labels,
        mainControlSystemPrompt,
      },
    );
    const client = this.requireClient(handle.provider);
    const available = await client.isAvailable();
    if (!available) {
      throw new Error(
        `Provider '${handle.provider}' is not available. Please ensure the CLI is installed.`,
      );
    }
    this.paseoToolPolicies.set(resolvedAgentId, paseoToolPolicy);
    const launchContext = await this.buildLaunchContext(
      resolvedAgentId,
      client,
      storedConfig.cwd,
      paseoToolPolicy,
      launchEnv,
      {
        reason: "resume",
        purpose,
        workspaceId,
        title: record?.title ?? mergedConfig.title ?? null,
        background: options?.background,
        ...agentEntityData(record ?? options),
      },
    );
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);
    const launchedOptions = this.launchOptionsFor({
      client,
      own: providerLaunchConfig.providerOptions,
    });
    const session = await client.resumeSession(
      handle,
      providerLaunchConfig,
      launchContext,
      currentResumeOptions,
    );
    if (purpose === "history") this.historySessions.add(session);
    await this.requireExternalMcpSupport(session, providerLaunchConfig, launchContext);
    return this.registerSession(session, storedConfig, resolvedAgentId, {
      launchedOptions,
      ...options,
      // The caller read its metadata and attention before this turn in the lane; a setMetadata
      // or attention clear queued ahead of it has saved a newer record, the one the open hooks saw.
      ...(record
        ? { labels: record.labels, metadata: record.metadata, attention: extractAttention(record) }
        : {}),
      workspaceId,
      launchEnv,
      mainControlSystemPrompt,
      persistence:
        purpose === "interactive" && session.persistenceUpdatedOnResume
          ? (session.describePersistence() ?? handle)
          : handle,
      restoring: true,
    });
  }

  importProviderSession(input: {
    provider: AgentProvider;
    providerHandleId: string;
    cwd: string;
    workspaceId: string;
    labels?: Record<string, string>;
  }): Promise<ManagedAgent> {
    return this.trackAgentRegistrationOperation(this.importProviderSessionInternal(input));
  }

  private async importProviderSessionInternal(input: {
    provider: AgentProvider;
    providerHandleId: string;
    cwd: string;
    workspaceId: string;
    labels?: Record<string, string>;
  }): Promise<ManagedAgent> {
    this.assertAcceptingAgentRegistrations();
    const resolvedAgentId = validateAgentId(this.idFactory(), "importProviderSession");
    this.requireEnabledProvider(input.provider);

    const client = await this.requireAvailableClient({ provider: input.provider });
    if (!client.importSession) {
      throw new Error(`Provider '${input.provider}' does not support importing sessions`);
    }

    const mainControlSystemPrompt = this.snapshotMainControlPrompt(input.labels);
    const { storedConfig, launchConfig, paseoToolPolicy } = await this.prepareSessionConfig(
      {
        provider: input.provider,
        cwd: input.cwd,
      },
      resolvedAgentId,
      { resolveDefaultModel: false, labels: input.labels, mainControlSystemPrompt },
    );
    this.paseoToolPolicies.set(resolvedAgentId, paseoToolPolicy);
    const launchContext = await this.buildLaunchContext(
      resolvedAgentId,
      client,
      storedConfig.cwd,
      paseoToolPolicy,
      undefined,
      {
        reason: "import",
        purpose: "interactive",
        workspaceId: input.workspaceId,
        labels: input.labels ?? {},
      },
    );
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);
    const launchedOptions = this.launchOptionsFor({
      client,
      own: providerLaunchConfig.providerOptions,
    });
    const imported = await client.importSession(
      {
        providerHandleId: input.providerHandleId,
        cwd: input.cwd,
      },
      { config: providerLaunchConfig, storedConfig, launchContext },
    );
    await this.requireExternalMcpSupport(imported.session, providerLaunchConfig, launchContext);
    let handedToRegistration = false;
    try {
      const runtimeInfo = await imported.session.getRuntimeInfo();
      const importedConfig = await this.normalizeConfig(
        stripInternalPaseoMcpServer({
          ...imported.config,
          model: runtimeInfo.model ?? imported.config.model,
        }),
        { resolveDefaultModel: false },
      );
      const timelineRows = buildImportedTimelineRows(imported.timeline);
      const initialTitle = resolveImportedAgentTitle(importedConfig, timelineRows);
      const mainControlRoleVersion = this.launchMainControlRoleVersions.get(storedConfig);
      if (mainControlRoleVersion !== undefined) {
        this.launchMainControlRoleVersions.set(importedConfig, mainControlRoleVersion);
      }

      handedToRegistration = true;
      const agent = await this.registerSession(imported.session, importedConfig, resolvedAgentId, {
        mainControlSystemPrompt,
        launchedOptions,
        labels: input.labels,
        workspaceId: input.workspaceId,
        timelineRows,
        timelineNextSeq: timelineRows.length + 1,
        persistence: imported.persistence,
        historyPrimed: true,
        initialTitle,
        publishWhenReady: true,
      });
      for (const event of imported.providerSubagentEvents ?? []) {
        const update = this.providerSubagents.apply(agent.id, event.provider, event.event);
        this.dispatch({ type: "provider_subagent", event: update });
      }
      return agent;
    } finally {
      if (!handedToRegistration) {
        await this.closeUnregisteredSession(imported.session);
      }
    }
  }

  // Hot-reload an active agent session with config overrides. By default the
  // in-memory timeline is preserved (used for voice-mode toggles and similar
  // config swaps). When `rehydrateFromDisk` is set, the timeline is wiped so a
  // new epoch is minted and provider history is re-streamed — this is what the
  // user-facing "Reload agent" action wants when the on-disk session was
  // mutated outside Paseo.
  reloadAgentSession(
    agentId: string,
    overrides?: Partial<AgentSessionConfig>,
    options?: { rehydrateFromDisk?: boolean },
  ): Promise<ManagedAgent> {
    return this.trackAgentRegistrationOperation(
      this.runLifecycleMutation(agentId, () =>
        this.reloadAgentSessionInternal(agentId, overrides, options),
      ),
    );
  }

  private async reloadAgentSessionInternal(
    agentId: string,
    overrides?: Partial<AgentSessionConfig>,
    {
      rehydrateFromDisk = false,
      mainControlRole,
      refreshHierarchy = false,
    }: {
      rehydrateFromDisk?: boolean;
      mainControlRole?: MainControlRoleUpdate;
      refreshHierarchy?: boolean;
    } = {},
  ): Promise<ManagedAgent> {
    this.assertAcceptingAgentRegistrations();
    let existing = this.requireSessionAgent(agentId);
    if (this.shouldCancelRunForReload(existing, { mainControlRole, refreshHierarchy })) {
      await this.cancelAgentRunBefore(agentId, "reload");
      existing = this.requireSessionAgent(agentId);
    }
    const preservedHistoryPrimed = existing.historyPrimed;
    const preservedLastUsage = existing.lastUsage;
    const preservedLastError = existing.lastError;
    const preservedAttention = existing.attention;
    const handle = existing.persistence;
    const provider = handle?.provider ?? existing.provider;
    const client = this.requireClient(provider);
    const refreshConfig = {
      ...existing.config,
      ...overrides,
      provider,
    } as AgentSessionConfig;
    const { labels, mainControlSystemPrompt } = mainControlRole ?? existing;
    const { storedConfig, launchConfig, paseoToolPolicy } = await this.prepareSessionConfig(
      refreshConfig,
      agentId,
      { env: existing.launchEnv, labels, mainControlSystemPrompt },
    );
    const hadPreviousPaseoToolPolicy = this.paseoToolPolicies.has(agentId);
    const previousPaseoToolPolicy = this.paseoToolPolicies.get(agentId);
    const launchContext = await this.buildLaunchContext(
      agentId,
      client,
      storedConfig.cwd,
      paseoToolPolicy,
      existing.launchEnv,
      {
        reason: "refresh",
        purpose: "interactive",
        workspaceId: existing.workspaceId,
        title: await this.resolveInitialPersistedTitle(agentId, existing.config, null),
        background: existing.background,
        labels,
        metadata: existing.metadata,
      },
    );
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);
    if (
      Object.keys(stripInternalPaseoMcpServer(providerLaunchConfig).mcpServers ?? {}).length > 0 &&
      existing.session.capabilities.supportsMcpServers !== true
    ) {
      throw this.unsupportedMcpError(providerLaunchConfig, launchContext);
    }

    let session: AgentSession | undefined;
    let closedExisting: ManagedAgentClosed | undefined;
    let handedToRegistration = false;
    try {
      // A persisted thread can have only one writer, even when its turn is idle.
      await this.closeReloadedSession(existing.session, agentId);
      await this.drainSessionEvents(agentId);
      this.cancelRunningProviderSubagents(agentId);
      this.clearProviderBackgroundWork(agentId);
      closedExisting = this.prepareAgentForClosure(existing, "agent reloaded");
      this.applyReloadedHierarchy(closedExisting, storedConfig, mainControlRole);
      await this.persistSnapshot(closedExisting);
      this.assertAcceptingAgentRegistrations();

      this.paseoToolPolicies.set(agentId, paseoToolPolicy);
      const launchedOptions = this.launchOptionsFor({
        client,
        own: providerLaunchConfig.providerOptions,
      });
      session = handle
        ? await client.resumeSession(handle, providerLaunchConfig, launchContext)
        : await client.createSession(providerLaunchConfig, launchContext);
      await this.requireExternalMcpSupport(session, providerLaunchConfig, launchContext);
      this.assertAcceptingAgentRegistrations();

      if (rehydrateFromDisk) {
        // Wipe the in-memory timeline so registerSession mints a new epoch and
        // hydrateTimelineFromProvider re-streams the freshly read provider history.
        this.timelineStore.delete(agentId);
        for (const event of this.providerSubagents.deleteParent(agentId)) {
          this.dispatch({ type: "provider_subagent", event });
        }
      }

      // Preserve existing labels and timeline during reload.
      handedToRegistration = true;
      return this.registerSession(session, storedConfig, agentId, {
        launchedOptions,
        labels,
        mainControlSystemPrompt,
        metadata: existing.metadata,
        workspaceId: existing.workspaceId,
        owner: existing.owner,
        background: existing.background,
        launchEnv: existing.launchEnv,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
        lastUserMessageAt: existing.lastUserMessageAt,
        historyPrimed: !rehydrateFromDisk && preservedHistoryPrimed,
        lastUsage: preservedLastUsage,
        lastError: preservedLastError,
        attention: preservedAttention,
        restoring: true,
      });
    } catch (error) {
      if (closedExisting) {
        this.emitClosedAgent(closedExisting, { persist: false });
      } else if (this.agents.get(agentId) === existing) {
        existing.lifecycle = "error";
        existing.lastError = error instanceof Error ? error.message : String(error);
        this.raiseErrorAttention(existing);
        this.emitState(existing);
      }
      throw error;
    } finally {
      if (!handedToRegistration) {
        this.detachPluginTools(agentId);
        await this.cleanUpReload(
          agentId,
          session,
          hadPreviousPaseoToolPolicy,
          previousPaseoToolPolicy,
          closedExisting,
          mainControlRole,
        );
      }
    }
  }

  private applyReloadedHierarchy(
    agent: ManagedAgentClosed,
    config: AgentSessionConfig,
    role?: MainControlRoleUpdate,
  ): void {
    if (!role) return;
    agent.labels = role.labels;
    agent.mainControlSystemPrompt = role.mainControlSystemPrompt;
    agent.config = config;
    agent.currentModeId = config.modeId ?? null;
    if (agent.runtimeInfo)
      agent.runtimeInfo = { ...agent.runtimeInfo, modeId: agent.currentModeId };
    this.touchUpdatedAt(agent);
  }

  private shouldCancelRunForReload(
    agent: ManagedAgent,
    options: { mainControlRole?: MainControlRoleUpdate; refreshHierarchy: boolean },
  ): boolean {
    if (options.mainControlRole) {
      this.assertMainControlAgentIdle(agent.id);
      return false;
    }
    if (options.refreshHierarchy) {
      if (this.hasRunningHierarchyTurn(agent)) {
        throw new Error("Cannot refresh hierarchy during an active turn.");
      }
      return false;
    }
    return this.hasInFlightRun(agent.id);
  }

  private async cleanUpReload(
    agentId: string,
    session: AgentSession | undefined,
    hadPreviousPolicy: boolean,
    previousPolicy: ProviderPaseoToolsPolicy | undefined,
    closedExisting?: ManagedAgentClosed,
    mainControlRole?: MainControlRoleUpdate,
  ): Promise<void> {
    if (hadPreviousPolicy && !(closedExisting && mainControlRole)) {
      this.paseoToolPolicies.set(agentId, previousPolicy);
    } else {
      this.paseoToolPolicies.delete(agentId);
    }
    if (session) await this.closeUnregisteredSession(session);
  }

  private async closeReloadedSession(session: AgentSession, agentId: string): Promise<void> {
    let operation = this.reloadedSessionCloses.get(session);
    if (!operation) {
      operation = session.close();
      this.reloadedSessionCloses.set(session, operation);
      // Keep pending closes across request timeouts; a retry must await the same release.
      void operation.catch(() => this.reloadedSessionCloses.delete(session));
    }
    const result = await this.waitWithTimeout({
      operation,
      timeoutMs: this.rescueTimeouts.reloadSessionCloseMs,
      onLateError: (error) => {
        this.logger.warn(
          { err: error, agentId },
          "Previous session close failed after refresh timeout",
        );
      },
    });
    if (result === "timed_out") {
      throw new Error("Timed out closing previous session during refresh");
    }
  }

  private async waitWithTimeout(options: TimeoutOptions): Promise<TimeoutResult> {
    let didTimeOut = false;
    let timer: NodeJS.Timeout | null = null;
    const operation = options.operation
      .then((): TimeoutResult => "completed")
      .catch((error) => {
        if (didTimeOut) {
          options.onLateError?.(error);
          return "timed_out" as const;
        }
        throw error;
      });

    try {
      return await Promise.race([
        operation,
        new Promise<TimeoutResult>((resolvePromise) => {
          timer = setTimeout(() => {
            didTimeOut = true;
            resolvePromise("timed_out");
          }, options.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * The archived snapshot of an internal agent, for a while after archive.
   * Null once it has expired or was never an internal agent.
   */
  getRetiredInternalAgent(agentId: string): RetiredInternalAgent | null {
    const entry = this.retiredInternalAgents.get(agentId);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.retiredInternalAgents.delete(agentId);
      return null;
    }
    return { record: entry.record, lastMessage: entry.lastMessage };
  }

  private retireInternalAgent(entry: RetiredInternalAgent): void {
    const now = Date.now();
    for (const [agentId, retired] of this.retiredInternalAgents) {
      if (retired.expiresAt <= now) {
        this.retiredInternalAgents.delete(agentId);
      }
    }
    while (this.retiredInternalAgents.size >= RETIRED_INTERNAL_AGENT_LIMIT) {
      const oldest = this.retiredInternalAgents.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.retiredInternalAgents.delete(oldest);
    }
    this.retiredInternalAgents.set(entry.record.id, {
      ...entry,
      expiresAt: now + RETIRED_INTERNAL_AGENT_TTL_MS,
    });
  }

  /** Capture runtime capabilities without handing lifecycle ownership to the collector. */
  getRuntimeCleanupCandidates(): RuntimeCleanupCandidate[] {
    if (!this.registry) return [];
    const candidates: RuntimeCleanupCandidate[] = [];
    for (const agent of this.agents.values()) {
      const updatedAt = agent.updatedAt;
      let identity = this.runtimeCleanupIdentities.get(agent.session);
      if (!identity) {
        identity = Object.freeze({ openedAt: Date.now() });
        this.runtimeCleanupIdentities.set(agent.session, identity);
      }
      const isEligible = () =>
        this.agents.get(agent.id) === agent &&
        agent.updatedAt === updatedAt &&
        this.runtimeHasNoPendingWork(agent);
      candidates.push({
        identity,
        agentId: agent.id,
        parentAgentId: getParentAgentIdFromLabels(agent.labels) ?? undefined,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? null,
        lastActivityAt: Math.max(updatedAt.getTime(), identity.openedAt),
        isEligible,
        canStopRuntime: agent.session.canStopRuntime?.bind(agent.session),
        closeIfEligible: async (revalidate) => {
          if (!agent.persistence?.sessionId) return false;
          // Block prompt admission before entering the close lane. A skipped close also
          // releases this barrier, so the waiting prompt keeps the existing runtime.
          this.collectingRuntimes.add(agent.id);
          try {
            return await this.runLifecycleMutation(agent.id, () =>
              this.closeAgentRuntime(agent.id, () => isEligible() && revalidate()),
            );
          } finally {
            this.collectingRuntimes.delete(agent.id);
          }
        },
      });
    }
    return candidates;
  }

  private runtimeHasNoPendingWork(agent: LiveManagedAgent): boolean {
    return (
      agent.lifecycle === "idle" &&
      !agent.internal &&
      agent.activeForegroundTurnId === null &&
      !this.runs.hasRun(agent.id) &&
      !agent.pendingReplacement &&
      agent.pendingPermissions.size === 0 &&
      agent.inFlightPermissionResponses.size === 0 &&
      (this.collectingRuntimes.has(agent.id) || !this.lifecycleMutationTails.has(agent.id)) &&
      !this.foregroundMutationTails.has(agent.id) &&
      !this.replacementMutationTails.has(agent.id) &&
      !this.sessionEventTails.has(agent.id) &&
      !this.providerSubagents.list(agent.id).some((child) => child.status === "running")
    );
  }

  closeAgent(agentId: string): Promise<void> {
    const existing = this.inFlightAgentCloses.get(agentId);
    if (existing) {
      return existing;
    }

    const close = this.runLifecycleMutation(agentId, async () => {
      // A preceding reload or archive may already have closed the durable agent.
      if (this.agents.has(agentId)) await this.closeAgentRuntime(agentId);
    });
    this.inFlightAgentCloses.set(agentId, close);
    const clearClose = () => {
      if (this.inFlightAgentCloses.get(agentId) === close) {
        this.inFlightAgentCloses.delete(agentId);
      }
    };
    void close.then(clearClose, clearClose);
    return close;
  }

  private async closeAgentRuntime(agentId: string, canClose?: () => boolean): Promise<boolean> {
    const agent = this.requireAgent(agentId);
    this.logger.trace(
      {
        agentId,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: agent.activeForegroundTurnId ?? undefined,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        pendingPermissions: agent.pendingPermissions.size,
      },
      "agent.manager.close.start",
    );
    await this.drainSessionEvents(agentId);
    if (canClose && !canClose()) return false;
    // Retain ownership until shutdown succeeds. A failed close may still own a
    // native writer, so publishing a resumable closed snapshot would orphan it.
    await agent.session.close();
    await this.drainSessionEvents(agentId);
    this.cancelRunningProviderSubagents(agentId);
    // close() drops the session's subscribers before the provider could report an empty list.
    this.clearProviderBackgroundWork(agentId);
    const closedAgent = this.prepareAgentForClosure(agent, "agent closed");

    let persistError: unknown;
    try {
      await this.persistSnapshot(closedAgent);
    } catch (error) {
      persistError = error;
    }
    this.detachPluginTools(agentId);
    this.emitClosedAgent(closedAgent, { persist: false });
    this.logger.trace(
      {
        agentId,
        provider: closedAgent.provider,
        sessionId: closedAgent.persistence?.sessionId ?? undefined,
      },
      "agent.manager.close.complete",
    );

    if (persistError !== undefined) {
      throw persistError;
    }
    return true;
  }

  private cancelRunningProviderSubagents(parentAgentId: string): void {
    for (const subagent of this.providerSubagents.list(parentAgentId)) {
      if (subagent.status !== "running") {
        continue;
      }
      const event = this.providerSubagents.apply(parentAgentId, subagent.provider, {
        type: "upsert",
        id: subagent.id,
        status: "canceled",
      });
      this.dispatch({ type: "provider_subagent", event });
    }
  }

  async archiveAgent(agentId: string, archivedAt?: string): Promise<{ archivedAt: string }> {
    return this.runHierarchyArchive(agentId, () => this.archiveAgentUnlocked(agentId, archivedAt));
  }

  async archiveAgentInWorkspace(
    agentId: string,
    expectedWorkspaceId: string,
  ): Promise<{ archivedAt: string; record: StoredAgentRecord | null }> {
    return this.runHierarchyArchive(agentId, async () => {
      const live = this.agents.get(agentId);
      const stored = live?.internal ? null : await this.requireRegistry().get(agentId);
      const workspaceId = live ? live.workspaceId : stored?.workspaceId;
      if (workspaceId !== expectedWorkspaceId) {
        throw new Error(`Agent ${agentId} is no longer in workspace ${expectedWorkspaceId}`);
      }
      if (!live) {
        if (!stored) throw new Error(`Agent not found: ${agentId}`);
        if (stored.archivedAt) return { archivedAt: stored.archivedAt, record: stored };
        const archivedAt = new Date().toISOString();
        const record = await this.archiveSnapshotUnlocked(agentId, archivedAt);
        return { archivedAt: record.archivedAt ?? archivedAt, record };
      }
      if (this.hasInFlightRun(agentId)) await this.cancelAgentRun(agentId);
      await this.clearAgentAttentionUnlocked(agentId).catch(() => undefined);
      const { archivedAt } = await this.archiveAgentUnlocked(agentId, undefined, {
        retainForkContext: true,
      });
      const record = live.internal ? null : await this.requireRegistry().get(agentId);
      if (!record && !live.internal) {
        throw new Error(`Agent not found in storage after archive: ${agentId}`);
      }
      return { archivedAt: record?.archivedAt ?? archivedAt, record };
    });
  }

  private async archiveAgentUnlocked(
    agentId: string,
    requestedArchivedAt?: string,
    options?: { retainForkContext: boolean },
  ): Promise<{ archivedAt: string }> {
    const agent = this.requireAgent(agentId);
    if (agent.internal) {
      // Nothing about an internal agent is on disk, and archiving must not put
      // it there. Its final snapshot is kept in memory for a while (see
      // getRetiredInternalAgent); the runtime is closed and the committed
      // timeline dropped, so `getAgent` returns null from here on.
      const archivedAt = requestedArchivedAt ?? new Date().toISOString();
      const lastMessage = await this.getLastAssistantMessage(agentId);
      const record = buildArchivedAgentRecord(
        toStoredAgentRecord(agent, { title: agent.config.title ?? null, internal: true }),
        { archivedAt, updatedAt: archivedAt },
      );
      await this.closeAgentRuntime(agentId);
      await this.deleteAgentState(agentId);
      this.retireInternalAgent({ record, lastMessage });
      await this.cascadeArchiveChildren(record);
      return { archivedAt };
    }
    if (!this.registry) {
      throw new Error("Agent storage is not configured");
    }

    await this.registry.applySnapshot(agent, {
      internal: agent.internal,
    });
    const stored = await this.registry.get(agentId);
    if (!stored) {
      throw new Error(`Agent ${agentId} not found in storage after snapshot`);
    }

    const archivedRecord = await this.markRecordArchived(stored, requestedArchivedAt);
    const { archivedAt } = archivedRecord;
    agent.updatedAt = new Date(archivedRecord.updatedAt);
    await this.closeAgentRuntime(agentId);
    // Close has drained provider events and flushed buffered text. Provider history
    // may never contain the last partial reply, so retain the bounded fork attachment.
    if (options?.retainForkContext) this.retainArchivedForkContext(archivedRecord);
    await this.syncNativeArchiveState(stored.provider, stored.persistence, "archive");
    this.discardRetainedAgentState(agentId);

    await this.cascadeArchiveChildren(archivedRecord);

    return { archivedAt };
  }

  // Children created via the MCP `create_agent` tool carry the parent-agent-id
  // label pointing back at the caller. Archiving the parent cascades to those
  // children so subagent fleets don't outlive their orchestrator. Detached
  // handoff agents omit this label, so they stand outside the cascade.
  private async cascadeArchiveChildren(
    parent: Pick<ArchivedStoredAgentRecord, "id" | "workspaceId" | "archivedAt">,
  ): Promise<void> {
    const registry = this.registry;
    if (!registry) {
      return;
    }
    const parentAgentId = parent.id;
    const records = await registry.listActive();
    for (const record of records) {
      if (record.archivedAt) {
        continue;
      }
      if (record.labels?.[PARENT_AGENT_ID_LABEL] !== parentAgentId) {
        continue;
      }
      const child = await registry.get(record.id);
      if (!child || child.archivedAt || child.labels?.[PARENT_AGENT_ID_LABEL] !== parentAgentId) {
        continue;
      }
      await this.runLifecycleMutation(child.id, async () => {
        const currentChild = await registry.get(child.id);
        if (
          !currentChild ||
          currentChild.archivedAt ||
          currentChild.labels?.[PARENT_AGENT_ID_LABEL] !== parentAgentId
        ) {
          return;
        }
        if (shouldDetachFromArchivedParent(parent, currentChild)) {
          const detached = await this.detachAgentUnlocked(currentChild.id);
          if (!detached.live) {
            this.dispatchStoredAgentState(detached.record);
          }
        } else if (this.agents.has(currentChild.id)) {
          await this.archiveAgentUnlocked(currentChild.id, parent.archivedAt);
        } else {
          await this.archiveSnapshotUnlocked(currentChild.id, parent.archivedAt);
        }
      });
    }
    // Internal children never reach storage, so the scan above cannot see them.
    // They have no tab to keep open and no listing to detach into, so they
    // always archive with the parent.
    for (const child of Array.from(this.agents.values())) {
      if (!child.internal || getParentAgentIdFromLabels(child.labels) !== parentAgentId) {
        continue;
      }
      await this.runLifecycleMutation(child.id, async () => {
        const current = this.agents.get(child.id);
        if (!current || getParentAgentIdFromLabels(current.labels) !== parentAgentId) {
          return;
        }
        await this.archiveAgentUnlocked(current.id, parent.archivedAt);
      });
    }
  }

  private async markRecordArchived(
    record: StoredAgentRecord,
    archivedAt = new Date().toISOString(),
  ): Promise<ArchivedStoredAgentRecord> {
    const archivedRecord = await this.persistArchivedRecord(record, {
      archivedAt: record.archivedAt ?? archivedAt,
      updatedAt: archivedAt,
    });

    if (this.agents.has(record.id)) {
      this.notifyAgentState(record.id);
    } else if (!archivedRecord.internal) {
      this.dispatchStoredAgentState(archivedRecord);
    }

    await this.fireAgentArchived(record.id);

    return archivedRecord;
  }

  private async persistArchivedRecord(
    record: StoredAgentRecord,
    options: { archivedAt: string; updatedAt: string },
  ): Promise<ArchivedStoredAgentRecord> {
    const archivedRecord = buildArchivedAgentRecord(record, options);
    await this.requireRegistry().upsert(archivedRecord);
    // A restore and a new archive can reuse the previous timestamp.
    if (record.archivedAt !== archivedRecord.archivedAt)
      this.archivedForkContexts.delete(record.id);
    if (!record.archivedAt && !record.internal) {
      this.pluginLifecycle?.emit("agent.archive.after", {
        agent: describeHookAgent(archivedRecord),
        archivedAt: archivedRecord.archivedAt,
      });
    }
    return archivedRecord;
  }

  private async fireAgentArchived(agentId: string): Promise<void> {
    const callback = this.onAgentArchived;
    if (!callback) {
      return;
    }
    try {
      await callback(agentId);
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "onAgentArchived callback failed");
    }
  }

  private dispatchStoredAgentState(record: StoredAgentRecord): void {
    const updatedAt = new Date(record.updatedAt);
    const attention = extractAttention(record);
    this.dispatch({
      type: "agent_state",
      agent: {
        id: record.id,
        provider: record.provider,
        cwd: record.cwd,
        workspaceId: record.workspaceId,
        owner: record.owner,
        session: null,
        capabilities: STORED_AGENT_CAPABILITIES,
        config: buildStoredAgentConfig(record),
        runtimeInfo: record.runtimeInfo,
        lifecycle: "closed",
        createdAt: new Date(record.createdAt),
        updatedAt,
        availableModes: [],
        controls: record.controls,
        effectiveOptions: this.effectiveOptionsFor(
          record.provider,
          record.config?.providerOptions ?? undefined,
        ),
        currentModeId: record.lastModeId ?? null,
        pendingPermissions: new Map(),
        bufferedPermissionResolutions: new Map(),
        inFlightPermissionResponses: new Set(),
        pendingReplacement: false,
        activeForegroundTurnId: null,
        activeTurnId: null,
        activeTurnStartedAt: null,
        foregroundTurnWaiters: new Set(),
        finalizedForegroundTurnIds: new Set(),
        unsubscribeSession: null,
        persistence: record.persistence ?? null,
        historyPrimed: true,
        lastUserMessageAt: record.lastUserMessageAt ? new Date(record.lastUserMessageAt) : null,
        lastUsage: undefined,
        lastError: record.lastError ?? undefined,
        attention,
        internal: record.internal,
        background: record.background,
        labels: record.labels,
        metadata: record.metadata,
      },
    });
  }

  async switchAgentProvider(
    agentId: string,
    input: SwitchAgentProviderInput,
  ): Promise<{ agent: ManagedAgent; notice: AgentProviderNotice | null }> {
    const source = this.getAgent(agentId) ?? (await this.registry?.get(agentId));
    if (source?.internal) throw new AgentNotFoundError(agentId);
    if (this.registry) {
      await ensureAgentLoaded(agentId, {
        agentManager: this,
        agentStorage: this.registry,
        logger: this.logger,
        purpose: "history",
      });
    }
    return this.trackAgentRegistrationOperation(
      this.runLifecycleMutation(agentId, async () => {
        this.providerSwitches.add(agentId);
        try {
          const agent = this.requireSessionAgent(agentId);
          await this.drainSessionEvents(agentId);
          if (
            agent.lifecycle === "running" ||
            this.hasInFlightRun(agentId) ||
            agent.activeTurnId ||
            this.foregroundMutationTails.has(agentId)
          ) {
            throw new Error(`Agent ${agentId} must be idle before switching providers`);
          }
          await this.hydrateTimelineFromLegacyProviderHistory(agent);
          return await this.switchAgentSession(agent, input);
        } finally {
          this.providerSwitches.delete(agentId);
        }
      }),
    );
  }

  private async switchAgentSession(agent: ActiveManagedAgent, input: SwitchAgentProviderInput) {
    this.assertAcceptingAgentRegistrations();
    const { id, cwd, labels, launchEnv, mainControlSystemPrompt } = agent;
    const record = await this.registry?.get(id);
    const config: AgentSessionConfig = {
      cwd,
      title: record?.title ?? agent.config.title,
      internal: agent.internal,
      provider: input.provider,
      model: input.model ?? undefined,
      modeId: input.modeId ?? undefined,
      thinkingOptionId: input.thinkingOptionId ?? undefined,
      providerOptions: applyProviderOptionsPatch({
        options: undefined,
        patch: input.options ?? {},
      }),
      systemPrompt: agent.config.systemPrompt,
      mcpServers: agent.config.mcpServers,
      toolPolicy: agent.config.toolPolicy,
    };
    const { storedConfig, launchConfig, paseoToolPolicy } = await this.prepareSessionConfig(
      config,
      id,
      { env: launchEnv, labels, mainControlSystemPrompt },
    );
    this.requireEnabledProvider(storedConfig.provider);
    const client = await this.requireAvailableClient({ provider: storedConfig.provider });
    const priorTools = this.attachedPluginTools.get(id);
    const priorGeneration = this.sessionOpenGenerations.get(id);
    const switchId = randomUUID();
    let opened: AgentSession | undefined;
    let previousPrefix: PersistedTimelinePrefix | null = null;
    let handoffCanceled = false;
    let prefixWritten = false;
    let installed = false;
    try {
      const launchContext = await this.buildLaunchContext(
        id,
        client,
        cwd,
        paseoToolPolicy,
        launchEnv,
        {
          ...agent,
          reason: "create",
          purpose: "interactive",
          title: config.title,
        },
      );
      const providerConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);
      const session = await client.createSession(providerConfig, launchContext);
      await this.requireExternalMcpSupport(session, providerConfig, launchContext);
      opened = session;
      const next = this.buildSwitchedAgent(agent, session, storedConfig, providerConfig, client);
      const notice = await this.initializeSwitchedAgent(next, storedConfig);
      this.assertAgentRegistrationActive(agent);

      previousPrefix = await this.timelinePrefixes.load(id);
      // Let the old provider's already submitted events reach the retained timeline.
      await this.drainSessionEvents(id);
      agent.unsubscribeSession?.();
      agent.unsubscribeSession = null;
      this.agentStreamCoalescer.flushAndDiscard(id);
      const cache = this.contextHandoffs.get(id);
      const prefix = this.buildPendingTimelinePrefix(this.timelineStore.getRows(id), cache);
      this.cancelContextHandoff(id);
      handoffCanceled = true;
      // Compaction could have completed while the previous sidecar was being read.
      previousPrefix = cache?.prefix ?? previousPrefix;
      await this.timelinePrefixes.stageSwitch(id, switchId, previousPrefix, prefix);
      prefixWritten = true;
      next.updatedAt = new Date();
      await this.commitSwitchedSession(agent, next, switchId, record?.timelinePrefixSwitchId);
      // The staged file is already readable as committed if this cleanup fails.
      await this.timelinePrefixes.save(id, prefix).catch((err) => {
        this.logger.warn({ err, agentId: id }, "Failed to finalize the timeline prefix");
      });
      this.clearProviderBackgroundWork(id);
      this.cancelRunningProviderSubagents(id);
      this.paseoToolPolicies.set(id, paseoToolPolicy);
      this.promptedMainControlRoleVersions.delete(id);
      this.pendingHierarchySessionReloads.delete(id);
      this.runtimeCleanupIdentities.set(session, Object.freeze({ openedAt: Date.now() }));
      this.timelineStore.sealPrefix(id);
      Object.assign(agent, next);
      installed = true;
      this.refreshIfMainControlChangedWhileOpening(agent, storedConfig);
      this.subscribeToSession(agent);
      this.installContextHandoff(agent, prefix);
      this.emitState(agent, { persist: false });
      return { agent: { ...agent }, notice };
    } catch (error) {
      if (!installed) {
        await this.rollbackProviderSwitch(id, {
          opened,
          prefixWritten,
          previousPrefix,
          priorTools,
          priorGeneration,
        });
        if (handoffCanceled) {
          this.subscribeToSession(agent);
          if (previousPrefix) this.installContextHandoff(agent, previousPrefix);
        }
      }
      throw error;
    }
  }

  private buildSwitchedAgent(
    agent: ActiveManagedAgent,
    session: AgentSession,
    config: AgentSessionConfig,
    launchConfig: AgentSessionConfig,
    client: AgentClient,
  ): ActiveManagedAgent {
    const openedConfig = this.withOpenedOptions({ config, session });
    return {
      ...agent,
      provider: openedConfig.provider,
      providerAdapter: this.adapterOf(openedConfig.provider),
      session,
      config: openedConfig,
      effectiveOptions: this.openedEffectiveOptions({
        session,
        launchedOptions: this.launchOptionsFor({ client, own: launchConfig.providerOptions }),
      }),
      capabilities: session.capabilities,
      persistence: normalizePersistenceForConfig(session.describePersistence(), openedConfig),
      lifecycle: "idle",
      activeForegroundTurnId: null,
      activeTurnId: null,
      activeTurnStartedAt: null,
      pendingReplacement: false,
      pendingPermissions: new Map(),
      bufferedPermissionResolutions: new Map(),
      inFlightPermissionResponses: new Set(),
      unsubscribeSession: null,
      controls: undefined,
      runtimeInfo: undefined,
      currentModeId: null,
      availableModes: [],
      lastError: undefined,
    };
  }

  private async initializeSwitchedAgent(agent: ActiveManagedAgent, config: AgentSessionConfig) {
    let notice: AgentProviderNotice | null = null;
    const { modeId, thinkingOptionId } = config;
    await this.refreshSessionState(agent, { emit: false });
    if (modeId && agent.currentModeId !== modeId) {
      notice = (await agent.session.setMode(modeId)) ?? null;
    }
    if (thinkingOptionId && agent.runtimeInfo?.thinkingOptionId !== thinkingOptionId) {
      const thinkingNotice = await agent.session.setThinkingOption?.(thinkingOptionId);
      notice ??= thinkingNotice ?? null;
    }
    await this.refreshSessionState(agent, { emit: false });
    this.refreshSessionPersistence(agent);
    return notice;
  }

  private async commitSwitchedSession(
    agent: ActiveManagedAgent,
    replacement: ActiveManagedAgent,
    switchId: string,
    priorSwitchId?: string | null,
  ): Promise<void> {
    let persisted = false;
    try {
      // The old provider remains available if committing the new record fails.
      await this.persistSnapshot(replacement, { timelinePrefixSwitchId: switchId });
      persisted = true;
      await agent.session.close();
    } catch (error) {
      if (persisted) {
        await this.persistSnapshot(agent, { timelinePrefixSwitchId: priorSwitchId ?? null });
      }
      throw error;
    }
  }

  private async rollbackProviderSwitch(
    id: string,
    previous: {
      opened?: AgentSession;
      prefixWritten: boolean;
      previousPrefix: PersistedTimelinePrefix | null;
      priorTools?: AttachedAgentTool[];
      priorGeneration?: number;
    },
  ): Promise<void> {
    this.detachPluginTools(id);
    if (previous.priorTools) this.attachedPluginTools.set(id, previous.priorTools);
    if (previous.priorGeneration !== undefined)
      this.sessionOpenGenerations.set(id, previous.priorGeneration);
    if (previous.opened) await this.closeUnregisteredSession(previous.opened);
    if (!previous.prefixWritten) return;
    if (previous.previousPrefix) await this.timelinePrefixes.save(id, previous.previousPrefix);
    else await this.timelinePrefixes.delete(id);
  }

  // Mode, model, thinking and options change inside the agent's lifecycle lane, like every other
  // mutation of one agent. A provider session therefore never has two of `setMode`, `setModel`,
  // `setThinkingOption` and `applyOptions` in flight at once, and none of them overlaps an open,
  // reload or close; providers do no sequencing of their own.

  async setAgentMode(agentId: string, modeId: string): Promise<AgentProviderNotice | null> {
    return this.runLifecycleMutation(agentId, () =>
      this.withLiveInteractiveSessionUnlocked(agentId, async (agent) => {
        if (
          isMainControlAgentLabels(agent.labels) &&
          this.adapterOf(agent.provider) === "codex" &&
          modeId !== "read-only"
        ) {
          throw new Error(MAIN_CONTROL_WRITE_DENIAL);
        }
        const notice = (await agent.session.setMode(modeId)) ?? null;
        await this.drainSessionEvents(agentId);
        const currentMode = (await agent.session.getCurrentMode()) ?? modeId;
        agent.config.modeId = currentMode ?? undefined;
        agent.currentModeId = currentMode;
        // Update runtimeInfo to reflect the new mode
        if (agent.runtimeInfo) {
          agent.runtimeInfo = { ...agent.runtimeInfo, modeId: currentMode };
        }
        this.touchUpdatedAt(agent);
        this.emitState(agent);
        return notice;
      }),
    );
  }

  async setAgentModel(agentId: string, modelId: string | null): Promise<void> {
    return this.runLifecycleMutation(agentId, () =>
      this.withLiveInteractiveSessionUnlocked(agentId, async (agent) => {
        const normalizedModelId =
          typeof modelId === "string" && modelId.trim().length > 0 ? modelId : null;

        const selection = await agent.session.setModel?.(normalizedModelId);
        await this.drainSessionEvents(agentId);

        // A reset clears the preference even when the provider retains its active model.
        let effectiveModelId = normalizedModelId;
        if (normalizedModelId !== null && selection) effectiveModelId = selection.model;

        agent.config.model = effectiveModelId ?? undefined;
        if (agent.runtimeInfo) {
          agent.runtimeInfo = { ...agent.runtimeInfo, model: effectiveModelId };
        }
        this.refreshSessionPersistence(agent);
        this.touchUpdatedAt(agent);
        this.emitState(agent);
      }),
    );
  }

  async setAgentThinkingOption(
    agentId: string,
    thinkingOptionId: string | null,
  ): Promise<AgentProviderNotice | null> {
    return this.runLifecycleMutation(agentId, () =>
      this.withLiveInteractiveSessionUnlocked(agentId, async (agent) => {
        const normalizedThinkingOptionId =
          typeof thinkingOptionId === "string" && thinkingOptionId.trim().length > 0
            ? thinkingOptionId
            : null;

        let notice: AgentProviderNotice | null = null;
        if (agent.session.setThinkingOption) {
          notice = (await agent.session.setThinkingOption(normalizedThinkingOptionId)) ?? null;
        }
        await this.drainSessionEvents(agentId);

        let effectiveThinkingOptionId = normalizedThinkingOptionId;
        const runtimeInfo = await agent.session.getRuntimeInfo();
        if (runtimeInfo.thinkingOptionId !== undefined) {
          effectiveThinkingOptionId = runtimeInfo.thinkingOptionId;
        }

        agent.config.thinkingOptionId = effectiveThinkingOptionId ?? undefined;
        if (agent.runtimeInfo) {
          agent.runtimeInfo = {
            ...agent.runtimeInfo,
            thinkingOptionId: effectiveThinkingOptionId,
          };
        }
        this.touchUpdatedAt(agent);
        this.emitState(agent);
        return notice;
      }),
    );
  }

  /**
   * Applies an options patch to a running agent (see `AgentSession.applyOptions`). The provider
   * gets each key the patch touches, resolved against the `config.json` defaults, with `null`
   * where nothing is set. The patch and whatever the provider says it ended up with are stored in
   * one step once the provider accepts. Patches to one agent run one at a time, in arrival order.
   */
  async setAgentOptions(agentId: string, requested: ProviderOptionsPatch): Promise<void> {
    return this.runLifecycleMutation(agentId, () =>
      this.withLiveInteractiveSessionUnlocked(agentId, async (agent) => {
        const patch = this.convertLegacyOptions(agent.provider, requested);
        if (isMainControlAgentLabels(agent.labels)) {
          const adapter = this.adapterOf(agent.provider);
          if (
            patch.auto_accept === true ||
            (adapter === "codex" && ("sandbox_mode" in patch || "approval_policy" in patch)) ||
            (adapter === "claude" && "disallowedTools" in patch) ||
            (adapter === "opencode" && ("auto_accept" in patch || "permission" in patch))
          ) {
            throw new Error(MAIN_CONTROL_WRITE_DENIAL);
          }
        }
        let ended: ProviderOptionsPatch = {};
        let sent: ProviderOptionsPatch = {};
        if (Object.keys(patch).length > 0) {
          // A provider that cannot apply options to a running agent must not store them either.
          if (!agent.session.applyOptions) {
            throw new ProviderOptionsValidationError(
              agent.provider,
              Object.keys(patch).map((key) => ({
                path: [key],
                message: "cannot change on a running session; it applies when the agent is opened",
              })),
            );
          }
          const set = Object.fromEntries(
            Object.entries(patch).filter(([, value]) => value != null),
          );
          const resolved = this.effectiveOptionsFor(agent.provider, set);
          sent = Object.fromEntries(Object.keys(patch).map((key) => [key, resolved[key] ?? null]));
          const modelBefore = agent.runtimeInfo?.model;
          ended = (await agent.session.applyOptions(sent)) ?? {};
          // Changes the provider made on its own while applying are older than its final answer.
          await this.drainSessionEvents(agentId);
          await this.refreshRuntimeInfo(agent, { emit: false });
          // An option can choose the model too, as an fx connection does. Reopening the agent on
          // the earlier preference would send that model to the new connection.
          const modelAfter = agent.runtimeInfo?.model;
          if (agent.config.model && modelAfter && modelAfter !== modelBefore) {
            agent.config.model = modelAfter;
          }
        }
        this.storeOptionsPatch({ agent, patch: { ...patch, ...ended } });
        this.updateEffectiveOptions({ agent, sent, reported: ended });
        this.touchUpdatedAt(agent);
        this.emitState(agent);
      }),
    );
  }

  /** The config as the opened session left it: its own difference from the options it was given. */
  private withOpenedOptions(input: {
    config: AgentSessionConfig;
    session: AgentSession;
  }): AgentSessionConfig {
    const { config } = input;
    const opened = input.session.openOptionsPatch;
    if (!opened || Object.keys(opened).length === 0) return config;
    const own = applyProviderOptionsPatch({ options: config.providerOptions, patch: opened });
    return { ...config, providerOptions: Object.keys(own).length > 0 ? own : undefined };
  }

  private storeOptionsPatch(input: { agent: ManagedAgent; patch: ProviderOptionsPatch }): void {
    const { agent } = input;
    const own = applyProviderOptionsPatch({
      options: agent.config.providerOptions,
      patch: input.patch,
    });
    agent.config.providerOptions = Object.keys(own).length > 0 ? own : undefined;
  }

  /**
   * What the running session has: the options it opened with, moved only by what an apply sent
   * it (defaults merged in, `null` where a removal left nothing) and by what the provider reports
   * back. The agent's own stored options keep only the raw patch.
   */
  private updateEffectiveOptions(input: {
    agent: ManagedAgent;
    sent: ProviderOptionsPatch;
    reported: ProviderOptionsPatch;
  }): void {
    input.agent.effectiveOptions = applyProviderOptionsPatch({
      options: input.agent.effectiveOptions,
      patch: { ...input.sent, ...input.reported },
    });
  }

  /**
   * Defaults merge into what the session was given; what it reports it ended up with comes
   * after, so an option it dropped does not come back from a default.
   */
  private openedEffectiveOptions(input: {
    session: AgentSession;
    launchedOptions: ProviderOptions;
  }): ProviderOptions {
    return applyProviderOptionsPatch({
      options: input.launchedOptions,
      patch: input.session.openOptionsPatch ?? {},
    });
  }

  /** The options a client opens with: its own defaults merged under the agent's. */
  private launchOptionsFor(input: {
    client: AgentClient;
    own: ProviderOptions | undefined;
  }): ProviderOptions {
    return input.client.effectiveOptions?.(input.own) ?? input.own ?? {};
  }

  /**
   * What an agent of this provider runs with, given its own options: the defaults under them.
   * Stored records are read through here before they are reopened, so the legacy conversion
   * runs here too; a record converted on open passes through unchanged. A legacy value the
   * conversion cannot read stays as stored: this describes the record, and opening or changing
   * the agent is what rejects the value.
   */
  effectiveOptionsFor(provider: AgentProvider, own: ProviderOptions | undefined): ProviderOptions {
    const client = this.clients.get(provider);
    const converted = this.convertStoredOptions(provider, own);
    return client ? this.launchOptionsFor({ client, own: converted }) : (converted ?? {});
  }

  private convertStoredOptions(
    provider: AgentProvider,
    own: ProviderOptions | undefined,
  ): ProviderOptions | undefined {
    try {
      return this.convertLegacyOptions(provider, own);
    } catch (error) {
      if (error instanceof MalformedLegacyOptionError) return own;
      throw error;
    }
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      return;
    }
    if (
      this.agentsAwaitingInitialSnapshotPersist.has(agent.id) &&
      this.registry &&
      (await this.registry.get(agent.id)) === null
    ) {
      return;
    }
    this.touchUpdatedAt(agent);
    await this.persistSnapshot(agent, { title: normalizedTitle });
    this.emitState(agent, { persist: false });
  }

  async setLabels(agentId: string, labels: Record<string, string>): Promise<void> {
    await this.runLifecycleMutation(agentId, async () => {
      const agent = this.requireAgent(agentId);
      await this.writeLabels(agent.id, labels);
    });
  }

  /** Applies a plugin-metadata patch (null removes a key) and returns the stored result. */
  async setMetadata(
    agentId: string,
    patch: Record<string, JsonValue | null>,
  ): Promise<AgentMetadata> {
    return this.runLifecycleMutation(agentId, async () => {
      const liveAgent = this.agents.get(agentId);
      if (liveAgent) {
        liveAgent.metadata = applyRecordPatch<JsonValue>(liveAgent.metadata, patch);
        this.touchUpdatedAt(liveAgent);
        await this.persistSnapshot(liveAgent);
        this.emitState(liveAgent, { persist: false });
        return liveAgent.metadata;
      }
      const record = await this.writeStoredMetadata(agentId, { metadata: patch });
      if (!record.internal) this.dispatchStoredAgentState(record);
      return record.metadata;
    });
  }

  private async writeLabels(agentId: string, patch: AgentLabelPatch): Promise<WriteLabelsResult> {
    const liveAgent = this.agents.get(agentId);
    if (liveAgent) {
      liveAgent.labels = applyRecordPatch(liveAgent.labels, patch);
      this.touchUpdatedAt(liveAgent);
      await this.persistSnapshot(liveAgent);
      this.emitState(liveAgent, { persist: false });
      const record = this.registry ? await this.registry.get(agentId) : null;
      return { record, live: true };
    }

    const nextRecord = await this.writeStoredMetadata(agentId, { labels: patch });
    return { record: nextRecord, live: false };
  }

  private async writeStoredMetadata(
    agentId: string,
    patch: AgentMetadataPatch,
  ): Promise<StoredAgentRecord> {
    const registry = this.requireRegistry();
    const record = await registry.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const nextRecord = {
      ...record,
      ...(patch.title ? { title: patch.title } : {}),
      ...(patch.labels ? { labels: applyRecordPatch(record.labels, patch.labels) } : {}),
      ...(patch.metadata ? { metadata: applyRecordPatch(record.metadata, patch.metadata) } : {}),
      updatedAt: this.nextStoredUpdatedAt(record),
    };
    await registry.upsert(nextRecord);
    return nextRecord;
  }

  async createSilentWorkspaceMainAgent({
    agentId,
    config,
    workspaceId,
    background,
  }: {
    agentId?: string;
    config: AgentSessionConfig & LegacyFeatureValues;
    workspaceId: string;
    background?: boolean;
  }): Promise<StoredAgentRecord> {
    return this.runHierarchyMutation(async () => {
      this.assertAcceptingAgentRegistrations();
      if (!workspaceId.trim()) throw new Error("Main Control requires a workspace.");
      const registry = this.requireRegistry();
      const existing = [...(await this.readHierarchyAgents()).values()].some(
        (agent) => agent.workspaceId === workspaceId && isMainControlAgentLabels(agent.labels),
      );
      if (existing) throw new Error("Workspace already has a Main Control agent.");
      this.requireClient(config.provider);
      const id = validateAgentId(agentId ?? this.idFactory(), "createSilentWorkspaceMainAgent");
      if (this.agents.has(id) || (await registry.get(id))) {
        throw new Error("Agent ID is already in use.");
      }
      const priorMode = config.modeId?.trim();
      const labels = {
        [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE,
        ...(priorMode ? { [MAIN_PRIOR_MODE_ID_LABEL]: priorMode } : {}),
      };
      const modeId = this.resolveMainControlMode({
        enabled: true,
        provider: config.provider,
        currentMode: priorMode,
        priorMode: null,
      });
      // Discover the provider's default model when the first turn opens its session.
      const storedConfig = await this.normalizeConfig(
        stripInternalPaseoMcpServer(foldFeatureValues({ ...config, modeId })),
        { resolveDefaultModel: false },
      );
      const now = new Date().toISOString();
      const record: StoredAgentRecord = {
        id,
        provider: storedConfig.provider,
        cwd: storedConfig.cwd,
        workspaceId,
        title: storedConfig.title?.trim() || "Main Session",
        labels,
        mainControlSystemPrompt: this.mainControlAppendSystemPrompt,
        metadata: {},
        createdAt: now,
        updatedAt: now,
        lastStatus: "closed",
        lastModeId: storedConfig.modeId ?? null,
        config: buildSerializableConfig(storedConfig),
        background,
      };
      await registry.upsert(record);
      this.dispatchStoredAgentState(record);
      return record;
    });
  }

  async setAgentMainControl(
    agentId: string,
    enabled: boolean,
    options?: {
      handoffFromAgentId?: string;
      archiveSource?: boolean;
      assertNoRemoteChildren?: (parentIds: ReadonlySet<string>) => Promise<void>;
      checkReservation?: CheckRemoteChildReservation;
    },
  ): Promise<AgentRelationshipUpdate> {
    const sourceId = options?.handoffFromAgentId;
    if ((sourceId && !enabled) || (options?.archiveSource && !sourceId) || sourceId === agentId) {
      throw new Error(
        "Main Control handoff requires a different source agent and an enabled target.",
      );
    }
    return this.runHierarchyMutation(() =>
      this.runLifecycleMutation(agentId, async () => {
        const registry = this.requireRegistry();
        const hierarchy = await this.readHierarchyAgents();
        const agent = hierarchy.get(agentId);
        const targetRecord = await registry.get(agentId);
        if (!agent || !targetRecord || agent.archivedAt || targetRecord.archivedAt) {
          throw new Error("Agent is missing or archived.");
        }
        const workspaceId = agent.workspaceId ?? targetRecord.workspaceId;
        if (enabled) {
          if (
            !workspaceId ||
            getParentAgentIdFromLabels(agent.labels) ||
            getParentAgentIdFromLabels(targetRecord.labels)
          ) {
            throw new Error("Only a workspace root agent can be Main Control.");
          }
        }
        const previousMainIds = enabled
          ? [...hierarchy.values()]
              .filter(
                (other) =>
                  other.id !== agentId &&
                  other.workspaceId === workspaceId &&
                  isMainControlAgentLabels(other.labels),
              )
              .map((other) => other.id)
          : [];
        const roleChange = { targetRecord, enabled, workspaceId, previousMainIds };
        const roleLanes = new Set(previousMainIds);
        if (!sourceId) {
          return this.withHierarchyLifecycleLanes([...roleLanes], () =>
            this.changeMainControlRoles(roleChange),
          );
        }
        await this.assertMainControlHandoffSource(hierarchy.get(sourceId), sourceId, workspaceId);
        const sourceIds = new Set([sourceId]);
        await this.assertNoRemoteChildReservations(sourceIds, options?.checkReservation);
        await options?.assertNoRemoteChildren?.(sourceIds);
        roleLanes.add(sourceId);
        const children = [...hierarchy.values()].filter(
          (child) =>
            child.workspaceId === workspaceId &&
            this.localHierarchyParentId(child.labels) === sourceId,
        );
        return this.withHierarchyLifecycleLanes(
          [...roleLanes, ...children.map(({ id }) => id)],
          () =>
            this.commitMainControlHandoff(roleChange, sourceId, children, options?.archiveSource),
        );
      }),
    );
  }

  private async assertMainControlHandoffSource(
    source: WorkspaceHierarchyAgent | undefined,
    sourceId: string,
    workspaceId: string | undefined,
  ): Promise<void> {
    const stored = await this.requireRegistry().get(sourceId);
    if (stored?.archivedAt) throw new Error("Main Control handoff source is archived.");
    if (
      !source ||
      !stored ||
      source.workspaceId !== workspaceId ||
      getParentAgentIdFromLabels(source.labels)
    ) {
      throw new Error("Main Control handoff requires a source root in the same workspace.");
    }
  }

  private async commitMainControlHandoff(
    roleChange: MainControlRoleChange,
    sourceId: string,
    children: readonly WorkspaceHierarchyAgent[],
    archiveSource?: boolean,
  ): Promise<AgentRelationshipUpdate> {
    const changed: WorkspaceHierarchyAgent[] = [];
    let canRestore = true;
    try {
      return await this.changeMainControlRoles({
        ...roleChange,
        handoff: {
          archiveSourceId: archiveSource ? sourceId : undefined,
          canRestore: () => canRestore,
          commit: async (result) => {
            for (const child of children) {
              changed.push(child);
              await this.commitAgentParent(
                child.id,
                child.labels,
                {
                  [PARENT_AGENT_ID_LABEL]: roleChange.targetRecord.id,
                  [PARENT_SERVER_ID_LABEL]: this.serverId ?? null,
                  [REMOTE_HIERARCHY_DEPTH_LABEL]: null,
                },
                undefined,
              );
            }
            if (!archiveSource) return;
            // Never restore children to an archived source, even if its provider cleanup fails.
            canRestore = false;
            try {
              await this.archiveSnapshotUnlocked(sourceId, new Date().toISOString());
              result.archivedSource = true;
            } catch (error) {
              const archivedRecord = await this.requireRegistry()
                .get(sourceId)
                .catch((readError) => {
                  throw new Error(
                    `Archive failed: ${getErrorMessage(error)}. Could not confirm source ${sourceId}: ${getErrorMessage(readError)}`,
                    { cause: error },
                  );
                });
              canRestore = Boolean(archivedRecord && !archivedRecord.archivedAt);
              if (archivedRecord?.archivedAt) {
                throw new Error(
                  `Main Control handoff committed, but archive cleanup failed for ${sourceId}: ${getErrorMessage(error)}`,
                  { cause: error },
                );
              }
              throw error;
            }
          },
        },
      });
    } catch (error) {
      const restoreFailures: string[] = [];
      if (canRestore) {
        for (const child of changed.toReversed()) {
          const currentLabels = this.agents.get(child.id)?.labels;
          try {
            await this.commitAgentParent(
              child.id,
              currentLabels,
              {
                [PARENT_AGENT_ID_LABEL]: sourceId,
                [PARENT_SERVER_ID_LABEL]: child.labels?.[PARENT_SERVER_ID_LABEL] ?? null,
                [REMOTE_HIERARCHY_DEPTH_LABEL]:
                  child.labels?.[REMOTE_HIERARCHY_DEPTH_LABEL] ?? null,
              },
              undefined,
            );
          } catch (restoreError) {
            restoreFailures.push(`parent of ${child.id}: ${getErrorMessage(restoreError)}`);
          }
        }
      }
      if (restoreFailures.length) {
        throw new Error(
          `${getErrorMessage(error)}. Failed to restore ${restoreFailures.join(", ")}`,
          {
            cause: error,
          },
        );
      }
      throw error;
    } finally {
      await this.publishHandoffChildren(changed).catch((error) =>
        this.logger.warn(
          { err: error, sourceId },
          "Failed to publish Main Control handoff children",
        ),
      );
    }
  }

  private async publishHandoffChildren(
    children: readonly WorkspaceHierarchyAgent[],
  ): Promise<void> {
    if (!children.length) return;
    const hierarchy = await this.readHierarchyAgents();
    this.refreshHierarchyToolPolicies(hierarchy);
    for (const { id } of children) {
      const live = this.agents.get(id);
      if (live) this.markHierarchySessionForRefresh(live);
      else {
        const record = await this.requireRegistry().get(id);
        if (record) this.dispatchStoredAgentState(record);
      }
    }
  }

  private withHierarchyLifecycleLanes<T>(
    ids: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const lock = (index: number): Promise<T> => {
      const id = ids[index];
      return id ? this.runLifecycleMutation(id, () => lock(index + 1)) : operation();
    };
    return lock(0);
  }

  private async changeMainControlRoles({
    targetRecord,
    enabled,
    workspaceId,
    previousMainIds,
    handoff,
  }: MainControlRoleChange & {
    handoff?: {
      archiveSourceId?: string;
      canRestore: () => boolean;
      commit: (result: AgentRelationshipUpdate) => Promise<void>;
    };
  }): Promise<AgentRelationshipUpdate> {
    const registry = this.requireRegistry();
    const agentId = targetRecord.id;
    const previousMains = (await Promise.all(previousMainIds.map((id) => registry.get(id)))).filter(
      (record): record is StoredAgentRecord =>
        Boolean(
          record &&
          !record.archivedAt &&
          record.workspaceId === workspaceId &&
          isMainControlAgentLabels(record.labels),
        ),
    );
    const targetChanges = isMainControlAgentLabels(targetRecord.labels) !== enabled;
    const changingIds = previousMains.map((record) => record.id);
    if (targetChanges) changingIds.push(agentId);
    if (handoff?.archiveSourceId && !changingIds.includes(handoff.archiveSourceId)) {
      changingIds.push(handoff.archiveSourceId);
    }
    for (const id of changingIds) this.assertMainControlAgentIdle(id);
    // Run admission is synchronous. Reserve every changed agent before the first await so
    // a prompt arriving during the reload waits in the existing lifecycle lane.
    for (const id of changingIds) {
      this.hierarchySessionUpdates.add(id);
      this.mainControlRoleUpdates.add(id);
    }
    const demoted: StoredAgentRecord[] = [];
    let attemptedTargetChange = false;
    try {
      for (const previousMain of previousMains) {
        demoted.push(previousMain);
        await this.writeMainControlRole(previousMain.id, false);
      }
      attemptedTargetChange = targetChanges;
      const result = await this.writeMainControlRole(agentId, enabled);
      await handoff?.commit(result);
      return result;
    } catch (error) {
      if (handoff && !handoff.canRestore()) throw error;
      const restoreFailures: string[] = [];
      if (attemptedTargetChange) {
        await this.writeMainControlRole(agentId, !enabled, targetRecord).catch((restoreError) => {
          restoreFailures.push(`role of ${agentId}: ${getErrorMessage(restoreError)}`);
        });
      }
      for (const previousMain of demoted.toReversed()) {
        await this.writeMainControlRole(previousMain.id, true, previousMain).catch(
          (restoreError) => {
            restoreFailures.push(`role of ${previousMain.id}: ${getErrorMessage(restoreError)}`);
          },
        );
      }
      if (restoreFailures.length) {
        throw new Error(
          `${getErrorMessage(error)}. Failed to restore ${restoreFailures.join(", ")}`,
          {
            cause: error,
          },
        );
      }
      throw error;
    } finally {
      this.invalidateMainControlChildren(changingIds);
      for (const id of changingIds) {
        this.mainControlRoleUpdates.delete(id);
        this.hierarchySessionUpdates.delete(id);
      }
    }
  }

  private invalidateMainControlChildren(changingIds: readonly string[]): void {
    if (!changingIds.length) return;
    // Also invalidate an opening session that already read the old hierarchy and
    // won't be in the live map until its provider has finished opening.
    for (const id of changingIds) {
      this.mainControlRoleVersions.set(id, (this.mainControlRoleVersions.get(id) ?? 0) + 1);
      this.promptedMainControlRoleVersions.delete(id);
    }
    for (const child of this.agents.values()) {
      const parentId = this.localHierarchyParentId(child.labels);
      if (parentId && this.mainControlRoleUpdates.has(parentId)) {
        this.markHierarchySessionForRefresh(child);
      }
    }
  }

  private assertMainControlAgentIdle(agentId: string): void {
    const live = this.agents.get(agentId);
    if (
      this.hasInFlightRun(agentId) ||
      live?.activeTurnId ||
      live?.lifecycle === "initializing" ||
      (this.backgroundWork.summary(agentId)?.count ?? 0) > 0
    ) {
      throw new Error("Wait for active work to finish before changing Main Control.");
    }
  }

  private async writeMainControlRole(
    agentId: string,
    enabled: boolean,
    restore?: Pick<StoredAgentRecord, "mainControlSystemPrompt">,
  ): Promise<AgentRelationshipUpdate> {
    const registry = this.requireRegistry();
    const record = await registry.get(agentId);
    if (!record || record.archivedAt) throw new Error("Agent is missing or archived.");
    const current = this.agents.get(agentId);
    if (isMainControlAgentLabels(record.labels) === enabled) {
      return { record, live: Boolean(current) };
    }

    const currentMode = current?.currentModeId ?? record.lastModeId ?? record.config?.modeId;
    const priorMode = getMainPriorModeIdFromLabels(record.labels);
    const labels = applyRecordPatch(current?.labels ?? record.labels, {
      [WORKSPACE_ROLE_LABEL]: enabled ? WORKSPACE_MAIN_ROLE : null,
      [MAIN_PRIOR_MODE_ID_LABEL]: enabled ? currentMode?.trim() || null : null,
    });
    const modeId = this.resolveMainControlMode({
      enabled,
      provider: record.provider,
      currentMode,
      priorMode,
    });
    let mainControlSystemPrompt: string | undefined;
    if (enabled) {
      // A rollback must restore the missing field on pre-snapshot records too.
      mainControlSystemPrompt = restore
        ? restore.mainControlSystemPrompt
        : this.mainControlAppendSystemPrompt;
    }
    if (current) {
      return this.applyLiveMainControlRole(current, {
        labels,
        modeId,
        enabled,
        mainControlSystemPrompt,
      });
    }

    const next: StoredAgentRecord = {
      ...record,
      labels,
      mainControlSystemPrompt,
      config: { ...record.config, modeId },
      lastModeId: modeId ?? null,
      runtimeInfo: record.runtimeInfo
        ? { ...record.runtimeInfo, modeId: modeId ?? null }
        : undefined,
      updatedAt: this.nextStoredUpdatedAt(record),
    };
    await registry.upsert(next);
    this.paseoToolPolicies.delete(agentId);
    this.dispatchStoredAgentState(next);
    return { record: next, live: false };
  }

  private resolveMainControlMode({
    enabled,
    provider,
    currentMode,
    priorMode,
  }: {
    enabled: boolean;
    provider: AgentProvider;
    currentMode: string | null | undefined;
    priorMode: string | null;
  }): string | undefined {
    if (this.adapterOf(provider) === "codex") {
      return enabled ? "read-only" : (priorMode ?? undefined);
    }
    if (!enabled && priorMode) return priorMode;
    return currentMode ?? undefined;
  }

  private applyLiveMainControlRole(
    current: ActiveManagedAgent,
    role: MainControlRoleUpdate,
  ): Promise<AgentRelationshipUpdate> {
    const shouldReload =
      Boolean(current.persistence && current.capabilities.supportsSessionPersistence) &&
      HIERARCHY_SYSTEM_PROMPT_ADAPTERS.has(this.adapterOf(current.provider));
    return shouldReload
      ? this.reloadWithMainControlRole(current.id, role)
      : this.updateLiveMainControlRole(current, role);
  }

  private async updateLiveMainControlRole(
    current: ActiveManagedAgent,
    { labels, modeId, enabled, mainControlSystemPrompt }: MainControlRoleUpdate,
  ): Promise<AgentRelationshipUpdate> {
    const agentId = current.id;
    const previousLabels = current.labels;
    const previousMainControlSystemPrompt = current.mainControlSystemPrompt;
    const previousConfig = current.config;
    const previousModeId = current.currentModeId;
    const previousRuntimeInfo = current.runtimeInfo;
    const previousUpdatedAt = current.updatedAt;
    const hadPreviousPolicy = this.paseoToolPolicies.has(agentId);
    const previousPolicy = this.paseoToolPolicies.get(agentId);
    const wasInPlaceSession = this.inPlaceMainControlSessions.has(current.session);

    current.labels = labels;
    current.mainControlSystemPrompt = mainControlSystemPrompt;
    current.config = { ...current.config, modeId };
    current.currentModeId = modeId ?? null;
    if (current.runtimeInfo) {
      current.runtimeInfo = { ...current.runtimeInfo, modeId: current.currentModeId };
    }
    this.touchUpdatedAt(current);
    const policy = resolveAgentPaseoToolPolicy(
      this.basePaseoToolPolicy(current.provider),
      current,
      0,
    );
    if (policy === undefined) this.paseoToolPolicies.delete(agentId);
    else this.paseoToolPolicies.set(agentId, policy);
    if (enabled && HIERARCHY_SYSTEM_PROMPT_ADAPTERS.has(this.adapterOf(current.provider))) {
      this.inPlaceMainControlSessions.add(current.session);
    } else {
      this.inPlaceMainControlSessions.delete(current.session);
    }

    try {
      await this.persistSnapshot(current);
    } catch (error) {
      current.labels = previousLabels;
      current.mainControlSystemPrompt = previousMainControlSystemPrompt;
      current.config = previousConfig;
      current.currentModeId = previousModeId;
      current.runtimeInfo = previousRuntimeInfo;
      current.updatedAt = previousUpdatedAt;
      if (hadPreviousPolicy) this.paseoToolPolicies.set(agentId, previousPolicy);
      else this.paseoToolPolicies.delete(agentId);
      if (wasInPlaceSession) this.inPlaceMainControlSessions.add(current.session);
      else this.inPlaceMainControlSessions.delete(current.session);
      throw error;
    }

    if (enabled && current.effectiveOptions?.auto_accept === true) {
      await current.session.applyOptions?.({ auto_accept: false }).catch(() => undefined);
      current.effectiveOptions = { ...current.effectiveOptions, auto_accept: false };
    } else if (!enabled) {
      const restoredEffective = this.effectiveOptionsFor(
        current.provider,
        current.config.providerOptions,
      );
      if (
        "auto_accept" in restoredEffective &&
        restoredEffective.auto_accept !== current.effectiveOptions?.auto_accept
      ) {
        await current.session
          .applyOptions?.({ auto_accept: restoredEffective.auto_accept })
          .catch(() => undefined);
        current.effectiveOptions = restoredEffective;
      }
    }

    this.emitState(current);
    const record = await this.requireRegistry().get(agentId);
    if (!record) throw new Error(`Agent not found after updating Main Control: ${agentId}`);
    return { record, live: true };
  }

  private async reloadWithMainControlRole(
    agentId: string,
    role: MainControlRoleUpdate,
  ): Promise<AgentRelationshipUpdate> {
    try {
      await this.trackAgentRegistrationOperation(
        this.reloadAgentSessionInternal(
          agentId,
          { modeId: role.modeId },
          { mainControlRole: role },
        ),
      );
    } catch (error) {
      const committed = await this.requireRegistry().get(agentId);
      if (
        this.agents.has(agentId) ||
        !committed ||
        isMainControlAgentLabels(committed.labels) !== role.enabled
      ) {
        throw error;
      }
      this.logger.warn({ err: error, agentId }, "Agent will reopen with its new role on demand");
      return { record: committed, live: false };
    }
    const record = await this.requireRegistry().get(agentId);
    if (!record) throw new Error(`Agent not found after updating Main Control: ${agentId}`);
    return { record, live: true };
  }

  async setAgentParent(
    agentId: string,
    parentAgentId: string,
    serverId?: string,
    prepareFinishSubscription?: () => Promise<FinishRegistration>,
    assertRemoteDepthCanChange?: (localAgentIds: ReadonlySet<string>) => Promise<void>,
    checkReservation?: CheckRemoteChildReservation,
  ): Promise<AgentParentUpdate> {
    return this.runHierarchyMutation(() =>
      this.runLifecycleMutation(agentId, async () => {
        const hierarchy = await this.readHierarchyAgents();
        const agent = hierarchy.get(agentId);
        const parentAgent = hierarchy.get(parentAgentId);
        if (!agent || !parentAgent) throw new Error("Agent or parent is missing or archived.");
        if (!agent.workspaceId || agent.workspaceId !== parentAgent.workspaceId) {
          throw new Error("An agent and its new parent must belong to the same workspace.");
        }
        validateSetAgentParent({
          agent,
          parentAgent,
          readAgent: (id) => hierarchy.get(id),
          listActiveAgents: () => hierarchy.values(),
          serverId,
        });
        const read = (id: string) => hierarchy.get(id);
        if (
          computeAgentDepth(parentAgentId, read, serverId) + 1 !==
          computeAgentDepth(agentId, read, serverId)
        ) {
          const branch = readLocalSubtreeDepths(agentId, hierarchy.values(), serverId);
          const parentIds = new Set(branch.keys());
          await this.assertNoRemoteChildReservations(parentIds, checkReservation);
          await assertRemoteDepthCanChange?.(parentIds);
        }
        const previousParentAgentId = getParentAgentIdFromLabels(agent.labels);
        const wasRunning = this.agents.get(agentId)?.lifecycle === "running";
        const registration =
          !isExplicitParentReportingLabels(agent.labels) &&
          (wasRunning || this.hasInFlightRun(agentId))
            ? await prepareFinishSubscription?.()
            : undefined;
        const { record, live } = await this.commitAgentParent(
          agentId,
          agent.labels,
          {
            [PARENT_AGENT_ID_LABEL]: parentAgentId,
            [PARENT_SERVER_ID_LABEL]: serverId ?? null,
            [REMOTE_HIERARCHY_DEPTH_LABEL]: null,
          },
          registration,
        );
        if (!live) {
          this.paseoToolPolicies.delete(agentId);
          if (!record.internal) this.dispatchStoredAgentState(record);
        }
        hierarchy.set(agentId, { ...agent, labels: record.labels });
        this.refreshHierarchyToolPolicies(hierarchy);
        if (live) await this.refreshHierarchySessionUnlocked(agentId);
        return { record, live, previousParentAgentId, wasRunning };
      }),
    );
  }

  private async commitAgentParent(
    agentId: string,
    previousLabels: Record<string, string> | undefined,
    patch: AgentLabelPatch,
    registration: FinishRegistration | undefined,
  ): Promise<AgentRelationshipUpdate> {
    let result: WriteLabelsResult;
    try {
      result = await this.writeLabels(agentId, patch);
      if (!result.record) throw new Error("Agent not found after changing parent: " + agentId);
    } catch (error) {
      // writeLabels updates the live labels before persisting them.
      const liveAgent = this.agents.get(agentId);
      if (liveAgent) {
        const restore = Object.fromEntries(
          Object.keys(patch).map((key) => [key, previousLabels?.[key] ?? null]),
        );
        liveAgent.labels = applyRecordPatch(liveAgent.labels, restore);
      }
      await registration?.reject().catch((cleanupError) => {
        this.logger.warn(
          { err: cleanupError, agentId },
          "Failed to remove rejected parent subscription",
        );
      });
      throw error;
    }
    registration?.accept();
    return { record: result.record, live: result.live };
  }

  private runHierarchyMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.hierarchyMutationTail.then(mutation);
    this.hierarchyMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  reserveRemoteChild(parentId: string, destination: string, idempotencyKey?: string) {
    return this.runHierarchyMutation(async () => {
      const hierarchy = await this.readHierarchyAgents();
      const parent = hierarchy.get(parentId);
      if (!parent || this.pendingHierarchyArchives.has(parentId)) {
        throw new Error(`Parent agent ${parentId} is missing or archived.`);
      }
      if (this.pendingSubagentMoveSnapshots.has(parentId)) {
        throw new Error("Recover the parent's workspace move before creating a subagent.");
      }
      const read = (id: string) => hierarchy.get(id);
      validateCanSpawnChild(parent, read);
      const reservationId = idempotencyKey
        ? createHash("sha256")
            .update(JSON.stringify([this.serverId, parentId, destination, idempotencyKey]))
            .digest("hex")
        : randomUUID();
      const previous = this.remoteChildReservations.get(reservationId);
      if (previous && !previous.uncertain) throw new Error("Remote child creation is in progress.");
      const reservation = { parentId, destination, uncertain: false };
      this.remoteChildReservations.set(reservationId, reservation);
      return {
        id: reservationId,
        depth: computeAgentDepth(parentId, read) + 1,
        finish: (outcome: "confirmed" | "rejected" | "unknown") => {
          if (outcome === "unknown" || (outcome === "rejected" && previous?.uncertain)) {
            reservation.uncertain = true;
          } else {
            this.remoteChildReservations.delete(reservationId);
          }
        },
      };
    });
  }

  private async assertNoRemoteChildReservations(
    parentIds: ReadonlySet<string>,
    check?: CheckRemoteChildReservation,
  ): Promise<void> {
    for (const [id, reservation] of this.remoteChildReservations) {
      if (!parentIds.has(reservation.parentId)) continue;
      if (reservation.uncertain && (await check?.(reservation.destination, id))) {
        this.remoteChildReservations.delete(id);
        continue;
      }
      throw new Error("A remote subagent creation is in progress or its outcome is unknown.");
    }
  }

  async detachAgent(
    agentId: string,
    assertRemoteDepthCanChange?: (localAgentIds: ReadonlySet<string>) => Promise<void>,
    checkReservation?: CheckRemoteChildReservation,
  ): Promise<{
    record: StoredAgentRecord;
    live: boolean;
    previousParentAgentId: string | null;
  }> {
    return this.runHierarchyMutation(() =>
      this.runLifecycleMutation(agentId, async () => {
        const hierarchy = await this.readHierarchyAgents();
        if (getParentAgentIdFromLabels(hierarchy.get(agentId)?.labels)) {
          const branch = readLocalSubtreeDepths(agentId, hierarchy.values(), this.serverId);
          const parentIds = new Set(branch.keys());
          await this.assertNoRemoteChildReservations(parentIds, checkReservation);
          await assertRemoteDepthCanChange?.(parentIds);
        }
        return this.detachAgentUnlocked(agentId);
      }),
    );
  }

  private async detachAgentUnlocked(agentId: string): Promise<{
    record: StoredAgentRecord;
    live: boolean;
    previousParentAgentId: string | null;
  }> {
    const registry = this.requireRegistry();
    const liveAgent = this.agents.get(agentId);
    if (liveAgent) {
      const previousParentAgentId = getParentAgentIdFromLabels(liveAgent.labels);
      if (!previousParentAgentId) {
        await this.persistSnapshot(liveAgent);
        const record = await registry.get(agentId);
        if (!record) {
          throw new Error(`Agent not found in storage after detach: ${agentId}`);
        }
        return { record, live: true, previousParentAgentId: null };
      }

      const { record } = await this.writeLabels(agentId, detachedAgentLabelPatch(liveAgent.labels));
      if (!record) {
        throw new Error(`Agent not found in storage after detach: ${agentId}`);
      }
      if (this.agents.size > 0) this.refreshHierarchyToolPolicies(await this.readHierarchyAgents());
      await this.refreshHierarchySessionUnlocked(agentId);
      return { record, live: true, previousParentAgentId };
    }

    const record = await registry.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const previousParentAgentId = getParentAgentIdFromLabels(record.labels);
    if (!previousParentAgentId) {
      return { record, live: false, previousParentAgentId: null };
    }

    const result = await this.writeLabels(agentId, detachedAgentLabelPatch(record.labels));
    if (!result.record) {
      throw new Error(`Agent not found in storage after detach: ${agentId}`);
    }
    this.paseoToolPolicies.delete(agentId);
    if (this.agents.size > 0) this.refreshHierarchyToolPolicies(await this.readHierarchyAgents());
    return { record: result.record, live: false, previousParentAgentId };
  }

  async moveSubagentToWorkspace(
    agentId: string,
    options: MoveSubagentToWorkspaceOptions,
  ): Promise<MoveSubagentToWorkspaceResult> {
    return this.runHierarchyMutation(async () => {
      const trimmedKey = options.idempotencyKey?.trim();
      const receiptKey = trimmedKey ? JSON.stringify([agentId, trimmedKey]) : null;
      if (receiptKey) {
        const receipt = this.moveToWorkspaceReceipts.get(receiptKey);
        if (receipt) return { ...receipt, replayed: true };
        const workspaceId = await options.durable?.journal.findReceipt(receiptKey);
        if (workspaceId) return { workspaceId, replayed: true };
      }
      await this.recoverPendingWorkspaceMoveUnlocked();
      return this.runLifecycleMutation(agentId, () =>
        this.moveSubagentToWorkspaceUnlocked(
          agentId,
          options,
          options.serverId ?? "self",
          receiptKey,
        ),
      );
    });
  }

  recoverPendingWorkspaceMove(): Promise<void> {
    return this.runHierarchyMutation(() => this.recoverPendingWorkspaceMoveUnlocked());
  }

  private async recoverPendingWorkspaceMoveUnlocked(): Promise<void> {
    const pending = this.pendingWorkspaceMoveRecovery;
    if (!pending) return;
    await pending.retry();
    this.pendingWorkspaceMoveRecovery = undefined;
    pending.release();
  }

  getStoredWorkspaceMoveSnapshots(): ReadonlyMap<string, StoredAgentRecord> {
    return new Map(this.pendingStoredMoveSnapshots);
  }

  private async moveSubagentToWorkspaceUnlocked(
    agentId: string,
    options: MoveSubagentToWorkspaceOptions,
    serverId: string,
    receiptKey: string | null,
  ): Promise<MoveSubagentToWorkspaceResult> {
    const durable = options.durable;

    const registry = this.requireRegistry();
    const liveAgent = this.agents.get(agentId);
    const storedRecord = await registry.get(agentId);
    const source = describeSubagentMoveSource(agentId, liveAgent, storedRecord, serverId);
    const { sourceWorkspaceId, previousParentAgentId } = source;
    if (
      options.expectedWorkspaceId !== undefined &&
      sourceWorkspaceId !== options.expectedWorkspaceId
    ) {
      throw new Error(`Agent ${agentId} is no longer in workspace ${options.expectedWorkspaceId}`);
    }
    const descendantIds = await this.findSameWorkspaceDescendantIds(
      registry,
      agentId,
      sourceWorkspaceId,
      serverId,
    );
    const lockedIds = new Set(descendantIds);
    // Match the archive cascade's lock order. Re-read the full path to the root
    // after acquiring the lanes, since detach can run while they are queued.
    const withDescendantLanes = <T>(index: number, operation: () => Promise<T>): Promise<T> =>
      index === descendantIds.length
        ? operation()
        : this.runLifecycleMutation(descendantIds[index]!, () =>
            withDescendantLanes(index + 1, operation),
          );
    const liveMoves: {
      agent: LiveManagedAgent;
      labels: Record<string, string>;
      updatedAt: Date;
    }[] = [];
    const result = await withDescendantLanes(0, async () => {
      const currentIds = await this.findSameWorkspaceDescendantIds(
        registry,
        agentId,
        sourceWorkspaceId,
        serverId,
      );
      if (currentIds.some((id) => !lockedIds.has(id))) {
        throw new Error("Workspace agents changed while preparing the move. Retry the move.");
      }

      const members = await Promise.all(
        [agentId, ...currentIds].map(async (id) => ({
          id,
          live: this.agents.get(id),
          stored: await registry.get(id),
        })),
      );
      await assertMoveSharesWorktree(
        source.cwd,
        members.map(({ live, stored }) => (live ?? stored)?.cwd),
        options.getWorktreeRoot,
      );
      const before = members.flatMap(({ stored }) => (stored ? [stored] : []));
      const rollbackRecords: StoredAgentRecord[] = [];
      const storedUpdates: StoredAgentRecord[] = [];
      let releaseSnapshots!: () => void;
      const snapshotsReleased = new Promise<void>((release) => {
        releaseSnapshots = release;
      });
      for (const { id, stored } of members) {
        this.pendingSubagentMoveSnapshots.set(id, snapshotsReleased);
        if (stored) this.pendingStoredMoveSnapshots.set(id, stored);
      }
      const releaseProtection = () => {
        for (const { id } of members) {
          this.pendingSubagentMoveSnapshots.delete(id);
          this.pendingStoredMoveSnapshots.delete(id);
        }
        releaseSnapshots();
      };
      const applyLiveMoves = (workspaceId: string) => {
        for (const { agent, labels, updatedAt } of liveMoves) {
          agent.workspaceId = workspaceId;
          agent.labels = labels;
          if (agent.updatedAt < updatedAt) agent.updatedAt = updatedAt;
        }
      };

      const persistMember = async (
        { id, live, stored }: (typeof members)[number],
        workspaceId: string,
      ): Promise<StoredAgentRecord | undefined> => {
        if (!stored && !live?.internal) throw new Error(`Agent not found in storage: ${id}`);
        const previousLabels = live?.labels ?? stored!.labels;
        let patch: AgentLabelPatch = {};
        if (id === agentId) patch = detachedAgentLabelPatch(previousLabels);
        else if (!live?.internal) patch = clearOpenAgentTabLabelPatch(previousLabels);
        const labels = applyRecordPatch(previousLabels, patch);
        if (live) {
          const snapshot = { ...live, workspaceId, labels };
          const updatedAt = this.touchUpdatedAt(snapshot);
          liveMoves.push({ agent: live, labels, updatedAt });
          if (live.internal) return;
          rollbackRecords.push(stored!);
          await registry.applySnapshot(snapshot);
        } else {
          rollbackRecords.push(stored!);
          await registry.upsert({
            ...stored!,
            workspaceId,
            labels,
            updatedAt: this.nextStoredUpdatedAt(stored!),
          });
        }
        const moved = await registry.get(id);
        if (moved?.workspaceId !== workspaceId) {
          throw new Error(`Agent move was not persisted: ${id}`);
        }
        if (!live) storedUpdates.push(moved);
        return moved;
      };

      let prepared = false;
      let allocation: MoveSubagentToWorkspaceAllocation | undefined;
      const rollback = async () => {
        if (durable) {
          if (prepared) {
            const published = await durable.journal.isPublished(durable.workspaceId);
            await durable.journal.recover(registry);
            if (published) applyLiveMoves(durable.workspaceId);
          }
          return;
        }
        for (const stored of rollbackRecords.toReversed()) {
          await registry.upsert(stored);
          if ((await registry.get(stored.id))?.workspaceId !== stored.workspaceId) {
            throw new Error(`Workspace move recovery did not restore agent ${stored.id}`);
          }
        }
        await allocation?.rollback?.();
      };

      let needsRecovery = false;
      try {
        let workspaceId: string;
        if (options.durable) {
          workspaceId = options.durable.workspaceId;
        } else {
          allocation = await options.allocateWorkspace(source);
          workspaceId = allocation.workspaceId.trim();
        }
        if (!workspaceId || workspaceId === sourceWorkspaceId) {
          throw new Error(`Move requires a different workspace: ${agentId}`);
        }

        let record: StoredAgentRecord | undefined;
        const persistMembers = async () => {
          for (const member of members) {
            const moved = await persistMember(member, workspaceId);
            if (member.id === agentId) record = moved;
          }
          if (!record) throw new Error(`Agent move was not persisted: ${agentId}`);
        };
        if (durable) {
          await durable.journal.prepare(
            {
              workspaceId,
              sourceWorkspaceId,
              members: before.map(({ id, labels, updatedAt }) => ({ id, labels, updatedAt })),
            },
            receiptKey,
          );
          prepared = true;
          try {
            await durable.publishWorkspace(source, persistMembers);
          } catch (error) {
            if (!(await durable.journal.isPublished(workspaceId))) throw error;
          }
          await durable.journal.commit(workspaceId).catch((error) => {
            this.logger.warn(
              { err: error, agentId, workspaceId },
              "Failed to finalize move receipt",
            );
          });
        } else {
          await persistMembers();
        }
        applyLiveMoves(workspaceId);
        return {
          record: record!,
          live: Boolean(liveAgent),
          sourceWorkspaceId,
          workspaceId,
          previousParentAgentId,
          storedUpdates,
        };
      } catch (error) {
        try {
          await rollback();
        } catch (rollbackError) {
          needsRecovery = true;
          const releaseWorkspace = durable?.retainWorkspaceProtection?.();
          this.pendingWorkspaceMoveRecovery = {
            retry: rollback,
            release: () => {
              releaseProtection();
              releaseWorkspace?.();
            },
          };
          this.logger.error(
            { err: rollbackError, moveError: error, agentId },
            "Workspace move requires recovery",
          );
          throw new Error("Workspace move requires recovery", {
            cause: rollbackError,
          });
        }
        throw error;
      } finally {
        if (!needsRecovery) releaseProtection();
      }
    });

    const { storedUpdates, ...moved } = result;
    const committed: CommittedWorkspaceMove = {
      ...moved,
      ...(storedUpdates.some((record) => record.id !== agentId)
        ? { movedDescendantStoredRecords: storedUpdates.filter((record) => record.id !== agentId) }
        : {}),
    };
    if (receiptKey && !durable) {
      if (this.moveToWorkspaceReceipts.size >= 256) {
        const oldest = this.moveToWorkspaceReceipts.keys().next();
        if (!oldest.done) this.moveToWorkspaceReceipts.delete(oldest.value);
      }
      this.moveToWorkspaceReceipts.set(receiptKey, committed);
    }
    try {
      for (const { agent } of liveMoves) this.emitState(agent, { persist: false });
      for (const record of storedUpdates) this.dispatchStoredAgentState(record);
      if (!liveAgent) this.paseoToolPolicies.delete(agentId);
      if (this.agents.size > 0) this.refreshHierarchyToolPolicies(await this.readHierarchyAgents());
      if (liveAgent) await this.refreshHierarchySessionUnlocked(agentId);
      for (const { agent } of liveMoves) {
        if (agent.id !== agentId) {
          await this.runLifecycleMutation(agent.id, () =>
            this.refreshHierarchySessionUnlocked(agent.id),
          );
        }
      }
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Failed to publish committed workspace move");
    }
    return committed;
  }

  private async collectSameWorkspaceDescendantCandidates(
    registry: AgentStorage,
    rootAgentId: string,
    sourceWorkspaceId: string,
  ): Promise<Map<string, Record<string, string>>> {
    const storedInSource = await registry.listByWorkspaces([sourceWorkspaceId]);
    const candidates = new Map<string, Record<string, string>>();
    for (const record of storedInSource) {
      if (record.id === rootAgentId || record.internal || record.archivedAt) {
        continue;
      }
      const live = this.agents.get(record.id);
      if ((live?.workspaceId ?? record.workspaceId)?.trim() !== sourceWorkspaceId) {
        continue;
      }
      candidates.set(record.id, live?.labels ?? record.labels);
    }
    for (const live of this.agents.values()) {
      if (
        live.id === rootAgentId ||
        candidates.has(live.id) ||
        live.workspaceId?.trim() !== sourceWorkspaceId
      ) {
        continue;
      }
      const stored = await registry.get(live.id);
      if (!stored?.archivedAt) {
        candidates.set(live.id, live.labels);
      }
    }
    return candidates;
  }

  private async findSameWorkspaceDescendantIds(
    registry: AgentStorage,
    rootAgentId: string,
    sourceWorkspaceId: string,
    serverId: string,
  ): Promise<string[]> {
    const candidates = await this.collectSameWorkspaceDescendantCandidates(
      registry,
      rootAgentId,
      sourceWorkspaceId,
    );
    const owners = new Set<string>([rootAgentId]);
    const descendantIds: string[] = [];
    let added = true;
    while (added) {
      added = false;
      for (const [candidateId, labels] of candidates) {
        if (owners.has(candidateId)) {
          continue;
        }
        const parent = getParentAddressFromLabels(labels, serverId);
        if (parent?.serverId === serverId && owners.has(parent.agentId)) {
          owners.add(candidateId);
          descendantIds.push(candidateId);
          added = true;
        }
      }
    }
    return descendantIds;
  }

  notifyAgentState(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.internal) {
      return;
    }
    this.touchUpdatedAt(agent);
    this.emitState(agent);
  }

  async clearAgentAttention(agentId: string): Promise<void> {
    return this.runLifecycleMutation(agentId, () => this.clearAgentAttentionUnlocked(agentId));
  }

  private async clearAgentAttentionUnlocked(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent) {
      if (agent.attention.requiresAttention) {
        agent.attention = { requiresAttention: false };
        await this.persistSnapshot(agent);
        this.emitState(agent, { persist: false });
      }
      return;
    }

    const registry = this.requireRegistry();
    const record = await registry.get(agentId);
    if (!record || record.internal || record.archivedAt || record.requiresAttention !== true) {
      return;
    }
    const nextRecord: StoredAgentRecord = {
      ...record,
      updatedAt: this.nextStoredUpdatedAt(record),
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
    };
    await registry.upsert(nextRecord);
    this.dispatchStoredAgentState(nextRecord);
  }

  async markAgentUnread(agentId: string): Promise<void> {
    const liveAgent = this.agents.get(agentId);
    if (liveAgent) {
      const attentionReason = unreadAttentionReason(liveAgent.lifecycle);
      const hasPendingPermissions = liveAgent.pendingPermissions.size > 0;
      const canMarkUnread =
        attentionReason && !liveAgent.attention.requiresAttention && !hasPendingPermissions;
      if (!canMarkUnread) {
        throw new Error(`Agent is no longer settled and read: ${agentId}`);
      }
      liveAgent.attention = {
        requiresAttention: true,
        attentionReason,
        attentionTimestamp: new Date(),
      };
      await this.persistSnapshot(liveAgent);
      this.emitState(liveAgent, { persist: false });
      return;
    }

    const registry = this.requireRegistry();
    const record = await registry.get(agentId);
    const attentionReason = record?.lastStatus ? unreadAttentionReason(record.lastStatus) : null;
    const canMarkUnread =
      record && !record.internal && !record.archivedAt && !record.requiresAttention;
    if (!canMarkUnread || !attentionReason) {
      throw new Error(`Agent is no longer settled and read: ${agentId}`);
    }
    const updatedAt = this.nextStoredUpdatedAt(record);
    const nextRecord: StoredAgentRecord = {
      ...record,
      updatedAt,
      requiresAttention: true,
      attentionReason,
      attentionTimestamp: updatedAt,
    };
    await registry.upsert(nextRecord);
    this.dispatchStoredAgentState(nextRecord);
  }

  async archiveSnapshot(agentId: string, archivedAt: string): Promise<StoredAgentRecord> {
    return this.runHierarchyArchive(agentId, () =>
      this.archiveSnapshotUnlocked(agentId, archivedAt),
    );
  }

  private async runHierarchyArchive<T>(agentId: string, archive: () => Promise<T>): Promise<T> {
    this.pendingHierarchyArchives.set(
      agentId,
      (this.pendingHierarchyArchives.get(agentId) ?? 0) + 1,
    );
    try {
      return await this.runHierarchyMutation(() => this.runLifecycleMutation(agentId, archive));
    } finally {
      const remaining = (this.pendingHierarchyArchives.get(agentId) ?? 1) - 1;
      if (remaining) this.pendingHierarchyArchives.set(agentId, remaining);
      else this.pendingHierarchyArchives.delete(agentId);
    }
  }

  private async archiveSnapshotUnlocked(
    agentId: string,
    archivedAt: string,
  ): Promise<StoredAgentRecord> {
    const registry = this.requireRegistry();
    // A stored-only archive can have waited behind a persisted resume. Reuse the
    // live archive transition so its newly acquired runtime is closed as well.
    if (this.agents.has(agentId)) {
      await this.archiveAgentUnlocked(agentId, archivedAt);
      const archivedRecord = await registry.get(agentId);
      if (!archivedRecord) throw new Error(`Agent not found: ${agentId}`);
      return archivedRecord;
    }

    const record = await registry.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Archiving is the agent's latest change, as markRecordArchived records it for a loaded agent.
    const nextRecord = await this.persistArchivedRecord(record, {
      archivedAt,
      updatedAt: archivedAt,
    });

    await this.syncNativeArchiveState(record.provider, record.persistence, "archive");

    this.discardRetainedAgentState(agentId);
    if (!nextRecord.internal) this.dispatchStoredAgentState(nextRecord);

    await this.fireAgentArchived(agentId);
    await this.cascadeArchiveChildren(nextRecord);

    return nextRecord;
  }

  async unarchiveSnapshot(
    agentId: string,
    updates?: { workspaceId?: string; labels?: AgentLabelPatch },
  ): Promise<boolean> {
    return this.runHierarchyMutation(() =>
      this.runLifecycleMutation(agentId, () => this.unarchiveSnapshotUnlocked(agentId, updates)),
    );
  }

  private async unarchiveSnapshotUnlocked(
    agentId: string,
    updates?: { workspaceId?: string; labels?: AgentLabelPatch },
  ): Promise<boolean> {
    const registry = this.requireRegistry();
    const record = await registry.get(agentId);
    if (!record || !record.archivedAt) {
      return false;
    }

    const nextRecord: StoredAgentRecord = {
      ...record,
      ...(updates?.workspaceId ? { workspaceId: updates.workspaceId } : {}),
      ...(updates?.labels ? { labels: applyRecordPatch(record.labels, updates.labels) } : {}),
      archivedAt: null,
      updatedAt: new Date().toISOString(),
    };
    if (getParentAgentIdFromLabels(nextRecord.labels)) {
      const hierarchy = await this.readHierarchyAgents();
      const stored = await registry.listAll();
      const ancestors = new Map(stored.map((agent) => [agent.id, agent]));
      const depth = computeAgentDepth(
        agentId,
        (id) => (id === agentId ? nextRecord : (hierarchy.get(id) ?? ancestors.get(id))),
        this.serverId,
      );
      if (depth > MAX_SUBAGENT_DEPTH) {
        throw new Error(
          "Restoring this agent would exceed the maximum hierarchy depth of 3 tiers.",
        );
      }
    }
    // Close and native restore share the lifecycle lane with persisted resume.
    // No new history or interactive runtime can acquire the writer between them.
    if (this.agents.has(agentId)) await this.closeAgentRuntime(agentId);
    await this.syncNativeArchiveState(record.provider, record.persistence, "restore");

    if (await this.shouldDemoteRestoredMainControl(nextRecord)) {
      const modeId = this.resolveMainControlMode({
        enabled: false,
        provider: record.provider,
        currentMode: record.lastModeId ?? record.config?.modeId,
        priorMode: getMainPriorModeIdFromLabels(nextRecord.labels),
      });
      nextRecord.labels = applyRecordPatch(nextRecord.labels, {
        [WORKSPACE_ROLE_LABEL]: null,
        [MAIN_PRIOR_MODE_ID_LABEL]: null,
      });
      nextRecord.config = { ...record.config, modeId };
      nextRecord.lastModeId = modeId ?? null;
      if (record.runtimeInfo) {
        nextRecord.runtimeInfo = { ...record.runtimeInfo, modeId: modeId ?? null };
      }
    }
    if (!isMainControlAgentLabels(nextRecord.labels)) {
      nextRecord.mainControlSystemPrompt = undefined;
    }
    await registry.upsert(nextRecord);

    if (this.getAgent(agentId)) {
      this.notifyAgentState(agentId);
    } else if (!nextRecord.internal) {
      // Same publication archiveSnapshot makes, so a stored-only agent reappears for every client.
      this.dispatchStoredAgentState(nextRecord);
    }
    return true;
  }

  private async shouldDemoteRestoredMainControl(record: StoredAgentRecord): Promise<boolean> {
    if (!isMainControlAgentLabels(record.labels)) return false;
    if (getParentAgentIdFromLabels(record.labels)) return true;
    if (!record.workspaceId) return false;
    const hierarchy = await this.readHierarchyAgents();
    return [...hierarchy.values()].some(
      (other) =>
        other.id !== record.id &&
        !other.archivedAt &&
        other.workspaceId === record.workspaceId &&
        isMainControlAgentLabels(other.labels),
    );
  }

  async unarchiveSnapshotByHandle(handle: AgentPersistenceHandle): Promise<void> {
    const registry = this.requireRegistry();
    // Restoring an archived provider session is an explicit recovery operation.
    const records = await registry.listAll();
    const matched = records.find(
      (record) =>
        record.persistence?.provider === handle.provider &&
        record.persistence?.sessionId === handle.sessionId,
    );
    if (!matched) {
      return;
    }

    await this.unarchiveSnapshot(matched.id);
  }

  async updateAgentMetadata(
    agentId: string,
    updates: {
      title?: string;
      labels?: Record<string, string>;
      expectedWorkspaceId?: string;
    },
  ): Promise<void> {
    if (hasReservedHierarchyLabels(updates.labels))
      throw new Error(RESERVED_HIERARCHY_LABELS_ERROR);
    await this.runLifecycleMutation(agentId, () =>
      this.updateAgentMetadataUnlocked(agentId, updates),
    );
  }

  private async updateAgentMetadataUnlocked(
    agentId: string,
    updates: {
      title?: string;
      labels?: Record<string, string>;
      expectedWorkspaceId?: string;
    },
  ): Promise<void> {
    const liveAgent = this.getAgent(agentId);
    if (updates.expectedWorkspaceId !== undefined) {
      const current = liveAgent ?? (await this.requireRegistry().get(agentId));
      if (current?.workspaceId !== updates.expectedWorkspaceId) {
        throw new Error(
          `Agent ${agentId} is no longer in workspace ${updates.expectedWorkspaceId}`,
        );
      }
    }
    if (liveAgent) {
      if (updates.title) {
        await this.setTitle(agentId, updates.title);
      }
      if (updates.labels) {
        await this.writeLabels(agentId, updates.labels);
      }
      return;
    }

    await this.writeStoredMetadata(agentId, updates);
  }

  private async runLifecycleMutation<T>(agentId: string, mutation: () => Promise<T>): Promise<T> {
    // Parent cascade classifies a child inside the same lane used by open-tab
    // label writes, so a received ownership update cannot be overtaken.
    const previous = this.lifecycleMutationTails.get(agentId) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(() => {
        if (this.pendingSubagentMoveSnapshots.has(agentId)) {
          throw new Error("Agent workspace move requires recovery before updating this agent.");
        }
        return mutation();
      });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleMutationTails.set(agentId, tail);
    void tail.finally(() => {
      if (this.lifecycleMutationTails.get(agentId) === tail) {
        this.lifecycleMutationTails.delete(agentId);
      }
    });
    return result;
  }

  async runAgent(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const events = this.streamAgent(agentId, prompt, options);
    const timeline: AgentTimelineItem[] = [];
    let finalText = "";
    let usage: AgentUsage | undefined;
    let canceled = false;

    for await (const event of events) {
      if (event.type === "timeline") {
        timeline.push(event.item);
      } else if (event.type === "turn_completed") {
        usage = event.usage;
      } else if (event.type === "turn_failed") {
        throw new Error(this.formatTurnFailedMessage(event));
      } else if (event.type === "turn_canceled") {
        canceled = true;
      }
    }

    finalText = this.getLastAssistantMessageFromTimeline(timeline) ?? "";

    const agent = this.requireAgent(agentId);
    const sessionId = agent.persistence?.sessionId;
    if (!sessionId) {
      throw new Error(`Agent ${agentId} has no persistence.sessionId after run completed`);
    }
    return {
      sessionId,
      finalText,
      usage,
      timeline,
      canceled,
    };
  }

  /**
   * Try to run a prompt out-of-band — i.e. without allocating a foreground turn
   * and without canceling any active turn. Returns true when the session
   * accepted the prompt as a side-effect command (e.g. /goal pause). Events
   * emitted by the handler flow through dispatchStream so they persist and
   * broadcast like normal timeline events.
   */
  async tryRunOutOfBand(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
    onAccepted?: () => void | Promise<void>,
    commandDispatch?: {
      waitForProviderOutcome?: boolean;
      assertAllowed?: () => void;
      onProviderOutcome?: (outcome: AgentCommandOutcome) => Promise<void>;
    },
  ): Promise<boolean> {
    this.assertAcceptingAgentRuns();
    if (this.collectingRuntimes.has(agentId) || !this.agents.has(agentId)) {
      await this.waitForAgentClose(agentId);
      await ensureAgentLoaded(agentId, {
        agentManager: this,
        agentStorage: this.requireRegistry(),
        logger: this.logger,
      });
    }
    const agent = await this.ensureInteractiveSession(agentId);
    this.assertAcceptingAgentRuns();
    // A switch can acquire the lifecycle lane while the history session is opening.
    // Let the foreground admission path wait for that switch.
    if (this.providerSwitches.has(agentId)) return false;
    // Providers parse slash commands from the raw text, so a command another agent sent
    // must reach them without its sender envelope.
    const agentMessage = typeof prompt === "string" ? parseAgentMessage(prompt) : null;
    const handler = agent.session.tryHandleOutOfBand?.(
      agentMessage?.source ? agentMessage.text : prompt,
    );
    if (!handler) {
      return false;
    }
    const requiresProviderHandoff = commandDispatch?.waitForProviderOutcome === true;
    const assertDispatchAllowed = commandDispatch?.assertAllowed;
    if (!requiresProviderHandoff) {
      const acceptedCallback = onAccepted?.();
      if (acceptedCallback) await acceptedCallback;
    }
    this.assertAcceptingAgentRuns();
    this.touchUpdatedAt(agent);
    if (options?.clientMessageId) {
      this.recordSubmittedPrompt(agent, prompt, options.clientMessageId, "accepted");
      this.emitState(agent);
    }
    const dispatch = (event: AgentStreamEvent): void => {
      // Persist timeline items so they show up in fetchAgentTimeline; broadcast
      // for live subscribers. Other event types are broadcast only.
      if (event.type === "timeline") {
        this.touchUpdatedAt(agent);
        const row = this.recordTimeline(agent.id, event.item);
        this.dispatchStream(
          agent.id,
          { ...event, item: row.item },
          {
            seq: row.seq,
            epoch: this.timelineStore.getEpoch(agent.id),
            timestamp: row.timestamp,
          },
        );
        return;
      }
      this.dispatchStream(agent.id, event, { timestamp: new Date().toISOString() });
    };
    // Manual commands acknowledge queueing. Startup recovery consumes its record
    // only once the provider acknowledges the command or its outcome is unknown.
    let markCommandStarted: (() => void) | undefined;
    const commandStarted = requiresProviderHandoff
      ? new Promise<void>((resolveStarted) => {
          markCommandStarted = resolveStarted;
        })
      : undefined;
    let providerHandoffOutcome: AgentCommandOutcome | undefined;
    let failedAdmission: { error: unknown } | undefined;
    const beforeProviderDispatch = requiresProviderHandoff
      ? async () => {
          try {
            this.assertAcceptingAgentRuns();
            assertDispatchAllowed?.();
            const accepted = onAccepted?.();
            if (accepted) await accepted;
            this.assertAcceptingAgentRuns();
            assertDispatchAllowed?.();
          } catch (error) {
            // A command handler may turn this error into a timeline message.
            failedAdmission = { error };
            throw error;
          }
        }
      : undefined;
    const onProviderOutcome = requiresProviderHandoff
      ? async (outcome: AgentCommandOutcome = "accepted") => {
          if (providerHandoffOutcome) return;
          providerHandoffOutcome = outcome;
          await commandDispatch?.onProviderOutcome?.(outcome);
          markCommandStarted?.();
        }
      : undefined;
    const command = this.runForegroundMutation(agentId, async () => {
      assertDispatchAllowed?.();
      try {
        await handler.run({ emit: dispatch, beforeProviderDispatch, onProviderOutcome });
      } catch (error) {
        if (requiresProviderHandoff && !providerHandoffOutcome) {
          if (failedAdmission) throw failedAdmission.error;
          throw new AgentCommandNotDispatchedError(error);
        }
        const text = error instanceof Error ? error.message : "Out-of-band command failed";
        dispatch({
          type: "timeline",
          provider: agent.provider,
          item: { type: "assistant_message", text: `[Error] ${text}` },
        });
      }
      if (requiresProviderHandoff && !providerHandoffOutcome) {
        if (failedAdmission) throw failedAdmission.error;
        throw new AgentCommandNotDispatchedError();
      }
    });
    if (commandStarted) await Promise.race([commandStarted, command]);
    return true;
  }

  private notifyAgentRunAccepted(
    agentId: string,
    options: AgentRunOptions | undefined,
    prompt: AgentPromptInput,
  ): Promise<void> | undefined {
    if (
      options?.recoveryIntent === "automatic" ||
      !this.onAgentRunAccepted ||
      parseAgentMessages(submittedPromptText(prompt))?.some((message) => message.source)
    )
      return undefined;
    return Promise.resolve(this.onAgentRunAccepted(agentId)).catch((error) => {
      this.logger.warn({ err: error, agentId }, "Failed to consume automatic recovery intent");
    });
  }

  async appendTimelineItem(
    agentId: string,
    item: AgentTimelineItem,
  ): Promise<{ seq: number; epoch: string }> {
    if (this.providerSwitches.has(agentId)) await this.waitForAgentClose(agentId);
    const agent = this.requireAgent(agentId);
    item = limitAgentTimelineItemContent(item);
    this.touchUpdatedAt(agent);
    const row = this.recordTimeline(agentId, item);
    this.dispatchStream(
      agentId,
      {
        type: "timeline",
        item: row.item,
        provider: agent.provider,
      },
      {
        seq: row.seq,
        epoch: this.timelineStore.getEpoch(agentId),
        timestamp: row.timestamp,
      },
    );
    await this.persistSnapshot(agent);
    return { seq: row.seq, epoch: this.timelineStore.getEpoch(agentId) };
  }

  async emitLiveTimelineItem(agentId: string, item: AgentTimelineItem): Promise<void> {
    const agent = this.requireAgent(agentId);
    this.touchUpdatedAt(agent);
    this.dispatchStream(agentId, {
      type: "timeline",
      item,
      provider: agent.provider,
    });
  }

  private async prepareProviderTurnPrompt(
    agent: ActiveManagedAgent,
    prompt: AgentPromptInput,
    handoff: PendingContextHandoff | undefined,
    addMainControl: boolean,
  ): Promise<AgentPromptInput> {
    const envelope = handoff && (await this.prepareContextForSend(agent, handoff));
    const providerPrompt = envelope ? injectContextHandoffIntoPrompt(prompt, envelope) : prompt;
    if (!addMainControl) return providerPrompt;
    const hierarchy = await this.readHierarchyAgents();
    const instructions = buildHierarchyAppendSystemPrompt({
      agent,
      mainControlSystemPrompt: agent.mainControlSystemPrompt,
      serverId: this.serverId,
      readAgent: (id) => hierarchy.get(id),
      listActiveAgents: () => hierarchy.values(),
    });
    const prefix = `${MAIN_CONTROL_PROMPT_HEADER}\n${instructions}${mainControlPromptEnd(agent.id)}\n\n`;
    if (typeof providerPrompt === "string") return prefix + providerPrompt;
    const [first, ...rest] = providerPrompt;
    return first?.type === "text" && !("mimeType" in first)
      ? [{ ...first, text: prefix + first.text }, ...rest]
      : [{ type: "text", text: prefix }, ...providerPrompt];
  }

  private needsMainControlPrompt(agent: ActiveManagedAgent, roleVersion: number): boolean {
    return (
      isMainControlAgentLabels(agent.labels) &&
      (!HIERARCHY_SYSTEM_PROMPT_ADAPTERS.has(this.adapterOf(agent.provider)) ||
        this.inPlaceMainControlSessions.has(agent.session)) &&
      this.promptedMainControlRoleVersions.get(agent.id) !== roleVersion
    );
  }

  private assertPendingTurnStart(agentId: string, pendingRun: PendingForegroundRun): void {
    if (pendingRun.settled) {
      throw new Error(`Agent ${agentId} run was canceled before its turn started`);
    }
  }

  private async startPendingForegroundTurn(params: {
    agent: ActiveManagedAgent;
    agentId: string;
    pendingRun: PendingForegroundRun;
    prompt: AgentPromptInput;
    options?: AgentRunOptions;
    promptStart?: ForegroundPromptStart;
  }): Promise<string | null> {
    const { agent, agentId, pendingRun, prompt, options, promptStart } = params;
    if (promptStart?.admit?.() === false) {
      this.runs.settleForegroundRun(agentId, pendingRun.token);
      return null;
    }
    try {
      const handoff = this.contextHandoffs.get(agentId);
      const roleVersion = this.mainControlRoleVersions.get(agentId) ?? 0;
      const addedMainControl = this.needsMainControlPrompt(agent, roleVersion);
      const providerPrompt =
        handoff || addedMainControl
          ? await this.prepareProviderTurnPrompt(agent, prompt, handoff, addedMainControl)
          : prompt;
      const result = await this.startAdmittedProviderTurn(params, providerPrompt);
      if (addedMainControl) this.promptedMainControlRoleVersions.set(agentId, roleVersion);
      if (handoff) await this.consumeContextHandoff(agentId, handoff);
      this.assertPendingTurnStart(agentId, pendingRun);
      return result.turnId;
    } catch (error) {
      if (error instanceof AgentTurnStartCanceledError) {
        if (!pendingRun.settled) {
          if (options?.clientMessageId) {
            this.recordSubmittedPrompt(agent, prompt, options.clientMessageId, "rejected", {
              messageId: options.clientMessageId,
            });
          }
          await this.handleStreamEvent(agent, {
            type: "turn_canceled",
            provider: agent.provider,
            reason: "interrupted",
          });
          this.finalizeForegroundTurn(agent);
          this.runs.settleForegroundRun(agentId, pendingRun.token);
        }
        return null;
      }
      if (pendingRun.settled) {
        throw error;
      }
      if (isStaleProviderSessionError(error)) {
        this.runs.settleForegroundStart(pendingRun, {
          status: "failed",
          error: error.message,
          stale: true,
        });
        agent.pendingReplacement = false;
        if (!agent.activeForegroundTurnId) agent.lifecycle = "idle";
        this.runs.settleForegroundRun(agentId, pendingRun.token);
        throw error;
      }
      agent.pendingReplacement = false;
      const errorMsg = error instanceof Error ? error.message : "Failed to start turn";
      this.runs.settleForegroundStart(pendingRun, foregroundStartFailure(error, errorMsg));
      try {
        // A terminal rejection belongs after the submitted prompt even though no provider turn exists.
        if (options?.clientMessageId) {
          this.recordSubmittedPrompt(agent, prompt, options.clientMessageId, "rejected", {
            messageId: options.clientMessageId,
          });
        }
        await this.handleStreamEvent(agent, {
          type: "turn_failed",
          provider: agent.provider,
          error: errorMsg,
        });
        this.finalizeForegroundTurn(agent);
      } finally {
        // A steer waiting on this start is released only once the run is cleared.
        this.runs.settleForegroundRun(agentId, pendingRun.token);
      }
      throw error;
    }
  }

  private startAdmittedProviderTurn(
    params: Parameters<AgentManager["startPendingForegroundTurn"]>[0],
    providerPrompt: AgentPromptInput,
  ) {
    const { agent, agentId, pendingRun, options, promptStart } = params;
    const validate = () => {
      this.assertPendingTurnStart(agentId, pendingRun);
    };
    validate();
    const start = (runOptions = options) => agent.session.startTurn(providerPrompt, runOptions);
    if (!promptStart?.beforeHandoff) return start();
    this.assertAcceptingAgentRuns();
    const validateHandoff = () => {
      this.assertAcceptingAgentRuns();
      validate();
    };
    return (
      agent.session.capabilities.defersPromptHandoff
        ? start({
            ...options,
            beforeProviderDispatch: () => promptStart.handoff(async () => {}, validateHandoff),
          })
        : promptStart.handoff(start, validateHandoff)
    ).catch(async (error) => {
      if (
        isStaleProviderSessionError(error) ||
        error instanceof AgentTurnStartCanceledError ||
        error instanceof AgentTurnStartRejectedError
      ) {
        await promptStart.onHandoffDeclined?.();
      }
      throw error;
    });
  }

  private async refreshHierarchySessionUnlocked(
    agentId: string,
    beforeTurn = false,
  ): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent?.persistence || !agent.capabilities.supportsSessionPersistence) {
      this.pendingHierarchySessionReloads.delete(agentId);
      return;
    }
    if (this.hasRunningHierarchyTurn(agent) || (!beforeTurn && agent.lifecycle !== "idle")) {
      this.pendingHierarchySessionReloads.add(agentId);
      return;
    }
    this.pendingHierarchySessionReloads.delete(agentId);
    this.hierarchySessionUpdates.add(agentId);
    try {
      await this.trackAgentRegistrationOperation(
        this.reloadAgentSessionInternal(agentId, undefined, { refreshHierarchy: true }),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, agentId },
        "Failed to refresh agent session after hierarchy change",
      );
      if (this.agents.has(agentId)) this.pendingHierarchySessionReloads.add(agentId);
      if (beforeTurn) throw error;
    } finally {
      this.hierarchySessionUpdates.delete(agentId);
    }
  }

  private hasRunningHierarchyTurn(agent: ManagedAgent): boolean {
    if (agent.pendingReplacement) {
      // Between canceled and replacement turns, lifecycle remains running for the UI.
      return Boolean(
        agent.activeTurnId || agent.activeForegroundTurnId || this.runs.hasRun(agent.id),
      );
    }
    return this.hasInFlightRun(agent.id);
  }

  private needsHierarchySessionReload(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    return (
      !!agent &&
      this.pendingHierarchySessionReloads.has(agentId) &&
      !this.hasRunningHierarchyTurn(agent)
    );
  }

  private localHierarchyParentId(labels?: Record<string, string>): string | null {
    if (labels?.[REMOTE_HIERARCHY_DEPTH_LABEL]) return null;
    const recordedServer = labels?.[PARENT_SERVER_ID_LABEL];
    if (this.serverId && recordedServer && recordedServer !== this.serverId) return null;
    return getParentAgentIdFromLabels(labels);
  }

  private changingMainControlParent(agent: ManagedAgent): string | null {
    const parentId = this.localHierarchyParentId(agent.labels);
    return parentId &&
      this.mainControlRoleUpdates.has(parentId) &&
      !this.hasRunningHierarchyTurn(agent)
      ? parentId
      : null;
  }

  private refreshIfMainControlChangedWhileOpening(
    agent: ManagedAgent,
    openedConfig: AgentSessionConfig,
  ): void {
    const parentId = this.localHierarchyParentId(agent.labels);
    const roleVersion = this.launchMainControlRoleVersions.get(openedConfig);
    if (
      parentId &&
      roleVersion !== undefined &&
      roleVersion !== (this.mainControlRoleVersions.get(parentId) ?? 0)
    ) {
      this.markHierarchySessionForRefresh(agent);
    }
  }

  private markHierarchySessionForRefresh(agent: ManagedAgent): void {
    if (agent.persistence && agent.capabilities.supportsSessionPersistence) {
      this.pendingHierarchySessionReloads.add(agent.id);
    }
  }

  private async ensureInteractiveSession(agentId: string): Promise<ActiveManagedAgent> {
    while (this.hierarchySessionUpdates.has(agentId) || this.providerSwitches.has(agentId)) {
      await this.waitForAgentClose(agentId);
    }
    let agent = this.requireSessionAgent(agentId);
    let changingParent = this.changingMainControlParent(agent);
    while (changingParent) {
      await this.waitForAgentClose(changingParent);
      agent = this.requireSessionAgent(agentId);
      changingParent = this.changingMainControlParent(agent);
    }
    if (this.historySessions.has(agent.session) || this.needsHierarchySessionReload(agentId)) {
      await this.runLifecycleMutation(agentId, () =>
        this.ensureInteractiveSessionUnlocked(agentId),
      );
    }
    return this.requireSessionAgent(agentId);
  }

  /** Inside the agent's lane: a history session is upgraded before anything is applied to it. */
  private async ensureInteractiveSessionUnlocked(agentId: string): Promise<ActiveManagedAgent> {
    if (this.needsHierarchySessionReload(agentId)) {
      await this.refreshHierarchySessionUnlocked(agentId, true);
    }
    const agent = this.requireSessionAgent(agentId);
    if (this.historySessions.has(agent.session)) {
      const record = await this.registry?.get(agentId);
      if (record?.archivedAt) throw new Error(`Agent is archived: ${agentId}`);
      // Reload validates the directory before releasing readable history.
      await this.trackAgentRegistrationOperation(this.reloadAgentSessionInternal(agentId));
    }
    return this.requireSessionAgent(agentId);
  }

  /** Inside the agent's lane: transparently reopens a retired plugin session before applying config. */
  private async withLiveInteractiveSessionUnlocked<T>(
    agentId: string,
    operation: (agent: ActiveManagedAgent) => Promise<T>,
  ): Promise<T> {
    const pendingCancellation = this.pendingCancellations.get(agentId);
    if (pendingCancellation) {
      await this.waitWithTimeout({
        operation: pendingCancellation.then(
          () => undefined,
          () => undefined,
        ),
        timeoutMs: this.rescueTimeouts.interruptSessionMs,
      });
    }
    const agent = await this.ensureInteractiveSessionUnlocked(agentId);
    try {
      return await operation(agent);
    } catch (error) {
      if (!isStaleProviderSessionError(error)) throw error;
      await this.runs.getPendingRun(agentId)?.settledPromise.catch(() => undefined);
      if (this.hasInFlightRun(agentId)) throw error;
      await this.trackAgentRegistrationOperation(this.reloadAgentSessionInternal(agentId));
      return await operation(this.requireSessionAgent(agentId));
    }
  }

  private async *streamAfterHistoryLoad(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
    promptStart?: ForegroundPromptStart,
  ): AsyncGenerator<AgentStreamEvent> {
    await this.ensureInteractiveSession(agentId);
    yield* this.streamAgent(agentId, prompt, options, promptStart);
  }

  private async *streamAfterRuntimeCollection(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
    promptStart?: ForegroundPromptStart,
  ): AsyncGenerator<AgentStreamEvent> {
    await this.waitForAgentClose(agentId);
    await ensureAgentLoaded(agentId, {
      agentManager: this,
      agentStorage: this.requireRegistry(),
      logger: this.logger,
    });
    yield* this.streamAgent(agentId, prompt, options, promptStart);
  }

  streamAgent(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
    promptStart?: ForegroundPromptStart,
  ): AsyncGenerator<AgentStreamEvent> {
    this.assertAcceptingAgentRuns();
    return this.reserveAgentRun(agentId, prompt, options, promptStart);
  }

  private reserveAgentRun(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
    promptStart?: ForegroundPromptStart,
  ): AsyncGenerator<AgentStreamEvent> {
    if (
      this.hierarchySessionUpdates.has(agentId) ||
      this.providerSwitches.has(agentId) ||
      this.collectingRuntimes.has(agentId) ||
      (!this.agents.has(agentId) && this.registry)
    )
      return this.streamAfterRuntimeCollection(agentId, prompt, options, promptStart);
    const existingAgent = this.requireSessionAgent(agentId);
    if (
      this.historySessions.has(existingAgent.session) ||
      this.needsHierarchySessionReload(agentId) ||
      this.changingMainControlParent(existingAgent)
    )
      return this.streamAfterHistoryLoad(agentId, prompt, options, promptStart);
    this.logger.trace(
      {
        agentId,
        provider: existingAgent.provider,
        sessionId: existingAgent.persistence?.sessionId ?? undefined,
        turnId: existingAgent.activeForegroundTurnId ?? undefined,
        lifecycle: existingAgent.lifecycle,
        activeForegroundTurnId: existingAgent.activeForegroundTurnId,
        hasTrackedRun: this.runs.hasRun(agentId),
        promptType: typeof prompt === "string" ? "string" : "structured",
        hasRunOptions: Boolean(options),
      },
      "agent.manager.stream.request",
    );
    if (existingAgent.activeForegroundTurnId || this.runs.hasRun(agentId)) {
      this.logger.trace(
        {
          agentId,
          provider: existingAgent.provider,
          sessionId: existingAgent.persistence?.sessionId ?? undefined,
          turnId: existingAgent.activeForegroundTurnId ?? undefined,
          lifecycle: existingAgent.lifecycle,
          hasTrackedRun: this.runs.hasRun(agentId),
        },
        "agent.manager.stream.reject",
      );
      throw new Error(`Agent ${agentId} already has an active run`);
    }

    const agent = existingAgent;
    const isReplacement = agent.pendingReplacement;
    agent.lastError = undefined;

    const pendingRun = this.runs.createPendingRun(agentId);
    promptStart?.bind(pendingRun);

    const streamForwarder = async function* streamForwarder(this: AgentManager) {
      let turnId: string | null;
      let turnStream: ReturnType<AgentRunState["createTurnStream"]> | null = null;
      turnId = await this.startPendingForegroundTurn({
        agent,
        agentId,
        pendingRun,
        prompt,
        options,
        promptStart,
      });
      if (turnId === null) {
        const canceledEvent: AgentStreamEvent = {
          type: "turn_canceled",
          provider: agent.provider,
          reason: "interrupted",
        };
        yield canceledEvent;
        return;
      }

      const turnStartedAt = new Date();
      this.runs.settleForegroundStart(pendingRun, { status: "started", turnId });
      const accepted = this.notifyAgentRunAccepted(agentId, options, prompt);

      if (isReplacement) {
        agent.pendingReplacement = false;
      }
      agent.activeForegroundTurnId = turnId;
      this.openActiveTurn(agent, turnId, turnStartedAt);
      agent.attention = { requiresAttention: false };
      agent.lifecycle = "running";
      this.touchUpdatedAt(agent);
      // AgentManager owns the accepted-turn boundary. Publish liveness before the canonical
      // prompt so clients can retire optimistic activity without painting an idle frame.
      // The provider's duplicate start for this turn is suppressed at the ingestion boundary.
      this.dispatchStream(
        agent.id,
        { type: "turn_started", provider: agent.provider, turnId },
        { timestamp: turnStartedAt.toISOString() },
      );
      const stagedSubmittedPromptEcho = options?.clientMessageId
        ? pendingRun.stagedEvents.find(
            (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
              event.type === "timeline" &&
              event.item.type === "user_message" &&
              event.item.clientMessageId === options.clientMessageId,
          )
        : undefined;
      if (options?.clientMessageId) {
        this.recordSubmittedPrompt(agent, prompt, options.clientMessageId, "accepted", {
          messageId: options.clientMessageId,
          turnId,
          providerMessageId:
            stagedSubmittedPromptEcho?.item.type === "user_message"
              ? stagedSubmittedPromptEcho.item.messageId
              : undefined,
        });
      }
      for (const stagedEvent of pendingRun.stagedEvents.splice(0)) {
        const isAcceptedTurnStart =
          stagedEvent.type === "turn_started" && getAgentStreamEventTurnId(stagedEvent) === turnId;
        if (isAcceptedTurnStart || stagedEvent === stagedSubmittedPromptEcho) {
          continue;
        }
        this.enqueueSessionEvent(agent.id, stagedEvent);
      }
      this.emitState(agent);
      this.logger.trace(
        {
          agentId,
          provider: agent.provider,
          sessionId: agent.persistence?.sessionId ?? undefined,
          turnId,
          lifecycle: agent.lifecycle,
          activeForegroundTurnId: agent.activeForegroundTurnId,
        },
        "agent.manager.stream.start",
      );

      turnStream = this.runs.createTurnStream(turnId);
      this.runs.addWaiter(agent, turnStream.waiter);

      try {
        if (accepted) await accepted;
        const acceptedTurnStartedEvent: AgentStreamEvent = {
          type: "turn_started",
          provider: agent.provider,
          turnId,
        };
        yield acceptedTurnStartedEvent;
        for await (const event of turnStream.events(isTurnTerminalEvent)) {
          yield event;
        }
      } finally {
        if (turnStream) {
          this.runs.deleteWaiter(agent, turnStream.waiter);
        }
        this.runs.settleForegroundRun(agentId, pendingRun.token);
        if (!agent.activeForegroundTurnId) {
          await this.refreshRuntimeInfo(agent);
        }
      }
    }.call(this);

    return streamForwarder;
  }

  private finalizeForegroundTurn(agent: ActiveManagedAgent, turnId?: string): void {
    const mutableAgent = agent;
    if (turnId) {
      this.runs.rememberFinalizedTurn(mutableAgent, turnId);
    }
    mutableAgent.activeForegroundTurnId = null;
    this.applyActiveTurnTerminal(mutableAgent, turnId);
    const terminalError = mutableAgent.lastError;
    const shouldHoldBusyForReplacement = mutableAgent.pendingReplacement && !terminalError;
    let nextLifecycle: "running" | "error" | "idle";
    if (shouldHoldBusyForReplacement) {
      nextLifecycle = "running";
    } else if (terminalError) {
      nextLifecycle = "error";
    } else {
      nextLifecycle = "idle";
    }
    mutableAgent.lifecycle = nextLifecycle;
    const persistenceHandle =
      mutableAgent.session.describePersistence() ??
      (mutableAgent.runtimeInfo?.sessionId
        ? { provider: mutableAgent.provider, sessionId: mutableAgent.runtimeInfo.sessionId }
        : null);
    if (persistenceHandle) {
      mutableAgent.persistence = normalizePersistenceForConfig(
        persistenceHandle,
        mutableAgent.config,
      );
    }
    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: mutableAgent.persistence?.sessionId ?? undefined,
        turnId,
        lifecycle: mutableAgent.lifecycle,
        terminalError,
        pendingReplacement: mutableAgent.pendingReplacement,
      },
      "agent.manager.finalize",
    );
    if (!shouldHoldBusyForReplacement) {
      this.touchUpdatedAt(mutableAgent);
      this.emitState(mutableAgent);
    }
  }

  private openActiveTurn(agent: ActiveManagedAgent, turnId: string, startedAt: Date): void {
    agent.activeTurnId = turnId;
    agent.activeTurnStartedAt = startedAt;
  }

  private applyActiveTurnTerminal(
    agent: ActiveManagedAgent,
    turnId?: string,
    fromHistory = false,
  ): ActiveTurnTerminalDisposition {
    if (fromHistory) return "stale";
    if (!agent.activeTurnId) return "untracked";
    if (turnId && agent.activeTurnId !== turnId) return "stale";
    agent.activeTurnId = null;
    agent.activeTurnStartedAt = null;
    return "closed_current";
  }

  async replaceAgentRun(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
    promptStart?: ForegroundPromptStart,
  ): Promise<AsyncGenerator<AgentStreamEvent>> {
    this.assertAcceptingAgentRuns();
    if (!this.hierarchySessionUpdates.has(agentId)) this.requireSessionAgent(agentId);
    return this.replaceRunInForegroundLane(agentId, prompt, options, promptStart);
  }

  async steerAgentRun(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentSteerOptions,
  ): Promise<SteerResult> {
    this.assertAcceptingAgentRuns();
    const agent = this.requireSessionAgent(agentId);
    const expectedTurnId = agent.activeForegroundTurnId ?? agent.activeTurnId;
    if (!expectedTurnId || !agent.session.steerActiveTurn) {
      return { status: "unavailable" };
    }
    const result = await this.runSteerAdmission(agent, expectedTurnId, async () => {
      const admission = await agent.session.steerActiveTurn!(prompt, {
        ...options,
        expectedTurnId,
      });
      if (admission.status === "accepted") {
        await this.recordAcceptedSteer(
          agent,
          prompt,
          options?.clientMessageId,
          expectedTurnId,
          admission.providerMessageId,
        );
        const accepted = this.notifyAgentRunAccepted(agentId, options, prompt);
        if (accepted) await accepted;
      }
      return admission;
    });
    // An unavailable answer is only safe to fall back from while this admission
    // still owns the active turn. Never let an A admission replace a later B.
    if (result.status === "unavailable" && agent.activeTurnId !== expectedTurnId) {
      throw new Error("Active turn changed before steering could be delivered");
    }
    return result;
  }

  async steerOrReplaceActiveTurn(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentSteerOptions,
    promptStart?: ForegroundPromptStart,
    admitSteer?: () => Promise<boolean>,
    onSteerDeclined?: () => Promise<void>,
  ): Promise<ActiveTurnSteerDispatchResult> {
    this.assertAcceptingAgentRuns();
    // A turn that is still starting has no id to steer yet. Replacing it would drop its
    // prompt, so wait until it is accepted (or fails) and steer the turn it became.
    await this.runs.waitForForegroundStart(agentId);
    this.assertAcceptingAgentRuns();
    const agent = this.requireSessionAgent(agentId);
    const expectedTurnId = agent.activeForegroundTurnId ?? agent.activeTurnId;
    if (!expectedTurnId) {
      return { status: "inactive" };
    }

    const result = agent.session.steerActiveTurn
      ? await this.runSteerAdmission<SteerResult>(
          agent,
          expectedTurnId,
          async () => {
            if (admitSteer) {
              if (!(await admitSteer())) return { status: "unavailable" };
            }
            const assertSteerAllowed = () => {
              this.assertAcceptingAgentRuns();
              this.assertSteerAdmissionOwnsTurn(agent, expectedTurnId);
            };
            const steer = (beforeProviderDispatch?: () => Promise<void>) =>
              agent.session.steerActiveTurn!(prompt, {
                ...options,
                expectedTurnId,
                beforeProviderDispatch,
              });
            let admission: SteerResult;
            try {
              if (promptStart?.beforeHandoff) {
                admission = agent.session.capabilities.defersPromptHandoff
                  ? await steer(() => promptStart.handoff(async () => {}, assertSteerAllowed))
                  : await promptStart.handoff(steer, assertSteerAllowed);
              } else {
                assertSteerAllowed();
                admission = await steer();
              }
            } catch (error) {
              if (
                isStaleProviderSessionError(error) ||
                error instanceof AgentTurnStartCanceledError
              ) {
                await onSteerDeclined?.();
              }
              throw error;
            }
            if (admission.status === "unavailable") await onSteerDeclined?.();
            if (admission.status === "accepted") {
              await this.recordAcceptedSteer(
                agent,
                prompt,
                options?.clientMessageId,
                expectedTurnId,
                admission.providerMessageId,
              );
              const accepted = this.notifyAgentRunAccepted(agentId, options, prompt);
              if (accepted) await accepted;
            }
            return admission;
          },
          admitSteer ? () => ({ status: "unavailable" }) : undefined,
        )
      : { status: "unavailable" as const };
    if (result.status === "accepted") {
      return { status: "steered" };
    }
    if (admitSteer) return { status: "inactive" };

    // Providers without autonomous steering keep their existing dispatch behavior. The shared
    // admission may recognize the turn, but only an accepted steer can own it without replacement.
    if (agent.activeForegroundTurnId === null && agent.activeTurnId === expectedTurnId) {
      return { status: "inactive" };
    }

    await this.beforeSteerUnavailableFallback?.({ agentId, expectedTurnId });
    this.assertSteerAdmissionOwnsTurn(agent, expectedTurnId);
    return {
      status: "replaced",
      iterator: await this.replaceAdmittedForegroundTurn(
        agent,
        expectedTurnId,
        prompt,
        stripSteerOptions(options),
        promptStart,
      ),
    };
  }

  private assertSteerAdmissionOwnsTurn(agent: ActiveManagedAgent, expectedTurnId: string): void {
    if (agent.activeTurnId !== expectedTurnId) {
      throw new Error("Active turn changed before steering could be delivered");
    }
  }

  private async runSteerAdmission<T>(
    agent: ActiveManagedAgent,
    expectedTurnId: string,
    operation: () => Promise<T>,
    onTurnChanged?: () => T,
  ): Promise<T> {
    return this.runForegroundMutation(agent.id, async () => {
      await this.drainSessionEvents(agent.id);
      this.assertAcceptingAgentRuns();
      this.agentStreamCoalescer.flushFor(agent.id);
      if (onTurnChanged && agent.activeTurnId !== expectedTurnId) return onTurnChanged();
      this.assertSteerAdmissionOwnsTurn(agent, expectedTurnId);
      const barrier: SteerEventBarrier = { events: [] };
      this.steerEventBarriers.set(agent.id, barrier);
      try {
        return await operation();
      } finally {
        if (this.steerEventBarriers.get(agent.id) === barrier) {
          this.steerEventBarriers.delete(agent.id);
        }
        for (const event of barrier.events) {
          this.enqueueSessionEvent(agent.id, event);
        }
        await this.drainSessionEvents(agent.id);
      }
    });
  }

  private async runForegroundMutation<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    return this.runQueuedMutation(this.foregroundMutationTails, agentId, operation);
  }

  private async runQueuedMutation<T>(
    tails: Map<string, Promise<void>>,
    agentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = tails.get(agentId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(agentId, tail);
    try {
      return await run;
    } finally {
      if (tails.get(agentId) === tail) {
        tails.delete(agentId);
      }
    }
  }

  private async replaceAdmittedForegroundTurn(
    agent: ActiveManagedAgent,
    expectedTurnId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
    promptStart?: ForegroundPromptStart,
  ): Promise<AsyncGenerator<AgentStreamEvent>> {
    this.assertSteerAdmissionOwnsTurn(agent, expectedTurnId);
    return this.replaceRunInForegroundLane(agent.id, prompt, options, promptStart, (live) =>
      this.assertSteerAdmissionOwnsTurn(live, expectedTurnId),
    );
  }

  /**
   * Cancels the current run and reserves its replacement in one foreground mutation, so a
   * concurrent replacement or Stop cannot land between the cancel and the new run's start.
   */
  private async replaceRunInForegroundLane(
    agentId: string,
    prompt: AgentPromptInput,
    options: AgentRunOptions | undefined,
    promptStart?: ForegroundPromptStart,
    assertAdmission?: (agent: ActiveManagedAgent) => void,
  ): Promise<AsyncGenerator<AgentStreamEvent>> {
    // Replacements queue in arrival order; each one holds the foreground lane only while
    // it cancels and reserves, so Stop is never stuck behind a replacement that is waiting.
    return this.runQueuedMutation(this.replacementMutationTails, agentId, () =>
      this.replaceRunWhenAdmitted(agentId, prompt, options, promptStart, assertAdmission),
    );
  }

  private async replaceRunWhenAdmitted(
    agentId: string,
    prompt: AgentPromptInput,
    options: AgentRunOptions | undefined,
    promptStart?: ForegroundPromptStart,
    assertAdmission?: (agent: ActiveManagedAgent) => void,
  ): Promise<AsyncGenerator<AgentStreamEvent>> {
    let stalledStart: PendingForegroundRun | null = null;
    for (;;) {
      const admission = await this.runForegroundMutation(agentId, async () => {
        this.assertAcceptingAgentRuns();
        if (this.hierarchySessionUpdates.has(agentId) && !assertAdmission) {
          return {
            status: "reserved" as const,
            iterator: this.streamAgent(agentId, prompt, options),
          };
        }
        // Resolve the agent inside the lane: a reload while this send waited replaces it.
        const agent = this.requireSessionAgent(agentId);
        // A run that is still starting has no turn to interrupt yet. Canceling it would drop
        // its prompt, so wait for it outside the lane, where Stop can still reach it. A start
        // that outlasts the rescue timeout is canceled like any other run.
        const starting = this.runs.getPendingRun(agent.id);
        if (starting && starting.start.status !== "started" && starting !== stalledStart) {
          return { status: "starting" as const, run: starting };
        }
        assertAdmission?.(agent);
        if (!this.hasInFlightRun(agent.id)) {
          return {
            status: "reserved" as const,
            iterator: this.streamAgent(agent.id, prompt, options, promptStart),
          };
        }
        agent.pendingReplacement = true;
        agent.lifecycle = "running";
        this.touchUpdatedAt(agent);
        this.emitState(agent);
        try {
          const result = await this.cancelAgentRunNow(agent.id);
          if (result.status === "refused") {
            throw new AgentRunCancellationError(agent.id, "replace");
          }
          return {
            status: "reserved" as const,
            iterator: this.reserveAgentRun(agent.id, prompt, options, promptStart),
          };
        } catch (error) {
          agent.pendingReplacement = false;
          throw error;
        }
      });
      if (admission.status === "reserved") {
        return admission.iterator;
      }
      const started = await this.waitWithTimeout({
        operation: Promise.race([admission.run.turnStartedPromise, admission.run.settledPromise]),
        timeoutMs: this.rescueTimeouts.interruptSessionMs,
      });
      if (started === "timed_out") {
        stalledStart = admission.run;
      }
    }
  }

  private async recordAcceptedSteer(
    agent: ActiveManagedAgent,
    prompt: AgentPromptInput,
    clientMessageId: string | undefined,
    expectedTurnId: string,
    providerMessageId: string | undefined,
  ): Promise<void> {
    if (!clientMessageId) {
      return;
    }
    this.recordSubmittedPrompt(agent, prompt, clientMessageId, "accepted", {
      messageId: clientMessageId,
      turnId: expectedTurnId,
      ...(providerMessageId ? { providerMessageId } : {}),
    });
    this.emitState(agent);
  }

  async waitForAgentRunStart(agentId: string, options?: WaitForAgentStartOptions): Promise<void> {
    const snapshot = this.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const pendingRun = this.runs.getPendingRun(agentId);
    if (
      (snapshot.lifecycle === "running" || pendingRun?.start.status === "started") &&
      !snapshot.pendingReplacement
    ) {
      return;
    }

    if (!snapshot.activeForegroundTurnId && !pendingRun && !snapshot.pendingReplacement) {
      throw new Error(`Agent ${agentId} has no pending run`);
    }

    if (options?.signal?.aborted) {
      throw createAbortError(options.signal, "wait_for_agent_start aborted");
    }

    await new Promise<void>((resolvePromise, reject) => {
      if (options?.signal?.aborted) {
        reject(createAbortError(options.signal, "wait_for_agent_start aborted"));
        return;
      }

      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      const cleanup = () => {
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch {
            // ignore cleanup errors
          }
          unsubscribe = null;
        }
        if (abortHandler && options?.signal) {
          try {
            options.signal.removeEventListener("abort", abortHandler);
          } catch {
            // ignore cleanup errors
          }
          abortHandler = null;
        }
      };

      const finishOk = () => {
        cleanup();
        resolvePromise();
      };

      const finishErr = (error: unknown) => {
        cleanup();
        reject(error);
      };

      if (options?.signal) {
        abortHandler = () =>
          finishErr(createAbortError(options.signal, "wait_for_agent_start aborted"));
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      const checkCurrentState = () => {
        const current = this.getAgent(agentId);
        if (!current) {
          finishErr(new Error(`Agent ${agentId} not found`));
          return true;
        }

        const currentPendingRun = this.runs.getPendingRun(agentId);
        if (
          (current.lifecycle === "running" || currentPendingRun?.start.status === "started") &&
          !current.pendingReplacement
        ) {
          finishOk();
          return true;
        }

        if (currentPendingRun?.start.status === "failed") {
          finishErr(new Error(currentPendingRun.start.error));
          return true;
        }

        if (current.lifecycle === "error" && !currentPendingRun) {
          finishErr(new Error(current.lastError ?? `Agent ${agentId} failed to start`));
          return true;
        }

        if (!currentPendingRun && !current.activeForegroundTurnId && !current.pendingReplacement) {
          finishErr(new Error(`Agent ${agentId} run finished before starting`));
          return true;
        }

        return false;
      };

      unsubscribe = this.subscribe(
        (event) => {
          if (event.type !== "agent_state" || event.agent.id !== agentId) {
            return;
          }
          checkCurrentState();
        },
        { agentId, replayState: false },
      );

      checkCurrentState();
    });
  }

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    const agent = this.requireAgent(agentId);
    const request = agent.pendingPermissions.get(requestId);
    if (
      response.behavior === "allow" &&
      request &&
      isMainControlAgentLabels(agent.labels) &&
      isMainControlWritePermissionBlocked(request)
    ) {
      throw new Error(MAIN_CONTROL_WRITE_DENIAL);
    }
    if (agent.inFlightPermissionResponses.has(requestId)) {
      throw new Error("A response to this permission request is already being submitted");
    }
    agent.inFlightPermissionResponses.add(requestId);

    try {
      const result = await agent.session.respondToPermission(requestId, response);
      agent.pendingPermissions.delete(requestId);

      try {
        await this.refreshSessionState(agent);
      } catch {
        // Ignore refresh errors - state sync after permission approval is best effort.
      }

      this.touchUpdatedAt(agent);
      await this.persistSnapshot(agent);
      this.emitState(agent);

      const bufferedResolution = agent.bufferedPermissionResolutions.get(requestId);
      if (bufferedResolution) {
        agent.bufferedPermissionResolutions.delete(requestId);
        this.dispatchStream(agent.id, bufferedResolution, { timestamp: new Date().toISOString() });
      }

      return result;
    } finally {
      agent.inFlightPermissionResponses.delete(requestId);
      agent.bufferedPermissionResolutions.delete(requestId);
    }
  }

  async cancelAgentRun(agentId: string): Promise<AgentRunCancellationResult> {
    const cancellation = this.runForegroundMutation(agentId, () => {
      this.requireSessionAgent(agentId).pendingReplacement = false;
      return this.cancelAgentRunNow(agentId);
    });
    this.pendingCancellations.set(agentId, cancellation);
    try {
      return await cancellation;
    } finally {
      if (this.pendingCancellations.get(agentId) === cancellation) {
        this.pendingCancellations.delete(agentId);
      }
    }
  }

  private async cancelAgentRunNow(agentId: string): Promise<AgentRunCancellationResult> {
    const agent = this.requireSessionAgent(agentId);
    const run =
      this.runs.getRun(agentId) ??
      (agent.lifecycle === "running" ? this.runs.trackAutonomousRun(agentId, null) : null);
    if (!run) {
      return { status: "not_running" };
    }

    const interruptAcknowledged = await this.interruptSession(agent.session, agentId);
    const settlement = await this.waitWithTimeout({
      operation: run.settledPromise,
      timeoutMs: interruptAcknowledged
        ? INTERRUPT_SESSION_TIMEOUT_MS
        : this.rescueTimeouts.interruptSessionMs,
    });

    if (!interruptAcknowledged) {
      return { status: settlement === "completed" ? "settled" : "refused" };
    }

    const runTurnId = this.runs.getTurnId(agentId);
    if (settlement === "timed_out" && runTurnId) {
      this.logger.warn(
        { agentId, turnId: runTurnId, kind: run.kind },
        "cancelAgentRun: acknowledged turn still active after timeout, force-canceling",
      );
      await this.dispatchSessionEvent(agent, {
        type: "turn_canceled",
        provider: agent.provider,
        reason: "interrupted",
        turnId: runTurnId,
      });
      await run.settledPromise;
    } else if (settlement === "timed_out" && run.kind === "foreground") {
      this.logger.warn(
        { agentId, kind: run.kind },
        "cancelAgentRun: acknowledged pending turn still active after timeout, clearing it",
      );
      this.runs.settleForegroundRun(agentId, run.token);
      if (!agent.pendingReplacement) {
        agent.lifecycle = "idle";
        this.touchUpdatedAt(agent);
        this.emitState(agent);
      }
    } else if (settlement === "timed_out" && run.kind === "autonomous") {
      this.logger.warn(
        { agentId, kind: run.kind },
        "cancelAgentRun: acknowledged turn still active after timeout, force-canceling",
      );
      await this.dispatchSessionEvent(agent, {
        type: "turn_canceled",
        provider: agent.provider,
        reason: "interrupted",
      });
    }

    if (agent.pendingPermissions.size > 0) {
      this.resolvePendingPermissionsForAgent(agent, agent.provider, undefined, "Interrupted");
      this.touchUpdatedAt(agent);
      this.emitState(agent);
    }
    return { status: "settled" };
  }

  private async cancelAgentRunBefore(
    agentId: string,
    action: "reload" | "replace" | "rewind",
  ): Promise<void> {
    const result = await this.cancelAgentRun(agentId);
    if (result.status === "refused") {
      throw new AgentRunCancellationError(agentId, action);
    }
  }

  private async interruptSession(session: AgentSession, agentId: string): Promise<boolean> {
    try {
      const result = await this.waitWithTimeout({
        operation: session.interrupt(),
        timeoutMs: this.rescueTimeouts.interruptSessionMs,
        onLateError: (error) => {
          this.logger.warn(
            { err: error, agentId },
            "Session interrupt failed after timeout during cancel",
          );
        },
      });

      if (result === "timed_out") {
        this.logger.warn(
          { agentId, timeoutMs: this.rescueTimeouts.interruptSessionMs },
          "Timed out interrupting session during cancel",
        );
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error({ err: error, agentId }, "Failed to interrupt session");
      return false;
    }
  }

  getPendingPermissions(agentId: string): AgentPermissionRequest[] {
    const agent = this.requireSessionAgent(agentId);
    return Array.from(agent.pendingPermissions.values());
  }

  private peekPendingPermission(agent: ManagedAgent): AgentPermissionRequest | null {
    const iterator = agent.pendingPermissions.values().next();
    return iterator.done ? null : iterator.value;
  }

  /**
   * Hydrates the runtime timeline from provider history. No-ops if already hydrated.
   */
  async hydrateTimelineFromProvider(
    agentId: string,
    options?: HydrateTimelineOptions,
  ): Promise<void> {
    if (options?.whileRegistered) {
      return this.runLifecycleMutation(agentId, async () => {
        // Whichever operation entered the lane first gets to finish. An
        // archive that already closed this session wins over initial replay.
        const agent = this.agents.get(agentId);
        if (!agent) return;
        try {
          await this.hydrateTimelineFromLegacyProviderHistory(agent, options);
        } catch (error) {
          // Some temporary readers (such as Pi) shut down when history exits.
          // Discard a failed reader so the next load can open a fresh one.
          if (!agent.historyPrimed && this.historySessions.has(agent.session)) {
            await this.closeAgentRuntime(agentId).catch((closeError: unknown) => {
              this.logger.warn({ err: closeError, agentId }, "Failed to close history reader");
            });
          }
          throw error;
        }
      });
    }
    await this.hydrateTimelineFromLegacyProviderHistory(this.requireSessionAgent(agentId), options);
  }

  private buildPendingTimelinePrefix(
    rows: readonly AgentTimelineRow[],
    cache?: PendingContextHandoff,
  ): PersistedTimelinePrefix {
    const savedRows = retainTimelinePrefixRows(rows);
    const context = splitContextHandoff(savedRows);
    const olderSummary =
      context.olderDigest && context.olderDigest === cache?.context.olderDigest
        ? cache.prefix.pendingContextHandoff?.olderSummary
        : undefined;
    return {
      version: 1,
      rows: savedRows,
      pendingContextHandoff: context.recentTurns.length ? { olderSummary } : null,
    };
  }

  private installContextHandoff(
    agent: ActiveManagedAgent,
    prefix: PersistedTimelinePrefix | null | undefined,
  ): void {
    if (!prefix?.pendingContextHandoff || this.contextHandoffs.has(agent.id)) return;
    const context = splitContextHandoff(prefix.rows);
    if (!context.recentTurns.length) return;
    const handoff: PendingContextHandoff = { prefix, context };
    this.contextHandoffs.set(agent.id, handoff);
    if (context.olderDigest && !prefix.pendingContextHandoff.olderSummary) {
      this.startContextCompaction(agent, handoff);
    }
  }

  private startContextCompaction(agent: ActiveManagedAgent, handoff: PendingContextHandoff): void {
    const item = { type: "compaction", status: "loading", trigger: "auto" } as const;
    // A loading marker belongs only to this runtime, including when a durable store is installed.
    const row = this.timelineStore.append(agent.id, item);
    this.dispatchStream(
      agent.id,
      { type: "timeline", provider: agent.provider, item },
      {
        seq: row.seq,
        epoch: this.timelineStore.getEpoch(agent.id),
        timestamp: row.timestamp,
      },
    );
    const controller = new AbortController();
    handoff.controller = controller;
    handoff.compactionRow = row;
    const summary = summarizeContextHandoff(
      handoff.context,
      (prompt, signal) => this.summarizePriorConversation(agent, prompt, signal),
      controller,
    );
    handoff.summary = summary;
    this.trackBackgroundTask(
      summary
        .then(async (olderSummary) => {
          if (this.contextHandoffs.get(agent.id) !== handoff || !handoff.compactionRow)
            return undefined;
          return this.completeContextCompaction(agent.id, handoff, olderSummary);
        })
        .catch((err) => {
          this.logger.warn({ err, agentId: agent.id }, "Failed to persist context summary");
        }),
    );
  }

  private async summarizePriorConversation(
    agent: ActiveManagedAgent,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const adapter = this.adapterOf(agent.provider);
    const client = this.requireClient(agent.provider);
    const restrictions = this.contextSummaryRestrictions(adapter);
    if (!restrictions && client.capabilities.supportsToolInvocations) return "";
    const opening = client.createSession(
      {
        provider: agent.provider,
        model: agent.runtimeInfo?.model ?? agent.config.model,
        cwd: agent.cwd,
        internal: true,
        mcpServers: {},
        ...restrictions,
      },
      { mcpServers: {} },
      { persistSession: false },
    );
    const session = await waitForAbort(opening, signal);
    if (!session) {
      // Provider creation has no abort option. Dispose it if it returns after the deadline.
      void opening.then(
        (late) => this.closeUnregisteredSession(late),
        () => undefined,
      );
      return "";
    }
    try {
      signal.throwIfAborted();
      const result = await waitForAbort(session.run(prompt), signal);
      return result && !result.canceled ? result.finalText : "";
    } finally {
      await this.closeUnregisteredSession(session);
    }
  }

  private contextSummaryRestrictions(
    adapter: string,
  ): Pick<AgentSessionConfig, "modeId" | "providerOptions"> | undefined {
    switch (adapter) {
      case "codex":
        return {
          modeId: "read-only",
          providerOptions: { sandbox_mode: "read-only", approval_policy: "never" },
        };
      case "claude":
        return { modeId: "plan", providerOptions: { disallowedTools: ["*"] } };
      case "opencode":
        return { providerOptions: { permission: { "*": "deny" } } };
      case "pi":
        return { providerOptions: { mainControlReadOnly: true } };
      default:
        return undefined;
    }
  }

  private async completeContextCompaction(
    agentId: string,
    handoff: PendingContextHandoff,
    olderSummary: string,
  ): Promise<void> {
    const pending = handoff.prefix.pendingContextHandoff;
    const loading = handoff.compactionRow;
    if (!loading || !pending) return;
    handoff.compactionRow = undefined;
    const completed: AgentTimelineRow = {
      ...loading,
      item: { type: "compaction", status: "completed", trigger: "auto" },
    };
    pending.olderSummary = olderSummary;
    handoff.prefix.rows.push(completed);
    this.replaceContextCompactionRow(agentId, loading, completed);
    this.enqueueDurableTimelineAppend(agentId, completed);
    await this.timelinePrefixes.save(agentId, handoff.prefix);
  }

  private replaceContextCompactionRow(
    agentId: string,
    loading: AgentTimelineRow,
    completed?: AgentTimelineRow,
  ): void {
    if (!this.timelineStore.has(agentId)) return;
    const { seq } = this.timelineStore.getHead(agentId);
    const rows = this.timelineStore.getRows(agentId).flatMap((row) => {
      if (row.seq !== loading.seq) return [row];
      return completed ? [{ ...row, item: completed.item }] : [];
    });
    // Clients deduplicate replacement events by epoch.
    this.timelineStore.initialize(agentId, {
      rows,
      nextSeq: seq + 1,
      sealedThrough: this.timelineStore.getSealedThrough(agentId),
    });
    this.dispatch({
      type: "timeline_replacement",
      agentId,
      epoch: this.timelineStore.getEpoch(agentId),
    });
  }

  private async prepareContextForSend(agent: ActiveManagedAgent, handoff: PendingContextHandoff) {
    let summary = handoff.prefix.pendingContextHandoff?.olderSummary;
    if (summary == null && handoff.summary) {
      summary = await waitForContextSummary(handoff.summary);
      if (summary === undefined) {
        handoff.controller?.abort();
        summary = fallbackContextSummary(handoff.context);
        this.trackBackgroundTask(
          this.completeContextCompaction(agent.id, handoff, summary).catch((err) => {
            this.logger.warn(
              { err, agentId: agent.id },
              "Failed to persist fallback context summary",
            );
          }),
        );
      }
    }
    return buildContextHandoffEnvelope(handoff.context, summary);
  }

  private cancelContextHandoff(agentId: string): void {
    const handoff = this.contextHandoffs.get(agentId);
    if (!handoff) return;
    this.contextHandoffs.delete(agentId);
    handoff.controller?.abort();
    if (handoff.compactionRow) this.replaceContextCompactionRow(agentId, handoff.compactionRow);
  }

  private async consumeContextHandoff(agentId: string, handoff: PendingContextHandoff) {
    if (this.contextHandoffs.get(agentId) !== handoff) return;
    this.contextHandoffs.delete(agentId);
    await this.clearPersistedContextHandoff(agentId, handoff.prefix);
  }

  private async clearPersistedContextHandoff(agentId: string, prefix: PersistedTimelinePrefix) {
    await this.timelinePrefixes
      .save(agentId, { ...prefix, pendingContextHandoff: null })
      .catch((err) => {
        this.logger.warn({ err, agentId }, "Failed to clear persisted context handoff");
      });
  }

  async rewind(agentId: string, messageId: string, mode: RewindMode): Promise<void> {
    if (this.providerSwitches.has(agentId)) await this.waitForAgentClose(agentId);
    let agent = this.requireSessionAgent(agentId);
    if (this.historySessions.has(agent.session)) {
      agent = await this.ensureInteractiveSession(agentId);
    }
    // An interactive session must acquire its rewind lock without yielding.

    const submittedRow = this.timelineStore
      .getRows(agentId)
      .find(
        (row) =>
          row.item.type === "user_message" &&
          row.item.messageId === messageId &&
          row.item.clientMessageId === messageId,
      );
    if (submittedRow && !submittedRow.providerMessageId) {
      throw new Error("Cannot rewind before the provider acknowledges the submitted prompt");
    }
    const providerMessageId = submittedRow?.providerMessageId ?? messageId;

    if (this.hasInFlightRun(agentId)) {
      await this.cancelAgentRunBefore(agentId, "rewind");
    }

    const lock = this.runs.createPendingRun(agentId);
    try {
      this.logger.info(
        { agentId, provider: agent.provider, messageId, mode },
        "agent.rewind.start",
      );
      await invokeRewindCapability(agent.session, { messageId: providerMessageId, mode });
      if (mode !== "files") {
        await this.hydrateTimelineFromProvider(agentId, {
          force: true,
          broadcast: true,
          broadcastTimeline: false,
        });
        this.dispatch({
          type: "timeline_replacement",
          agentId,
          epoch: this.timelineStore.getEpoch(agentId),
        });
      }
      // Rewind stages provider events under the run lock; publish its final state directly.
      this.refreshSessionPersistence(agent);
      await this.refreshSessionState(agent, { emit: false });
      await this.persistSnapshot(agent);
      this.emitState(agent, { persist: false });
      this.logger.info(
        { agentId, provider: agent.provider, messageId, mode },
        "agent.rewind.complete",
      );
    } catch (error) {
      // Native rewind can commit a fork before history refresh fails. Recovery
      // must resume that latest handle rather than the abandoned conversation.
      this.refreshSessionPersistence(agent);
      await this.persistSnapshot(agent);
      this.logger.warn(
        { err: error, agentId, provider: agent.provider, messageId, mode },
        "agent.rewind.failed",
      );
      throw error;
    } finally {
      this.runs.settleForegroundRun(agentId, lock.token);
    }
  }

  async deleteAgentState(agentId: string): Promise<void> {
    this.discardRetainedAgentState(agentId);
    await this.timelinePrefixes.delete(agentId);
    await this.deleteCommittedTimeline(agentId);
  }

  notifyAgentRemoved(agent: Pick<StoredAgentRecord, "id" | "workspaceId" | "internal">): void {
    this.dispatch({
      type: "agent_removed",
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      internal: agent.internal === true,
    });
  }

  async deleteCommittedTimeline(agentId: string): Promise<void> {
    const store = this.durableTimelineStore;
    if (store) await this.writeDurableTimeline(agentId, () => store.deleteAgent(agentId));
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    if (!this.timelineStore.has(agentId)) {
      return (await this.durableTimelineStore?.getLastAssistantMessage(agentId)) ?? null;
    }
    return await this.getLastAssistantMessageFromStores(agentId);
  }

  async getCompletionAssistantMessage(
    agentId: string,
    snapshot: Pick<ManagedAgent, "activeTurnId" | "lastTurnCompletion" | "lastError"> | null,
    status: AgentLifecycleStatus,
    storedError?: string | null,
  ): Promise<string | null> {
    if (snapshot?.activeTurnId) {
      return this.getTurnAssistantMessage(agentId, snapshot.activeTurnId);
    }
    const completed = snapshot?.lastTurnCompletion;
    const failed =
      status === "error" || (status === "closed" && Boolean(snapshot?.lastError ?? storedError));
    if (completed && failed === (completed.event.type === "turn_failed")) {
      return completed.lastMessage;
    }
    // An older stored failure has no turn identity. Its historical last reply may
    // be from a different turn.
    return failed ? null : await this.getLastAssistantMessage(agentId);
  }

  private getTurnAssistantMessage(agentId: string, turnId: string | undefined): string | null {
    if (!turnId || !this.timelineStore.has(agentId)) return null;
    return (
      this.getLastAssistantMessageSegmentFromTimeline(
        this.timelineStore.getRows(agentId).filter((row) => row.turnId === turnId),
      )?.text ?? null
    );
  }

  private getLastAssistantMessageFromTimeline(
    timeline: readonly AgentTimelineItem[],
  ): string | null {
    return (
      this.getLastAssistantMessageSegmentFromTimeline(timeline.map((item) => ({ item })))?.text ??
      null
    );
  }

  private getLastAssistantMessageSegmentFromTimeline(
    timeline: readonly Pick<AgentTimelineRow, "item" | "turnId">[],
  ): { text: string; startsAtBeginning: boolean } | null {
    // Collect the chunks of the last assistant message (Claude streams chunks). A turn the
    // provider starts on its own has no user message before its reply.
    const chunks: string[] = [];
    let startsAtBeginning = false;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const { item } = timeline[i];
      if (chunks.length > 0 && !continuesAssistantMessage(timeline[i], timeline[i + 1])) {
        break;
      }
      if (item.type !== "assistant_message") continue;
      chunks.push(item.text);
      startsAtBeginning = i === 0;
    }

    if (!chunks.length) {
      return null;
    }

    return {
      text: chunks.toReversed().join(""),
      startsAtBeginning,
    };
  }

  private async getLastAssistantMessageFromStores(agentId: string): Promise<string | null> {
    const liveSegment = this.getLastAssistantMessageSegmentFromTimeline(
      this.timelineStore.getRows(agentId),
    );
    if (!this.durableTimelineStore) {
      return liveSegment?.text ?? null;
    }
    if (!liveSegment) {
      return await this.durableTimelineStore.getLastAssistantMessage(agentId);
    }
    if (!liveSegment.startsAtBeginning) {
      return liveSegment.text;
    }
    const lastDurableItem = await this.durableTimelineStore.getLastItem(agentId);
    if (lastDurableItem?.type !== "assistant_message") {
      return liveSegment.text;
    }
    const durableMessage = await this.durableTimelineStore.getLastAssistantMessage(agentId);
    return durableMessage ? `${durableMessage}${liveSegment.text}` : liveSegment.text;
  }

  private async getLastItemFromStores(agentId: string): Promise<AgentTimelineItem | null> {
    const lastLiveItem = this.timelineStore.getLastItem(agentId);
    return lastLiveItem ?? (await this.durableTimelineStore?.getLastItem(agentId)) ?? null;
  }

  async waitForAgentEvent(
    agentId: string,
    options?: WaitForAgentOptions,
  ): Promise<WaitForAgentResult> {
    const snapshot = this.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const pendingForegroundRun = this.runs.getPendingRun(agentId);
    const hasForegroundTurn =
      Boolean(snapshot.activeForegroundTurnId) || Boolean(pendingForegroundRun);
    const readResponse = (state: ManagedAgent, status: AgentLifecycleStatus) =>
      options?.completionResponse
        ? this.getCompletionAssistantMessage(agentId, state, status)
        : this.getLastAssistantMessage(agentId);
    const completionSnapshot = (state: ManagedAgent) =>
      options?.completionResponse ? { completionSnapshot: state } : {};

    const immediatePermission = this.peekPendingPermission(snapshot);
    if (immediatePermission) {
      return {
        status: snapshot.lifecycle,
        permission: immediatePermission,
        lastMessage: await readResponse(snapshot, snapshot.lifecycle),
        ...completionSnapshot(snapshot),
      };
    }

    const initialStatus = snapshot.lifecycle;
    const initialBusy = isAgentBusy(initialStatus) || hasForegroundTurn;
    const waitForActive = options?.waitForActive ?? false;
    if (!waitForActive && !initialBusy) {
      return {
        status: initialStatus,
        permission: null,
        lastMessage: await readResponse(snapshot, initialStatus),
        ...completionSnapshot(snapshot),
      };
    }
    if (waitForActive && !initialBusy && !hasForegroundTurn) {
      return {
        status: initialStatus,
        permission: null,
        lastMessage: await readResponse(snapshot, initialStatus),
        ...completionSnapshot(snapshot),
      };
    }

    if (options?.signal?.aborted) {
      throw createAbortError(options.signal, "wait_for_agent aborted");
    }

    return await new Promise<WaitForAgentResult>((resolvePromise, reject) => {
      // Bug #1 Fix: Check abort signal AGAIN inside Promise constructor
      // to avoid race condition between pre-Promise check and abort listener registration
      if (options?.signal?.aborted) {
        reject(createAbortError(options.signal, "wait_for_agent aborted"));
        return;
      }

      let currentStatus: AgentLifecycleStatus = initialStatus;
      let hasStarted =
        isAgentBusy(initialStatus) ||
        Boolean(snapshot.activeForegroundTurnId) ||
        pendingForegroundRun?.start.status === "started";
      let terminalStatusOverride: AgentLifecycleStatus | null = null;
      let finished = false;

      // Bug #3 Fix: Declare unsubscribe and abortHandler upfront so cleanup can reference them
      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      const cleanup = () => {
        // Clean up subscription
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch {
            // ignore cleanup errors
          }
          unsubscribe = null;
        }

        // Clean up abort listener
        if (abortHandler && options?.signal) {
          try {
            options.signal.removeEventListener("abort", abortHandler);
          } catch {
            // ignore cleanup errors
          }
          abortHandler = null;
        }
      };

      const finish = (permission: AgentPermissionRequest | null, state: ManagedAgent) => {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        const status = currentStatus;
        void readResponse(state, status)
          .then((lastMessage) => {
            resolvePromise({
              status,
              permission,
              lastMessage,
              ...completionSnapshot(state),
            });
            return;
          })
          .catch(reject);
      };

      // Bug #3 Fix: Set up abort handler BEFORE subscription
      // to ensure cleanup handlers exist before callback can fire
      if (options?.signal) {
        abortHandler = () => {
          cleanup();
          reject(createAbortError(options.signal, "wait_for_agent aborted"));
        };
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      // Bug #3 Fix: Now subscribe with cleanup handlers already in place
      // This prevents race condition if callback fires synchronously with replayState: true
      unsubscribe = this.subscribe(
        (event) => {
          if (event.type === "agent_state") {
            currentStatus = event.agent.lifecycle;
            const pending = this.peekPendingPermission(event.agent);
            if (pending) {
              finish(pending, event.agent);
              return;
            }
            if (isAgentBusy(event.agent.lifecycle)) {
              hasStarted = true;
              return;
            }
            if (!waitForActive || hasStarted) {
              if (terminalStatusOverride) {
                currentStatus = terminalStatusOverride;
              }
              finish(null, event.agent);
            }
            return;
          }

          if (event.type === "agent_stream") {
            if (event.event.type === "permission_requested") {
              finish(event.event.request, this.getAgent(agentId) ?? snapshot);
              return;
            }
            if (event.event.type === "turn_failed") {
              hasStarted = true;
              // Completion waits use the same state snapshot for status and reply.
              // A late failure for a different turn must not override it.
              if (!options?.completionResponse) terminalStatusOverride = "error";
              return;
            }
            if (event.event.type === "turn_completed") {
              hasStarted = true;
            }
            if (event.event.type === "turn_canceled") {
              hasStarted = true;
            }
          }
        },
        { agentId, replayState: true },
      );
      if (finished) cleanup();
    });
  }

  private async registerSession(
    session: AgentSession,
    openedConfig: AgentSessionConfig,
    agentId: string,
    options: {
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
      labels?: Record<string, string>;
      mainControlSystemPrompt?: string;
      metadata?: AgentMetadata;
      timeline?: AgentTimelineItem[];
      timelineRows?: AgentTimelineRow[];
      contextPrefix?: PersistedTimelinePrefix | null;
      timelineNextSeq?: number;
      persistence?: AgentPersistenceHandle;
      historyPrimed?: boolean;
      lastUsage?: AgentUsage;
      lastError?: string;
      attention?: AttentionState;
      /**
       * Bringing a known agent back, rather than starting a new one. Its timestamps and
       * attention come from what was already recorded, and installing the session is not
       * activity in it.
       */
      /**
       * The effective options the opening resolved before the session started. Registration
       * starts from these rather than reading the defaults again, which may have been edited
       * while the provider was opening.
       */
      launchedOptions: ProviderOptions;
      restoring?: boolean;
      initialTitle?: string | null;
      publishWhenReady?: boolean;
      workspaceId?: string;
      owner?: AgentOwner;
      background?: boolean;
      launchEnv?: Record<string, string>;
    },
  ): Promise<ManagedAgent> {
    let registered = false;
    try {
      this.assertAcceptingAgentRegistrations();
      const config = this.withOpenedOptions({ config: openedConfig, session });
      const resolvedAgentId = validateAgentId(agentId, "registerSession");
      if (this.agents.has(resolvedAgentId)) {
        throw new Error(`Agent with id ${resolvedAgentId} already exists`);
      }
      const initialPersistedTitle = await this.resolveInitialPersistedTitle(
        resolvedAgentId,
        config,
        options?.initialTitle ?? null,
      );

      const now = new Date();
      const { durableTimelineHasRows } = await this.initializeAgentTimelineForRegister({
        agentId: resolvedAgentId,
        now,
        options,
      });

      const managed = this.buildManagedAgentForRegister({
        resolvedAgentId,
        session,
        config,
        effectiveOptions: this.openedEffectiveOptions({
          session,
          launchedOptions: options.launchedOptions,
        }),
        now,
        durableTimelineHasRows,
        background: options?.background === true,
        options,
      });
      // Read history before publishing the agent: a provider failure must leave the
      // session unregistered so the registration catch closes it.
      const startupHistory: AgentStreamEvent[] = [];
      if (session.initialTimeline?.length && !managed.historyPrimed) {
        for await (const event of session.streamHistory()) {
          startupHistory.push(event);
        }
      }

      this.assertAcceptingAgentRegistrations();
      this.runtimeCleanupIdentities.set(session, Object.freeze({ openedAt: Date.now() }));
      this.agents.set(resolvedAgentId, managed);
      this.refreshIfMainControlChangedWhileOpening(managed, openedConfig);
      registered = true;
      // Initialize previousStatus to track transitions
      this.previousStatuses.set(resolvedAgentId, managed.lifecycle);
      if (session.initialTimeline?.length) {
        if (!managed.historyPrimed) {
          // Legacy/imported chats need their existing history before startup rows.
          await this.primeTimelineFromLegacyProviderHistory(managed, false, startupHistory);
        } else {
          for (const entry of buildImportedTimelineRows(session.initialTimeline)) {
            this.recordTimeline(managed.id, entry.item, { timestamp: entry.timestamp });
          }
        }
        this.refreshSessionPersistence(managed);
      }
      await this.refreshRuntimeInfo(managed, { emit: false });
      this.assertAgentRegistrationActive(managed);
      await this.persistSnapshot(managed, {
        title: initialPersistedTitle,
      });
      this.assertAgentRegistrationActive(managed);
      if (!options?.publishWhenReady) {
        this.emitState(managed, { persist: false });
      }

      await this.refreshSessionState(managed, { emit: false });
      this.assertAgentRegistrationActive(managed);
      managed.lifecycle = "idle";
      // Stamping now over a restored timestamp rewrote the workspace's "last used" in the
      // sidebar every time a chat was reopened, because workspace `statusEnteredAt` is
      // re-derived from persisted agent `updatedAt` on every daemon start.
      if (!options?.restoring) {
        this.touchUpdatedAt(managed);
      }
      await this.persistSnapshot(managed);
      this.assertAgentRegistrationActive(managed);
      this.emitState(managed, { persist: false });
      this.subscribeToSession(managed);
      await this.drainSessionEvents(managed.id);
      this.assertAgentRegistrationActive(managed);
      this.installContextHandoff(managed, options.contextPrefix);
      return { ...managed };
    } catch (error) {
      if (!registered) {
        await this.closeUnregisteredSession(session);
      }
      throw error;
    }
  }

  private assertAcceptingAgentRegistrations(): void {
    if (!this.acceptingAgentRegistrations) {
      throw new AgentManagerShuttingDownError();
    }
  }

  private assertAgentRegistrationActive(agent: ActiveManagedAgent): void {
    if (!this.acceptingAgentRegistrations || this.agents.get(agent.id) !== agent) {
      throw new AgentManagerShuttingDownError();
    }
  }

  private async closeUnregisteredSession(session: AgentSession): Promise<void> {
    try {
      await session.close();
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to close unregistered agent session");
    }
  }

  private async requireExternalMcpSupport(
    session: AgentSession,
    launchConfig: AgentSessionConfig,
    launchContext: AgentLaunchContext,
  ): Promise<void> {
    if (
      Object.keys(stripInternalPaseoMcpServer(launchConfig).mcpServers ?? {}).length === 0 ||
      session.capabilities.supportsMcpServers === true
    ) {
      return;
    }
    await this.closeUnregisteredSession(session);
    throw this.unsupportedMcpError(launchConfig, launchContext);
  }

  private unsupportedMcpError(config: AgentSessionConfig, context: AgentLaunchContext): Error {
    const owners = [...new Set(Object.values(context.mcpServerOwners ?? {}))];
    const source = owners.length ? ` (plugin ${owners.join(", ")})` : "";
    return new Error(`Provider '${config.provider}' does not support MCP servers${source}`);
  }

  private async initializeAgentTimelineForRegister(params: {
    agentId: string;
    now: Date;
    options:
      | {
          timeline?: AgentTimelineItem[];
          timelineRows?: AgentTimelineRow[];
          contextPrefix?: PersistedTimelinePrefix | null;
          timelineNextSeq?: number;
          persistence?: AgentPersistenceHandle;
          createdAt?: Date;
          updatedAt?: Date;
        }
      | undefined;
  }): Promise<{ durableTimelineHasRows: boolean }> {
    const { agentId, now, options } = params;
    const timelineAlreadyPrimed = this.timelineStore.has(agentId);
    const preserveExistingPrefix = timelineAlreadyPrimed && options?.contextPrefix;
    const explicitTimelineSeed = preserveExistingPrefix
      ? null
      : buildExplicitTimelineSeedForRegister(now, options);
    const shouldSeedFromDurable =
      !explicitTimelineSeed && !this.timelineStore.has(agentId) && this.durableTimelineStore;
    const durableTimelineSeed = shouldSeedFromDurable
      ? await this.loadCommittedTimelineSeed(agentId, now)
      : null;
    const durableTimelineHasRows =
      timelineAlreadyPrimed ||
      (durableTimelineSeed != null && (durableTimelineSeed.nextSeq ?? 1) > 1);
    const timelineSeed = explicitTimelineSeed ?? durableTimelineSeed;
    if (timelineSeed || !this.timelineStore.has(agentId)) {
      this.timelineStore.initialize(agentId, {
        timestamp: now.toISOString(),
        ...timelineSeed,
        sealedThrough: maxTimelineSeq(options?.contextPrefix?.rows ?? []),
      });
    }
    if (explicitTimelineSeed && options?.timelineRows?.length) {
      this.enqueueDurableTimelineBulkInsert(agentId, options.timelineRows);
    }
    return { durableTimelineHasRows };
  }

  private buildManagedAgentForRegister(params: {
    resolvedAgentId: string;
    session: AgentSession;
    config: AgentSessionConfig;
    effectiveOptions: ProviderOptions;
    now: Date;
    durableTimelineHasRows: boolean;
    background: boolean;
    options:
      | {
          createdAt?: Date;
          updatedAt?: Date;
          lastUserMessageAt?: Date | null;
          labels?: Record<string, string>;
          mainControlSystemPrompt?: string;
          metadata?: AgentMetadata;
          historyPrimed?: boolean;
          lastUsage?: AgentUsage;
          lastError?: string;
          attention?: AttentionState;
          persistence?: AgentPersistenceHandle;
          workspaceId?: string;
          owner?: AgentOwner;
          launchEnv?: Record<string, string>;
        }
      | undefined;
  }): ActiveManagedAgent {
    const {
      resolvedAgentId,
      session,
      config,
      effectiveOptions,
      now,
      durableTimelineHasRows,
      options,
    } = params;
    return {
      id: resolvedAgentId,
      provider: config.provider,
      providerAdapter: this.adapterOf(config.provider),
      cwd: config.cwd,
      workspaceId: options?.workspaceId,
      mainControlSystemPrompt: options?.mainControlSystemPrompt,
      owner: options?.owner,
      launchEnv: options?.launchEnv,
      session,
      capabilities: session.capabilities,
      config,
      // What the session opened with. Provider defaults edited later reach it when it next opens.
      effectiveOptions,
      runtimeInfo: undefined,
      lifecycle: "initializing",
      createdAt: options?.createdAt ?? now,
      updatedAt: options?.updatedAt ?? now,
      availableModes: [],
      currentModeId: null,
      pendingPermissions: new Map<string, AgentPermissionRequest>(),
      bufferedPermissionResolutions: new Map(),
      inFlightPermissionResponses: new Set(),
      pendingReplacement: false,
      activeForegroundTurnId: null,
      activeTurnId: null,
      activeTurnStartedAt: null,
      foregroundTurnWaiters: new Set<ForegroundTurnWaiter>(),
      finalizedForegroundTurnIds: new Set<string>(),
      unsubscribeSession: null,
      persistence: normalizePersistenceForConfig(
        options?.persistence ?? session.describePersistence(),
        config,
      ),
      historyPrimed:
        options?.historyPrimed ??
        (durableTimelineHasRows && !this.unprimedRetainedTimelines.has(resolvedAgentId)),
      lastUserMessageAt: options?.lastUserMessageAt ?? null,
      lastUsage: options?.lastUsage,
      lastError: options?.lastError,
      attention: resolveInitialAttention(options?.attention),
      internal: config.internal ?? false,
      background: params.background,
      ...agentEntityData(options),
    } as ActiveManagedAgent;
  }

  private async loadCommittedTimelineSeed(
    agentId: string,
    now: Date,
  ): Promise<SeedAgentTimelineOptions> {
    if (!this.durableTimelineStore) {
      return { timestamp: now.toISOString() };
    }
    return {
      nextSeq: (await this.durableTimelineStore.getLatestCommittedSeq(agentId)) + 1,
      timestamp: now.toISOString(),
    };
  }

  private prepareAgentForClosure(
    agent: LiveManagedAgent,
    cancelReason: string,
  ): ManagedAgentClosed {
    if (agent.historyPrimed) {
      this.unprimedRetainedTimelines.delete(agent.id);
    } else {
      this.unprimedRetainedTimelines.add(agent.id);
    }
    this.agentStreamCoalescer.flushAndDiscard(agent.id);
    this.agents.delete(agent.id);
    this.pendingHierarchySessionReloads.delete(agent.id);
    this.previousStatuses.delete(agent.id);
    if (agent.unsubscribeSession) {
      agent.unsubscribeSession();
      agent.unsubscribeSession = null;
    }
    this.runs.cancelWaiters(agent, (turnId) => ({
      type: "turn_canceled",
      provider: agent.provider,
      reason: cancelReason,
      turnId,
    }));
    this.runs.clearAgentRun(agent.id);
    return {
      ...agent,
      lifecycle: "closed",
      session: null,
      activeForegroundTurnId: null,
      activeTurnId: null,
      activeTurnStartedAt: null,
      pendingPermissions: new Map(),
      bufferedPermissionResolutions: new Map(),
      inFlightPermissionResponses: new Set(),
      pendingReplacement: false,
      foregroundTurnWaiters: new Set(),
      finalizedForegroundTurnIds: new Set(),
      unsubscribeSession: null,
    };
  }

  private discardRetainedAgentState(agentId: string): void {
    this.unprimedRetainedTimelines.delete(agentId);
    this.cancelContextHandoff(agentId);
    this.timelineStore.delete(agentId);
    this.paseoToolPolicies.delete(agentId);
    this.detachPluginTools(agentId);
    for (const event of this.providerSubagents.deleteParent(agentId)) {
      this.dispatch({ type: "provider_subagent", event });
    }
    this.clearProviderBackgroundWork(agentId);
  }

  private emitClosedAgent(agent: ManagedAgentClosed, options?: { persist?: boolean }): void {
    this.emitState(agent, options);
    if (!agent.internal) {
      this.pluginLifecycle?.emit("agent.close.after", {
        agent: describeHookAgent({ ...agent, title: agent.config.title }),
      });
    }
  }
  private subscribeToSession(agent: ActiveManagedAgent): void {
    if (agent.unsubscribeSession) {
      return;
    }
    const agentId = agent.id;
    const unsubscribe = agent.session.subscribe((event: AgentStreamEvent) => {
      this.enqueueSessionEvent(agentId, event);
    });
    agent.unsubscribeSession = unsubscribe;
  }

  private enqueueSessionEvent(agentId: string, event: AgentStreamEvent): void {
    this.logger.trace(
      {
        agentId,
        provider: event.provider,
        sessionId: this.agents.get(agentId)?.persistence?.sessionId ?? undefined,
        turnId: getAgentStreamEventTurnId(event),
        event,
      },
      "agent.manager.enqueue",
    );
    const steerBarrier = this.steerEventBarriers.get(agentId);
    if (steerBarrier) {
      steerBarrier.events.push(event);
      return;
    }
    const pendingRun = this.runs.getPendingRun(agentId);
    if (pendingRun?.start.status === "pending") {
      pendingRun.stagedEvents.push(event);
      return;
    }
    const previous = this.sessionEventTails.get(agentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const current = this.agents.get(agentId);
        if (!current) {
          return;
        }
        if (current.session == null) {
          return;
        }
        this.logger.trace(
          {
            agentId,
            provider: event.provider,
            sessionId: current.persistence?.sessionId ?? undefined,
            turnId: getAgentStreamEventTurnId(event),
            event,
          },
          "agent.manager.dequeue",
        );
        await this.dispatchSessionEvent(current, event);
        return;
      })
      .catch((err) => {
        this.logger.error(
          { err, agentId, eventType: event.type },
          "Failed to process session event",
        );
      });

    this.sessionEventTails.set(agentId, next);
    this.trackBackgroundTask(next);
    void next.finally(() => {
      if (this.sessionEventTails.get(agentId) === next) {
        this.sessionEventTails.delete(agentId);
      }
    });
  }

  /**
   * Provider mutations may synchronously emit config events that are processed through the
   * asynchronous session queue. Apply those events before committing the mutation's explicit
   * manager state so call order remains authoritative.
   */
  private async drainSessionEvents(agentId: string): Promise<void> {
    while (true) {
      const tail = this.sessionEventTails.get(agentId);
      if (!tail) {
        return;
      }
      await tail;
      if (this.sessionEventTails.get(agentId) === tail) {
        return;
      }
    }
  }

  private async dispatchSessionEvent(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
  ): Promise<void> {
    if (event.type === "provider_subagent") {
      const update = this.providerSubagents.apply(agent.id, event.provider, event.event);
      this.dispatch({ type: "provider_subagent", event: update });
      return;
    }
    if (event.type === "background_work") {
      const items =
        event.items === null
          ? this.backgroundWork.clear(agent.id)
          : this.backgroundWork.apply(agent.id, event.items);
      this.publishBackgroundWork(agent.id, items);
      return;
    }
    // Resolve notice membership before selecting the foreground run's waiters.
    if (event.type === "timeline" && event.item.type === "notification") {
      event = attachManagedTurnIdentity(agent, event, false).event;
    }
    const turnId = getAgentStreamEventTurnId(event);
    const matchingWaiters = this.runs.getMatchingWaiters(agent, turnId);
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        matchingWaiterCount: matchingWaiters.length,
        event,
      },
      "agent.manager.dispatch_session_event",
    );

    const shouldNotifyWaiters = await this.handleStreamEvent(agent, event);

    if (!shouldNotifyWaiters) {
      return;
    }

    this.runs.notifyWaiters(matchingWaiters, event, {
      terminal: isTurnTerminalEvent(event),
    });
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        notifiedWaiterCount: matchingWaiters.length,
        terminal: isTurnTerminalEvent(event),
        event,
      },
      "agent.manager.notify_waiters",
    );
  }

  private async resolveInitialPersistedTitle(
    agentId: string,
    config: AgentSessionConfig,
    fallbackTitle: string | null,
  ): Promise<string | null> {
    const existing = await this.registry?.get(agentId);
    if (existing) {
      return existing.title ?? null;
    }
    const explicitTitle =
      typeof config.title === "string" && config.title.trim().length > 0
        ? config.title.trim()
        : null;
    return explicitTitle ?? fallbackTitle;
  }

  private async persistSnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null; internal?: boolean; timelinePrefixSwitchId?: string | null },
  ): Promise<void> {
    if (!this.registry) {
      return;
    }
    // Don't persist internal agents - they're ephemeral system tasks
    if (agent.internal) {
      return;
    }
    // A provider snapshot written during the move must use the final live
    // workspace, whether the staged write committed or failed.
    const pendingMove = this.pendingSubagentMoveSnapshots.get(agent.id);
    if (pendingMove) await pendingMove.catch(() => undefined);
    await this.registry.applySnapshot(agent, options);
  }

  private requireRegistry(): AgentStorage {
    if (!this.registry) {
      throw new Error("Agent storage unavailable");
    }
    return this.registry;
  }

  /**
   * Provider-side mode switches (ACP current_mode_update, in-session
   * commands, permission-driven transitions) must land in config.modeId too —
   * reloadAgentSession and the persisted record derive the resumed session's
   * mode from it, so leaving it stale silently downgrades the mode on resume.
   */
  private applyObservedMode(agent: ActiveManagedAgent, modeId: string | null): void {
    agent.currentModeId = modeId;
    if (modeId != null) {
      agent.config.modeId = modeId;
    }
  }

  private async refreshSessionState(
    agent: ActiveManagedAgent,
    options?: { emit?: boolean },
  ): Promise<void> {
    try {
      const modes = await agent.session.getAvailableModes();
      agent.availableModes = modes;
    } catch {
      agent.availableModes = [];
    }

    try {
      this.applyObservedMode(agent, await agent.session.getCurrentMode());
    } catch {
      agent.currentModeId = null;
    }

    try {
      const pending = agent.session.getPendingPermissions();
      agent.pendingPermissions = new Map(pending.map((request) => [request.id, request]));
    } catch {
      agent.pendingPermissions.clear();
    }

    this.syncControls(agent);
    await this.refreshRuntimeInfo(agent, options);
  }

  private async refreshRuntimeInfo(
    agent: ActiveManagedAgent,
    options?: { emit?: boolean },
  ): Promise<void> {
    try {
      const newInfo = await agent.session.getRuntimeInfo();
      const changed =
        newInfo.model !== agent.runtimeInfo?.model ||
        newInfo.thinkingOptionId !== agent.runtimeInfo?.thinkingOptionId ||
        newInfo.sessionId !== agent.runtimeInfo?.sessionId ||
        newInfo.modeId !== agent.runtimeInfo?.modeId;
      agent.runtimeInfo = newInfo;
      if (!agent.persistence && newInfo.sessionId) {
        agent.persistence = normalizePersistenceForConfig(
          { provider: agent.provider, sessionId: newInfo.sessionId },
          agent.config,
        );
      }
      // Emit state if runtimeInfo changed so clients get the updated model
      if (changed && options?.emit !== false) {
        this.emitState(agent);
      }
    } catch {
      // Keep existing runtimeInfo if refresh fails.
    }
  }

  private async hydrateTimelineFromLegacyProviderHistory(
    agent: ActiveManagedAgent,
    options?: HydrateTimelineOptions,
  ): Promise<void> {
    if (agent.historyPrimed && !options?.force) {
      return;
    }

    const broadcast = options?.broadcast ?? false;
    const broadcastTimeline = options?.broadcastTimeline ?? broadcast;

    if (options?.force) {
      await this.forceHydrateTimelineFromLegacyProviderHistory(
        agent,
        typeof broadcast === "function" ? broadcast() : broadcast,
        typeof broadcastTimeline === "function" ? broadcastTimeline() : broadcastTimeline,
      );
      return;
    }

    await this.primeTimelineFromLegacyProviderHistory(agent, broadcast);
  }

  private async forceHydrateTimelineFromLegacyProviderHistory(
    agent: ActiveManagedAgent,
    broadcast: boolean,
    broadcastTimeline: boolean,
  ): Promise<void> {
    const historyEvents: Extract<AgentStreamEvent, { type: "timeline" }>[] = [];
    const providerSubagentEvents: Extract<AgentStreamEvent, { type: "provider_subagent" }>[] = [];
    let deliveredHandoff = false;
    for await (const rawEvent of agent.session.streamHistory()) {
      deliveredHandoff ||= replayIncludesContextHandoff(rawEvent, agent.id);
      const event = limitAgentStreamEventContent(rawEvent, agent.id);
      if (event.type === "timeline") {
        for (const item of projectAgentMessages(event.item)) {
          historyEvents.push({ ...event, item });
        }
      } else if (event.type === "provider_subagent") {
        providerSubagentEvents.push(event);
      }
    }

    this.agentStreamCoalescer.flushAndDiscard(agent.id);
    this.cancelContextHandoff(agent.id);
    await this.deleteCommittedTimeline(agent.id);
    this.timelineStore.delete(agent.id);
    this.timelineStore.initialize(agent.id, { timestamp: new Date().toISOString() });
    const prefix = await this.seedTimelinePrefix(agent.id);
    agent.historyPrimed = true;

    for (const event of this.providerSubagents.deleteParent(agent.id)) {
      if (broadcast) {
        this.dispatch({ type: "provider_subagent", event });
      }
    }
    for (const event of providerSubagentEvents) {
      const update = this.providerSubagents.apply(agent.id, event.provider, event.event);
      if (broadcast) {
        this.dispatch({ type: "provider_subagent", event: update });
      }
    }
    for (const event of this.excludePrefixReplay(prefix, historyEvents)) {
      const row = this.recordTimeline(
        agent.id,
        event.item,
        event.timestamp ? { timestamp: event.timestamp } : undefined,
      );
      if (broadcastTimeline) {
        this.dispatchStream(
          agent.id,
          { ...event, item: row.item },
          {
            seq: row.seq,
            epoch: this.timelineStore.getEpoch(agent.id),
            timestamp: row.timestamp,
          },
        );
      }
    }
    await this.restoreContextAfterReplay(agent, prefix, deliveredHandoff);
    this.touchUpdatedAt(agent);
    this.emitState(agent);
  }

  private async primeTimelineFromLegacyProviderHistory(
    agent: ActiveManagedAgent,
    broadcast: boolean | (() => boolean),
    history:
      | AsyncIterable<AgentStreamEvent>
      | Iterable<AgentStreamEvent> = agent.session.streamHistory(),
  ): Promise<void> {
    const deferredBroadcast = typeof broadcast === "function";
    const historyEvents: Extract<AgentStreamEvent, { type: "timeline" }>[] = [];
    const historySubagentEvents: Extract<AgentStreamEvent, { type: "provider_subagent" }>[] = [];
    let deliveredHandoff = false;
    agent.historyPrimed = false;
    try {
      // Collect the whole replay before touching either store. A stream that fails
      // halfway then leaves the committed timeline as it was, instead of a partial
      // copy the next attempt would append to.
      for await (const rawEvent of history) {
        deliveredHandoff ||= replayIncludesContextHandoff(rawEvent, agent.id);
        const event = limitAgentStreamEventContent(rawEvent, agent.id);
        if (event.type === "provider_subagent") {
          historySubagentEvents.push(event);
          continue;
        }
        if (event.type !== "timeline") {
          continue;
        }
        for (const item of projectAgentMessages(event.item)) {
          historyEvents.push({ ...event, item });
        }
      }
    } catch (error) {
      this.logger.warn({ err: error, agentId: agent.id }, "Failed to hydrate provider history");
      throw error;
    }

    // The replay is the timeline, so drop the rows a previous hydration committed.
    // Keeping them would leave getTimelineRows reading one copy per hydration.
    await this.deleteCommittedTimeline(agent.id);
    const prefix = await this.seedTimelinePrefix(agent.id);

    const timelineEvents: Array<{
      event: Extract<AgentStreamEvent, { type: "timeline" }>;
      row: AgentTimelineRow;
    }> = [];
    const providerSubagentEvents: AgentManagerEvent[] = [];
    for (const event of historySubagentEvents) {
      const update = this.providerSubagents.apply(agent.id, event.provider, event.event);
      const managerEvent: AgentManagerEvent = { type: "provider_subagent", event: update };
      if (deferredBroadcast) {
        providerSubagentEvents.push(managerEvent);
      } else if (broadcast) {
        this.dispatch(managerEvent);
      }
    }
    for (const event of this.excludePrefixReplay(prefix, historyEvents)) {
      const row = this.recordTimeline(
        agent.id,
        event.item,
        event.timestamp ? { timestamp: event.timestamp } : undefined,
      );
      if (deferredBroadcast) {
        timelineEvents.push({ event, row });
      } else if (broadcast) {
        this.dispatchStream(
          agent.id,
          { ...event, item: row.item },
          {
            seq: row.seq,
            epoch: this.timelineStore.getEpoch(agent.id),
            timestamp: row.timestamp,
          },
        );
      }
    }
    agent.historyPrimed = true;
    await this.restoreContextAfterReplay(agent, prefix, deliveredHandoff);

    if (typeof broadcast !== "function" || !broadcast()) {
      return;
    }
    for (const event of providerSubagentEvents) {
      this.dispatch(event);
    }
    for (const { event, row } of timelineEvents) {
      this.dispatchStream(
        agent.id,
        { ...event, item: row.item },
        {
          seq: row.seq,
          epoch: this.timelineStore.getEpoch(agent.id),
          timestamp: row.timestamp,
        },
      );
    }
  }

  private async seedTimelinePrefix(agentId: string): Promise<PersistedTimelinePrefix | null> {
    const prefix = await this.timelinePrefixes.load(agentId);
    if (!prefix?.rows.length) return prefix;
    const current = this.timelineStore.getRows(agentId);
    const { epoch, seq } = this.timelineStore.getHead(agentId);
    const retained = new Set(current.map((row) => row.seq));
    const rows = [...prefix.rows.filter((row) => !retained.has(row.seq)), ...current];
    this.timelineStore.initialize(agentId, {
      rows,
      epoch,
      nextSeq: seq + 1,
      sealedThrough: maxTimelineSeq(prefix.rows),
    });
    this.enqueueDurableTimelineBulkInsert(agentId, prefix.rows);
    return prefix;
  }

  private excludePrefixReplay(
    prefix: PersistedTimelinePrefix | null,
    events: Extract<AgentStreamEvent, { type: "timeline" }>[],
  ): Extract<AgentStreamEvent, { type: "timeline" }>[] {
    if (!prefix?.rows.length) return events;
    const replayedTextById = new Map<string, Set<string>>();
    for (const { item } of prefix.rows) {
      const id = timelineMessageId(item);
      const text = timelineMessageText(item);
      if (!id || text === undefined) continue;
      const matched = replayedTextById.get(id) ?? new Set<string>();
      matched.add(text);
      replayedTextById.set(id, matched);
    }
    return events.filter(({ item }) => {
      const id = timelineMessageId(item);
      return !id || !replayedTextById.get(id)?.has(timelineMessageText(item)!);
    });
  }

  private async restoreContextAfterReplay(
    agent: ActiveManagedAgent,
    prefix: PersistedTimelinePrefix | null,
    deliveredHandoff: boolean,
  ): Promise<void> {
    if (!prefix?.pendingContextHandoff) return;
    if (deliveredHandoff) {
      await this.clearPersistedContextHandoff(agent.id, prefix);
    } else {
      this.installContextHandoff(agent, prefix);
    }
  }

  private notifyForegroundTurnWaiters(agentId: string, event: AgentStreamEvent): void {
    const turnId = getAgentStreamEventTurnId(event);
    if (turnId == null) {
      return;
    }

    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }

    this.runs.notifyAgentWaiters(agent, event);
    this.logger.trace(
      {
        agentId,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        event,
      },
      "agent.manager.notify_waiters.coalesced",
    );
  }

  private async handleStreamEvent(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    options?: HandleStreamEventOptions,
  ): Promise<boolean> {
    event = limitAgentStreamEventContent(event, agent.id);
    const identified = attachManagedTurnIdentity(agent, event, options?.fromHistory === true);
    event = identified.event;
    const eventTurnId = identified.turnId;
    const isForegroundEvent = agent.activeForegroundTurnId === eventTurnId;
    this.traceHandleStreamEventStart(agent, event, eventTurnId, isForegroundEvent);
    if (
      eventTurnId &&
      isTurnTerminalEvent(event) &&
      this.runs.hasFinalizedTurn(agent, eventTurnId) &&
      this.runs.getTurnId(agent.id) !== eventTurnId
    ) {
      return false;
    }

    // Only update timestamp for live events, not history replay
    if (!options?.fromHistory) {
      this.touchUpdatedAt(agent);
      if (this.agentStreamCoalescer.handle(agent.id, event)) {
        this.traceCoalescerBuffered(agent, event, eventTurnId);
        return false;
      }
      this.agentStreamCoalescer.flushFor(agent.id);
    }

    if (event.type === "assistant_messages_removed") {
      await this.removeAssistantMessages(agent.id, event);
      return false;
    }

    let terminalDisposition: ActiveTurnTerminalDisposition = "untracked";
    if (isTurnTerminalEvent(event)) {
      terminalDisposition = this.applyActiveTurnTerminal(
        agent,
        eventTurnId,
        options?.fromHistory === true,
      );
      if (terminalDisposition !== "stale") {
        // Capture the remaining reply before publishing state or starting another turn.
        agent.lastTurnCompletion = {
          event,
          lastMessage: this.getTurnAssistantMessage(agent.id, eventTurnId),
        };
      }
    }

    const flags: StreamEventFlags = { shouldDispatchEvent: true, shouldNotifyWaiters: true };

    const dispatchPromise = this.dispatchStreamEventByType({
      agent,
      event,
      options,
      isForegroundEvent,
      eventTurnId,
      terminalDisposition,
      flags,
    });
    if (dispatchPromise) {
      await dispatchPromise;
    }

    if (!options?.fromHistory) {
      if (isTurnTerminalEvent(event)) {
        this.runs.settleTerminalRun(agent.id, eventTurnId);
        this.publishTerminalReadiness(agent, eventTurnId, isForegroundEvent, terminalDisposition);
      }

      if (flags.shouldDispatchEvent) {
        this.dispatchStream(agent.id, event, { timestamp: new Date().toISOString() });
      }
    }

    this.traceHandleStreamEventEnd(agent, event, eventTurnId, flags);

    return flags.shouldNotifyWaiters;
  }

  private publishTerminalReadiness(
    agent: ActiveManagedAgent,
    turnId: string | undefined,
    isForegroundEvent: boolean,
    disposition: ActiveTurnTerminalDisposition,
  ): void {
    if (isForegroundEvent) {
      this.finalizeForegroundTurn(agent, turnId);
    } else if (disposition !== "stale" && !agent.activeForegroundTurnId) {
      // Publish autonomous readiness only after the tracked run has settled.
      this.emitState(agent);
    }
  }

  private traceHandleStreamEventStart(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    turnId: string | undefined,
    isForegroundEvent: boolean,
  ): void {
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        isForegroundEvent,
        event,
      },
      "agent.manager.handle_stream_event.start",
    );
  }

  private traceCoalescerBuffered(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    turnId: string | undefined,
  ): void {
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        event,
      },
      "agent.manager.coalescer.buffer",
    );
  }

  private traceHandleStreamEventEnd(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    turnId: string | undefined,
    flags: StreamEventFlags,
  ): void {
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        shouldDispatchEvent: flags.shouldDispatchEvent,
        shouldNotifyWaiters: flags.shouldNotifyWaiters,
        event,
      },
      "agent.manager.handle_stream_event.end",
    );
  }

  private onStreamOptionsChanged(params: {
    agent: ActiveManagedAgent;
    patch: ProviderOptionsPatch;
    flags: StreamEventFlags;
  }): void {
    const { agent, patch, flags } = params;
    this.storeOptionsPatch({ agent, patch });
    this.updateEffectiveOptions({ agent, sent: {}, reported: patch });
    flags.shouldDispatchEvent = false;
    this.emitState(agent);
  }

  private dispatchStreamEventByType(params: {
    agent: ActiveManagedAgent;
    event: AgentStreamEvent;
    options: HandleStreamEventOptions | undefined;
    isForegroundEvent: boolean;
    eventTurnId: string | undefined;
    terminalDisposition: ActiveTurnTerminalDisposition;
    flags: StreamEventFlags;
  }): Promise<void> | undefined {
    const { agent, event, options, isForegroundEvent, eventTurnId, terminalDisposition, flags } =
      params;
    switch (event.type) {
      case "thread_started":
        this.onStreamThreadStarted(agent);
        return undefined;
      case "usage_updated":
        agent.lastUsage = event.usage;
        this.emitState(agent);
        return undefined;
      case "mode_changed":
        this.applyObservedMode(agent, event.currentModeId);
        agent.availableModes = event.availableModes;
        if (agent.runtimeInfo) {
          agent.runtimeInfo = { ...agent.runtimeInfo, modeId: event.currentModeId };
        }
        flags.shouldDispatchEvent = false;
        this.emitState(agent);
        return undefined;
      case "model_changed":
        agent.runtimeInfo = event.runtimeInfo;
        if (!agent.persistence && event.runtimeInfo.sessionId) {
          agent.persistence = normalizePersistenceForConfig(
            { provider: agent.provider, sessionId: event.runtimeInfo.sessionId },
            agent.config,
          );
        }
        this.applyObservedMode(agent, event.runtimeInfo.modeId ?? agent.currentModeId);
        flags.shouldDispatchEvent = false;
        this.emitState(agent);
        return undefined;
      case "thinking_option_changed":
        agent.config.thinkingOptionId = event.thinkingOptionId ?? undefined;
        if (agent.runtimeInfo) {
          agent.runtimeInfo = {
            ...agent.runtimeInfo,
            thinkingOptionId: event.thinkingOptionId,
          };
        }
        flags.shouldDispatchEvent = false;
        this.emitState(agent);
        return undefined;
      case "options_changed":
        this.onStreamOptionsChanged({ agent, patch: event.patch, flags });
        return undefined;
      case "timeline":
        return this.onStreamTimelineEvent({ agent, event, options, flags });
      case "turn_completed":
        this.onStreamTurnCompleted({
          agent,
          event,
          eventTurnId,
          isForegroundEvent,
          terminalDisposition,
        });
        return undefined;
      case "turn_failed":
        return this.onStreamTurnFailed({
          agent,
          event,
          eventTurnId,
          isForegroundEvent,
          terminalDisposition,
          options,
        });
      case "turn_canceled":
        this.onStreamTurnCanceled({
          agent,
          event,
          eventTurnId,
          isForegroundEvent,
          terminalDisposition,
          options,
        });
        return undefined;
      case "turn_started":
        this.onStreamTurnStarted({ agent, eventTurnId, isForegroundEvent, flags });
        return undefined;
      case "permission_requested":
        this.onStreamPermissionRequested(agent, event, options, flags);
        return undefined;
      case "permission_resolved":
        this.onStreamPermissionResolved({ agent, event, options, flags });
        return undefined;
      default:
        return undefined;
    }
  }

  private onStreamThreadStarted(agent: ActiveManagedAgent): void {
    const previousSessionId = agent.persistence?.sessionId ?? null;
    this.refreshSessionPersistence(agent);
    if (agent.persistence?.sessionId !== previousSessionId) {
      this.emitState(agent);
    }
    void this.refreshRuntimeInfo(agent);
  }

  private refreshSessionPersistence(agent: ActiveManagedAgent): void {
    const handle = agent.session.describePersistence();
    if (handle) {
      agent.persistence = normalizePersistenceForConfig(handle, agent.config);
    }
  }

  private async removeAssistantMessages(
    agentId: string,
    event: Extract<AgentStreamEvent, { type: "assistant_messages_removed" }>,
  ): Promise<void> {
    const { turnId, messageIds } = event;
    if (!turnId || messageIds.length === 0) return;
    const store = this.durableTimelineStore;
    if (store) {
      await this.writeDurableTimeline(agentId, () =>
        store.removeAssistantMessages(agentId, turnId, messageIds),
      );
    }
    if (!this.timelineStore.removeAssistantMessages(agentId, turnId, messageIds)) return;
    this.dispatch({
      type: "timeline_replacement",
      agentId,
      epoch: this.timelineStore.getEpoch(agentId),
    });
  }

  private async onStreamTimelineEvent(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "timeline" }>;
    options: { fromHistory?: boolean } | undefined;
    flags: StreamEventFlags;
  }): Promise<void> {
    const { agent, event, options, flags } = params;

    flags.shouldDispatchEvent = false;
    flags.shouldNotifyWaiters = false;
    for (const item of projectAgentMessages(event.item)) {
      if (
        item.type === "user_message" &&
        item.clientMessageId &&
        this.reconcileSubmittedPromptEcho(agent, item, event.turnId)
      )
        continue;

      if (options?.fromHistory) {
        this.recordTimeline(
          agent.id,
          item,
          event.timestamp ? { timestamp: event.timestamp } : undefined,
        );
        continue;
      }

      this.recordAndDispatchTimelineItem(agent.id, item, event.provider, event.turnId);
      if (item.type === "user_message") {
        agent.lastUserMessageAt = new Date();
        this.emitState(agent);
      }
      flags.shouldNotifyWaiters = true;
    }
  }

  private onStreamTurnCompleted(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "turn_completed" }>;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    terminalDisposition: ActiveTurnTerminalDisposition;
  }): void {
    const { agent, event, eventTurnId, isForegroundEvent, terminalDisposition } = params;
    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: eventTurnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
      },
      "agent.manager.turn.completed",
    );
    if (terminalDisposition === "stale") return;
    if (event.usage) {
      agent.lastUsage = { ...agent.lastUsage, ...event.usage };
    }
    // If no usage on turn_completed, keep lastUsage as-is so context window
    // data accumulated during streaming isn't lost when the provider omits
    // it from the completion event.
    agent.lastError = undefined;
    if (
      !isForegroundEvent &&
      !agent.activeForegroundTurnId &&
      agent.lifecycle !== "idle" &&
      !agent.pendingReplacement
    ) {
      (agent as ActiveManagedAgent).lifecycle = "idle";
    }
    void this.refreshRuntimeInfo(agent);
  }

  private async onStreamTurnFailed(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "turn_failed" }>;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    terminalDisposition: ActiveTurnTerminalDisposition;
    options: { fromHistory?: boolean } | undefined;
  }): Promise<void> {
    const { agent, event, eventTurnId, isForegroundEvent, terminalDisposition, options } = params;
    this.logger.warn(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: eventTurnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        eventTurnId,
        error: event.error,
        code: event.code,
        diagnostic: event.diagnostic,
      },
      "handleStreamEvent: turn_failed",
    );
    if (terminalDisposition === "stale") return;
    if (!isForegroundEvent && !agent.activeForegroundTurnId) {
      agent.lifecycle = "error";
    }
    agent.lastError = event.error;
    await this.appendSystemErrorTimelineMessage(
      agent,
      event.provider,
      this.formatTurnFailedMessage(event),
      options,
    );
    this.resolvePendingPermissionsForAgent(agent, event.provider, options, "Turn failed");
  }

  private onStreamTurnCanceled(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "turn_canceled" }>;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    terminalDisposition: ActiveTurnTerminalDisposition;
    options:
      | {
          fromHistory?: boolean;
        }
      | undefined;
  }): void {
    const { agent, event, eventTurnId, isForegroundEvent, terminalDisposition, options } = params;
    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: eventTurnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        eventTurnId,
      },
      "agent.manager.turn.canceled",
    );
    if (terminalDisposition === "stale") return;
    if (!isForegroundEvent && !agent.activeForegroundTurnId && !agent.pendingReplacement) {
      agent.lifecycle = "idle";
    }
    agent.lastError = undefined;
    this.resolvePendingPermissionsForAgent(agent, event.provider, options, "Interrupted");
  }

  private onStreamTurnStarted(params: {
    agent: ActiveManagedAgent;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    flags: StreamEventFlags;
  }): void {
    const { agent, eventTurnId, isForegroundEvent, flags } = params;
    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: eventTurnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
      },
      "agent.manager.turn.started",
    );
    if (isForegroundEvent) {
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      return;
    }
    if (agent.activeForegroundTurnId) {
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      return;
    }
    this.runs.trackAutonomousRun(agent.id, eventTurnId ?? null);
    if (eventTurnId) {
      this.openActiveTurn(agent, eventTurnId, new Date());
    }
    agent.lastError = undefined;
    // Nobody read the agent, so an unread finish stays unread. Clearing it would make every
    // turn the agent starts on its own, such as a reaction to background output, notify again.
    if (agent.attention.requiresAttention && agent.attention.attentionReason === "error") {
      agent.attention = { requiresAttention: false };
    }
    agent.lifecycle = "running";
    this.emitState(agent);
  }

  private onStreamPermissionRequested(
    agent: ActiveManagedAgent,
    event: Extract<AgentStreamEvent, { type: "permission_requested" }>,
    options: HandleStreamEventOptions | undefined,
    flags: StreamEventFlags,
  ): void {
    if (
      !options?.fromHistory &&
      isMainControlAgentLabels(agent.labels) &&
      isMainControlWritePermissionBlocked(event.request)
    ) {
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      agent.pendingPermissions.set(event.request.id, event.request);
      void this.respondToPermission(agent.id, event.request.id, {
        behavior: "deny",
        message: MAIN_CONTROL_WRITE_DENIAL,
      }).catch((err) =>
        this.logger.warn({ err, agentId: agent.id }, "Could not deny write permission"),
      );
      return;
    }
    const hadPendingPermissions = agent.pendingPermissions.size > 0;
    agent.pendingPermissions.set(event.request.id, event.request);
    this.refreshSessionPersistence(agent);
    if (!hadPendingPermissions && raisesAttention(agent)) {
      this.broadcastAgentAttention(agent, "permission");
    }
    this.emitState(agent);
  }

  private onStreamPermissionResolved(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "permission_resolved" }>;
    options: { fromHistory?: boolean } | undefined;
    flags: StreamEventFlags;
  }): void {
    const { agent, event, options, flags } = params;
    agent.pendingPermissions.delete(event.requestId);
    this.refreshSessionPersistence(agent);
    if (!options?.fromHistory && agent.inFlightPermissionResponses.has(event.requestId)) {
      agent.bufferedPermissionResolutions.set(event.requestId, event);
      flags.shouldDispatchEvent = false;
      return;
    }
    this.emitState(agent);
  }

  private resolvePendingPermissionsForAgent(
    agent: ActiveManagedAgent,
    provider: AgentProvider,
    options: { fromHistory?: boolean } | undefined,
    message: string,
  ): void {
    for (const [requestId] of agent.pendingPermissions) {
      agent.pendingPermissions.delete(requestId);
      if (!options?.fromHistory) {
        this.dispatchStream(agent.id, {
          type: "permission_resolved",
          provider,
          requestId,
          resolution: { behavior: "deny", message },
        });
      }
    }
  }

  private recordAndDispatchTimelineItem(
    agentId: string,
    item: AgentTimelineItem,
    provider: AgentProvider,
    turnId?: string,
    options?: { providerMessageId?: string },
  ): AgentStreamEvent {
    const row = this.recordTimeline(agentId, item, { ...options, turnId });
    const event: AgentStreamEvent = {
      type: "timeline",
      item: row.item,
      provider,
      ...(turnId !== undefined ? { turnId } : {}),
    };
    this.dispatchStream(agentId, event, {
      seq: row.seq,
      epoch: this.timelineStore.getEpoch(agentId),
      timestamp: row.timestamp,
    });

    if (
      item.type === "tool_call" &&
      item.status === "completed" &&
      item.detail?.type === "shell" &&
      commandMayHaveChangedExternalState(item.detail.command)
    ) {
      const agent = this.agents.get(agentId);
      if (agent) {
        this.onWorkspaceStateMayHaveChanged?.({ cwd: agent.cwd });
      }
    }

    return event;
  }

  private recordSubmittedPrompt(
    agent: ActiveManagedAgent,
    prompt: AgentPromptInput,
    clientMessageId: string,
    outcome: "accepted" | "rejected",
    options?: { messageId?: string; providerMessageId?: string; turnId?: string },
  ): void {
    const forkContext = extractSubmittedPromptForkContext(prompt);
    const items = projectAgentMessages(
      {
        type: "user_message",
        text: submittedPromptText(prompt),
        clientMessageId,
        ...(forkContext ? { forkContext } : {}),
        ...(options?.messageId ? { messageId: options.messageId } : {}),
      },
      { submitted: true },
    );
    for (const item of items) {
      // Human attempts stay in history on rejection; delivery notifications require acceptance.
      if (outcome === "rejected" && item.type !== "user_message") continue;
      this.recordSubmittedPromptItem(agent, item, options);
    }
  }

  private recordSubmittedPromptItem(
    agent: ActiveManagedAgent,
    item: AgentTimelineItem,
    options?: { providerMessageId?: string; turnId?: string },
  ): void {
    if (
      item.type === "user_message" &&
      item.clientMessageId &&
      this.timelineStore.getSubmittedUserMessage(agent.id, item.clientMessageId)
    )
      return;
    this.touchUpdatedAt(agent);
    if (item.type === "user_message") agent.lastUserMessageAt = new Date();
    this.recordAndDispatchTimelineItem(agent.id, item, agent.provider, options?.turnId, options);
  }

  private reconcileSubmittedPromptEcho(
    agent: ActiveManagedAgent,
    item: Extract<AgentTimelineItem, { type: "user_message" }>,
    turnId?: string,
  ): AgentTimelineRow | null {
    const { clientMessageId, messageId } = item;
    if (!clientMessageId) return null;
    let existing = this.timelineStore.getSubmittedUserMessage(agent.id, clientMessageId);
    if (!existing) {
      this.recordSubmittedPromptItem(
        agent,
        { ...item, messageId: clientMessageId },
        {
          ...(messageId ? { providerMessageId: messageId } : {}),
          ...(turnId ? { turnId } : {}),
        },
      );
      existing = this.timelineStore.getSubmittedUserMessage(agent.id, clientMessageId);
    }
    if (!existing || existing.item.type !== "user_message") return null;
    if (messageId) {
      const enriched = this.timelineStore.enrichSubmittedUserMessage(
        agent.id,
        clientMessageId,
        messageId,
      );
      if (enriched) this.enqueueDurableTimelineUpdate(agent.id, enriched);
    }
    return existing;
  }

  private async appendSystemErrorTimelineMessage(
    agent: ActiveManagedAgent,
    provider: AgentProvider,
    message: string,
    options?: { fromHistory?: boolean },
  ): Promise<void> {
    if (options?.fromHistory) {
      return;
    }

    const normalized = message.trim();
    if (!normalized) {
      return;
    }

    const text = `${SYSTEM_ERROR_PREFIX} ${normalized}`;
    const lastItem = await this.getLastItemFromStores(agent.id);
    if (lastItem?.type === "assistant_message" && lastItem.text === text) {
      return;
    }

    const item: AgentTimelineItem = { type: "assistant_message", text };
    const row = this.recordTimeline(agent.id, item);
    this.dispatchStream(
      agent.id,
      {
        type: "timeline",
        item,
        provider,
      },
      {
        seq: row.seq,
        epoch: this.timelineStore.getEpoch(agent.id),
        timestamp: row.timestamp,
      },
    );
  }

  private formatTurnFailedMessage(
    event: Extract<AgentStreamEvent, { type: "turn_failed" }>,
  ): string {
    const base = event.error.trim();
    const parts = [base.length > 0 ? base : "Provider run failed"];
    const code = event.code?.trim();
    if (code) {
      parts.push(`code: ${code}`);
    }
    const diagnostic = event.diagnostic?.trim();
    if (diagnostic && diagnostic !== base) {
      parts.push(diagnostic);
    }
    return parts.join("\n\n");
  }

  private recordTimeline(
    agentId: string,
    item: AgentTimelineItem,
    options?: {
      timestamp?: string;
      providerMessageId?: string;
      turnId?: string;
    },
  ): AgentTimelineRow {
    item = limitAgentTimelineItemContent(item);
    const row = this.timelineStore.append(agentId, item, options);
    this.enqueueDurableTimelineAppend(agentId, row);
    return row;
  }

  private emitState(agent: ManagedAgent, options?: { persist?: boolean }): void {
    // Keep attention as an edge-triggered unread signal, not a level signal.
    this.checkAndSetAttention(agent);
    if (options?.persist !== false) {
      this.enqueueBackgroundPersist(agent);
    }

    this.syncControls(agent);

    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: agent.activeForegroundTurnId ?? undefined,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        pendingPermissions: agent.pendingPermissions.size,
        persist: options?.persist !== false,
      },
      "agent.manager.emit_state",
    );

    this.dispatch({
      type: "agent_state",
      agent: { ...agent },
    });
  }

  private syncControls(agent: ManagedAgent): void {
    if ("session" in agent && agent.session?.controls) {
      agent.controls = agent.session.controls;
    }
  }

  private checkAndSetAttention(agent: ManagedAgent): void {
    const previousStatus = this.previousStatuses.get(agent.id);
    const currentStatus = agent.lifecycle;

    // Track the new status
    this.previousStatuses.set(agent.id, currentStatus);

    if (!raisesAttention(agent)) {
      return;
    }

    if (previousStatus !== "error" && currentStatus === "error") {
      this.raiseErrorAttention(agent);
      return;
    }

    const finished = previousStatus === "running" && currentStatus === "idle";
    if (agent.attention.requiresAttention) {
      // The unread finish stays the same; the notifier knows whether the user was told about it.
      if (finished && agent.attention.attentionReason === "finished") {
        this.broadcastAgentAttention(agent, "finished");
      }
      return;
    }

    if (finished) {
      agent.attention = {
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: new Date(),
      };
      this.broadcastAgentAttention(agent, "finished");
    }
  }

  // The failed state is only shown while error attention is unread, so every new failure raises
  // it, including one that keeps the lifecycle at "error". An error outranks an unread finish,
  // which would otherwise make the failure look green.
  private raiseErrorAttention(agent: ManagedAgent): void {
    if (!raisesAttention(agent)) {
      return;
    }
    if (agent.attention.requiresAttention && agent.attention.attentionReason !== "finished") {
      return;
    }
    agent.attention = {
      requiresAttention: true,
      attentionReason: "error",
      attentionTimestamp: new Date(),
    };
    this.broadcastAgentAttention(agent, "error");
  }

  private enqueueBackgroundPersist(agent: ManagedAgent): void {
    const task = this.persistSnapshot(agent).catch((err) => {
      this.logger.error({ err, agentId: agent.id }, "Failed to persist agent snapshot");
    });
    this.trackBackgroundTask(task);
  }

  private enqueueDurableTimelineAppend(agentId: string, row: AgentTimelineRow): void {
    if (!this.durableTimelineStore) {
      return;
    }
    const store = this.durableTimelineStore;
    const task = this.writeDurableTimeline(agentId, () => store.bulkInsert(agentId, [row])).catch(
      (err) => {
        this.logger.error(
          { err, agentId, seq: row.seq, itemType: row.item.type },
          "Failed to append timeline row to durable store",
        );
      },
    );
    this.trackBackgroundTask(task);
  }

  private enqueueDurableTimelineBulkInsert(
    agentId: string,
    rows: readonly AgentTimelineRow[],
  ): void {
    if (!this.durableTimelineStore || rows.length === 0) {
      return;
    }
    const store = this.durableTimelineStore;
    const task = this.writeDurableTimeline(agentId, () => store.bulkInsert(agentId, rows)).catch(
      (err) => {
        this.logger.error(
          { err, agentId, rowCount: rows.length },
          "Failed to seed durable timeline store",
        );
      },
    );
    this.trackBackgroundTask(task);
  }

  private enqueueDurableTimelineUpdate(agentId: string, row: AgentTimelineRow): void {
    if (!this.durableTimelineStore) return;
    const store = this.durableTimelineStore;
    const task = this.writeDurableTimeline(agentId, () =>
      store.updateCommittedRow(agentId, row),
    ).catch((err) => {
      this.logger.error(
        { err, agentId, seq: row.seq, itemType: row.item.type },
        "Failed to enrich durable timeline row",
      );
    });
    this.trackBackgroundTask(task);
  }

  private writeDurableTimeline(agentId: string, write: () => Promise<void>): Promise<void> {
    // Retractions must follow every buffered append, or a delayed write resurrects failed text.
    const operation = (this.durableTimelineWriteTails.get(agentId) ?? Promise.resolve()).then(
      write,
    );
    const settled = operation.catch(() => {});
    this.durableTimelineWriteTails.set(agentId, settled);
    void settled.then(() => {
      if (this.durableTimelineWriteTails.get(agentId) === settled)
        this.durableTimelineWriteTails.delete(agentId);
      return undefined;
    });
    return operation;
  }

  private trackBackgroundTask(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task.finally(() => {
      this.backgroundTasks.delete(task);
    });
  }

  private trackAgentRegistrationOperation<T>(result: Promise<T>): Promise<T> {
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.agentRegistrationTasks.add(settled);
    void settled.then(() => {
      this.agentRegistrationTasks.delete(settled);
      return undefined;
    });
    return result;
  }

  /**
   * Flush any background persistence work (best-effort).
   */
  async flush(): Promise<void> {
    await this.flushTasks({ includeAgentRegistrations: false });
  }

  /**
   * Flush persistence and agent registrations that crossed the synchronous
   * shutdown barrier. Those registrations own provider sessions until they
   * either install them or close them.
   */
  async flushForShutdown(): Promise<void> {
    await this.flushTasks({ includeAgentRegistrations: true });
  }

  private async flushTasks(options: { includeAgentRegistrations: boolean }): Promise<void> {
    this.agentStreamCoalescer.flushAll();
    // Drain tasks, including tasks spawned while awaiting.
    while (
      this.backgroundTasks.size > 0 ||
      (options.includeAgentRegistrations && this.agentRegistrationTasks.size > 0)
    ) {
      const pending = options.includeAgentRegistrations
        ? [...this.backgroundTasks, ...this.agentRegistrationTasks]
        : [...this.backgroundTasks];
      await Promise.allSettled(pending);
    }
  }

  private broadcastAgentAttention(
    agent: ManagedAgent,
    reason: "finished" | "error" | "permission",
  ): void {
    if (isDelegatedAgent(agent)) {
      return;
    }

    this.onAgentAttention?.({
      agentId: agent.id,
      provider: agent.provider,
      reason,
      attentionTimestamp: agent.attention.requiresAttention
        ? agent.attention.attentionTimestamp
        : null,
    });
  }

  private dispatchStream(
    agentId: string,
    event: AgentStreamEvent,
    metadata?: {
      seq?: number;
      epoch?: string;
      timestamp?: string;
    },
  ): void {
    if (event.type === "timeline") {
      event = {
        ...event,
        item: limitAgentTimelineItemContent(event.item),
      };
    }
    const agent = this.agents.get(agentId);
    this.logger.trace(
      {
        agentId,
        provider: event.provider,
        sessionId: agent?.persistence?.sessionId ?? undefined,
        turnId: getAgentStreamEventTurnId(event),
        metadata,
        event,
      },
      "agent.manager.dispatch_stream",
    );
    this.dispatch({ type: "agent_stream", agentId, event, ...metadata });
    if (this.pluginLifecycle && agent && !agent.internal && event.type !== "timeline") {
      publishAgentStream(
        this.pluginLifecycle,
        describeHookAgent({ ...agent, title: agent.config.title }),
        event,
      );
    }
  }

  private dispatch(event: AgentManagerEvent): void {
    for (const subscriber of this.subscribers) {
      if (
        subscriber.agentId &&
        (event.type === "agent_stream" || event.type === "agent_removed") &&
        subscriber.agentId !== event.agentId
      ) {
        continue;
      }
      if (
        subscriber.agentId &&
        event.type === "background_work" &&
        subscriber.agentId !== event.agentId
      ) {
        continue;
      }
      if (
        subscriber.agentId &&
        event.type === "agent_state" &&
        subscriber.agentId !== event.agent.id
      ) {
        continue;
      }
      if (
        subscriber.agentId &&
        event.type === "provider_subagent" &&
        subscriber.agentId !==
          (event.event.type === "upsert"
            ? event.event.subagent.parentAgentId
            : event.event.parentAgentId)
      ) {
        continue;
      }
      // Global subscribers (no agentId) skip internal agents unless they opted in.
      if (
        !subscriber.agentId &&
        !subscriber.includeInternal &&
        this.eventBelongsToInternalAgent(event)
      ) {
        continue;
      }
      subscriber.callback(event);
    }
  }

  private eventBelongsToInternalAgent(event: AgentManagerEvent): boolean {
    if (event.type === "agent_state") return event.agent.internal === true;
    if (event.type === "agent_removed") return event.internal;
    if (event.type === "agent_stream") return this.agents.get(event.agentId)?.internal === true;
    if (event.type === "background_work") return this.agents.get(event.agentId)?.internal === true;
    if (event.type !== "provider_subagent") return false;
    const parentAgentId =
      event.event.type === "upsert"
        ? event.event.subagent.parentAgentId
        : event.event.parentAgentId;
    return this.agents.get(parentAgentId)?.internal === true;
  }

  private async normalizeConfig(
    config: AgentSessionConfig,
    options: NormalizeConfigOptions = {},
  ): Promise<AgentSessionConfig> {
    const normalized: AgentSessionConfig = { ...this.withConvertedOptions(config) };

    // Always resolve cwd to absolute path for consistent history file lookup
    if (normalized.cwd) {
      normalized.cwd = resolve(normalized.cwd);
      // Only a session that will run in the directory needs it to still be there. Reading
      // an archived agent's history runs nothing, and must survive the worktree it ran in
      // being removed when its workspace was archived.
      if (options.purpose !== "history") {
        await assertUsableWorkingDirectory(normalized.cwd);
      }
    }

    if (typeof normalized.model === "string") {
      const trimmed = normalized.model.trim();
      normalized.model = trimmed.length > 0 && trimmed !== "default" ? trimmed : undefined;
    }

    const shouldResolveDefaultModel = options.resolveDefaultModel ?? true;
    if (shouldResolveDefaultModel && !normalized.model) {
      const defaultModelId = await this.resolveDefaultModelId(normalized);
      if (defaultModelId) {
        normalized.model = defaultModelId;
      }
    }

    return this.applyProviderConfiguration(normalized);
  }

  private applyProviderConfiguration(config: AgentSessionConfig): AgentSessionConfig {
    const definition = this.providerDefinitions.get(config.provider);
    this.validateToolPolicyServers(config);
    if (config.toolPolicy && !definition?.applyToolPolicy) {
      throw new Error(
        `Provider '${config.provider}' cannot preapprove exact MCP tools for unattended execution`,
      );
    }
    return definition?.applyToolPolicy
      ? definition.applyToolPolicy(config, config.toolPolicy)
      : config;
  }

  private validateToolPolicyServers(config: AgentSessionConfig): void {
    if (!config.toolPolicy) return;
    const serverNames = new Set(Object.keys(config.mcpServers ?? {}));
    for (const grant of config.toolPolicy.preapproved) {
      if (!serverNames.has(grant.server)) {
        throw new Error(
          `toolPolicy preapproval '${grant.server}.${grant.tool}' requires MCP server '${grant.server}' in the same agent request`,
        );
      }
    }
  }

  private async resolveDefaultModelId(config: AgentSessionConfig): Promise<string | undefined> {
    const client = this.clients.get(config.provider);
    if (!client) {
      return undefined;
    }
    try {
      const catalog = await client.fetchCatalog({
        scope: "workspace",
        cwd: config.cwd,
        force: false,
      });
      return (catalog.models.find((model) => model.isDefault) ?? catalog.models[0])?.id;
    } catch {
      // Provider may not support model listing — leave model undefined.
      return undefined;
    }
  }

  /** The adapter a provider id runs on: a custom provider is named by the one it extends. */
  adapterOf(provider: AgentProvider): AgentProvider {
    return resolveAdapter({
      provider,
      extendsOf: (id) => this.providerDefinitions.get(id)?.derivedFromProviderId,
    });
  }

  /**
   * Options older data carries are converted for the adapter the provider runs on, before
   * defaults merge and before anything is stored; nothing past the manager sees the old keys.
   */
  private convertLegacyOptions<T extends ProviderOptions | undefined>(
    provider: AgentProvider,
    options: T,
  ): T {
    return convertLegacyOptions({ provider: this.adapterOf(provider), options }) as T;
  }

  private withConvertedOptions(config: AgentSessionConfig): AgentSessionConfig {
    const providerOptions = this.convertLegacyOptions(config.provider, config.providerOptions);
    return this.convertLegacySessionConfig(
      providerOptions === config.providerOptions ? config : { ...config, providerOptions },
    );
  }

  convertLegacySessionConfig<T extends Parameters<typeof convertLegacyClaudeUltracode>[0]>(
    config: T,
  ): T {
    return convertLegacyClaudeUltracode(config, this.adapterOf(config.provider));
  }

  private async prepareSessionConfig(
    config: AgentSessionConfig,
    agentId: string,
    options: PrepareSessionConfigOptions = {},
  ): Promise<PreparedSessionConfig> {
    let storedConfig = await this.normalizeConfig(stripInternalPaseoMcpServer(config), {
      env: options.env,
      purpose: options.purpose,
      resolveDefaultModel: options.resolveDefaultModel,
    });
    const parentId = this.localHierarchyParentId(options.labels);
    const mainControlRoleVersion = parentId
      ? (this.mainControlRoleVersions.get(parentId) ?? 0)
      : undefined;
    const hierarchy = await this.readHierarchyAgents();
    const agent = { id: agentId, labels: options.labels };
    const readAgent = (id: string) => (id === agentId ? agent : hierarchy.get(id));
    const depth = computeAgentDepth(agentId, readAgent);
    const adapter = this.adapterOf(storedConfig.provider);
    const hierarchyPrompt = buildHierarchyAppendSystemPrompt({
      agent,
      // Other adapters already get these instructions on the first turn.
      mainControlSystemPrompt: HIERARCHY_SYSTEM_PROMPT_ADAPTERS.has(adapter)
        ? options.mainControlSystemPrompt
        : undefined,
      serverId: this.serverId,
      readAgent,
      listActiveAgents: () => hierarchy.values(),
    });
    const mainControl = isMainControlAgentLabels(agent.labels);
    if (mainControl && adapter === "codex") storedConfig = { ...storedConfig, modeId: "read-only" };
    const rawEffectiveOptions = mainControl
      ? this.effectiveOptionsFor(storedConfig.provider, storedConfig.providerOptions)
      : undefined;
    const effectiveOptions =
      mainControl &&
      (adapter === "claude" || adapter === "opencode" || rawEffectiveOptions?.auto_accept === true)
        ? rawEffectiveOptions
        : undefined;
    const restrictedConfig = applyMainControlReadOnlyConfig(
      effectiveOptions ? { ...storedConfig, providerOptions: effectiveOptions } : storedConfig,
      agent.labels,
      adapter,
    );
    const paseoToolPolicy = resolveAgentPaseoToolPolicy(
      this.basePaseoToolPolicy(storedConfig.provider),
      agent,
      depth,
    );
    const launchConfig = this.applyDaemonAppendSystemPrompt(
      withRuntimePaseoMcpServer({
        config: restrictedConfig,
        agentId,
        mcpBaseUrl:
          this.paseoToolsEnabled && isPaseoToolPolicyEnabled(paseoToolPolicy)
            ? this.mcpBaseUrl
            : null,
        mcpAuthToken: this.mcpAuthToken,
      }),
      hierarchyPrompt,
    );
    if (mainControlRoleVersion !== undefined) {
      this.launchMainControlRoleVersions.set(storedConfig, mainControlRoleVersion);
    }
    return { storedConfig, launchConfig, paseoToolPolicy };
  }

  private applyDaemonAppendSystemPrompt(
    config: AgentSessionConfig,
    hierarchyPrompt: string,
  ): AgentSessionConfig {
    const daemonAppendSystemPrompt = [this.appendSystemPrompt.trim(), hierarchyPrompt]
      .filter(Boolean)
      .join("\n\n");
    const next = { ...config };
    delete next.daemonAppendSystemPrompt;

    return daemonAppendSystemPrompt
      ? {
          ...next,
          daemonAppendSystemPrompt,
        }
      : next;
  }

  private async buildLaunchContext(
    agentId: string,
    client: AgentClient,
    cwd: string,
    paseoToolPolicy: ProviderPaseoToolsPolicy | undefined,
    env?: Record<string, string>,
    opening?: {
      reason: PluginSessionOpenRequest["reason"];
      purpose: PluginSessionOpenRequest["purpose"];
      workspaceId?: string | null;
      title?: string | null;
      background?: boolean;
      labels?: Record<string, string>;
      metadata?: AgentMetadata;
    },
  ): Promise<AgentLaunchContext> {
    // A plugin changing during this open must still make the resulting session stale.
    const generation = this.sessionOpenGeneration;
    this.detachPluginTools(agentId);
    let appendSystemPrompt: string[] | undefined;
    let mcpServers: AgentSessionConfig["mcpServers"];
    let mcpServerOwners: Record<string, string> | undefined;
    if (this.pluginLifecycle) {
      const request = {
        agentId,
        provider: client.provider,
        cwd,
        workspaceId: opening?.workspaceId ?? null,
        reason: opening?.reason ?? "resume",
        purpose: opening?.purpose ?? "interactive",
        env: { ...env },
        title: opening?.title ?? null,
        background: opening?.background === true,
        ...agentEntityData(opening),
        tools: [],
        mcpServers: {},
      };
      const transformed = await this.pluginLifecycle.before("agent.open.before", request);
      env = transformed.env;
      if (request.purpose === "interactive") {
        this.attachedPluginTools.set(agentId, transformed.tools as AttachedAgentTool[]);
        appendSystemPrompt = transformed.appendSystemPrompt;
        mcpServers = transformed.mcpServers;
        mcpServerOwners = transformed.mcpServerOwners;
      }
    }
    const context: AgentLaunchContext = {
      agentId,
      ...pluginPromptContext(appendSystemPrompt),
      mcpServers,
      mcpServerOwners,
      env: {
        ...env,
        ...agentIdentityEnv({ agentId, cwd, opening }),
      },
    };
    const useNativeTools =
      this.paseoToolsEnabled &&
      isPaseoToolPolicyEnabled(paseoToolPolicy) &&
      client.capabilities.supportsNativePaseoTools;
    if (
      this.paseoToolCatalogFactory &&
      (useNativeTools || this.getPluginTools(agentId).length > 0)
    ) {
      try {
        const catalog = await this.paseoToolCatalogFactory({
          callerAgentId: agentId,
          paseoToolPolicy,
        });
        if (useNativeTools) context.paseoTools = catalog;
      } catch (error) {
        this.detachPluginTools(agentId);
        throw error;
      }
    }
    this.sessionOpenGenerations.set(agentId, generation);
    return context;
  }

  private resolveProviderLaunchConfig(
    launchConfig: AgentSessionConfig,
    launchContext: AgentLaunchContext,
  ): AgentSessionConfig {
    const savedServerNames = new Set(
      Object.keys(stripInternalPaseoMcpServer(launchConfig).mcpServers ?? {}),
    );
    for (const name of Object.keys(launchContext.mcpServers ?? {})) {
      const owner = launchContext.mcpServerOwners?.[name];
      if (name === PASEO_MCP_SERVER_NAME || savedServerNames.has(name)) {
        const existingOwner = savedServerNames.has(name)
          ? "agent saved configuration"
          : "Paseo internal MCP server";
        throw new Error(`MCP server '${name}' from plugin ${owner} collides with ${existingOwner}`);
      }
    }
    launchConfig = { ...launchConfig, pluginAppendSystemPrompt: launchContext.appendSystemPrompt };
    const merged =
      Object.keys(launchContext.mcpServers ?? {}).length > 0
        ? {
            ...launchConfig,
            mcpServers: { ...launchConfig.mcpServers, ...launchContext.mcpServers },
          }
        : launchConfig;
    return launchContext.paseoTools ? stripInternalPaseoMcpServer(merged) : merged;
  }

  private async requireAvailableClient(options: { provider: AgentProvider }): Promise<AgentClient> {
    const client = this.clients.get(options.provider);
    if (!client) {
      const configuredProviders = this.getConfiguredProviderIds();
      throw new Error(
        `Unknown provider '${options.provider}'. Configured providers: ${formatProviderList(
          configuredProviders,
        )}.`,
      );
    }

    let unavailableReason: string | null = null;
    try {
      const available = await client.isAvailable();
      if (available) {
        return client;
      }
    } catch (error) {
      unavailableReason = error instanceof Error ? error.message : String(error);
    }

    const availableProviders = (await this.listProviderAvailability())
      .filter((entry) => entry.available)
      .map((entry) => entry.provider);
    const providerList = formatProviderList(availableProviders);
    const reason = unavailableReason ? ` Reason: ${unavailableReason}.` : "";
    throw new Error(
      `Provider '${options.provider}' is not available.${reason} Available providers: ${providerList}. Use one of those providers, or install/configure '${options.provider}'.`,
    );
  }

  private requireEnabledProvider(provider: AgentProvider): void {
    if (this.providerEnabled.get(provider) === false) {
      throw new Error(`Provider '${provider}' is disabled`);
    }
  }

  private getConfiguredProviderIds(): AgentProvider[] {
    return Array.from(new Set([...this.providerEnabled.keys(), ...this.clients.keys()]));
  }

  private requireClient(provider: AgentProvider): AgentClient {
    const client = this.clients.get(provider);
    if (!client) {
      throw new Error(`No client registered for provider '${provider}'`);
    }
    return client;
  }

  private async syncNativeArchiveState(
    provider: AgentProvider,
    persistence: AgentPersistenceHandle | null | undefined,
    state: "archive" | "restore",
  ): Promise<void> {
    if (!persistence) return;
    const client = this.clients.get(provider);
    const sync =
      state === "archive" ? client?.archiveNativeSession : client?.unarchiveNativeSession;
    if (!sync) return;
    if (state === "restore") {
      await sync.call(client, persistence);
      return;
    }
    try {
      await sync.call(client, persistence);
    } catch (error) {
      this.logger.warn(
        { error, provider, sessionId: persistence.sessionId },
        "Failed to archive native session (best-effort)",
      );
    }
  }

  private requireAgent(id: string): LiveManagedAgent {
    const normalizedId = validateAgentId(id, "requireAgent");
    const agent = this.agents.get(normalizedId);
    if (!agent) {
      throw new Error(`Unknown agent '${normalizedId}'`);
    }
    return agent;
  }

  private requireSessionAgent(id: string): ActiveManagedAgent {
    const agent = this.requireAgent(id);
    if (agent.session === null) {
      throw new Error(`Agent '${agent.id}' has no managed session`);
    }
    return agent;
  }

  private requirePublicAgent(id: string): LiveManagedAgent {
    const agent = this.requireAgent(id);
    if (agent.internal) {
      throw new Error(`Unknown agent '${agent.id}'`);
    }
    return agent;
  }
}

function matchesImportableSessionQuery(
  session: ImportableProviderSession,
  rawQuery: string | undefined,
): boolean {
  const query = rawQuery?.trim().toLowerCase();
  if (!query) return true;
  const cwdBasename = basename(session.cwd.replaceAll("\\", "/"));
  return [session.title, session.firstPromptPreview, session.lastPromptPreview, cwdBasename].some(
    (value) => value?.toLowerCase().includes(query),
  );
}

export function commandMayHaveChangedExternalState(command: string): boolean {
  const normalized = command.toLowerCase();
  // Commands that operate on remote state and do NOT trigger local file
  // watchers. Local git mutations (commit, checkout, merge, rebase, reset,
  // pull) are already caught by watchers on .git/HEAD and refs/heads/.
  return (
    // GitHub PR operations (merge, close, create, edit, comment, review)
    /\bgh\s+pr\s+(merge|close|create|edit|comment|review)\b/.test(normalized) ||
    // Pushes to remote — local refs unchanged, but remote state (PR checks,
    // mergeable status) may shift immediately after.
    /\bgit\s+push\b/.test(normalized) ||
    // Fetches update refs/remotes/ which our watchers do not watch, so
    // ahead/behind counts can drift stale until the next refresh.
    /\bgit\s+fetch\b/.test(normalized)
  );
}

function pluginPromptContext(
  appendSystemPrompt: string[] | undefined,
): Pick<AgentLaunchContext, "appendSystemPrompt"> {
  return appendSystemPrompt?.length ? { appendSystemPrompt } : {};
}
