import type { FinishRegistration, FinishSubscriptions } from "../finish-subscriptions/index.js";
import type { AgentPromptSource } from "../agent-messages/index.js";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import type { MessageReceipts, QueueHandoff } from "../../message-receipts/index.js";
import type { Logger } from "pino";

import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { CreatePaseoWorktreeInput } from "../../paseo-worktree-service.js";
import { expandUserPath, isSameOrDescendantPath } from "../../path-utils.js";
import { toWorktreeRequestError } from "../../worktree-errors.js";
import type {
  CreatePaseoWorktreeWorkflowFn,
  CreatePaseoWorktreeWorkflowResult,
} from "../../worktree-session.js";
import type { AgentAttachment, FirstAgentContext } from "../../messages.js";
import {
  AgentCommandNotDispatchedError,
  type AgentManager,
  type CreateAgentOptions,
  type CreateReservedWorkspaceMain,
  type ManagedAgent,
} from "../agent-manager.js";
import type { AgentPromptInput, AgentRunOptions, AgentSessionConfig } from "../agent-sdk-types.js";
import type { AgentStorage } from "../agent-storage.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import type { AgentOwner } from "../agent-owner.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import { startCreatedAgentInitialPrompt } from "../agent-prompt.js";
import { resolveCreateAgentTitles } from "../create-agent-title.js";
import { buildAgentPrompt } from "../prompt-attachments.js";
import { normalizeClientMessageId, resolveClientMessageId } from "../../client-message-id.js";
import { resolveRequiredProviderModel, type ResolvedProviderModel } from "../mcp-shared.js";
import {
  AGENT_WORKSPACE_CREATION_ERROR,
  inheritAgentBackground,
  inheritWorkspaceBackground,
  resolveCreateAgentIntent,
} from "./intent.js";
import type { ProviderOptions } from "@getpaseo/protocol/agent-types";
import { foldFeatureValues, type LegacyFeatureValues } from "../option-controls.js";
import {
  AGENT_PROFILE_ID_LABEL,
  EXPLICIT_PARENT_REPORTING,
  getParentAddressFromLabels,
  isExplicitParentReportingLabels,
  isMainControlAgentLabels,
  getParentAgentIdFromLabels,
  LEAD_COMMIT_POLICY_LABEL,
  LEAD_PLAYBOOK_LABEL,
  MAIN_PRIOR_MODE_ID_LABEL,
  PARENT_AGENT_ID_LABEL,
  PARENT_REPORTING_LABEL,
  RESERVED_LEAD_PLAYBOOK_LABELS,
  WORKSPACE_ROLE_LABEL,
  type LeadCommitPolicy,
  type LeadPlaybook,
} from "@getpaseo/protocol/agent-labels";
import {
  readAgentHierarchyPath,
  MAX_SUBAGENT_DEPTH,
  REMOTE_HIERARCHY_DEPTH_LABEL,
  RESERVED_HIERARCHY_LABELS,
  RESERVED_RESIDENT_LABELS,
  resolveInheritedHierarchyMode,
  validateCanSpawnChild,
} from "../hierarchy-policy.js";
import { resolveLeadPlaybookInput } from "../orchestration-playbooks.js";

/** How a workspace this creation makes inherits its creator's visibility. */
interface McpWorkspaceIntent {
  background?: boolean;
  callerWorkspaceId?: string;
}

export interface CreateAgentCommandDependencies {
  serverId?: string;
  finishSubscriptions?: FinishSubscriptions;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  initialPromptReceipts?: Pick<MessageReceipts, "send">;
  logger: Logger;
  paseoHome?: string;
  worktreesRoot?: string;
  terminalManager?: TerminalManager | null;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "resolveCreateConfig">;
  workspaceRegistry?: Pick<WorkspaceRegistry, "get">;
  createPaseoWorktree?: CreatePaseoWorktreeWorkflowFn;
  // Mints a fresh directory workspace for a cwd and returns its id.
  ensureWorkspaceForCreate?: EnsureWorkspaceForCreate;
}

export type EnsureWorkspaceForCreate = (
  cwd: string,
  firstAgentContext?: FirstAgentContext,
  context?: { background?: boolean; callerWorkspaceId?: string },
) => Promise<string>;

