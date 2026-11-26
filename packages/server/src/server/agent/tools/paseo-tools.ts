import { describeAgentMessage } from "../agent-messages/guidance.js";
import {
  WorkspaceTopicDecideRequestSchema,
  type AgentActiveTurnBehavior,
  type TopicThreadEntry,
  type WorkspaceTopicDecideRequest,
  type WorkspaceTopicDecideResponse,
} from "@getpaseo/protocol/messages";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChangeRequestWatches } from "../change-request-watches/index.js";
import { changeRequestStatusSchema } from "../../../services/change-request-source.js";
import { registerPluginTools } from "./plugin-tools.js";
import type { FinishSubscriptions, FinishRegistration } from "../finish-subscriptions/index.js";
import { resolveReportTitle } from "../report-title.js";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import {
  encodePeerWorkspacePrompt,
  formatPeerInspectionPromptPrefix,
  isPeerInspectionBoundaryPromptText,
  isSystemInjectedEnvelope,
  neutralizePeerWorkspacePromptMarker,
  parseAgentMessages,
  parseProjectedPeerCallId,
  PeerMessageIntentSchema,
  projectedPeerMessagePrefix,
  registerHostPeerDispatchVerifier,
  registerPromptDispatchVerifier,
  releasePromptDispatchVerifier,
  resolvePeerTransportSecret,
  type AgentPromptSource,
  type PeerDispatchEndpointContext,
  type PeerDispatchTerminalOutcome,
  type PeerDispatchVerificationRequest,
} from "../agent-messages/envelope.js";
import {
  fingerprintMessageRequest,
  MessageReceipts,
  type RecoverableAgentMessage,
} from "../../message-receipts/index.js";
import {
  assertDirectParent,
  createHostResolver,
  HostOperationRejectedError,
  type HostOperation,
  type HostOperations,
  type ToolHosts,
} from "../host-operations/index.js";
import { AgentDirectory } from "../directory.js";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { ensureValidJson } from "../../json-utils.js";
import {
  agentDurableItemRequestSchema,
  readDurableItemTurnMessageIds,
  requestDurableItemFromAgent,
  resolveDurableItemTurnTopic,
  type PendingDurableItemTaskBinding,
} from "../../durable-items/agent-request.js";
import type { DurableItemStore } from "../../durable-items/store.js";
import type { TopicAnchorInput } from "../../topic-threads/anchors.js";
import type { TopicDecisionActor } from "../../topic-threads/decide.js";
import {
  WORKSPACE_SITUATION_MAX_BYTES,
  type WorkspaceSituation,
  type WorkspaceSituationOptions,
} from "../workspace-situation.js";
import type { Logger } from "pino";

import type {
  AgentMode,
  AgentPromptInput,
  AgentProvider,
  AgentSessionConfig,
  AgentTimelineItem,
} from "../agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "../agent-manager.js";
import {
  ActiveTurnBehaviorSchema,
  AgentActiveTurnBehaviorSchema,
  AgentProfileSchema,
  WorkspaceAgentSummaryEntrySchema,
} from "@getpaseo/protocol/messages";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import { featuresFromControls } from "@getpaseo/protocol/option-controls";
import {
  AgentFeatureSchema,
  AgentPermissionRequestPayloadSchema,
  AgentListItemPayloadSchema,
  AgentPermissionResponseSchema,
  AgentSnapshotPayloadSchema,
  WorkspaceScriptPayloadSchema,
} from "../../messages.js";
import {
  buildStoredAgentPayload,
  selectAgentListItems,
  toAgentPayload,
} from "../agent-projections.js";
import { summarizeAgentActivity } from "../activity-curator.js";
import { summarizeWorkspaceAgents } from "../workspace-agents-summary.js";
import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
import { AgentNotFoundError, ensureAgentLoaded } from "../agent-loading.js";
import { isStoredAgentProviderAvailable } from "../../persistence-hooks.js";
import {
  archiveByScope,
  killTerminalsForWorkspace,
  requireActiveWorkspaceForArchive,
  type ArchiveDependencies,
} from "../../workspace-archive-service.js";
import {
  createAgentCommand,
  formatProviderModel,
  type CreateAgentFromMcpInput,
} from "../create-agent/create.js";
import {
  AGENT_WORKSPACE_CREATION_ERROR,
  inheritWorkspaceBackground,
} from "../create-agent/intent.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "../../voice-types.js";
import type { FirstAgentContext } from "../../messages.js";
import { everyMsToFiveFieldCron } from "@getpaseo/protocol/schedule/cadence";
import { expandUserPath, isSameOrDescendantPath, resolvePathFromBase } from "../../path-utils.js";
import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import { encodeTerminalKeyInput } from "@getpaseo/protocol/terminal-key-input";
import { TerminalInputModeTracker } from "@getpaseo/protocol/terminal-input-mode";
import type { CreatePaseoWorktreeWorkflowFn } from "../../worktree-session.js";
import { computeNextRunAt, validateScheduleCadence } from "../../schedule/cron.js";
import {
  ScheduleNotFoundError,
  ScheduleStateConflictError,
  type ScheduleService,
} from "../../schedule/service.js";
import {
  ScheduleRunSchema,
  ScheduleSummarySchema,
  StoredScheduleSchema,
  type ScheduleCadence,
  type UpdateScheduleInput,
} from "@getpaseo/protocol/schedule/types";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import {
  AgentModelSchema,
  AgentProviderEnum,
  AgentStatusEnum,
  ProviderModeSchema,
  ProviderSummarySchema,
  parseDurationString,
  resolveRequiredProviderModel,
  sanitizePermissionRequest,
  serializeSnapshotWithMetadata,
  toScheduleSummary,
} from "../mcp-shared.js";
import {
  sendPromptToAgent,
  waitForAgentRunStartWithTimeout,
  withPeerInitialPrompt,
} from "../agent-prompt.js";
import { respondToAgentPermission } from "../permission-response.js";
import {
  archiveAgentCommand,
  cancelAgentRunCommand,
  closeAgentCommand,
  setAgentModeCommand,
  updateAgentCommand,
} from "../lifecycle-command.js";
import type { ForgeService } from "../../../services/forge-service.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import {
  resolveWorkspaceDisplayName,
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import { resolveWorktreeSourceCwd } from "../../workspace-source.js";
import type { WorkspaceScriptsService } from "../../session/workspace-scripts/workspace-scripts-service.js";
import {
  type ArchiveCommandDependencies,
  type CreatePaseoWorktreeCommandInput,
  createPaseoWorktreeCommand,
} from "../../worktree/commands.js";
import { registerBrowserTools } from "../../browser-tools/tools.js";
import type { BrowserToolsBroker } from "../../browser-tools/broker.js";
import {
  PaseoToolInputError,
  type PaseoToolCatalog,
  type PaseoToolConfig,
  type PaseoToolDefinition,
  type PaseoToolExecutionContext,
  type PaseoToolResult,
} from "./types.js";
import { isPaseoToolEnabled } from "../paseo-tool-policy.js";
import {
  WorkspaceTaskLedgerStore,
  projectTaskParticipantReuse,
  WorkspaceTaskToolInputSchema,
} from "../task-ledger/index.js";
import {
  runWithTaskDispatchAdmission,
  type TaskDispatchAdmission,
} from "../task-ledger/admission.js";
import { taskEvent } from "../task-ledger/events.js";
import { isLocalTaskChild, TaskDispatchRejectedError } from "../task-ledger/reuse.js";
import {
  applyHierarchyPaseoToolPolicy,
  computeAgentDepth,
  hasReservedHierarchyLabels,
  readAgentHierarchyPath,
  RESERVED_HIERARCHY_LABELS_ERROR,
  requiresSingleHopOrchestration,
  TASK_ID_LABEL,
  TOPIC_ROOT_MESSAGE_ID_LABEL,
  validateCanSpawnChild,
  validateSingleHopOrchestration,
  type HierarchyAgent,
  type PaseoToolPolicy,
} from "../hierarchy-policy.js";
import {
  getLeadPlaybookFromLabels,
  getParentAddressFromLabels,
  getParentAgentIdFromLabels,
  isExplicitParentReportingLabels,
  isMainControlAgentLabels,
  isOpenAgentTabLabel,
  isSideChatAgent,
  AGENT_PROFILE_ID_MAX_LENGTH,
  RESIDENT_ROLE_MAX_LENGTH,
} from "@getpaseo/protocol/agent-labels";
import {
  LeadCommitPolicySchema,
  LeadPlaybookSchema,
  LeadPlaybookValidationError,
  resolveLeadPlaybookInput,
  type ResolvedLeadPlaybookOptions,
} from "../orchestration-playbooks.js";

export interface ButlerTopicDecisionActor extends TopicDecisionActor {
  origin: "butler_dispatch";
  assertCurrent(): void;
}

export interface PaseoToolHostDependencies {
  agentMessages?: () => AgentMessageDelivery;
  queueAgentPrompt?: (
    agentId: string,
    message: Omit<RecoverableAgentMessage, "messageId">,
  ) => Promise<string>;
  queueAgentPromptAndWaitForDispatch?: (
    agentId: string,
    message: Omit<RecoverableAgentMessage, "messageId">,
    validateDispatch: () => Promise<void>,
  ) => Promise<string>;
  changeRequestWatches?: ChangeRequestWatches;
  finishSubscriptions?: () => FinishSubscriptions;
  serverId?: string;
  hosts?: () => ToolHosts;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager?: TerminalManager | null;
  getDaemonTcpPort?: () => number | null;
  scheduleService?: ScheduleService | null;
  providerSnapshotManager: ProviderSnapshotManager;
  daemonConfigStore?: Pick<DaemonConfigStore, "get">;
  github?: ForgeService;
  workspaceGitService?: Pick<
    WorkspaceGitService,
    "getSnapshot" | "listWorktrees" | "resolveRepoRoot" | "invalidateWorktrees"
  >;
  findWorkspaceIdForCwd?: ArchiveDependencies["findWorkspaceIdForCwd"];
  worktreeManagers?: ArchiveDependencies["worktreeManagers"];
  workspaceArchiveOperations?: ArchiveDependencies["workspaceArchiveOperations"];
  assertWorkspaceAutomationAllowed?: ArchiveDependencies["assertWorkspaceAutomationAllowed"];
  isCheckoutUntrusted?: ArchiveDependencies["isCheckoutUntrusted"];
  listActiveWorkspaces?: ArchiveDependencies["listActiveWorkspaces"];
  archiveWorkspaceRecord?: ArchiveDependencies["archiveWorkspaceRecord"];
  emitWorkspaceUpdatesForWorkspaceIds?: ArchiveDependencies["emitWorkspaceUpdatesForWorkspaceIds"];
  workspaceRegistry?: Pick<WorkspaceRegistry, "get" | "listActive" | "update">;
  projectRegistry?: Pick<ProjectRegistry, "get" | "list">;
  createDirectoryWorkspace?: (
    cwd: string,
    title?: string | null,
    projectId?: string,
    context?: { background?: boolean; callerWorkspaceId?: string },
  ) => Promise<PersistedWorkspaceRecord>;
  workspaceScripts?: Pick<WorkspaceScriptsService, "list" | "launch" | "stop">;
  markWorkspaceArchiving?: ArchiveDependencies["markWorkspaceArchiving"];
  clearWorkspaceArchiving?: ArchiveDependencies["clearWorkspaceArchiving"];
  createPaseoWorktree?: CreatePaseoWorktreeWorkflowFn;
  // Mints a fresh directory workspace for a cwd and returns its id.
  ensureWorkspaceForCreate?: (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
    context?: { background?: boolean; callerWorkspaceId?: string },
  ) => Promise<string>;
  browserToolsEnabled?: boolean;
  browserToolsBroker?: BrowserToolsBroker | null;
  paseoToolPolicy?: PaseoToolPolicy;
  paseoHome?: string;
  worktreesRoot?: string;
  /**
   * ID of the agent that is using this tool catalog.
   * Used for cwd/mode inheritance when agents spawn child agents.
   */
  callerAgentId?: string;
  /** Caller ID verified by the entry point and bound to this invocation's authority. */
  verifiedCallerAgentId?: string;
  taskLedger?: WorkspaceTaskLedgerStore;
  durableItems?: DurableItemStore;
  getWorkspaceSituation?: (
    workspaceId: string,
    mainAgentId: string,
    options: WorkspaceSituationOptions,
  ) => Promise<WorkspaceSituation>;
  decideTopicAction?: (
    request: WorkspaceTopicDecideRequest,
    actor: ButlerTopicDecisionActor,
  ) => Promise<WorkspaceTopicDecideResponse["payload"]>;
  upsertTopicAnchor?: (input: TopicAnchorInput) => Promise<unknown>;
  listTopicEntries?: (scope: {
    workspaceId: string;
    mainAgentId: string;
  }) => Promise<TopicThreadEntry[]>;
  crossWorkspacePeerPolicy?: {
    allowLocalPeerMessages?: boolean;
    maxMessagesPerMinute?: number;
    cooldownMs?: number;
    now?: () => number;
  };
  /**
   * Optional resolver for session-bound speak handlers.
   * Used by hidden voice agents to narrate through daemon-managed TTS.
   */
  resolveSpeakHandler?: (callerAgentId: string) => VoiceSpeakHandler | null;
  resolveCallerContext?: (callerAgentId: string) => VoiceCallerContext | null;
  enableVoiceTools?: boolean;
  voiceOnly?: boolean;
  logger: Logger;
}

interface ProviderSummary {
  id: AgentProvider;
  label: string;
  description: string;
  enabled: boolean;
  modes: AgentMode[];
  status: string;
  error?: string;
}

const WorkspaceAutomationSummarySchema = z.object({
  parentWorkspaceId: z.string().optional(),
  workspaceId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  isolation: z.enum(["local", "worktree"]),
  kind: z.enum(["directory", "local_checkout", "worktree"]),
  title: z.string().nullable(),
  background: z.boolean().optional(),
});

function toWorkspaceAutomationSummary(workspace: PersistedWorkspaceRecord) {
  return {
    workspaceId: workspace.workspaceId,
    projectId: workspace.projectId,
    cwd: workspace.cwd,
    isolation: workspace.kind === "worktree" ? ("worktree" as const) : ("local" as const),
    kind: workspace.kind,
    title: workspace.title,
    background: workspace.background,
    parentWorkspaceId: workspace.parentWorkspaceId,
  };
}

type WorkspaceWorktreeMode = "branch-off" | "checkout-branch" | "checkout-pr";

interface WorkspaceWorktreeOptions {
  mode?: WorkspaceWorktreeMode;
  worktreeSlug?: string;
  branchName?: string;
  baseBranch?: string;
  branch?: string;
  prNumber?: number;
  forge?: string;
}

type WorkspaceWorktreeTarget = Pick<
  CreatePaseoWorktreeCommandInput,
  "action" | "branchName" | "refName" | "checkoutSource"
>;

