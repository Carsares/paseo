import type { AgentModelDefinition, AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ModelBrowserView } from "@/components/model-browser-view";
import type { CrossProviderHandoffSelection } from "@/composer/cross-provider-handoff";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";

export const MAX_WORKSPACE_BATCH_MODELS = 4;

export interface WorkspaceBatchModel {
  provider: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
}

export interface WorkspaceBatchModelPicker {
  models: readonly WorkspaceBatchModel[];
  disabledReason?: string;
  onChange: (models: WorkspaceBatchModel[]) => void;
}

export function sameWorkspaceBatchModel(
  left: WorkspaceBatchModel,
  right: WorkspaceBatchModel,
): boolean {
  return left.provider === right.provider && left.modelId === right.modelId;
}

export function toggleWorkspaceBatchModel(input: {
  models: readonly WorkspaceBatchModel[];
  model: WorkspaceBatchModel;
  disabled?: boolean;
}): WorkspaceBatchModel[] | null {
  const { models, model, disabled } = input;
  if (disabled) return null;
  if (models.some((selected) => sameWorkspaceBatchModel(selected, model))) {
    return models.filter((selected) => !sameWorkspaceBatchModel(selected, model));
  }
  return models.length >= MAX_WORKSPACE_BATCH_MODELS ? null : [...models, model];
}

export function findWorkspaceBatchModel(
  providers: readonly ProviderSelectorProvider[],
  provider: string,
  modelId: string,
): WorkspaceBatchModel | undefined {
  const selection = providers.find((entry) => entry.id === provider)?.modelSelection;
  return selection?.kind === "models"
    ? selection.rows.find((row) => row.modelId === modelId)
    : undefined;
}

export function resolveModelSheetOpening({
  canSwitchProvider,
  providers,
  selectedProvider,
}: {
  canSwitchProvider: boolean;
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
}): ModelBrowserView {
  if (canSwitchProvider) return { kind: "all" };

  const provider = providers.find((entry) => entry.id === selectedProvider) ?? providers[0] ?? null;
  return provider
    ? { kind: "provider", providerId: provider.id, providerLabel: provider.label }
    : { kind: "all" };
}

export type ThinkingPrecheckAction =
  | { kind: "none" }
  | { kind: "clear"; previousThinkingOptionId: string }
  | {
      kind: "adjust";
      thinkingOptionId: string;
      thinkingLabel: string;
      previousThinkingOptionId: string | null;
    };

function normalizeThinkingId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "default") return null;
  return trimmed;
}

export function precheckModelThinkingCompatibility(input: {
  targetModel: AgentModelDefinition | null | undefined;
  currentThinkingOptionId: string | null | undefined;
  savedThinkingOptionId?: string | null | undefined;
}): ThinkingPrecheckAction {
  const { targetModel } = input;
  if (!targetModel) {
    return { kind: "none" };
  }

  const normalizedCurrent = normalizeThinkingId(input.currentThinkingOptionId);
  const options = targetModel.thinkingOptions ?? [];

  if (options.length === 0) {
    return normalizedCurrent
      ? { kind: "clear", previousThinkingOptionId: normalizedCurrent }
      : { kind: "none" };
  }

  if (normalizedCurrent && options.some((option) => option.id === normalizedCurrent)) {
    return { kind: "none" };
  }

  const normalizedSaved = normalizeThinkingId(input.savedThinkingOptionId);
  const savedMatch = normalizedSaved
    ? options.find((option) => option.id === normalizedSaved)
    : undefined;
  const defaultMatch =
    options.find((option) => option.id === targetModel.defaultThinkingOptionId) ??
    options.find((option) => option.isDefault) ??
    options[0];

  const chosen = savedMatch ?? defaultMatch;
  if (!chosen) {
    return { kind: "none" };
  }

  return {
    kind: "adjust",
    thinkingOptionId: chosen.id,
    thinkingLabel: chosen.label,
    previousThinkingOptionId: normalizedCurrent,
  };
}

export type CrossProviderContextMode = "carry-summary" | "fresh-blank";