export interface CreateAgentFromSessionInput {
  kind: "session";
  callerAgentId?: string;
  notifyParentOnInitialPrompt?: boolean;
  onAgentReady?: (agent: ManagedAgent) => Promise<void>;
  agentId?: string;
  /** Wire configs from older clients can still carry `featureValues`; they are folded on entry. */
  config: AgentSessionConfig & LegacyFeatureValues;
  workspaceId: string;
  workspaceRole?: "main";
  profileId?: string;
  background: boolean;
  initialPrompt?: string;
  forkedTimelineRows?: AgentTimelineRow[];
  source?: AgentPromptSource;
  clientMessageId?: string;
  outputSchema?: Record<string, unknown>;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: AgentAttachment[];
  labels: Record<string, string>;
  metadata?: CreateAgentOptions["metadata"];
  env?: Record<string, string>;
  provisionalTitle: string | null;
  firstAgentContext: FirstAgentContext;
}

export interface CreateAgentFromMcpInput {
  kind: "mcp";
  provider: string;
  title: string;
  initialPrompt?: string;
  config?: Partial<AgentSessionConfig>;
  cwd?: string;
  workspaceId?: string;
  thinking?: string;
  providerOptions?: ProviderOptions;
  labels?: Record<string, string>;
  mode?: string;
  unattended?: boolean;
  promptFailure?: CreateAgentPromptFailureMode;
  validateInitialPromptDispatch?: (agentId: string) => Promise<void>;
  initialPromptMessageId?: string;
  notifyOnFinish?: boolean;
  parentReporting?: "auto" | "explicit";
  playbook?: LeadPlaybook;
  commitPolicy?: LeadCommitPolicy;
  resident?: { profileId?: string; role?: string };
  internal?: boolean;
  /** Omitted with a caller, the caller agent's own background applies. */
  background?: boolean;
  detached?: boolean;
  owner?: AgentOwner;
  env?: Record<string, string>;
  onCreated?: (created: {
    agentId: string;
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  }) => void;
  onWorktreeCreated?: (createdWorktree: CreatePaseoWorktreeWorkflowResult) => void;
  callerAgentId?: string;
  callerContext?: {
    lockedCwd?: string;
    allowCustomCwd?: boolean;
    childAgentDefaultLabels?: Record<string, string>;
  } | null;

  worktree?: {
    worktreeName?: string;
    branchName?: string;
    baseBranch?: string;
    refName?: string;
    action?: "branch-off" | "checkout";
    githubPrNumber?: number;
  };
}

export type CreateAgentCommandInput = CreateAgentFromSessionInput | CreateAgentFromMcpInput;
export type CreateAgentPromptFailureMode = "throw" | "log" | "return-error";

export function shouldUseExplicitParentReporting(
  input: Partial<Pick<CreateAgentFromMcpInput, "parentReporting" | "notifyOnFinish" | "playbook">>,
  parentLabels: ManagedAgent["labels"] | undefined,
): boolean {
  return (
    input.playbook !== undefined ||
    input.parentReporting === "explicit" ||
    (input.parentReporting === undefined &&
      input.notifyOnFinish === false &&
      isMainControlAgentLabels(parentLabels))
  );
}

function applyMcpParentReporting(
  labels: Record<string, string>,
  input: CreateAgentFromMcpInput,
  parentLabels: ManagedAgent["labels"] | undefined,
): void {
  if (shouldUseExplicitParentReporting(input, parentLabels)) {
    labels[PARENT_REPORTING_LABEL] = EXPLICIT_PARENT_REPORTING;
  } else if (input.parentReporting === "auto") {
    labels[PARENT_REPORTING_LABEL] = input.parentReporting;
  }
}

export interface CreateAgentCommandResult {
  snapshot: ManagedAgent;
  liveSnapshot: ManagedAgent;
  initialPromptStarted: boolean;
  initialPromptError: unknown | null;
  createdWorktree?: CreatePaseoWorktreeWorkflowResult;
}

export type BoundCreateAgentCommand = (
  input: CreateAgentCommandInput,
) => Promise<CreateAgentCommandResult>;

