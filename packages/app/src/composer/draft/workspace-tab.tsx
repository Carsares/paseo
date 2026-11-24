import type { ComposerOptionControls } from "@/agent-controls/option-controls";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  EXPLICIT_PARENT_REPORTING,
  PARENT_AGENT_ID_LABEL,
  PARENT_REPORTING_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { Keyboard, StyleSheet as RNStyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { StyleSheet } from "react-native-unistyles";
import { CHAT_COLUMN_RAIL_DATASET } from "@/chat-rail";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import invariant from "tiny-invariant";
import { Composer } from "@/composer";
import { type ComposerEditingSession, useComposerFullscreen } from "@/composer/editing-session";
import { ComposerImportPill } from "@/composer/draft/import-pill";
import { COMPOSER_PILL_CLEARANCE } from "@/composer/pill-styles";
import { composerWorkspaceAttachment } from "@/composer/attachments/workspace";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import { useWorkspaceMainPreference } from "@/composer/draft/workspace-main-preference";
import {
  canChooseWorkspaceMain,
  isTopicFirstQuestionDraft,
  workspaceMainBlock,
  workspaceMainBlockMessage,
  workspaceMainDraftKey,
  workspaceMainErrorBlock,
} from "@/composer/draft/workspace-main-intent";
import type { CreateAgentInitialValues } from "@/hooks/use-agent-form-state";
import { restoreDraftCreateAttempt, useDraftAgentCreateFlow } from "@/composer/draft/create-flow";
import type { MessagePayload } from "@/composer/types";
import { selectHostFeature, useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { buildWorkspaceDraftAgentConfig } from "@/screens/workspace/workspace-draft-agent-config";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { flushDraftPersistStorage } from "@/stores/draft-store";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { selectWorkspace } from "@/stores/session-store-hooks/selectors";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { encodeImages } from "@/utils/encode-images";
import { shouldAutoFocusWorkspaceDraftComposer } from "@/screens/workspace/workspace-draft-pane-focus";
import {
  resolveDraftWorkingDirectory,
  shouldAllowEmptyDraftText,
  validateDraftSubmission,
} from "@/composer/draft/workspace-tab-core";
import { DRAFT_CAPABILITIES } from "@/composer/draft/timeline";
import type { AgentForkSource, AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import {
  isDraftChatHistoryReady,
  useDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import type { UserMessageImageAttachment } from "@/types/stream";
import { COMPACT_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceDraftTabSetup,
  type WorkspaceTabTarget,
} from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import { openWorkspaceChanges } from "@/workspace-tabs/open-supporting-view";
import { useSettings, type OpenInSidePanePreferences } from "@/hooks/use-settings";
import { draftCreationKey } from "@/composer/draft/creation-key";
import { ParentAgentPill } from "@/subagents/parent";
import { Button } from "@/components/ui/button";
import { useTopicFirstQuestion } from "./use-topic-first-question";

export function isDraftTabSubmitting(target: WorkspaceTabTarget | null | undefined): boolean {
  return (
    target?.kind === "draft" &&
    useCreateFlowStore.getState().pendingByDraftId[target.draftId]?.lifecycle === "active"
  );
}

export function revealCreatedDraftAgentTab(input: {
  workspaceKey: string;
  target: Extract<WorkspaceTabTarget, { kind: "agent" }>;
  preferences: OpenInSidePanePreferences;
}): void {
  const openedTabId = openPreferredWorkspaceTarget({ ...input, source: "subagents" });
  // A compact reveal can open a sheet. The completed draft needs a workspace tab.
  const store = useWorkspaceLayoutStore.getState();
  const sheet = store.sheetsByWorkspace[input.workspaceKey]?.find(
    (entry) => entry.tab.tabId === openedTabId,
  );
  if (sheet) store.openTabInFront(input.workspaceKey, sheet);
}

interface AutoSubmitConfig {
  provider: string;
  modeId: string | null;
  model: string | null;
  thinkingOptionId: string | null;
  providerOptions: Record<string, unknown>;
}

function resolveAutoSubmitConfig(
  pending: {
    provider: string;
    modeId?: string | null;
    model?: string | null;
    thinkingOptionId?: string | null;
    providerOptions?: Record<string, unknown>;
  } | null,
): AutoSubmitConfig | null {
  if (!pending) return null;
  return {
    provider: pending.provider,
    modeId: pending.modeId ?? null,
    model: pending.model ?? null,
    thinkingOptionId: pending.thinkingOptionId ?? null,
    providerOptions: pending.providerOptions ?? {},
  };
}

function resolveDraftModeIdOverride(input: {
  autoSubmitConfig: AutoSubmitConfig | null;
  effectiveModeId: string;
}): { modeId: string } | Record<string, never> {
  const { autoSubmitConfig, effectiveModeId } = input;
  if (autoSubmitConfig?.modeId) {
    return { modeId: autoSubmitConfig.modeId };
  }
  if (effectiveModeId !== "") {
    return { modeId: effectiveModeId };
  }
  return {};
}

function normalizeParentAgentId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveDraftModeId(input: {
  autoSubmitConfig: AutoSubmitConfig | null;
  effectiveModeId: string;
}): string | null {
  const { autoSubmitConfig, effectiveModeId } = input;
  if (autoSubmitConfig?.modeId !== undefined) {
    return autoSubmitConfig.modeId;
  }
  if (effectiveModeId !== "") {
    return effectiveModeId;
  }
  return null;
}

function buildDraftCaller(input: {
  parentAgentId?: string | null;
  requiresUserPromptOrigin: boolean;
  supportsAgentInitialPromptOrigin: () => boolean;
  initialPromptOriginUnavailableMessage: string;
}): { callerAgentId?: string; initialPromptOrigin?: "user"; labels?: Record<string, string> } {
  const callerAgentId = normalizeParentAgentId(input.parentAgentId);
  if (!callerAgentId) return {};
  // COMPAT(agentInitialPromptOrigin): added in v0.16.0, remove gate after 2027-05-19.
  if (input.requiresUserPromptOrigin && !input.supportsAgentInitialPromptOrigin()) {
    throw new Error(input.initialPromptOriginUnavailableMessage);
  }
  return {
    callerAgentId,
    initialPromptOrigin: "user",
    labels: draftParentLabels(callerAgentId),
  };
}

function draftParentLabels(parentAgentId: string | null): Record<string, string> {
  return parentAgentId
    ? {
        [PARENT_AGENT_ID_LABEL]: parentAgentId,
        [PARENT_REPORTING_LABEL]: EXPLICIT_PARENT_REPORTING,
      }
    : {};
}

function resolveDraftSubmitPolicy(
  setup: WorkspaceDraftTabSetup | null,
  pendingAutoSubmit: { allowEmptyText?: boolean } | null,
) {
  const isTimelineFork = Boolean(setup?.forkFrom);
  return {
    isTimelineFork,
    allowEmptyText:
      !setup?.sideChatFromAgentId && (isTimelineFork || pendingAutoSubmit?.allowEmptyText === true),
    requiresUserPromptOrigin: !isTimelineFork && setup?.restoreChatHistory === true,
  };
}

interface DraftCreateRequestInput {
  draftId: string;
  parentAgentId?: string | null;
  forkFrom?: AgentForkSource;
  sideChatFromAgentId?: string;
  attempt: { clientMessageId: string; workspaceRole?: "main" };
  assertWorkspaceMainAvailable?: () => void;
  imageEncodingFailedMessage?: string;
  text: string;
  images?: UserMessageImageAttachment[];
  attachments?: unknown;
  cwd: string;
  client: Pick<DaemonClient, "createAgent"> | null;
  workspaceDirectory: string | null;
  workspaceId: string | null;
  autoSubmitConfig: AutoSubmitConfig | null;
  composerState: {
    selectedProvider: string | null;
    effectiveModeId: string;
    effectiveModelId: string | null;
    effectiveThinkingOptionId: string | null;
    providerOptions: Record<string, unknown> | undefined;
    metadata: Record<string, JsonValue>;
  };
  hostDisconnectedMessage: string;
  selectModelMessage: string;
  requiresUserPromptOrigin: boolean;
  supportsAgentInitialPromptOrigin: () => boolean;
  initialPromptOriginUnavailableMessage: string;
}

function buildDraftRequestConfig(input: DraftCreateRequestInput) {
  const { cwd, autoSubmitConfig, composerState } = input;
  const provider = autoSubmitConfig?.provider ?? composerState.selectedProvider;
  if (!provider) {
    throw new Error(input.selectModelMessage);
  }
  const modeIdOverride = resolveDraftModeIdOverride({
    autoSubmitConfig,
    effectiveModeId: composerState.effectiveModeId,
  });
  return buildWorkspaceDraftAgentConfig({
    provider,
    cwd,
    ...modeIdOverride,
    model: autoSubmitConfig?.model ?? (composerState.effectiveModelId || undefined),
    thinkingOptionId:
      autoSubmitConfig?.thinkingOptionId ?? (composerState.effectiveThinkingOptionId || undefined),
    providerOptions: autoSubmitConfig?.providerOptions ?? composerState.providerOptions,
  });
}

async function buildDraftRequestMessage(input: DraftCreateRequestInput) {
  const { attempt, images, attachments, text } = input;
  const attachmentsArray = Array.isArray(attachments) ? attachments : undefined;
  const workspaceRole = attempt.workspaceRole;
  const imagesData = await encodeImages(
    images,
    workspaceRole ? input.imageEncodingFailedMessage : undefined,
  );
  if (workspaceRole) {
    invariant(
      !input.parentAgentId?.trim() && !input.forkFrom,
      "Main Session cannot have a parent or fork source",
    );
    input.assertWorkspaceMainAvailable?.();
  }
  const silent =
    workspaceRole === "main" && !text.trim() && !imagesData?.length && !attachmentsArray?.length;
  return {
    silent,
    fields: {
      ...(workspaceRole ? { workspaceRole } : {}),
      ...(silent ? {} : { initialPrompt: text, clientMessageId: attempt.clientMessageId }),
      ...(imagesData?.length ? { images: imagesData } : {}),
      ...(attachmentsArray?.length ? { attachments: attachmentsArray } : {}),
    },
  };
}

async function prepareDraftCreateRequest(input: DraftCreateRequestInput) {
  const { workspaceDirectory, workspaceId, composerState, forkFrom, sideChatFromAgentId } = input;
  invariant(workspaceDirectory, "Workspace directory is required");
  invariant(workspaceId, "Workspace id is required");
  if (sideChatFromAgentId) {
    invariant(
      forkFrom?.sourceAgentId === sideChatFromAgentId &&
        (forkFrom.boundaryCursor || forkFrom.boundaryMessageId) &&
        !input.parentAgentId &&
        !input.attempt.workspaceRole,
      "Side chat requires a fixed fork source and cannot have a workspace role or parent",
    );
  }

  const config = buildDraftRequestConfig(input);
  const { silent, fields } = await buildDraftRequestMessage(input);
  return {
    silent,
    request: {
      config,
      workspaceId,
      ...fields,
      ...buildDraftCaller(input),
      ...(forkFrom ? { forkFrom } : {}),
      ...(sideChatFromAgentId ? { sideChatFromAgentId } : {}),
      ...(Object.keys(composerState.metadata).length > 0
        ? { metadata: composerState.metadata }
        : {}),
    },
  };
}

export async function submitDraftCreateRequest(
  input: DraftCreateRequestInput,
): Promise<{ agentId: string | null; result: AgentSnapshotPayload }> {
  const { client } = input;
  if (!client) throw new Error(input.hostDisconnectedMessage);
  const { silent, request } = await prepareDraftCreateRequest(input);
  const result = await client.createAgent({
    ...request,
    idempotencyKey: draftCreationKey(input.draftId, request),
  });

  return {
    agentId: silent ? null : result.id,
    result,
  };
}

function buildDraftAgentSnapshot(input: {
  attempt: { timestamp: Date };
  serverId: string;
  tabId: string;
  parentAgentId?: string | null;
  workspaceDirectory: string | null;
  autoSubmitConfig: AutoSubmitConfig | null;
  composerState: {
    effectiveModelId: string | null;
    effectiveThinkingOptionId: string | null;
    effectiveModeId: string;
    selectedProvider: string | null;
    agentControls: { optionControls?: ComposerOptionControls };
  };
  selectModelMessage: string;
}): Agent {
  const {
    attempt,
    serverId,
    tabId,
    parentAgentId,
    workspaceDirectory,
    autoSubmitConfig,
    composerState,
  } = input;
  invariant(workspaceDirectory, "Workspace directory is required");
  const now = attempt.timestamp;
  const model = autoSubmitConfig?.model ?? (composerState.effectiveModelId || null);
  const thinkingOptionId =
    autoSubmitConfig?.thinkingOptionId ?? (composerState.effectiveThinkingOptionId || null);
  const modeId = resolveDraftModeId({
    autoSubmitConfig,
    effectiveModeId: composerState.effectiveModeId,
  });
  const provider = autoSubmitConfig?.provider ?? composerState.selectedProvider;
  if (!provider) {
    throw new Error(input.selectModelMessage);
  }
  const normalizedParentAgentId = normalizeParentAgentId(parentAgentId);
  return {
    serverId,
    id: tabId,
    provider,
    status: "running",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: now,
    lastActivityAt: now,
    capabilities: DRAFT_CAPABILITIES,
    currentModeId: modeId,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: { provider, sessionId: null, model, modeId },
    title: "Agent",
    cwd: workspaceDirectory,
    model,
    options: composerState.agentControls.optionControls?.options,
    controls: composerState.agentControls.optionControls?.controls,
    thinkingOptionId,
    parentAgentId: normalizedParentAgentId,
    labels: draftParentLabels(normalizedParentAgentId),
  };
}

export function useInitialDraftText(input: {
  draftKey: string;
  isHydrated: boolean;
  initialDraftText: string | null | undefined;
  textSource: { getSnapshot: () => string };
  replaceDraftText: (text: string) => void;
  onInitialized: () => void;
}) {
  const { draftKey, isHydrated, initialDraftText, textSource, replaceDraftText, onInitialized } =
    input;
  const initializedDraftKey = useRef<string | null>(null);
  useEffect(() => {
    if (!isHydrated || !initialDraftText?.trim() || initializedDraftKey.current === draftKey)
      return;
    initializedDraftKey.current = draftKey;
    if (textSource.getSnapshot() === "") replaceDraftText(initialDraftText);
    onInitialized();
  }, [draftKey, initialDraftText, isHydrated, onInitialized, replaceDraftText, textSource]);
}

async function consumeDraftTextSeed(input: {
  workspaceKey: string | null;
  tabId: string;
  draftId: string;
}) {
  const { workspaceKey, tabId, draftId } = input;
  if (!workspaceKey) return;
  // Save the editable text before removing the seed so deleted text stays deleted on reload.
  await flushDraftPersistStorage();
  const layoutStore = useWorkspaceLayoutStore.getState();
  const layout = layoutStore.layoutByWorkspace[workspaceKey];
  const target = layout && collectAllTabs(layout.root).find((tab) => tab.tabId === tabId)?.target;
  if (target?.kind !== "draft" || target.draftId !== draftId || !target.setup?.initialDraftText) {
    return;
  }
  const { initialDraftText: _seed, ...setup } = target.setup;
  layoutStore.replaceTab(workspaceKey, tabId, { ...target, setup });
}

function buildDraftInitialValues(input: {
  initialSetup: WorkspaceDraftTabSetup | null;
}): CreateAgentInitialValues | undefined {
  if (!input.initialSetup) return undefined;
  return {
    provider: input.initialSetup.provider,
    modeId: input.initialSetup.modeId,
    model: input.initialSetup.model,
    thinkingOptionId: input.initialSetup.thinkingOptionId,
  };
}

interface WorkspaceDraftComposerProps {
  serverId: string;
  workspaceId: string;
  tabId: string;
  draftId: string;
  initialSetup?: WorkspaceDraftTabSetup;
  isPaneFocused: boolean;
  editingSession: ComposerEditingSession;
  onCreated: (snapshot: AgentSnapshotPayload) => void;
  onOpenImportSheet?: () => void;
}

function resolveImportPillPress(
  onOpenImportSheet: (() => void) | undefined,
  isSubmitting: boolean,
  isTopicFirstQuestion: boolean,
): (() => void) | null {
  if (isSubmitting || isTopicFirstQuestion) {
    return null;
  }
  return onOpenImportSheet ?? null;
}

function useExistingWorkspaceMainPreference(input: {
  draftId: string;
  serverId: string;
  workspaceId: string;
  setup: WorkspaceDraftTabSetup | null;
  isHandoff: boolean;
  isTopicFirstQuestion: boolean;
  hasActiveMainAgent?: boolean;
  t: TFunction;
}) {
  const {
    draftId,
    serverId,
    workspaceId,
    setup,
    isHandoff,
    isTopicFirstQuestion,
    hasActiveMainAgent,
    t,
  } = input;
  const supportsCreateAsMain = useHostFeature(serverId, "agentCreateAsMain");
  const preference = useWorkspaceMainPreference(
    workspaceMainDraftKey({
      draftId,
      serverId,
      target:
        !isTopicFirstQuestion && canChooseWorkspaceMain({ setup, isHandoff })
          ? { kind: "workspace", workspaceId }
          : null,
    }),
    workspaceMainBlock({ supportsCreateAsMain, target: { kind: "workspace", hasActiveMainAgent } }),
    t,
  );
  const getMainBlock = useCallback(() => {
    const state = useSessionStore.getState();
    if (isTopicFirstQuestion && !selectHostFeature(state, serverId, "topicWorkbenchV1")) {
      return "unsupported";
    }
    return workspaceMainBlock({
      // COMPAT(agentCreateAsMain): added in v0.17.0-beta.1, remove gate after 2027-05-22.
      supportsCreateAsMain: selectHostFeature(state, serverId, "agentCreateAsMain"),
      // The daemon serializes Main binding. Record its decision for a topic question.
      target: isTopicFirstQuestion
        ? { kind: "new" }
        : {
            kind: "workspace",
            hasActiveMainAgent: selectWorkspace(state, serverId, workspaceId)?.hasActiveMainAgent,
          },
    });
  }, [isTopicFirstQuestion, serverId, workspaceId]);
  return {
    ...preference,
    getMainBlock,
    submitBehavior: isTopicFirstQuestion || preference.checked ? "preserve-and-lock" : "clear",
  } as const;
}

const UNKNOWN_WORKSPACE_FIELDS = {
  workspaceDirectory: null,
  id: null,
  hasActiveMainAgent: undefined,
};

/**
 * Creates the agent from the draft's first prompt. The conversation panel shows that prompt in
 * the timeline from the create-flow store while the agent is created.
 */
export function WorkspaceDraftComposer({
  serverId,
  workspaceId,
  tabId,
  draftId,
  initialSetup,
  isPaneFocused,
  editingSession,
  onCreated,
  onOpenImportSheet,
}: WorkspaceDraftComposerProps) {
  const { t } = useTranslation();
  const isTopicFirstQuestion = isTopicFirstQuestionDraft(draftId, serverId, workspaceId);
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const workspaceFields =
    useWorkspaceFields(serverId, workspaceId, (w) => ({
      workspaceDirectory: w.workspaceDirectory || null,
      id: w.id,
      hasActiveMainAgent: w.hasActiveMainAgent,
    })) ?? UNKNOWN_WORKSPACE_FIELDS;
  const { workspaceDirectory } = workspaceFields;
  const draftSetup = initialSetup ?? null;
  const draftWorkingDirectory = resolveDraftWorkingDirectory({
    workspaceDirectory,
    initialSetup: draftSetup,
  });
  const draftInitialValues = buildDraftInitialValues({
    initialSetup: draftSetup,
  });
  const draftStoreKey = useMemo(
    () =>
      buildDraftStoreKey({
        serverId,
        agentId: tabId,
        draftId,
      }),
    [draftId, serverId, tabId],
  );
  const draftInput = useAgentInputDraft({
    draftKey: draftStoreKey,
    composer: {
      initialServerId: serverId,
      initialValues: draftInitialValues,
      initialProviderOptions: draftSetup?.providerOptions,
      isVisible: true,
      lockedWorkingDir: draftWorkingDirectory ?? undefined,
    },
  });
  const composerState = draftInput.composerState;
  if (!composerState) {
    throw new Error("Workspace draft composer state is required");
  }

  const clearDraftInput = draftInput.clear;
  const replaceDraftText = draftInput.replaceText;
  const setDraftAttachments = draftInput.setAttachments;
  const parentAgentId = normalizeParentAgentId(draftSetup?.parentAgentId);
  const handleInitialTextApplied = useCallback(() => {
    void consumeDraftTextSeed({
      workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
      tabId,
      draftId,
    });
  }, [draftId, serverId, tabId, workspaceId]);
  useInitialDraftText({
    draftKey: draftStoreKey,
    isHydrated: draftInput.isHydrated,
    initialDraftText: draftSetup?.initialDraftText,
    textSource: draftInput.textSource,
    replaceDraftText,
    onInitialized: handleInitialTextApplied,
  });
  const pendingAutoSubmit = useWorkspaceDraftSubmissionStore((state) => {
    if (isTopicFirstQuestion || draftSetup?.sideChatFromAgentId) return null;
    const pending = state.pendingByDraftId[draftId] ?? null;
    return pending?.serverId === serverId && pending.workspaceId === workspaceId ? pending : null;
  });
  const pendingCreateAttempt = useCreateFlowStore((state) => {
    const pending = state.pendingByDraftId[draftId] ?? null;
    return pending?.serverId === serverId && pending.lifecycle === "active" ? pending : null;
  });
  const { getMainBlock, ...mainPreference } = useExistingWorkspaceMainPreference({
    draftId,
    serverId,
    workspaceId,
    setup: draftSetup,
    isHandoff: Boolean(pendingAutoSubmit),
    isTopicFirstQuestion,
    hasActiveMainAgent: workspaceFields.hasActiveMainAgent,
    t,
  });
  const consumePendingAutoSubmit = useWorkspaceDraftSubmissionStore(
    (state) => state.consumePending,
  );
  const autoSubmitConfig = resolveAutoSubmitConfig(pendingAutoSubmit);
  const initialCreateAttempt = useMemo(
    () => restoreDraftCreateAttempt(pendingCreateAttempt),
    [pendingCreateAttempt],
  );
  const { isTimelineFork, allowEmptyText, requiresUserPromptOrigin } = resolveDraftSubmitPolicy(
    draftSetup,
    pendingAutoSubmit,
  );
  const isCompactFormFactor = useIsCompactFormFactor();
  const isComposerFullscreen = useComposerFullscreen(editingSession);
  const { onLayout: onInputAreaLayout, isBelow: isCompactComposerLayout } = useContainerWidthBelow(
    COMPACT_CONTENT_WIDTH,
    { initialIsBelow: isCompactFormFactor },
  );
  const workspaceAttachmentScopeKey = useWorkspaceAttachmentScopeKey({
    serverId,
    cwd: composerState.workingDir,
    workspaceId,
  });
  const draftAttachmentScopeKey = useDraftWorkspaceAttachmentScopeKey(draftId);
  const areDraftAttachmentsReady = useWorkspaceAttachmentsStore(
    (state) => isTimelineFork || isDraftChatHistoryReady(state, draftAttachmentScopeKey),
  );
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const attachmentScopeKeys = useMemo(
    () => [draftAttachmentScopeKey, workspaceAttachmentScopeKey].filter(Boolean),
    [draftAttachmentScopeKey, workspaceAttachmentScopeKey],
  );
  const clearWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.clearWorkspaceAttachments,
  );
  const handleOpenWorkspaceAttachment = useCallback(
    (attachment: WorkspaceComposerAttachment) => {
      if (attachment.kind !== "review") {
        return;
      }
      openWorkspaceChanges({
        isCompact: isCompactFormFactor,
        workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId: workspaceId ?? "" }),
        preferences: openInSidePane,
      });
    },
    [isCompactFormFactor, openInSidePane, serverId, workspaceId],
  );
  const assertWorkspaceMainAvailable = () => {
    const block = getMainBlock();
    if (block) throw new Error(workspaceMainBlockMessage(t, block));
  };
  const finishDraftInput = () => {
    clearDraftInput("sent");
    clearWorkspaceAttachments({ scopeKey: draftAttachmentScopeKey });
    useWorkspaceDraftSubmissionStore.getState().clearDraftSetup({ draftId });
  };
  const topicQuestion = useTopicFirstQuestion({
    draftId,
    enabled: isTopicFirstQuestion,
    client,
    isConnected,
    isFocused: isPaneFocused,
    isDraftHydrated: draftInput.isHydrated,
    unconfirmedMessage: t("topicWorkbench.promptUnconfirmed"),
    assertAvailable: assertWorkspaceMainAvailable,
    onConfirmed: async (agent) => {
      finishDraftInput();
      await topicQuestion.clear();
      onCreated(agent);
    },
  });

  const { formErrorMessage, isSubmitting, handleCreateFromInput, continueCreateFromAttempt } =
    useDraftAgentCreateFlow<Agent, AgentSnapshotPayload>({
      draftId,
      getPendingServerId: () => serverId,
      initialAttempt: initialCreateAttempt,
      allowEmptyText,
      validateBeforeSubmit: ({ text, attachments, workspaceRole }) => {
        const block = workspaceRole ? getMainBlock() : null;
        if (block) return workspaceMainBlockMessage(t, block);
        if (!areDraftAttachmentsReady) return t("common.loading");
        const allowsEmptyDraftText = shouldAllowEmptyDraftText({
          allowsEmptyAutoSubmit: allowEmptyText || workspaceRole === "main",
          attachments,
        });
        return validateDraftSubmission({
          text,
          allowsEmptyAutoSubmit: !isTopicFirstQuestion && allowsEmptyDraftText,
          composerState,
          autoSubmitConfig,
          workspaceDirectory: draftWorkingDirectory,
          isConnected,
        });
      },
      onBeforeSubmit: async () => {
        await composerState.persistFormPreferences();
        if (isWeb) {
          (document.activeElement as HTMLElement | null)?.blur?.();
        }
        Keyboard.dismiss();
      },
      buildDraftAgent: (attempt) =>
        buildDraftAgentSnapshot({
          attempt,
          serverId,
          tabId,
          parentAgentId,
          workspaceDirectory: draftWorkingDirectory,
          autoSubmitConfig,
          composerState,
          selectModelMessage: t("workspaceSetup.errors.selectModel"),
        }),
      createRequest: async ({ attempt, text, images, attachments, cwd }) => {
        // COMPAT(agentSideChat): added in v0.17.0, remove gate after 2027-06-01.
        if (
          draftSetup?.sideChatFromAgentId &&
          !selectHostFeature(useSessionStore.getState(), serverId, "agentSideChat")
        ) {
          throw new Error(t("message.actions.forkUnavailable"));
        }
        const hasInitialMessage = Boolean(text.trim() || images?.length || attachments?.length);
        // An empty fork has no incoming user message for the create flow to hand off.
        const forkOnly = isTimelineFork && !hasInitialMessage;
        if (pendingAutoSubmit?.agentCreation) {
          const result = await pendingAutoSubmit.agentCreation.result;
          return { agentId: forkOnly ? null : result.id, result };
        }
        const requestInput: DraftCreateRequestInput = {
          draftId,
          parentAgentId,
          forkFrom: draftSetup?.forkFrom,
          sideChatFromAgentId: draftSetup?.sideChatFromAgentId,
          attempt,
          assertWorkspaceMainAvailable,
          imageEncodingFailedMessage: t("composer.errors.failedToSend"),
          text,
          images,
          attachments,
          cwd,
          client,
          workspaceDirectory: draftWorkingDirectory,
          workspaceId: workspaceFields.id,
          autoSubmitConfig,
          composerState,
          hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
          selectModelMessage: t("workspaceSetup.errors.selectModel"),
          requiresUserPromptOrigin,
          supportsAgentInitialPromptOrigin: () =>
            selectHostFeature(useSessionStore.getState(), serverId, "agentInitialPromptOrigin"),
          initialPromptOriginUnavailableMessage: t("message.actions.forkUnavailable"),
        };
        if (isTopicFirstQuestion) {
          const { request } = await prepareDraftCreateRequest(requestInput);
          const result = await topicQuestion.submit({
            ...request,
            workspaceRole: "main",
            initialPrompt: text,
            clientMessageId: attempt.clientMessageId,
          });
          return { result, agentId: result.id };
        }
        const created = await submitDraftCreateRequest(requestInput).catch((error: unknown) => {
          const block = attempt.workspaceRole ? workspaceMainErrorBlock(error) : null;
          if (block) throw new Error(workspaceMainBlockMessage(t, block));
          throw error;
        });
        return forkOnly ? { ...created, agentId: null } : created;
      },
      onCreateSuccess: async ({ result, attempt }) => {
        if (isTimelineFork || attempt.workspaceRole === "main") {
          const createFlow = useCreateFlowStore.getState();
          if (!createFlow.pendingByDraftId[draftId]?.agentId) {
            createFlow.updateAgentId({ draftId, agentId: result.id });
            createFlow.markLifecycle({ draftId, lifecycle: "sent" });
          }
        }
        if (attempt.workspaceRole === "main") mainPreference.clear();
        finishDraftInput();
        await topicQuestion.clear();
        onCreated(result);
      },
    });
  const isReadyForPendingAutoSubmit = Boolean(
    pendingAutoSubmit &&
    draftInput.isHydrated &&
    draftWorkingDirectory &&
    client &&
    !composerState.isModelLoading,
  );
  const autoSubmitKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isReadyForPendingAutoSubmit || !areDraftAttachmentsReady) {
      return;
    }
    const submitKey = `${serverId}:${workspaceId}:${draftId}`;
    if (autoSubmitKeyRef.current === submitKey) {
      return;
    }
    const submission = consumePendingAutoSubmit({ serverId, workspaceId, draftId });
    if (!submission) {
      return;
    }
    autoSubmitKeyRef.current = submitKey;
    replaceDraftText("");
    setDraftAttachments([]);
    const preparedAttempt =
      initialCreateAttempt?.clientMessageId === submission.clientMessageId
        ? initialCreateAttempt
        : null;
    const createPromise = preparedAttempt
      ? continueCreateFromAttempt({
          attempt: preparedAttempt,
          cwd: submission.cwd,
        })
      : handleCreateFromInput({
          text: submission.text,
          attachments: submission.attachments,
          cwd: submission.cwd,
        });
    void createPromise.catch(() => {
      replaceDraftText(submission.text);
      setDraftAttachments(composerWorkspaceAttachment.userAttachmentsOnly(submission.attachments));
      autoSubmitKeyRef.current = null;
    });
  }, [
    continueCreateFromAttempt,
    consumePendingAutoSubmit,
    draftId,
    handleCreateFromInput,
    initialCreateAttempt,
    isReadyForPendingAutoSubmit,
    areDraftAttachmentsReady,
    serverId,
    setDraftAttachments,
    replaceDraftText,
    workspaceId,
  ]);

  const focusInputRef = useRef<(() => void) | null>(null);

  const handleFocusInputCallback = useCallback((focus: () => void) => {
    focusInputRef.current = focus;
  }, []);

  const handleDropdownCloseFocus = useCallback(() => {
    focusInputRef.current?.();
  }, []);
  const importPillPress = resolveImportPillPress(
    draftSetup?.sideChatFromAgentId ? undefined : onOpenImportSheet,
    isSubmitting,
    isTopicFirstQuestion,
  );
  const { readForSubmit } = mainPreference;
  const submitDraft = useCallback(
    async (payload: MessagePayload) => {
      const createAsMain = isTopicFirstQuestion || (await readForSubmit());
      return handleCreateFromInput(createAsMain ? { ...payload, workspaceRole: "main" } : payload);
    },
    [handleCreateFromInput, isTopicFirstQuestion, readForSubmit],
  );
  const composerAgentControls = useMemo(
    () => ({
      ...composerState.agentControls,
      onDropdownClose: handleDropdownCloseFocus,
      disabled: isSubmitting,
      workspaceMain: mainPreference.control,
    }),
    [composerState.agentControls, handleDropdownCloseFocus, isSubmitting, mainPreference.control],
  );
  return (
    <View style={animatedStaticStyles.inputAreaWrapper} onLayout={onInputAreaLayout}>
      <TopicQuestionRecovery
        state={topicQuestion}
        isConnected={isConnected}
        isSubmitting={isSubmitting}
      />
      {formErrorMessage ? (
        <View
          style={styles.formErrorRow}
          dataSet={isComposerFullscreen ? undefined : CHAT_COLUMN_RAIL_DATASET}
        >
          <View style={styles.formError}>
            <Text style={styles.errorText}>{formErrorMessage}</Text>
          </View>
        </View>
      ) : null}
      {!isComposerFullscreen ? (
        <DraftComposerPills
          serverId={serverId}
          parentAgentId={parentAgentId}
          onImport={importPillPress}
        />
      ) : null}
      <Composer
        agentId={tabId}
        serverId={serverId}
        workspaceId={workspaceId}
        isPaneFocused={isPaneFocused}
        onSubmitMessage={submitDraft}
        allowEmptySubmit={allowEmptyText || mainPreference.checked}
        submitBehavior={mainPreference.submitBehavior}
        isSubmitLoading={isSubmitting || !areDraftAttachmentsReady || topicQuestion.isLocked}
        blurOnSubmit={true}
        textSource={draftInput.textSource}
        onChangeText={draftInput.editText}
        textReplacement={draftInput.textReplacement}
        attachments={draftInput.attachments}
        attachmentScopeKeys={attachmentScopeKeys}
        onOpenWorkspaceAttachment={handleOpenWorkspaceAttachment}
        onChangeAttachments={draftInput.setAttachments}
        cwd={composerState.workingDir}
        clearDraft={draftInput.clear}
        editingSession={editingSession}
        autoFocus={shouldAutoFocusWorkspaceDraftComposer({ isPaneFocused, isSubmitting })}
        autoFocusKey={String(draftInput.attachmentFocusRequestId)}
        onFocusInput={handleFocusInputCallback}
        commandDraft={composerState.commandDraft}
        agentControls={composerAgentControls}
        isCompactLayout={isCompactComposerLayout}
      />
    </View>
  );
}