/**
 * Blank-context cross-provider switch requires both `workspace.write` and `hub.execute`
 * (matching `resetAgentSession`). When optional host permissions are omitted, allow it.
 */
export function hasBlankContextSwitchPermissions(
  permissions: readonly string[] | undefined,
): boolean {
  if (!permissions) return true;
  return permissions.includes("workspace.write") && permissions.includes("hub.execute");
}

export type TopicMetadataDisclosureState =
  | { status: "none" }
  | { status: "present"; hideFromModel: boolean }
  | { status: "unverified" };

export interface LiveTopicWorkspaceClient {
  findWorkspace: (
    workspaceId: string,
  ) => Promise<{ topic?: { hideFromModel?: boolean } | null } | null>;
}

/**
 * Reads live topic visibility from the authoritative host rather than cached workspace queries.
 * When live lookup fails for a topic-capable Main Control seat, returns `"unverified"` so the UI
 * discloses conservatively instead of claiming no topic metadata will be sent.
 */
export async function readLiveTopicMetadataDisclosure(input: {
  client: LiveTopicWorkspaceClient | null;
  workspaceId: string | null | undefined;
  isMainControl: boolean;
  supportsTopic: boolean;
}): Promise<TopicMetadataDisclosureState> {
  if (!input.isMainControl || !input.supportsTopic || !input.workspaceId) {
    return { status: "none" };
  }
  if (!input.client) {
    return { status: "unverified" };
  }
  try {
    const descriptor = await input.client.findWorkspace(input.workspaceId);
    if (!descriptor?.topic) {
      return { status: "none" };
    }
    return { status: "present", hideFromModel: descriptor.topic.hideFromModel === true };
  } catch {
    return { status: "unverified" };
  }
}

export function didTopicMetadataDisclosureChange(
  previous: TopicMetadataDisclosureState,
  next: TopicMetadataDisclosureState,
): boolean {
  if (previous.status !== next.status) {
    return true;
  }
  if (previous.status === "present" && next.status === "present") {
    return previous.hideFromModel !== next.hideFromModel;
  }
  return false;
}

export type CrossProviderOutboundItem =
  | "handoff-summary"
  | "topic-metadata"
  | "topic-hidden"
  | "topic-unverified"
  | "task-ledger"
  | "role-prompt"
  | "blank-only";

export type CrossProviderDisclosureChangeReason = "none" | "topic" | "session";

export interface CrossProviderSwitchDisclosurePlan {
  sourceProvider: string;
  sourceProviderLabel: string;
  targetProvider: string;
  targetProviderLabel: string;
  targetModelId: string;
  targetModelLabel: string;
  isSilentSeat: boolean;
  isRunning: boolean;
  hasConversationHistory: boolean;
  topicMetadataState: TopicMetadataDisclosureState;
  disclosureChangedReason: CrossProviderDisclosureChangeReason;
  hasWorkspaceTaskLedger: boolean;
  hasRolePrompt: boolean;
  pendingPermissionsCount: number;
  thinkingPrecheck: ThinkingPrecheckAction;
  canChooseFreshBlank: boolean;
  defaultContextMode: CrossProviderContextMode;
}

export function isAgentTurnRunning(
  status: string | null | undefined,
  turnPhase: string | null | undefined,
): boolean {
  return status === "running" || status === "initializing" || turnPhase === "open";
}