export async function registerParentFinishSubscription({
  agentId,
  serverId,
  agentManager,
  agentStorage,
  finishSubscriptions,
  humanPrompt,
  logger,
}: {
  agentId: string;
  serverId?: string;
  agentManager: Pick<AgentManager, "getAgent" | "convergeLegacyParentReporting">;
  agentStorage: Pick<AgentStorage, "get">;
  finishSubscriptions?: FinishSubscriptions;
  humanPrompt?: boolean;
  logger?: Logger;
}): Promise<FinishRegistration | undefined> {
  const migratedParent = await agentManager.convergeLegacyParentReporting(agentId, humanPrompt);
  if (migratedParent) {
    await finishSubscriptions?.cancelAutomaticParent(agentId, migratedParent).catch((error) => {
      logger?.warn(
        { err: error, agentId, parentId: migratedParent },
        "Failed to retire parent finish subscription",
      );
    });
    return;
  }
  if (!finishSubscriptions) return;
  const agent = agentManager.getAgent(agentId) ?? (await agentStorage.get(agentId));
  if (isExplicitParentReportingLabels(agent?.labels)) return;
  const parentId = getParentAgentIdFromLabels(agent?.labels);
  if (!parentId || parentId === agentId) return;
  const parentAddress = serverId && getParentAddressFromLabels(agent?.labels, serverId);
  if (parentAddress && parentAddress.serverId !== serverId) {
    if (agent?.labels?.[REMOTE_HIERARCHY_DEPTH_LABEL] === String(MAX_SUBAGENT_DEPTH)) return;
    return finishSubscriptions.register(
      {
        childAgentId: agentId,
        callerAgentId: parentId,
        callerServerId: parentAddress.serverId,
        requireParentOwnership: true,
        followupReport: true,
      },
      true,
    );
  }
  const storedParent = await agentStorage.get(parentId);
  if (storedParent ? storedParent.archivedAt : !agentManager.getAgent(parentId)) return;
  return finishSubscriptions.register(
    {
      childAgentId: agentId,
      callerAgentId: parentId,
      requireParentOwnership: true,
      automaticParent: true,
      canRegister: () => {
        const labels = agentManager.getAgent(agentId)?.labels ?? agent?.labels;
        return (
          !isExplicitParentReportingLabels(labels) &&
          getParentAgentIdFromLabels(labels) === parentId &&
          (!serverId || getParentAddressFromLabels(labels, serverId)?.serverId === serverId)
        );
      },
    },
    true,
  );
}

function requireResolvedWorkspaceId(workspaceId: string | undefined): string {
  if (!workspaceId) {
    throw new Error("createAgentCommand requires a resolved workspaceId");
  }
  return workspaceId;
}

export function formatProviderModel(provider: string, model: string | null | undefined): string {
  if (!model || provider.includes("/")) {
    return provider;
  }
  return `${provider}/${model}`;
}

function resolveProviderModel(providerValue: string): ResolvedProviderModel {
  const providerInput = providerValue.trim();
  if (providerInput.includes("/")) {
    return resolveRequiredProviderModel(providerInput);
  }
  if (!providerInput) {
    throw new Error("provider is required");
  }
  return { provider: providerInput, model: undefined };
}

interface ResolvedCreateAgent {
  config: AgentSessionConfig;
  createOptions: CreateAgentOptions;
  prompt?: AgentPromptInput;
  source?: AgentPromptSource;
  runOptions?: AgentRunOptions;
  promptFailure: CreateAgentPromptFailureMode;
  promptLogger?: Logger;
  createdWorktree?: CreatePaseoWorktreeWorkflowResult;
}

export async function createAgentCommand(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
  options?: Pick<CreateAgentOptions, "inheritParentWorkspace">,
): Promise<CreateAgentCommandResult> {
  if (input.callerAgentId) await validateCreateCaller(dependencies, input.callerAgentId);
  const resolved =
    input.kind === "session"
      ? await resolveSessionCreateAgent(dependencies, input, options)
      : await resolveMcpCreateAgent(dependencies, input);

  applyCreateLabelPolicy(resolved.createOptions.labels, input);
  if (input.kind === "session" && input.workspaceRole === "main") {
    return dependencies.agentManager.withWorkspaceMainCreation(
      { workspaceId: input.workspaceId, agentId: input.agentId },
      (createMain) => createResolvedAgent(dependencies, input, resolved, createMain),
    );
  }
  return createResolvedAgent(dependencies, input, resolved);
}

async function createResolvedAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
  resolved: ResolvedCreateAgent,
  createMain?: CreateReservedWorkspaceMain,
): Promise<CreateAgentCommandResult> {
  const snapshot = await registerResolvedAgent(dependencies, input, resolved, createMain);

  if (input.kind === "session") await input.onAgentReady?.(snapshot);

  let liveSnapshot = snapshot;
  let initialPromptStarted = false;
  let initialPromptError: unknown | null = null;
  if (input.kind === "mcp") {
    input.onCreated?.({ agentId: snapshot.id, createdWorktree: resolved.createdWorktree ?? null });
  }
  if (resolved.prompt !== undefined) {
    const notification = await registerInitialPromptFinish(dependencies, input, snapshot);
    const rejectNotification = async () => {
      await notification?.reject().catch((rejectError) => {
        dependencies.logger.warn(
          { err: rejectError, agentId: snapshot.id },
          "Failed to remove rejected finish subscription",
        );
      });
    };
    const validateDispatch = input.kind === "mcp" ? input.validateInitialPromptDispatch : undefined;
    const sendResult = await sendInitialPrompt(
      dependencies,
      resolved,
      snapshot,
      !!createMain,
      validateDispatch,
    ).catch(async (error) => {
      await rejectNotification();
      throw error;
    });
    if (sendResult.started) notification?.accept();
    else await rejectNotification();
    initialPromptStarted = sendResult.started;
    liveSnapshot = sendResult.liveSnapshot;
    initialPromptError = sendResult.error ?? null;
  }

  return {
    snapshot,
    liveSnapshot,
    initialPromptStarted,
    initialPromptError,
    ...(resolved.createdWorktree ? { createdWorktree: resolved.createdWorktree } : {}),
  };
}

function registerResolvedAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
  resolved: ResolvedCreateAgent,
  createMain?: CreateReservedWorkspaceMain,
): Promise<ManagedAgent> {
  if (createMain) return createMain(resolved.config, resolved.createOptions);
  if (input.kind === "mcp" && input.resident)
    return createMcpResident(dependencies, input, resolved);
  return dependencies.agentManager.createAgent(
    resolved.config,
    input.kind === "session" ? input.agentId : undefined,
    resolved.createOptions,
  );
}

function applyCreateLabelPolicy(
  labels: CreateAgentOptions["labels"],
  input: CreateAgentCommandInput,
): void {
  if (!labels) return;
  delete labels[WORKSPACE_ROLE_LABEL];
  delete labels[MAIN_PRIOR_MODE_ID_LABEL];
  for (const label of RESERVED_RESIDENT_LABELS) delete labels[label];
  for (const label of RESERVED_LEAD_PLAYBOOK_LABELS) delete labels[label];
  if (input.kind === "session" && input.workspaceRole === "main" && input.profileId) {
    labels[AGENT_PROFILE_ID_LABEL] = input.profileId;
  }
  if (input.kind === "mcp" && input.playbook) {
    labels[LEAD_PLAYBOOK_LABEL] = input.playbook;
    labels[LEAD_COMMIT_POLICY_LABEL] =
      input.playbook === "readonly_cr" ? "none" : (input.commitPolicy ?? "none");
  }
}

async function createMcpResident(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromMcpInput,
  resolved: ResolvedCreateAgent,
): Promise<ManagedAgent> {
  if (!input.callerAgentId || input.detached || resolved.createOptions.background) {
    throw new Error("Resident specialists must be visible subagents in the caller's workspace.");
  }
  const { agentManager, agentStorage, logger } = dependencies;
  const { inheritParentWorkspace, workspaceId: resolvedWorkspaceId } = resolved.createOptions;
  const expectedWorkspaceId = inheritParentWorkspace ? undefined : resolvedWorkspaceId;
  const { agentId, created } = await agentManager.createSilentResidentSubagent({
    ...input.resident,
    parentAgentId: input.callerAgentId,
    expectedWorkspaceId,
    provider: resolved.config.provider,
    config: resolved.config,
  });
  if (!created) {
    throw new Error(
      `Resident specialist ${agentId} already exists. Use send_agent_prompt with its agentId.`,
    );
  }
  const record = await agentStorage.get(agentId);
  const workspaceId = record?.workspaceId;
  if (!workspaceId || (expectedWorkspaceId !== undefined && expectedWorkspaceId !== workspaceId)) {
    throw new Error("The caller's workspace changed during resident creation.");
  }
  const labels = { ...resolved.createOptions.labels };
  for (const key of RESERVED_HIERARCHY_LABELS) delete labels[key];
  for (const key of RESERVED_LEAD_PLAYBOOK_LABELS) delete labels[key];
  if (Object.keys(labels).length) {
    await agentManager.updateAgentMetadata(agentId, { labels, expectedWorkspaceId: workspaceId });
  }
  return ensureAgentLoaded(agentId, { agentManager, agentStorage, logger });
}

async function validateCreateCaller(
  dependencies: CreateAgentCommandDependencies,
  callerAgentId: string,
): Promise<void> {
  const path = await readAgentHierarchyPath(callerAgentId, async (id) => {
    const stored = await dependencies.agentStorage.get(id);
    return stored?.archivedAt ? stored : (dependencies.agentManager.getAgent(id) ?? stored);
  });
  const parent = path.get(callerAgentId);
  if (!parent) throw new Error(`Parent agent ${callerAgentId} not found`);
  validateCanSpawnChild(parent, (id) => path.get(id));
}

