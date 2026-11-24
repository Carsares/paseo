import type { ChangeRequestWatches } from "../change-request-watches/index.js";
import { changeRequestStatusSchema } from "../../../services/change-request-source.js";
import { registerPluginTools } from "./plugin-tools.js";
import type { FinishSubscriptions, FinishRegistration } from "../finish-subscriptions/index.js";
import { resolveReportTitle } from "../report-title.js";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import type { RecoverableAgentMessage } from "../../message-receipts/index.js";
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
import type { Logger } from "pino";

import type { AgentMode, AgentProvider, AgentSessionConfig } from "../agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "../agent-manager.js";
import {
  ActiveTurnBehaviorSchema,
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
import { sendPromptToAgent, waitForAgentRunStartWithTimeout } from "../agent-prompt.js";
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
import type {
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
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
  applyHierarchyPaseoToolPolicy,
  computeAgentDepth,
  hasReservedHierarchyLabels,
  readAgentHierarchyPath,
  RESERVED_HIERARCHY_LABELS_ERROR,
  requiresSingleHopOrchestration,
  validateCanSpawnChild,
  validateSingleHopOrchestration,
  type HierarchyAgent,
  type PaseoToolPolicy,
} from "../hierarchy-policy.js";
import {
  getParentAddressFromLabels,
  isExplicitParentReportingLabels,
  isMainControlAgentLabels,
  isOpenAgentTabLabel,
  isSideChatAgent,
  AGENT_PROFILE_ID_MAX_LENGTH,
  RESIDENT_ROLE_MAX_LENGTH,
} from "@getpaseo/protocol/agent-labels";

export interface PaseoToolHostDependencies {
  agentMessages?: () => AgentMessageDelivery;
  queueAgentPrompt?: (
    agentId: string,
    message: Omit<RecoverableAgentMessage, "messageId">,
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

export function createPaseoToolCatalog(options: PaseoToolHostDependencies): PaseoToolCatalog {
  return createToolCatalog(options, options.callerAgentId ? "agent" : "top-level");
}

export function createPaseoAgentToolManifest(
  options: PaseoToolHostDependencies,
): Pick<PaseoToolCatalog, "tools"> {
  // Plugins register before a caller exists, but every execution uses an agent-bound catalog.
  return { tools: createToolCatalog(options, "agent").tools };
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
  const hostResolver = createHostResolver({
    serverId: options.serverId ?? "self",
    callerAgentId,
    trackRemoteChild:
      callerAgentId && options.finishSubscriptions
        ? (childAgentId, serverId) =>
            finishSubscriptions().trackRemoteChild({ childAgentId, callerAgentId, serverId })
        : undefined,
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
      title: resolveReportTitle(id, stored?.title, live?.config.title),
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
        snapshot: z.object({ id: z.string(), labels: z.record(z.string(), z.string()) }),
      })
      .safeParse(response.structuredContent);
    return parsed.success ? parsed.data.snapshot : null;
  }

  interface OrchestrationCheck {
    requireParentOwnership: boolean;
    targetLabels?: HierarchyAgent["labels"];
    allowLegacyDirectPrompt?: boolean;
  }

  async function checkHierarchy(
    name: string,
    args: { agentId?: string; serverId?: string; labels?: Record<string, string> },
    context: PaseoToolExecutionContext,
  ): Promise<OrchestrationCheck> {
    const unrestricted = { requireParentOwnership: false };
    if (!callerAgentId) return unrestricted;
    if (
      (name === "create_agent" || name === "update_agent") &&
      Object.keys(args.labels ?? {}).some(isOpenAgentTabLabel)
    ) {
      throw new PaseoToolInputError("Only clients can set open-tab labels.");
    }
    const path = await readAgentHierarchyPath(callerAgentId, readHierarchyAgent);
    const caller = path.get(callerAgentId);
    const read = (id: string) => path.get(id);
    const depth = computeAgentDepth(callerAgentId, read);
    if (name === "create_agent" && caller) validateCanSpawnChild(caller, read);
    if (
      !isPaseoToolEnabled(applyHierarchyPaseoToolPolicy(undefined, caller?.labels, depth), name)
    ) {
      throw new PaseoToolInputError(`Paseo tool is disabled for your hierarchy role: ${name}`);
    }
    const localServer = options.serverId ?? "self";
    const destination = args.serverId ?? localServer;
    const targetsSelf = args.agentId === callerAgentId && destination === localServer;
    if (name === "set_agent_mode" || name === "respond_to_permission") {
      if (targetsSelf) return unrestricted;
      if (depth >= 2) {
        throw new PaseoToolInputError(
          name === "set_agent_mode"
            ? "Level-2 subagents can only change their own mode."
            : "Level-2 subagents cannot respond to permission requests for other agents.",
        );
      }
    }
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

  const registerTool = (
    name: string,
    config: PaseoToolConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool handlers are schema-validated at registration boundaries.
    handler: (input: any, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
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
        await checkHierarchy(name, input, context);
        return run(input, context);
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
      return tool.handler(await parseToolInput(tool, input), context);
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
    activeTurnBehavior: ActiveTurnBehaviorSchema.optional().describe(
      'Agent callers: "steer" (default) waits until the current turn ends; "interrupt" replaces it. Human callers: "steer" joins the turn, falling back to interrupt; default is interrupt.',
    ),
    agentId: z.string(),
    prompt: z.string(),
    sessionMode: z.string().optional().describe("Optional mode to set before running the prompt."),
  };
  const agentToAgentSendAgentPromptInputSchema = {
    ...commonSendAgentPromptInputSchema,
    notifyOnFinish: z
      .boolean()
      .optional()
      .describe(
        "Get notified when the prompted agent finishes, errors, or needs permission. Defaults to true except for explicit-reporting agents, where it defaults to false.",
      ),
  };
  const topLevelSendAgentPromptInputSchema = {
    ...commonSendAgentPromptInputSchema,
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
      },
    },
    async (args: unknown) => {
      const resolvedArgs = await resolveCreateAgentToolArgs(args);
      const { parsedArgs } = resolvedArgs;
      const notifyOnFinish = parsedArgs.notifyOnFinish;
      const parentReporting =
        resolvedArgs.kind === "agent-scoped" ? resolvedArgs.parsedArgs.parentReporting : undefined;
      const { snapshot, initialPromptStarted } = await createAgentCommand(
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
          ...resolveCreateToolProviderSettings(parsedArgs),
          title: parsedArgs.title,
          initialPrompt: parsedArgs.initialPrompt,
          cwd: resolvedArgs.kind === "top-level" ? resolvedArgs.cwd : undefined,
          // Keep explicit placement for the final comparison after a concurrent parent move.
          workspaceId: resolvedArgs.workspaceId,
          labels: parsedArgs.labels,
          promptFailure: "throw",
          notifyOnFinish,
          parentReporting,
          background: parsedArgs.background,
          detached: resolvedArgs.kind === "top-level" && resolvedArgs.detached,
          callerAgentId,
          callerContext,
        },
      );

      // Return immediately for async creation.
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
          ...(guidance ? { guidance } : {}),
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
    if (input.resident ?? profile?.defaultResident) {
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

  function queuedPromptResponse(agentId: string, messageId: string, notifying: boolean) {
    return {
      content: [],
      structuredContent: {
        success: true,
        deliveryStatus: "queued" as const,
        messageId,
        status: agentManager.getAgent(agentId)?.lifecycle ?? "idle",
        guidance: notifying
          ? `Queued for delivery after two quiet seconds and the current turn ends. ${PROMPTED_AGENT_NOTIFICATION_GUIDANCE}`
          : "Queued for delivery after two quiet seconds and the current turn ends; provider dispatch has not occurred.",
      },
    };
  }

  async function enqueueLocalAgentPrompt(
    agentId: string,
    message: Omit<RecoverableAgentMessage, "messageId">,
  ): Promise<string> {
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
    try {
      const receipt = agentMessages().enqueue({
        recipientId: agentId,
        prompt: message.prompt,
        source: { kind: "agent-message", ...message.source },
        sessionMode: message.sessionMode,
        validateDispatch: parent
          ? async () => {
              const target = await readHierarchyAgent(agentId);
              assertDirectParent(target?.labels, parent.serverId, parent);
            }
          : undefined,
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

  registerTool(
    "send_agent_prompt",
    {
      title: "Send agent prompt",
      description:
        "Send a task. Agent callers receive an immediate queued receipt; delivery follows after two quiet seconds per recipient and waits for the current turn to end unless interrupt is requested. Completion reports include the target’s last response by default. Paseo supplies caller identity.",
      inputSchema: sendAgentPromptInputSchema,
      outputSchema: {
        success: z.boolean(),
        disposition: z.enum(["turn_started", "out_of_band", "steered"]).optional(),
        deliveryStatus: z.literal("queued").optional(),
        messageId: z.string().optional(),
        status: AgentStatusEnum,
        guidance: z.string().optional(),
      },
    },
    async ({
      agentId,
      prompt,
      sessionMode,
      requireParentOwnership,
      notifyOnFinish,
      activeTurnBehavior = callerAgentId ? "steer" : "interrupt",
    }) => {
      const target =
        callerAgentId && (agentManager.getAgent(agentId) ?? (await agentStorage.get(agentId)));
      if (callerAgentId && !target) {
        throw new PaseoToolInputError(`Agent ${agentId} not found`);
      }
      const notifying =
        !!target && (notifyOnFinish ?? !isExplicitParentReportingLabels(target.labels));
      if (callerAgentId) {
        const messageId = await enqueueLocalAgentPrompt(agentId, {
          prompt,
          source: {
            agentId: callerAgentId,
            serverId: requireParentOwnership ? options.serverId : undefined,
            title: resolveCallerAgent()?.config.title ?? undefined,
          },
          directParent: requireParentOwnership
            ? { agentId: callerAgentId, serverId: options.serverId ?? "self" }
            : undefined,
          sessionMode,
          activeTurnBehavior,
          unarchive: true,
          notifyLocalCaller: notifying,
          notifyOnFinish,
        });
        return queuedPromptResponse(agentId, messageId, notifying);
      }
      const dispatch = await sendPromptToAgent({
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
      const turnId = reportTurnId(callerAgentId);
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
      if (parent.serverId === localServer) {
        const target = await readHierarchyAgent(parent.agentId);
        if (!target || target.archivedAt) {
          throw new PaseoToolInputError(`Parent agent ${parent.agentId} is unavailable`);
        }
      } else {
        const target = await readRemoteParentForReport(parent).catch(() => undefined);
        if (target === null || target?.archivedAt) {
          throw new PaseoToolInputError(`Parent agent ${parent.agentId} is unavailable`);
        }
      }
      const messageId = await finishSubscriptions().queueParentReport(
        {
          childAgentId: callerAgentId,
          callerAgentId: parent.agentId,
          ...(parent.serverId === localServer ? {} : { callerServerId: parent.serverId }),
        },
        {
          status,
          summary,
          title: resolveReportTitle(callerAgentId, caller.title),
          turnId,
        },
      );
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
  return {
    paseoHome: options.paseoHome,
    paseoWorktreesBaseRoot: options.worktreesRoot,
    worktreeManagers: options.worktreeManagers,
    workspaceArchiveOperations: options.workspaceArchiveOperations,
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