export function buildCrossProviderSwitchDisclosurePlan(input: {
  sourceProvider: string;
  sourceProviderLabel: string;
  targetProvider: string;
  targetProviderLabel: string;
  targetModelId: string;
  targetModelLabel: string;
  targetModel: AgentModelDefinition | null | undefined;
  currentThinkingOptionId: string | null | undefined;
  savedThinkingOptionId?: string | null | undefined;
  skipThinkingPrecheck?: boolean;
  agentStatus: string;
  turnPhase: string;
  hasConversationHistory: boolean;
  topicMetadataState: TopicMetadataDisclosureState;
  hasWorkspaceTaskLedger: boolean;
  hasRolePrompt: boolean;
  pendingPermissionsCount: number;
  /** True only when the protocol/host supports an atomic blank-context cross-provider switch. */
  supportsAtomicBlankContextSwitch: boolean;
}): CrossProviderSwitchDisclosurePlan {
  const isSilentSeat = input.agentStatus === "closed" && !input.hasConversationHistory;
  const isRunning = isAgentTurnRunning(input.agentStatus, input.turnPhase);
  const thinkingPrecheck: ThinkingPrecheckAction = input.skipThinkingPrecheck
    ? { kind: "none" }
    : precheckModelThinkingCompatibility({
        targetModel: input.targetModel,
        currentThinkingOptionId: input.currentThinkingOptionId,
        savedThinkingOptionId: input.savedThinkingOptionId,
      });
  const canChooseFreshBlank = !isSilentSeat && input.supportsAtomicBlankContextSwitch;
  const defaultContextMode: CrossProviderContextMode = isSilentSeat
    ? "fresh-blank"
    : "carry-summary";

  return {
    sourceProvider: input.sourceProvider,
    sourceProviderLabel: input.sourceProviderLabel,
    targetProvider: input.targetProvider,
    targetProviderLabel: input.targetProviderLabel,
    targetModelId: input.targetModelId,
    targetModelLabel: input.targetModelLabel,
    isSilentSeat,
    isRunning,
    hasConversationHistory: input.hasConversationHistory,
    topicMetadataState: input.topicMetadataState,
    disclosureChangedReason: "none",
    hasWorkspaceTaskLedger: input.hasWorkspaceTaskLedger,
    hasRolePrompt: input.hasRolePrompt,
    pendingPermissionsCount: Math.max(0, input.pendingPermissionsCount),
    thinkingPrecheck,
    canChooseFreshBlank,
    defaultContextMode,
  };
}

export function classifyCrossProviderDisclosureChange(
  previous: CrossProviderSwitchDisclosurePlan,
  next: CrossProviderSwitchDisclosurePlan,
): CrossProviderDisclosureChangeReason {
  const sessionChanged =
    previous.sourceProvider !== next.sourceProvider ||
    previous.isSilentSeat !== next.isSilentSeat ||
    (!previous.isRunning && next.isRunning) ||
    previous.hasConversationHistory !== next.hasConversationHistory ||
    previous.canChooseFreshBlank !== next.canChooseFreshBlank ||
    previous.defaultContextMode !== next.defaultContextMode ||
    previous.hasRolePrompt !== next.hasRolePrompt ||
    previous.hasWorkspaceTaskLedger !== next.hasWorkspaceTaskLedger ||
    previous.pendingPermissionsCount !== next.pendingPermissionsCount;
  if (sessionChanged) {
    return "session";
  }
  if (didTopicMetadataDisclosureChange(previous.topicMetadataState, next.topicMetadataState)) {
    return "topic";
  }
  return "none";
}

export function resolveCrossProviderOutboundItems(
  plan: Pick<
    CrossProviderSwitchDisclosurePlan,
    "hasConversationHistory" | "topicMetadataState" | "hasWorkspaceTaskLedger" | "hasRolePrompt"
  >,
  contextMode: CrossProviderContextMode,
): CrossProviderOutboundItem[] {
  const items: CrossProviderOutboundItem[] = [];
  if (contextMode === "carry-summary" && plan.hasConversationHistory) {
    items.push("handoff-summary");
  }
  if (contextMode === "fresh-blank") {
    items.push("blank-only");
  }
  if (plan.topicMetadataState.status === "present") {
    items.push(plan.topicMetadataState.hideFromModel ? "topic-hidden" : "topic-metadata");
  } else if (plan.topicMetadataState.status === "unverified") {
    items.push("topic-unverified");
  }
  if (plan.hasWorkspaceTaskLedger) {
    items.push("task-ledger");
  }
  if (plan.hasRolePrompt) {
    items.push("role-prompt");
  }
  if (items.length === 0) {
    items.push("blank-only");
  }
  return items;
}