function registerInitialPromptFinish(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
  child: ManagedAgent,
): Promise<FinishRegistration> | undefined {
  if (!input.callerAgentId) return;
  let notify: boolean | undefined;
  if (input.kind === "mcp") {
    notify = input.playbook ? false : input.notifyOnFinish;
  } else {
    notify = input.notifyParentOnInitialPrompt;
  }
  if (!(notify ?? !isExplicitParentReportingLabels(child.labels))) return;
  const subscriptions =
    input.kind === "mcp"
      ? requireFinishSubscriptions(dependencies)
      : dependencies.finishSubscriptions;
  const automaticParent = notify === undefined && (input.kind === "session" || !input.detached);
  return subscriptions?.register(
    {
      childAgentId: child.id,
      callerAgentId: input.callerAgentId,
      requireParentOwnership: input.kind === "session" || !input.detached,
      automaticParent,
      canRegister: automaticParent
        ? () => {
            const labels = dependencies.agentManager.getAgent(child.id)?.labels ?? child.labels;
            return (
              !isExplicitParentReportingLabels(labels) &&
              getParentAgentIdFromLabels(labels) === input.callerAgentId
            );
          }
        : undefined,
    },
    true,
  );
}

async function resolveSessionCreateAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromSessionInput,
  options?: Pick<CreateAgentOptions, "inheritParentWorkspace">,
): Promise<ResolvedCreateAgent> {
  const trimmedPrompt = input.initialPrompt?.trim();
  const builtSessionConfig = foldFeatureValues(input.config);
  const resolvedCreateConfig = await dependencies.providerSnapshotManager.resolveCreateConfig({
    cwd: builtSessionConfig.cwd,
    provider: builtSessionConfig.provider,
    requestedMode: builtSessionConfig.modeId,
    providerOptions: builtSessionConfig.providerOptions,
    parent: null,
    unattended: false,
  });
  const sessionConfig: AgentSessionConfig = {
    ...builtSessionConfig,
    modeId: resolvedCreateConfig.modeId,
    providerOptions: resolvedCreateConfig.providerOptions,
  };
  const prompt = buildAgentPrompt(trimmedPrompt ?? "", input.images, input.attachments);
  const hasPromptContent = Array.isArray(prompt) ? prompt.length > 0 : prompt.length > 0;
  const clientMessageId = normalizeClientMessageId(input.clientMessageId);
  const runOptions: AgentRunOptions | undefined =
    input.outputSchema || clientMessageId
      ? {
          ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
          ...(clientMessageId ? { clientMessageId } : {}),
        }
      : undefined;
  const workspaceId = input.workspaceId;
  const labels: Record<string, string> = {
    ...input.labels,
    ...(input.callerAgentId ? { [PARENT_AGENT_ID_LABEL]: input.callerAgentId } : {}),
  };
  const parent = getParentAddressFromLabels(labels, dependencies.serverId ?? "");
  const isRemoteChild =
    parent && dependencies.serverId && parent.serverId !== dependencies.serverId;
  if (!input.callerAgentId && !isRemoteChild) {
    delete labels[PARENT_REPORTING_LABEL];
  }

  return {
    config: sessionConfig,
    createOptions: {
      labels,
      metadata: input.metadata,
      initialPrompt: trimmedPrompt,
      forkedTimelineRows: input.forkedTimelineRows,
      env: input.env,
      initialTitle: input.provisionalTitle,
      // Paseo never persists an internal agent, so nothing could resume its
      // provider session either. Same as the daemon's own ephemeral helpers.
      ...(sessionConfig.internal ? { persistSession: false } : {}),
      workspaceId: requireResolvedWorkspaceId(workspaceId),
      ...(options?.inheritParentWorkspace ? { inheritParentWorkspace: true } : {}),
      background: input.background,
    },
    prompt: hasPromptContent ? prompt : undefined,
    source: input.source,
    runOptions,
    // Registration commits creation. First-turn failures belong to the created agent.
    promptFailure: "return-error",
    promptLogger: dependencies.logger.child({
      clientMessageId: resolveClientMessageId(input.clientMessageId),
    }),
  };
}