function assertOptionsAbsent(
  options: Array<[name: string, value: unknown]>,
  message: string,
): void {
  if (options.some(([, value]) => value !== undefined)) {
    throw new PaseoToolInputError(message);
  }
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function resolveWorkspaceWorktreeTarget(input: WorkspaceWorktreeOptions): WorkspaceWorktreeTarget {
  switch (input.mode ?? "branch-off") {
    case "branch-off":
      assertOptionsAbsent(
        [
          ["branch", input.branch],
          ["prNumber", input.prNumber],
          ["forge", input.forge],
        ],
        "branch, prNumber, and forge require a checkout mode",
      );
      return {
        action: "branch-off",
        ...(input.branchName ? { branchName: input.branchName } : {}),
        ...(input.baseBranch ? { refName: input.baseBranch } : {}),
      };
    case "checkout-branch":
      if (!input.branch) {
        throw new PaseoToolInputError("branch is required for checkout-branch mode");
      }
      assertOptionsAbsent(
        [
          ["branchName", input.branchName],
          ["baseBranch", input.baseBranch],
          ["prNumber", input.prNumber],
          ["forge", input.forge],
        ],
        "branchName, baseBranch, prNumber, and forge are not valid for checkout-branch mode",
      );
      return { action: "checkout", refName: input.branch };
    case "checkout-pr":
      if (input.prNumber === undefined) {
        throw new PaseoToolInputError("prNumber is required for checkout-pr mode");
      }
      assertOptionsAbsent(
        [
          ["branchName", input.branchName],
          ["baseBranch", input.baseBranch],
          ["branch", input.branch],
        ],
        "branchName, baseBranch, and branch are not valid for checkout-pr mode",
      );
      return {
        action: "checkout",
        checkoutSource: {
          kind: "change_request",
          ...(input.forge ? { forge: input.forge } : {}),
          number: input.prNumber,
        },
      };
  }
}

function toProviderSummary(entry: {
  provider: AgentProvider;
  label?: string;
  description?: string;
  enabled: boolean;
  modes?: AgentMode[];
  status: string;
  error?: string;
}): ProviderSummary {
  return {
    id: entry.provider,
    label: entry.label ?? entry.provider,
    description: entry.description ?? "",
    enabled: entry.enabled,
    modes: entry.modes ?? [],
    status: entry.status === "ready" ? "available" : entry.status,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

function resolveScheduleProviderAndModel(params: {
  provider?: string;
  defaultProvider: AgentProvider;
}): { provider: AgentProvider; model?: string } {
  const providerInput = params.provider?.trim() || params.defaultProvider;
  const slashIndex = providerInput.indexOf("/");
  if (slashIndex === -1) {
    return { provider: providerInput };
  }

  const provider = providerInput.slice(0, slashIndex).trim();
  const model = providerInput.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    throw new PaseoToolInputError("provider must be <provider> or <provider>/<model>");
  }

  return {
    provider: provider,
    model,
  };
}

function resolveScheduleUpdateProviderAndModel(params: {
  provider?: string;
  model?: string | null;
}): { provider?: string; model?: string | null } {
  const providerInput = params.provider?.trim();
  const modelInput = typeof params.model === "string" ? params.model.trim() : params.model;

  if (params.model !== undefined && modelInput === "") {
    throw new PaseoToolInputError("model cannot be empty");
  }

  if (!providerInput) {
    return params.model !== undefined ? { model: modelInput } : {};
  }

  const slashIndex = providerInput.indexOf("/");
  if (slashIndex === -1) {
    return {
      provider: providerInput,
      ...(params.model !== undefined ? { model: modelInput } : {}),
    };
  }

  const provider = providerInput.slice(0, slashIndex).trim();
  const modelFromProvider = providerInput.slice(slashIndex + 1).trim();
  if (!provider || !modelFromProvider) {
    throw new PaseoToolInputError("provider must be <provider> or <provider>/<model>");
  }
  if (params.model === null) {
    throw new PaseoToolInputError("provider specifies a model but model is null");
  }
  if (typeof modelInput === "string" && modelInput !== modelFromProvider) {
    throw new PaseoToolInputError("Conflicting model values provided");
  }

  return {
    provider,
    model: modelInput ?? modelFromProvider,
  };
}

interface ScheduleUpdateToolInput {
  id: string;
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string | null;
  prompt?: string;
  maxRuns?: number | null;
  provider?: string;
  model?: string | null;
  mode?: string | null;
  cwd?: string;
  expiresIn?: string;
  clearExpires?: boolean;
}

function normalizeScheduleCadenceArg(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

function normalizeScheduleTimeZoneArg(value: string | undefined): string | undefined {
  return normalizeScheduleCadenceArg(value);
}

function addScheduleCadenceIssue(
  input: { cron?: string; timezone?: string },
  context: z.RefinementCtx,
): void {
  const expression = input.cron?.trim();
  if (!expression) {
    return;
  }
  const cadence: ScheduleCadence = {
    type: "cron",
    expression,
    ...(input.timezone !== undefined ? { timezone: input.timezone.trim() } : {}),
  };
  try {
    validateScheduleCadence(cadence);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.addIssue({
      code: "custom",
      path: [message.startsWith("Invalid cron time zone:") ? "timezone" : "cron"],
      message,
    });
    return;
  }
  try {
    computeNextRunAt(cadence, new Date());
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["cron"],
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseToolArguments<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new PaseoToolInputError(result.error.message, result.error.issues);
  }
  return result.data;
}

function addScheduleDurationIssue(value: string, context: z.RefinementCtx): void {
  try {
    parseDurationString(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const scheduleDurationInputSchema = z.string().superRefine(addScheduleDurationIssue);

function resolveScheduleUpdateCadence(input: ScheduleUpdateToolInput): ScheduleCadence | undefined {
  const every = normalizeScheduleCadenceArg(input.every);
  const cron = normalizeScheduleCadenceArg(input.cron);
  const timeZone = normalizeScheduleTimeZoneArg(input.timezone);

  if (every !== undefined && cron !== undefined) {
    throw new PaseoToolInputError("Specify at most one of every or cron");
  }
  if (timeZone !== undefined && cron === undefined) {
    throw new PaseoToolInputError("timezone can only be used with cron");
  }
  if (every !== undefined) {
    // COMPAT(scheduleEveryInput): accept the old hidden field and canonicalize it before write.
    // Added in v0.2.0; remove after 2027-01-17.
    const everyMs = parseDurationString(parseToolArguments(scheduleDurationInputSchema, every));
    const expression = everyMsToFiveFieldCron(everyMs);
    if (expression) {
      return { type: "cron", expression };
    }
    throw new PaseoToolInputError(`${every} cannot be represented faithfully by five-field cron`);
  }
  if (cron !== undefined) {
    return {
      type: "cron",
      expression: cron,
      ...(timeZone !== undefined ? { timezone: timeZone } : {}),
    };
  }
  return undefined;
}

function resolveScheduleUpdateExpiresAt(input: ScheduleUpdateToolInput): string | null | undefined {
  if (input.expiresIn !== undefined && input.clearExpires) {
    throw new PaseoToolInputError("Specify at most one of expiresIn or clearExpires");
  }
  if (input.expiresIn !== undefined) {
    return new Date(Date.now() + parseDurationString(input.expiresIn)).toISOString();
  }
  if (input.clearExpires) {
    return null;
  }
  return undefined;
}

function buildScheduleUpdateInput(input: ScheduleUpdateToolInput): UpdateScheduleInput {
  const cadence = resolveScheduleUpdateCadence(input);
  const expiresAt = resolveScheduleUpdateExpiresAt(input);
  const providerModelPatch = resolveScheduleUpdateProviderAndModel({
    provider: input.provider,
    model: input.model,
  });
  const newAgentConfig = {
    ...(providerModelPatch.provider !== undefined ? { provider: providerModelPatch.provider } : {}),
    ...(providerModelPatch.model !== undefined ? { model: providerModelPatch.model } : {}),
    ...(input.mode !== undefined ? { modeId: input.mode } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  };

  return {
    id: input.id,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(cadence !== undefined ? { cadence } : {}),
    ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(Object.keys(newAgentConfig).length > 0 ? { newAgentConfig } : {}),
  };
}

function resolveChildAgentCwd(params: {
  parentCwd: string;
  requestedCwd?: string;
  lockedCwd?: string;
  allowCustomCwd: boolean;
}): string {
  const lockedCwd = params.lockedCwd?.trim();
  if (lockedCwd) {
    return expandUserPath(lockedCwd);
  }

  const requestedCwd = params.requestedCwd?.trim();
  if (!requestedCwd || !params.allowCustomCwd) {
    return params.parentCwd;
  }

  return resolvePathFromBase(params.parentCwd, requestedCwd);
}

const TerminalSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
});

interface TerminalKeyTokenInput {
  key: string;
  literal: boolean;
  preamble: string;
}

function resolveTerminalKeyToken({ key, literal, preamble }: TerminalKeyTokenInput): string {
  if (literal) {
    return key;
  }

  const match = /^((?:[CMS]-)*)(.+)$/.exec(key);
  if (!match) {
    return key;
  }
  const [, modifiers, token] = match;
  const aliases: Record<string, string> = {
    Up: "ArrowUp",
    Down: "ArrowDown",
    Left: "ArrowLeft",
    Right: "ArrowRight",
    BSpace: "Backspace",
    Space: " ",
  };
  const inputMode = new TerminalInputModeTracker();
  inputMode.feed(preamble);
  const encodedKey = Object.hasOwn(aliases, token) ? aliases[token] : token;
  return (
    encodeTerminalKeyInput(
      {
        key: encodedKey,
        ctrl: modifiers.includes("C-"),
        alt: modifiers.includes("M-"),
        shift: modifiers.includes("S-"),
      },
      { inputMode: inputMode.getState() },
    ) || key
  );
}

const DEFAULT_MAX_PEER_HOPS = 4;
const MAX_ALLOWED_PEER_HOPS = 6;
const DEFAULT_MAX_PEER_MESSAGES_PER_MINUTE = 6;
const DEFAULT_PEER_CIRCUIT_COOLDOWN_MS = 60_000;
const PEER_RATE_WINDOW_MS = 60_000;
const MAX_TRACKED_PEER_THREADS = 2000;
const MAX_TRACKED_PEER_MESSAGES = 2000;
const MAX_TRACKED_PEER_WINDOWS = 256;
const PEER_TRUSTED_WORKSPACES_METADATA_KEY = "paseo.trustedPeerWorkspaces";
const PEER_TRUSTED_TARGET_AGENTS_METADATA_KEY = "paseo.trustedPeerTargetAgents";
const PEER_REQUIRE_APPROVAL_METADATA_KEY = "paseo.requirePeerApproval";
const PEER_ALLOW_LOCAL_METADATA_KEY = "paseo.allowLocalPeerMessages";
const PEER_INSPECTION_PROMPT_PREFIX = formatPeerInspectionPromptPrefix();

const PEER_READ_ONLY_TOOLS = new Set([
  "list_workspaces",
  "summarize_workspace_agents",
  "list_workspace_tasks",
  "get_workspace_situation",
  "list_agents",
  "get_agent_status",
  "get_agent_activity",
  "list_profiles",
  "list_providers",
  "list_models",
  "inspect_provider",
  "list_hosts",
  "list_workspace_scripts",
  "list_terminals",
  "capture_terminal",
  "list_schedules",
  "inspect_schedule",
  "schedule_logs",
  "list_pending_permissions",
  "request_human_decision",
  "report_to_parent",
  "browser_list_hosts",
  "browser_list_tabs",
  "browser_snapshot",
  "browser_screenshot",
  "browser_logs",
]);

const PEER_ALLOWED_EXPLICIT_MODES = new Set(["read-only", "plan"]);

function isPeerExplicitModeDisallowed(modeId: unknown): boolean {
  if (typeof modeId !== "string") return false;
  const trimmed = modeId.trim().toLowerCase();
  if (!trimmed) return false;
  return !PEER_ALLOWED_EXPLICIT_MODES.has(trimmed);
}

function hasPeerDisallowedProviderOptions(optionsRecord: unknown): boolean {
  if (!optionsRecord || typeof optionsRecord !== "object") return false;
  const record = optionsRecord as Record<string, unknown>;
  if (record.sandbox_mode !== undefined && record.sandbox_mode !== "read-only") return true;
  if (record.mainControlReadOnly === false) return true;
  if (record.disallowedTools !== undefined || record.permission !== undefined) return true;
  return false;
}

function readWorkspaceStringSet(
  workspace: PersistedWorkspaceRecord,
  metadataKey: string,
): ReadonlySet<string> {
  const raw = workspace.metadata?.[metadataKey];
  if (!Array.isArray(raw)) return new Set();
  return new Set(
    raw.flatMap((entry) => (typeof entry === "string" && entry.trim() ? [entry.trim()] : [])),
  );
}

function readWorkspaceTrustedPeers(workspace: PersistedWorkspaceRecord): ReadonlySet<string> {
  return readWorkspaceStringSet(workspace, PEER_TRUSTED_WORKSPACES_METADATA_KEY);
}

function readWorkspaceTrustedTargetAgents(
  workspace: PersistedWorkspaceRecord,
): ReadonlySet<string> {
  return readWorkspaceStringSet(workspace, PEER_TRUSTED_TARGET_AGENTS_METADATA_KEY);
}

function workspaceRequiresPeerApproval(workspace: PersistedWorkspaceRecord): boolean {
  if (workspace.metadata?.[PEER_REQUIRE_APPROVAL_METADATA_KEY] === true) return true;
  if (workspace.metadata?.[PEER_ALLOW_LOCAL_METADATA_KEY] === false) return true;
  return false;
}

interface BasePeerThreadSnapshot {
  correlationId: string;
  maxHops: number;
  hop: number;
  expectReply: boolean;
  lastSourceWorkspaceId: string;
  lastSourceAgentId: string;
  lastTargetWorkspaceId: string;
  lastTargetAgentId: string;
  repliedHops: number[];
  admitted: boolean;
}

interface PeerThreadState {
  correlationId: string;
  maxHops: number;
  hop: number;
  expectReply: boolean;
  lastSourceWorkspaceId: string;
  lastSourceAgentId: string;
  lastTargetWorkspaceId: string;
  lastTargetAgentId: string;
  repliedHops: Set<number>;
  admitted: boolean;
  confirmedSnapshot?: BasePeerThreadSnapshot;
  highestUnknownSnapshot?: BasePeerThreadSnapshot;
  unknownReplyHops?: number[];
}

interface PeerLockGrant {
  grantId: string;
  dispatchId?: string;
  correlationId: string;
  lockedHumanCount: number;
}

interface PeerPairWindow {
  timestamps: number[];
  trippedUntil: number;
}

type SerializedPeerThread = z.infer<typeof persistedPeerThreadSchema>;

type PersistedPeerEnvelope = Extract<AgentPromptSource, { kind: "peer-workspace-message" }> & {
  dispatchId: string;
  recipientAgentId: string;
  activeAttemptId?: string;
  lastAttemptId?: string;
  settled?: boolean;
  deliveryOutcome?: "accepted" | "outcome_unknown";
  legacyUnconfirmed?: true;
  replyToHop?: number;
  inboundThread?: SerializedPeerThread;
};

interface PersistedPeerChildDispatch {
  dispatchId: string;
  senderAgentId: string;
  senderServerId?: string;
  senderWorkspaceId: string | null;
  recipientAgentId: string;
  correlationId: string;
  activeAttemptId?: string;
  lastAttemptId?: string;
  settled?: boolean;
  deliveryOutcome?: "accepted" | "outcome_unknown";
}

interface PeerRuntimeMaps {
  threads: Map<string, PeerThreadState>;
  byMessageId: Map<string, PersistedPeerEnvelope>;
  inboundAgentLocks: Map<string, Map<string, PeerLockGrant>>;
  lockedChildren: Map<string, Map<string, PeerLockGrant>>;
  pendingChildDispatches: Map<string, PersistedPeerChildDispatch>;
  pairWindows: Map<string, PeerPairWindow>;
}

interface PendingPeerOutcomeRecord {
  outcomeKey: string;
  dispatchId: string;
  outcome: PeerDispatchTerminalOutcome;
  context: PeerDispatchEndpointContext;
}

interface PeerWorkspaceRuntime extends PeerRuntimeMaps {
  paseoHome?: string;
  readRecipientTimeline(
    agentId: string,
  ): Promise<Awaited<ReturnType<AgentManager["readStoredTimeline"]>> | null>;
  loadPromise: Promise<void> | null;
  loadedFromDisk: boolean;
  stateMutex: Promise<void>;
  pendingOutcomes: Map<string, PendingPeerOutcomeRecord>;
}

function cloneBaseThreadSnapshot(
  snapshot: BasePeerThreadSnapshot | undefined,
): BasePeerThreadSnapshot | undefined {
  if (!snapshot) return undefined;
  return { ...snapshot, repliedHops: [...snapshot.repliedHops] };
}

function toBasePeerThreadSnapshot(thread: PeerThreadState): BasePeerThreadSnapshot {
  return {
    correlationId: thread.correlationId,
    maxHops: thread.maxHops,
    hop: thread.hop,
    expectReply: thread.expectReply,
    lastSourceWorkspaceId: thread.lastSourceWorkspaceId,
    lastSourceAgentId: thread.lastSourceAgentId,
    lastTargetWorkspaceId: thread.lastTargetWorkspaceId,
    lastTargetAgentId: thread.lastTargetAgentId,
    repliedHops: [...thread.repliedHops],
    admitted: thread.admitted,
  };
}

function deserializeBasePeerThread(snapshot: BasePeerThreadSnapshot): PeerThreadState {
  return {
    ...snapshot,
    repliedHops: new Set(snapshot.repliedHops),
  };
}

function clonePeerThreadState(thread: PeerThreadState): PeerThreadState {
  return {
    ...thread,
    repliedHops: new Set(thread.repliedHops),
    confirmedSnapshot: cloneBaseThreadSnapshot(thread.confirmedSnapshot),
    highestUnknownSnapshot: cloneBaseThreadSnapshot(thread.highestUnknownSnapshot),
    unknownReplyHops: thread.unknownReplyHops?.slice(),
  };
}

function cloneGrantMap(
  source: Map<string, Map<string, PeerLockGrant>>,
): Map<string, Map<string, PeerLockGrant>> {
  const outer = new Map<string, Map<string, PeerLockGrant>>();
  for (const [agentId, grants] of source) {
    const inner = new Map<string, PeerLockGrant>();
    for (const [grantId, grant] of grants) {
      inner.set(grantId, { ...grant });
    }
    outer.set(agentId, inner);
  }
  return outer;
}

function clonePeerRuntimeMaps(source: PeerRuntimeMaps): PeerRuntimeMaps {
  const threads = new Map<string, PeerThreadState>();
  for (const [id, thread] of source.threads) {
    threads.set(id, clonePeerThreadState(thread));
  }
  const byMessageId = new Map<string, PersistedPeerEnvelope>();
  for (const [id, entry] of source.byMessageId) {
    byMessageId.set(id, { ...entry });
  }
  const pendingChildDispatches = new Map<string, PersistedPeerChildDispatch>();
  for (const [id, entry] of source.pendingChildDispatches) {
    pendingChildDispatches.set(id, { ...entry });
  }
  const pairWindows = new Map<string, PeerPairWindow>();
  for (const [key, win] of source.pairWindows) {
    pairWindows.set(key, { timestamps: [...win.timestamps], trippedUntil: win.trippedUntil });
  }
  return {
    threads,
    byMessageId,
    inboundAgentLocks: cloneGrantMap(source.inboundAgentLocks),
    lockedChildren: cloneGrantMap(source.lockedChildren),
    pendingChildDispatches,
    pairWindows,
  };
}

function applyPeerRuntimeMaps(runtime: PeerWorkspaceRuntime, next: PeerRuntimeMaps): void {
  runtime.threads = next.threads;
  runtime.byMessageId = next.byMessageId;
  runtime.inboundAgentLocks = next.inboundAgentLocks;
  runtime.lockedChildren = next.lockedChildren;
  runtime.pendingChildDispatches = next.pendingChildDispatches;
  runtime.pairWindows = next.pairWindows;
}

function setBoundedMapEntryWithUndo<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
  canEvict: (candidateKey: K, candidateValue: V) => boolean = () => true,
): (target: Map<K, V>) => void {
  const hadPrevious = map.has(key);
  const previousValue = map.get(key);
  if (hadPrevious) map.delete(key);
  map.set(key, value);
  const evicted: Array<[K, V]> = [];
  while (map.size > maxEntries) {
    let victimKey: K | undefined;
    for (const [candidateKey, candidateValue] of map) {
      if (candidateKey !== key && canEvict(candidateKey, candidateValue)) {
        victimKey = candidateKey;
        break;
      }
    }
    if (victimKey === undefined) break;
    evicted.push([victimKey, map.get(victimKey)!]);
    map.delete(victimKey);
  }
  return (target) => {
    if (hadPrevious && previousValue !== undefined) {
      target.set(key, previousValue);
    } else {
      target.delete(key);
    }
    for (const [victimKey, victimValue] of evicted) {
      if (!target.has(victimKey)) target.set(victimKey, victimValue);
    }
  };
}

function hasUnsettledDispatchForThread(correlationId: string, state: PeerRuntimeMaps): boolean {
  for (const msg of state.byMessageId.values()) {
    if (!msg.settled && msg.correlationId === correlationId) return true;
  }
  for (const child of state.pendingChildDispatches.values()) {
    if (!child.settled && child.correlationId === correlationId) return true;
  }
  return false;
}

function hasActiveGrantForThread(
  correlationId: string,
  lockMap: Map<string, Map<string, PeerLockGrant>>,
  countHuman: (agentId: string) => number,
): boolean {
  for (const [agentId, grants] of lockMap) {
    const humanCount = countHuman(agentId);
    for (const grant of grants.values()) {
      if (grant.correlationId === correlationId && humanCount <= grant.lockedHumanCount) {
        return true;
      }
    }
  }
  return false;
}

function selectThreadEvictionVictim(
  draft: PeerRuntimeMaps,
  protectedCorrelationId: string,
  countHuman: (agentId: string) => number,
): string | undefined {
  for (const [candidateId, candidate] of draft.threads) {
    const converged = !candidate.expectReply || candidate.repliedHops.has(candidate.hop);
    if (
      candidateId !== protectedCorrelationId &&
      converged &&
      !hasUnsettledDispatchForThread(candidateId, draft)
    ) {
      return candidateId;
    }
  }
  for (const candidateId of draft.threads.keys()) {
    if (
      candidateId !== protectedCorrelationId &&
      !hasUnsettledDispatchForThread(candidateId, draft) &&
      !hasActiveGrantForThread(candidateId, draft.inboundAgentLocks, countHuman) &&
      !hasActiveGrantForThread(candidateId, draft.lockedChildren, countHuman)
    ) {
      return candidateId;
    }
  }
  return undefined;
}

function setPeerThreadWithUndo(
  draft: PeerRuntimeMaps,
  correlationId: string,
  nextThread: PeerThreadState,
  countHuman: (agentId: string) => number,
): (target: Map<string, PeerThreadState>) => void {
  const existing = draft.threads.get(correlationId);
  const previous = existing ? clonePeerThreadState(existing) : undefined;
  if (existing) draft.threads.delete(correlationId);
  draft.threads.set(correlationId, nextThread);
  const evicted: Array<[string, PeerThreadState]> = [];
  while (draft.threads.size > MAX_TRACKED_PEER_THREADS) {
    const victimKey = selectThreadEvictionVictim(draft, correlationId, countHuman);
    if (victimKey === undefined) break;
    const victim = draft.threads.get(victimKey)!;
    evicted.push([victimKey, clonePeerThreadState(victim)]);
    draft.threads.delete(victimKey);
  }
  return (target) => {
    if (previous) target.set(correlationId, previous);
    else target.delete(correlationId);
    for (const [victimKey, victimThread] of evicted) {
      if (!target.has(victimKey)) target.set(victimKey, victimThread);
    }
  };
}

function revokeGrantByAttemptId(
  lockMap: Map<string, Map<string, PeerLockGrant>>,
  attemptId: string | undefined,
  preserveOuterMarkerGrantId?: string,
): boolean {
  if (!attemptId || attemptId === preserveOuterMarkerGrantId) return false;
  let changed = false;
  for (const [agentId, grants] of lockMap) {
    if (!grants.delete(attemptId)) continue;
    changed = true;
    if (grants.size === 0 && !preserveOuterMarkerGrantId) {
      lockMap.delete(agentId);
    }
  }
  return changed;
}

function revokeGrantsByDispatchId(
  lockMap: Map<string, Map<string, PeerLockGrant>>,
  dispatchId: string,
  preserveOuterMarkerGrantId?: string,
): boolean {
  let changed = false;
  for (const [agentId, grants] of lockMap) {
    for (const [grantId, grant] of grants) {
      if (grantId === preserveOuterMarkerGrantId) continue;
      if (grant.dispatchId === dispatchId || grantId === dispatchId) {
        grants.delete(grantId);
        changed = true;
      }
    }
    if (grants.size === 0 && !preserveOuterMarkerGrantId) {
      lockMap.delete(agentId);
    }
  }
  return changed;
}

function isProtectedPeerDelivery(
  key: string,
  entry: PersistedPeerEnvelope,
  inboundAgentLocks: Map<string, Map<string, PeerLockGrant>>,
): boolean {
  if (!entry.settled) return true;
  const grants = inboundAgentLocks.get(entry.recipientAgentId);
  if (!grants) return false;
  for (const grant of grants.values()) {
    if (grant.dispatchId === key || grant.grantId === key) return true;
  }
  return false;
}

function setPeerDeliveryRecordWithUndo(
  map: Map<string, PersistedPeerEnvelope>,
  inboundAgentLocks: Map<string, Map<string, PeerLockGrant>>,
  dispatchId: string,
  value: PersistedPeerEnvelope,
): (target: Map<string, PersistedPeerEnvelope>) => void {
  if (map.has(dispatchId)) map.delete(dispatchId);
  map.set(dispatchId, value);
  const evicted: Array<[string, PersistedPeerEnvelope]> = [];
  while (map.size > MAX_TRACKED_PEER_MESSAGES) {
    let victimKey: string | undefined;
    for (const [key, entry] of map) {
      if (
        key !== dispatchId &&
        entry.intent === "reply" &&
        !isProtectedPeerDelivery(key, entry, inboundAgentLocks)
      ) {
        victimKey = key;
        break;
      }
    }
    if (victimKey === undefined) {
      for (const [key, entry] of map) {
        if (key !== dispatchId && !isProtectedPeerDelivery(key, entry, inboundAgentLocks)) {
          victimKey = key;
          break;
        }
      }
    }
    if (victimKey === undefined) break;
    evicted.push([victimKey, map.get(victimKey)!]);
    map.delete(victimKey);
  }
  return (target) => {
    target.delete(dispatchId);
    for (const [victimKey, victimEntry] of evicted) {
      if (!target.has(victimKey)) target.set(victimKey, victimEntry);
    }
  };
}

function grantAgentPeerLockWithUndo(
  lockMap: Map<string, Map<string, PeerLockGrant>>,
  agentId: string,
  grant: PeerLockGrant,
  currentHumanCount: number,
  preserveGrantId?: string,
): (target: Map<string, Map<string, PeerLockGrant>>) => void {
  const existingGrants = lockMap.get(agentId);
  const createdOuter = !existingGrants;
  const grants = existingGrants ?? new Map<string, PeerLockGrant>();
  const previousGrant = grants.get(grant.grantId);
  grants.set(grant.grantId, grant);
  const pruned: PeerLockGrant[] = [];
  if (grants.size > 32) {
    for (const [id, candidate] of grants) {
      if (
        id !== grant.grantId &&
        id !== preserveGrantId &&
        currentHumanCount > candidate.lockedHumanCount
      ) {
        pruned.push(candidate);
        grants.delete(id);
      }
    }
  }
  lockMap.set(agentId, grants);
  return (target) => {
    const targetGrants = target.get(agentId);
    if (!targetGrants) return;
    if (previousGrant) targetGrants.set(grant.grantId, previousGrant);
    else targetGrants.delete(grant.grantId);
    for (const restored of pruned) {
      if (!targetGrants.has(restored.grantId)) targetGrants.set(restored.grantId, restored);
    }
    if (createdOuter && targetGrants.size === 0) target.delete(agentId);
  };
}

const persistedPeerLockGrantSchema = z.object({
  grantId: z.string().min(1),
  dispatchId: z.string().min(1).optional(),
  correlationId: z.string().min(1),
  lockedHumanCount: z.number().int().min(0),
});

const legacyPeerLockEntrySchema = z.object({
  correlationId: z.string().min(1),
  lockedHumanCount: z.number().int().min(0),
});

const basePeerThreadSnapshotSchema = z.object({
  correlationId: z.string().min(1),
  maxHops: z.number().int().min(1),
  hop: z.number().int().min(1),
  expectReply: z.boolean(),
  lastSourceWorkspaceId: z.string().min(1),
  lastSourceAgentId: z.string().min(1),
  lastTargetWorkspaceId: z.string().min(1),
  lastTargetAgentId: z.string().min(1),
  repliedHops: z.array(z.number().int().min(1)),
  admitted: z.boolean(),
});

const persistedPeerThreadSchema = basePeerThreadSnapshotSchema.extend({
  hasConfirmedHop: z.boolean().optional(),
  confirmedSnapshot: basePeerThreadSnapshotSchema.optional(),
  highestUnknownSnapshot: basePeerThreadSnapshotSchema.optional(),
  unknownReplyHops: z.array(z.number().int().min(1)).optional(),
});

const persistedPeerChildDispatchSchema = z.object({
  dispatchId: z.string().min(1),
  senderAgentId: z.string().min(1),
  senderServerId: z.string().min(1).optional(),
  senderWorkspaceId: z.string().nullable(),
  recipientAgentId: z.string().min(1),
  correlationId: z.string().min(1),
  activeAttemptId: z.string().min(1).optional(),
  lastAttemptId: z.string().min(1).optional(),
  settled: z.boolean().optional(),
  deliveryOutcome: z.enum(["accepted", "outcome_unknown"]).optional(),
});

const pendingPeerOutcomeRecordSchema = z.object({
  outcomeKey: z.string().min(1),
  dispatchId: z.string().min(1),
  outcome: z.enum([
    "accepted",
    "retained_for_restart",
    "outcome_unknown",
    "definitively_unsent",
    "returned_to_queue",
  ]),
  context: z.object({
    kind: z.enum(["peer-workspace", "peer-child"]),
    recipientId: z.string().min(1),
    senderAgentId: z.string().min(1).optional(),
    senderServerId: z.string().min(1).optional(),
    attemptId: z.string().min(1).optional(),
    ownsReservation: z.boolean().optional(),
  }),
});

const persistedAgentGrantsTupleSchema = z.tuple([
  z.string().min(1),
  z.union([z.array(persistedPeerLockGrantSchema), legacyPeerLockEntrySchema]),
]);

const persistedPeerStateFileSchema = z.object({
  separatesUnknownOutcomes: z.literal(true).optional(),
  threads: z.array(persistedPeerThreadSchema).optional(),
  messages: z.array(z.tuple([z.string().min(1), z.record(z.string(), z.unknown())])).optional(),
  inboundAgentLocks: z.array(persistedAgentGrantsTupleSchema).optional(),
  lockedChildren: z.array(persistedAgentGrantsTupleSchema).optional(),
  pendingChildDispatches: z.array(persistedPeerChildDispatchSchema).optional(),
});

function serializePeerThread(thread: PeerThreadState): SerializedPeerThread {
  const confirmedSnapshot = cloneBaseThreadSnapshot(thread.confirmedSnapshot);
  return {
    ...toBasePeerThreadSnapshot(thread),
    hasConfirmedHop: Boolean(confirmedSnapshot),
    ...(confirmedSnapshot ? { confirmedSnapshot } : {}),
    highestUnknownSnapshot: thread.highestUnknownSnapshot,
    unknownReplyHops: thread.unknownReplyHops,
  };
}

function deserializePeerThread(thread: SerializedPeerThread): PeerThreadState {
  const { hasConfirmedHop: _ignored, confirmedSnapshot: rawConfirmed, ...rest } = thread;
  const confirmedSnapshot = cloneBaseThreadSnapshot(rawConfirmed);
  return {
    ...rest,
    repliedHops: new Set(rest.repliedHops),
    ...(confirmedSnapshot ? { confirmedSnapshot } : {}),
  };
}

function matchesPersistedPeerWorkspaceEndpoints(
  msg: PersistedPeerEnvelope,
  endpoint: { recipientId: string; senderAgentId?: string; senderServerId?: string },
): boolean {
  return (
    msg.recipientAgentId === endpoint.recipientId &&
    msg.agentId === endpoint.senderAgentId &&
    (msg.serverId ?? undefined) === (endpoint.senderServerId ?? undefined)
  );
}

function matchesPersistedPeerChildEndpoints(
  child: PersistedPeerChildDispatch,
  endpoint: { recipientId: string; senderAgentId?: string; senderServerId?: string },
): boolean {
  return (
    child.recipientAgentId === endpoint.recipientId &&
    child.senderAgentId === endpoint.senderAgentId &&
    (child.senderServerId ?? undefined) === (endpoint.senderServerId ?? undefined)
  );
}

function matchesRecordedOutcomeContext(
  draft: PeerRuntimeMaps,
  dispatchId: string,
  context: PeerDispatchEndpointContext,
): boolean {
  if (context.kind === "peer-workspace") {
    const msg = draft.byMessageId.get(dispatchId);
    return Boolean(msg && matchesPersistedPeerWorkspaceEndpoints(msg, context));
  }
  const child = draft.pendingChildDispatches.get(dispatchId);
  return Boolean(child && matchesPersistedPeerChildEndpoints(child, context));
}

function peerSnapshotFromMessage(msg: PersistedPeerEnvelope): BasePeerThreadSnapshot {
  return {
    correlationId: msg.correlationId,
    maxHops: msg.maxHops,
    hop: msg.hop,
    expectReply: msg.expectReply,
    lastSourceWorkspaceId: msg.sourceWorkspaceId,
    lastSourceAgentId: msg.agentId,
    lastTargetWorkspaceId: msg.targetWorkspaceId,
    lastTargetAgentId: msg.recipientAgentId,
    repliedHops: [],
    admitted: true,
  };
}

function persistedReplyTargetHop(msg: PersistedPeerEnvelope): number | undefined {
  // Older queued replies already stored their confirmed inbound snapshot.
  return msg.intent === "reply" ? (msg.replyToHop ?? msg.inboundThread?.hop) : undefined;
}

function recordPeerThreadOutcome(
  draft: PeerRuntimeMaps,
  msg: PersistedPeerEnvelope,
  outcome: "accepted" | "outcome_unknown",
): void {
  const snapshot = peerSnapshotFromMessage(msg);
  const thread = draft.threads.get(msg.correlationId) ?? deserializeBasePeerThread(snapshot);
  const replyToHop = persistedReplyTargetHop(msg);
  if (replyToHop !== undefined) thread.repliedHops.add(replyToHop);
  if (outcome === "accepted") {
    const previous = thread.confirmedSnapshot;
    const repliedHops = new Set(previous?.repliedHops);
    if (replyToHop !== undefined) repliedHops.add(replyToHop);
    const latest = previous && previous.hop > msg.hop ? previous : snapshot;
    thread.confirmedSnapshot = { ...latest, repliedHops: [...repliedHops] };
    thread.admitted = true;
  } else {
    if (!thread.highestUnknownSnapshot || msg.hop > thread.highestUnknownSnapshot.hop)
      thread.highestUnknownSnapshot = snapshot;
    if (replyToHop !== undefined)
      thread.unknownReplyHops = [...new Set([...(thread.unknownReplyHops ?? []), replyToHop])];
  }
  draft.threads.set(msg.correlationId, thread);
}

function pruneUnlockedInboundGrants(
  inboundAgentLocks: Map<string, Map<string, PeerLockGrant>>,
  countHuman: (agentId: string) => number,
): void {
  for (const [agentId, grants] of inboundAgentLocks) {
    const humanCount = countHuman(agentId);
    for (const [id, grant] of grants) {
      if (humanCount > grant.lockedHumanCount) grants.delete(id);
    }
    if (grants.size === 0) inboundAgentLocks.delete(agentId);
  }
}

function settlePeerDispatchInDraft(
  draft: PeerRuntimeMaps,
  dispatchId: string,
  kind: PeerDispatchEndpointContext["kind"],
  outcome: "accepted" | "outcome_unknown",
  countHuman: (agentId: string) => number,
): void {
  if (kind === "peer-workspace") {
    const msg = draft.byMessageId.get(dispatchId);
    if (msg) {
      const { activeAttemptId: _cleared, ...rest } = msg;
      draft.byMessageId.set(dispatchId, { ...rest, settled: true, deliveryOutcome: outcome });
      recordPeerThreadOutcome(draft, msg, outcome);
    }
    pruneUnlockedInboundGrants(draft.inboundAgentLocks, countHuman);
    return;
  }
  const child = draft.pendingChildDispatches.get(dispatchId);
  if (child) {
    const { activeAttemptId: _cleared, ...rest } = child;
    draft.pendingChildDispatches.set(dispatchId, {
      ...rest,
      settled: true,
      deliveryOutcome: outcome,
    });
  }
}

function reconcileThreadAfterUnsentRemoval(
  draft: PeerRuntimeMaps,
  removedMsg: PersistedPeerEnvelope,
): void {
  const { correlationId } = removedMsg;
  const currentThread = draft.threads.get(correlationId);
  const confirmedSnapshot = currentThread?.confirmedSnapshot;
  const highestUnknownSnapshot = currentThread?.highestUnknownSnapshot;
  let latest = confirmedSnapshot;
  if (highestUnknownSnapshot && (!latest || highestUnknownSnapshot.hop > latest.hop))
    latest = highestUnknownSnapshot;
  const repliedHops = new Set([
    ...(confirmedSnapshot?.repliedHops ?? []),
    ...(currentThread?.unknownReplyHops ?? []),
  ]);
  for (const candidate of draft.byMessageId.values()) {
    if (candidate.settled || candidate.correlationId !== correlationId) continue;
    const replyToHop = persistedReplyTargetHop(candidate);
    if (replyToHop !== undefined) repliedHops.add(replyToHop);
    if (!latest || candidate.hop > latest.hop) latest = peerSnapshotFromMessage(candidate);
  }
  if (latest) {
    draft.threads.set(correlationId, {
      ...deserializeBasePeerThread(latest),
      repliedHops,
      admitted: Boolean(confirmedSnapshot?.admitted),
      confirmedSnapshot,
      highestUnknownSnapshot,
      unknownReplyHops: currentThread?.unknownReplyHops,
    });
    return;
  }
  draft.threads.delete(correlationId);
}

function cleanupUnsentPeerDispatchInDraft(
  draft: PeerRuntimeMaps,
  dispatchId: string,
  kind: PeerDispatchEndpointContext["kind"],
): void {
  if (kind === "peer-child") {
    revokeGrantsByDispatchId(draft.lockedChildren, dispatchId, "initial");
    draft.pendingChildDispatches.delete(dispatchId);
    return;
  }
  revokeGrantsByDispatchId(draft.inboundAgentLocks, dispatchId);
  const msg = draft.byMessageId.get(dispatchId);
  if (!msg) return;
  draft.byMessageId.delete(dispatchId);
  reconcileThreadAfterUnsentRemoval(draft, msg);
}

function revokeAttemptGrantForKind(
  draft: PeerRuntimeMaps,
  kind: PeerDispatchEndpointContext["kind"],
  attemptId: string | undefined,
): void {
  if (kind === "peer-child") {
    revokeGrantByAttemptId(draft.lockedChildren, attemptId, "initial");
  } else {
    revokeGrantByAttemptId(draft.inboundAgentLocks, attemptId);
  }
}

function clearActiveAttemptOnReturn(
  draft: PeerRuntimeMaps,
  dispatchId: string,
  context: PeerDispatchEndpointContext,
): void {
  if (!context.attemptId) return;
  if (context.kind === "peer-child") {
    const child = draft.pendingChildDispatches.get(dispatchId);
    if (child && child.activeAttemptId === context.attemptId) {
      const { activeAttemptId: _cleared, ...rest } = child;
      draft.pendingChildDispatches.set(dispatchId, rest);
    }
    return;
  }
  const msg = draft.byMessageId.get(dispatchId);
  if (msg && msg.activeAttemptId === context.attemptId) {
    const { activeAttemptId: _cleared, ...rest } = msg;
    draft.byMessageId.set(dispatchId, rest);
  }
}

function matchesPeerAttempt(
  record: { settled?: boolean; activeAttemptId?: string; lastAttemptId?: string },
  context: PeerDispatchEndpointContext,
): boolean {
  if (record.settled) return false;
  if (record.activeAttemptId) return context.attemptId === record.activeAttemptId;
  return context.ownsReservation === true && Boolean(context.attemptId || !record.lastAttemptId);
}

function peerOutcomeRecord(
  draft: PeerRuntimeMaps,
  dispatchId: string,
  context: PeerDispatchEndpointContext,
) {
  return context.kind === "peer-child"
    ? draft.pendingChildDispatches.get(dispatchId)
    : draft.byMessageId.get(dispatchId);
}

function matchesPeerAcceptanceAttempt(
  record: NonNullable<ReturnType<typeof peerOutcomeRecord>>,
  attemptId: string | undefined,
): boolean {
  if (!attemptId) return false;
  if (!record.settled) return attemptId === record.activeAttemptId;
  return record.deliveryOutcome !== undefined && attemptId === record.lastAttemptId;
}

function applySinglePeerOutcomeInDraft(
  draft: PeerRuntimeMaps,
  dispatchId: string,
  outcome: PeerDispatchTerminalOutcome,
  context: PeerDispatchEndpointContext,
  countHuman: (agentId: string) => number,
): boolean {
  if (!matchesRecordedOutcomeContext(draft, dispatchId, context)) return false;
  const targetRecord = peerOutcomeRecord(draft, dispatchId, context);
  if (!targetRecord) return false;
  if (outcome === "accepted") {
    if (!matchesPeerAcceptanceAttempt(targetRecord, context.attemptId)) return false;
    if (targetRecord.deliveryOutcome !== "accepted") {
      settlePeerDispatchInDraft(draft, dispatchId, context.kind, outcome, countHuman);
    }
    return true;
  }
  if (!matchesPeerAttempt(targetRecord, context)) return false;
  if (outcome === "outcome_unknown") {
    if (!context.attemptId || context.attemptId !== targetRecord.activeAttemptId) return false;
    settlePeerDispatchInDraft(draft, dispatchId, context.kind, outcome, countHuman);
    return true;
  }
  if (outcome === "returned_to_queue" || outcome === "retained_for_restart") {
    clearActiveAttemptOnReturn(draft, dispatchId, context);
    revokeAttemptGrantForKind(draft, context.kind, context.attemptId);
    return true;
  }
  cleanupUnsentPeerDispatchInDraft(draft, dispatchId, context.kind);
  return true;
}

function serializeGrantMap(
  lockMap: Map<string, Map<string, PeerLockGrant>>,
): Array<[string, PeerLockGrant[]]> {
  return Array.from(lockMap.entries(), ([agentId, grants]) => [agentId, [...grants.values()]]);
}

function hydrateGrantEntries(
  target: Map<string, Map<string, PeerLockGrant>>,
  entries: z.infer<typeof persistedAgentGrantsTupleSchema>[] | undefined,
  defaultGrantId: string,
): void {
  for (const [agentId, rawGrants] of entries ?? []) {
    if (target.has(agentId)) continue;
    const grants = new Map<string, PeerLockGrant>();
    if (Array.isArray(rawGrants)) {
      for (const grant of rawGrants) grants.set(grant.grantId, grant);
    } else {
      grants.set(defaultGrantId, { grantId: defaultGrantId, ...rawGrants });
    }
    if (grants.size > 0) target.set(agentId, grants);
  }
}

function invalidatePeerRuntimeCache(runtime: PeerWorkspaceRuntime): void {
  runtime.loadedFromDisk = false;
  runtime.loadPromise = null;
  runtime.threads.clear();
  runtime.byMessageId.clear();
  runtime.inboundAgentLocks.clear();
  runtime.lockedChildren.clear();
  runtime.pendingChildDispatches.clear();
}

async function restoreLegacyPeerConfirmation(
  runtime: PeerWorkspaceRuntime,
  journal: PendingPeerOutcomeRecord[],
): Promise<void> {
  const accepted = new Set<string>();
  for (const { dispatchId, outcome, context } of journal) {
    if (
      outcome !== "accepted" ||
      context.kind !== "peer-workspace" ||
      !matchesRecordedOutcomeContext(runtime, dispatchId, context)
    )
      continue;
    accepted.add(dispatchId);
  }
  for (const message of runtime.byMessageId.values()) {
    if (message.legacyUnconfirmed && accepted.has(message.dispatchId))
      settleLegacyPeerAcceptance(runtime, message);
  }
  for (const message of await findLegacyPeerAcceptances(runtime))
    settleLegacyPeerAcceptance(runtime, message);
}

function settleLegacyPeerAcceptance(draft: PeerRuntimeMaps, message: PersistedPeerEnvelope): void {
  draft.byMessageId.set(message.dispatchId, {
    ...message,
    legacyUnconfirmed: undefined,
    deliveryOutcome: "accepted",
  });
  recordPeerThreadOutcome(draft, message, "accepted");
}

function matchLegacyPeerTimelineItem(
  item: AgentTimelineItem,
  candidates: ReadonlyMap<string, PersistedPeerEnvelope>,
) {
  if (
    item.type !== "tool_call" ||
    item.name !== "agent_message" ||
    item.status !== "completed" ||
    item.agentMessage?.event !== "message"
  )
    return;
  const id = parseProjectedPeerCallId(item.callId);
  if (!id) return;
  const message = candidates.get(id.messageId);
  if (
    !message ||
    id.correlationId !== message.correlationId ||
    id.intent !== message.intent ||
    item.agentMessage.sender.id !== message.agentId ||
    item.agentMessage.sender.serverId !== message.serverId
  )
    return;
  return { message, text: item.agentMessage.text };
}

async function findLegacyPeerAcceptances(
  runtime: PeerWorkspaceRuntime,
  correlationId?: string,
): Promise<PersistedPeerEnvelope[]> {
  const byRecipient = new Map<string, Map<string, PersistedPeerEnvelope>>();
  for (const message of runtime.byMessageId.values()) {
    if (!message.legacyUnconfirmed || (correlationId && message.correlationId !== correlationId))
      continue;
    const group = byRecipient.get(message.recipientAgentId) ?? new Map();
    group.set(message.dispatchId, message);
    byRecipient.set(message.recipientAgentId, group);
  }
  const accepted = new Set<PersistedPeerEnvelope>();
  const replayed = new Map<string, PersistedPeerEnvelope>();
  const secret =
    byRecipient.size && runtime.paseoHome
      ? await resolvePeerTransportSecret(runtime.paseoHome)
      : undefined;
  for (const [recipientId, candidates] of byRecipient) {
    const timeline = await runtime.readRecipientTimeline(recipientId).catch(() => null);
    for (const { item, turnId } of timeline?.rows ?? []) {
      const match = matchLegacyPeerTimelineItem(item, candidates);
      if (!match) continue;
      // The local accepted-turn projection has a turn ID. Replay alone lacks it
      // and needs the matching completed queue receipt, including the exact body.
      if (turnId) accepted.add(match.message);
      else if (secret) {
        const fingerprint = legacyPeerRequestFingerprint(match, secret);
        if (fingerprint) replayed.set(fingerprint, match.message);
      }
    }
  }
  if (runtime.paseoHome && replayed.size) {
    const receipts = new MessageReceipts(join(runtime.paseoHome, "agent-requests"));
    const matches = await receipts
      .findCompletedFingerprints(
        new Map(
          [...replayed].map(([fingerprint, message]) => [fingerprint, message.recipientAgentId]),
        ),
      )
      .catch(() => new Set<string>());
    for (const [fingerprint, message] of replayed)
      if (matches.has(fingerprint)) accepted.add(message);
  }
  return [...accepted];
}

function legacyPeerRequestFingerprint(
  { message, text }: { message: PersistedPeerEnvelope; text: string },
  secret: Buffer,
) {
  const prefix = projectedPeerMessagePrefix(message);
  if (!text.startsWith(prefix)) return;
  const {
    dispatchId,
    agentId,
    serverId,
    title,
    recipientAgentId,
    sourceWorkspaceId,
    sourceWorkspaceTitle,
    targetWorkspaceId,
    correlationId,
    intent,
    hop,
    maxHops,
    expectReply,
    subject,
  } = message;
  try {
    const prompt = encodePeerWorkspacePrompt(
      {
        dispatchId,
        senderAgentId: agentId,
        senderServerId: serverId,
        recipientAgentId,
        sourceWorkspaceId,
        sourceWorkspaceTitle,
        targetWorkspaceId,
        correlationId,
        intent,
        hop,
        maxHops,
        expectReply,
        subject,
      },
      text.slice(prefix.length),
      secret,
    );
    return fingerprintMessageRequest({
      prompt,
      source: { agentId, serverId, title },
      activeTurnBehavior: "queue",
      unarchive: false,
      notifyLocalCaller: false,
      notifyOnFinish: false,
    });
  } catch {
    // Unverifiable stale metadata cannot establish a completed request.
    return;
  }
}

function hydratePeerThread(
  runtime: PeerWorkspaceRuntime,
  rawThread: SerializedPeerThread,
  separatesUnknownOutcomes: boolean,
): PeerThreadState {
  const thread = deserializePeerThread(rawThread);
  if (!separatesUnknownOutcomes) {
    // This format used the same snapshot for acceptance and unknown provider results.
    // Keep its occupancy and consumption unless a durable outcome proves acceptance.
    const previous =
      thread.confirmedSnapshot ??
      (rawThread.hasConfirmedHop === undefined &&
      !hasUnsettledDispatchForThread(rawThread.correlationId, runtime)
        ? toBasePeerThreadSnapshot(thread)
        : undefined);
    thread.highestUnknownSnapshot = previous;
    thread.unknownReplyHops = previous?.repliedHops;
    thread.confirmedSnapshot = undefined;
    thread.admitted = false;
  } else if (
    rawThread.hasConfirmedHop === undefined &&
    !thread.confirmedSnapshot &&
    !hasUnsettledDispatchForThread(rawThread.correlationId, runtime)
  ) {
    thread.confirmedSnapshot = toBasePeerThreadSnapshot(thread);
  }
  return thread;
}

async function hydratePersistedPeerState(
  runtime: PeerWorkspaceRuntime,
  parsed: z.infer<typeof persistedPeerStateFileSchema>,
  journal: PendingPeerOutcomeRecord[],
): Promise<void> {
  hydrateGrantEntries(runtime.inboundAgentLocks, parsed.inboundAgentLocks, "legacy");
  hydrateGrantEntries(runtime.lockedChildren, parsed.lockedChildren, "initial");
  for (const [msgId, rawSource] of parsed.messages ?? []) {
    const validRecord =
      rawSource.kind === "peer-workspace-message" &&
      typeof rawSource.recipientAgentId === "string" &&
      rawSource.recipientAgentId.length > 0;
    if (validRecord && !runtime.byMessageId.has(msgId)) {
      setPeerDeliveryRecordWithUndo(runtime.byMessageId, runtime.inboundAgentLocks, msgId, {
        ...(rawSource as PersistedPeerEnvelope),
        dispatchId: typeof rawSource.dispatchId === "string" ? rawSource.dispatchId : msgId,
        ...(!parsed.separatesUnknownOutcomes &&
        rawSource.settled === true &&
        rawSource.deliveryOutcome === undefined
          ? { legacyUnconfirmed: true as const }
          : {}),
      });
    }
  }
  for (const childDispatch of parsed.pendingChildDispatches ?? []) {
    if (!runtime.pendingChildDispatches.has(childDispatch.dispatchId)) {
      setBoundedMapEntryWithUndo(
        runtime.pendingChildDispatches,
        childDispatch.dispatchId,
        childDispatch,
        MAX_TRACKED_PEER_MESSAGES,
        (_k, entry) => entry.settled === true,
      );
    }
  }
  for (const rawThread of parsed.threads ?? []) {
    if (runtime.threads.has(rawThread.correlationId)) continue;
    runtime.threads.set(
      rawThread.correlationId,
      hydratePeerThread(runtime, rawThread, parsed.separatesUnknownOutcomes === true),
    );
  }
  if (!parsed.separatesUnknownOutcomes) await restoreLegacyPeerConfirmation(runtime, journal);
}

async function readPendingOutcomesJournal(paseoHome: string): Promise<PendingPeerOutcomeRecord[]> {
  const journalPath = join(paseoHome, "agents", "peer-workspace-pending-outcomes.json");
  try {
    const raw = await readFile(journalPath, "utf8");
    return z.array(pendingPeerOutcomeRecordSchema).parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
}

async function writePendingOutcomesJournal(
  paseoHome: string | undefined,
  pendingOutcomes: ReadonlyMap<string, PendingPeerOutcomeRecord>,
): Promise<void> {
  if (!paseoHome || pendingOutcomes.size === 0) return;
  const agentsDir = join(paseoHome, "agents");
  const journalPath = join(agentsDir, "peer-workspace-pending-outcomes.json");
  await mkdir(agentsDir, { recursive: true });
  const tmpPath = `${journalPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmpPath, JSON.stringify([...pendingOutcomes.values()]), { mode: 0o600 });
  await rename(tmpPath, journalPath);
}

async function clearPendingOutcomesJournal(paseoHome: string | undefined): Promise<void> {
  if (!paseoHome) return;
  const journalPath = join(paseoHome, "agents", "peer-workspace-pending-outcomes.json");
  await unlink(journalPath).catch((error: NodeJS.ErrnoException) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

function replayPendingOutcomesIntoRuntime(runtime: PeerWorkspaceRuntime): void {
  for (const entry of runtime.pendingOutcomes.values()) {
    applySinglePeerOutcomeInDraft(runtime, entry.dispatchId, entry.outcome, entry.context, () => 0);
  }
}

function ensurePeerRuntimeLoaded(runtime: PeerWorkspaceRuntime): Promise<void> {
  if (runtime.loadedFromDisk || !runtime.paseoHome) return Promise.resolve();
  if (runtime.loadPromise) return runtime.loadPromise;
  const home = runtime.paseoHome;
  runtime.loadPromise = (async () => {
    await resolvePeerTransportSecret(home);
    const statePath = join(home, "agents", "peer-workspace-state.json");
    let rawText: string | undefined;
    try {
      rawText = await readFile(statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    const journalEntries = await readPendingOutcomesJournal(home);
    if (rawText !== undefined) {
      const parsed = persistedPeerStateFileSchema.parse(JSON.parse(rawText));
      await hydratePersistedPeerState(runtime, parsed, journalEntries);
    }
    for (const entry of journalEntries) {
      if (!runtime.pendingOutcomes.has(entry.outcomeKey)) {
        runtime.pendingOutcomes.set(entry.outcomeKey, entry);
      }
    }
    if (runtime.pendingOutcomes.size > 0) {
      replayPendingOutcomesIntoRuntime(runtime);
      try {
        await writePeerStateMapsToDisk(home, runtime);
        for (const entry of journalEntries) {
          if (runtime.pendingOutcomes.get(entry.outcomeKey) === entry) {
            runtime.pendingOutcomes.delete(entry.outcomeKey);
          }
        }
        if (runtime.pendingOutcomes.size === 0) {
          await clearPendingOutcomesJournal(home).catch(() => undefined);
        }
      } catch {
        // Keep pendingOutcomes in memory + journal for retry on next write.
      }
    }
    runtime.loadedFromDisk = true;
  })().catch((error) => {
    runtime.loadPromise = null;
    throw error;
  });
  return runtime.loadPromise;
}

async function writePeerStateMapsToDisk(
  paseoHome: string | undefined,
  state: PeerRuntimeMaps,
): Promise<void> {
  if (!paseoHome) return;
  const agentsDir = join(paseoHome, "agents");
  const statePath = join(agentsDir, "peer-workspace-state.json");
  const payload = {
    separatesUnknownOutcomes: true,
    threads: Array.from(state.threads.values(), serializePeerThread),
    messages: [...state.byMessageId.entries()],
    inboundAgentLocks: serializeGrantMap(state.inboundAgentLocks),
    lockedChildren: serializeGrantMap(state.lockedChildren),
    pendingChildDispatches: [...state.pendingChildDispatches.values()],
  };
  await mkdir(agentsDir, { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmpPath, JSON.stringify(payload), { mode: 0o600 });
  await rename(tmpPath, statePath);
}

async function finalizeFlushedPendingOutcomes(
  runtime: PeerWorkspaceRuntime,
  flushed: ReadonlyArray<PendingPeerOutcomeRecord>,
  releasedDispatches: ReadonlySet<string>,
): Promise<void> {
  if (flushed.length === 0) return;
  for (const entry of flushed) {
    if (runtime.pendingOutcomes.get(entry.outcomeKey) === entry) {
      runtime.pendingOutcomes.delete(entry.outcomeKey);
    }
    if (releasedDispatches.has(entry.dispatchId)) {
      releasePromptDispatchVerifier(entry.dispatchId);
    }
  }
  if (runtime.pendingOutcomes.size === 0) {
    await clearPendingOutcomesJournal(runtime.paseoHome).catch(() => undefined);
  }
}

async function commitPeerStateTransaction<T>(
  runtime: PeerWorkspaceRuntime,
  mutator: (draft: PeerRuntimeMaps) => T | Promise<T>,
  countHuman: (agentId: string) => number = () => 0,
): Promise<T> {
  const pendingSnapshot = [...runtime.pendingOutcomes.values()];
  const draft = clonePeerRuntimeMaps(runtime);
  const releasedDispatches = new Set<string>();
  for (const entry of pendingSnapshot) {
    const applied = applySinglePeerOutcomeInDraft(
      draft,
      entry.dispatchId,
      entry.outcome,
      entry.context,
      countHuman,
    );
    if (applied && peerDispatchEndsReservation(entry.outcome))
      releasedDispatches.add(entry.dispatchId);
  }
  const result = await mutator(draft);
  await writePeerStateMapsToDisk(runtime.paseoHome, draft);
  applyPeerRuntimeMaps(runtime, draft);
  await finalizeFlushedPendingOutcomes(runtime, pendingSnapshot, releasedDispatches);
  return result;
}

function peerDispatchEndsReservation(outcome: PeerDispatchTerminalOutcome): boolean {
  return outcome !== "returned_to_queue" && outcome !== "retained_for_restart";
}

async function withPeerStateMutex<T>(
  runtime: PeerWorkspaceRuntime,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = runtime.stateMutex;
  let releaseMutex!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseMutex = resolve;
  });
  runtime.stateMutex = previous.then(() => gate);
  await previous;
  try {
    await ensurePeerRuntimeLoaded(runtime);
    return await operation();
  } finally {
    releaseMutex();
  }
}

const peerRuntimeByManager = new WeakMap<object, PeerWorkspaceRuntime>();

function getPeerWorkspaceRuntime(
  key: object,
  readRecipientTimeline: PeerWorkspaceRuntime["readRecipientTimeline"],
  paseoHome?: string,
): PeerWorkspaceRuntime {
  let runtime = peerRuntimeByManager.get(key);
  if (!runtime) {
    runtime = {
      paseoHome,
      readRecipientTimeline,
      loadPromise: null,
      loadedFromDisk: false,
      stateMutex: Promise.resolve(),
      threads: new Map(),
      byMessageId: new Map(),
      inboundAgentLocks: new Map(),
      lockedChildren: new Map(),
      pendingChildDispatches: new Map(),
      pairWindows: new Map(),
      pendingOutcomes: new Map(),
    };
    peerRuntimeByManager.set(key, runtime);
  } else if (paseoHome && !runtime.paseoHome) {
    runtime.paseoHome = paseoHome;
  }
  return runtime;
}

export function createPaseoToolCatalog(options: PaseoToolHostDependencies): PaseoToolCatalog {
  return createToolCatalog(options, options.callerAgentId ? "agent" : "top-level");
}

export function createPaseoAgentToolManifest(
  options: PaseoToolHostDependencies,
): Pick<PaseoToolCatalog, "tools"> {
  // Plugins register before a caller exists, but every execution uses an agent-bound catalog.
  return { tools: createToolCatalog(options, "agent").tools };
}

function openTaskLedger({ taskLedger, paseoHome }: PaseoToolHostDependencies) {
  return taskLedger ?? (paseoHome ? new WorkspaceTaskLedgerStore(paseoHome) : null);
}

const pendingDurableItemBindings = new WeakMap<
  AgentManager,
  Map<string, PendingDurableItemTaskBinding>
>();

function getPendingDurableItemBindings(agentManager: AgentManager) {
  let bindings = pendingDurableItemBindings.get(agentManager);
  if (!bindings) {
    bindings = new Map();
    pendingDurableItemBindings.set(agentManager, bindings);
  }
  return bindings;
}

function createToolCatalog(
  options: PaseoToolHostDependencies,
  scope: "agent" | "top-level",
): PaseoToolCatalog {
  const {
    agentManager,
    agentStorage,
    terminalManager,
    workspaceScripts,
    scheduleService,
    providerSnapshotManager,
    daemonConfigStore,
    callerAgentId,
    resolveSpeakHandler,
    resolveCallerContext,
    logger,
  } = options;
  const childLogger = logger.child({ module: "agent", component: "paseo-tool-catalog" });
  const callerContext = callerAgentId ? (resolveCallerContext?.(callerAgentId) ?? null) : null;
  const taskLedger = openTaskLedger(options);
  const pendingBindings = getPendingDurableItemBindings(agentManager);
  const peerRuntime = getPeerWorkspaceRuntime(
    agentManager,
    async (agentId) => {
      const record = await agentStorage.get(agentId);
      return record ? agentManager.readStoredTimeline(record, { limit: 0 }) : null;
    },
    options.paseoHome,
  );
  void ensurePeerRuntimeLoaded(peerRuntime);

  const parseToolInput = async (tool: PaseoToolDefinition, input: unknown): Promise<unknown> => {
    const inputSchema = tool.inputSchema;
    if (!inputSchema) {
      return input;
    }
    const schema =
      typeof inputSchema === "object" &&
      inputSchema !== null &&
      typeof (inputSchema as { safeParseAsync?: unknown }).safeParseAsync === "function"
        ? (inputSchema as z.ZodType)
        : z.object(inputSchema as z.ZodRawShape).passthrough();
    const result = await schema.safeParseAsync(input);
    if (!result.success) {
      throw new PaseoToolInputError(result.error.message, result.error.issues);
    }
    return result.data;
  };

  function agentMessages(): AgentMessageDelivery {
    if (!options.agentMessages) throw new Error("Agent message delivery is not configured");
    return options.agentMessages();
  }
  function finishSubscriptions(): FinishSubscriptions {
    if (!options.finishSubscriptions) throw new Error("Finish subscriptions are not configured");
    return options.finishSubscriptions();
  }
  async function prepareRemoteNotification(
    name: string,
    destination: string | undefined,
    input: Record<string, unknown>,
    requireParentOwnership: boolean,
    automaticParent: boolean,
  ): Promise<FinishRegistration | undefined> {
    if (name !== "send_agent_prompt" || destination === options.serverId || !callerAgentId) {
      return undefined;
    }
    if (input.notifyOnFinish === false) return undefined;
    return finishSubscriptions().register(
      {
        childAgentId: input.agentId as string,
        callerAgentId,
        serverId: destination,
        ...(requireParentOwnership ? { requireParentOwnership: true } : {}),
        automaticParent,
      },
      true,
    );
  }
  function defaultRemotePromptNotification(
    name: string,
    destination: string | undefined,
    input: Record<string, unknown>,
    labels: HierarchyAgent["labels"],
  ): void {
    if (name === "send_agent_prompt" && destination !== options.serverId)
      input.notifyOnFinish ??= !isExplicitParentReportingLabels(labels);
  }
  const creationNotificationGuidance =
    "You will get notified when the created agent finishes, errors, or needs permission. Do not poll for status; continue with other work until the notification arrives.";
  function remoteGuidance(
    name: string,
    destination: string | undefined,
    input: Record<string, unknown>,
    response: PaseoToolResult,
  ) {
    if (
      destination === options.serverId ||
      !callerAgentId ||
      input.notifyOnFinish !== true ||
      response.isError
    )
      return {};
    if (name === "send_agent_prompt") return { guidance: PROMPTED_AGENT_NOTIFICATION_GUIDANCE };
    return {};
  }
  const localHostOperations = new Map<string, HostOperation>();
  const tools = new Map<string, PaseoToolDefinition>();
  const builtinNames = new Set<string>();
  const hostTools = new Map([
    ["create_agent", "createAgent"],
    ["create_workspace", "createWorkspace"],
    ["list_workspaces", "listWorkspaces"],
    ["send_agent_prompt", "sendPrompt"],
    ["respond_to_permission", "respondToPermission"],
    ["get_agent_status", "getStatus"],
    ["get_agent_activity", "getActivity"],
    ["list_agents", "listAgents"],
  ] as const satisfies ReadonlyArray<readonly [string, keyof HostOperations]>);
  function createRemoteChildTracker() {
    if (!callerAgentId || !options.finishSubscriptions) return undefined;
    return (childAgentId: string, serverId: string) =>
      finishSubscriptions().trackRemoteChild({ childAgentId, callerAgentId, serverId });
  }
  const hostResolver = createHostResolver({
    serverId: options.serverId ?? "self",
    callerAgentId,
    trackRemoteChild: createRemoteChildTracker(),
    lockedCwd: callerContext?.lockedCwd,
    hosts: () => {
      if (!options.hosts) throw new Error("Connected hosts are not configured");
      return options.hosts();
    },
    local: {
      createAgent: (args, context) => localHostOperations.get("create_agent")!(args, context),
      createWorkspace: (args, context) =>
        localHostOperations.get("create_workspace")!(args, context),
      listWorkspaces: (args, context) => localHostOperations.get("list_workspaces")!(args, context),
      sendPrompt: (args, context) => localHostOperations.get("send_agent_prompt")!(args, context),
      respondToPermission: (args, context) =>
        localHostOperations.get("respond_to_permission")!(args, context),
      getStatus: (args, context) => localHostOperations.get("get_agent_status")!(args, context),
      getActivity: (args, context) => localHostOperations.get("get_agent_activity")!(args, context),
      listAgents: (args, context) => localHostOperations.get("list_agents")!(args, context),
    },
  });
  const orchestrationTools = new Set([
    "send_agent_prompt",
    "update_agent",
    "cancel_agent",
    "archive_agent",
    "kill_agent",
    "set_agent_mode",
    "respond_to_permission",
  ]);
  const readHierarchyAgent = async (id: string): Promise<HierarchyAgent | null> => {
    const stored = await agentStorage.get(id);
    const live = agentManager.getAgent(id);
    const selected = stored?.archivedAt ? stored : (live ?? stored);
    if (!selected) return null;
    return {
      ...selected,
      title: resolveReportTitle(id, stored?.title, live?.config?.title),
    };
  };

  async function readOrchestrationTarget(
    targetId: string,
    destination: string,
    localServer: string,
    context: PaseoToolExecutionContext,
  ): Promise<HierarchyAgent | null> {
    if (destination === localServer) return readHierarchyAgent(targetId);
    const response = await hostResolver.use(destination, (host) =>
      host.getStatus({ agentId: targetId }, context),
    );
    const parsed = z
      .object({
        snapshot: z.object({
          id: z.string(),
          workspaceId: z.string().nullish(),
          labels: z.record(z.string(), z.string()),
          archivedAt: z.string().nullish(),
        }),
      })
      .safeParse(response.structuredContent);
    return parsed.success ? parsed.data.snapshot : null;
  }

  interface OrchestrationCheck {
    requireParentOwnership: boolean;
    targetLabels?: HierarchyAgent["labels"];
    allowLegacyDirectPrompt?: boolean;
  }

  function rejectArchivedMainControlPrompt(
    name: string,
    caller: HierarchyAgent | undefined,
    target: HierarchyAgent | null,
  ): void {
    if (
      name === "send_agent_prompt" &&
      target?.archivedAt &&
      isMainControlAgentLabels(caller?.labels)
    ) {
      throw new PaseoToolInputError(`Agent ${target.id} is archived.`);
    }
  }

  function isLocalHumanTimelineMessage(text: string): boolean {
    if (isSystemInjectedEnvelope(text) || isPeerInspectionBoundaryPromptText(text)) return false;
    const parsed = parseAgentMessages(text);
    return !parsed || parsed.some((entry) => entry.source === null);
  }

  function safeGetAgentTimeline(agentId: string): ReturnType<AgentManager["getTimeline"]> {
    if (typeof agentManager.getTimeline !== "function" || !agentManager.getAgent(agentId)) {
      return [];
    }
    try {
      return agentManager.getTimeline(agentId);
    } catch {
      return [];
    }
  }

  function countLocalHumanMessages(agentId: string): number {
    let count = 0;
    for (const item of safeGetAgentTimeline(agentId)) {
      if (item?.type === "user_message" && isLocalHumanTimelineMessage(item.text)) {
        count += 1;
      }
    }
    return count;
  }

  async function pruneArchivedGrantMap(
    lockMap: Map<string, Map<string, PeerLockGrant>>,
  ): Promise<void> {
    if (lockMap.size <= 256) return;
    for (const agentId of lockMap.keys()) {
      const live = agentManager.getAgent(agentId);
      if (live) continue;
      const stored = await agentStorage.get(agentId);
      if (!stored || stored.archivedAt) {
        lockMap.delete(agentId);
      }
    }
  }

  async function recordPeerLockedChild(
    childAgentId: string,
    correlationId: string,
    grantId = "initial",
    dispatchId?: string,
  ): Promise<void> {
    const humanCount = countLocalHumanMessages(childAgentId);
    await withPeerStateMutex(peerRuntime, () =>
      commitPeerStateTransaction(
        peerRuntime,
        async (draft) => {
          if (dispatchId) {
            const activeChild = draft.pendingChildDispatches.get(dispatchId);
            if (
              !activeChild ||
              activeChild.settled ||
              (!activeChild.activeAttemptId && activeChild.lastAttemptId === grantId) ||
              activeChild.recipientAgentId !== childAgentId
            ) {
              throw new PaseoToolInputError(
                `Peer child prompt ${dispatchId} was withdrawn or settled before dispatch lock commit.`,
              );
            }
            if (activeChild.activeAttemptId !== grantId) {
              revokeGrantsByDispatchId(draft.lockedChildren, dispatchId, "initial");
            }
            draft.pendingChildDispatches.set(dispatchId, {
              ...activeChild,
              activeAttemptId: grantId,
              lastAttemptId: grantId,
            });
          }
          await pruneArchivedGrantMap(draft.lockedChildren);
          grantAgentPeerLockWithUndo(
            draft.lockedChildren,
            childAgentId,
            {
              grantId,
              ...(dispatchId ? { dispatchId } : {}),
              correlationId,
              lockedHumanCount: humanCount,
            },
            humanCount,
            "initial",
          );
        },
        countLocalHumanMessages,
      ),
    );
  }

  async function recordPeerInboundAgentLock(
    recipientAgentId: string,
    attemptId: string,
    dispatchId: string,
    correlationId: string,
  ): Promise<void> {
    const humanCount = countLocalHumanMessages(recipientAgentId);
    await withPeerStateMutex(peerRuntime, () =>
      commitPeerStateTransaction(
        peerRuntime,
        async (draft) => {
          const activeMessage = draft.byMessageId.get(dispatchId);
          if (
            !activeMessage ||
            activeMessage.settled ||
            (!activeMessage.activeAttemptId && activeMessage.lastAttemptId === attemptId) ||
            activeMessage.recipientAgentId !== recipientAgentId
          ) {
            throw new PaseoToolInputError(
              `Peer message ${dispatchId} was withdrawn or settled before dispatch lock commit.`,
            );
          }
          if (activeMessage.activeAttemptId !== attemptId) {
            revokeGrantsByDispatchId(draft.inboundAgentLocks, dispatchId);
          }
          draft.byMessageId.set(dispatchId, {
            ...activeMessage,
            activeAttemptId: attemptId,
            lastAttemptId: attemptId,
          });
          await pruneArchivedGrantMap(draft.inboundAgentLocks);
          grantAgentPeerLockWithUndo(
            draft.inboundAgentLocks,
            recipientAgentId,
            {
              grantId: attemptId,
              dispatchId,
              correlationId,
              lockedHumanCount: humanCount,
            },
            humanCount,
          );
        },
        countLocalHumanMessages,
      ),
    );
  }

  async function flushPendingPeerOutcomesUnlocked(): Promise<void> {
    if (peerRuntime.pendingOutcomes.size === 0) return;
    await commitPeerStateTransaction(peerRuntime, () => undefined, countLocalHumanMessages);
  }

  function queuePendingOutcomeRecord(
    dispatchId: string,
    outcome: PeerDispatchTerminalOutcome,
    context: PeerDispatchEndpointContext,
  ): void {
    const outcomeKey = context.attemptId
      ? `${dispatchId}::${outcome}::${context.attemptId}`
      : `${dispatchId}::${outcome}`;
    if (peerRuntime.pendingOutcomes.has(outcomeKey)) {
      peerRuntime.pendingOutcomes.delete(outcomeKey);
    }
    peerRuntime.pendingOutcomes.set(outcomeKey, {
      outcomeKey,
      dispatchId,
      outcome,
      context,
    });
  }

  async function flushPendingOutcomesOnShutdown(): Promise<void> {
    if (peerRuntime.pendingOutcomes.size === 0) return;
    await withPeerStateMutex(peerRuntime, async () => {
      if (peerRuntime.pendingOutcomes.size === 0) return;
      try {
        await flushPendingPeerOutcomesUnlocked();
      } catch (stateErr) {
        try {
          await writePendingOutcomesJournal(peerRuntime.paseoHome, peerRuntime.pendingOutcomes);
        } catch (journalErr) {
          childLogger.error(
            { err: journalErr, stateErr, pendingCount: peerRuntime.pendingOutcomes.size },
            "Failed to persist peer outcomes to both state file and fallback journal during shutdown; outcomes remain in memory only",
          );
          throw new Error("Failed to persist pending peer dispatch outcomes during shutdown", {
            cause: journalErr,
          });
        }
        for (const entry of peerRuntime.pendingOutcomes.values()) {
          if (peerDispatchEndsReservation(entry.outcome)) {
            releasePromptDispatchVerifier(entry.dispatchId);
          }
        }
        childLogger.warn(
          { err: stateErr, pendingCount: peerRuntime.pendingOutcomes.size },
          "Failed to flush peer state file during shutdown; persisted pending outcomes journal",
        );
      }
    });
  }

  function handlePeerDispatchOutcome(
    dispatchId: string,
    outcome: PeerDispatchTerminalOutcome,
    context: PeerDispatchEndpointContext,
  ): Promise<boolean | void> {
    return withPeerStateMutex(peerRuntime, async () => {
      if (context.rejectDurableHold) {
        if (outcome !== "definitively_unsent") return false;
        const rejection = resolveDurableHoldRejection(dispatchId, context);
        if (typeof rejection === "boolean") return rejection;
        context = rejection;
      }
      if (outcome === "accepted") {
        const record = peerOutcomeRecord(peerRuntime, dispatchId, context);
        if (
          !record ||
          !matchesRecordedOutcomeContext(peerRuntime, dispatchId, context) ||
          !matchesPeerAcceptanceAttempt(record, context.attemptId)
        ) {
          throw new Error("Peer acceptance does not match the recorded delivery attempt.");
        }
        if (record.deliveryOutcome === "accepted") return;
      }
      queuePendingOutcomeRecord(dispatchId, outcome, context);
      try {
        await flushPendingPeerOutcomesUnlocked();
      } catch (stateErr) {
        try {
          await writePendingOutcomesJournal(peerRuntime.paseoHome, peerRuntime.pendingOutcomes);
          childLogger.warn(
            { err: stateErr, dispatchId, outcome },
            "Failed to update peer state file; persisted outcome in fallback journal for retry",
          );
        } catch (journalErr) {
          childLogger.error(
            { err: journalErr, stateErr, dispatchId, outcome },
            "Failed to persist peer dispatch outcome to both state file and fallback journal; retained in memory only",
          );
        }
        throw stateErr;
      }
      if (
        outcome === "accepted" &&
        peerOutcomeRecord(peerRuntime, dispatchId, context)?.deliveryOutcome !== "accepted"
      ) {
        throw new Error("Peer acceptance could not be applied to the recorded delivery attempt.");
      }
      if (outcome === "definitively_unsent")
        return !peerOutcomeRecord(peerRuntime, dispatchId, context);
    });
  }

  function resolveDurableHoldRejection(
    dispatchId: string,
    context: PeerDispatchEndpointContext,
  ): PeerDispatchEndpointContext | boolean {
    if (context.kind !== "peer-workspace" || !context.ownsReservation) return false;
    const record = peerRuntime.byMessageId.get(dispatchId);
    if (!record) return true; // Cleanup can have committed before the receipt was written.
    if (
      record.settled ||
      !matchesRecordedOutcomeContext(peerRuntime, dispatchId, context) ||
      hasPendingAcceptedOutcome(dispatchId, context.kind, context.recipientId)
    )
      return false;
    // Use the recorded pre-handoff attempt in the journal without broadening anonymous outcomes.
    return {
      ...context,
      rejectDurableHold: undefined,
      attemptId: record.activeAttemptId ?? record.lastAttemptId,
    };
  }

  function hasEnforcedAdapterReadOnlyOptions(
    adapter: string | null | undefined,
    providerOptions: Record<string, unknown> | null | undefined,
    effectiveMode: string | null | undefined,
  ): boolean {
    if (isPeerExplicitModeDisallowed(effectiveMode)) return false;
    switch (adapter) {
      case "codex":
        return providerOptions?.sandbox_mode === "read-only";
      case "claude":
        return Array.isArray(providerOptions?.disallowedTools);
      case "opencode": {
        const perm = providerOptions?.permission as Record<string, unknown> | undefined;
        return perm?.edit === "deny" && perm?.write === "deny" && perm?.bash === "deny";
      }
      case "pi":
        return providerOptions?.mainControlReadOnly === true;
      default:
        return effectiveMode === "read-only" || effectiveMode === "plan";
    }
  }

  function resolveSubagentAdapter(providerId: string | undefined): string | undefined {
    if (!providerId) return undefined;
    return typeof agentManager.adapterOf === "function"
      ? agentManager.adapterOf(providerId)
      : providerId;
  }

  async function readSubagentEffectiveState(targetAgentId: string) {
    const live = agentManager.getAgent(targetAgentId);
    const stored = await agentStorage.get(targetAgentId);
    const providerId = live ? live.provider : stored?.provider;
    const liveConfig = live?.config;
    const storedConfig = stored?.config;
    return {
      labels: live ? live.labels : stored?.labels,
      providerId,
      adapter: resolveSubagentAdapter(providerId),
      effectiveMode:
        live?.currentModeId ?? stored?.lastModeId ?? liveConfig?.modeId ?? storedConfig?.modeId,
      providerOptions: (liveConfig?.providerOptions ?? storedConfig?.providerOptions) as
        | Record<string, unknown>
        | undefined,
    };
  }

  async function assertEnforcedPeerReadOnlySubagent(targetAgentId: string): Promise<void> {
    if (!peerRuntime.lockedChildren.has(targetAgentId)) {
      throw new PaseoToolInputError(
        'Cross-workspace peer messages are read-only (A0 READ) and cannot prompt pre-existing subagents; spawn a dedicated playbook "readonly_cr" inspector instead.',
      );
    }
    const state = await readSubagentEffectiveState(targetAgentId);
    if (!state.providerId || getLeadPlaybookFromLabels(state.labels) !== "readonly_cr") {
      throw new PaseoToolInputError(
        'Cross-workspace peer messages are read-only (A0 READ) and require target subagents to keep playbook "readonly_cr".',
      );
    }
    if (
      !hasEnforcedAdapterReadOnlyOptions(state.adapter, state.providerOptions, state.effectiveMode)
    ) {
      throw new PaseoToolInputError(
        "Cross-workspace peer messages are read-only (A0 READ) and require the target subagent to remain in enforced read-only configuration.",
      );
    }
  }

  function hasPendingAcceptedOutcome(
    dispatchId: string,
    kind: PeerDispatchEndpointContext["kind"],
    agentId: string,
  ): boolean {
    const record =
      kind === "peer-child"
        ? peerRuntime.pendingChildDispatches.get(dispatchId)
        : peerRuntime.byMessageId.get(dispatchId);
    for (const entry of peerRuntime.pendingOutcomes.values()) {
      if (
        entry.dispatchId === dispatchId &&
        entry.context.kind === kind &&
        entry.context.recipientId === agentId &&
        record?.activeAttemptId !== undefined &&
        record.activeAttemptId === entry.context.attemptId &&
        (entry.outcome === "accepted" || entry.outcome === "outcome_unknown")
      ) {
        return true;
      }
    }
    return false;
  }

  function isPeerWorkspaceDispatchUnsentInPending(dispatchId: string, agentId: string): boolean {
    const recorded = peerRuntime.byMessageId.get(dispatchId);
    if (recorded?.settled || hasPendingAcceptedOutcome(dispatchId, "peer-workspace", agentId)) {
      return false;
    }
    for (const pending of peerRuntime.pendingOutcomes.values()) {
      if (
        pending.dispatchId !== dispatchId ||
        pending.outcome !== "definitively_unsent" ||
        pending.context.kind !== "peer-workspace" ||
        pending.context.recipientId !== agentId
      ) {
        continue;
      }
      if (!recorded || !matchesPeerAttempt(recorded, pending.context)) continue;
      return true;
    }
    return false;
  }

  function extractProjectedPeerLockId(agentId: string, callId: string): string | undefined {
    const parsedCall = parseProjectedPeerCallId(callId);
    if (!parsedCall) return undefined;
    if (isPeerWorkspaceDispatchUnsentInPending(parsedCall.messageId, agentId)) return undefined;
    const recorded = peerRuntime.byMessageId.get(parsedCall.messageId);
    if (!recorded || recorded.recipientAgentId !== agentId) return undefined;
    if (
      recorded.intent !== parsedCall.intent ||
      recorded.correlationId !== parsedCall.correlationId
    ) {
      return undefined;
    }
    return recorded.correlationId;
  }

  function verifyRecordedUserPeerEntry(
    agentId: string,
    dispatchKey: string,
    source: Extract<AgentPromptSource, { kind: "peer-workspace-message" }>,
  ): string | undefined {
    if (isPeerWorkspaceDispatchUnsentInPending(dispatchKey, agentId)) return undefined;
    const recorded = peerRuntime.byMessageId.get(dispatchKey);
    if (!recorded || recorded.recipientAgentId !== agentId) return undefined;
    const sameSender =
      recorded.agentId === source.agentId &&
      (recorded.serverId ?? undefined) === (source.serverId ?? undefined);
    const sameThread =
      recorded.correlationId === source.correlationId && recorded.intent === source.intent;
    if (!sameSender || !sameThread) return undefined;
    return recorded.correlationId;
  }

  function collectUnprojectedUserPeerIds(
    agentId: string,
    text: string,
    correlationIds: Set<string>,
  ): "stop" | "continue" {
    if (isSystemInjectedEnvelope(text) || isPeerInspectionBoundaryPromptText(text)) {
      return "continue";
    }
    const parsed = parseAgentMessages(text);
    if (!parsed) return "stop";
    for (const entry of parsed) {
      if (entry.source?.kind === "peer-workspace-message") {
        const verified = verifyRecordedUserPeerEntry(
          agentId,
          entry.source.dispatchId ?? entry.id,
          entry.source,
        );
        if (verified) correlationIds.add(verified);
      }
    }
    return parsed.some((entry) => entry.source === null) ? "stop" : "continue";
  }

  function isRevokingOutcome(outcome: PeerDispatchTerminalOutcome): boolean {
    return (
      outcome === "returned_to_queue" ||
      outcome === "definitively_unsent" ||
      outcome === "retained_for_restart"
    );
  }

  function isDispatchSettledForKind(
    dispatchId: string,
    kind: PeerDispatchEndpointContext["kind"],
    agentId: string,
  ): boolean {
    const rec =
      kind === "peer-child"
        ? peerRuntime.pendingChildDispatches.get(dispatchId)
        : peerRuntime.byMessageId.get(dispatchId);
    return Boolean(rec?.settled) || hasPendingAcceptedOutcome(dispatchId, kind, agentId);
  }

  function isGrantRevokedByPendingOutcome(
    grant: PeerLockGrant,
    agentId: string,
    kind: PeerDispatchEndpointContext["kind"],
  ): boolean {
    const dispatchKey = grant.dispatchId ?? (grant.grantId !== "initial" ? grant.grantId : "");
    if (dispatchKey && isDispatchSettledForKind(dispatchKey, kind, agentId)) {
      return false;
    }
    for (const entry of peerRuntime.pendingOutcomes.values()) {
      if (entry.context.kind !== kind || entry.context.recipientId !== agentId) continue;
      if (!isRevokingOutcome(entry.outcome)) continue;
      if (entry.context.attemptId === grant.grantId) return true;
    }
    return false;
  }

  function collectActiveGrantCorrelationIds(
    grants: ReadonlyMap<string, PeerLockGrant> | undefined,
    agentId: string,
    kind: PeerDispatchEndpointContext["kind"],
    humanCount: number,
    correlationIds: Set<string>,
  ): void {
    if (!grants) return;
    for (const grant of grants.values()) {
      if (
        humanCount <= grant.lockedHumanCount &&
        !isGrantRevokedByPendingOutcome(grant, agentId, kind)
      ) {
        correlationIds.add(grant.correlationId);
      }
    }
  }

  function getActivePeerTurnCorrelationIdsForAgent(agentId: string): ReadonlySet<string> {
    const correlationIds = new Set<string>();
    const humanCount = countLocalHumanMessages(agentId);
    collectActiveGrantCorrelationIds(
      peerRuntime.lockedChildren.get(agentId),
      agentId,
      "peer-child",
      humanCount,
      correlationIds,
    );
    collectActiveGrantCorrelationIds(
      peerRuntime.inboundAgentLocks.get(agentId),
      agentId,
      "peer-workspace",
      humanCount,
      correlationIds,
    );
    const timeline = safeGetAgentTimeline(agentId);
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (!item) continue;
      if (item.type === "tool_call") {
        const correlationId = extractProjectedPeerLockId(agentId, item.callId);
        if (correlationId) correlationIds.add(correlationId);
        continue;
      }
      if (item.type === "user_message") {
        if (collectUnprojectedUserPeerIds(agentId, item.text, correlationIds) === "stop") break;
      }
    }
    return correlationIds;
  }

  function getActivePeerTurnContext(
    agentId: string,
    path?: ReadonlyMap<string, HierarchyAgent>,
  ): { correlationIds: ReadonlySet<string> } | null {
    const candidateIds = path ? [...path.keys()] : [agentId];
    const correlationIds = new Set<string>();
    for (const id of candidateIds) {
      for (const correlationId of getActivePeerTurnCorrelationIdsForAgent(id)) {
        correlationIds.add(correlationId);
      }
    }
    return correlationIds.size > 0 ? { correlationIds } : null;
  }

  function assertPeerTurnCreateModeAndFeatures(args: Record<string, unknown> | undefined): void {
    const settings =
      args?.settings && typeof args.settings === "object"
        ? (args.settings as Record<string, unknown>)
        : undefined;
    const invalid =
      isPeerExplicitModeDisallowed(settings?.modeId) ||
      isPeerExplicitModeDisallowed(args?.mode) ||
      hasPeerDisallowedProviderOptions(settings?.features) ||
      hasPeerDisallowedProviderOptions(args?.features);
    if (invalid) {
      throw new PaseoToolInputError(
        "Cross-workspace peer messages are read-only (A0 READ) and cannot launch subagents in write-capable modes.",
      );
    }
  }

  function assertPeerTurnCreateAgent(args: Record<string, unknown> | undefined): void {
    if (args?.taskBinding !== undefined) {
      throw new PaseoToolInputError(
        "Cross-workspace peer messages are read-only (A0 READ) and cannot mutate the workspace task ledger via taskBinding.",
      );
    }
    const playbook = args?.playbook;
    if (playbook !== "readonly_cr") {
      throw new PaseoToolInputError(
        'Cross-workspace peer messages are read-only (A0 READ) and may only spawn inspection subagents with playbook "readonly_cr".',
      );
    }
    if (args?.resident || args?.residentRole) {
      throw new PaseoToolInputError(
        "Cross-workspace peer messages are read-only (A0 READ) and cannot register resident specialists.",
      );
    }
    if (args?.commitPolicy === "scoped_only") {
      throw new PaseoToolInputError(
        'Cross-workspace peer messages are read-only (A0 READ) and cannot authorize commitPolicy "scoped_only".',
      );
    }
    assertPeerTurnCreateModeAndFeatures(args);
  }

  function assertPeerTurnSendPrompt(args: Record<string, unknown> | undefined): void {
    if (args?.taskBinding !== undefined || isPeerExplicitModeDisallowed(args?.sessionMode)) {
      throw new PaseoToolInputError(
        "Cross-workspace peer messages are read-only (A0 READ) and cannot elevate subagent mode or mutate the task ledger.",
      );
    }
  }

  function assertPeerTurnReply(
    args: Record<string, unknown> | undefined,
    depth: number,
    correlationIds: ReadonlySet<string>,
  ): void {
    const correlationId = typeof args?.correlationId === "string" ? args.correlationId.trim() : "";
    if (depth === 0 && args?.intent === "reply" && correlationIds.has(correlationId)) return;
    throw new PaseoToolInputError(
      'Cross-workspace peer turns are read-only (A0 READ) and may only reply to the active inbound correlationId (cannot chain new "query" or "align" requests).',
    );
  }

  async function assertPeerTurnToolAllowed(
    name: string,
    args: { agentId?: string } & Record<string, unknown>,
    caller: HierarchyAgent | undefined,
    depth: number,
    path: ReadonlyMap<string, HierarchyAgent>,
  ): Promise<void> {
    if (!callerAgentId || PEER_READ_ONLY_TOOLS.has(name)) return;
    const peerTurn = getActivePeerTurnContext(callerAgentId, path);
    if (!peerTurn) return;
    if (name === "send_peer_message") {
      assertPeerTurnReply(args, depth, peerTurn.correlationIds);
      return;
    }
    if (depth === 0 && isMainControlAgentLabels(caller?.labels)) {
      if (name === "create_agent") {
        assertPeerTurnCreateAgent(args);
        return;
      }
      if (name === "send_agent_prompt") {
        assertPeerTurnSendPrompt(args);
        if (args.agentId) await assertEnforcedPeerReadOnlySubagent(args.agentId);
        return;
      }
    }
    throw new PaseoToolInputError(
      `Cross-workspace peer messages carry read-only (A0 READ) authority and cannot invoke "${name}" without local human approval.`,
    );
  }

  function assertDisallowedClientLabels(
    name: string,
    labels: Record<string, string> | undefined,
  ): void {
    if (
      (name === "create_agent" || name === "update_agent") &&
      Object.keys(labels ?? {}).some(isOpenAgentTabLabel)
    ) {
      throw new PaseoToolInputError("Only clients can set open-tab labels.");
    }
  }

  function assertLevel2SelfScope(name: string, depth: number, targetsSelf: boolean): boolean {
    if (name !== "set_agent_mode" && name !== "respond_to_permission") return false;
    if (targetsSelf) return true;
    if (depth >= 2) {
      throw new PaseoToolInputError(
        name === "set_agent_mode"
          ? "Level-2 subagents can only change their own mode."
          : "Level-2 subagents cannot respond to permission requests for other agents.",
      );
    }
    return false;
  }

  async function checkHierarchy(
    name: string,
    args: { agentId?: string; serverId?: string; labels?: Record<string, string> } & Record<
      string,
      unknown
    >,
    context: PaseoToolExecutionContext,
  ): Promise<OrchestrationCheck> {
    const unrestricted = { requireParentOwnership: false };
    if (!callerAgentId) return unrestricted;
    assertDisallowedClientLabels(name, args.labels);
    const path = await readAgentHierarchyPath(callerAgentId, readHierarchyAgent);
    await peerRuntime.stateMutex;
    await ensurePeerRuntimeLoaded(peerRuntime);
    if (peerRuntime.pendingOutcomes.size > 0) {
      await withPeerStateMutex(peerRuntime, () => flushPendingPeerOutcomesUnlocked());
    }
    const caller = path.get(callerAgentId);
    const read = (id: string) => path.get(id);
    const depth = computeAgentDepth(callerAgentId, read);
    if (name === "create_agent" && caller) validateCanSpawnChild(caller, read);
    if (
      !isPaseoToolEnabled(applyHierarchyPaseoToolPolicy(undefined, caller?.labels, depth), name)
    ) {
      throw new PaseoToolInputError(`Paseo tool is disabled for your hierarchy role: ${name}`);
    }
    await assertPeerTurnToolAllowed(name, args, caller, depth, path);
    const localServer = options.serverId ?? "self";
    const destination = args.serverId ?? localServer;
    const targetsSelf = args.agentId === callerAgentId && destination === localServer;
    if (assertLevel2SelfScope(name, depth, targetsSelf)) return unrestricted;
    if (!args.agentId || !orchestrationTools.has(name)) return unrestricted;
    return checkOrchestration(
      name,
      args.agentId,
      destination,
      localServer,
      callerAgentId,
      path,
      context,
    );
  }

  function assertSameOrchestrationWorkspace(
    caller: HierarchyAgent | undefined,
    target: HierarchyAgent | null,
  ): void {
    if (!target) return;
    const callerWs = caller?.workspaceId ?? null;
    const targetWs = target.workspaceId ?? null;
    if (callerWs !== targetWs && Boolean(callerWs || targetWs)) {
      throw new PaseoToolInputError(
        "You can only manage your direct subagents. Coordinate through your direct child, or use send_peer_message for cross-workspace read-only queries.",
      );
    }
  }

  async function checkOrchestration(
    name: string,
    targetId: string,
    destination: string,
    localServer: string,
    callerId: string,
    path: ReadonlyMap<string, HierarchyAgent>,
    context: PaseoToolExecutionContext,
  ): Promise<OrchestrationCheck> {
    const read = (id: string) => path.get(id);
    const singleHop = requiresSingleHopOrchestration(callerId, read);
    if (!singleHop && name !== "send_agent_prompt" && name !== "respond_to_permission")
      return { requireParentOwnership: false };

    const targetSnapshot = await readOrchestrationTarget(
      targetId,
      destination,
      localServer,
      context,
    );
    const caller = read(callerId);
    rejectArchivedMainControlPrompt(name, caller, targetSnapshot);
    assertSameOrchestrationWorkspace(caller, targetSnapshot);
    const parent = getParentAddressFromLabels(targetSnapshot?.labels, destination);
    const target = parent?.serverId === localServer ? targetSnapshot : null;
    if (!singleHop) {
      const directChild = parent?.serverId === localServer && parent.agentId === callerId;
      if (name === "respond_to_permission" && !directChild) {
        throw new PaseoToolInputError("You can only manage your direct subagents.");
      }
      // A prompt admitted as a parent's delegation must still belong to that parent at dispatch.
      return {
        requireParentOwnership: directChild,
        targetLabels: targetSnapshot?.labels,
        allowLegacyDirectPrompt:
          name === "send_agent_prompt" &&
          directChild &&
          !isExplicitParentReportingLabels(targetSnapshot?.labels),
      };
    }
    validateSingleHopOrchestration({
      callerAgentId: callerId,
      targetAgentId: targetId,
      readAgent: (id) => (id === targetId && id !== callerId ? target : path.get(id)),
    });
    return { requireParentOwnership: true, targetLabels: targetSnapshot?.labels };
  }

  async function assertHostCreationAllowed(
    name: string,
    destination: string,
    input: LegacyPlacement & {
      labels?: Record<string, string>;
      profileId?: string;
      resident?: boolean;
      residentRole?: string;
    },
  ): Promise<void> {
    if (scope === "agent" && name === "create_workspace") {
      throw new PaseoToolInputError(AGENT_WORKSPACE_CREATION_ERROR);
    }
    if (name !== "create_agent") return;
    if (scope === "agent") {
      if (destination !== (options.serverId ?? "self")) {
        throw new PaseoToolInputError(AGENT_WORKSPACE_CREATION_ERROR);
      }
      await assertAgentCreatePlacement(input);
      return;
    }
    if (
      destination !== (options.serverId ?? "self") &&
      (input.profileId !== undefined ||
        input.resident !== undefined ||
        input.residentRole !== undefined)
    ) {
      throw new PaseoToolInputError(
        "Profile and resident options require create_agent on the destination host.",
      );
    }
    const parent = getParentAddressFromLabels(input.labels, destination);
    if (parent && parent.serverId !== destination) {
      throw new PaseoToolInputError(AGENT_WORKSPACE_CREATION_ERROR);
    }
  }

  function describeForScope(agent: string, topLevel: string): string {
    return scope === "agent" ? agent : topLevel;
  }

  function hostOperationFailure(error: unknown, serverId?: string): PaseoToolResult {
    if (!options.serverId) throw error;
    const failure = {
      serverId,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && "code" in error ? { code: error.code } : {}),
      ...(error instanceof Error && "outcome" in error ? { outcome: error.outcome } : {}),
    };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(failure) }],
      structuredContent: failure,
    };
  }

  const butlerDecisionTurn = Symbol("butlerDecisionTurn");
  type ToolContext = PaseoToolExecutionContext & {
    [butlerDecisionTurn]?: ReturnType<typeof readButlerDecisionTurn>;
  };

  function captureDecisionTurn(name: string, context: ToolContext): ToolContext {
    if (name !== "dispatch_topic_decision" || context[butlerDecisionTurn]) return context;
    return { ...context, [butlerDecisionTurn]: readButlerDecisionTurn(callerAgentId) };
  }

  const registerTool = (
    name: string,
    config: PaseoToolConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool handlers are schema-validated at registration boundaries.
    handler: (input: any, context: ToolContext) => Promise<PaseoToolResult>,
  ) => {
    builtinNames.add(name);
    if (!isPaseoToolEnabled(options.paseoToolPolicy, name)) {
      return;
    }
    const operation = hostTools.get(name as Parameters<typeof hostTools.get>[0]);
    if (operation) {
      localHostOperations.set(name, handler);
      const original = config.inputSchema;
      const selector = {
        serverId: z
          .string()
          .min(1)
          .optional()
          .describe("Destination server ID from list_hosts; omit for this host."),
      };
      if (scope === "top-level" || (name !== "create_agent" && name !== "create_workspace")) {
        config = {
          ...config,
          inputSchema:
            original instanceof z.ZodObject
              ? original.extend(selector)
              : { ...(original as z.ZodRawShape), ...selector },
        };
      }
      handler = async ({ serverId, ...input }, context) => {
        const automaticParent = input.notifyOnFinish === undefined;
        const destination = serverId ?? options.serverId;
        if (
          input.taskBinding !== undefined &&
          (destination ?? "self") !== (options.serverId ?? "self")
        ) {
          throw new PaseoToolInputError("Task binding is only available on the caller's host.");
        }
        await assertHostCreationAllowed(name, destination ?? "self", input);
        const { requireParentOwnership, targetLabels, allowLegacyDirectPrompt } =
          await checkHierarchy(name, { ...input, serverId }, context);
        const restrictedSend = name === "send_agent_prompt" && requireParentOwnership;
        let remoteNotification: FinishRegistration | undefined;
        defaultRemotePromptNotification(name, destination, input, targetLabels);
        const prepareLegacyNotification = async () => {
          try {
            remoteNotification = await prepareRemoteNotification(
              name,
              destination,
              input,
              restrictedSend,
              automaticParent,
            );
          } catch (error) {
            throw new HostOperationRejectedError(error);
          }
        };
        try {
          const response = await hostResolver.use(
            serverId,
            (host) =>
              host[operation](
                name === "send_agent_prompt"
                  ? {
                      ...input,
                      requireParentOwnership: restrictedSend,
                      prepareLegacyNotification,
                    }
                  : input,
                context,
              ),
            restrictedSend || name === "respond_to_permission" ? callerAgentId : undefined,
            allowLegacyDirectPrompt,
          );
          if (response.isError) await remoteNotification?.reject();
          else remoteNotification?.accept();
          return {
            ...response,
            structuredContent: {
              ...(response.structuredContent as object),
              ...remoteGuidance(name, destination, input, response),
              ...(destination ? { serverId: destination } : {}),
            },
          };
        } catch (error) {
          // A lost response does not establish whether the remote daemon admitted the prompt.
          // Reconcile the child rather than silently dropping notification intent.
          if (error instanceof PaseoToolInputError || error instanceof HostOperationRejectedError)
            await remoteNotification?.reject();
          else remoteNotification?.accept();
          return hostOperationFailure(error, destination);
        }
      };
    } else {
      const run = handler;
      handler = async (input, context) => {
        const invocation = captureDecisionTurn(name, context);
        await checkHierarchy(name, input, context);
        return run(input, invocation);
      };
    }
    tools.set(name, {
      name,
      title: config.title,
      description: config.description ?? name,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      handler: handler as PaseoToolDefinition["handler"],
    });
  };
  const toCatalog = (): PaseoToolCatalog => ({
    tools,
    getTool(name: string): PaseoToolDefinition | undefined {
      return tools.get(name);
    },
    async executeTool(
      name: string,
      input: unknown,
      context: PaseoToolExecutionContext = {},
    ): Promise<PaseoToolResult> {
      const tool = tools.get(name);
      if (!tool) {
        throw new PaseoToolInputError(`Paseo tool not found: ${name}`);
      }
      const invocation = captureDecisionTurn(name, context);
      return tool.handler(await parseToolInput(tool, input), invocation);
    },
  });

  const buildCronScheduleCadence = (input: {
    cron: string | undefined;
    timezone?: string;
  }): ScheduleCadence => {
    const expression = input.cron?.trim() ?? "";
    if (!expression) {
      throw new PaseoToolInputError("cron is required");
    }
    const timezone = normalizeScheduleTimeZoneArg(input.timezone);
    return {
      type: "cron",
      expression,
      ...(timezone !== undefined ? { timezone } : {}),
    };
  };

  const buildScheduleExpiry = (expiresIn: string | undefined): string | undefined => {
    return expiresIn === undefined
      ? undefined
      : new Date(Date.now() + parseDurationString(expiresIn)).toISOString();
  };

  const resolveCallerAgent = () => {
    if (!callerAgentId) {
      return null;
    }
    const parentAgent = agentManager.getAgent(callerAgentId);
    if (!parentAgent) {
      throw new PaseoToolInputError(`Parent agent ${callerAgentId} not found`);
    }
    return parentAgent;
  };

  const workspaceBackgroundIntent = (background: boolean | undefined) => {
    const caller = resolveCallerAgent();
    return {
      background: inheritWorkspaceBackground(background, caller),
      callerWorkspaceId: caller?.workspaceId,
    };
  };

  const resolveInheritedProviderConfig = (
    selectedProvider: string,
  ): Pick<AgentSessionConfig, "providerOptions"> | undefined => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent?.provider !== selectedProvider || !callerAgent.config?.providerOptions) {
      return undefined;
    }
    return {
      providerOptions: callerAgent.config.providerOptions,
    };
  };

  const resolveScopedCwd = (requestedCwd?: string, opts?: { required?: boolean }): string => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent) {
      return resolveChildAgentCwd({
        parentCwd: callerAgent.cwd,
        requestedCwd,
        lockedCwd: callerContext?.lockedCwd,
        allowCustomCwd: callerContext?.allowCustomCwd ?? true,
      });
    }

    const trimmedCwd = requestedCwd?.trim();
    if (!trimmedCwd) {
      if (opts?.required) {
        throw new PaseoToolInputError("cwd is required");
      }
      throw new PaseoToolInputError("cwd is required outside an agent-scoped session");
    }

    return expandUserPath(trimmedCwd);
  };

  async function createTopLevelTerminalWorkspace(resolvedCwd: string): Promise<string> {
    if (!options.ensureWorkspaceForCreate) {
      throw new PaseoToolInputError("workspaceId is required outside an agent-scoped session");
    }

    return options.ensureWorkspaceForCreate(resolvedCwd);
  }

  async function requireCallerWorkspace(requestedWorkspaceId?: string): Promise<string> {
    const caller = callerAgentId ? agentManager.getAgent(callerAgentId) : null;
    if (!caller?.workspaceId || (await agentStorage.get(caller.id))?.archivedAt) {
      throw new PaseoToolInputError(AGENT_WORKSPACE_CREATION_ERROR);
    }
    if (
      (requestedWorkspaceId !== undefined && requestedWorkspaceId !== caller.workspaceId) ||
      !(await findActiveWorkspace(caller.workspaceId))
    ) {
      throw new PaseoToolInputError(AGENT_WORKSPACE_CREATION_ERROR);
    }
    return caller.workspaceId;
  }

  async function findActiveWorkspace(workspaceId: string): Promise<{ cwd: string } | null> {
    if (options.workspaceRegistry) {
      const record = await options.workspaceRegistry.get(workspaceId);
      if (record) return record.archivedAt ? null : record;
    }
    return (
      (await options.listActiveWorkspaces?.())?.find(
        (record) => record.workspaceId === workspaceId,
      ) ?? null
    );
  }

  async function requireTaskLedgerWorkspace(requestedWorkspaceId?: string) {
    if (!callerAgentId || !isMainControlAgentLabels(agentManager.getAgent(callerAgentId)?.labels)) {
      throw new PaseoToolInputError(
        "Only Main Control agents can access the workspace task ledger.",
      );
    }
    if (options.verifiedCallerAgentId !== callerAgentId) {
      throw new PaseoToolInputError(
        "The workspace task ledger requires a verified agent identity.",
      );
    }
    const workspaceId = await requireCallerWorkspace(requestedWorkspaceId);
    const current = agentManager.getAgent(callerAgentId);
    if (
      current?.workspaceId !== workspaceId ||
      !isMainControlAgentLabels(current.labels) ||
      agentManager.isTaskAgentArchivePending(callerAgentId)
    )
      throw new PaseoToolInputError(AGENT_WORKSPACE_CREATION_ERROR);
    return workspaceId;
  }

  function assertButlerCaller(mainAgentId: string, workspaceId: string) {
    const current = agentManager.getAgent(mainAgentId);
    if (
      current?.workspaceId !== workspaceId ||
      current.internal ||
      current.lifecycle === "closed" ||
      getParentAgentIdFromLabels(current.labels) ||
      !isMainControlAgentLabels(current.labels) ||
      agentManager.isTaskAgentArchivePending(mainAgentId)
    ) {
      throw new PaseoToolInputError("Workspace Main Control is no longer available.");
    }
    return current;
  }

  async function requireButlerCaller(requestedWorkspaceId?: string) {
    if (scope !== "agent" || !callerAgentId || options.verifiedCallerAgentId !== callerAgentId) {
      throw new PaseoToolInputError("This tool requires a verified Main Control agent identity.");
    }
    const workspaceId = await requireTaskLedgerWorkspace(requestedWorkspaceId);
    assertButlerCaller(callerAgentId, workspaceId);
    return { mainAgentId: callerAgentId, workspaceId };
  }

  function readButlerDecisionTurn(agentId: string | undefined) {
    const current = agentId ? agentManager.getAgent(agentId) : null;
    return {
      turnId: current?.activeForegroundTurnId ?? current?.activeTurnId,
      human: !!agentId && agentManager.isActiveTurnHumanInitiated(agentId) === true,
      peer: !!agentId && Boolean(getActivePeerTurnContext(agentId)),
    };
  }

  async function withTaskLedger<T>(
    requestedWorkspaceId: string | undefined,
    operation: (ledger: WorkspaceTaskLedgerStore, workspaceId: string) => Promise<T>,
  ): Promise<T> {
    if (!callerAgentId) {
      throw new PaseoToolInputError(
        "Only Main Control agents can access the workspace task ledger.",
      );
    }
    if (!taskLedger) throw new PaseoToolInputError("The workspace task ledger is not configured.");
    return agentManager.withTaskLedgerCaller(callerAgentId, async () =>
      operation(taskLedger, await requireTaskLedgerWorkspace(requestedWorkspaceId)),
    );
  }

  async function prepareTaskBinding(input: z.infer<typeof WorkspaceTaskToolInputSchema>) {
    if (callerAgentId && getActivePeerTurnContext(callerAgentId)) {
      throw new PaseoToolInputError(
        "Cross-workspace peer messages are read-only (A0 READ) and cannot mutate the workspace task ledger.",
      );
    }
    // Local host operations can call this handler without going through the outer tool parser.
    input = WorkspaceTaskToolInputSchema.parse(input);
    const { workspaceId, existingRoot } = await withTaskLedger(undefined, async (ledger, id) => {
      const current = (await ledger.list(id)).find((task) => task.taskId === input.taskId);
      if (!current && input.title === undefined) {
        throw new PaseoToolInputError("A title is required to create a workspace task.");
      }
      if (
        (input.status ?? current?.status) === "completed" &&
        (input.closure?.verification?.state ?? current?.closure?.verification?.state) === "failed"
      ) {
        throw new PaseoToolInputError(
          "A workspace task with failed verification cannot be completed.",
        );
      }
      return { workspaceId: id, existingRoot: current?.rootMessageId };
    });
    const caller = agentManager.getAgent(callerAgentId!);
    const turnId = caller?.activeForegroundTurnId ?? caller?.activeTurnId;
    const rootRow =
      !existingRoot && turnId
        ? (await agentManager.getTimelineRows(callerAgentId!)).find(
            ({ item, turnId: rowTurn }) =>
              rowTurn === turnId &&
              item.type === "user_message" &&
              isLocalHumanTimelineMessage(item.text),
          )
        : undefined;
    const rootMessageId =
      existingRoot ??
      (rootRow?.item.type === "user_message"
        ? (rootRow.item.messageId ?? rootRow.item.clientMessageId)
        : undefined);
    const rootPrompt = rootRow?.item.type === "user_message" ? rootRow.item.text : undefined;
    const rootPromptText = rootPrompt
      ? (parseAgentMessages(rootPrompt)?.find(({ source }) => source === null)?.text ?? rootPrompt)
      : undefined;
    const localServer = options.serverId ?? "self";
    const admission: TaskDispatchAdmission = {};
    const checkCaller = agentManager.taskDispatchCaller(callerAgentId!, workspaceId);
    let resetEpoch: number | undefined;
    let capture: ReturnType<AgentManager["captureTaskBinding"]> | undefined;

    function rememberTaskHandoff(agentId: string) {
      if (!admission.messageId) return;
      pendingBindings.set(admission.messageId, {
        messageId: admission.messageId,
        agentId,
        workspaceId,
        taskId: input.taskId,
        rootMessageId,
      });
    }

    async function readTarget(agentId: string) {
      const stored = await agentStorage.get(agentId);
      const live = agentManager.getAgent(agentId);
      const target = live ?? stored;
      if (!target) throw new PaseoToolInputError(`Agent ${agentId} not found`);
      if (target.workspaceId !== workspaceId) {
        throw new PaseoToolInputError("Task binding requires an agent in your current workspace.");
      }
      if (
        !callerAgentId ||
        target.internal ||
        !isLocalTaskChild(target.labels, callerAgentId, localServer)
      ) {
        throw new PaseoToolInputError("Task binding requires a local direct subagent.");
      }
      return { live, stored, callerId: callerAgentId };
    }

    return {
      workspaceId,
      run<T>(operation: () => T, messageId?: string) {
        admission.messageId = messageId;
        return runWithTaskDispatchAdmission(admission, operation);
      },
      prepareRecipient(agentId: string) {
        admission.beforeProviderDispatch = () => this.labelTarget(agentId);
      },
      async validateDispatch(agentId: string) {
        try {
          await requireTaskLedgerWorkspace(workspaceId);
          const { live, stored, callerId } = await readTarget(agentId);
          const decision = agentManager.readTaskAgentReuse(
            callerId,
            workspaceId,
            { agentId },
            live,
            stored,
          );
          if (decision.action === "reset" || decision.action === "unavailable") {
            throw new PaseoToolInputError(`Agent ${agentId}: ${decision.description}.`);
          }
          if (resetEpoch !== undefined && resetEpoch !== decision.resetEpoch) {
            throw new PaseoToolInputError(`Agent ${agentId} was reset while the task was waiting.`);
          }
          resetEpoch = decision.resetEpoch;
          // Read storage first. Capture both live identities only after all awaited
          // reads, then repeat the synchronous check at each irreversible boundary.
          checkCaller();
          const checkTarget = agentManager.taskDispatchTarget(
            callerId,
            agentId,
            workspaceId,
            resetEpoch ?? 0,
            stored,
          );
          admission.agentId = agentId;
          admission.assertCurrent = () => {
            checkCaller();
            checkTarget();
          };
          admission.assertCurrent();
          // The existing queue waits for busy recipients unless interrupt was requested.
          capture ??= agentManager.captureTaskBinding(agentId, workspaceId);
        } catch (error) {
          if (!(error instanceof PaseoToolInputError)) throw error;
          throw new TaskDispatchRejectedError(error.message);
        }
      },
      async labelTarget(agentId: string) {
        await this.validateDispatch(agentId);
        const target = agentManager.getAgent(agentId);
        // A replacement checks its handoff before canceling, then again before its new
        // provider turn. Keep the old turn's labels until that turn actually ends.
        if (!target || target.activeForegroundTurnId || target.activeTurnId) return;
        if (
          target.labels?.[TASK_ID_LABEL] === input.taskId &&
          (target.labels?.[TOPIC_ROOT_MESSAGE_ID_LABEL] ?? "") === (rootMessageId ?? "")
        ) {
          rememberTaskHandoff(agentId);
          return;
        }
        await agentManager.setLabels(agentId, {
          [TASK_ID_LABEL]: input.taskId,
          [TOPIC_ROOT_MESSAGE_ID_LABEL]: rootMessageId ?? "",
        });
        admission.assertCurrent?.();
        rememberTaskHandoff(agentId);
      },
      close() {
        capture?.close();
        if (admission.messageId) pendingBindings.delete(admission.messageId);
      },
      async record(agentId: string, messageId: string, created = false) {
        try {
          return await withTaskLedger(workspaceId, async (ledger, id) => {
            // Once accepted, an archive is a historical observation, not a new dispatch.
            const { callerId, live, stored } = await readTarget(agentId);
            const events = capture?.events(messageId) ?? [];
            const accepted = events.find((event) => event.kind === "dispatched");
            if (!accepted) {
              throw new PaseoToolInputError(
                "No provider acceptance was observed for the task binding.",
              );
            }
            if (created) {
              events.push(
                taskEvent(
                  agentId,
                  "created",
                  accepted.resetEpoch,
                  undefined,
                  messageId,
                  accepted.order - 1,
                ),
              );
            }
            const task = await ledger.upsert(
              id,
              {
                ...input,
                rootMessageId,
                leadAgentId: agentId,
                leadServerId: options.serverId,
                participants: [{ agentId, boundBy: callerId }],
              },
              events,
            );
            if (options.upsertTopicAnchor) {
              try {
                await options.upsertTopicAnchor({
                  workspaceId: id,
                  mainAgentId: callerId,
                  topicKey: `task:${task.taskId}`,
                  taskId: task.taskId,
                  rootMessageId: task.rootMessageId,
                  rootPromptText: rootPromptText ?? task.title,
                  title: task.title,
                  leadAgentId: task.leadAgentId,
                  leadServerId: task.leadServerId,
                  leadTitle: live?.config.title ?? stored?.title ?? undefined,
                });
              } catch (error) {
                childLogger.warn(
                  { err: error, workspaceId, taskId: task.taskId },
                  "Failed to anchor agent task binding",
                );
                return {
                  taskId: task.taskId,
                  taskBindingError:
                    "The task was recorded, but its topic anchor could not be saved.",
                };
              }
            }
            return { taskId: task.taskId };
          });
        } catch (error) {
          // The dispatch already succeeded. Keep its acknowledgement and report the write separately.
          childLogger.warn(
            { err: error, agentId, workspaceId },
            "Failed to record agent task binding",
          );
          return { taskBindingError: error instanceof Error ? error.message : String(error) };
        }
      },
    };
  }

  function resolveWorkspaceIdForRename(requestedWorkspaceId?: string): string {
    const explicitWorkspaceId = requestedWorkspaceId?.trim();
    if (explicitWorkspaceId) {
      return explicitWorkspaceId;
    }

    if (callerAgentId) {
      const callerAgent = resolveCallerAgent();
      if (!callerAgent?.workspaceId) {
        throw new PaseoToolInputError(`Caller agent ${callerAgentId} has no current workspace`);
      }
      return callerAgent.workspaceId;
    }
    throw new PaseoToolInputError("workspaceId is required outside an agent-scoped session");
  }

  const buildCallerAgentScheduleConfigExtras = (
    callerAgent: NonNullable<ReturnType<typeof resolveCallerAgent>>,
    resolvedProvider: string,
  ): Record<string, unknown> => {
    return {
      ...(callerAgent.config.thinkingOptionId
        ? { thinkingOptionId: callerAgent.config.thinkingOptionId }
        : {}),
      ...(callerAgent.provider === resolvedProvider && callerAgent.config.providerOptions
        ? { providerOptions: callerAgent.config.providerOptions }
        : {}),
      ...(callerAgent.config.systemPrompt ? { systemPrompt: callerAgent.config.systemPrompt } : {}),
      ...(callerAgent.config.mcpServers ? { mcpServers: callerAgent.config.mcpServers } : {}),
    };
  };

  const buildCallerAgentScheduleConfig = (
    callerAgent: NonNullable<ReturnType<typeof resolveCallerAgent>>,
    params?: { provider?: string; cwd?: string },
  ) => {
    const hasProviderOverride = params?.provider !== undefined;
    const resolvedProviderModel = hasProviderOverride
      ? resolveScheduleProviderAndModel({
          provider: params?.provider,
          defaultProvider: callerAgent.provider,
        })
      : null;
    const resolvedProvider = resolvedProviderModel?.provider ?? callerAgent.provider;
    let resolvedModel: string | undefined;
    if (resolvedProviderModel?.model) {
      resolvedModel = resolvedProviderModel.model;
    } else if (!hasProviderOverride && callerAgent.config.model) {
      resolvedModel = callerAgent.config.model;
    }
    return {
      provider: resolvedProvider,
      cwd: params?.cwd?.trim() ? expandUserPath(params.cwd) : callerAgent.cwd,
      ...(callerAgent.currentModeId && callerAgent.provider === resolvedProvider
        ? {
            modeId: callerAgent.currentModeId,
          }
        : {}),
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...buildCallerAgentScheduleConfigExtras(callerAgent, resolvedProvider),
    };
  };

  const resolveNewAgentScheduleTarget = (params?: {
    provider?: string;
    cwd?: string;
    isolation?: "local" | "worktree";
  }) => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent) {
      return {
        type: "new-agent" as const,
        config: {
          ...buildCallerAgentScheduleConfig(callerAgent, params),
          ...(params?.isolation ? { isolation: params.isolation } : {}),
        },
      };
    }

    if (!params?.provider?.trim()) {
      throw new PaseoToolInputError("provider is required when target is new-agent");
    }

    const resolvedProviderModel = resolveScheduleProviderAndModel({
      provider: params?.provider,
      defaultProvider: params.provider,
    });
    return {
      type: "new-agent" as const,
      config: {
        provider: resolvedProviderModel.provider,
        cwd: params?.cwd?.trim() ? expandUserPath(params.cwd) : process.cwd(),
        ...(resolvedProviderModel.model ? { model: resolvedProviderModel.model } : {}),
        ...(params?.isolation ? { isolation: params.isolation } : {}),
      },
    };
  };

  async function requireScheduleTarget(id: string, type: "agent" | "new-agent") {
    if (!scheduleService) {
      throw new Error("Schedule service is not configured");
    }
    let schedule: Awaited<ReturnType<ScheduleService["inspect"]>>;
    try {
      schedule = await scheduleService.inspect(id);
    } catch (error) {
      if (error instanceof ScheduleNotFoundError) {
        throw new PaseoToolInputError(error.message);
      }
      throw error;
    }
    if (schedule.target.type !== type) {
      throw new PaseoToolInputError(
        type === "agent" ? `Heartbeat not found: ${id}` : `Schedule not found: ${id}`,
      );
    }
    return schedule;
  }

  async function runScheduleAction<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ScheduleStateConflictError) {
        throw new PaseoToolInputError(error.message);
      }
      throw error;
    }
  }

  async function requireCallerHeartbeat(id: string) {
    if (!callerAgentId) {
      throw new PaseoToolInputError("Heartbeat operations require an agent-scoped session");
    }
    const schedule = await requireScheduleTarget(id, "agent");
    if (schedule.target.type !== "agent" || schedule.target.agentId !== callerAgentId) {
      throw new PaseoToolInputError(`Heartbeat ${id} does not belong to caller ${callerAgentId}`);
    }
    return schedule;
  }
  const ProviderModelInputSchema = AgentProviderEnum.trim()
    .refine((value) => value.includes("/"), {
      message: "provider must be provider/model, for example codex/gpt-5.4",
    })
    .refine(
      (value) => {
        if (!value.includes("/")) {
          return true;
        }
        try {
          resolveRequiredProviderModel(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "provider must be provider/model, for example codex/gpt-5.4" },
    );
  const ProviderOrProviderModelInputSchema = AgentProviderEnum.trim()
    .min(1, "provider is required")
    .refine(
      (value) => {
        if (!value.includes("/")) {
          return true;
        }
        try {
          resolveRequiredProviderModel(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "provider must be provider or provider/model, for example codex/gpt-5.4" },
    );
  const CreateAgentSettingsInputSchema = z
    .object({
      modeId: z.string().optional().describe("Session mode to configure before the first run."),
      thinkingOptionId: z.string().optional().describe("Thinking option ID."),
      features: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Provider-specific feature values, for example { fast_mode: true } for Codex."),
    })
    .strict();
  const UpdateAgentSettingsInputSchema = z
    .object({
      modeId: z.string().optional().describe("Session mode ID."),
      model: z.string().nullable().optional().describe("Model ID. Pass null to clear."),
      thinkingOptionId: z
        .string()
        .nullable()
        .optional()
        .describe("Thinking option ID. Pass null to clear."),
      features: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Provider-specific feature values, for example { fast_mode: true } for Codex."),
    })
    .strict();
  const InspectProviderSettingsInputSchema = z
    .object({
      modeId: z.string().optional().describe("Draft session mode ID."),
      model: z.string().optional().describe("Draft model ID."),
      thinkingOptionId: z.string().optional().describe("Draft thinking option ID."),
      features: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Draft provider feature values."),
    })
    .strict();
  const AgentRelationshipInputSchema = z.discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("subagent") })
      .strict()
      .describe("Create a child agent under this agent's subagent track."),
    z
      .object({ kind: z.literal("detached") })
      .strict()
      .describe("Create a root agent that does not appear in this agent's subagent track."),
  ]);
  const AgentWorkspaceInputSchema = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("current"),
        cwd: z.string().optional().describe("Optional runtime cwd. Defaults to the caller's cwd."),
      })
      .strict()
      .describe("Use the caller's current workspace."),
    z
      .object({
        kind: z.literal("existing"),
        workspaceId: z.string().min(1).describe("Existing workspace id to attach the agent to."),
        cwd: z
          .string()
          .optional()
          .describe("Optional runtime cwd. Defaults to the existing workspace cwd."),
      })
      .strict()
      .describe("Attach the agent to an existing workspace."),
    z
      .object({
        kind: z.literal("create"),
        source: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("directory"),
              path: z
                .string()
                .optional()
                .describe("Optional directory path. Defaults to the caller's cwd."),
            })
            .strict(),
        ]),
      })
      .strict()
      .describe("Create a new workspace for the agent."),
  ]);
  const commonCreateAgentFields = {
    taskBinding: WorkspaceTaskToolInputSchema.optional().describe(
      "Main Control only. Upsert a task in your workspace and add the created agent as a participant.",
    ),
    title: z
      .string()
      .trim()
      .min(1, "Title is required")
      .max(60, "Title must be 60 characters or fewer")
      .describe("Short descriptive title (<= 60 chars) summarizing the agent's focus."),
    provider: ProviderModelInputSchema.optional().describe(
      "Provider/model pair, for example codex/gpt-5.4. Required when profileId is omitted.",
    ),
    profileId: z
      .string()
      .trim()
      .min(1)
      .max(AGENT_PROFILE_ID_MAX_LENGTH)
      .optional()
      .describe("Preset ID from list_profiles. Applies its provider settings and role defaults."),
    resident: z
      .boolean()
      .optional()
      .describe("Create a lasting specialist in your workspace. Omit to use the profile default."),
    residentRole: z
      .string()
      .trim()
      .min(1)
      .max(RESIDENT_ROLE_MAX_LENGTH)
      .optional()
      .describe("Display role for a resident specialist. Omit to use the profile name."),
    labels: z.record(z.string(), z.string()).optional().describe("Labels to set on the agent"),
    settings: CreateAgentSettingsInputSchema.optional().describe(
      "Initial runtime settings for the new agent.",
    ),
    initialPrompt: z
      .string()
      .trim()
      .min(1, "initialPrompt is required")
      .describe("Required first task to run immediately after creation."),
    background: z
      .boolean()
      .optional()
      .describe(
        "True creates a background agent: hidden from tabs, default lists, your subagent track and notifications. You still get its finish notification and can address it by id. Omit to inherit your own value (false without a caller); use it for helpers the user does not need to watch.",
      ),
  };
  const legacyCreateAgentPlacementFields = {
    relationship: AgentRelationshipInputSchema.describe(
      "Whether the created agent is a subagent under you or a detached root agent.",
    ),
    workspace: AgentWorkspaceInputSchema.describe(
      "Workspace ownership/location for the created agent.",
    ),
  };
  const canonicalCreateAgentFields = {
    ...commonCreateAgentFields,
    workspaceId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Existing workspace id. Agent-scoped calls default to the caller workspace; top-level calls create a new local workspace when omitted.",
      ),
  };
  const agentToAgentInputSchema = {
    ...canonicalCreateAgentFields,
    workspaceId: canonicalCreateAgentFields.workspaceId.describe(
      "Your current workspace ID. Omit it to reuse your current workspace.",
    ),
    parentReporting: z
      .enum(["auto", "explicit"])
      .optional()
      .describe(
        'Set "explicit" to have the child report via report_to_parent and skip automatic completion notifications by default. Set "auto" to keep automatic follow-up notifications even when skipping the first notification.',
      ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .describe(
        "Get notified when the first turn finishes, errors, or needs permission. Set false to skip that notification. Main Control also defaults the child to explicit reporting in that case unless parentReporting is set.",
      ),
    playbook: LeadPlaybookSchema.optional().describe(
      'Main Control only: attach a built-in Level-1 orchestration contract ("batch_implement", "cr_fix_loop", or "readonly_cr"). Forces explicit parent reporting and notifyOnFinish: false.',
    ),
    commitPolicy: LeadCommitPolicySchema.optional().describe(
      'Commit policy for "batch_implement" or "cr_fix_loop": "none" (default, leave verified edits uncommitted) or "scoped_only" (commit owned files via git commit --only when explicitly authorized).',
    ),
  };
  const canonicalTopLevelInputSchema = {
    ...canonicalCreateAgentFields,
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Agent-scoped only: get notified when the created agent finishes, errors, or needs permission.",
      ),
  };
  const legacyAgentToAgentInputSchema = {
    ...commonCreateAgentFields,
    ...legacyCreateAgentPlacementFields,
    parentReporting: agentToAgentInputSchema.parentReporting,
    notifyOnFinish: agentToAgentInputSchema.notifyOnFinish,
    playbook: agentToAgentInputSchema.playbook,
    commitPolicy: agentToAgentInputSchema.commitPolicy,
  };
  const legacyTopLevelCreateAgentInputSchema = {
    ...commonCreateAgentFields,
    relationship: legacyCreateAgentPlacementFields.relationship.optional(),
    workspace: legacyCreateAgentPlacementFields.workspace.optional(),
    notifyOnFinish: canonicalTopLevelInputSchema.notifyOnFinish,
    cwd: z
      .string()
      .optional()
      .describe("Legacy top-level working directory. Prefer workspace.source.path."),
    mode: z.string().optional().describe("Legacy session mode ID. Prefer settings.modeId."),
    thinking: z
      .string()
      .optional()
      .describe("Legacy thinking option ID. Prefer settings.thinkingOptionId."),
    features: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Legacy feature values. Prefer settings.features."),
  };
  const createAgentInputSchema = z
    .object(scope === "agent" ? agentToAgentInputSchema : canonicalTopLevelInputSchema)
    .passthrough();
  const agentToAgentCreateAgentArgsSchema = z.object(agentToAgentInputSchema).strict();
  const legacyAgentToAgentCreateAgentArgsSchema = z.object(legacyAgentToAgentInputSchema).strict();
  const canonicalTopLevelCreateAgentArgsSchema = z.object(canonicalTopLevelInputSchema).strict();
  const legacyTopLevelCreateAgentArgsSchema = z
    .object(legacyTopLevelCreateAgentInputSchema)
    .strict();
  const commonSendAgentPromptInputSchema = {
    taskBinding: WorkspaceTaskToolInputSchema.optional().describe(
      "Main Control only. Wait for the prompt to dispatch, then add the local recipient to a task in your workspace.",
    ),
    agentId: z.string(),
    prompt: z.string(),
    sessionMode: z.string().optional().describe("Optional mode to set before running the prompt."),
  };
  const agentToAgentSendAgentPromptInputSchema = {
    ...commonSendAgentPromptInputSchema,
    activeTurnBehavior: AgentActiveTurnBehaviorSchema.optional().describe(
      'Leave this out unless the message cannot wait. Default "queue": the message waits until the agent\'s running turn ends. "steer": the message joins the running turn; a provider that cannot steer interrupts the turn instead. "interrupt": the running turn stops and a new turn starts with the message. A steer or interrupt carries the messages you queued before it, in order.',
    ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .describe(
        "Get notified when the prompted agent finishes, errors, or needs permission. Defaults to true except for explicit-reporting agents, where it defaults to false.",
      ),
  };
  const topLevelSendAgentPromptInputSchema = {
    ...commonSendAgentPromptInputSchema,
    activeTurnBehavior: ActiveTurnBehaviorSchema.optional().describe(
      'Default "interrupt": the running turn stops and a new turn starts with the prompt. "steer": the prompt joins the running turn; a provider that cannot steer interrupts the turn instead.',
    ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Agent-scoped only: get notified when the prompted agent finishes, errors, or needs permission.",
      ),
  };
  const sendAgentPromptInputSchema =
    scope === "agent" ? agentToAgentSendAgentPromptInputSchema : topLevelSendAgentPromptInputSchema;
  const inspectProviderInputSchema = {
    provider: ProviderOrProviderModelInputSchema.describe(
      "Provider ID, optionally with a model ID (for example codex or codex/gpt-5.4).",
    ),
    cwd: z
      .string()
      .optional()
      .describe("Working directory used to resolve provider feature availability."),
    settings: InspectProviderSettingsInputSchema.optional().describe(
      "Draft provider settings used to compute available features.",
    ),
  };
  type AgentToAgentCreateAgentArgs = z.infer<typeof agentToAgentCreateAgentArgsSchema>;
  type LegacyAgentToAgentCreateAgentArgs = z.infer<typeof legacyAgentToAgentCreateAgentArgsSchema>;
  type TopLevelCreateAgentArgs = z.infer<typeof canonicalTopLevelCreateAgentArgsSchema>;
  type LegacyTopLevelCreateAgentArgs = z.infer<typeof legacyTopLevelCreateAgentArgsSchema>;

  if (options.voiceOnly || options.enableVoiceTools || callerContext?.enableVoiceTools) {
    registerTool(
      "speak",
      {
        title: "Speak",
        description:
          "Speak text to the user via daemon-managed voice output. Blocks until playback completes.",
        inputSchema: {
          text: z
            .string()
            .trim()
            .min(1, "text is required")
            .max(4000, "text must be 4000 characters or fewer"),
        },
        outputSchema: {
          ok: z.boolean(),
        },
      },
      async (args, context) => {
        if (!callerAgentId) {
          throw new PaseoToolInputError("speak is only available to agent-scoped tool sessions");
        }
        const handler = resolveSpeakHandler?.(callerAgentId) ?? null;
        if (!handler) {
          throw new PaseoToolInputError(
            `No speak handler registered for your session '${callerAgentId}'`,
          );
        }
        await handler({
          text: args.text,
          callerAgentId,
          signal: context?.signal,
        });
        return {
          content: [],
          structuredContent: ensureValidJson({ ok: true }),
        };
      },
    );
  }

  if (options.voiceOnly) {
    return toCatalog();
  }

  if (options.browserToolsEnabled && options.browserToolsBroker) {
    registerBrowserTools({
      registerTool,
      broker: options.browserToolsBroker,
      callerAgentId,
      resolveCallerAgent,
    });
  }

  registerTool(
    "list_hosts",
    {
      title: "List hosts",
      description: "Discover this host and registered destination hosts for fleet tools.",
      inputSchema: {},
    },
    async () => ({
      content: [],
      structuredContent: ensureValidJson(await hostResolver.directory()),
    }),
  );

  registerTool(
    "create_workspace",
    {
      title: "Create workspace",
      description: describeForScope(
        AGENT_WORKSPACE_CREATION_ERROR,
        "Create a workspace using an existing local checkout or a new Paseo-managed worktree.",
      ),
      inputSchema:
        scope === "agent"
          ? z.object({}).passthrough()
          : {
              isolation: z.enum(["local", "worktree"]),
              path: z
                .string()
                .optional()
                .describe(
                  "Local directory or source checkout. Defaults to your current workspace. Local isolation adopts an existing directory and never creates one.",
                ),
              projectId: z
                .string()
                .optional()
                .describe("Existing project id to own the workspace."),
              title: z.string().trim().min(1).optional(),
              background: z
                .boolean()
                .optional()
                .describe(
                  "True hides the workspace from default lists and the sidebar while its contents remain durable and accessible; omit background to inherit your own visibility (true when you or your current workspace are background, false without a caller), and override it only when the user explicitly asks.",
                ),
              mode: z
                .enum(["branch-off", "checkout-branch", "checkout-pr"])
                .optional()
                .describe("Worktree creation mode. Defaults to branch-off."),
              worktreeSlug: z.string().trim().min(1).optional(),
              branchName: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe("New branch name for branch-off mode."),
              baseBranch: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe("Base ref for branch-off mode."),
              branch: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe("Existing branch for checkout-branch mode."),
              prNumber: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Pull request or change request number for checkout-pr mode."),
              forge: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe("Forge for checkout-pr mode. Defaults to the source checkout."),
            },
      outputSchema: WorkspaceAutomationSummarySchema.shape,
    },
    async ({
      isolation,
      path,
      projectId,
      title,
      background,
      mode,
      worktreeSlug,
      branchName,
      baseBranch,
      branch,
      prNumber,
      forge,
    }) => {
      let workspace: PersistedWorkspaceRecord;
      if (isolation === "local") {
        const cwd = resolveScopedCwd(path, { required: true });
        if (!(await isExistingDirectory(cwd))) {
          throw new PaseoToolInputError(`Directory not found: ${cwd}`);
        }
        assertOptionsAbsent(
          [
            ["mode", mode],
            ["worktreeSlug", worktreeSlug],
            ["branchName", branchName],
            ["baseBranch", baseBranch],
            ["branch", branch],
            ["prNumber", prNumber],
            ["forge", forge],
          ],
          "Worktree options require isolation worktree",
        );
        if (!options.createDirectoryWorkspace) {
          throw new Error("Workspace provisioning is not configured");
        }
        workspace = await options.createDirectoryWorkspace(
          cwd,
          title,
          projectId,
          workspaceBackgroundIntent(background),
        );
      } else {
        let cwd =
          path !== undefined || !projectId ? resolveScopedCwd(path, { required: true }) : null;
        if (!cwd) {
          if (!options.projectRegistry) {
            throw new Error("Project registry is not configured");
          }
          cwd = await resolveWorktreeSourceCwd({ projectId }, options.projectRegistry);
        }
        const worktreeTarget = resolveWorkspaceWorktreeTarget({
          mode,
          worktreeSlug,
          branchName,
          baseBranch,
          branch,
          prNumber,
          forge,
        });
        const result = await createPaseoWorktreeCommand(
          {
            paseoHome: options.paseoHome,
            worktreesRoot: options.worktreesRoot,
            createPaseoWorktreeWorkflow: options.createPaseoWorktree,
          },
          {
            cwd,
            ...(projectId ? { projectId } : {}),
            ...(worktreeSlug ? { worktreeSlug } : {}),
            ...worktreeTarget,
            ...(title ? { title } : {}),
            ...workspaceBackgroundIntent(background),
          },
        );
        if (!result.ok) {
          throw result.cause;
        }
        workspace = result.createdWorktree.workspace;
      }

      return {
        content: [],
        structuredContent: ensureValidJson(toWorkspaceAutomationSummary(workspace)),
      };
    },
  );

  registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description: "List active workspaces.",
      inputSchema: { includeBackground: z.boolean().optional().default(false) },
      outputSchema: { workspaces: z.array(WorkspaceAutomationSummarySchema) },
    },
    async ({ includeBackground = false }) => {
      if (!options.workspaceRegistry) {
        throw new Error("Workspace registry is not configured");
      }
      const workspaces = (await options.workspaceRegistry.listActive())
        .filter(
          (workspace) => !workspace.archivedAt && (includeBackground || !workspace.background),
        )
        .map(toWorkspaceAutomationSummary);
      return {
        content: [],
        structuredContent: ensureValidJson({ workspaces }),
      };
    },
  );

  registerTool(
    "summarize_workspace_agents",
    {
      title: "Summarize workspace sessions",
      description:
        "Read active and closed sessions, their latest progress, tasks, and touched files. Archived sessions are omitted by default.",
      inputSchema: {
        workspaceId: z.string().trim().min(1).optional(),
        includeArchived: z
          .boolean()
          .optional()
          .describe("Include up to 30 recently updated archived sessions."),
      },
      outputSchema: {
        workspaceId: z.string(),
        summaryText: z.string(),
        entries: z.array(WorkspaceAgentSummaryEntrySchema),
      },
    },
    async ({ workspaceId: requestedWorkspaceId, includeArchived }) => {
      if (!options.workspaceRegistry) throw new Error("Workspace registry is not configured");
      const workspaceId = resolveWorkspaceIdForRename(requestedWorkspaceId);
      const { summaryText, entries } = await summarizeWorkspaceAgents({
        workspaceId,
        includeArchived,
        agentManager: {
          listAgents: (filters) => agentManager.listAgents(filters).filter(isToolVisibleAgent),
          readTimelineForSummary: agentManager.readTimelineForSummary.bind(agentManager),
        },
        agentStorage: {
          listByWorkspaces: async (...args) =>
            (await agentStorage.listByWorkspaces(...args)).filter(isToolVisibleAgent),
        },
        workspaceRegistry: options.workspaceRegistry,
        logger: childLogger,
      });
      return {
        content: [],
        structuredContent: ensureValidJson({ workspaceId, summaryText, entries }),
      };
    },
  );

  registerTool(
    "archive_workspace",
    {
      title: "Archive workspace",
      description: "Archive a workspace and everything it owns.",
      inputSchema: { workspaceId: z.string().min(1) },
      outputSchema: {
        workspaceId: z.string(),
        archivedAgentIds: z.array(z.string()),
        removedDirectory: z.boolean(),
      },
    },
    async ({ workspaceId }) => {
      if (!options.listActiveWorkspaces) {
        throw new Error("Active workspace lister is required to archive workspaces");
      }
      const workspace = await requireActiveWorkspaceForArchive(
        { listActiveWorkspaces: options.listActiveWorkspaces },
        workspaceId,
      );
      const result = await archiveByScope(
        archiveWorktreeDependencies(options, {
          agentManager,
          agentStorage,
          terminalManager: terminalManager ?? null,
          logger: childLogger,
        }),
        {
          requestId: "mcp:archive_workspace",
          scope: { kind: "workspace", workspaceId: workspace.workspaceId },
          caller: callerAgentId ? await readHierarchyAgent(callerAgentId) : null,
        },
      );
      return {
        content: [],
        structuredContent: ensureValidJson({
          workspaceId,
          archivedAgentIds: result.archivedAgentIds,
          removedDirectory: result.removedDirectory,
        }),
      };
    },
  );

  function registerTaskLedgerTools() {
    if (scope !== "agent" || !taskLedger) return;
    if (
      callerAgentId &&
      (options.verifiedCallerAgentId !== callerAgentId ||
        (!isMainControlAgentLabels(agentManager.getAgent(callerAgentId)?.labels) &&
          // Native tools can be assembled before the caller is live. Execution checks its current role.
          !options.paseoToolPolicy?.allowedTools?.includes("list_workspace_tasks")))
    )
      return;
    const workspaceIdSchema = z.string().min(1).optional().describe("Your current workspace ID.");
    registerTool(
      "upsert_workspace_task",
      {
        title: "Update workspace task",
        description: "Create or update a task in your current workspace. Omitted fields are kept.",
        inputSchema: WorkspaceTaskToolInputSchema.extend({
          workspaceId: workspaceIdSchema,
        }).strict(),
      },
      async ({ workspaceId: requestedWorkspaceId, ...input }) => {
        if (callerAgentId && getActivePeerTurnContext(callerAgentId)) {
          throw new PaseoToolInputError(
            "Cross-workspace peer messages are read-only (A0 READ) and cannot mutate the workspace task ledger.",
          );
        }
        return withTaskLedger(requestedWorkspaceId, async (ledger, workspaceId) => {
          const task = await ledger.upsert(workspaceId, input);
          return { content: [], structuredContent: ensureValidJson({ workspaceId, task }) };
        });
      },
    );
    registerTool(
      "list_workspace_tasks",
      {
        title: "List workspace tasks",
        description: "Read the task ledger for your current workspace.",
        inputSchema: z.object({ workspaceId: workspaceIdSchema }).strict(),
      },
      async ({ workspaceId: requestedWorkspaceId }) =>
        withTaskLedger(requestedWorkspaceId, async (ledger, workspaceId) => {
          const tasks = await ledger.list(workspaceId);
          const reuse = await agentManager.readTaskParticipantReuse(
            callerAgentId!,
            workspaceId,
            tasks,
          );
          return {
            content: [],
            structuredContent: ensureValidJson({
              workspaceId,
              tasks: projectTaskParticipantReuse(tasks, reuse),
            }),
          };
        }),
    );
  }
  registerTaskLedgerTools();

  function registerButlerTools() {
    if (scope !== "agent") return;
    if (callerAgentId) {
      if (options.verifiedCallerAgentId !== callerAgentId) return;
      const live = agentManager.getAgent(callerAgentId);
      if (
        live &&
        (!isMainControlAgentLabels(live.labels) || getParentAgentIdFromLabels(live.labels))
      )
        return;
      if (!live && !options.paseoToolPolicy?.allowedTools?.includes("get_workspace_situation"))
        return;
    }

    const workspaceIdSchema = z.string().trim().min(1).optional();
    const situationInputSchema = z.strictObject({
      workspaceId: workspaceIdSchema,
      includeCompletedTasks: z.boolean().default(false),
      completedLimit: z.number().int().positive().max(20).default(5),
    });
    registerTool(
      "get_workspace_situation",
      {
        title: "Get workspace situation",
        description:
          "Read your workspace's topics, active work, human decisions, todos and file conflicts without waking any agents.",
        inputSchema: situationInputSchema,
      },
      async ({ workspaceId: requested, ...input }: z.output<typeof situationInputSchema>) => {
        const { workspaceId, mainAgentId } = await requireButlerCaller(requested);
        if (!options.getWorkspaceSituation)
          throw new PaseoToolInputError("Workspace situation is unavailable on this host.");
        const situation = await options.getWorkspaceSituation(workspaceId, mainAgentId, input);
        await requireButlerCaller(workspaceId);
        const json = JSON.stringify(situation);
        if (Buffer.byteLength(json, "utf8") >= WORKSPACE_SITUATION_MAX_BYTES)
          throw new PaseoToolInputError("Workspace situation exceeded its output limit.");
        const structuredContent: unknown = JSON.parse(json);
        return {
          content: [{ type: "text", text: json }],
          structuredContent,
        };
      },
    );

    const dispatchInputSchema = WorkspaceTopicDecideRequestSchema.omit({
      type: true,
      requestId: true,
      workspaceId: true,
      mainAgentId: true,
    })
      .extend({ workspaceId: workspaceIdSchema })
      .strict();
    registerTool(
      "dispatch_topic_decision",
      {
        title: "Dispatch topic decision",
        description:
          "Send the user's decision to its topic and record it on the topic card. Requires a direct human turn. Use a stable clientMessageId for retry. System authorizations cannot be decided here.",
        inputSchema: dispatchInputSchema,
      },
      async (
        { workspaceId: requested, ...input }: z.output<typeof dispatchInputSchema>,
        context,
      ) => {
        const turn = context[butlerDecisionTurn];
        if (!turn) throw new PaseoToolInputError("The decision turn could not be verified.");
        const { workspaceId, mainAgentId } = await requireButlerCaller(requested);
        const durable = input.resolutionKind === "durable_item";
        const assertCurrent = () => {
          assertButlerCaller(mainAgentId, workspaceId);
          const current = readButlerDecisionTurn(mainAgentId);
          if (turn.peer || current.peer)
            throw new PaseoToolInputError(
              "Cross-workspace peer messages are read-only and cannot dispatch topic decisions.",
            );
          if (!turn.turnId || !turn.human || turn.turnId !== current.turnId || !current.human) {
            throw new PaseoToolInputError("Topic decisions require a direct human turn.");
          }
        };
        assertCurrent();

        const { decideTopicAction, durableItems, serverId } = options;
        if (!decideTopicAction)
          throw new PaseoToolInputError("Topic decisions are unavailable on this host.");
        if (durable) {
          const { durableItemRequestId, expectedRevision, decision } = input;
          if (!durableItemRequestId || expectedRevision === undefined || !decision)
            throw new PaseoToolInputError(
              "A durable item, expected revision and decision are required.",
            );
          if (!durableItems || !serverId)
            throw new PaseoToolInputError("Durable item decisions are unavailable on this host.");
          const item = await durableItems.get({
            workspaceId,
            serverId,
            requestId: durableItemRequestId,
          });
          if (!item)
            throw new PaseoToolInputError("The durable item is unavailable in this workspace.");
          if (item.kind === "authorization")
            throw new PaseoToolInputError(
              "System authorizations must be decided by the user directly.",
            );
        } else if (
          input.durableItemRequestId ||
          input.expectedRevision !== undefined ||
          input.decision
        ) {
          throw new PaseoToolInputError("Use a durable item decision for durable approval fields.");
        }
        await requireButlerCaller(workspaceId);
        assertCurrent();
        const result = await decideTopicAction(
          {
            ...input,
            type: "workspace.topic.decide.request",
            requestId: input.clientMessageId,
            workspaceId,
            mainAgentId,
          },
          {
            origin: "butler_dispatch",
            serverId,
            principalId: durable ? `agent:${mainAgentId}` : undefined,
            assertCurrent,
          },
        );
        return {
          isError: result.error !== null,
          content: [],
          structuredContent: ensureValidJson(result),
        };
      },
    );
  }
  registerButlerTools();

  async function findLocalMain(agentId: string, workspaceId: string) {
    const path = await readAgentHierarchyPath(agentId, readHierarchyAgent);
    const localServer = options.serverId ?? "self";
    for (const { labels, workspaceId: id, archivedAt } of path.values()) {
      const parent = getParentAddressFromLabels(labels, localServer);
      if (id !== workspaceId || archivedAt || (parent && parent.serverId !== localServer)) return;
    }
    return [...path.values()].find(
      ({ labels, workspaceId: id }) =>
        id === workspaceId &&
        !getParentAgentIdFromLabels(labels) &&
        isMainControlAgentLabels(labels),
    );
  }

  async function readDurableItemTopic(agentId: string, workspaceId: string, sourceTurnId: string) {
    const agent = agentManager.getAgent(agentId);
    if (!agent || agent.workspaceId !== workspaceId) return;
    // Snapshot the confirmed handoff lane before async reads. The lead can call a
    // tool before its parent finishes writing the provider acceptance to the ledger.
    const handoffs = [...pendingBindings.values()].filter(
      (binding) => binding.workspaceId === workspaceId && binding.agentId === agentId,
    );
    const main = await findLocalMain(agentId, workspaceId);
    if (!main) return;
    const [rows, tasks, entries] = await Promise.all([
      agentManager.getTimelineRows(agentId),
      taskLedger?.list(workspaceId) ?? [],
      options.listTopicEntries?.({ workspaceId, mainAgentId: main.id }) ?? [],
    ]);
    const messageIds = readDurableItemTurnMessageIds(rows, sourceTurnId);
    const topic = resolveDurableItemTurnTopic({
      agentId,
      resetEpoch: agent.resetEpoch,
      messageIds,
      pendingBindings: handoffs,
      tasks,
      entries,
    });
    if (topic) return topic;
    if (agentId !== main.id || !agentManager.isActiveTurnHumanInitiated(agentId)) return;
    const root = rows.find(
      ({ item, turnId }) =>
        turnId === sourceTurnId &&
        item.type === "user_message" &&
        isLocalHumanTimelineMessage(item.text),
    )?.item;
    if (root?.type !== "user_message") return;
    const rootMessageId = root.messageId ?? root.clientMessageId;
    if (!rootMessageId) return;
    const matching = tasks.filter(
      (task) => task.rootMessageId && messageIds.has(task.rootMessageId),
    );
    if (matching.length === 1) {
      const [task] = matching;
      return {
        taskId: task.taskId,
        topicKey: `task:${task.taskId}`,
        rootMessageId: task.rootMessageId,
      };
    }
    return { topicKey: `msg:${rootMessageId}`, rootMessageId };
  }

  function registerDurableItemRequestTool() {
    const { durableItems, serverId, verifiedCallerAgentId } = options;
    if (scope !== "agent" || !durableItems || !serverId) return;
    if (callerAgentId && verifiedCallerAgentId !== callerAgentId) return;

    registerTool(
      "request_human_decision",
      {
        title: "Request human decision",
        description:
          "Ask the user to make a decision or accept a deliverable in your current workspace. " +
          "This creates a persistent item for the user. Acceptance requires evidence paths. " +
          "For routine completion or a decision from your parent agent, use report_to_parent instead.",
        inputSchema: agentDurableItemRequestSchema,
      },
      async (input: z.infer<typeof agentDurableItemRequestSchema>) => {
        const item = await requestDurableItemFromAgent({
          store: durableItems,
          serverId,
          agentManager,
          callerAgentId,
          verifiedCallerAgentId,
          input,
          resolveTopic:
            callerAgentId && options.listTopicEntries
              ? ({ workspaceId, sourceTurnId }) =>
                  readDurableItemTopic(callerAgentId, workspaceId, sourceTurnId)
              : undefined,
        });
        return { content: [], structuredContent: ensureValidJson({ item }) };
      },
    );
  }
  registerDurableItemRequestTool();

  registerTool(
    "create_agent",
    {
      title: "Create agent",
      description:
        describeForScope(
          "Create a subagent in your current workspace on this host. ",
          "Create an agent. Omit workspaceId to create a new local workspace on this host. ",
        ) +
        "Provide profileId from list_profiles or provider/model, and an initial prompt. Reuse an existing resident specialist with send_agent_prompt. For a different provider, use inspect_provider to choose a supported mode.",
      inputSchema: createAgentInputSchema,
      outputSchema: {
        agentId: z.string(),
        type: AgentProviderEnum,
        status: AgentStatusEnum,
        cwd: z.string(),
        workspaceId: z.string().optional(),
        currentModeId: z.string().nullable(),
        availableModes: z.array(ProviderModeSchema),
        guidance: z.string().optional(),
        taskId: z.string().optional(),
        taskBindingError: z.string().optional(),
      },
    },
    async (args: { taskBinding?: z.infer<typeof WorkspaceTaskToolInputSchema> }) => {
      const resolvedArgs = await resolveCreateAgentToolArgs(args);
      const { parsedArgs } = resolvedArgs;
      const callerSnapshot = callerAgentId ? await readHierarchyAgent(callerAgentId) : null;
      let resolvedPlaybook: ResolvedLeadPlaybookOptions | undefined;
      if (resolvedArgs.kind === "agent-scoped") {
        try {
          resolvedPlaybook = resolveLeadPlaybookInput({
            playbook: resolvedArgs.parsedArgs.playbook,
            commitPolicy: resolvedArgs.parsedArgs.commitPolicy,
            callerLabels: callerSnapshot?.labels,
            resident: Boolean(
              resolvedArgs.parsedArgs.resident || resolvedArgs.parsedArgs.residentRole,
            ),
            parentReporting: resolvedArgs.parsedArgs.parentReporting,
            notifyOnFinish: resolvedArgs.parsedArgs.notifyOnFinish,
          });
        } catch (error) {
          if (error instanceof LeadPlaybookValidationError) {
            throw new PaseoToolInputError(error.message);
          }
          throw error;
        }
      }
      const taskBinding = args.taskBinding ? await prepareTaskBinding(args.taskBinding) : undefined;
      const notifyOnFinish = resolvedPlaybook ? false : parsedArgs.notifyOnFinish;
      let parentReporting: "auto" | "explicit" | undefined;
      if (resolvedPlaybook) {
        parentReporting = "explicit";
      } else if (resolvedArgs.kind === "agent-scoped") {
        parentReporting = resolvedArgs.parsedArgs.parentReporting;
      }
      const activePeerTurn = callerAgentId ? getActivePeerTurnContext(callerAgentId) : null;
      const baseProviderSettings = resolveCreateToolProviderSettings(parsedArgs);
      const effectiveProviderSettings = activePeerTurn
        ? await enforcePeerReadOnlyCreateSettings(parsedArgs, baseProviderSettings)
        : baseProviderSettings;
      const bindingMessageId = taskBinding ? randomUUID() : undefined;
      const { snapshot, initialPromptStarted, bindingResult } = await (async () => {
        let peerChildLockedBeforeStart = false;
        const create = (verifyPeerRecipient?: (agentId: string) => void) =>
          createAgentCommand(
            {
              serverId: options.serverId,
              agentManager,
              agentStorage,
              finishSubscriptions: options.finishSubscriptions?.(),
              logger: childLogger,
              paseoHome: options.paseoHome,
              worktreesRoot: options.worktreesRoot,
              terminalManager,
              providerSnapshotManager,
              ...(callerAgentId ? { workspaceRegistry: options.workspaceRegistry } : {}),
              createPaseoWorktree: options.createPaseoWorktree,
              ...(options.ensureWorkspaceForCreate
                ? { ensureWorkspaceForCreate: options.ensureWorkspaceForCreate }
                : {}),
            },
            {
              kind: "mcp",
              ...effectiveProviderSettings,
              title: parsedArgs.title,
              initialPrompt: activePeerTurn
                ? `${PEER_INSPECTION_PROMPT_PREFIX}${parsedArgs.initialPrompt}`
                : parsedArgs.initialPrompt,
              cwd: resolvedArgs.kind === "top-level" ? resolvedArgs.cwd : undefined,
              // Keep explicit placement for the final comparison after a concurrent parent move.
              workspaceId: taskBinding?.workspaceId ?? resolvedArgs.workspaceId,
              labels: parsedArgs.labels,
              promptFailure: taskBinding ? "return-error" : "throw",
              validateInitialPromptDispatch:
                taskBinding || activePeerTurn
                  ? async (createdAgentId) => {
                      await taskBinding?.labelTarget(createdAgentId);
                      if (activePeerTurn) {
                        const [firstCorrelationId] = activePeerTurn.correlationIds;
                        if (firstCorrelationId) {
                          await recordPeerLockedChild(
                            createdAgentId,
                            firstCorrelationId,
                            "initial",
                          );
                          peerChildLockedBeforeStart = true;
                          verifyPeerRecipient?.(createdAgentId);
                        }
                      }
                    }
                  : undefined,
              initialPromptMessageId: bindingMessageId,
              notifyOnFinish,
              parentReporting,
              playbook: resolvedPlaybook?.playbook,
              commitPolicy: resolvedPlaybook?.commitPolicy,
              background: parsedArgs.background,
              detached: resolvedArgs.kind === "top-level" && resolvedArgs.detached,
              callerAgentId,
              callerContext,
            },
          );

        const startCreate = () => (activePeerTurn ? withPeerInitialPrompt(create) : create());
        const creation = await (taskBinding
          ? taskBinding.run(startCreate, bindingMessageId)
          : startCreate());
        if (activePeerTurn && !peerChildLockedBeforeStart) {
          const [firstCorrelationId] = activePeerTurn.correlationIds;
          if (firstCorrelationId) {
            await recordPeerLockedChild(creation.snapshot.id, firstCorrelationId, "initial");
          }
        }
        let recordedBinding;
        if (taskBinding && bindingMessageId) {
          recordedBinding = creation.initialPromptStarted
            ? await taskBinding.record(creation.snapshot.id, bindingMessageId, true)
            : {
                taskBindingError:
                  creation.initialPromptError instanceof Error
                    ? creation.initialPromptError.message
                    : "The initial prompt did not start.",
              };
        }
        return { ...creation, bindingResult: recordedBinding };
      })().finally(() => taskBinding?.close());
      const currentSnapshot = agentManager.getAgent(snapshot.id) ?? snapshot;
      const guidance =
        callerAgentId &&
        (notifyOnFinish ?? !isExplicitParentReportingLabels(snapshot.labels)) &&
        initialPromptStarted
          ? creationNotificationGuidance
          : "Creation acknowledged. Observe completion using get_agent_status/get_agent_activity or SDK/RPC subscriptions and wait APIs.";
      const response = {
        content: [],
        structuredContent: ensureValidJson({
          agentId: currentSnapshot.id,
          type: snapshot.provider,
          status: currentSnapshot.lifecycle,
          cwd: currentSnapshot.cwd,
          ...(currentSnapshot.workspaceId ? { workspaceId: currentSnapshot.workspaceId } : {}),
          currentModeId: currentSnapshot.currentModeId,
          availableModes: currentSnapshot.availableModes,
          guidance,
          ...bindingResult,
        }),
      };
      return response;
    },
  );

  function getCreateToolProfile(profileId?: string) {
    if (!profileId) return undefined;
    const profile = daemonConfigStore?.get().agentProfiles?.find((entry) => entry.id === profileId);
    if (!profile) throw new PaseoToolInputError(`Unknown agent profile: ${profileId}`);
    return profile;
  }

  function resolveCreateToolProviderSettings(
    input: ResolvedCreateAgentToolArgs["parsedArgs"],
  ): Pick<
    CreateAgentFromMcpInput,
    "provider" | "config" | "resident" | "mode" | "thinking" | "providerOptions"
  > {
    const profile = getCreateToolProfile(input.profileId);
    const { provider: providerId, model } = selectCreateToolProvider(input.provider, profile);
    const providerProfile = providerId === profile?.provider ? profile : undefined;
    const inheritedConfig = resolveInheritedProviderConfig(providerId);
    return {
      provider: formatProviderModel(providerId, model),
      config: profile
        ? { ...inheritedConfig, model, systemPrompt: profile.rolePrompt }
        : inheritedConfig,
      resident: resolveCreateToolResidency(input, profile),
      mode: input.settings?.modeId ?? providerProfile?.modeId,
      thinking: input.settings?.thinkingOptionId ?? providerProfile?.thinkingOptionId,
      providerOptions: providerProfile
        ? {
            ...providerProfile.featureValues,
            ...providerProfile.options,
            ...input.settings?.features,
          }
        : input.settings?.features,
    };
  }

  function buildAdapterReadOnlyProviderOptions(
    adapter: string | null | undefined,
    existing: Record<string, unknown> | undefined,
  ): { supported: boolean; providerOptions?: Record<string, unknown> } {
    switch (adapter) {
      case "codex":
        return {
          supported: true,
          providerOptions: { ...existing, sandbox_mode: "read-only", approval_policy: "never" },
        };
      case "claude":
        return {
          supported: true,
          providerOptions: {
            ...existing,
            disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"],
          },
        };
      case "opencode":
        return {
          supported: true,
          providerOptions: {
            ...existing,
            permission: { edit: "deny", write: "deny", bash: "deny" },
          },
        };
      case "pi":
        return {
          supported: true,
          providerOptions: { ...existing, mainControlReadOnly: true },
        };
      default:
        return { supported: false, providerOptions: existing };
    }
  }

  function pickPeerReadOnlyMode(
    explicitMode: string | undefined,
    availableModeIds: ReadonlySet<string>,
    adapter: string | null | undefined,
  ): string | undefined {
    if (explicitMode) {
      if (availableModeIds.size > 0 && !availableModeIds.has(explicitMode)) {
        throw new PaseoToolInputError(
          `Read-only mode "${explicitMode}" is not supported by this provider.`,
        );
      }
      return explicitMode;
    }
    for (const candidate of ["read-only", "plan", "always-ask", "default"]) {
      if (availableModeIds.has(candidate)) return candidate;
    }
    if (availableModeIds.size === 0) {
      if (adapter === "codex") return "read-only";
      if (adapter === "claude") return "plan";
    }
    return undefined;
  }

  async function enforcePeerReadOnlyCreateSettings(
    input: ResolvedCreateAgentToolArgs["parsedArgs"],
    baseSettings: ReturnType<typeof resolveCreateToolProviderSettings>,
  ): Promise<ReturnType<typeof resolveCreateToolProviderSettings>> {
    if (
      isPeerExplicitModeDisallowed(baseSettings.mode) ||
      hasPeerDisallowedProviderOptions(baseSettings.providerOptions)
    ) {
      throw new PaseoToolInputError(
        "Cross-workspace peer messages are read-only (A0 READ) and cannot launch subagents with write-capable profiles, modes, or provider features.",
      );
    }
    const { provider: providerId } = selectCreateToolProvider(
      input.provider,
      getCreateToolProfile(input.profileId),
    );
    const adapter =
      typeof agentManager.adapterOf === "function"
        ? agentManager.adapterOf(providerId)
        : providerId;
    const callerCwd = callerAgentId ? agentManager.getAgent(callerAgentId)?.cwd : undefined;
    const snapshotEntry = callerCwd
      ? await providerSnapshotManager
          .getProvider({ cwd: callerCwd, provider: providerId, wait: false })
          .catch(() => null)
      : null;
    const availableModeIds = new Set((snapshotEntry?.modes ?? []).map((entry) => entry.id));
    const adapterRestrictions = buildAdapterReadOnlyProviderOptions(
      adapter,
      baseSettings.providerOptions,
    );
    const hasStrictReadOnlyMode = availableModeIds.has("read-only") || availableModeIds.has("plan");
    if (!adapterRestrictions.supported && !hasStrictReadOnlyMode) {
      throw new PaseoToolInputError(
        `Provider "${providerId}" does not support enforced read-only peer inspection subagents.`,
      );
    }
    return {
      ...baseSettings,
      mode: pickPeerReadOnlyMode(baseSettings.mode, availableModeIds, adapter),
      providerOptions: adapterRestrictions.providerOptions,
    };
  }

  function selectCreateToolProvider(
    provider: string | undefined,
    profile: ReturnType<typeof getCreateToolProfile>,
  ) {
    if (provider) return resolveRequiredProviderModel(provider);
    if (profile) return { provider: profile.provider, model: profile.model };
    throw new PaseoToolInputError("Provide provider/model or profileId.");
  }

  function resolveCreateToolResidency(
    input: ResolvedCreateAgentToolArgs["parsedArgs"],
    profile: ReturnType<typeof getCreateToolProfile>,
  ) {
    const hasPlaybook = "playbook" in input && input.playbook !== undefined;
    if (hasPlaybook && (input.resident || input.residentRole)) {
      throw new PaseoToolInputError("Orchestration playbook leads cannot be resident specialists.");
    }
    if (!hasPlaybook && (input.resident ?? profile?.defaultResident)) {
      if (!callerAgentId) {
        throw new PaseoToolInputError(
          "Resident specialists require a parent agent in an active workspace.",
        );
      }
      return { profileId: profile?.id, role: input.residentRole };
    }
    if (input.residentRole) {
      throw new PaseoToolInputError("residentRole requires resident: true or a resident profile.");
    }
  }

  type ResolvedCreateAgentToolArgs =
    | {
        kind: "agent-scoped";
        parsedArgs: AgentToAgentCreateAgentArgs | LegacyAgentToAgentCreateAgentArgs;
        workspaceId: string | undefined;
      }
    | {
        kind: "top-level";
        parsedArgs: TopLevelCreateAgentArgs | LegacyTopLevelCreateAgentArgs;
        detached: boolean;
        cwd: string | undefined;
        workspaceId: string | undefined;
      };

  interface LegacyPlacement {
    worktreeName?: unknown;
    branchName?: unknown;
    baseBranch?: unknown;
    refName?: unknown;
    githubPrNumber?: unknown;
    workspace?: { kind?: unknown; workspaceId?: unknown; source?: { kind?: unknown } };
    relationship?: { kind?: unknown };
    workspaceId?: unknown;
  }

  function hasWorktreePlacement(placement: LegacyPlacement): boolean {
    return (
      placement.workspace?.source?.kind === "worktree" ||
      [
        placement.worktreeName,
        placement.branchName,
        placement.baseBranch,
        placement.refName,
        placement.githubPrNumber,
      ].some((value) => value !== undefined)
    );
  }

  async function assertAgentCreatePlacement(placement: LegacyPlacement): Promise<void> {
    if (
      hasWorktreePlacement(placement) ||
      placement.workspace?.kind === "create" ||
      placement.workspace?.kind === "worktree" ||
      placement.relationship?.kind === "detached"
    ) {
      throw new PaseoToolInputError(AGENT_WORKSPACE_CREATION_ERROR);
    }
    const explicitWorkspace =
      placement.workspaceId ??
      (placement.workspace?.kind === "existing" ? placement.workspace.workspaceId : undefined);
    await requireCallerWorkspace(
      typeof explicitWorkspace === "string" ? explicitWorkspace : undefined,
    );
  }

  async function resolveCreateAgentToolArgs(args: unknown): Promise<ResolvedCreateAgentToolArgs> {
    if (!callerAgentId && args && hasWorktreePlacement(args as LegacyPlacement)) {
      throw new PaseoToolInputError(
        "Agent worktree placement was removed. Use create_workspace first, then create_agent with workspaceId.",
      );
    }
    if (callerAgentId) {
      if (hasLegacyCreateAgentPlacement(args)) {
        // COMPAT(nestedCreateAgentPlacement): accept the old relationship/workspace shape without
        // advertising it to models. Added in v0.2.0; remove after 2027-01-17.
        const parsed = parseToolArguments(legacyAgentToAgentCreateAgentArgsSchema, args);
        if (parsed.relationship.kind === "detached" || parsed.workspace.kind === "create") {
          throw new PaseoToolInputError(AGENT_WORKSPACE_CREATION_ERROR);
        }
        return {
          kind: "agent-scoped",
          parsedArgs: parsed,
          workspaceId:
            parsed.workspace.kind === "existing" ? parsed.workspace.workspaceId : undefined,
        };
      }
      const parsed = parseToolArguments(agentToAgentCreateAgentArgsSchema, args);
      return {
        kind: "agent-scoped",
        parsedArgs: parsed,
        workspaceId: parsed.workspaceId,
      };
    }
    if (hasLegacyCreateAgentPlacement(args)) {
      // COMPAT(nestedCreateAgentPlacement): see the agent-scoped branch above.
      const parsedArgs = normalizeTopLevelCreateAgentArgs(
        parseToolArguments(legacyTopLevelCreateAgentArgsSchema, args),
      );
      resolveCreateToolProviderSettings(parsedArgs);
      if (parsedArgs.relationship?.kind === "subagent") {
        throw new PaseoToolInputError(
          "relationship subagent requires an agent-scoped tool session",
        );
      }
      if (!parsedArgs.workspace) {
        throw new PaseoToolInputError("Legacy create_agent placement could not be resolved");
      }
      const { cwd, workspaceId } = await resolveCreateAgentWorkspace(parsedArgs.workspace, {
        prompt: parsedArgs.initialPrompt,
      });
      return {
        kind: "top-level",
        parsedArgs,
        detached: true,
        cwd,
        workspaceId,
      };
    }
    const parsedArgs = parseToolArguments(canonicalTopLevelCreateAgentArgsSchema, args);
    resolveCreateToolProviderSettings(parsedArgs);
    const { cwd, workspaceId } = await resolveCanonicalCreateAgentWorkspace(
      parsedArgs.workspaceId,
      { prompt: parsedArgs.initialPrompt },
    );
    return {
      kind: "top-level",
      parsedArgs,
      detached: false,
      cwd,
      workspaceId,
    };
  }

  function hasLegacyCreateAgentPlacement(args: unknown): boolean {
    if (!args || typeof args !== "object") {
      return false;
    }
    const input = args as Record<string, unknown>;
    return [
      "relationship",
      "workspace",
      "cwd",
      "worktreeName",
      "branchName",
      "baseBranch",
      "refName",
      "githubPrNumber",
    ].some((key) => input[key] !== undefined);
  }

  async function resolveCanonicalCreateAgentWorkspace(
    workspaceId?: string,
    firstAgentContext?: FirstAgentContext,
  ): Promise<{
    cwd: string | undefined;
    workspaceId: string | undefined;
  }> {
    if (workspaceId) {
      const resolved = await resolveCreateAgentWorkspace(
        { kind: "existing", workspaceId },
        undefined,
      );
      return { cwd: resolved.cwd, workspaceId };
    }
    if (!options.ensureWorkspaceForCreate) {
      throw new Error("Workspace creation is not configured");
    }
    const cwd = process.cwd();
    return {
      cwd,
      workspaceId: await options.ensureWorkspaceForCreate(
        cwd,
        firstAgentContext,
        workspaceBackgroundIntent(undefined),
      ),
    };
  }

  function normalizeTopLevelCreateAgentArgs(
    args: LegacyTopLevelCreateAgentArgs,
  ): LegacyTopLevelCreateAgentArgs {
    const { cwd, mode, thinking, features, ...canonicalCandidate } = args;
    const settings = {
      ...canonicalCandidate.settings,
      ...(mode ? { modeId: mode } : {}),
      ...(thinking ? { thinkingOptionId: thinking } : {}),
      ...(features ? { features } : {}),
    };

    if (canonicalCandidate.relationship && canonicalCandidate.workspace) {
      return parseToolArguments(legacyTopLevelCreateAgentArgsSchema, {
        ...canonicalCandidate,
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
      });
    }

    if (canonicalCandidate.relationship || canonicalCandidate.workspace) {
      throw new PaseoToolInputError("relationship and workspace must be provided together");
    }

    if (!cwd?.trim()) {
      throw new PaseoToolInputError("cwd is required for legacy top-level create_agent calls");
    }

    const workspace = {
      kind: "create" as const,
      source: { kind: "directory" as const, path: cwd },
    };

    return parseToolArguments(legacyTopLevelCreateAgentArgsSchema, {
      ...canonicalCandidate,
      relationship: { kind: "detached" },
      workspace,
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
    });
  }

  async function resolveCreateAgentWorkspace(
    workspace:
      | LegacyAgentToAgentCreateAgentArgs["workspace"]
      | NonNullable<LegacyTopLevelCreateAgentArgs["workspace"]>,
    firstAgentContext: FirstAgentContext | undefined,
  ): Promise<{
    cwd: string | undefined;
    workspaceId: string | undefined;
  }> {
    if (workspace.kind === "current") {
      throw new PaseoToolInputError("workspace current requires an agent-scoped tool session");
    }

    if (workspace.kind === "existing") {
      if (!options.workspaceRegistry && !options.listActiveWorkspaces) {
        throw new Error("Workspace lookup is not configured");
      }
      const existingWorkspace = await findActiveWorkspace(workspace.workspaceId);
      if (!existingWorkspace) {
        throw new PaseoToolInputError(`Workspace ${workspace.workspaceId} not found`);
      }
      const cwd = workspace.cwd
        ? resolveScopedCwd(workspace.cwd, { required: true })
        : existingWorkspace.cwd;
      const lockedCwd = callerContext?.lockedCwd?.trim();
      if (lockedCwd && !isSameOrDescendantPath(expandUserPath(lockedCwd), cwd)) {
        throw new PaseoToolInputError(
          `Workspace ${workspace.workspaceId} is outside the allowed cwd`,
        );
      }
      return {
        cwd,
        workspaceId: workspace.workspaceId,
      };
    }

    if (workspace.source.kind === "directory") {
      const cwd = resolveScopedCwd(workspace.source.path, { required: true });
      if (!options.ensureWorkspaceForCreate) {
        throw new Error("Workspace creation is not configured");
      }
      return {
        cwd,
        workspaceId: await options.ensureWorkspaceForCreate(
          cwd,
          firstAgentContext,
          workspaceBackgroundIntent(undefined),
        ),
      };
    }

    throw new PaseoToolInputError(
      "Use create_workspace first, then create_agent with workspaceId.",
    );
  }

  const PROMPTED_AGENT_NOTIFICATION_GUIDANCE =
    "You will get notified when the prompted agent finishes, errors, or needs permission. Do not poll for status; continue with other work until the notification arrives.";

  function queuedPromptResponse(
    agentId: string,
    messageId: string,
    notifying: boolean,
    activeTurnBehavior: AgentActiveTurnBehavior,
  ) {
    return {
      content: [],
      structuredContent: {
        success: true,
        deliveryStatus: "queued" as const,
        messageId,
        activeTurnBehavior,
        status: agentManager.getAgent(agentId)?.lifecycle ?? "idle",
        guidance: `${describeAgentMessage({
          activeTurnBehavior,
          running: agentManager.hasInFlightRun(agentId),
          canSteer: agentManager.canSteer(agentId),
        })}${notifying ? ` ${PROMPTED_AGENT_NOTIFICATION_GUIDANCE}` : ""}`,
      },
    };
  }

  async function enqueueLocalAgentPrompt(
    agentId: string,
    message: Omit<RecoverableAgentMessage, "messageId"> & { expectedWorkspaceId?: string | null },
    validateDispatch?: () => Promise<void>,
  ): Promise<string> {
    if (validateDispatch) {
      if (!options.queueAgentPromptAndWaitForDispatch) {
        throw new PaseoToolInputError("Task binding requires confirmed prompt dispatch.");
      }
      return options.queueAgentPromptAndWaitForDispatch(agentId, message, validateDispatch);
    }
    if (options.queueAgentPrompt) return options.queueAgentPrompt(agentId, message);
    const notification = message.notifyLocalCaller
      ? await finishSubscriptions().register(
          {
            childAgentId: agentId,
            callerAgentId: message.source.agentId,
            ...(message.directParent ? { requireParentOwnership: true } : {}),
            automaticParent: !!message.directParent && message.notifyOnFinish === undefined,
          },
          true,
        )
      : undefined;
    function rejectNotification(): void {
      void notification
        ?.reject()
        .catch((err) =>
          childLogger.error({ err, agentId }, "Failed to remove rejected finish subscription"),
        );
    }
    const parent = message.directParent;
    const expectedWorkspaceId = message.expectedWorkspaceId;
    const checkDispatchTarget =
      parent || expectedWorkspaceId !== undefined
        ? async () => {
            const target = await readHierarchyAgent(agentId);
            if (!message.unarchive && target?.archivedAt) {
              throw new PaseoToolInputError(`Agent ${agentId} is archived.`);
            }
            if (
              expectedWorkspaceId !== undefined &&
              (target?.workspaceId ?? null) !== expectedWorkspaceId &&
              Boolean(expectedWorkspaceId || target?.workspaceId)
            ) {
              throw new PaseoToolInputError("Target agent is no longer in the caller's workspace.");
            }
            if (parent) {
              assertDirectParent(target?.labels, parent.serverId, parent);
            }
          }
        : undefined;
    try {
      const receipt = agentMessages().enqueue({
        recipientId: agentId,
        prompt: message.prompt,
        source: { kind: "agent-message", ...message.source },
        sessionMode: message.sessionMode,
        unarchive: message.unarchive,
        validateDispatch: checkDispatchTarget,
        activeTurnBehavior: message.activeTurnBehavior,
        onDispatch: () => notification?.accept(),
      });
      void receipt.dispatched.catch(rejectNotification);
      return receipt.messageId;
    } catch (error) {
      rejectNotification();
      throw error;
    }
  }

  async function requireLocalPromptTarget(agentId: string, mainControl: boolean) {
    const live = agentManager.getAgent(agentId);
    const stored = mainControl || !live ? await agentStorage.get(agentId) : undefined;
    if (mainControl && stored?.archivedAt) {
      throw new PaseoToolInputError(`Agent ${agentId} is archived.`);
    }
    const target = live ?? stored;
    if (!target) throw new PaseoToolInputError(`Agent ${agentId} not found`);
    return target;
  }

  async function resolveLocalPromptSender(senderId: string) {
    const sender = resolveCallerAgent();
    const senderStored = sender ? undefined : await agentStorage.get(senderId);
    return {
      sender,
      senderWorkspaceId: sender?.workspaceId ?? senderStored?.workspaceId ?? null,
      mainControl: isMainControlAgentLabels(sender?.labels ?? senderStored?.labels),
    };
  }

  function assertSamePromptWorkspace(
    senderWorkspaceId: string | null,
    targetWorkspaceId: string | null | undefined,
  ): void {
    const targetWs = targetWorkspaceId ?? null;
    if (senderWorkspaceId !== targetWs && Boolean(senderWorkspaceId || targetWs)) {
      throw new PaseoToolInputError(
        "You can only send prompts to subagents in your current workspace. Use send_peer_message for cross-workspace read-only coordination.",
      );
    }
  }

  async function rollbackPeerDeltaAfterFailedEnqueue(
    undoDraft: (draft: PeerRuntimeMaps) => void,
    enqueueError: unknown,
  ): Promise<never> {
    try {
      await commitPeerStateTransaction(peerRuntime, undoDraft, countLocalHumanMessages);
    } catch (rollbackError) {
      invalidatePeerRuntimeCache(peerRuntime);
      childLogger.error(
        { err: rollbackError, enqueueError },
        "Failed to roll back persisted peer workspace state after enqueue failure",
      );
      throw new Error(
        `Failed to enqueue prompt (${
          enqueueError instanceof Error ? enqueueError.message : String(enqueueError)
        }) and failed to roll back persisted peer state`,
        { cause: rollbackError },
      );
    }
    throw enqueueError;
  }

  function prependPeerInspectionPrefix(
    prompt: AgentPromptInput,
    dispatchId: string,
  ): AgentPromptInput {
    const prefix = formatPeerInspectionPromptPrefix(dispatchId);
    if (typeof prompt === "string") {
      return `${prefix}${prompt}`;
    }
    return [{ type: "text", text: prefix }, ...prompt];
  }

  async function verifyQueuedPeerChildDispatchBoundary(params: {
    dispatchId: string;
    attemptId: string;
    senderAgentId: string;
    senderWorkspaceId: string | null;
    expectedRecipientId: string;
    recipientId: string;
    correlationId: string;
  }): Promise<void> {
    if (params.recipientId !== params.expectedRecipientId) {
      throw new PaseoToolInputError("Peer inspection subagent changed before dispatch.");
    }
    const sender = await readHierarchyAgent(params.senderAgentId);
    if (!sender || sender.archivedAt) {
      throw new PaseoToolInputError("Peer inspection parent session is unavailable at dispatch.");
    }
    assertSamePromptWorkspace(params.senderWorkspaceId, sender.workspaceId);
    const target = await readHierarchyAgent(params.recipientId);
    if (!target || target.archivedAt) {
      throw new PaseoToolInputError("Peer inspection subagent is unavailable at dispatch.");
    }
    assertSamePromptWorkspace(params.senderWorkspaceId, target.workspaceId);
    await assertEnforcedPeerReadOnlySubagent(params.recipientId);
    await recordPeerLockedChild(
      params.recipientId,
      params.correlationId,
      params.attemptId,
      params.dispatchId,
    );
  }

  async function stagePeerChildPromptDispatch(params: {
    senderId: string;
    targetId: string;
    senderWorkspaceId: string | null;
    requireParentOwnership: boolean;
    safePrompt: AgentPromptInput;
    correlationId: string;
  }): Promise<{
    dispatchId: string;
    guardedPrompt: AgentPromptInput;
    rollbackOnEnqueueFailure: (error: unknown) => Promise<never>;
  }> {
    const {
      senderId,
      targetId,
      senderWorkspaceId,
      requireParentOwnership,
      safePrompt,
      correlationId,
    } = params;
    const dispatchId = randomUUID();
    const expectedSenderServerId = requireParentOwnership ? options.serverId : undefined;
    const undoDraft = await withPeerStateMutex(peerRuntime, async () => {
      await flushPendingPeerOutcomesUnlocked();
      await assertEnforcedPeerReadOnlySubagent(targetId);
      return commitPeerStateTransaction(
        peerRuntime,
        (draft) => {
          const undoPending = setBoundedMapEntryWithUndo(
            draft.pendingChildDispatches,
            dispatchId,
            {
              dispatchId,
              senderAgentId: senderId,
              ...(expectedSenderServerId ? { senderServerId: expectedSenderServerId } : {}),
              senderWorkspaceId,
              recipientAgentId: targetId,
              correlationId,
              settled: false,
            },
            MAX_TRACKED_PEER_MESSAGES,
            (_k, entry) => entry.settled === true,
          );
          return (rollbackTarget: PeerRuntimeMaps) => {
            undoPending(rollbackTarget.pendingChildDispatches);
          };
        },
        countLocalHumanMessages,
      );
    });
    registerPromptDispatchVerifier(
      dispatchId,
      {
        kind: "peer-child",
        recipientId: targetId,
        senderAgentId: senderId,
        senderServerId: expectedSenderServerId,
      },
      (recipientId, attemptId) =>
        verifyQueuedPeerChildDispatchBoundary({
          dispatchId,
          attemptId,
          senderAgentId: senderId,
          senderWorkspaceId,
          expectedRecipientId: targetId,
          recipientId,
          correlationId,
        }),
      (outcome, context) => handlePeerDispatchOutcome(dispatchId, outcome, context),
    );
    return {
      dispatchId,
      guardedPrompt: prependPeerInspectionPrefix(safePrompt, dispatchId),
      rollbackOnEnqueueFailure: (enqueueError) => {
        releasePromptDispatchVerifier(dispatchId);
        return withPeerStateMutex(peerRuntime, () =>
          rollbackPeerDeltaAfterFailedEnqueue(undoDraft, enqueueError),
        );
      },
    };
  }

  async function sendLocalAgentPrompt(
    senderId: string,
    {
      agentId,
      prompt,
      sessionMode,
      requireParentOwnership,
      notifyOnFinish,
      activeTurnBehavior,
    }: z.infer<z.ZodObject<typeof commonSendAgentPromptInputSchema>> & {
      requireParentOwnership: boolean;
      notifyOnFinish?: boolean;
      activeTurnBehavior?: AgentActiveTurnBehavior;
    },
    taskBinding?: Awaited<ReturnType<typeof prepareTaskBinding>>,
  ) {
    await ensurePeerRuntimeLoaded(peerRuntime);
    const { sender, senderWorkspaceId, mainControl } = await resolveLocalPromptSender(senderId);
    const target = await requireLocalPromptTarget(agentId, mainControl);
    assertSamePromptWorkspace(senderWorkspaceId, target.workspaceId);
    if (taskBinding && !requireParentOwnership) {
      throw new PaseoToolInputError("Task binding requires a local direct subagent.");
    }
    await taskBinding?.validateDispatch(agentId);
    taskBinding?.prepareRecipient(agentId);
    const notifying = notifyOnFinish ?? !isExplicitParentReportingLabels(target.labels);
    const safePrompt = neutralizePeerWorkspacePromptMarker(prompt);
    const activePeerTurn = getActivePeerTurnContext(senderId);
    let guardedPrompt: AgentPromptInput = safePrompt;
    let stagedPeerChild: Awaited<ReturnType<typeof stagePeerChildPromptDispatch>> | undefined;
    if (activePeerTurn) {
      const [correlationId] = activePeerTurn.correlationIds;
      if (!correlationId) {
        throw new PaseoToolInputError("Peer inspection turn is missing correlation context.");
      }
      stagedPeerChild = await stagePeerChildPromptDispatch({
        senderId,
        targetId: agentId,
        senderWorkspaceId,
        requireParentOwnership,
        safePrompt,
        correlationId,
      });
      guardedPrompt = stagedPeerChild.guardedPrompt;
    }
    const behavior = stagedPeerChild ? "queue" : (activeTurnBehavior ?? "queue");
    const enqueue = () =>
      enqueueLocalAgentPrompt(
        agentId,
        {
          prompt: guardedPrompt,
          source: {
            agentId: senderId,
            serverId: requireParentOwnership ? options.serverId : undefined,
            title: sender?.config.title ?? undefined,
          },
          directParent: requireParentOwnership
            ? { agentId: senderId, serverId: options.serverId ?? "self" }
            : undefined,
          expectedWorkspaceId: senderWorkspaceId,
          sessionMode,
          activeTurnBehavior: behavior,
          ...(behavior === "steer" ? { immediateSteer: true } : {}),
          unarchive: !mainControl,
          notifyLocalCaller: notifying,
          notifyOnFinish,
        },
        taskBinding ? () => taskBinding.validateDispatch(agentId) : undefined,
      );
    let messageId: string;
    try {
      messageId = await (taskBinding ? taskBinding.run(enqueue) : enqueue());
    } catch (error) {
      if (stagedPeerChild) {
        return await stagedPeerChild.rollbackOnEnqueueFailure(error);
      }
      throw error;
    }
    if (!taskBinding) return queuedPromptResponse(agentId, messageId, notifying, behavior);
    return {
      content: [],
      structuredContent: {
        success: true,
        deliveryStatus: "dispatched" as const,
        messageId,
        status: agentManager.getAgent(agentId)?.lifecycle ?? "idle",
        guidance: notifying ? PROMPTED_AGENT_NOTIFICATION_GUIDANCE : "Dispatch acknowledged.",
        ...(await taskBinding.record(agentId, messageId)),
      },
    };
  }

  registerTool(
    "send_agent_prompt",
    {
      title: "Send agent prompt",
      description:
        scope === "agent"
          ? "Send a message to another agent. The response returns at once. Its guidance says whether the message waits for the running turn to end, joins it, or interrupts it, and how to deliver a waiting message now. Leave activeTurnBehavior out unless the message cannot wait. The recipient reads your messages in the order you sent them. Stop holds messages that have not reached the provider until the next prompt. Completion reports include the target’s last response by default. Paseo supplies caller identity."
          : "Send a prompt to an agent. A running turn is interrupted unless activeTurnBehavior is steer.",
      inputSchema: sendAgentPromptInputSchema,
      outputSchema: {
        success: z.boolean(),
        disposition: z.enum(["turn_started", "out_of_band", "steered"]).optional(),
        deliveryStatus: z.enum(["queued", "dispatched"]).optional(),
        messageId: z.string().optional(),
        activeTurnBehavior: AgentActiveTurnBehaviorSchema.optional(),
        status: AgentStatusEnum,
        guidance: z.string().optional(),
        taskId: z.string().optional(),
        taskBindingError: z.string().optional(),
      },
    },
    async ({
      agentId,
      prompt,
      sessionMode,
      requireParentOwnership,
      notifyOnFinish,
      taskBinding: taskBindingInput,
      activeTurnBehavior,
    }) => {
      const taskBinding = taskBindingInput ? await prepareTaskBinding(taskBindingInput) : undefined;
      if (callerAgentId) {
        return sendLocalAgentPrompt(
          callerAgentId,
          {
            agentId,
            prompt,
            sessionMode,
            requireParentOwnership,
            notifyOnFinish,
            activeTurnBehavior,
          },
          taskBinding,
        ).finally(() => taskBinding?.close());
      }
      if (activeTurnBehavior === "queue") {
        throw new PaseoToolInputError('activeTurnBehavior "queue" needs an agent caller');
      }
      const dispatch = await sendPromptToAgent({
        agentMessages: agentMessages(),
        agentManager,
        agentStorage,
        agentId,
        prompt,
        sessionMode,
        activeTurnBehavior,
        logger: childLogger,
      }).catch((error) => {
        if (error instanceof AgentNotFoundError) {
          throw new PaseoToolInputError(error.message);
        }
        throw error;
      });

      // Return once the provider has accepted the turn, so the status reports it running.
      const { disposition } = dispatch;
      if (dispatch.disposition === "turn_started") {
        await waitForAgentRunStartWithTimeout(agentManager, agentId, dispatch.started);
      }
      const currentSnapshot = agentManager.getAgent(agentId);

      const responseData = {
        success: true,
        disposition,
        status: currentSnapshot?.lifecycle ?? "idle",
        guidance:
          "Dispatch acknowledged. Observe completion using get_agent_status/get_agent_activity or SDK/RPC subscriptions and wait APIs.",
      };
      const validJson = ensureValidJson(responseData);

      const response = {
        content: [],
        structuredContent: validJson,
      };
      return response;
    },
  );

  const sendPeerMessageInputSchema = z
    .object({
      targetWorkspaceId: z
        .string()
        .trim()
        .min(1)
        .describe(
          "Destination workspace ID from list_workspaces (must differ from your current workspace).",
        ),
      targetAgentId: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Optional target top-level root session ID when the destination workspace has no active Main Control agent, or when replying to a root sender.",
        ),
      intent: PeerMessageIntentSchema.describe(
        '"query" or "align" to initiate a read-only cross-workspace request (Main Control only); "reply" to answer an inbound peer message.',
      ),
      correlationId: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'Thread correlation ID. Omit to start a new thread; required when intent is "reply".',
        ),
      expectReply: z
        .boolean()
        .optional()
        .describe(
          'Whether the recipient should send one reply. Defaults to true for "query"/"align" while a reply hop remains. Omit or set false on the last hop or for "reply".',
        ),
      maxHops: z
        .number()
        .int()
        .min(1)
        .max(MAX_ALLOWED_PEER_HOPS)
        .optional()
        .describe(
          `Maximum total hops allowed on a new correlationId thread (default ${DEFAULT_MAX_PEER_HOPS}, max ${MAX_ALLOWED_PEER_HOPS}).`,
        ),
      subject: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .optional()
        .describe("Concise subject line (<= 120 chars)."),
      message: z
        .string()
        .trim()
        .min(1)
        .max(8192)
        .describe("Read-only inquiry, protocol alignment note, or reply body (<= 8192 chars)."),
      taskId: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Optional task ID in your own workspace task ledger for local reference."),
    })
    .strict();

  interface PeerTargetCandidate {
    id: string;
    workspaceId?: string;
    labels?: Record<string, string>;
    archivedAt?: string | null;
    internal: boolean;
    background: boolean;
    title?: string;
  }

  function toStoredPeerCandidate(stored: StoredAgentRecord): PeerTargetCandidate {
    return {
      id: stored.id,
      workspaceId: stored.workspaceId,
      labels: stored.labels,
      archivedAt: stored.archivedAt,
      internal: Boolean(stored.internal),
      background: Boolean(stored.background),
      title: resolveReportTitle(stored.id, stored.title),
    };
  }

  function mergeLivePeerCandidate(
    live: ManagedAgent,
    prev: PeerTargetCandidate | undefined,
  ): PeerTargetCandidate {
    return {
      id: live.id,
      workspaceId: live.workspaceId ?? prev?.workspaceId,
      labels: live.labels,
      archivedAt: prev?.archivedAt ?? null,
      internal: Boolean(live.internal || prev?.internal),
      background: Boolean(live.background || prev?.background),
      title: resolveReportTitle(live.id, prev?.title, live.config.title),
    };
  }

  function isEligiblePeerRootCandidate(
    candidate: PeerTargetCandidate,
    targetWorkspaceId: string,
  ): boolean {
    return (
      candidate.workspaceId === targetWorkspaceId &&
      !candidate.archivedAt &&
      !candidate.internal &&
      !candidate.background &&
      !isSideChatAgent(candidate) &&
      !getParentAgentIdFromLabels(candidate.labels)
    );
  }

  async function readExplicitPeerCandidate(id: string): Promise<PeerTargetCandidate | undefined> {
    const stored = await agentStorage.get(id);
    const live = agentManager.getAgent(id);
    if (!stored && !live) return undefined;
    const base = stored ? toStoredPeerCandidate(stored) : undefined;
    return live ? mergeLivePeerCandidate(live, base) : base;
  }

  async function listEligiblePeerTargets(
    targetWorkspaceId: string,
    explicitTargetId?: string,
  ): Promise<PeerTargetCandidate[]> {
    const liveList = agentManager.listAgents();
    const storedList =
      typeof agentStorage.listByWorkspaces === "function"
        ? await agentStorage.listByWorkspaces([targetWorkspaceId])
        : [];
    const byId = new Map<string, PeerTargetCandidate>();
    for (const stored of storedList) {
      byId.set(stored.id, toStoredPeerCandidate(stored));
    }
    for (const live of liveList) {
      if (live.workspaceId !== targetWorkspaceId) continue;
      byId.set(live.id, mergeLivePeerCandidate(live, byId.get(live.id)));
    }
    if (explicitTargetId && !byId.has(explicitTargetId)) {
      const explicit = await readExplicitPeerCandidate(explicitTargetId);
      if (explicit) byId.set(explicitTargetId, explicit);
    }
    return [...byId.values()].filter((candidate) =>
      isEligiblePeerRootCandidate(candidate, targetWorkspaceId),
    );
  }

  type SendPeerMessageInput = z.infer<typeof sendPeerMessageInputSchema>;

  async function inspectPeerCallerSessionState(callerId: string) {
    const path = await readAgentHierarchyPath(callerId, readHierarchyAgent);
    const caller = path.get(callerId);
    const liveCaller = agentManager.getAgent(callerId);
    const storedCaller = await agentStorage.get(callerId);
    const unavailable =
      !caller ||
      Boolean(caller.archivedAt || storedCaller?.archivedAt) ||
      Boolean(liveCaller?.internal || storedCaller?.internal) ||
      Boolean(liveCaller?.background || storedCaller?.background) ||
      isSideChatAgent(caller);
    if (unavailable) {
      throw new PaseoToolInputError("Caller session is unavailable for peer messaging.");
    }
    if (computeAgentDepth(callerId, (id) => path.get(id)) > 0) {
      throw new PaseoToolInputError(
        "Subagents cannot send cross-workspace peer messages. Report to your parent agent so Main Control can coordinate across workspaces.",
      );
    }
    return {
      liveCaller,
      storedCaller,
      callerIsMainControl: isMainControlAgentLabels(caller.labels),
    };
  }

  async function requirePeerCallerSession(callerId: string) {
    if (options.verifiedCallerAgentId !== undefined && options.verifiedCallerAgentId !== callerId) {
      throw new PaseoToolInputError(
        "Cross-workspace peer messaging requires a verified agent identity.",
      );
    }
    return inspectPeerCallerSessionState(callerId);
  }

  async function resolvePeerWorkspaces(
    sourceWorkspaceId: string | undefined,
    targetWorkspaceId: string,
  ) {
    if (!options.workspaceRegistry) {
      throw new Error("Workspace registry is not configured");
    }
    if (!sourceWorkspaceId) {
      throw new PaseoToolInputError("Caller agent does not belong to an active workspace.");
    }
    const sourceWorkspace = await options.workspaceRegistry.get(sourceWorkspaceId);
    if (!sourceWorkspace || sourceWorkspace.archivedAt) {
      throw new PaseoToolInputError("Caller workspace is unavailable.");
    }
    if (targetWorkspaceId === sourceWorkspaceId) {
      throw new PaseoToolInputError(
        "Target workspace must differ from your current workspace. Use send_agent_prompt for direct subagents in your own workspace.",
      );
    }
    const targetWorkspace = await options.workspaceRegistry.get(targetWorkspaceId);
    if (!targetWorkspace || targetWorkspace.archivedAt) {
      throw new PaseoToolInputError(`Target workspace ${targetWorkspaceId} not found`);
    }
    const lockedCwd = callerContext?.lockedCwd?.trim();
    if (lockedCwd && !isSameOrDescendantPath(expandUserPath(lockedCwd), targetWorkspace.cwd)) {
      throw new PaseoToolInputError(`Workspace ${targetWorkspaceId} is outside the allowed cwd`);
    }
    return { sourceWorkspaceId, sourceWorkspace, targetWorkspace };
  }

  function reserveNextPeerHop(state: PeerRuntimeMaps, thread: PeerThreadState): number {
    const { correlationId, maxHops } = thread;
    let highest = Math.max(
      thread.hop,
      thread.confirmedSnapshot?.hop ?? 0,
      thread.highestUnknownSnapshot?.hop ?? 0,
    );
    for (const entry of state.byMessageId.values()) {
      if (entry.correlationId === correlationId) highest = Math.max(highest, entry.hop);
    }
    if (highest >= maxHops) {
      throw new PaseoToolInputError(`Peer thread ${correlationId} exceeded maxHops (${maxHops}).`);
    }
    return highest + 1;
  }

  function resolvePeerReplyStep(params: {
    rawInput: SendPeerMessageInput;
    callerId: string;
    callerIsMainControl: boolean;
    sourceWorkspaceId: string;
    targetWorkspaceId: string;
    state: PeerRuntimeMaps;
  }) {
    const { rawInput, callerId, callerIsMainControl, sourceWorkspaceId, targetWorkspaceId } =
      params;
    if (!rawInput.correlationId) {
      throw new PaseoToolInputError('correlationId is required when intent is "reply".');
    }
    if (rawInput.expectReply === true) {
      throw new PaseoToolInputError("Replies must converge with expectReply: false.");
    }
    const correlationId = rawInput.correlationId;
    const trackedThread = params.state.threads.get(correlationId);
    const confirmedSnap = trackedThread?.confirmedSnapshot;
    if (!trackedThread || !confirmedSnap || !confirmedSnap.admitted) {
      throw new PaseoToolInputError(`Unknown or unauthorized peer correlationId: ${correlationId}`);
    }
    const inboundThread: PeerThreadState = {
      ...deserializeBasePeerThread(confirmedSnap),
      confirmedSnapshot: cloneBaseThreadSnapshot(confirmedSnap),
    };
    if (!isSameWorkspacePair(inboundThread, sourceWorkspaceId, targetWorkspaceId)) {
      throw new PaseoToolInputError(`Unknown or unauthorized peer correlationId: ${correlationId}`);
    }
    if (inboundThread.lastSourceWorkspaceId === sourceWorkspaceId) {
      throw new PaseoToolInputError(
        `Peer thread ${correlationId} already sent a reply or the latest confirmed hop was outbound.`,
      );
    }
    if (inboundThread.lastTargetAgentId !== callerId && !callerIsMainControl) {
      throw new PaseoToolInputError(`Unknown or unauthorized peer correlationId: ${correlationId}`);
    }
    if (!inboundThread.expectReply) {
      throw new PaseoToolInputError(
        `Peer thread ${correlationId} does not expect a reply (reply convergence reached).`,
      );
    }
    const replyAlreadyRecorded =
      inboundThread.repliedHops.has(inboundThread.hop) ||
      trackedThread.repliedHops.has(inboundThread.hop);
    if (replyAlreadyRecorded) {
      throw new PaseoToolInputError(
        `Peer thread ${correlationId} already sent a reply for hop ${inboundThread.hop}.`,
      );
    }
    const effectiveMaxHops = trackedThread.maxHops;
    if (rawInput.maxHops !== undefined && rawInput.maxHops !== effectiveMaxHops) {
      throw new PaseoToolInputError("maxHops cannot be changed on an existing peer thread.");
    }
    return {
      correlationId,
      nextHop: reserveNextPeerHop(params.state, trackedThread),
      effectiveMaxHops,
      effectiveExpectReply: false,
      inboundThread,
    };
  }

  function isSameWorkspacePair(
    thread: PeerThreadState,
    sourceWorkspaceId: string,
    targetWorkspaceId: string,
  ): boolean {
    const forward =
      thread.lastSourceWorkspaceId === sourceWorkspaceId &&
      thread.lastTargetWorkspaceId === targetWorkspaceId;
    const reverse =
      thread.lastSourceWorkspaceId === targetWorkspaceId &&
      thread.lastTargetWorkspaceId === sourceWorkspaceId;
    return forward || reverse;
  }

  function resolvePeerInitiationStep(params: {
    rawInput: SendPeerMessageInput;
    callerIsMainControl: boolean;
    sourceWorkspaceId: string;
    targetWorkspaceId: string;
    state: PeerRuntimeMaps;
  }) {
    const { rawInput, callerIsMainControl, sourceWorkspaceId, targetWorkspaceId } = params;
    if (!callerIsMainControl) {
      throw new PaseoToolInputError(
        'Only Workspace Main Control agents can initiate cross-workspace "query" or "align" messages.',
      );
    }
    const correlationId = rawInput.correlationId ?? `peer_${randomUUID()}`;
    const existing = params.state.threads.get(correlationId);
    if (existing && !isSameWorkspacePair(existing, sourceWorkspaceId, targetWorkspaceId)) {
      throw new PaseoToolInputError(
        `Peer correlationId ${correlationId} belongs to another workspace pair.`,
      );
    }
    if (existing && rawInput.maxHops !== undefined && rawInput.maxHops !== existing.maxHops) {
      throw new PaseoToolInputError("maxHops cannot be changed on an existing peer thread.");
    }
    const nextHop = existing ? reserveNextPeerHop(params.state, existing) : 1;
    const effectiveMaxHops = existing?.maxHops ?? rawInput.maxHops ?? DEFAULT_MAX_PEER_HOPS;
    const hasReplyHop = nextHop < effectiveMaxHops;
    if (!hasReplyHop && rawInput.expectReply === true) {
      throw new PaseoToolInputError(
        `Peer hop ${nextHop} of ${effectiveMaxHops} leaves no room for a reply. Omit expectReply or set expectReply: false.`,
      );
    }
    return {
      correlationId,
      nextHop,
      effectiveMaxHops,
      effectiveExpectReply: rawInput.expectReply ?? hasReplyHop,
      inboundThread: existing,
    };
  }

  function resolvePeerStep(params: Parameters<typeof resolvePeerReplyStep>[0]) {
    return params.rawInput.intent === "reply"
      ? resolvePeerReplyStep(params)
      : resolvePeerInitiationStep(params);
  }

  function selectPeerReplyTarget(
    eligibleTargets: PeerTargetCandidate[],
    targetMain: PeerTargetCandidate | undefined,
    targetWorkspaceId: string,
    targetAgentId: string | undefined,
    inboundThread: PeerThreadState,
  ): PeerTargetCandidate {
    const desiredId = targetAgentId ?? inboundThread.lastSourceAgentId;
    const resolved =
      eligibleTargets.find((candidate) => candidate.id === desiredId) ??
      (!targetAgentId ? targetMain : undefined);
    if (!resolved) {
      throw new PaseoToolInputError(
        `Peer reply recipient ${desiredId} is unavailable in workspace ${targetWorkspaceId}.`,
      );
    }
    const validExplicit =
      !targetAgentId ||
      targetAgentId === inboundThread.lastSourceAgentId ||
      targetAgentId === targetMain?.id;
    if (!validExplicit) {
      throw new PaseoToolInputError(
        `Peer reply targetAgentId must match the thread sender (${inboundThread.lastSourceAgentId}) or active Main Control.`,
      );
    }
    return resolved;
  }

  function selectPeerTargetAgent(params: {
    intent: SendPeerMessageInput["intent"];
    eligibleTargets: PeerTargetCandidate[];
    targetWorkspaceId: string;
    targetAgentId?: string;
    inboundThread?: PeerThreadState;
  }): PeerTargetCandidate {
    const { intent, eligibleTargets, targetWorkspaceId, targetAgentId, inboundThread } = params;
    const targetMain = eligibleTargets.find((candidate) =>
      isMainControlAgentLabels(candidate.labels),
    );
    if (intent === "reply" && inboundThread) {
      return selectPeerReplyTarget(
        eligibleTargets,
        targetMain,
        targetWorkspaceId,
        targetAgentId,
        inboundThread,
      );
    }
    if (targetMain) {
      if (targetAgentId && targetAgentId !== targetMain.id) {
        throw new PaseoToolInputError(
          `Workspace ${targetWorkspaceId} has an active Main Control agent (${targetMain.id}). Route cross-workspace peer messages to Main Control.`,
        );
      }
      return targetMain;
    }
    if (!targetAgentId) {
      throw new PaseoToolInputError(
        `Workspace ${targetWorkspaceId} has no active Main Control agent. Pass targetAgentId for the user-specified top-level root session.`,
      );
    }
    const resolved = eligibleTargets.find((candidate) => candidate.id === targetAgentId);
    if (!resolved) {
      throw new PaseoToolInputError(
        `Target agent ${targetAgentId} is unavailable or is not an active top-level root session in workspace ${targetWorkspaceId}.`,
      );
    }
    return resolved;
  }

  async function validateLocalPeerTaskId(
    taskId: string | undefined,
    callerIsMainControl: boolean,
    sourceWorkspaceId: string,
  ): Promise<void> {
    if (!taskId) return;
    if (!callerIsMainControl || !taskLedger) {
      throw new PaseoToolInputError(
        "Workspace task references require Main Control with an active task ledger.",
      );
    }
    const tasks = await taskLedger.list(sourceWorkspaceId);
    if (!tasks.some((entry) => entry.taskId === taskId)) {
      throw new PaseoToolInputError(`Task ${taskId} does not exist in your workspace.`);
    }
  }

  function buildPeerApprovalPendingResult(params: {
    correlationId: string;
    hop: number;
    maxHops: number;
    expectReply: boolean;
    targetWorkspaceId: string;
    targetAgentId: string;
    approvalRequestId: string;
    taskId?: string;
    guidance: string;
  }): PaseoToolResult {
    return {
      content: [],
      structuredContent: ensureValidJson({
        success: false,
        deliveryStatus: "awaiting_approval",
        correlationId: params.correlationId,
        hop: params.hop,
        maxHops: params.maxHops,
        expectReply: params.expectReply,
        targetWorkspaceId: params.targetWorkspaceId,
        targetAgentId: params.targetAgentId,
        approvalRequestId: params.approvalRequestId,
        ...(params.taskId ? { taskId: params.taskId } : {}),
        guidance: params.guidance,
      }),
    };
  }

  async function findLatestPeerDurableAuth(sourceWorkspaceId: string, authPrefix: string) {
    if (!options.durableItems || !options.serverId) {
      throw new PaseoToolInputError(
        `Cross-workspace peer messaging requires workspace pairing or human authorization.`,
      );
    }
    const listed = await options.durableItems.list({
      serverId: options.serverId,
      workspaceId: sourceWorkspaceId,
      limit: 100,
    });
    return listed.items.findLast(
      (item) =>
        item.kind === "authorization" &&
        (item.requestId === authPrefix || item.requestId.startsWith(`${authPrefix}:`)),
    );
  }

  function computePeerPolicyFingerprint(params: {
    sourceWorkspace: PersistedWorkspaceRecord;
    targetWorkspace: PersistedWorkspaceRecord;
    sourceUntrusted: boolean;
    targetUntrusted: boolean;
    resolvedTarget: PeerTargetCandidate;
  }): string {
    const targetIsMain = isMainControlAgentLabels(params.resolvedTarget.labels);
    const material = {
      sourceUntrusted: params.sourceUntrusted,
      targetUntrusted: params.targetUntrusted,
      sourceOptOut: workspaceRequiresPeerApproval(params.sourceWorkspace),
      targetOptOut: workspaceRequiresPeerApproval(params.targetWorkspace),
      allowLocal: options.crossWorkspacePeerPolicy?.allowLocalPeerMessages ?? true,
      targetScope: targetIsMain ? "main" : `agent:${params.resolvedTarget.id}`,
      sourceTrustedPeers: [...readWorkspaceTrustedPeers(params.sourceWorkspace)].sort(),
      targetTrustedPeers: [...readWorkspaceTrustedPeers(params.targetWorkspace)].sort(),
      targetTrustedAgents: [...readWorkspaceTrustedTargetAgents(params.targetWorkspace)].sort(),
    };
    return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 12);
  }

  async function isPeerDurableApprovalGranted(
    sourceWorkspace: PersistedWorkspaceRecord,
    targetWorkspace: PersistedWorkspaceRecord,
    resolvedTarget: PeerTargetCandidate,
    sourceUntrusted: boolean,
    targetUntrusted: boolean,
  ): Promise<boolean> {
    if (!options.durableItems || !options.serverId) return false;
    const policyHash = computePeerPolicyFingerprint({
      sourceWorkspace,
      targetWorkspace,
      sourceUntrusted,
      targetUntrusted,
      resolvedTarget,
    });
    const authPrefix = `peer-auth:${sourceWorkspace.workspaceId}:${targetWorkspace.workspaceId}:${policyHash}`;
    const latestAuth = await findLatestPeerDurableAuth(sourceWorkspace.workspaceId, authPrefix);
    return latestAuth?.status === "decided" && latestAuth.decision === "approve";
  }

  async function requestOrReadPeerDurableApproval(params: {
    callerId: string;
    sourceWorkspace: PersistedWorkspaceRecord;
    targetWorkspace: PersistedWorkspaceRecord;
    resolvedTarget: PeerTargetCandidate;
    sourceUntrusted: boolean;
    targetUntrusted: boolean;
    rawInput: SendPeerMessageInput;
    correlationId: string;
    nextHop: number;
    effectiveMaxHops: number;
    effectiveExpectReply: boolean;
  }): Promise<{ admitted: true } | { admitted: false; response: PaseoToolResult }> {
    const { sourceWorkspace, targetWorkspace, resolvedTarget } = params;
    const sourceWorkspaceId = sourceWorkspace.workspaceId;
    const targetWorkspaceId = targetWorkspace.workspaceId;
    const policyHash = computePeerPolicyFingerprint({
      sourceWorkspace,
      targetWorkspace,
      sourceUntrusted: params.sourceUntrusted,
      targetUntrusted: params.targetUntrusted,
      resolvedTarget,
    });
    const authPrefix = `peer-auth:${sourceWorkspaceId}:${targetWorkspaceId}:${policyHash}`;
    const latestAuth = await findLatestPeerDurableAuth(sourceWorkspaceId, authPrefix);
    if (latestAuth?.status === "decided") {
      if (latestAuth.decision === "approve") return { admitted: true };
      throw new PaseoToolInputError(
        `Cross-workspace peer messaging to workspace ${targetWorkspaceId} was rejected by the user.`,
      );
    }
    if (latestAuth?.status === "pending") {
      return {
        admitted: false,
        response: buildPeerApprovalPendingResult({
          correlationId: params.correlationId,
          hop: params.nextHop,
          maxHops: params.effectiveMaxHops,
          expectReply: params.effectiveExpectReply,
          targetWorkspaceId,
          targetAgentId: resolvedTarget.id,
          approvalRequestId: latestAuth.requestId,
          taskId: params.rawInput.taskId,
          guidance: `Cross-workspace peer messaging to ${targetWorkspaceId} is awaiting human authorization (${latestAuth.requestId}). End your turn and wait for approval.`,
        }),
      };
    }
    if (sourceWorkspace.background || !options.durableItems || !options.serverId) {
      throw new PaseoToolInputError(
        `Cross-workspace peer messaging between ${sourceWorkspaceId} and ${targetWorkspaceId} requires workspace pairing or human authorization.`,
      );
    }
    const sourceTurnId = reportTurnId(params.callerId) ?? `peer-turn:${params.correlationId}`;
    const requestId = latestAuth ? `${authPrefix}:${randomUUID().slice(0, 8)}` : authPrefix;
    const targetDisplayName = resolveWorkspaceDisplayName(targetWorkspace);
    const subjectLine = params.rawInput.subject ? `\nSubject: ${params.rawInput.subject}` : "";
    const created = await options.durableItems.create({
      serverId: options.serverId,
      workspaceId: sourceWorkspaceId,
      requestId,
      sourceAgentId: params.callerId,
      sourceTurnId,
      kind: "authorization",
      title: `Allow cross-workspace peer messaging to ${targetDisplayName}`,
      summary: `Target workspace: ${targetDisplayName} (${targetWorkspaceId})\nTarget session: ${resolvedTarget.id}\nIntent: ${params.rawInput.intent}${subjectLine}`,
      evidence: [],
    });
    return {
      admitted: false,
      response: buildPeerApprovalPendingResult({
        correlationId: params.correlationId,
        hop: params.nextHop,
        maxHops: params.effectiveMaxHops,
        expectReply: params.effectiveExpectReply,
        targetWorkspaceId,
        targetAgentId: resolvedTarget.id,
        approvalRequestId: created.requestId,
        taskId: params.rawInput.taskId,
        guidance: `Created authorization request ${created.requestId} for cross-workspace peer messaging to ${targetWorkspaceId}. End your turn and wait for user approval.`,
      }),
    };
  }

  async function isWorkspaceUntrusted(workspace: PersistedWorkspaceRecord): Promise<boolean> {
    if (workspace.untrustedSource) return true;
    return Boolean(await options.isCheckoutUntrusted?.(workspace.cwd));
  }

  function evaluatePeerFastAdmission(params: {
    sourceWorkspace: PersistedWorkspaceRecord;
    targetWorkspace: PersistedWorkspaceRecord;
    sourceUntrusted: boolean;
    targetUntrusted: boolean;
    resolvedTarget: PeerTargetCandidate;
    intent: SendPeerMessageInput["intent"];
    inboundThread?: PeerThreadState;
  }): boolean {
    const { sourceWorkspace, targetWorkspace, resolvedTarget, intent } = params;
    if (params.sourceUntrusted || params.targetUntrusted) return false;
    if (
      workspaceRequiresPeerApproval(sourceWorkspace) ||
      workspaceRequiresPeerApproval(targetWorkspace)
    ) {
      return false;
    }
    if (intent !== "reply" && !isMainControlAgentLabels(resolvedTarget.labels)) {
      if (!readWorkspaceTrustedTargetAgents(targetWorkspace).has(resolvedTarget.id)) {
        return false;
      }
    }
    if (intent === "reply" && params.inboundThread?.admitted) return true;
    const mutuallyPaired =
      readWorkspaceTrustedPeers(sourceWorkspace).has(targetWorkspace.workspaceId) &&
      readWorkspaceTrustedPeers(targetWorkspace).has(sourceWorkspace.workspaceId);
    if (mutuallyPaired) return true;
    return options.crossWorkspacePeerPolicy?.allowLocalPeerMessages ?? true;
  }

  async function assertSenderAuthorizedAtDispatch(params: {
    callerId: string;
    sourceWorkspaceId: string;
    intent: SendPeerMessageInput["intent"];
    inboundThread?: PeerThreadState;
    senderAgentId?: string;
    senderServerId?: string;
    expectedServerId?: string;
  }): Promise<void> {
    if (params.senderAgentId !== undefined && params.senderAgentId !== params.callerId) {
      throw new PaseoToolInputError("Peer message sender identity changed before dispatch.");
    }
    if (
      params.senderServerId !== undefined &&
      params.senderServerId !== (params.expectedServerId ?? options.serverId)
    ) {
      throw new PaseoToolInputError("Peer message sender server changed before dispatch.");
    }
    const { liveCaller, storedCaller, callerIsMainControl } = await inspectPeerCallerSessionState(
      params.callerId,
    );
    const currentWorkspaceId = liveCaller?.workspaceId ?? storedCaller?.workspaceId;
    if (currentWorkspaceId !== params.sourceWorkspaceId) {
      throw new PaseoToolInputError(
        "Peer message sender moved out of source workspace before dispatch.",
      );
    }
    if (params.intent !== "reply" && !callerIsMainControl) {
      throw new PaseoToolInputError(
        "Peer message sender lost Main Control authority before dispatch.",
      );
    }
    if (
      params.intent === "reply" &&
      params.inboundThread &&
      params.inboundThread.lastTargetAgentId !== params.callerId &&
      !callerIsMainControl
    ) {
      throw new PaseoToolInputError(
        "Peer reply sender is no longer authorized for this thread at dispatch.",
      );
    }
  }

  function resolveLiveReplyInboundThreadAtDispatch(params: {
    correlationId: string;
    sourceWorkspaceId: string;
    targetWorkspaceId: string;
    expectedInboundHop?: number;
  }): PeerThreadState {
    const liveConfirmed = peerRuntime.threads.get(params.correlationId)?.confirmedSnapshot;
    if (!liveConfirmed || !liveConfirmed.admitted || !liveConfirmed.expectReply) {
      throw new PaseoToolInputError(
        `Peer reply correlationId ${params.correlationId} has no confirmed inbound hop awaiting reply at dispatch.`,
      );
    }
    const validDirection =
      liveConfirmed.lastTargetWorkspaceId === params.sourceWorkspaceId &&
      liveConfirmed.lastSourceWorkspaceId === params.targetWorkspaceId;
    const alreadyReplied = liveConfirmed.repliedHops.includes(liveConfirmed.hop);
    const hopChanged =
      params.expectedInboundHop !== undefined && liveConfirmed.hop !== params.expectedInboundHop;
    if (!validDirection || alreadyReplied || hopChanged) {
      throw new PaseoToolInputError(
        `Peer reply correlationId ${params.correlationId} is no longer authorized at dispatch.`,
      );
    }
    return {
      ...deserializeBasePeerThread(liveConfirmed),
      confirmedSnapshot: cloneBaseThreadSnapshot(liveConfirmed),
    };
  }

  async function verifyQueuedPeerDispatchBoundary(params: {
    dispatchId: string;
    attemptId: string;
    correlationId: string;
    callerId: string;
    recipientId: string;
    expectedTargetId: string;
    sourceWorkspaceId: string;
    targetWorkspaceId: string;
    intent: SendPeerMessageInput["intent"];
    inboundThread?: PeerThreadState;
    senderAgentId?: string;
    senderServerId?: string;
    expectedServerId?: string;
  }): Promise<void> {
    if (params.recipientId !== params.expectedTargetId) {
      throw new PaseoToolInputError("Peer message recipient changed before dispatch.");
    }
    const effectiveInboundThread =
      params.intent === "reply"
        ? resolveLiveReplyInboundThreadAtDispatch({
            correlationId: params.correlationId,
            sourceWorkspaceId: params.sourceWorkspaceId,
            targetWorkspaceId: params.targetWorkspaceId,
            expectedInboundHop: params.inboundThread?.hop,
          })
        : params.inboundThread;
    await assertSenderAuthorizedAtDispatch({ ...params, inboundThread: effectiveInboundThread });
    const { sourceWorkspace, targetWorkspace } = await resolvePeerWorkspaces(
      params.sourceWorkspaceId,
      params.targetWorkspaceId,
    );
    const eligibleTargets = await listEligiblePeerTargets(
      params.targetWorkspaceId,
      params.expectedTargetId,
    );
    const currentTarget = selectPeerTargetAgent({
      intent: params.intent,
      eligibleTargets,
      targetWorkspaceId: params.targetWorkspaceId,
      targetAgentId: params.expectedTargetId,
      inboundThread: effectiveInboundThread,
    });
    const [sourceUntrusted, targetUntrusted] = await Promise.all([
      isWorkspaceUntrusted(sourceWorkspace),
      isWorkspaceUntrusted(targetWorkspace),
    ]);
    const stillFastAdmitted = evaluatePeerFastAdmission({
      sourceWorkspace,
      targetWorkspace,
      sourceUntrusted,
      targetUntrusted,
      resolvedTarget: currentTarget,
      intent: params.intent,
      inboundThread: effectiveInboundThread,
    });
    if (!stillFastAdmitted) {
      const approved = await isPeerDurableApprovalGranted(
        sourceWorkspace,
        targetWorkspace,
        currentTarget,
        sourceUntrusted,
        targetUntrusted,
      );
      if (!approved) {
        throw new PaseoToolInputError(
          `Cross-workspace peer message to ${params.targetWorkspaceId} is no longer authorized at dispatch.`,
        );
      }
    }
    await recordPeerInboundAgentLock(
      params.recipientId,
      params.attemptId,
      params.dispatchId,
      params.correlationId,
    );
  }

  async function verifyPersistedPeerDispatchById(
    request: PeerDispatchVerificationRequest,
  ): Promise<void> {
    await ensurePeerRuntimeLoaded(peerRuntime);
    if (request.kind === "peer-workspace") {
      const record = peerRuntime.byMessageId.get(request.dispatchId);
      if (!record) {
        throw new PaseoToolInputError(
          `Missing persisted authorization record for peer message ${request.dispatchId}.`,
        );
      }
      if (!matchesPersistedPeerWorkspaceEndpoints(record, request)) {
        throw new PaseoToolInputError("Peer message endpoints changed before dispatch.");
      }
      await verifyQueuedPeerDispatchBoundary({
        dispatchId: request.dispatchId,
        attemptId: request.attemptId,
        correlationId: record.correlationId,
        callerId: record.agentId,
        recipientId: request.recipientId,
        expectedTargetId: record.recipientAgentId,
        sourceWorkspaceId: record.sourceWorkspaceId,
        targetWorkspaceId: record.targetWorkspaceId,
        intent: record.intent,
        inboundThread: record.inboundThread
          ? deserializePeerThread(record.inboundThread)
          : undefined,
        senderAgentId: request.senderAgentId,
        senderServerId: request.senderServerId,
        expectedServerId: record.serverId,
      });
      return;
    }
    const childDispatch = peerRuntime.pendingChildDispatches.get(request.dispatchId);
    if (!childDispatch) {
      throw new PaseoToolInputError(
        `Missing persisted authorization record for peer child prompt ${request.dispatchId}.`,
      );
    }
    if (!matchesPersistedPeerChildEndpoints(childDispatch, request)) {
      throw new PaseoToolInputError("Peer child prompt sender changed before dispatch.");
    }
    await verifyQueuedPeerChildDispatchBoundary({
      dispatchId: request.dispatchId,
      attemptId: request.attemptId,
      senderAgentId: childDispatch.senderAgentId,
      senderWorkspaceId: childDispatch.senderWorkspaceId,
      expectedRecipientId: childDispatch.recipientAgentId,
      recipientId: request.recipientId,
      correlationId: childDispatch.correlationId,
    });
  }

  registerHostPeerDispatchVerifier(options.serverId, verifyPersistedPeerDispatchById, {
    runtimeKey: peerRuntime,
    ensureReady: () => ensurePeerRuntimeLoaded(peerRuntime),
    onOutcome: handlePeerDispatchOutcome,
    flushPendingOutcomes: flushPendingOutcomesOnShutdown,
  });

  function checkAndStagePeerPairSlot(
    runtime: PeerWorkspaceRuntime,
    draftWindows: Map<string, PeerPairWindow>,
    sourceWorkspaceId: string,
    targetWorkspaceId: string,
  ): (targetWindows: Map<string, PeerPairWindow>) => void {
    const currentMs = options.crossWorkspacePeerPolicy?.now?.() ?? Date.now();
    const pairKey = [sourceWorkspaceId, targetWorkspaceId].sort().join("::");
    const liveWindow = runtime.pairWindows.get(pairKey);
    if ((liveWindow?.trippedUntil ?? 0) > currentMs) {
      throw new PaseoToolInputError(
        `Cross-workspace peer circuit breaker is active between ${sourceWorkspaceId} and ${targetWorkspaceId}. Stop automated peer exchanges and report to the user.`,
      );
    }
    const existing = draftWindows.get(pairKey);
    const activeTimestamps = (existing?.timestamps ?? []).filter(
      (ts) => currentMs - ts < PEER_RATE_WINDOW_MS,
    );
    const rateLimit =
      options.crossWorkspacePeerPolicy?.maxMessagesPerMinute ??
      DEFAULT_MAX_PEER_MESSAGES_PER_MINUTE;
    const cooldownMs =
      options.crossWorkspacePeerPolicy?.cooldownMs ?? DEFAULT_PEER_CIRCUIT_COOLDOWN_MS;
    if (activeTimestamps.length >= rateLimit) {
      const tripped = { timestamps: activeTimestamps, trippedUntil: currentMs + cooldownMs };
      setBoundedMapEntryWithUndo(runtime.pairWindows, pairKey, tripped, MAX_TRACKED_PEER_WINDOWS);
      throw new PaseoToolInputError(
        `Cross-workspace peer rate limit exceeded (${rateLimit} messages/minute) between ${sourceWorkspaceId} and ${targetWorkspaceId}; circuit breaker tripped.`,
      );
    }
    const token = currentMs + Math.random() * 1e-6;
    const nextWindow: PeerPairWindow = {
      timestamps: [...activeTimestamps, token],
      trippedUntil: existing?.trippedUntil ?? 0,
    };
    const undoMap = setBoundedMapEntryWithUndo(
      draftWindows,
      pairKey,
      nextWindow,
      MAX_TRACKED_PEER_WINDOWS,
    );
    return (targetWindows) => {
      const current = targetWindows.get(pairKey);
      if (!current) {
        undoMap(targetWindows);
        return;
      }
      const idx = current.timestamps.indexOf(token);
      if (idx >= 0) current.timestamps.splice(idx, 1);
      if (!existing && current.timestamps.length === 0 && current.trippedUntil === 0) {
        undoMap(targetWindows);
      }
    };
  }

  function buildPeerDispatchGuidance(
    targetId: string,
    correlationId: string,
    expectReply: boolean,
    intent: SendPeerMessageInput["intent"],
  ): string {
    const base = agentManager.getAgent(targetId)?.session
      ? describeAgentMessage({
          activeTurnBehavior: "queue",
          running: agentManager.hasInFlightRun(targetId),
          canSteer: agentManager.canSteer(targetId),
        })
      : "The message is queued. Open the recipient's supported Codex session to receive it.";
    if (expectReply) {
      return `${base} End your turn and wait for the peer workspace to reply via send_peer_message on correlationId "${correlationId}". Do not poll.`;
    }
    return intent === "reply"
      ? `${base} Peer reply queued with expectReply=false; thread "${correlationId}" has converged.`
      : `${base} Peer message queued with expectReply=false. No reply is expected on thread "${correlationId}".`;
  }

  function formatPeerSenderTitle(
    callerId: string,
    sourceWorkspaceTitle: string,
    storedCaller: StoredAgentRecord | null,
    liveCaller: ManagedAgent | null,
  ): string {
    const senderRawTitle = resolveReportTitle(
      callerId,
      storedCaller?.title,
      liveCaller?.config.title,
    );
    return senderRawTitle
      ? `[${sourceWorkspaceTitle}] ${senderRawTitle}`
      : `[${sourceWorkspaceTitle}] ${callerId.slice(0, 8)}`;
  }

  async function enqueueReservedPeerPrompt(params: {
    callerId: string;
    callerIsMainControl: boolean;
    sourceWorkspaceId: string;
    sourceWorkspaceTitle: string;
    resolvedTargetId: string;
    senderTitle: string;
    correlationId: string;
    replyToHop?: number;
    rawInput: SendPeerMessageInput;
  }) {
    const {
      callerId,
      callerIsMainControl,
      sourceWorkspaceId,
      sourceWorkspaceTitle,
      resolvedTargetId,
      senderTitle,
      correlationId,
      replyToHop,
      rawInput,
    } = params;
    const { intent, subject, message, targetWorkspaceId, targetAgentId } = rawInput;
    const dispatchId = randomUUID();
    // Atomic copy-on-write pre-enqueue commit: disk failure leaves in-memory runtime completely untouched.
    const {
      step: reserved,
      peerDisplayMetadata: metadata,
      undoDraft,
    } = await commitPeerStateTransaction(
      peerRuntime,
      async (draft) => {
        const step = resolvePeerStep({
          rawInput: { ...rawInput, correlationId },
          callerId,
          callerIsMainControl,
          sourceWorkspaceId,
          targetWorkspaceId,
          state: draft,
        });
        if (intent === "reply" && step.inboundThread) {
          const eligibleTargets = await listEligiblePeerTargets(
            targetWorkspaceId,
            targetAgentId ?? step.inboundThread.lastSourceAgentId,
          );
          const replyTarget = selectPeerTargetAgent({
            intent,
            eligibleTargets,
            targetWorkspaceId,
            targetAgentId,
            inboundThread: step.inboundThread,
          });
          if (step.inboundThread.hop !== replyToHop || replyTarget.id !== resolvedTargetId) {
            throw new PaseoToolInputError("Peer reply target changed before reservation.");
          }
        }
        const peerDisplayMetadata = {
          sourceWorkspaceId,
          sourceWorkspaceTitle,
          targetWorkspaceId,
          correlationId,
          intent,
          hop: step.nextHop,
          maxHops: step.effectiveMaxHops,
          expectReply: step.effectiveExpectReply,
          ...(subject ? { subject } : {}),
        };
        const undoSlot = checkAndStagePeerPairSlot(
          peerRuntime,
          draft.pairWindows,
          sourceWorkspaceId,
          targetWorkspaceId,
        );
        const existingThread = draft.threads.get(step.correlationId);
        const confirmedSnapshot = cloneBaseThreadSnapshot(existingThread?.confirmedSnapshot);
        const repliedHops = new Set(existingThread?.repliedHops ?? []);
        if (replyToHop !== undefined) repliedHops.add(replyToHop);
        const undoDelivery = setPeerDeliveryRecordWithUndo(
          draft.byMessageId,
          draft.inboundAgentLocks,
          dispatchId,
          {
            kind: "peer-workspace-message",
            dispatchId,
            agentId: callerId,
            ...(options.serverId ? { serverId: options.serverId } : {}),
            title: senderTitle,
            recipientAgentId: resolvedTargetId,
            settled: false,
            ...(replyToHop !== undefined ? { replyToHop } : {}),
            ...(step.inboundThread
              ? { inboundThread: serializePeerThread(step.inboundThread) }
              : {}),
            ...peerDisplayMetadata,
          },
        );
        const undoThread = setPeerThreadWithUndo(
          draft,
          step.correlationId,
          {
            correlationId: step.correlationId,
            maxHops: step.effectiveMaxHops,
            hop: step.nextHop,
            expectReply: step.effectiveExpectReply,
            lastSourceWorkspaceId: sourceWorkspaceId,
            lastSourceAgentId: callerId,
            lastTargetWorkspaceId: targetWorkspaceId,
            lastTargetAgentId: resolvedTargetId,
            repliedHops,
            admitted: Boolean(confirmedSnapshot?.admitted),
            ...(confirmedSnapshot ? { confirmedSnapshot } : {}),
            highestUnknownSnapshot: existingThread?.highestUnknownSnapshot,
            unknownReplyHops: existingThread?.unknownReplyHops,
          },
          countLocalHumanMessages,
        );
        return {
          step,
          peerDisplayMetadata,
          undoDraft: (rollbackTarget: PeerRuntimeMaps) => {
            undoDelivery(rollbackTarget.byMessageId);
            undoThread(rollbackTarget.threads);
            undoSlot(rollbackTarget.pairWindows);
          },
        };
      },
      countLocalHumanMessages,
    );

    const transportSecret = await resolvePeerTransportSecret(options.paseoHome);
    const encodedPrompt = encodePeerWorkspacePrompt(
      {
        dispatchId,
        senderAgentId: callerId,
        ...(options.serverId ? { senderServerId: options.serverId } : {}),
        recipientAgentId: resolvedTargetId,
        ...metadata,
      },
      message,
      transportSecret,
    );
    registerPromptDispatchVerifier(
      dispatchId,
      {
        kind: "peer-workspace",
        recipientId: resolvedTargetId,
        senderAgentId: callerId,
        senderServerId: options.serverId,
      },
      (recipientId, attemptId) =>
        verifyQueuedPeerDispatchBoundary({
          dispatchId,
          attemptId,
          correlationId: reserved.correlationId,
          callerId,
          recipientId,
          expectedTargetId: resolvedTargetId,
          sourceWorkspaceId,
          targetWorkspaceId,
          intent,
          inboundThread: reserved.inboundThread,
          expectedServerId: options.serverId,
        }),
      (outcome, context) => handlePeerDispatchOutcome(dispatchId, outcome, context),
    );

    try {
      const messageId = await enqueueLocalAgentPrompt(resolvedTargetId, {
        prompt: encodedPrompt,
        source: {
          agentId: callerId,
          ...(options.serverId ? { serverId: options.serverId } : {}),
          title: senderTitle,
        },
        activeTurnBehavior: "queue",
        unarchive: false,
        notifyLocalCaller: false,
        notifyOnFinish: false,
      });
      return { messageId, step: reserved };
    } catch (enqueueError) {
      releasePromptDispatchVerifier(dispatchId);
      return await rollbackPeerDeltaAfterFailedEnqueue(undoDraft, enqueueError);
    }
  }

  async function executeSendPeerMessageUnlocked(
    callerId: string,
    rawInput: SendPeerMessageInput,
  ): Promise<PaseoToolResult> {
    const { liveCaller, storedCaller, callerIsMainControl } =
      await requirePeerCallerSession(callerId);
    const { sourceWorkspaceId, sourceWorkspace, targetWorkspace } = await resolvePeerWorkspaces(
      liveCaller?.workspaceId ?? storedCaller?.workspaceId,
      rawInput.targetWorkspaceId,
    );
    const { targetWorkspaceId, targetAgentId, intent, taskId } = rawInput;
    const step = resolvePeerStep({
      rawInput,
      callerId,
      callerIsMainControl,
      sourceWorkspaceId,
      targetWorkspaceId,
      state: peerRuntime,
    });

    const eligibleTargets = await listEligiblePeerTargets(
      targetWorkspaceId,
      targetAgentId ?? step.inboundThread?.lastSourceAgentId,
    );
    const resolvedTarget = selectPeerTargetAgent({
      intent,
      eligibleTargets,
      targetWorkspaceId,
      targetAgentId,
      inboundThread: step.inboundThread,
    });
    await validateLocalPeerTaskId(taskId, callerIsMainControl, sourceWorkspaceId);

    const [sourceUntrusted, targetUntrusted] = await Promise.all([
      isWorkspaceUntrusted(sourceWorkspace),
      isWorkspaceUntrusted(targetWorkspace),
    ]);
    const fastAdmitted = evaluatePeerFastAdmission({
      sourceWorkspace,
      targetWorkspace,
      sourceUntrusted,
      targetUntrusted,
      resolvedTarget,
      intent,
      inboundThread: step.inboundThread,
    });
    if (!fastAdmitted) {
      const approval = await requestOrReadPeerDurableApproval({
        callerId,
        sourceWorkspace,
        targetWorkspace,
        resolvedTarget,
        sourceUntrusted,
        targetUntrusted,
        rawInput,
        correlationId: step.correlationId,
        nextHop: step.nextHop,
        effectiveMaxHops: step.effectiveMaxHops,
        effectiveExpectReply: step.effectiveExpectReply,
      });
      if (!approval.admitted) return approval.response;
    }

    const sourceWorkspaceTitle = resolveWorkspaceDisplayName(sourceWorkspace);
    const senderTitle = formatPeerSenderTitle(
      callerId,
      sourceWorkspaceTitle,
      storedCaller,
      liveCaller,
    );
    const { messageId, step: reserved } = await enqueueReservedPeerPrompt({
      callerId,
      callerIsMainControl,
      sourceWorkspaceId,
      sourceWorkspaceTitle,
      resolvedTargetId: resolvedTarget.id,
      senderTitle,
      rawInput,
      correlationId: step.correlationId,
      replyToHop: intent === "reply" ? step.inboundThread?.hop : undefined,
    });

    return {
      content: [],
      structuredContent: ensureValidJson({
        success: true,
        deliveryStatus: "queued",
        messageId,
        correlationId: reserved.correlationId,
        hop: reserved.nextHop,
        maxHops: reserved.effectiveMaxHops,
        expectReply: reserved.effectiveExpectReply,
        targetWorkspaceId,
        targetAgentId: resolvedTarget.id,
        status: agentManager.getAgent(resolvedTarget.id)?.lifecycle ?? "idle",
        ...(taskId ? { taskId } : {}),
        guidance: buildPeerDispatchGuidance(
          resolvedTarget.id,
          reserved.correlationId,
          reserved.effectiveExpectReply,
          intent,
        ),
      }),
    };
  }

  async function executeSendPeerMessage(rawInput: SendPeerMessageInput): Promise<PaseoToolResult> {
    if (!callerAgentId) {
      throw new PaseoToolInputError("send_peer_message requires an agent-scoped tool session.");
    }
    return withPeerStateMutex(peerRuntime, async () => {
      await flushPendingPeerOutcomesUnlocked();
      if (rawInput.correlationId) {
        const recovered = await findLegacyPeerAcceptances(peerRuntime, rawInput.correlationId);
        if (recovered.length) {
          await commitPeerStateTransaction(
            peerRuntime,
            (draft) => {
              for (const message of recovered) settleLegacyPeerAcceptance(draft, message);
            },
            countLocalHumanMessages,
          );
        }
      }
      return executeSendPeerMessageUnlocked(callerAgentId, rawInput);
    });
  }

  if (scope === "agent") {
    registerTool(
      "send_peer_message",
      {
        title: "Send cross-workspace peer message",
        description:
          "Send a read-only cross-workspace query, protocol alignment request, or reply to another workspace's Main Control (or a user-specified top-level root session when that workspace has no Main Control). Peer messages never grant file-edit, git-write, or lifecycle authority in the target workspace.",
        inputSchema: sendPeerMessageInputSchema,
        outputSchema: {
          success: z.boolean(),
          deliveryStatus: z.enum(["queued", "awaiting_approval"]),
          messageId: z.string().optional(),
          correlationId: z.string(),
          hop: z.number().int().min(1),
          maxHops: z.number().int().min(1),
          expectReply: z.boolean(),
          targetWorkspaceId: z.string(),
          targetAgentId: z.string().optional(),
          approvalRequestId: z.string().optional(),
          status: AgentStatusEnum.optional(),
          taskId: z.string().optional(),
          guidance: z.string(),
        },
      },
      executeSendPeerMessage,
    );
  }

  async function readRemoteParentForReport(parent: { agentId: string; serverId: string }) {
    if (!options.hosts) return undefined;
    const hosts = options.hosts();
    // Reverse-link absence does not prevent the parent from receiving the report.
    const directory = await hosts.directory();
    if (
      !directory.hosts.some((host) => host.serverId === parent.serverId && host.status === "online")
    )
      return undefined;
    return hosts.use(
      parent.serverId,
      async (client) => (await client.fetchAgent(parent.agentId))?.agent ?? null,
    );
  }

  function reportTurnId(agentId: string): string | undefined {
    const runtime = agentManager.getAgent(agentId);
    return (
      runtime?.activeForegroundTurnId ??
      runtime?.activeTurnId ??
      runtime?.lastTurnCompletion?.event.turnId
    );
  }

  function reportTopic(
    caller: HierarchyAgent,
    localParent: HierarchyAgent | undefined,
    taskReport: ReturnType<AgentManager["captureTaskReport"]>,
    verified: boolean,
  ) {
    const topicTask = taskReport?.topicTask;
    if (topicTask) {
      const matchesScope =
        verified &&
        localParent?.id === topicTask.mainAgentId &&
        localParent.workspaceId === topicTask.workspaceId &&
        caller.workspaceId === topicTask.workspaceId &&
        isMainControlAgentLabels(localParent.labels);
      return { taskId: matchesScope ? topicTask.taskId : undefined };
    }
    let taskLabels = taskReport?.agent.labels ?? caller.labels;
    if (!taskLabels?.[TASK_ID_LABEL] && localParent) {
      taskLabels = localParent.workspaceId === caller.workspaceId ? localParent.labels : undefined;
    }
    return {
      taskId: taskLabels?.[TASK_ID_LABEL] || undefined,
      rootMessageId: taskLabels?.[TOPIC_ROOT_MESSAGE_ID_LABEL] || undefined,
    };
  }

  registerTool(
    "reset_agent_session",
    {
      title: "Reset agent session",
      description:
        "Start a fresh provider conversation for one of your direct subagents. The agent ID and role stay the same.",
      inputSchema: {
        agentId: z.string().min(1),
        interrupt: z.boolean().optional().describe("Interrupt an active turn before resetting."),
        clearVisibleTimeline: z
          .boolean()
          .optional()
          .describe("Also clear the visible conversation history."),
      },
      outputSchema: { success: z.boolean() },
    },
    async ({ agentId, interrupt, clearVisibleTimeline }) => {
      if (!callerAgentId) throw new PaseoToolInputError("Reset requires an agent-scoped session.");
      const workspaceId = await requireCallerWorkspace();
      const localServer = options.serverId ?? "self";
      const stored = await agentStorage.get(agentId);
      const target = agentManager.getAgent(agentId) ?? stored;
      if (!target || target.internal || stored?.archivedAt || target.workspaceId !== workspaceId) {
        throw new PaseoToolInputError("Target agent is unavailable in the caller's workspace.");
      }
      assertDirectParent(target.labels, localServer, {
        serverId: localServer,
        agentId: callerAgentId,
      });
      await agentManager.resetAgentSession(agentId, {
        interrupt,
        clearVisibleTimeline,
        expectedParentAgentId: callerAgentId,
        expectedWorkspaceId: workspaceId,
      });
      return { content: [], structuredContent: { success: true } };
    },
  );

  async function requireParentReportTarget(
    parent: { serverId: string; agentId: string },
    localServer: string,
  ) {
    if (parent.serverId === localServer) {
      const target = await readHierarchyAgent(parent.agentId);
      if (!target || target.archivedAt) {
        throw new PaseoToolInputError(`Parent agent ${parent.agentId} is unavailable`);
      }
      return target;
    } else {
      const target = await readRemoteParentForReport(parent).catch(() => undefined);
      if (target === null || target?.archivedAt) {
        throw new PaseoToolInputError(`Parent agent ${parent.agentId} is unavailable`);
      }
    }
  }

  registerTool(
    "report_to_parent",
    {
      title: "Report to parent",
      description: "Send your final result or a blocking question to your direct parent agent.",
      inputSchema: {
        status: z.enum(["completed", "blocked"]).optional().default("completed"),
        summary: z
          .string()
          .trim()
          .min(1)
          .describe("Concise final report or blocking question for your direct parent agent."),
      },
      outputSchema: {
        success: z.boolean(),
        deliveryStatus: z.literal("queued").optional(),
        messageId: z.string().optional(),
      },
    },
    async ({ status, summary }) => {
      if (!callerAgentId) throw new PaseoToolInputError("Only subagents can report to a parent.");
      const taskReport = agentManager.captureTaskReport(callerAgentId);
      const turnId = taskReport?.deliveryTurnId ?? reportTurnId(callerAgentId);
      const localServer = options.serverId ?? "self";
      const caller = await readHierarchyAgent(callerAgentId);
      const parent = getParentAddressFromLabels(caller?.labels, localServer);
      if (
        !caller ||
        caller.archivedAt ||
        isMainControlAgentLabels(caller.labels) ||
        !parent ||
        (parent.serverId === localServer && parent.agentId === callerAgentId)
      ) {
        throw new PaseoToolInputError("Only subagents with a direct parent can report.");
      }
      const localParent = await requireParentReportTarget(parent, localServer);
      const isLocal = parent.serverId === localServer;
      const verified = options.verifiedCallerAgentId === callerAgentId;
      const topic = reportTopic(caller, localParent, taskReport, verified);
      const report = {
        status,
        summary: neutralizePeerWorkspacePromptMarker(summary),
        title: resolveReportTitle(callerAgentId, caller.title),
        turnId,
        ...topic,
      };
      const messageId = await finishSubscriptions().queueParentReport(
        {
          childAgentId: callerAgentId,
          callerAgentId: parent.agentId,
          ...(isLocal ? {} : { callerServerId: parent.serverId }),
        },
        report,
      );
      if (verified && isLocal && (!taskReport?.topicTask || topic.taskId)) {
        await agentManager.recordTaskParentReport(callerAgentId, messageId, status, taskReport);
      }
      return {
        content: [],
        structuredContent: { success: true, deliveryStatus: "queued", messageId },
      };
    },
  );

  // Match the WebSocket snapshot: idle agents can still own background work.
  async function projectLiveAgent(agent: ManagedAgent) {
    const snapshot = await serializeSnapshotWithMetadata(agentStorage, agent, childLogger);
    const backgroundWork = agentManager.getAgentBackgroundWorkSummary(agent.id);
    return backgroundWork ? { ...snapshot, backgroundWork } : snapshot;
  }

  function projectStoredAgent(record: StoredAgentRecord) {
    return buildStoredAgentPayload(
      record,
      new Set(providerSnapshotManager.listRegisteredProviderIds()),
      (provider, own) => agentManager.effectiveOptionsFor(provider, own),
      agentManager.getAgentBackgroundWorkSummary(record.id),
      (provider) => agentManager.adapterOf(provider),
    );
  }

  function isToolVisibleAgent(agent: { labels?: Record<string, string> }): boolean {
    return !isSideChatAgent(agent);
  }

  function sessionReuseStatus(
    source: Pick<StoredAgentRecord, "lastTurnCompletedAt" | "resetEpoch" | "consecutiveErrors">,
  ) {
    const { lastTurnCompletedAt, resetEpoch, consecutiveErrors } = source;
    return {
      ...(lastTurnCompletedAt === undefined ? {} : { lastTurnCompletedAt }),
      ...(resetEpoch === undefined ? {} : { resetEpoch }),
      ...(consecutiveErrors === undefined ? {} : { consecutiveErrors }),
    };
  }

  registerTool(
    "get_agent_status",
    {
      title: "Get agent status",
      description:
        "Return the latest snapshot for an agent, including lifecycle state, capabilities, and pending permissions.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        status: AgentStatusEnum,
        snapshot: AgentSnapshotPayloadSchema,
        lastTurnCompletedAt: z.string().optional(),
        resetEpoch: z.number().int().nonnegative().optional(),
        consecutiveErrors: z.number().int().nonnegative().optional(),
      },
    },
    async ({ agentId }) => {
      const snapshot = agentManager.getAgent(agentId);
      if (snapshot) {
        if (!isToolVisibleAgent(snapshot))
          throw new PaseoToolInputError(`Agent ${agentId} not found`);
        const structuredSnapshot = await projectLiveAgent(snapshot);
        return {
          content: [],
          structuredContent: ensureValidJson({
            status: snapshot.lifecycle,
            snapshot: structuredSnapshot,
            ...sessionReuseStatus(snapshot),
          }),
        };
      }

      const record = await agentStorage.get(agentId);
      if (!record || record.internal || !isToolVisibleAgent(record)) {
        throw new PaseoToolInputError(`Agent ${agentId} not found`);
      }

      const structuredSnapshot = projectStoredAgent(record);
      return {
        content: [],
        structuredContent: ensureValidJson({
          status: structuredSnapshot.status,
          snapshot: structuredSnapshot,
          ...sessionReuseStatus(record),
        }),
      };
    },
  );

  registerTool(
    "list_agents",
    {
      title: "List agents",
      description: "List recent agents as compact metadata.",
      inputSchema: {
        includeBackground: z.boolean().optional().default(false),
        includeArchived: z.boolean().optional().default(false),
        cwd: z.string().optional(),
        sinceHours: z
          .number()
          .int()
          .positive()
          .max(24 * 30)
          .optional()
          .default(48),
        statuses: z.array(AgentStatusEnum).optional(),
        limit: z.number().int().positive().max(200).optional().default(50),
      },
      outputSchema: {
        agents: z.array(AgentListItemPayloadSchema),
      },
    },
    async ({
      includeBackground = false,
      includeArchived = false,
      cwd,
      sinceHours = 48,
      statuses,
      limit = 50,
    }) => {
      const callerCwd = callerAgentId ? resolveCallerAgent()?.cwd : undefined;
      const requestedCwd = cwd?.trim() ? expandUserPath(cwd) : callerCwd;
      if (!options.workspaceRegistry) throw new Error("Workspace registry is not configured");
      const directory = new AgentDirectory({
        manager: agentManager,
        storage: agentStorage,
        workspaces: options.workspaceRegistry,
        projectLive: projectLiveAgent,
        projectStored: projectStoredAgent,
        isProviderVisible: () => true,
        isStoredProviderAvailable: (record) =>
          isStoredAgentProviderAvailable(
            record,
            new Set(providerSnapshotManager.listRegisteredProviderIds()),
          ),
      });
      const agents = selectAgentListItems(
        (await directory.list({ includeBackground, includeArchived })).filter(isToolVisibleAgent),
        { cwd: requestedCwd, statuses, sinceHours, limit },
      );

      return {
        content: [],
        structuredContent: ensureValidJson({ agents }),
      };
    },
  );

  registerTool(
    "cancel_agent",
    {
      title: "Cancel agent run",
      description: "Abort the agent's current run but keep the agent alive for future tasks.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      const { cancelled } = await cancelAgentRunCommand(
        { agentManager, logger: childLogger },
        agentId,
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ success: cancelled }),
      };
    },
  );

  registerTool(
    "archive_agent",
    {
      title: "Archive agent",
      description: describeForScope(
        "Archive an inactive agent (soft-delete). Running or initializing agents and active turns are protected. Open-tab protection uses the subagent tab markers reported to the server. Clients do not report open root-agent tabs.",
        "Archive an agent (soft-delete). The agent is interrupted if running and removed from the active list.",
      ),
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }, context) => {
      if (scope === "agent") {
        await agentManager.archiveAgentFromAgentTool(agentId, async () => {
          await checkHierarchy("archive_agent", { agentId }, context);
        });
      } else {
        await archiveAgentCommand({ agentManager, agentStorage, logger: childLogger }, agentId);
      }
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "kill_agent",
    {
      title: "Kill agent",
      description: "Terminate an agent session permanently.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      await closeAgentCommand({ agentManager }, agentId);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "update_agent",
    {
      title: "Update agent",
      description: "Update an agent name, labels, and/or runtime settings.",
      inputSchema: {
        agentId: z.string(),
        name: z.string().optional(),
        labels: z.record(z.string(), z.string()).optional().describe("Labels to set on the agent"),
        settings: UpdateAgentSettingsInputSchema.optional().describe(
          "Runtime settings to apply to the agent.",
        ),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId, name, labels, settings }) => {
      if (hasReservedHierarchyLabels(labels)) {
        throw new PaseoToolInputError(RESERVED_HIERARCHY_LABELS_ERROR);
      }
      if (settings?.modeId !== undefined) {
        await agentManager.setAgentMode(agentId, settings.modeId);
      }
      if (settings?.model !== undefined) {
        await agentManager.setAgentModel(agentId, settings.model);
      }
      if (settings?.thinkingOptionId !== undefined) {
        await agentManager.setAgentThinkingOption(agentId, settings.thinkingOptionId);
      }
      if (settings?.features) {
        await agentManager.setAgentOptions(agentId, settings.features);
      }

      await updateAgentCommand({ agentManager }, { agentId, name, labels });

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "rename_workspace",
    {
      title: "Rename workspace",
      description:
        "Rename a workspace by setting its user-visible title. Omit workspaceId to rename your current workspace.",
      inputSchema: {
        workspaceId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Workspace id to rename. Omit to rename your current workspace."),
        title: z
          .string()
          .trim()
          .min(1, "title is required")
          .describe("New user-visible workspace title."),
      },
      outputSchema: {
        success: z.boolean(),
        workspaceId: z.string(),
        title: z.string(),
      },
    },
    async ({ workspaceId: requestedWorkspaceId, title }) => {
      if (!options.workspaceRegistry) {
        throw new Error("Workspace registry is required to rename workspaces");
      }
      if (!options.emitWorkspaceUpdatesForWorkspaceIds) {
        throw new Error("Workspace update emitter is required to rename workspaces");
      }

      const workspaceId = resolveWorkspaceIdForRename(requestedWorkspaceId);
      const updated = await options.workspaceRegistry.update(workspaceId, (current) => {
        if (current.archivedAt) {
          throw new PaseoToolInputError(`Workspace ${workspaceId} is archived`);
        }
        return { ...current, title, titleSource: "user", updatedAt: new Date().toISOString() };
      });
      if (!updated) {
        throw new PaseoToolInputError(`Workspace ${workspaceId} not found`);
      }
      await options.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);

      return {
        content: [],
        structuredContent: ensureValidJson({
          success: true,
          workspaceId,
          title,
        }),
      };
    },
  );

  registerTool(
    "list_workspace_scripts",
    {
      title: "List workspace scripts",
      description:
        "List configured workspace scripts and their lifecycle, service port, proxy URL, health, and terminal ID.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID whose configured scripts to list."),
      },
      outputSchema: {
        scripts: z.array(WorkspaceScriptPayloadSchema),
      },
    },
    async ({ workspaceId }) => {
      if (!workspaceScripts) {
        throw new Error("Workspace script management is not configured");
      }
      return {
        content: [],
        structuredContent: ensureValidJson({ scripts: await workspaceScripts.list(workspaceId) }),
      };
    },
  );

  registerTool(
    "start_workspace_script",
    {
      title: "Start workspace script",
      description:
        "Start one configured workspace script through Paseo's managed workspace-script launcher.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID containing the configured script."),
        scriptName: z.string().min(1).describe("Configured paseo.json script name to start."),
      },
      outputSchema: {
        script: WorkspaceScriptPayloadSchema,
      },
    },
    async ({ workspaceId, scriptName }) => {
      if (!workspaceScripts) {
        throw new Error("Workspace script management is not configured");
      }
      return {
        content: [],
        structuredContent: ensureValidJson({
          script: await workspaceScripts.launch({ workspaceId, scriptName }),
        }),
      };
    },
  );

  registerTool(
    "stop_workspace_script",
    {
      title: "Stop workspace script",
      description: "Stop a running workspace script through its supervised terminal lifecycle.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID containing the running script."),
        scriptName: z.string().min(1).describe("Configured paseo.json script name to stop."),
      },
      outputSchema: {
        script: WorkspaceScriptPayloadSchema,
      },
    },
    async ({ workspaceId, scriptName }) => {
      if (!workspaceScripts) {
        throw new Error("Workspace script management is not configured");
      }
      return {
        content: [],
        structuredContent: ensureValidJson({
          script: await workspaceScripts.stop({ workspaceId, scriptName }),
        }),
      };
    },
  );

  registerTool(
    "list_terminals",
    {
      title: "List terminals",
      description: "List terminals for a working directory or across all working directories.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory. Defaults to your current working directory."),
        all: z.boolean().optional().describe("List terminals across all working directories."),
      },
      outputSchema: {
        terminals: z.array(TerminalSummarySchema),
      },
    },
    async ({ cwd, all }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminals = all
        ? (
            await Promise.all(
              terminalManager.listDirectories().map(async (directory) =>
                (await terminalManager.getTerminals(directory)).map((terminal) => ({
                  id: terminal.id,
                  name: terminal.name,
                  cwd: terminal.cwd,
                })),
              ),
            )
          ).flat()
        : (await terminalManager.getTerminals(resolveScopedCwd(cwd, { required: true }))).map(
            (terminal) => ({
              id: terminal.id,
              name: terminal.name,
              cwd: terminal.cwd,
            }),
          );

      return {
        content: [],
        structuredContent: ensureValidJson({ terminals }),
      };
    },
  );

  registerTool(
    "create_terminal",
    {
      title: "Create terminal",
      description: describeForScope(
        "Create a terminal session in your current workspace.",
        "Create a terminal session for a working directory.",
      ),
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory. Defaults to your current working directory."),
        name: z.string().optional().describe("Optional terminal name."),
      },
      outputSchema: TerminalSummarySchema.shape,
    },
    async ({ cwd, name }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const callerWorkspaceId = callerAgentId ? await requireCallerWorkspace() : undefined;
      const resolvedCwd = resolveScopedCwd(cwd, { required: true });
      const workspaceId = callerWorkspaceId ?? (await createTopLevelTerminalWorkspace(resolvedCwd));

      const terminal = await terminalManager.createTerminal({
        cwd: resolvedCwd,
        workspaceId,
        ...(name?.trim() ? { name: name.trim() } : {}),
      });

      return {
        content: [],
        structuredContent: ensureValidJson({
          id: terminal.id,
          name: terminal.name,
          cwd: terminal.cwd,
        }),
      };
    },
  );

  registerTool(
    "kill_terminal",
    {
      title: "Kill terminal",
      description: "Kill an existing terminal session.",
      inputSchema: {
        terminalId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ terminalId }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminal = terminalManager.getTerminal(terminalId);
      if (!terminal) {
        throw new PaseoToolInputError(`Terminal ${terminalId} not found`);
      }

      terminal.kill();

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "capture_terminal",
    {
      title: "Capture terminal",
      description: "Capture plain-text terminal output lines from a terminal session.",
      inputSchema: {
        terminalId: z.string(),
        start: z.number().optional(),
        end: z.number().optional(),
        scrollback: z.boolean().optional(),
        stripAnsi: z.boolean().optional().default(true),
      },
      outputSchema: {
        terminalId: z.string(),
        lines: z.array(z.string()),
        totalLines: z.number().int().nonnegative(),
      },
    },
    async ({ terminalId, start, end, scrollback, stripAnsi = true }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      if (!terminalManager.getTerminal(terminalId)) {
        throw new PaseoToolInputError(`Terminal ${terminalId} not found`);
      }

      const capture = await terminalManager.captureTerminal(terminalId, {
        start: scrollback ? 0 : start,
        end,
        stripAnsi,
      });

      return {
        content: [],
        structuredContent: ensureValidJson({
          terminalId,
          lines: capture.lines,
          totalLines: capture.totalLines,
        }),
      };
    },
  );

  registerTool(
    "send_terminal_keys",
    {
      title: "Send terminal keys",
      description:
        "Send text or a key token: Enter, Tab, Escape, Space, BSpace, Up, Down, Left, Right, Home, End, Insert, Delete, PageUp, PageDown, or F1-F12. Combine C- (Ctrl), M- (Alt), and S- (Shift) prefixes, e.g. C-r, S-Tab, or C-M-Left. Set literal=true to send the text unchanged.",
      inputSchema: {
        terminalId: z.string(),
        keys: z.string(),
        literal: z.boolean().optional(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ terminalId, keys, literal = false }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminal = terminalManager.getTerminal(terminalId);
      if (!terminal) {
        throw new PaseoToolInputError(`Terminal ${terminalId} not found`);
      }

      terminal.send({
        type: "input",
        data: resolveTerminalKeyToken({
          key: keys,
          literal,
          preamble: terminal.getReplayPreamble(),
        }),
      });

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "create_schedule",
    {
      title: "Create schedule",
      description: "Create a recurring schedule that starts a new agent on a cron cadence.",
      inputSchema: z
        .object({
          prompt: z.string().trim().min(1, "prompt is required"),
          cron: z.string().trim().min(1, "cron is required"),
          timezone: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("IANA time zone for the cron cadence. For example: America/New_York."),
          name: z.string().optional(),
          provider: (scope === "agent" ? AgentProviderEnum.optional() : AgentProviderEnum).describe(
            "Provider, or provider/model (for example: codex or codex/gpt-5.4). Defaults to the caller's provider in an agent-scoped session.",
          ),
          cwd: z.string().optional(),
          isolation: z.enum(["local", "worktree"]).optional(),
          maxRuns: z.number().int().positive().optional(),
          expiresIn: scheduleDurationInputSchema.optional(),
        })
        .superRefine(addScheduleCadenceIssue),
      outputSchema: ScheduleSummarySchema.shape,
    },
    async ({ prompt, cron, timezone, name, provider, cwd, isolation, maxRuns, expiresIn }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const expiresAt = buildScheduleExpiry(expiresIn);
      const schedule = await runScheduleAction(() =>
        scheduleService.createOrReplace({
          callerAgentId,
          prompt: prompt.trim(),
          cadence: buildCronScheduleCadence({
            cron,
            ...(timezone !== undefined ? { timezone } : {}),
          }),
          target: resolveNewAgentScheduleTarget({ provider, cwd, isolation }),
          ...(name?.trim() ? { name: name.trim() } : {}),
          ...(maxRuns === undefined ? {} : { maxRuns }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
        }),
      );

      return {
        content: [],
        structuredContent: ensureValidJson(toScheduleSummary(schedule)),
      };
    },
  );

  if (options.changeRequestWatches) {
    const watches = options.changeRequestWatches;
    const inputSchema = {
      url: z
        .string()
        .trim()
        .min(1)
        .describe("URL of a pull request or merge request on a supported forge."),
    };
    registerTool(
      "subscribe_change_request",
      {
        title: "Watch change request",
        description:
          "Watch a pull request or merge request for check failures, passing checks, new comments, reviews, approvals, and closure. Returns the current state and sends future updates after your current turn.",
        inputSchema,
        outputSchema: {
          url: z.string(),
          ...changeRequestStatusSchema.shape,
          subscribed: z.boolean(),
          stale: z
            .boolean()
            .describe("The last stored status is shown because a fresh read is pending or failed."),
        },
      },
      async ({ url }) => {
        if (!callerAgentId) {
          throw new PaseoToolInputError(
            "subscribe_change_request requires an agent-scoped session",
          );
        }
        resolveCallerAgent();
        return {
          content: [],
          structuredContent: ensureValidJson(await watches.subscribe(callerAgentId, url)),
        };
      },
    );
    registerTool(
      "unsubscribe_change_request",
      {
        title: "Stop watching change request",
        description: "Stop your watch and discard its unsent updates.",
        inputSchema,
        outputSchema: { url: z.string(), removed: z.boolean() },
      },
      async ({ url }) => {
        if (!callerAgentId) {
          throw new PaseoToolInputError(
            "unsubscribe_change_request requires an agent-scoped session",
          );
        }
        resolveCallerAgent();
        return {
          content: [],
          structuredContent: ensureValidJson(await watches.unsubscribe(callerAgentId, url)),
        };
      },
    );
  }

  registerTool(
    "create_heartbeat",
    {
      title: "Create heartbeat",
      description: "Create a recurring heartbeat that sends you a prompt on a cron cadence.",
      inputSchema: z
        .object({
          prompt: z.string().trim().min(1, "prompt is required"),
          cron: z.string().trim().min(1, "cron is required"),
          timezone: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("IANA time zone for the cron cadence. For example: America/New_York."),
          name: z.string().optional(),
          maxRuns: z.number().int().positive().optional(),
          expiresIn: scheduleDurationInputSchema.optional(),
        })
        .superRefine(addScheduleCadenceIssue),
      outputSchema: ScheduleSummarySchema.shape,
    },
    async ({ prompt, cron, timezone, name, maxRuns, expiresIn }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }
      if (!callerAgentId) {
        throw new PaseoToolInputError("create_heartbeat requires an agent-scoped session");
      }
      resolveCallerAgent();

      const expiresAt = buildScheduleExpiry(expiresIn);
      const schedule = await scheduleService.createOrReplace({
        prompt: prompt.trim(),
        cadence: buildCronScheduleCadence({
          cron,
          ...(timezone !== undefined ? { timezone } : {}),
        }),
        target: { type: "agent", agentId: callerAgentId },
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(maxRuns === undefined ? {} : { maxRuns }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });

      return {
        content: [],
        structuredContent: ensureValidJson(toScheduleSummary(schedule)),
      };
    },
  );

  registerTool(
    "delete_heartbeat",
    {
      title: "Delete heartbeat",
      description: "Delete one of your heartbeats.",
      inputSchema: { id: z.string().min(1) },
      outputSchema: { success: z.boolean() },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }
      await requireCallerHeartbeat(id);
      await scheduleService.delete(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "list_schedules",
    {
      title: "List schedules",
      description: "List all schedules managed by the daemon.",
      inputSchema: {},
      outputSchema: {
        schedules: z.array(ScheduleSummarySchema),
      },
    },
    async () => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const schedules = (await scheduleService.list())
        .filter((schedule) => schedule.target.type === "new-agent")
        .map((schedule) => toScheduleSummary(schedule));
      return {
        content: [],
        structuredContent: ensureValidJson({ schedules }),
      };
    },
  );

  registerTool(
    "inspect_schedule",
    {
      title: "Inspect schedule",
      description: "Inspect a schedule and its run history.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: StoredScheduleSchema.shape,
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const schedule = await requireScheduleTarget(id, "new-agent");
      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  registerTool(
    "pause_schedule",
    {
      title: "Pause schedule",
      description: "Pause an active schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      await runScheduleAction(() => scheduleService.pause(id));
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "resume_schedule",
    {
      title: "Resume schedule",
      description: "Resume a paused schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      await runScheduleAction(() => scheduleService.resume(id, callerAgentId));
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "delete_schedule",
    {
      title: "Delete schedule",
      description: "Delete a schedule permanently.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      await scheduleService.delete(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "update_schedule",
    {
      title: "Update schedule",
      description:
        "Update an existing schedule. Only provided fields are changed; omitted fields remain unchanged.",
      inputSchema: z
        .object({
          id: z.string(),
          cron: z.string().optional().describe("New cron expression."),
          timezone: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "IANA time zone for cron cadence; requires cron. For example: America/New_York.",
            ),
          name: z.string().nullable().optional().describe("New name (null to clear)."),
          prompt: z.string().trim().min(1).optional().describe("New prompt text."),
          maxRuns: z
            .number()
            .int()
            .positive()
            .nullable()
            .optional()
            .describe("New max runs limit (null to clear)."),
          provider: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("New provider for new-agent target."),
          model: z
            .string()
            .trim()
            .min(1)
            .nullable()
            .optional()
            .describe("New model for new-agent target (null to clear)."),
          mode: z
            .string()
            .trim()
            .min(1)
            .nullable()
            .optional()
            .describe("New mode for new-agent target (null to clear)."),
          cwd: z.string().trim().min(1).optional().describe("New cwd for new-agent target."),
          expiresIn: scheduleDurationInputSchema
            .optional()
            .describe("New relative expiry duration (for example: 1h, 2d)."),
          clearExpires: z.boolean().optional().describe("Clear any schedule expiry."),
        })
        .passthrough()
        .superRefine(addScheduleCadenceIssue),
      outputSchema: StoredScheduleSchema.shape,
    },
    async (input) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(input.id, "new-agent");
      const schedule = await runScheduleAction(() =>
        scheduleService.update(buildScheduleUpdateInput(input), callerAgentId),
      );

      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  registerTool(
    "schedule_logs",
    {
      title: "Schedule logs",
      description: "Get the run history (logs) for a schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        runs: z.array(ScheduleRunSchema),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      const runs = await scheduleService.logs(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ runs }),
      };
    },
  );

  registerTool(
    "run_schedule_once",
    {
      title: "Run schedule once",
      description: "Run a schedule immediately without changing its cron cadence.",
      inputSchema: { id: z.string().min(1) },
      outputSchema: StoredScheduleSchema.shape,
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }
      await requireScheduleTarget(id, "new-agent");
      const schedule = await runScheduleAction(() => scheduleService.runOnce(id, callerAgentId));
      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  registerTool(
    "list_providers",
    {
      title: "List providers",
      description: "List configured agent providers, availability, and their modes.",
      inputSchema: {},
      outputSchema: {
        providers: z.array(ProviderSummarySchema),
      },
    },
    async () => {
      const providers = (await providerSnapshotManager.listProviders({ wait: true })).map(
        toProviderSummary,
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ providers }),
      };
    },
  );

  registerTool(
    "list_models",
    {
      title: "List models",
      description: "List models for an agent provider.",
      inputSchema: {
        provider: AgentProviderEnum,
      },
      outputSchema: {
        provider: z.string(),
        models: z.array(AgentModelSchema),
      },
    },
    async ({ provider }) => {
      const models = await providerSnapshotManager.listModels({
        provider,
        wait: true,
      });
      return {
        content: [],
        structuredContent: ensureValidJson({
          provider,
          models,
        }),
      };
    },
  );

  registerTool(
    "list_profiles",
    {
      title: "List agent profiles",
      description:
        "List the provider settings and role defaults configured by a human. Use `notes` to pick a profile " +
        "and pass its `id` to create_agent as `profileId`. The role prompt and provider options apply automatically. " +
        "Use `resident` to override `defaultResident`. Reuse an existing resident with send_agent_prompt. " +
        "Returns an empty list if none are configured.",
      inputSchema: {},
      outputSchema: {
        profiles: z.array(AgentProfileSchema),
      },
    },
    async () => {
      const profiles = daemonConfigStore?.get().agentProfiles ?? [];
      return {
        content: [],
        structuredContent: ensureValidJson({ profiles }),
      };
    },
  );

  registerTool(
    "inspect_provider",
    {
      title: "Inspect provider",
      description:
        "Inspect compact provider capabilities for orchestration, including modes and draft feature settings. Use list_models for the full model list.",
      inputSchema: inspectProviderInputSchema,
      outputSchema: {
        provider: AgentProviderEnum,
        label: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        enabled: z.boolean(),
        status: z.string(),
        modes: z.array(ProviderModeSchema).nullish(),
        selectedModel: z.string().nullable(),
        features: z.array(AgentFeatureSchema),
      },
    },
    async ({ provider, cwd, settings }) => {
      const resolvedProviderModel = resolveScheduleProviderAndModel({
        provider,
        defaultProvider: provider,
      });
      const providerId = resolvedProviderModel.provider;
      const resolvedCwd = resolveScopedCwd(cwd, { required: true });
      const entry = await providerSnapshotManager.getProvider({
        cwd: resolvedCwd,
        provider: providerId,
        wait: true,
      });
      const summary = toProviderSummary(entry);
      if (!entry.enabled) {
        throw new PaseoToolInputError(`Provider '${providerId}' is disabled`);
      }
      if (entry.status !== "ready") {
        throw new PaseoToolInputError(entry.error ?? `Provider '${providerId}' is unavailable`);
      }
      const selectedModel = settings?.model ?? resolvedProviderModel.model;
      const { controls, options: effectiveOptions } = await agentManager.listDraftControls({
        provider: providerId,
        cwd: resolvedCwd,
        ...(settings?.modeId ? { modeId: settings.modeId } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(settings?.thinkingOptionId ? { thinkingOptionId: settings.thinkingOptionId } : {}),
        ...(settings?.features ? { providerOptions: settings.features } : {}),
      });
      return {
        content: [],
        structuredContent: ensureValidJson({
          provider: providerId,
          label: summary.label,
          description: summary.description,
          enabled: summary.enabled,
          status: summary.status,
          modes: summary.modes,
          selectedModel: selectedModel ?? null,
          features: featuresFromControls({ controls, options: effectiveOptions }),
        }),
      };
    },
  );

  registerTool(
    "get_agent_activity",
    {
      title: "Get agent activity",
      description: "Return recent agent timeline entries as a curated summary.",
      inputSchema: {
        agentId: z.string(),
        limit: z
          .number()
          .optional()
          .describe("Optional limit for number of activities to include (most recent first)."),
      },
      outputSchema: {
        agentId: z.string(),
        updateCount: z.number(),
        currentModeId: z.string().nullable(),
        content: z.string(),
      },
    },
    async ({ agentId, limit }) => {
      await ensureAgentLoaded(agentId, {
        agentManager,
        agentStorage,
        logger: childLogger,
      });
      const timeline = agentManager.getTimeline(agentId);
      const snapshot = agentManager.getAgent(agentId);

      return {
        content: [],
        structuredContent: ensureValidJson({
          agentId,
          ...summarizeAgentActivity(timeline, limit),
          currentModeId: snapshot?.currentModeId ?? null,
        }),
      };
    },
  );

  registerTool(
    "set_agent_mode",
    {
      title: "Set agent session mode",
      description:
        "Switch the agent's session mode (plan, bypassPermissions, read-only, auto, etc.).",
      inputSchema: {
        agentId: z.string(),
        modeId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
        newMode: z.string(),
      },
    },
    async ({ agentId, modeId }) => {
      const result = await setAgentModeCommand({ agentManager }, { agentId, modeId });
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true, newMode: result.modeId }),
      };
    },
  );

  registerTool(
    "list_pending_permissions",
    {
      title: "List pending permissions",
      description:
        "Return all pending permission requests across all agents with the normalized payloads.",
      inputSchema: {},
      outputSchema: {
        permissions: z.array(
          z.object({
            agentId: z.string(),
            status: AgentStatusEnum,
            request: AgentPermissionRequestPayloadSchema,
          }),
        ),
      },
    },
    async () => {
      const permissions = agentManager
        .listAgents()
        .filter(isToolVisibleAgent)
        .flatMap((agent) => {
          const payload = toAgentPayload(agent);
          return payload.pendingPermissions.map((request) => ({
            agentId: agent.id,
            status: payload.status,
            request: sanitizePermissionRequest(request),
          }));
        });

      return {
        content: [],
        structuredContent: ensureValidJson({ permissions }),
      };
    },
  );

  registerTool(
    "respond_to_permission",
    {
      title: "Respond to permission",
      description:
        "Approve or deny a pending permission request with an AgentManager-compatible response payload.",
      inputSchema: {
        agentId: z.string(),
        requestId: z.string(),
        response: AgentPermissionResponseSchema,
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId, requestId, response }) => {
      if (callerAgentId && callerAgentId !== agentId) {
        const stored = await agentStorage.get(agentId);
        const target = agentManager.getAgent(agentId);
        const serverId = options.serverId ?? "self";
        assertDirectParent(target?.labels, serverId, { agentId: callerAgentId, serverId });
        if (stored?.archivedAt || !target?.pendingPermissions.has(requestId)) {
          throw new PaseoToolInputError("Permission request is no longer pending.");
        }
      }
      await respondToAgentPermission({
        agentManager,
        agentId,
        requestId,
        response,
        logger: childLogger,
      });
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerPluginTools({
    agentManager,
    callerAgentId,
    scope,
    tools,
    builtinNames,
    policy: options.paseoToolPolicy,
  });
  return toCatalog();
}

interface ArchiveWorktreeCommandContext {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager | null;
  logger: Logger;
}

function archiveWorktreeDependencies(
  options: PaseoToolHostDependencies,
  context: ArchiveWorktreeCommandContext,
): ArchiveCommandDependencies {
  if (!options.github) {
    throw new Error("GitHub service is required to archive worktrees");
  }
  if (!options.workspaceGitService) {
    throw new Error("WorkspaceGitService is required to archive worktrees");
  }
  if (!options.archiveWorkspaceRecord) {
    throw new Error("Workspace registry archiver is required to archive worktrees");
  }
  if (!options.findWorkspaceIdForCwd) {
    throw new Error("Workspace resolver is required to archive worktrees");
  }
  if (!options.listActiveWorkspaces) {
    throw new Error("Active workspace lister is required to archive worktrees");
  }
  if (!options.emitWorkspaceUpdatesForWorkspaceIds) {
    throw new Error("Workspace update emitter is required to archive worktrees");
  }
  if (!options.markWorkspaceArchiving) {
    throw new Error("Workspace archiving marker is required to archive worktrees");
  }
  if (!options.clearWorkspaceArchiving) {
    throw new Error("Workspace archiving clearer is required to archive worktrees");
  }
  if (!options.assertWorkspaceAutomationAllowed) {
    throw new Error("Workspace automation gate is required to archive worktrees");
  }
  if (!options.isCheckoutUntrusted) {
    throw new Error("Checkout trust lookup is required to archive worktrees");
  }
  return {
    paseoHome: options.paseoHome,
    paseoWorktreesBaseRoot: options.worktreesRoot,
    worktreeManagers: options.worktreeManagers,
    workspaceArchiveOperations: options.workspaceArchiveOperations,
    assertWorkspaceAutomationAllowed: options.assertWorkspaceAutomationAllowed,
    isCheckoutUntrusted: options.isCheckoutUntrusted,
    github: options.github,
    workspaceGitService: options.workspaceGitService,
    agentManager: context.agentManager,
    agentStorage: context.agentStorage,
    findWorkspaceIdForCwd: options.findWorkspaceIdForCwd,
    ...(options.workspaceRegistry
      ? { getWorkspace: (workspaceId: string) => options.workspaceRegistry!.get(workspaceId) }
      : {}),
    listActiveWorkspaces: options.listActiveWorkspaces,
    archiveWorkspaceRecord: options.archiveWorkspaceRecord,
    emitWorkspaceUpdatesForWorkspaceIds: options.emitWorkspaceUpdatesForWorkspaceIds,
    markWorkspaceArchiving: options.markWorkspaceArchiving,
    clearWorkspaceArchiving: options.clearWorkspaceArchiving,
    killTerminalsForWorkspace: (workspaceId: string) =>
      killTerminalsForWorkspace(
        {
          terminalManager: context.terminalManager,
          sessionLogger: context.logger,
        },
        workspaceId,
      ),
    sessionLogger: context.logger,
  };
}