export type CrossProviderSwitchTarget =
  | {
      kind: "model";
      targetProvider: AgentProvider;
      modelId: string;
    }
  | {
      kind: "profile";
      targetProvider: AgentProvider;
      modelId: string | null;
      modeId: string | null;
      thinkingOptionId: string | null;
      providerOptions: Record<string, unknown>;
    };

export interface CrossProviderSwitchHandoffSelection extends CrossProviderHandoffSelection {
  /** Present and `true` only for silent-seat config switches; omitted on all non-silent switches. */
  onlyIfSilent?: true;
}

export function buildCrossProviderHandoffSelection(
  target: CrossProviderSwitchTarget,
  contextMode: CrossProviderContextMode,
  options?: { onlyIfSilent?: boolean },
): CrossProviderSwitchHandoffSelection {
  const blankContext = contextMode === "fresh-blank" ? { context: "blank" as const } : {};
  const silentGuard = options?.onlyIfSilent ? { onlyIfSilent: true as const } : {};
  if (target.kind === "profile") {
    return {
      provider: target.targetProvider,
      modelId: target.modelId,
      modeId: target.modeId,
      thinkingOptionId: target.thinkingOptionId,
      providerOptions: target.providerOptions,
      kind: "profile",
      ...blankContext,
      ...silentGuard,
    };
  }
  return {
    provider: target.targetProvider,
    modelId: target.modelId,
    ...blankContext,
    ...silentGuard,
  };
}

export interface LiveAgentSwitchSnapshot {
  serverId: string;
  agentId: string;
  provider: string;
  workspaceId: string | null;
  isMainControl: boolean;
  isRoleSeat: boolean;
  status: string;
  turnPhase: string;
  hasConversationHistory: boolean;
  pendingPermissionsCount: number;
  currentThinkingOptionId: string | null;
  livePermissions: readonly string[] | undefined;
}

export type ConfirmCrossProviderSwitchCancelReason =
  | "seat-changed"
  | "already-on-target-provider"
  | "switch-unavailable";

export type ConfirmCrossProviderSwitchResult =
  | {
      status: "disclosure-changed";
      reason: Exclude<CrossProviderDisclosureChangeReason, "none">;
      updatedPlan: CrossProviderSwitchDisclosurePlan;
    }
  | { status: "cancelled"; reason: ConfirmCrossProviderSwitchCancelReason }
  | { status: "blocked"; reason: "update-host" | "unavailable" }
  | { status: "executed"; switched: boolean };

function validateLiveSeatSnapshot(
  snapshot: LiveAgentSwitchSnapshot | null,
  expectedSeat: { serverId: string; agentId: string },
  targetProvider: AgentProvider,
): ConfirmCrossProviderSwitchCancelReason | null {
  if (
    !snapshot ||
    snapshot.serverId !== expectedSeat.serverId ||
    snapshot.agentId !== expectedSeat.agentId ||
    !snapshot.provider
  ) {
    return "seat-changed";
  }
  if (snapshot.provider === targetProvider) {
    return "already-on-target-provider";
  }
  return null;
}

async function resolvePostReadSwitchState(input: {
  expectedSeat: { serverId: string; agentId: string };
  targetProvider: AgentProvider;
  readLiveSnapshot: () => LiveAgentSwitchSnapshot | null;
  readLiveTopicMetadata: (
    snapshot: LiveAgentSwitchSnapshot,
  ) => Promise<TopicMetadataDisclosureState>;
}): Promise<
  | { ok: false; reason: ConfirmCrossProviderSwitchCancelReason }
  | {
      ok: true;
      snapshot: LiveAgentSwitchSnapshot;
      topicMetadataState: TopicMetadataDisclosureState;
    }