async function resolveMcpCreateAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromMcpInput,
): Promise<ResolvedCreateAgent> {
  const resolvedProviderModel = resolveProviderModel(input.provider);
  const provider = resolvedProviderModel.provider;
  const parentAgent = input.callerAgentId
    ? requireParentAgent(dependencies.agentManager, input.callerAgentId)
    : null;
  assertMcpCallerPlacement(input, parentAgent, dependencies.workspaceRegistry);
  resolveLeadPlaybookInput({
    playbook: input.playbook,
    commitPolicy: input.commitPolicy,
    callerLabels: parentAgent?.labels,
    resident: Boolean(input.resident),
    parentReporting: input.parentReporting,
    notifyOnFinish: input.notifyOnFinish,
  });
  const cwd = resolveMcpInitialCwd(input, parentAgent);
  const workspaceIntent = {
    background: inheritWorkspaceBackground(input.background, parentAgent),
    callerWorkspaceId: parentAgent?.workspaceId,
  };
  const { resolvedCwd, createdWorkspaceId, createdWorktree } = await resolveMcpCwd({
    dependencies,
    cwd,
    worktree: input.worktree,
    initialPrompt: input.initialPrompt ?? "",
    workspaceIntent,
  });
  if (createdWorktree) input.onWorktreeCreated?.(createdWorktree);
  const intent = await resolveMcpAgentIntent({
    dependencies,
    input,
    parentAgent,
    resolvedCwd,
    createdWorkspaceId,
    workspaceIntent,
  });
  if (intent.parentAgentId) applyMcpParentReporting(intent.labels, input, parentAgent?.labels);
  const resolvedCreateConfig = await resolveMcpProviderCreateConfig({
    dependencies,
    input,
    provider,
    resolvedCwd,
    parentAgent,
  });

  const trimmedPrompt = input.initialPrompt?.trim() ?? "";
  return {
    config: buildMcpSessionConfig({
      input,
      resolvedProviderModel,
      provider,
      resolvedCwd: intent.cwd,
      trimmedPrompt,
      resolvedMode: resolvedCreateConfig.modeId,
      resolvedProviderOptions: resolvedCreateConfig.providerOptions,
    }),
    createOptions: {
      ...(Object.keys(intent.labels).length > 0 ? { labels: intent.labels } : {}),
      workspaceId: intent.workspaceId,
      inheritParentWorkspace:
        Boolean(intent.parentAgentId) && !createdWorkspaceId && input.workspaceId === undefined,
      owner: input.owner,
      background: inheritAgentBackground(input.background, parentAgent),
      env: input.env,
    },
    prompt: trimmedPrompt ? trimmedPrompt : undefined,
    runOptions: input.initialPromptMessageId
      ? { clientMessageId: input.initialPromptMessageId }
      : undefined,
    source: input.callerAgentId
      ? { kind: "agent-message", agentId: input.callerAgentId }
      : undefined,
    createdWorktree,
    promptFailure: input.promptFailure ?? "log",
  };
}

function resolveMcpInitialCwd(
  input: CreateAgentFromMcpInput,
  parentAgent: ManagedAgent | null,
): string {
  if (!parentAgent) {
    return expandUserPath(input.cwd ?? process.cwd());
  }
  const lockedCwd = input.callerContext?.lockedCwd?.trim();
  if (lockedCwd && !isSameOrDescendantPath(expandUserPath(lockedCwd), parentAgent.cwd)) {
    throw new Error("The parent workspace is outside the allowed working directory.");
  }
  return parentAgent.cwd;
}

function assertMcpCallerPlacement(
  input: CreateAgentFromMcpInput,
  parentAgent: ManagedAgent | null,
  workspaceRegistry: CreateAgentCommandDependencies["workspaceRegistry"],
): void {
  if (parentAgent && (!workspaceRegistry || hasMcpWorktreeRequest(input.worktree))) {
    throw new Error(AGENT_WORKSPACE_CREATION_ERROR);
  }
}

async function resolveMcpAgentIntent(params: {
  dependencies: CreateAgentCommandDependencies;
  input: CreateAgentFromMcpInput;
  parentAgent: ManagedAgent | null;
  resolvedCwd: string;
  createdWorkspaceId?: string;
  workspaceIntent: McpWorkspaceIntent;
}) {
  const { dependencies, input, parentAgent, resolvedCwd, createdWorkspaceId, workspaceIntent } =
    params;
  return resolveCreateAgentIntent({
    explicitWorkspaceId: createdWorkspaceId ?? input.workspaceId,
    caller: parentAgent,
    labels: input.labels,
    serverId: dependencies.serverId,
    childAgentDefaultLabels: input.callerContext?.childAgentDefaultLabels,
    legacyDetached: input.detached ?? false,
    resolveWorkspace: async (workspaceId) => {
      const workspace = await dependencies.workspaceRegistry?.get(workspaceId);
      if (dependencies.workspaceRegistry && (!workspace || workspace.archivedAt)) {
        if (parentAgent) throw new Error(AGENT_WORKSPACE_CREATION_ERROR);
        throw new Error(`Workspace ${workspaceId} not found`);
      }
      return { workspaceId, cwd: resolvedCwd };
    },
    createWorkspace: async () => ({
      workspaceId: requireResolvedWorkspaceId(
        await ensureWorkspaceForMcpCreate(
          dependencies,
          resolvedCwd,
          input.initialPrompt ?? "",
          workspaceIntent,
        ),
      ),
      cwd: resolvedCwd,
    }),
  });
}