function DraftComposerPills({
  serverId,
  parentAgentId,
  onImport,
}: {
  serverId: string;
  parentAgentId?: string | null;
  onImport?: (() => void) | null;
}) {
  if (!parentAgentId && !onImport) return null;
  return (
    <View style={styles.pillRow} dataSet={CHAT_COLUMN_RAIL_DATASET}>
      <View style={styles.pillContent}>
        {parentAgentId ? (
          <ParentAgentPill serverId={serverId} parentAgentId={parentAgentId} />
        ) : null}
        {onImport ? <ComposerImportPill onPress={onImport} /> : null}
      </View>
    </View>
  );
}

function TopicQuestionRecovery({
  state,
  isConnected,
  isSubmitting,
}: {
  state: ReturnType<typeof useTopicFirstQuestion>;
  isConnected: boolean;
  isSubmitting: boolean;
}) {
  const { t } = useTranslation();
  const stage = state.outcome?.stage;
  const action = stage === "retry" ? "retry" : "check";
  const actionLabel =
    action === "retry" ? t("common.actions.retry") : t("newWorkspace.batch.check");
  const status =
    stage === "queue-unavailable"
      ? t("topicWorkbench.mainQueueUnavailable")
      : t("topicWorkbench.promptUnconfirmed");
  const { check } = state;
  const handleAction = useCallback(() => void check(action), [action, check]);
  if (isSubmitting || (!state.hasSavedQuestion && !state.error)) return null;
  return (
    <View style={styles.formErrorRow}>
      <View style={styles.formError}>
        <Text style={styles.errorText}>{state.error ?? status}</Text>
        {state.hasSavedQuestion ? (
          <Button
            variant="outline"
            disabled={!isConnected || state.isChecking}
            onPress={handleAction}
          >
            {actionLabel}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

const animatedStaticStyles = RNStyleSheet.create({
  inputAreaWrapper: {
    width: "100%",
    flexShrink: 1,
    // Content-sized inline; fills the dock's fullscreen slot.
    flexGrow: 1,
  },
});

const styles = StyleSheet.create((theme) => ({
  formErrorRow: {
    width: "100%",
    paddingHorizontal: theme.spacing[4],
    alignItems: "center",
  },
  pillRow: {
    width: "100%",
    paddingHorizontal: theme.spacing[4],
    paddingTop: {
      xs: COMPOSER_PILL_CLEARANCE.compact,
      md: COMPOSER_PILL_CLEARANCE.wide,
    },
    paddingBottom: {
      xs: COMPOSER_PILL_CLEARANCE.compact,
      md: COMPOSER_PILL_CLEARANCE.wide,
    },
    alignItems: "center",
  },
  pillContent: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  formError: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.destructive,
  },
  errorText: {
    color: theme.colors.destructive,
  },
}));