> {
  const beforeRead = input.readLiveSnapshot();
  const preCancel = validateLiveSeatSnapshot(beforeRead, input.expectedSeat, input.targetProvider);
  if (preCancel || !beforeRead) {
    return { ok: false, reason: preCancel ?? "seat-changed" };
  }

  let topicMetadataState = await input.readLiveTopicMetadata(beforeRead);
  let postRead = input.readLiveSnapshot();
  const postCancel = validateLiveSeatSnapshot(postRead, input.expectedSeat, input.targetProvider);
  if (postCancel || !postRead) {
    return { ok: false, reason: postCancel ?? "seat-changed" };
  }

  if (
    postRead.workspaceId !== beforeRead.workspaceId ||
    postRead.isMainControl !== beforeRead.isMainControl
  ) {
    topicMetadataState = await input.readLiveTopicMetadata(postRead);
    postRead = input.readLiveSnapshot();
    const recheckCancel = validateLiveSeatSnapshot(
      postRead,
      input.expectedSeat,
      input.targetProvider,
    );
    if (recheckCancel || !postRead) {
      return { ok: false, reason: recheckCancel ?? "seat-changed" };
    }
  }

  return { ok: true, snapshot: postRead, topicMetadataState };
}

export async function confirmCrossProviderSwitchFlow(input: {
  plan: CrossProviderSwitchDisclosurePlan;
  target: CrossProviderSwitchTarget;
  contextMode: CrossProviderContextMode;
  expectedSeat: { serverId: string; agentId: string };
  canSwitchProvider: boolean;
  supportsBlankFeature: boolean;
  readLiveSnapshot: () => LiveAgentSwitchSnapshot | null;
  readLiveTopicMetadata: (
    snapshot: LiveAgentSwitchSnapshot,
  ) => Promise<TopicMetadataDisclosureState>;
  rebuildPlan: (
    snapshot: LiveAgentSwitchSnapshot,
    topicMetadataState: TopicMetadataDisclosureState,
  ) => CrossProviderSwitchDisclosurePlan;
  handoffToProvider: (selection: CrossProviderSwitchHandoffSelection) => Promise<boolean>;
  executeModelCarrySummary: (targetProvider: AgentProvider, modelId: string) => Promise<void>;
}): Promise<ConfirmCrossProviderSwitchResult> {
  const resolved = await resolvePostReadSwitchState({
    expectedSeat: input.expectedSeat,
    targetProvider: input.target.targetProvider,
    readLiveSnapshot: input.readLiveSnapshot,
    readLiveTopicMetadata: input.readLiveTopicMetadata,
  });
  if (!resolved.ok) {
    return { status: "cancelled", reason: resolved.reason };
  }

  const rebuiltPlan = input.rebuildPlan(resolved.snapshot, resolved.topicMetadataState);
  const changeReason = classifyCrossProviderDisclosureChange(input.plan, rebuiltPlan);
  if (changeReason !== "none") {
    return {
      status: "disclosure-changed",
      reason: changeReason,
      updatedPlan: { ...rebuiltPlan, disclosureChangedReason: changeReason },
    };
  }
  if (rebuiltPlan.isRunning || (rebuiltPlan.isSilentSeat && input.contextMode !== "fresh-blank")) {
    return {
      status: "disclosure-changed",
      reason: "session",
      updatedPlan: { ...rebuiltPlan, disclosureChangedReason: "session" },
    };
  }
  if (!input.canSwitchProvider) {
    return { status: "cancelled", reason: "switch-unavailable" };
  }

  if (input.contextMode === "fresh-blank") {
    if (!input.supportsBlankFeature) {
      return { status: "blocked", reason: "update-host" };
    }
    if (!hasBlankContextSwitchPermissions(resolved.snapshot.livePermissions)) {
      return { status: "blocked", reason: "unavailable" };
    }
    const switched = await input.handoffToProvider(
      buildCrossProviderHandoffSelection(
        input.target,
        "fresh-blank",
        rebuiltPlan.isSilentSeat ? { onlyIfSilent: true } : undefined,
      ),
    );
    return { status: "executed", switched };
  }

  if (input.target.kind === "profile") {
    const switched = await input.handoffToProvider(
      buildCrossProviderHandoffSelection(input.target, "carry-summary"),
    );
    return { status: "executed", switched };
  }

  await input.executeModelCarrySummary(input.target.targetProvider, input.target.modelId);
  return { status: "executed", switched: true };
}