async function resolveMcpProviderCreateConfig(params: {
  dependencies: CreateAgentCommandDependencies;
  input: CreateAgentFromMcpInput;
  provider: string;
  resolvedCwd: string;
  parentAgent: ManagedAgent | null;
}): Promise<{ modeId?: string; providerOptions?: ProviderOptions }> {
  const passthroughConfig = params.input.config;
  const parent = params.parentAgent;
  return params.dependencies.providerSnapshotManager.resolveCreateConfig({
    cwd: params.resolvedCwd,
    provider: params.provider,
    requestedMode: params.input.mode ?? passthroughConfig?.modeId,
    providerOptions: mergeMcpProviderOptions(params.input),
    parent: parent && {
      ...parent,
      currentModeId: resolveInheritedHierarchyMode(parent.currentModeId, parent.labels) ?? null,
      effectiveOptions: isMainControlAgentLabels(parent.labels)
        ? parent.config.providerOptions
        : parent.effectiveOptions,
    },
    unattended: params.input.unattended ?? false,
  });
}

function mergeMcpProviderOptions(input: CreateAgentFromMcpInput): ProviderOptions | undefined {
  if (!input.providerOptions) return input.config?.providerOptions;
  return { ...input.config?.providerOptions, ...input.providerOptions };
}

function buildMcpSessionConfig(params: {
  input: CreateAgentFromMcpInput;
  resolvedProviderModel: ResolvedProviderModel;
  provider: string;
  resolvedCwd: string;
  trimmedPrompt: string;
  resolvedMode?: string;
  resolvedProviderOptions?: ProviderOptions;
}): AgentSessionConfig {
  const passthroughConfig = params.input.config;
  const { provisionalTitle } = resolveCreateAgentTitles({
    configTitle: passthroughConfig?.title ?? params.input.title,
    initialPrompt: params.trimmedPrompt,
  });
  const providerOptions = params.resolvedProviderOptions ?? mergeMcpProviderOptions(params.input);
  const config: AgentSessionConfig = {
    ...passthroughConfig,
    provider: params.provider,
    cwd: params.resolvedCwd,
    modeId: params.resolvedMode ?? passthroughConfig?.modeId,
    model: params.resolvedProviderModel.model ?? passthroughConfig?.model,
    thinkingOptionId: params.input.thinking ?? passthroughConfig?.thinkingOptionId,
    internal: params.input.internal ?? passthroughConfig?.internal,
  };
  if (provisionalTitle) {
    config.title = provisionalTitle;
  }
  if (providerOptions) {
    config.providerOptions = providerOptions;
  }
  return config;
}

async function ensureWorkspaceForMcpCreate(
  dependencies: CreateAgentCommandDependencies,
  cwd: string,
  initialPrompt: string,
  workspaceIntent: McpWorkspaceIntent,
): Promise<string | undefined> {
  if (!dependencies.ensureWorkspaceForCreate) {
    return undefined;
  }
  return dependencies.ensureWorkspaceForCreate(cwd, { prompt: initialPrompt }, workspaceIntent);
}

async function sendInitialPrompt(
  dependencies: CreateAgentCommandDependencies,
  resolved: ResolvedCreateAgent,
  snapshot: ManagedAgent,
  waitForCommandOutcome: boolean,
  validateDispatch?: (agentId: string) => Promise<void>,
): Promise<{ started: boolean; liveSnapshot: ManagedAgent; error?: unknown }> {
  try {
    const prompt = resolved.prompt;
    if (prompt === undefined) {
      return { started: false, liveSnapshot: snapshot };
    }
    if (validateDispatch) await validateDispatch(snapshot.id);
    const start = (handoff?: QueueHandoff) =>
      startCreatedAgentInitialPrompt({
        agentStorage: dependencies.agentStorage,
        agentManager: dependencies.agentManager,
        agentId: snapshot.id,
        snapshot,
        prompt,
        source: resolved.source,
        runOptions: validateDispatch
          ? { ...resolved.runOptions, waitForProviderPrompt: true }
          : resolved.runOptions,
        handoff,
        waitForCommandOutcome: waitForCommandOutcome || !!validateDispatch,
        validateDispatch: validateDispatch ? () => validateDispatch(snapshot.id) : undefined,
        logger: resolved.promptLogger ?? dependencies.logger,
      });
    const messageId = resolved.runOptions?.clientMessageId;
    let liveSnapshot = snapshot;
    if (messageId && dependencies.initialPromptReceipts) {
      await dependencies.initialPromptReceipts.send({
        agentId: snapshot.id,
        messageId,
        // Match a normal human send, so a retry of the first message uses the same receipt.
        request: { prompt, activeTurnBehavior: "interrupt" },
        retryIfUnsent: (error) => error instanceof AgentCommandNotDispatchedError,
        send: async (begin, declined, onProviderOutcome) => {
          liveSnapshot = await start({ begin, declined, onProviderOutcome });
        },
      });
    } else {
      liveSnapshot = await start();
    }
    return { started: true, liveSnapshot };
  } catch (error) {
    if (resolved.promptFailure === "throw") {
      throw error;
    }
    if (resolved.promptFailure === "return-error") {
      return {
        started: false,
        liveSnapshot: dependencies.agentManager.getAgent(snapshot.id) ?? snapshot,
        error,
      };
    }
    dependencies.logger.error({ err: error, agentId: snapshot.id }, "Failed to run initial prompt");
    return { started: false, liveSnapshot: snapshot };
  }
}

function requireParentAgent(agentManager: AgentManager, parentAgentId: string): ManagedAgent {
  const parentAgent = agentManager.getAgent(parentAgentId);
  if (!parentAgent) {
    throw new Error(`Parent agent ${parentAgentId} not found`);
  }
  return parentAgent;
}

interface CreateMcpWorktreeOptions {
  input: CreatePaseoWorktreeInput;
  createPaseoWorktree: CreatePaseoWorktreeWorkflowFn | undefined;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
}

function hasMcpWorktreeRequest(worktree: CreateAgentFromMcpInput["worktree"]): boolean {
  return Boolean(
    worktree &&
    (worktree.worktreeName || worktree.refName || worktree.action || worktree.githubPrNumber),
  );
}

async function createMcpWorktree(
  options: CreateMcpWorktreeOptions,
): Promise<CreatePaseoWorktreeWorkflowResult> {
  try {
    if (!options.createPaseoWorktree) {
      throw new Error("Paseo worktree service is not configured");
    }
    return await options.createPaseoWorktree(
      options.input,
      options.resolveDefaultBranch ? { resolveDefaultBranch: options.resolveDefaultBranch } : {},
    );
  } catch (error) {
    throw toWorktreeRequestError(error);
  }
}

async function resolveMcpCwd(params: {
  dependencies: CreateAgentCommandDependencies;
  cwd: string;
  initialPrompt: string;
  workspaceIntent: McpWorkspaceIntent;
  worktree: CreateAgentFromMcpInput["worktree"];
}): Promise<{
  resolvedCwd: string;
  createdWorkspaceId?: string;
  createdWorktree?: CreatePaseoWorktreeWorkflowResult;
}> {
  const { dependencies, worktree } = params;
  if (!worktree) {
    return { resolvedCwd: params.cwd };
  }
  const shouldCreateWorktree = hasMcpWorktreeRequest(worktree);
  if (!shouldCreateWorktree) {
    return { resolvedCwd: params.cwd };
  }
  if (
    worktree.worktreeName &&
    !worktree.baseBranch &&
    !worktree.refName &&
    !worktree.action &&
    worktree.githubPrNumber === undefined
  ) {
    throw new Error("baseBranch is required when creating a worktree");
  }
  const baseBranch = worktree.baseBranch;
  const createdWorktree = await createMcpWorktree({
    input: {
      cwd: params.cwd,
      ...params.workspaceIntent,
      worktreeSlug: worktree.worktreeName,
      branchName: worktree.branchName,
      refName: worktree.refName,
      action: worktree.action,
      githubPrNumber: worktree.githubPrNumber,
      firstAgentContext: { prompt: params.initialPrompt },

      paseoHome: dependencies.paseoHome,
      worktreesRoot: dependencies.worktreesRoot,
    },
    createPaseoWorktree: dependencies.createPaseoWorktree,
    resolveDefaultBranch: baseBranch ? async () => baseBranch : undefined,
  });
  return {
    resolvedCwd: createdWorktree.workspace.cwd,
    createdWorkspaceId: createdWorktree.workspace.workspaceId,
    createdWorktree,
  };
}

function requireFinishSubscriptions(
  dependencies: CreateAgentCommandDependencies,
): FinishSubscriptions {
  if (!dependencies.finishSubscriptions) throw new Error("Finish subscriptions are not configured");
  return dependencies.finishSubscriptions;
}
