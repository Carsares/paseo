import { useAddHost } from "@/hosts/add-host";
import type { CreateWorkspaceRequestOptions } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload, CreationSnapshot } from "@getpaseo/protocol/messages";
import { encodeImages } from "@/utils/encode-images";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIsFocused } from "expo-router/react-navigation";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { createNameId } from "mnemonic-id";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Composer } from "@/composer";
import { ComposerDock } from "@/composer/dock";
import { useComposerEditingSession, useComposerFullscreen } from "@/composer/editing-session";
import { FileDropZone } from "@/components/file-drop/file-drop-zone";
import {
  resolveComposerAttachmentSubmitFormat,
  splitComposerAttachmentsForSubmit,
} from "@/composer/attachments/submit";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { Button } from "@/components/ui/button";
import { ICON_BUTTON_SIZES } from "@/components/ui/control-geometry";
import { MenuHeader } from "@/components/headers/menu-header";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import {
  canChooseWorkspaceMain,
  workspaceMainBlockMessage,
  workspaceMainErrorBlock,
} from "@/composer/draft/workspace-main-intent";
import { useForgeSearchQuery } from "@/git/use-forge-search-query";
import { getForgePresentation } from "@/git/forge";
import { useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { ensureCheckoutStatus } from "@/git/checkout-status-cache";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { resolveTerminalProfiles } from "@getpaseo/protocol/terminal-profiles";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import {
  CHAT_LAUNCH_TARGET,
  resolveLaunchTarget,
  type LaunchTarget,
} from "@/new-workspace-launch/target";
import { useTerminalComposerState } from "@/new-workspace-launch/composer-state";
import { runCreateTerminalWorkspace } from "./new-workspace-terminal";
import {
  useHostRuntimeClient,
  useHostRuntimeConnectionStatuses,
  useHostRuntimeIsConnected,
  useHosts,
  type HostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import { selectHostFeature, useHostFeature, useHostFeatureMap } from "@/runtime/host-features";
import type { HostProfile } from "@/types/host-connection";
import {
  navigateToWorkspace,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import {
  normalizeWorkspaceDescriptor,
  useSessionStore,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { buildNewWorkspaceDraftKey, generateDraftId } from "@/stores/draft-keys";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { isActiveCreateFlowForDraft, useCreateFlowStore } from "@/stores/create-flow-store";
import {
  readForkAgentIntent,
  useWorkspaceDraftSubmissionStore,
  type ForkAgentIntent,
  type ForkWorktreeSubmission,
  type PendingWorkspaceDraftSetup,
  type WorkspaceDraftTitle,
} from "@/stores/workspace-draft-submission-store";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useAppSettings } from "@/hooks/use-settings";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import type { CreateAgentInitialValues } from "@/hooks/use-agent-form-state";
import { toErrorMessage } from "@/utils/error-messages";
import {
  getHostProjectId,
  getWorktreeSupportForHostProject,
  hostProjectFromRoute,
  hostProjectFromWorkspace,
  resolveHostProjectCandidate,
  useHostProjects,
  type HostProjectListItem,
} from "@/projects/host-projects";
import { useProjectIcons } from "@/projects/icons";
import type { ComposerAttachment } from "@/attachments/types";
import { useDraftWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import type { MessagePayload } from "@/composer/types";
import type { UserComposerAttachment } from "@/attachments/types";
import type { AgentAttachment, ForgeSearchItem } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentProvider, JsonValue } from "@getpaseo/protocol/agent-types";
import type { WorkspaceDraftTabSetup, WorkspaceTabTarget } from "@/workspace-tabs/model";
import {
  isEmptyWorkspaceSubmission,
  resolveEmptyWorkspaceMainProvider,
  runCreateEmptyWorkspace,
  type EnsureNewWorkspaceRequest,
} from "./new-workspace-empty";
import {
  getWorkspaceNamingAttachments,
  remapDraftCwdToWorkspace,
} from "./new-workspace-fork-context";
import {
  buildPickerOptionData,
  defaultBasePickerItem,
  pickerItemLabel,
  startsNewBranch,
  type BaseRefCheckoutStatus,
  type BranchPickerDetail,
  type PickerCheckoutRequest,
  type PickerItem,
  type PickerOptionData,
} from "./new-workspace-picker-item";
import {
  clearPickerPrAttachmentForTargetChange,
  syncPickerPrAttachment,
} from "./new-workspace-picker-state";
import {
  PluginNewWorkspaceItems,
  type NewWorkspaceItemsScreen,
} from "@/plugins/new-workspace-items";
import {
  BranchInWorktreeError,
  createNewWorkspaceSetup,
  refActionOf,
  useNewWorkspaceSetupState,
  type NewWorkspaceSetup,
  type SetupEffects,
  type SetupInputs,
} from "./new-workspace/setup-model";
import type { IsolationChoice } from "./new-workspace/form";
import { shortenPath } from "@/utils/shorten-path";
import {
  resolveNewWorkspaceAutomaticServerId,
  resolveNewWorkspaceInitialServerId,
} from "./new-workspace-initial-context";
import { buildNewWorkspaceProjectIconTargets } from "./new-workspace/project-icon-targets";
import { useNewWorkspaceProjectPicker } from "./new-workspace/project-picker";
import {
  useExistingWorktrees,
  useProjectWorktrees,
  type ExistingWorktree,
} from "./new-workspace/existing-worktrees";
import { useNewWorkspaceForm } from "./new-workspace/form";
import { DraftTitleEditor } from "./new-workspace/draft-title-editor";
import { createOrRetryWorkspaceMain } from "./new-workspace/create-explicit-main";
import {
  readMainDraft,
  restoreMainDraftAtTarget,
  writeMainDraft,
  type MainDraft,
  type MainDraftTarget,
} from "./new-workspace/main-draft";
import { ImportSessionButton } from "./new-workspace/import-session-button";
import { useImportSession } from "@/hooks/use-import-session";
import {
  buildTerminalsQueryKey,
  type ListTerminalsPayload,
  upsertCreatedTerminalPayload,
} from "./workspace/terminals/state";
import {
  captureWorkspaceDraftCleanup,
  handOffDraftMetadata,
} from "./new-workspace/background-handoff";
import { useNewWorkspaceScreenPresence } from "./new-workspace/screen-presence";

function useIsNewWorkspaceDraftHandoffActive(input: {
  draftId: string | undefined;
  selectedServerId: string;
}): boolean {
  const normalizedDraftId = input.draftId?.trim() ?? "";
  return useCreateFlowStore((state) =>
    isActiveCreateFlowForDraft({
      draftId: normalizedDraftId,
      serverId: input.selectedServerId,
      pending: normalizedDraftId ? state.pendingByDraftId[normalizedDraftId] : null,
    }),
  );
}

function resolveVisibleDraftContextScopeKeys(input: {
  isDraftHandoffActive: boolean;
  draftContextScopeKey: string;
}): readonly string[] {
  if (input.isDraftHandoffActive || !input.draftContextScopeKey) {
    return [];
  }
  return [input.draftContextScopeKey];
}

function isNewWorkspacePending(input: {
  pendingAction: "chat" | "empty" | "terminal" | null;
  isDraftHandoffActive: boolean;
}): boolean {
  return input.pendingAction !== null || input.isDraftHandoffActive;
}

function buildFirstAgentContext(input: {
  prompt: string;
  attachments: AgentAttachment[];
}): { prompt?: string; attachments?: AgentAttachment[] } | undefined {
  const trimmedPrompt = input.prompt.trim();
  if (!trimmedPrompt && input.attachments.length === 0) {
    return undefined;
  }

  return {
    ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
    attachments: input.attachments,
  };
}

interface NewWorkspaceScreenProps {
  serverId: string;
  sourceDirectory?: string;
  projectId?: string;
  displayName?: string;
  draftId?: string;
}

// A terminal launch sends argv, not a message: there is nothing to attach and
// no draft to persist, so the composer's attachment and draft seams are inert.
const NO_TERMINAL_ATTACHMENTS: UserComposerAttachment[] = [];
function noopChangeAttachments() {}
function noopClearDraft() {}

// Stable reference so the keyboard-action handler doesn't re-register each render.
const PROJECT_PICK_ACTIONS: readonly KeyboardActionId[] = [
  "workspace.project.pick",
  "workspace.new",
];

interface WorkspaceIsolationState {
  isolation: "local" | "worktree";
  setIsolation: (value: "local" | "worktree") => void;
  /** What the workspace is created as. An existing worktree is a local workspace at its path. */
  effectiveIsolation: "local" | "worktree";
  /** The Isolation field's choice. */
  choice: IsolationChoice;
  /** The worktree an Existing worktree workspace is created in. */
  existingWorktreePath: string | null;
  /** Where the workspace works: the existing worktree, else the project directory. */
  workingDirectory: string | null;
  canCreateWorktree: boolean;
  showRefPicker: boolean;
}

// Preserve the user's worktree choice while route metadata is provisional. Once
// the authoritative placement arrives, unsupported projects fall back to local.
function useWorkspaceIsolation(input: {
  setup: NewWorkspaceSetup;
  supportsMultiplicity: boolean;
  canCreateWorktree: boolean;
  existingWorktrees: readonly ExistingWorktree[];
  projectDirectory: string | null;
  submittedForkIsolation?: "local" | "worktree";
  restoredMainTarget: MainDraftTarget | null;
}): WorkspaceIsolationState {
  const { setup, supportsMultiplicity, canCreateWorktree, existingWorktrees } = input;
  // The last isolation choice is remembered alongside the other New Workspace
  // form preferences (provider, model, mode). A manual in-screen pick overrides
  // the remembered default until the screen remounts.
  const { preferences } = useFormPreferences();
  const { manualIsolation, existingWorktreePath: manuallyChosenPath } =
    useNewWorkspaceSetupState(setup);
  const chosenPath =
    manuallyChosenPath ??
    (input.restoredMainTarget?.isolation === "existing"
      ? input.restoredMainTarget.directory
      : null);
  const restoredIsolation =
    input.restoredMainTarget?.isolation === "existing"
      ? "local"
      : input.restoredMainTarget?.isolation;
  const isolation =
    manualIsolation ??
    input.submittedForkIsolation ??
    restoredIsolation ??
    preferences.isolation ??
    "local";
  // A worktree that left the list (removed since it was chosen) is no choice.
  const existingWorktreePath =
    canCreateWorktree && existingWorktrees.some((worktree) => worktree.path === chosenPath)
      ? chosenPath
      : null;
  const isWorktree = isolation === "worktree" && canCreateWorktree && !existingWorktreePath;
  const worktreeChoice = isWorktree ? "worktree" : "local";

  return {
    isolation,
    setIsolation: setup.chooseIsolation,
    effectiveIsolation: isWorktree ? "worktree" : "local",
    choice: existingWorktreePath ? "existing" : worktreeChoice,
    existingWorktreePath,
    workingDirectory: existingWorktreePath ?? input.projectDirectory,
    canCreateWorktree,
    showRefPicker: !supportsMultiplicity || isWorktree,
  };
}

/** Create's checkout request, with the model's refusal said in the user's language. */
function checkoutRequestOrExplain(
  resolve: () => PickerCheckoutRequest | undefined,
  t: TFunction,
): PickerCheckoutRequest | undefined {
  try {
    return resolve();
  } catch (error) {
    if (!(error instanceof BranchInWorktreeError)) throw error;
    const branch = error.branchName;
    throw new Error(
      error.worktree.containsCwd
        ? t("newWorkspace.errors.branchInProjectDirectory", { branch })
        : t("newWorkspace.errors.branchInWorktree", {
            branch,
            path: shortenPath(error.worktree.path),
          }),
      { cause: error },
    );
  }
}

function resolveStartingRef(
  selected: PickerItem | null,
  submitted: ForkWorktreeSubmission | undefined,
  status?: BaseRefCheckoutStatus | null,
): PickerItem | null {
  if (selected) return selected;
  if (submitted) return submitted.baseItem;
  return status ? defaultBasePickerItem(status) : null;
}

async function resolveWorktreeSubmission(input: {
  setup: NewWorkspaceSetup;
  submittedWorktree?: ForkWorktreeSubmission;
  readCheckoutStatus: () => Promise<BaseRefCheckoutStatus>;
  sourceDirectory: string;
  projectId: string;
  worktreeSlug: string;
  t: TFunction;
}): Promise<ForkWorktreeSubmission> {
  const { setup, submittedWorktree } = input;
  const status = submittedWorktree ? null : await input.readCheckoutStatus();
  const { pickerSelection, branch, metadata } = setup.getSnapshot();
  const baseItem = resolveStartingRef(pickerSelection.selectedItem, submittedWorktree, status);
  const checkout = checkoutRequestOrExplain(
    () => setup.checkoutRequestFor(baseItem, submittedWorktree?.source),
    input.t,
  );
  const source: ForkWorktreeSubmission["source"] = {
    kind: "worktree",
    cwd: input.sourceDirectory,
    projectId: input.projectId,
    worktreeSlug: input.worktreeSlug,
    ...checkout,
    ...(branch && startsNewBranch(checkout) ? { branchName: branch } : {}),
  };
  return { source, baseItem, metadata };
}

async function recordWorkspaceCreationSource(input: {
  directory: Extract<CreateWorkspaceRequestOptions["source"], { kind: "directory" }>;
  worktree?: ForkWorktreeSubmission;
  forkDraft?: { draftId: string; serverId: string };
  agentConfig?: ForkAgentIntent["config"];
  createMainAgent: boolean;
}): Promise<CreateWorkspaceRequestOptions["source"]> {
  const { directory, worktree, forkDraft, agentConfig, createMainAgent } = input;
  const slug =
    forkDraft && agentConfig
      ? await useWorkspaceDraftSubmissionStore.getState().recordForkSubmission({
          ...forkDraft,
          worktree,
          agentIntent: { config: agentConfig, createMainAgent },
        })
      : undefined;
  if (!worktree) return directory;
  return { ...worktree.source, worktreeSlug: slug ?? worktree.source.worktreeSlug };
}

function normalizeBranchDetails(
  data: { branchDetails?: BranchPickerDetail[]; branches?: string[] } | undefined,
): BranchPickerDetail[] {
  const details = data?.branchDetails;
  if (details && details.length > 0) return details;
  const names = data?.branches ?? [];
  return names.map((name) => ({ name, committerDate: 0 }));
}

/**
 * "background" means the user left the New workspace screen mid-creation, so nothing navigated
 * and the screen — if still mounted under another route — has to drop its pending state itself.
 */
type SubmitOutcome = "navigated" | "background";

interface SubmitDraftInput {
  clearConsumedDraft: () => void;
  agentCreation?: {
    result: Promise<AgentSnapshotPayload>;
  };
  serverId: string;
  draftKey: string;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  draftId?: string;
  draftContextScopeKey: string | null;
  initialSetup?: WorkspaceDraftTabSetup;
  workspaceId: string;
  workspaceDirectory: string;
  text: string;
  attachments: ComposerAttachment[];
  provider: AgentProvider;
  composerState: NewWorkspaceComposerState;
  supportsForgeSearch: boolean;
  resolveClient: () => DaemonClient;
  isStillOnCreateScreen: () => boolean;
}

type NewWorkspaceComposerState = NonNullable<
  ReturnType<typeof useAgentInputDraft>["composerState"]
>;

interface WorkspaceDraftSubmissionConfig {
  cwd: string;
  provider: AgentProvider;
  modeId: string | null;
  model: string | null;
  thinkingOptionId: string | null;
  providerOptions: Record<string, unknown> | undefined;
  target: WorkspaceTabTarget;
}

interface WorkspaceCreationResult {
  workspace: ReturnType<typeof normalizeWorkspaceDescriptor>;
  agent?: AgentSnapshotPayload;
  mainAgent?: AgentSnapshotPayload | null;
}

async function createMultiplicityWorkspace(input: {
  title: string;
  idempotencyKey: string;
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  source: CreateWorkspaceRequestOptions["source"];
  /** Stored on the created workspace. */
  metadata: Readonly<Record<string, JsonValue>>;
  withInitialAgent: boolean;
  agent?: CreateWorkspaceRequestOptions["agent"];
  mainAgent?: CreateWorkspaceRequestOptions["mainAgent"];
  onEvent?: (snapshot: CreationSnapshot) => void;
  prompt: string;
  attachments: AgentAttachment[];
  mergeWorkspaces: (
    serverId: string,
    workspaces: ReturnType<typeof normalizeWorkspaceDescriptor>[],
  ) => void;
  serverId: string;
  createFailedMessage: string;
}): Promise<WorkspaceCreationResult> {
  const firstAgentContext = buildFirstAgentContext({
    prompt: input.prompt,
    attachments: input.attachments,
  });
  const acceptMainAgent = (snapshot: AgentSnapshotPayload | null | undefined) => {
    if (snapshot) {
      getHostRuntimeStore().acceptAgentSnapshot(
        input.serverId,
        normalizeAgentSnapshot(snapshot, input.serverId),
      );
    }
  };
  const payload = await input.client.createWorkspace({
    idempotencyKey: input.idempotencyKey,
    ...(input.title ? { title: input.title } : {}),
    agent: input.agent,
    ...(input.mainAgent ? { mainAgent: input.mainAgent } : {}),
    onEvent: (snapshot) => {
      acceptMainAgent(snapshot.mainAgent);
      input.onEvent?.(snapshot);
    },
    source: input.source,
    ...(firstAgentContext ? { firstAgentContext } : {}),
    ...(Object.keys(input.metadata).length > 0 ? { metadata: { ...input.metadata } } : {}),
  });
  if (payload.error || !payload.workspace) {
    const code = payload.errorCode ?? payload.creation?.errorCode;
    throw Object.assign(new Error(payload.error ?? input.createFailedMessage), { code });
  }
  const normalizedWorkspace = normalizeWorkspaceDescriptor(payload.workspace);
  const workspaceForInitialMerge = input.withInitialAgent
    ? { ...normalizedWorkspace, status: "running" as const, statusEnteredAt: new Date() }
    : normalizedWorkspace;
  input.mergeWorkspaces(input.serverId, [workspaceForInitialMerge]);
  acceptMainAgent(payload.mainAgent);
  if (input.agent?.workspaceRole === "main") acceptMainAgent(payload.agent);
  return { workspace: normalizedWorkspace, agent: payload.agent, mainAgent: payload.mainAgent };
}

type EnsureWorkspace = (
  input: EnsureNewWorkspaceRequest & Pick<CreateWorkspaceRequestOptions, "agent" | "onEvent">,
) => Promise<WorkspaceCreationResult>;

function readCachedWorkspaceCreation(
  result: WorkspaceCreationResult | { workspace: null },
  agent: CreateWorkspaceRequestOptions["agent"],
  t: TFunction,
): WorkspaceCreationResult | null {
  if (!result.workspace) return null;
  if (agent?.workspaceRole === "main") {
    throw new Error(workspaceMainBlockMessage(t, "unknown"));
  }
  return result;
}

function resolveSeparateMainAgent(input: {
  request: EnsureNewWorkspaceRequest;
  createMainAgent: boolean;
  composerState: NewWorkspaceComposerState | null;
  preferredProvider?: AgentProvider;
  t: TFunction;
}): CreateWorkspaceRequestOptions["mainAgent"] {
  const { request, createMainAgent, composerState, preferredProvider, t } = input;
  if (!createMainAgent || request.withInitialAgent) return request.mainAgent;
  const selectedProvider = composerState?.selectedProvider ?? null;
  const provider = resolveEmptyWorkspaceMainProvider({
    selectedProvider,
    preferredProvider,
    entries: composerState?.allProviderEntries ?? [],
  });
  if (!provider) throw new Error(t("newWorkspace.errors.selectModel"));
  const matchingComposer = provider === selectedProvider ? composerState : null;
  return { config: buildWorkspaceAgentConfig(request.cwd, provider, matchingComposer) };
}

interface CreateChatAgentInput {
  finishTitle: () => void;
  payload: MessagePayload;
  composerState: ReturnType<typeof useAgentInputDraft>["composerState"];
  forkDraftSetup?: PendingWorkspaceDraftSetup | null;
  ensureWorkspace: EnsureWorkspace;
  createMainAgent: boolean;
  submittedAgentConfig?: ForkAgentIntent["config"];
  serverId: string;
  draftKey: string;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  draftId?: string;
  draftContextScopeKey: string | null;
  supportsForgeSearch: boolean;
  resolveClient: () => DaemonClient;
  isStillOnCreateScreen: () => boolean;
  labels: {
    composerStateRequired: string;
    selectModel: string;
    missingAgent: string;
  };
}

function buildWorkspaceAgentConfig(
  cwd: string,
  provider: AgentProvider,
  composerState: NewWorkspaceComposerState | null,
): NonNullable<CreateWorkspaceRequestOptions["mainAgent"]>["config"] {
  return {
    provider,
    cwd,
    modeId: composerState?.effectiveModeId || undefined,
    model: composerState?.effectiveModelId || undefined,
    thinkingOptionId: composerState?.effectiveThinkingOptionId || undefined,
    providerOptions: composerState?.providerOptions,
  };
}

function buildWorkspaceDraftSetupForCreatedWorkspace(input: {
  forkDraftSetup: PendingWorkspaceDraftSetup | null | undefined;
  workspaceDirectory: string;
  agentConfig: ForkAgentIntent["config"];
  mainAgentId?: string;
}): WorkspaceDraftTabSetup | undefined {
  if (!input.forkDraftSetup && !input.mainAgentId) return undefined;
  const cwd = input.forkDraftSetup
    ? remapDraftCwdToWorkspace({
        cwd: input.forkDraftSetup.setup.cwd,
        sourceDirectory: input.forkDraftSetup.sourceDirectory,
        workspaceDirectory: input.workspaceDirectory,
      })
    : input.workspaceDirectory;
  const { provider, modeId, model, thinkingOptionId, providerOptions } = input.agentConfig;
  const forkFrom = input.forkDraftSetup?.setup.forkFrom;
  return {
    cwd,
    provider,
    modeId: modeId ?? null,
    model: model ?? null,
    thinkingOptionId: thinkingOptionId ?? null,
    providerOptions: providerOptions ?? {},
    ...(input.mainAgentId ? { parentAgentId: input.mainAgentId } : {}),
    ...(forkFrom ? { forkFrom, restoreChatHistory: false } : {}),
  };
}

function buildComposerInitialValues(input: {
  initialSetup?: CreateAgentInitialValues | null;
}): CreateAgentInitialValues | undefined {
  if (input.initialSetup) {
    return {
      provider: input.initialSetup.provider,
      modeId: input.initialSetup.modeId,
      model: input.initialSetup.model,
      thinkingOptionId: input.initialSetup.thinkingOptionId,
    };
  }
  return undefined;
}

const pendingExplicitMainSubmissions = new Set<string>();
const pendingWorkspaceSubmissions = new Map<string, Promise<SubmitOutcome>>();
function runCreateChatAgent(input: CreateChatAgentInput): Promise<SubmitOutcome> {
  const key = JSON.stringify([input.serverId, input.draftId]);
  const pending = pendingWorkspaceSubmissions.get(key);
  if (pending) return pending;
  const submission = Promise.resolve().then(() => createWorkspaceChatAgent(input));
  pendingWorkspaceSubmissions.set(key, submission);
  void submission.finally(() => pendingWorkspaceSubmissions.delete(key)).catch(() => undefined);
  return submission;
}

async function createWorkspaceChatAgent(input: CreateChatAgentInput): Promise<SubmitOutcome> {
  const { payload, composerState, ensureWorkspace, serverId, clearDraft } = input;
  const clearConsumedDraft = captureWorkspaceDraftCleanup(input);
  const { text, attachments, cwd } = payload;
  if (!composerState) {
    throw new Error(input.labels.composerStateRequired);
  }
  const provider = input.submittedAgentConfig?.provider ?? composerState.selectedProvider;
  if (!provider) {
    throw new Error(input.labels.selectModel);
  }
  const attachmentSubmitFormat = resolveComposerAttachmentSubmitFormat({
    supportsForgeAttachments: input.supportsForgeSearch,
  });
  const { attachments: reviewAttachments } = splitComposerAttachmentsForSubmit(attachments, {
    format: attachmentSubmitFormat,
  });
  const workspaceNamingAttachments = getWorkspaceNamingAttachments(reviewAttachments);
  const wirePayload = splitComposerAttachmentsForSubmit(attachments, {
    format: attachmentSubmitFormat,
  });
  const images = await encodeImages(wirePayload.images);
  let navigated = false;
  let outcome: SubmitOutcome = "background";
  const agentConfig = input.submittedAgentConfig
    ? { ...input.submittedAgentConfig, cwd }
    : buildWorkspaceAgentConfig(cwd, provider, composerState);
  const forkFrom = input.forkDraftSetup?.setup.forkFrom;
  const initialAgent: NonNullable<CreateWorkspaceRequestOptions["agent"]> = {
    config: agentConfig,
    ...(forkFrom ? { forkFrom } : {}),
    ...(Object.keys(composerState.metadata).length > 0 ? { metadata: composerState.metadata } : {}),
    initialPrompt: text,
    clientMessageId: `${input.draftId}:initial-message`,
    images: images?.length ? images : undefined,
    attachments: wirePayload.attachments?.length ? wirePayload.attachments : undefined,
  };
  const openWorkspaceDraft = (
    workspace: WorkspaceCreationResult["workspace"],
    mainAgent?: WorkspaceCreationResult["mainAgent"],
  ) => {
    if (navigated || (input.createMainAgent && !mainAgent)) return;
    navigated = true;
    if (!input.isStillOnCreateScreen()) return;
    const initialSetup = buildWorkspaceDraftSetupForCreatedWorkspace({
      forkDraftSetup: input.forkDraftSetup,
      workspaceDirectory: workspace.workspaceDirectory,
      agentConfig,
      mainAgentId: mainAgent?.id,
    });
    outcome = submitWorkspaceDraft({
      clearConsumedDraft,
      draftKey: input.draftKey,
      draftContextScopeKey: input.draftContextScopeKey,
      resolveClient: input.resolveClient,
      isStillOnCreateScreen: input.isStillOnCreateScreen,
      serverId,
      clearDraft,
      draftId: input.draftId,
      initialSetup,
      workspaceId: workspace.id,
      workspaceDirectory: workspace.workspaceDirectory,
      text,
      attachments,
      provider,
      composerState,
      supportsForgeSearch: input.supportsForgeSearch,
      agentCreation,
    });
    if (!input.forkDraftSetup) input.finishTitle();
  };
  const execute = async (): Promise<AgentSnapshotPayload> => {
    const { workspace, agent, mainAgent } = await ensureWorkspace({
      cwd,
      prompt: text,
      attachments: workspaceNamingAttachments,
      withInitialAgent: true,
      agent: initialAgent,
      ...(input.createMainAgent ? { mainAgent: { config: agentConfig } } : {}),
      onEvent: (snapshot) => {
        if (!snapshot.workspace || navigated || (input.createMainAgent && !snapshot.mainAgent)) {
          return;
        }
        const readyWorkspace = normalizeWorkspaceDescriptor(snapshot.workspace);
        getHostRuntimeStore().acceptWorkspaceSnapshots(serverId, [
          { ...readyWorkspace, status: "running" },
        ]);
        openWorkspaceDraft(readyWorkspace, snapshot.mainAgent);
      },
    });
    if (!agent) throw new Error("Workspace creation returned no agent");
    if (input.createMainAgent && mainAgent) openWorkspaceDraft(workspace, mainAgent);
    return agent;
  };
  // A retry after a failed agent start belongs to the ready workspace's draft, not to this creation.
  const agentCreation = { result: Promise.resolve().then(() => execute()) };
  await agentCreation.result;
  if (outcome === "background") clearConsumedDraft();
  if (outcome === "background" || input.forkDraftSetup) input.finishTitle();
  return outcome;
}

function buildComposerConfig(input: {
  serverId: string;
  workspaceDirectory: string | null;
  sourceDirectory: string | null;
  initialSetup?: WorkspaceDraftTabSetup | null;
  restoredAgentIntent?: ForkAgentIntent;
}): Parameters<typeof useAgentInputDraft>[0]["composer"] {
  const { serverId, workspaceDirectory, sourceDirectory, initialSetup, restoredAgentIntent } =
    input;
  const composerSetup = restoredAgentIntent?.config ?? initialSetup;
  const workingDir = workspaceDirectory || sourceDirectory || undefined;
  return {
    initialServerId: serverId || null,
    initialValues: buildComposerInitialValues({ initialSetup: composerSetup }),
    initialProviderOptions: composerSetup?.providerOptions,
    context: "new-workspace" as const,
    isVisible: true,
    lockedWorkingDir: workingDir,
  };
}

function usePendingWorkspaceDraftSetup(draftId: string | undefined) {
  const normalizedDraftId = draftId?.trim() ?? "";
  const forkDraftSetup = useWorkspaceDraftSubmissionStore((state) =>
    normalizedDraftId ? (state.setupByDraftId[normalizedDraftId] ?? null) : null,
  );
  const draftStatus = useWorkspaceDraftSubmissionStore(
    (state) => state.draftSetupStatusById[normalizedDraftId],
  );
  const storedDraft = typeof draftStatus === "object" ? draftStatus : null;
  const reservedWorktreeSlug = storedDraft?.worktreeSlug;
  const submittedForkIsolation = reservedWorktreeSlug
    ? ("worktree" as const)
    : storedDraft?.agentIntent && ("local" as const);
  return {
    forkDraftSetup,
    isTimelineFork: Boolean(forkDraftSetup?.setup.forkFrom),
    reservedWorktreeSlug,
    submittedForkIsolation,
    storedDraft,
  };
}

function forkWorktreeAtTarget(
  draft: ReturnType<typeof usePendingWorkspaceDraftSetup>["storedDraft"],
  serverId: string,
  projectId: string | null,
  directory: string | null,
): ForkWorktreeSubmission | undefined {
  const submitted = draft?.worktreeSubmission;
  if (
    draft?.sourceServerId === serverId &&
    submitted?.source.projectId === projectId &&
    submitted.source.cwd === directory
  ) {
    return submitted;
  }
  return undefined;
}

function restoreForkWorktreeProject(
  route: NewWorkspaceScreenProps,
  restored: ForkWorktreeSubmission | undefined,
): NewWorkspaceScreenProps {
  if (!restored) return route;
  return {
    ...route,
    sourceDirectory: restored.source.cwd,
    projectId: restored.source.projectId,
    displayName: restored.source.projectId === route.projectId ? route.displayName : undefined,
  };
}

function resolveWorkspaceDraftSubmissionConfig(input: {
  draftId: string;
  workspaceDirectory: string;
  provider: AgentProvider;
  composerState: NewWorkspaceComposerState;
  initialSetup?: WorkspaceDraftTabSetup;
}): WorkspaceDraftSubmissionConfig {
  const { draftId, workspaceDirectory, provider, composerState, initialSetup } = input;
  if (initialSetup) {
    return {
      cwd: initialSetup.cwd,
      provider: initialSetup.provider,
      modeId: initialSetup.modeId,
      model: initialSetup.model,
      thinkingOptionId: initialSetup.thinkingOptionId,
      providerOptions: initialSetup.providerOptions,
      target: { kind: "draft", draftId, setup: initialSetup },
    };
  }
  return {
    cwd: workspaceDirectory,
    provider,
    modeId: composerState.effectiveModeId || null,
    model: composerState.effectiveModelId || null,
    thinkingOptionId: composerState.effectiveThinkingOptionId || null,
    providerOptions: composerState.providerOptions,
    target: { kind: "draft", draftId },
  };
}

function submitWorkspaceDraft(input: SubmitDraftInput): SubmitOutcome {
  const {
    serverId,
    clearDraft,
    draftId: draftIdInput,
    workspaceId,
    workspaceDirectory,
    text,
    attachments,
    provider,
    composerState,
    initialSetup,
  } = input;
  const draftId = draftIdInput?.trim() || generateDraftId();
  const clientMessageId = `${draftId}:initial-message`;
  const timestamp = Date.now();
  const wirePayload = splitComposerAttachmentsForSubmit(attachments, {
    format: resolveComposerAttachmentSubmitFormat({
      supportsForgeAttachments: input.supportsForgeSearch,
    }),
  });
  const submission = resolveWorkspaceDraftSubmissionConfig({
    draftId,
    workspaceDirectory,
    provider,
    composerState,
    initialSetup,
  });
  const started = useCreateFlowStore.getState().trySetPending({
    serverId,
    draftId,
    workspaceId,
    agentId: null,
    clientMessageId,
    text: text.trim(),
    timestamp,
    ...(wirePayload.images.length > 0 ? { images: wirePayload.images } : {}),
    ...(wirePayload.attachments.length > 0 ? { attachments: wirePayload.attachments } : {}),
  });
  if (!started) return "navigated";
  useWorkspaceDraftSubmissionStore.getState().setPending({
    serverId,
    workspaceId,
    draftId,
    text: text.trim(),
    attachments,
    cwd: submission.cwd,
    provider: submission.provider,
    clientMessageId,
    timestamp,
    ...(submission.modeId ? { modeId: submission.modeId } : {}),
    ...(submission.model ? { model: submission.model } : {}),
    ...(submission.thinkingOptionId ? { thinkingOptionId: submission.thinkingOptionId } : {}),
    ...(submission.providerOptions ? { providerOptions: submission.providerOptions } : {}),
    allowEmptyText: true,
    agentCreation: input.agentCreation,
  });
  handOffDraftMetadata({ serverId, draftId, metadata: composerState.metadata });
  clearDraft("sent");
  navigateToWorkspace({
    serverId,
    workspaceId,
    target: submission.target,
  });
  return "navigated";
}

function useNewWorkspaceHostSelector(input: {
  initialServerId: string;
  allServerIds: string[];
  projects: HostProjectListItem[];
  lastActiveProject: HostProjectListItem | null;
  hostConnectionStatusByServerId: ReadonlyMap<string, HostRuntimeConnectionStatus>;
  workspaceMultiplicityByServerId: ReadonlyMap<string, boolean>;
}) {
  const routeServerId = input.initialServerId.trim();
  const defaultServerId = useMemo(
    () =>
      resolveNewWorkspaceInitialServerId({
        allServerIds: input.allServerIds,
        routeServerId: input.initialServerId,
        lastActiveProject: input.lastActiveProject,
        projects: input.projects,
        hostConnectionStatusByServerId: input.hostConnectionStatusByServerId,
        workspaceMultiplicityByServerId: input.workspaceMultiplicityByServerId,
      }),
    [
      input.allServerIds,
      input.hostConnectionStatusByServerId,
      input.initialServerId,
      input.lastActiveProject,
      input.projects,
      input.workspaceMultiplicityByServerId,
    ],
  );
  const [automaticSelection, setAutomaticSelection] = useState(() => ({
    routeServerId,
    serverId: defaultServerId,
  }));
  const [manualSelection, setManualSelection] = useState<{
    routeServerId: string;
    serverId: string;
  } | null>(null);
  const [hostPickerOpen, setHostPickerOpen] = useState(false);

  useEffect(() => {
    setAutomaticSelection((current) => {
      const nextServerId =
        current.routeServerId === routeServerId
          ? resolveNewWorkspaceAutomaticServerId({
              allServerIds: input.allServerIds,
              routeServerId: input.initialServerId,
              lastActiveProject: input.lastActiveProject,
              projects: input.projects,
              hostConnectionStatusByServerId: input.hostConnectionStatusByServerId,
              workspaceMultiplicityByServerId: input.workspaceMultiplicityByServerId,
              currentServerId: current.serverId,
              nextServerId: defaultServerId,
            })
          : defaultServerId;

      if (current.routeServerId === routeServerId && current.serverId === nextServerId) {
        return current;
      }

      return { routeServerId, serverId: nextServerId };
    });
  }, [
    defaultServerId,
    input.allServerIds,
    input.hostConnectionStatusByServerId,
    input.initialServerId,
    input.lastActiveProject,
    input.projects,
    input.workspaceMultiplicityByServerId,
    routeServerId,
  ]);

  const automaticServerId =
    automaticSelection.routeServerId === routeServerId &&
    input.allServerIds.includes(automaticSelection.serverId)
      ? automaticSelection.serverId
      : defaultServerId;
  const selectedServerId =
    manualSelection?.routeServerId === routeServerId &&
    input.allServerIds.includes(manualSelection.serverId)
      ? manualSelection.serverId
      : automaticServerId;

  const handleSelectHost = useCallback(
    (id: string) => {
      setManualSelection({ routeServerId, serverId: id });
      setHostPickerOpen(false);
    },
    [routeServerId],
  );

  const handleHostPickerOpenChange = useCallback((open: boolean) => {
    setHostPickerOpen(open);
  }, []);

  const openHostPicker = useCallback(() => {
    setHostPickerOpen(true);
  }, []);

  return {
    selectedServerId,
    hostPickerOpen,
    handleSelectHost,
    handleHostPickerOpenChange,
    openHostPicker,
  };
}

interface NewWorkspaceInitialContextState {
  allHosts: HostProfile[];
  selectedServerId: string;
  hostPickerOpen: boolean;
  handleSelectHost: (id: string) => void;
  handleHostPickerOpenChange: (open: boolean) => void;
  openHostPicker: () => void;
  projects: HostProjectListItem[];
  routeProject: HostProjectListItem | null;
  routeProjectContextViewKey: string | null;
  lastActiveProject: HostProjectListItem | null;
}

function useNewWorkspaceInitialContext(
  {
    serverId,
    sourceDirectory: sourceDirectoryProp,
    projectId,
    displayName: displayNameProp,
  }: NewWorkspaceScreenProps,
  isTimelineFork: boolean,
): NewWorkspaceInitialContextState {
  const allHosts = useHosts();
  const allServerIds = useMemo(() => allHosts.map((h) => h.serverId), [allHosts]);
  const projects = useHostProjects(allServerIds);
  const routeDisplayName = displayNameProp?.trim() ?? "";
  const routePlacement = useMemo(
    () =>
      hostProjectFromRoute({
        serverId,
        projectId,
        displayName: routeDisplayName,
        sourceDirectory: sourceDirectoryProp,
      }),
    [projectId, routeDisplayName, serverId, sourceDirectoryProp],
  );
  const routeProject = useMemo(() => {
    if (!routePlacement) return null;
    return (
      resolveHostProjectCandidate({
        candidate: routePlacement,
        projects,
        serverId,
      }) ?? routePlacement
    );
  }, [projects, routePlacement, serverId]);
  const lastWorkspaceSelection = useLastWorkspaceSelection();
  const lastWorkspaceServerId = useMemo(
    () =>
      lastWorkspaceSelection && allServerIds.includes(lastWorkspaceSelection.serverId)
        ? lastWorkspaceSelection.serverId
        : null,
    [allServerIds, lastWorkspaceSelection],
  );
  const lastWorkspaceId = lastWorkspaceServerId ? lastWorkspaceSelection!.workspaceId : null;
  const lastWorkspace = useWorkspace(lastWorkspaceServerId, lastWorkspaceId);
  const lastActiveProject = useMemo(
    () =>
      lastWorkspaceServerId
        ? hostProjectFromWorkspace({ serverId: lastWorkspaceServerId, workspace: lastWorkspace })
        : null,
    [lastWorkspace, lastWorkspaceServerId],
  );
  const hostConnectionStatusByServerId = useHostRuntimeConnectionStatuses(allServerIds);
  const workspaceMultiplicityByServerId = useHostFeatureMap(allServerIds, "workspaceMultiplicity");
  const {
    selectedServerId,
    hostPickerOpen,
    handleSelectHost,
    handleHostPickerOpenChange,
    openHostPicker,
  } = useNewWorkspaceHostSelector({
    initialServerId: serverId,
    allServerIds,
    projects,
    lastActiveProject,
    hostConnectionStatusByServerId,
    workspaceMultiplicityByServerId,
  });

  return {
    allHosts,
    // The selected history belongs to its source host, including while that host is offline.
    selectedServerId: isTimelineFork ? serverId.trim() : selectedServerId,
    hostPickerOpen,
    handleSelectHost,
    handleHostPickerOpenChange,
    openHostPicker,
    projects,
    routeProject,
    routeProjectContextViewKey: routePlacement?.viewKey ?? null,
    lastActiveProject,
  };
}

function useDefaultWorkspaceMainAgent(serverId: string) {
  // COMPAT(workspaceMainAgentDefault): added in v0.16.0, remove gate after 2027-05-20.
  const supported = useHostFeature(serverId, "workspaceMainAgentDefault");
  const { settings } = useAppSettings();
  return supported && settings.defaultWorkspaceMainAgent;
}

function readSubmittedForkIntent(draftId: string, serverId: string) {
  const stored = useWorkspaceDraftSubmissionStore.getState().draftSetupStatusById[draftId];
  return typeof stored === "object" && stored.sourceServerId === serverId
    ? readForkAgentIntent(stored)
    : undefined;
}

function workspaceCreationErrorMessage(t: TFunction, error: unknown, explicitMain: boolean) {
  const block = explicitMain ? workspaceMainErrorBlock(error) : null;
  return block ? workspaceMainBlockMessage(t, block) : toErrorMessage(error);
}

export function NewWorkspaceScreen({
  creationDraftId,
  rememberCreationDraft,
  ...props
}: NewWorkspaceScreenProps & {
  creationDraftId?: string;
  rememberCreationDraft: (id: string) => void;
}) {
  const forkDraftId = props.draftId;
  const id = forkDraftId ?? creationDraftId;
  const focused = useIsFocused();
  const title = useWorkspaceDraftSubmissionStore((state) =>
    id && Object.hasOwn(state.titlesById, id) ? state.titlesById[id] : undefined,
  );
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const retry = useCallback(() => setError(null), []);
  const mainDraft = useQuery({
    queryKey: ["new-workspace-main-draft", id],
    queryFn: () => (id ? readMainDraft(id) : null),
    enabled: Boolean(title && !forkDraftId),
    gcTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (!focused || title || error) return;
    let active = true;
    async function open() {
      try {
        const openedId = await useWorkspaceDraftSubmissionStore.getState().openDraftTitle({
          forkDraftId,
          creationDraftId,
          createWorktreeSlug: createNameId,
        });
        if (active && !forkDraftId && openedId !== creationDraftId) rememberCreationDraft(openedId);
      } catch (cause) {
        if (active) setError(toErrorMessage(cause));
      }
    }
    void open();
    return () => {
      active = false;
    };
  }, [creationDraftId, forkDraftId, focused, error, title, rememberCreationDraft]);
  const { refetch: refetchMainDraft } = mainDraft;
  const retryMainDraft = useCallback(() => void refetchMainDraft(), [refetchMainDraft]);
  if (!title || (!forkDraftId && !mainDraft.isFetchedAfterMount)) {
    return (
      <View style={styles.titleLoading}>
        {error ? (
          <>
            <Text accessibilityRole="alert" style={styles.errorText}>
              {error}
            </Text>
            <Button variant="ghost" onPress={retry}>
              {t("common.actions.retry")}
            </Button>
          </>
        ) : (
          <ActivityIndicator />
        )}
      </View>
    );
  }
  if (!forkDraftId && mainDraft.isError) {
    return (
      <View style={styles.titleLoading}>
        <Text accessibilityRole="alert" style={styles.errorText}>
          {workspaceMainBlockMessage(t, "unknown")}
        </Text>
        <Button variant="ghost" onPress={retryMainDraft}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }
  return (
    <NewWorkspaceForm
      key={title.draftId}
      {...props}
      creationIdentity={title}
      restoredMainDraft={mainDraft.data ?? null}
    />
  );
}

function initialNewWorkspaceRoute(main: MainDraft | null, route: NewWorkspaceScreenProps) {
  if (!main) return route;
  const { serverId, sourceDirectory, projectId } = main.target;
  return { serverId, sourceDirectory, projectId };
}

function useMainDraftSelection(id: string, initial: MainDraft | null) {
  const [restoredMainTarget, setRestoredMainTarget] = useState(() => initial?.target ?? null);
  const [mainDraft, setMainDraft] = useState(initial);
  const mainDraftRef = useRef(initial);
  const saveMainDraft = useCallback(
    (next: MainDraft | null) => {
      mainDraftRef.current = next;
      setMainDraft(next);
      return writeMainDraft(id, next);
    },
    [id],
  );
  return {
    restoredMainTarget,
    setRestoredMainTarget,
    mainDraft,
    mainDraftRef,
    mainAttempt: mainDraft?.attempt,
    saveMainDraft,
  };
}

function NewWorkspaceForm({
  serverId,
  sourceDirectory: sourceDirectoryProp,
  projectId,
  displayName: displayNameProp,
  draftId,
  creationIdentity,
  restoredMainDraft,
}: NewWorkspaceScreenProps & {
  creationIdentity: WorkspaceDraftTitle;
  restoredMainDraft: MainDraft | null;
}) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const toast = useToast();
  const {
    restoredMainTarget,
    setRestoredMainTarget,
    mainDraft,
    mainDraftRef,
    mainAttempt,
    saveMainDraft,
  } = useMainDraftSelection(creationIdentity.draftId, restoredMainDraft);
  const beforeIsolationChange = useRef<SetupEffects["beforeIsolationChange"]>(undefined);
  const {
    forkDraftSetup,
    isTimelineFork,
    reservedWorktreeSlug,
    submittedForkIsolation,
    storedDraft,
  } = usePendingWorkspaceDraftSetup(draftId);
  const [restoredWorktree] = useState(() => storedDraft?.worktreeSubmission);
  const [restoredAgentIntent] = useState(() => readForkAgentIntent(storedDraft));
  const agentConfigRevision = useRef(0);
  const submittedAgentConfigRevision = useRef(0);
  const markAgentConfigEdited = useCallback(() => {
    agentConfigRevision.current += 1;
  }, []);
  const composerEditing = useNewWorkspaceComposerEditing();
  const { leaveFullscreen } = composerEditing;
  const mergeWorkspaces = useCallback(
    (targetServerId: string, workspaces: Iterable<WorkspaceDescriptor>) => {
      getHostRuntimeStore().acceptWorkspaceSnapshots(targetServerId, Array.from(workspaces));
    },
    [],
  );
  const {
    allHosts,
    selectedServerId,
    hostPickerOpen,
    handleSelectHost,
    handleHostPickerOpenChange,
    openHostPicker,
    projects,
    routeProject,
    routeProjectContextViewKey,
    lastActiveProject,
  } = useNewWorkspaceInitialContext(
    restoreForkWorktreeProject(
      initialNewWorkspaceRoute(restoredMainDraft, {
        serverId,
        sourceDirectory: sourceDirectoryProp,
        projectId,
        displayName: displayNameProp,
      }),
      restoredWorktree,
    ),
    isTimelineFork,
  );
  // COMPAT(workspaceMultiplicity): added in v0.1.97, drop the gate when floor >= v0.1.97
  const supportsWorkspaceMultiplicity = useHostFeature(selectedServerId, "workspaceMultiplicity");
  const supportsForgeSearch = useHostFeature(selectedServerId, "forgeSearch");
  const createMainAgent = useDefaultWorkspaceMainAgent(selectedServerId);
  const draftKey = buildNewWorkspaceDraftKey(draftId);
  const creationDraftId = creationIdentity.draftId;
  const commitTitle = useCallback(
    (value: string) => {
      void useWorkspaceDraftSubmissionStore
        .getState()
        .editDraftTitle(creationDraftId, value)
        .catch((error) => toast.error(toErrorMessage(error)));
    },
    [creationDraftId, toast],
  );
  const finishTitle = useCallback(() => {
    void useWorkspaceDraftSubmissionStore
      .getState()
      .finishDraftTitle(creationDraftId)
      .catch((error) => toast.error(toErrorMessage(error)));
  }, [creationDraftId, toast]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [creationResult, setCreationResult] = useState<
    WorkspaceCreationResult | { workspace: null }
  >({ workspace: null });
  const [pendingAction, setPendingAction] = useState<"chat" | "empty" | "terminal" | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const openAddProjectPicker = useOpenAddProject();
  const [isolationPickerOpen, setIsolationPickerOpen] = useState(false);
  const [pickerSearchQuery, setPickerSearchQuery] = useState("");
  const [debouncedPickerSearchQuery, setDebouncedPickerSearchQuery] = useState("");
  const pickerAnchorRef = useRef<View>(null);
  const projectPickerAnchorRef = useRef<View>(null);
  const isolationPickerAnchorRef = useRef<View>(null);
  const hostPickerAnchorRef = useRef<View | null>(null);
  const isDraftHandoffActive = useIsNewWorkspaceDraftHandoffActive({ draftId, selectedServerId });
  const isStillOnCreateScreen = useNewWorkspaceScreenPresence();
  const isScreenFocused = useIsFocused();
  const projectPickHandlerId = useId();

  // Launch target: what the composer submits to (chat agent, or a terminal
  // profile). Mirrors useWorkspaceIsolation's pattern below: the derived
  // value reads live from preferences until the user manually picks
  // something in this screen, so the async preferences load doesn't race a
  // frozen useState initializer.
  const { preferences: formPreferences, updatePreferences: updateFormPreferences } =
    useFormPreferences();
  const { config: daemonConfig } = useDaemonConfig(selectedServerId);
  const terminalProfiles: readonly TerminalProfile[] = useMemo(
    () => resolveTerminalProfiles(daemonConfig?.terminalProfiles),
    [daemonConfig?.terminalProfiles],
  );
  // Manual selection wins once the user picks something; until then the target
  // reads live from preferences so the async load can't race a frozen
  // initializer. Both go through `resolveLaunchTarget`, so a profile deleted
  // daemon-side falls back to chat rather than leaving a dead selection.
  const [manualLaunchTarget, setManualLaunchTarget] = useState<LaunchTarget | null>(null);
  const launchTarget = useMemo(
    () =>
      isTimelineFork || (mainDraft && !manualLaunchTarget)
        ? CHAT_LAUNCH_TARGET
        : resolveLaunchTarget(manualLaunchTarget ?? formPreferences.launchTarget, terminalProfiles),
    [isTimelineFork, mainDraft, manualLaunchTarget, formPreferences.launchTarget, terminalProfiles],
  );
  const [terminalPromptText, setTerminalPromptText] = useState("");
  const {
    isTerminalLaunch,
    selectedTerminalProfile,
    terminalTakesPrompt,
    terminalComposerValue,
    terminalPlaceholder,
    terminalSubmitLabel,
    launchFocusKey,
  } = useTerminalComposerState({ launchTarget, terminalProfiles, terminalPromptText });
  const terminalTextSource = useMemo(
    () => ({
      getSnapshot: () => terminalComposerValue,
      subscribe: (_listener: () => void) => () => {},
    }),
    [terminalComposerValue],
  );
  const terminalTextReplacement = useMemo(
    () => ({ kind: "replace" as const, key: launchFocusKey, text: terminalComposerValue }),
    [launchFocusKey, terminalComposerValue],
  );

  useEffect(() => {
    const trimmed = pickerSearchQuery.trim();
    const timer = setTimeout(() => setDebouncedPickerSearchQuery(trimmed), 180);
    return () => clearTimeout(timer);
  }, [pickerSearchQuery]);

  const { workspace: createdWorkspace } = creationResult;
  const client = useHostRuntimeClient(selectedServerId);
  const isConnected = useHostRuntimeIsConnected(selectedServerId);
  const {
    selectedProject,
    selectedSourceDirectory,
    projectPickerOptions,
    projectByOptionId,
    selectedProjectOptionId,
    projectTriggerLabel,
    handleSelectProjectOption: selectProjectOption,
  } = useNewWorkspaceProjectPicker({
    selectedServerId,
    projects,
    routeProject,
    routeProjectContextViewKey,
    lastActiveProject,
    allowAllProjects: supportsWorkspaceMultiplicity,
  });
  const projectIconTargets = useMemo(
    () => buildNewWorkspaceProjectIconTargets(projects, selectedServerId),
    [projects, selectedServerId],
  );

  const projectIconDataByProjectViewKey = useProjectIcons({
    projects: projectIconTargets,
  });
  const draftContextScopeKey = useDraftWorkspaceAttachmentScopeKey(draftId);
  const visibleDraftContextScopeKeys = useMemo(
    () => resolveVisibleDraftContextScopeKeys({ isDraftHandoffActive, draftContextScopeKey }),
    [draftContextScopeKey, isDraftHandoffActive],
  );
  const chatDraft = useAgentInputDraft({
    draftKey,
    composer: buildComposerConfig({
      serverId: selectedServerId,
      workspaceDirectory: createdWorkspace?.workspaceDirectory ?? null,
      sourceDirectory: selectedSourceDirectory,
      initialSetup: forkDraftSetup?.setup,
      restoredAgentIntent,
    }),
  });
  const composerState = chatDraft.composerState;
  const supportsWorktreeList = useHostFeature(selectedServerId, "checkoutWorktreeList");
  const projectWorktrees = useProjectWorktrees({
    client,
    serverId: selectedServerId,
    cwd: selectedSourceDirectory,
    enabled: supportsWorktreeList && isConnected,
  });
  const {
    setup,
    pluginProject,
    projectId: selectedProjectId,
    canCreateWorktree,
    isPending,
  } = usePluginSetup({
    serverId: selectedServerId,
    project: selectedProject,
    worktrees: projectWorktrees,
    supportsMultiplicity: supportsWorkspaceMultiplicity,
    restoredWorktree,
    pendingAction,
    isDraftHandoffActive,
    beforeIsolationChange,
    updatePreferences: updateFormPreferences,
    setAttachments: chatDraft.setAttachments,
  });
  const submittedWorktreeAtTarget = forkWorktreeAtTarget(
    storedDraft,
    selectedServerId,
    selectedProjectId,
    selectedSourceDirectory,
  );
  const dispatchPickerSelection = setup.dispatchPicker;
  const setupState = useNewWorkspaceSetupState(setup);
  const selectedItem = setupState.pickerSelection.selectedItem;
  const supportsRefActions = useHostFeature(selectedServerId, "worktreeRefActions");
  const { refActions } = setupState;
  const refActionFor = useMemo(
    () => ({
      branch: refActionOf({ refActions, supportsRefActions, kind: "branch" }),
      "github-pr": refActionOf({ refActions, supportsRefActions, kind: "github-pr" }),
    }),
    [refActions, supportsRefActions],
  );
  const existingWorktrees = useExistingWorktrees(projectWorktrees);

  const handleForgeChangeRequestDetected = useCallback(() => {
    dispatchPickerSelection({ type: "pr-detected" });
  }, [dispatchPickerSelection]);

  const handleForgeChangeRequestAutoAttach = useCallback(
    (item: ForgeSearchItem) => {
      dispatchPickerSelection({
        type: "pr-added",
        item: { kind: "github-pr", item },
      });
    },
    [dispatchPickerSelection],
  );

  const withConnectedClient = useCallback(() => {
    const connectedClient = getHostRuntimeStore().getClient(selectedServerId);
    if (!connectedClient?.isConnected) {
      throw new Error(t("newWorkspace.errors.hostDisconnected"));
    }
    return connectedClient;
  }, [selectedServerId, t]);

  const clientReady = isConnected && Boolean(client);
  const hasSelectedSourceDirectory = selectedSourceDirectory !== null;
  const pickerQueryEnabled = pickerOpen && clientReady && hasSelectedSourceDirectory;

  const { status: checkoutStatus } = useCheckoutStatusQuery({
    serverId: selectedServerId,
    cwd: selectedSourceDirectory ?? "",
  });

  const matchedMainTarget = useMemo(
    () =>
      restoredMainTarget?.serverId === selectedServerId &&
      restoredMainTarget.projectId === selectedProjectId &&
      restoredMainTarget.sourceDirectory === selectedSourceDirectory
        ? restoredMainTarget
        : null,
    [restoredMainTarget, selectedProjectId, selectedServerId, selectedSourceDirectory],
  );
  const {
    effectiveIsolation,
    setIsolation,
    showRefPicker,
    choice,
    existingWorktreePath,
    workingDirectory,
  } = useWorkspaceIsolation({
    setup,
    supportsMultiplicity: supportsWorkspaceMultiplicity,
    canCreateWorktree,
    existingWorktrees,
    projectDirectory: selectedSourceDirectory,
    submittedForkIsolation,
    restoredMainTarget: matchedMainTarget,
  });
  const mainTarget = useMemo(
    () =>
      selectedProjectId && selectedSourceDirectory && workingDirectory
        ? {
            serverId: selectedServerId,
            projectId: selectedProjectId,
            sourceDirectory: selectedSourceDirectory,
            directory: workingDirectory,
            isolation: choice,
          }
        : null,
    [choice, selectedProjectId, selectedServerId, selectedSourceDirectory, workingDirectory],
  );
  const supportsCreateAsMain = useHostFeature(selectedServerId, "agentCreateAsMain");
  const assertExplicitMainSupported = useCallback(() => {
    // COMPAT(agentCreateAsMain): added in v0.17.0-beta.1, remove gate after 2027-05-22.
    if (!selectHostFeature(useSessionStore.getState(), selectedServerId, "agentCreateAsMain")) {
      throw new Error(workspaceMainBlockMessage(t, "unsupported"));
    }
  }, [selectedServerId, t]);
  const reportMainDraftStorageError = useCallback(() => {
    toast.error(workspaceMainBlockMessage(t, "unknown"));
  }, [t, toast]);
  const forgetMainTarget = useCallback(() => {
    if (mainDraftRef.current?.attempt || pendingExplicitMainSubmissions.has(creationDraftId))
      return false;
    setRestoredMainTarget(null);
    if (mainDraftRef.current) void saveMainDraft(null).catch(reportMainDraftStorageError);
    return true;
  }, [
    creationDraftId,
    mainDraftRef,
    reportMainDraftStorageError,
    saveMainDraft,
    setRestoredMainTarget,
  ]);
  useLayoutEffect(() => {
    beforeIsolationChange.current = (next) => {
      if (mainDraftRef.current?.attempt || pendingExplicitMainSubmissions.has(creationDraftId))
        return false;
      if (typeof next === "string" ? next === choice : next.path === existingWorktreePath)
        return true;
      return forgetMainTarget();
    };
  }, [choice, creationDraftId, existingWorktreePath, forgetMainTarget, mainDraftRef]);
  const workspaceMain = useMemo(() => {
    if (
      !mainTarget ||
      !canChooseWorkspaceMain({
        setup: forkDraftSetup?.setup,
        isTerminal: isTerminalLaunch,
        isHandoff: Boolean(draftId),
      })
    )
      return undefined;
    const checked = Boolean(restoreMainDraftAtTarget(mainDraft, mainTarget));
    return {
      checked,
      disabled: Boolean(mainAttempt) || (!checked && !supportsCreateAsMain),
      hint: supportsCreateAsMain ? undefined : workspaceMainBlockMessage(t, "unsupported"),
      onChange: (next: boolean) => {
        if (mainAttempt || pendingExplicitMainSubmissions.has(creationDraftId)) return;
        if (next && !supportsCreateAsMain) return;
        setRestoredMainTarget(null);
        if (mainTarget.isolation === "existing") setup.chooseExistingWorktree(mainTarget.directory);
        else if (restoredMainTarget) setIsolation(mainTarget.isolation);
        void saveMainDraft(next ? { target: mainTarget } : null).catch(reportMainDraftStorageError);
      },
    };
  }, [
    creationDraftId,
    draftId,
    forkDraftSetup?.setup,
    isTerminalLaunch,
    mainAttempt,
    mainDraft,
    mainTarget,
    reportMainDraftStorageError,
    restoredMainTarget,
    saveMainDraft,
    setIsolation,
    setRestoredMainTarget,
    setup,
    supportsCreateAsMain,
    t,
  ]);
  const launchControl = useMemo(
    () => ({
      serverId: selectedServerId,
      target: launchTarget,
      onChange: setManualLaunchTarget,
      profiles: terminalProfiles,
      disabled: isPending || isTimelineFork || Boolean(mainAttempt),
    }),
    [isPending, isTimelineFork, launchTarget, mainAttempt, selectedServerId, terminalProfiles],
  );

  const branchSuggestionsQuery = useQuery({
    queryKey: [
      "branch-suggestions",
      selectedServerId,
      selectedSourceDirectory,
      debouncedPickerSearchQuery,
    ],
    queryFn: async () => {
      if (!selectedSourceDirectory) {
        throw new Error("Choose a project");
      }
      const connectedClient = withConnectedClient();
      return connectedClient.getBranchSuggestions({
        cwd: selectedSourceDirectory,
        query: debouncedPickerSearchQuery || undefined,
        limit: 20,
      });
    },
    enabled: pickerQueryEnabled,
    staleTime: 15_000,
  });

  const changeRequestContext = useChangeRequestContext({
    serverId: selectedServerId,
    cwd: selectedSourceDirectory,
    pickerOpen: pickerQueryEnabled,
    selectedItem,
  });

  const githubPrSearchQuery = useForgeSearchQuery({
    client,
    serverId: selectedServerId,
    cwd: selectedSourceDirectory ?? "",
    query: debouncedPickerSearchQuery,
    kinds: ["change_request"],
    supportsForgeSearch,
    enabled: pickerQueryEnabled,
  });

  const branchDetails = useMemo(
    () => normalizeBranchDetails(branchSuggestionsQuery.data),
    [branchSuggestionsQuery.data],
  );
  const forgeSearchAuthenticated =
    !githubPrSearchQuery.data || githubPrSearchQuery.data.authState === "authenticated";
  const prItems: ForgeSearchItem[] = useMemo(() => {
    if (!forgeSearchAuthenticated) return [];
    return githubPrSearchQuery.data?.items ?? [];
  }, [forgeSearchAuthenticated, githubPrSearchQuery.data?.items]);

  const baseItem = useMemo(
    () => resolveStartingRef(selectedItem, submittedWorktreeAtTarget, checkoutStatus),
    [checkoutStatus, selectedItem, submittedWorktreeAtTarget],
  );
  const { options, itemById, selectedOptionId }: PickerOptionData = useMemo(
    () =>
      buildPickerOptionData({
        branchDetails,
        prItems,
        baseItem,
      }),
    [baseItem, branchDetails, prItems],
  );
  const triggerLabel = useMemo(() => {
    const displayItem = itemById.get(selectedOptionId);
    return displayItem ? pickerItemLabel(displayItem) : "main";
  }, [itemById, selectedOptionId]);
  const selectPickerItem = useCallback(
    (item: PickerItem) => {
      setup.chooseRef(item);
      setPickerOpen(false);
    },
    [setup],
  );

  const pluginScreen = useMemo<NewWorkspaceItemsScreen>(
    () => ({ project: pluginProject, isolation: effectiveIsolation, baseItem, locked: isPending }),
    [baseItem, effectiveIsolation, isPending, pluginProject],
  );

  const handleSelectOption = useCallback(
    (id: string) => {
      const item = itemById.get(id);
      if (!item) return;
      selectPickerItem(item);
    },
    [itemById, selectPickerItem],
  );

  const clearPickerSelectionForTargetChange = useCallback(
    (currentTargetId: string, nextTargetId: string) => {
      const nextAttachments = clearPickerPrAttachmentForTargetChange({
        attachments: chatDraft.attachments,
        currentTargetId,
        nextTargetId,
      });
      if (nextAttachments === chatDraft.attachments) return;
      chatDraft.setAttachments(nextAttachments);
      dispatchPickerSelection({ type: "target-changed" });
    },
    [chatDraft, dispatchPickerSelection],
  );

  const handleSelectProjectOption = useCallback(
    (id: string) => {
      // selectProjectOption enforces selectability (worktree-only when
      // multiplicity is off, any project when it's on); don't re-gate here on
      // canCreateWorktree or non-git projects become unselectable.
      if (id !== selectedProjectOptionId && !forgetMainTarget()) return;
      selectProjectOption(id);
      setProjectPickerOpen(false);
      clearPickerSelectionForTargetChange(selectedProjectOptionId, id);
    },
    [
      clearPickerSelectionForTargetChange,
      forgetMainTarget,
      selectProjectOption,
      selectedProjectOptionId,
    ],
  );

  const handleSelectWorkspaceHost = useCallback(
    (id: string) => {
      if (isTimelineFork && id !== serverId.trim()) {
        toast.error(t("message.actions.forkUnavailable"));
        return;
      }
      if (id !== selectedServerId && !forgetMainTarget()) return;
      handleSelectHost(id);
      clearPickerSelectionForTargetChange(selectedServerId, id);
    },
    [
      clearPickerSelectionForTargetChange,
      forgetMainTarget,
      handleSelectHost,
      isTimelineFork,
      selectedServerId,
      serverId,
      t,
      toast,
    ],
  );

  const handleAddProject = useCallback(() => {
    setProjectPickerOpen(false);
    openAddProjectPicker(selectedServerId);
  }, [openAddProjectPicker, selectedServerId]);

  const handleAddHost = useAddHost();

  const openPicker = useCallback(() => {
    setPickerOpen(true);
  }, []);

  const openProjectPicker = useCallback(() => {
    setProjectPickerOpen(true);
  }, []);

  // On this screen, both project-pick and new-workspace open the chooser.
  // Take precedence over global new-workspace navigation to preserve the draft.
  const handleProjectPick = useCallback(() => {
    openProjectPicker();
    return true;
  }, [openProjectPicker]);
  useKeyboardActionHandler({
    handlerId: `new-workspace-project-pick:${projectPickHandlerId}`,
    actions: PROJECT_PICK_ACTIONS,
    enabled: isScreenFocused,
    isActive: isStillOnCreateScreen,
    priority: 10,
    handle: handleProjectPick,
  });

  const openIsolationPicker = useCallback(() => {
    setIsolationPickerOpen(true);
  }, []);

  const handleIsolationPickerOpenChange = useCallback((nextOpen: boolean) => {
    setIsolationPickerOpen(nextOpen);
  }, []);

  const handleClearDraft = useCallback(() => {
    // No-op: screen navigates away on success, text should stay for retry on error
  }, []);

  const handlePickerOpenChange = useCallback((nextOpen: boolean) => {
    setPickerOpen(nextOpen);
    if (!nextOpen) {
      setPickerSearchQuery("");
    }
  }, []);

  const handleProjectPickerOpenChange = useCallback((nextOpen: boolean) => {
    setProjectPickerOpen(nextOpen);
  }, []);

  const prepareWorkspacePlacement = useCallback(
    async (createSeparateMain: boolean, agentConfig?: ForkAgentIntent["config"]) => {
      if (!selectedProject || !selectedProjectId) throw new Error("Choose a project");
      if (!selectedSourceDirectory || !workingDirectory) {
        throw new Error("Choose a host for this project");
      }
      const connectedClient = withConnectedClient();
      const metadata = setup.getSnapshot().metadata;
      const createsWorktree = !supportsWorkspaceMultiplicity || effectiveIsolation === "worktree";
      const worktree = createsWorktree
        ? await resolveWorktreeSubmission({
            setup,
            submittedWorktree: submittedWorktreeAtTarget,
            readCheckoutStatus: () =>
              ensureCheckoutStatus({
                queryClient,
                client: connectedClient,
                serverId: selectedServerId,
                cwd: selectedSourceDirectory,
              }),
            sourceDirectory: workingDirectory,
            projectId: selectedProjectId,
            worktreeSlug: reservedWorktreeSlug ?? creationIdentity.worktreeSlug,
            t,
          })
        : undefined;
      const source = await recordWorkspaceCreationSource({
        directory: { kind: "directory", path: workingDirectory, projectId: selectedProjectId },
        worktree,
        forkDraft: isTimelineFork
          ? { draftId: creationDraftId, serverId: selectedServerId }
          : undefined,
        agentConfig,
        createMainAgent: createSeparateMain,
      });
      const title = await useWorkspaceDraftSubmissionStore
        .getState()
        .submitDraftTitle(creationDraftId);
      return { source, title, metadata };
    },
    [
      creationDraftId,
      creationIdentity.worktreeSlug,
      effectiveIsolation,
      isTimelineFork,
      queryClient,
      reservedWorktreeSlug,
      selectedProject,
      selectedProjectId,
      selectedServerId,
      selectedSourceDirectory,
      setup,
      submittedWorktreeAtTarget,
      supportsWorkspaceMultiplicity,
      t,
      withConnectedClient,
      workingDirectory,
    ],
  );

  const assertNoMainAttempt = useCallback(async () => {
    if (draftId) return;
    if (
      pendingExplicitMainSubmissions.has(creationDraftId) ||
      (await readMainDraft(creationDraftId))?.attempt
    ) {
      throw new Error(workspaceMainBlockMessage(t, "unknown"));
    }
  }, [creationDraftId, draftId, t]);

  const ensureWorkspace = useCallback<EnsureWorkspace>(
    async (input) => {
      await assertNoMainAttempt();
      const cached = readCachedWorkspaceCreation(creationResult, input.agent, t);
      if (cached) return cached;
      const mainAgent = resolveSeparateMainAgent({
        request: input,
        createMainAgent,
        composerState,
        preferredProvider: formPreferences.provider,
        t,
      });
      const placement = await prepareWorkspacePlacement(Boolean(mainAgent), input.agent?.config);
      const normalizedWorkspace = await createMultiplicityWorkspace({
        ...placement,
        idempotencyKey: creationDraftId,
        client: withConnectedClient(),
        withInitialAgent: input.withInitialAgent,
        prompt: input.prompt,
        attachments: input.attachments,
        agent: input.agent,
        mainAgent,
        onEvent: input.onEvent,
        mergeWorkspaces,
        serverId: selectedServerId,
        createFailedMessage: t("newWorkspace.errors.createWorktreeFailed"),
      });
      setCreationResult(normalizedWorkspace);
      return normalizedWorkspace;
    },
    [
      assertNoMainAttempt,
      creationDraftId,
      creationResult,
      composerState,
      createMainAgent,
      formPreferences.provider,
      mergeWorkspaces,
      prepareWorkspacePlacement,
      selectedServerId,
      t,
      withConnectedClient,
    ],
  );

  const submitExplicitMain = useCallback(
    async (payload: MessagePayload, target: MainDraftTarget) => {
      const clearConsumedDraft = captureWorkspaceDraftCleanup({
        draftId: creationDraftId,
        draftKey,
        draftContextScopeKey,
        clearDraft: chatDraft.clear,
      });
      const provider = composerState?.selectedProvider;
      const config = provider
        ? buildWorkspaceAgentConfig(target.directory, provider, composerState)
        : null;
      const metadata = composerState?.metadata;
      const format = resolveComposerAttachmentSubmitFormat({
        supportsForgeAttachments: supportsForgeSearch,
      });
      const wire = splitComposerAttachmentsForSubmit(payload.attachments, { format });
      const unavailableMessage = workspaceMainBlockMessage(t, "unknown");
      const previous = restoreMainDraftAtTarget(await readMainDraft(creationDraftId), target);
      if (!previous) throw new Error(unavailableMessage);
      const { workspace, agent } = await createOrRetryWorkspaceMain({
        client: withConnectedClient(),
        target,
        previous,
        save: saveMainDraft,
        prepareAgent: async () => {
          if (!composerState) throw new Error(t("newWorkspace.errors.composerStateRequired"));
          if (!config) throw new Error(t("newWorkspace.errors.selectModel"));
          const images = await encodeImages(wire.images, t("composer.errors.failedToSend"));
          await composerState.persistFormPreferences();
          await updateFormPreferences({ launchTarget });
          return {
            config,
            ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
            initialPrompt: payload.text,
            clientMessageId: `${creationDraftId}:initial-message`,
            images: images?.length ? images : undefined,
            attachments: wire.attachments?.length ? wire.attachments : undefined,
          };
        },
        prepareWorkspace: () => prepareWorkspacePlacement(false),
        canCreateWorkspace: Boolean(restoreMainDraftAtTarget(previous, mainTarget)),
        assertSupported: assertExplicitMainSupported,
        unavailableMessage,
        inProgressMessage: t("panels.draft.creatingAgent"),
        failedMessage: t("composer.errors.failedToCreateAgent"),
      });
      const normalizedWorkspace = normalizeWorkspaceDescriptor(workspace);
      mergeWorkspaces(selectedServerId, [{ ...normalizedWorkspace, hasActiveMainAgent: true }]);
      getHostRuntimeStore().acceptAgentSnapshot(
        selectedServerId,
        normalizeAgentSnapshot(agent, selectedServerId),
      );
      clearConsumedDraft();
      if (isStillOnCreateScreen()) {
        leaveFullscreen();
        navigateToWorkspace({
          serverId: selectedServerId,
          workspaceId: workspace.id,
          target: { kind: "agent", agentId: agent.id },
        });
      }
      await useWorkspaceDraftSubmissionStore
        .getState()
        .finishDraftTitle(creationDraftId)
        .then(() => writeMainDraft(creationDraftId, null))
        .catch(reportMainDraftStorageError);
    },
    [
      assertExplicitMainSupported,
      chatDraft.clear,
      composerState,
      creationDraftId,
      draftContextScopeKey,
      draftKey,
      isStillOnCreateScreen,
      launchTarget,
      leaveFullscreen,
      mainTarget,
      mergeWorkspaces,
      prepareWorkspacePlacement,
      reportMainDraftStorageError,
      saveMainDraft,
      selectedServerId,
      supportsForgeSearch,
      t,
      updateFormPreferences,
      withConnectedClient,
    ],
  );

  const handleSubmitExplicitMain = useCallback(
    async (payload: MessagePayload, draft: MainDraft) => {
      const canRecover = draft.attempt && draft.target.serverId === selectedServerId;
      const canCreate = restoreMainDraftAtTarget(draft, mainTarget);
      if ((!canRecover && !canCreate) || pendingExplicitMainSubmissions.has(creationDraftId)) {
        throw new Error(workspaceMainBlockMessage(t, "unknown"));
      }
      pendingExplicitMainSubmissions.add(creationDraftId);
      setPendingAction("chat");
      try {
        await submitExplicitMain(payload, draft.target);
      } finally {
        pendingExplicitMainSubmissions.delete(creationDraftId);
        setPendingAction(null);
      }
    },
    [creationDraftId, mainTarget, selectedServerId, submitExplicitMain, t],
  );

  const handleSubmitNewWorkspace = useCallback(
    async (payload: MessagePayload) => {
      const armedMain = mainDraftRef.current;
      try {
        setErrorMessage(null);
        // The source agent ID is local to the host that opened this draft.
        if (isTimelineFork && selectedServerId !== serverId.trim()) {
          throw new Error(t("message.actions.forkUnavailable"));
        }
        if (armedMain) {
          await handleSubmitExplicitMain(payload, armedMain);
          return;
        }
        await assertNoMainAttempt();
        await composerState?.persistFormPreferences();
        if (!isTimelineFork) await updateFormPreferences({ launchTarget });
        if (!isTimelineFork && isEmptyWorkspaceSubmission(payload)) {
          setPendingAction("empty");
          let outcome: SubmitOutcome = "background";
          await runCreateEmptyWorkspace({
            payload,
            ensureWorkspace,
            serverId: selectedServerId,
            navigate: (targetServerId, workspaceId, mainAgentId) => {
              if (!isStillOnCreateScreen()) {
                return;
              }
              outcome = "navigated";
              leaveFullscreen();
              navigateToWorkspace({
                serverId: targetServerId,
                workspaceId,
                ...(mainAgentId ? { target: { kind: "agent", agentId: mainAgentId } } : {}),
              });
            },
          });
          finishTitle();
          // Nothing navigated, so this screen may still be mounted under another route. Release
          // the pending lock it would otherwise keep forever.
          if (outcome === "background") {
            setPendingAction(null);
          }
          return;
        }

        setPendingAction("chat");
        const submittedAgentIntent = readSubmittedForkIntent(creationDraftId, selectedServerId);
        if (!submittedAgentIntent) {
          submittedAgentConfigRevision.current = agentConfigRevision.current;
        }
        // Catalog refreshes and remembered preferences can change the effective composer values.
        // Only a deliberate edit should replace the configuration from an accepted request.
        const submittedAgentConfig =
          agentConfigRevision.current === submittedAgentConfigRevision.current
            ? submittedAgentIntent?.config
            : undefined;
        const outcome = await runCreateChatAgent({
          finishTitle,
          payload,
          composerState,
          forkDraftSetup,
          ensureWorkspace,
          createMainAgent: submittedAgentIntent?.createMainAgent ?? createMainAgent,
          submittedAgentConfig,
          serverId: selectedServerId,
          clearDraft: chatDraft.clear,
          draftKey,
          draftId: creationDraftId,
          draftContextScopeKey,
          supportsForgeSearch,
          resolveClient: withConnectedClient,
          isStillOnCreateScreen,
          labels: {
            composerStateRequired: t("newWorkspace.errors.composerStateRequired"),
            selectModel: t("newWorkspace.errors.selectModel"),
            missingAgent: t("composer.errors.failedToCreateAgent"),
          },
        });
        if (outcome === "background") {
          setPendingAction(null);
        }
      } catch (error) {
        const message = workspaceCreationErrorMessage(t, error, Boolean(armedMain));
        setPendingAction(null);
        setErrorMessage(message);
        toast.error(message);
        if (armedMain) throw new Error(message, { cause: error });
      }
    },
    [
      assertNoMainAttempt,
      composerState,
      createMainAgent,
      draftContextScopeKey,
      creationDraftId,
      chatDraft.clear,
      draftKey,
      finishTitle,
      ensureWorkspace,
      forkDraftSetup,
      isStillOnCreateScreen,
      isTimelineFork,
      launchTarget,
      leaveFullscreen,
      handleSubmitExplicitMain,
      mainDraftRef,
      selectedServerId,
      serverId,
      supportsForgeSearch,
      t,
      toast,
      updateFormPreferences,
      withConnectedClient,
    ],
  );

  const handleSubmitTerminalLaunch = useCallback(async () => {
    try {
      setErrorMessage(null);
      await updateFormPreferences({ launchTarget });
      setPendingAction("terminal");
      let outcome: SubmitOutcome = "background";
      await runCreateTerminalWorkspace({
        cwd: workingDirectory ?? "",
        prompt: terminalPromptText,
        profile: selectedTerminalProfile,
        profileName: selectedTerminalProfile?.name,
        ensureWorkspace: async (request) => (await ensureWorkspace(request)).workspace,
        createTerminal: async (input) => {
          const connectedClient = withConnectedClient();
          const createdTerminal = await connectedClient.createTerminal(
            input.workspaceDirectory,
            input.name,
            undefined,
            { command: input.command, args: input.args, workspaceId: input.workspaceId },
          );
          const terminal = createdTerminal.terminal;
          if (!terminal) {
            throw new Error(createdTerminal.error ?? t("newWorkspace.errors.createWorktreeFailed"));
          }
          queryClient.setQueryData<ListTerminalsPayload>(
            buildTerminalsQueryKey(selectedServerId, input.workspaceDirectory, input.workspaceId),
            (current) =>
              upsertCreatedTerminalPayload({
                current,
                terminal,
                workspaceDirectory: input.workspaceDirectory,
              }),
          );
          return { terminalId: terminal.id };
        },
        sendTerminalInput: (terminalId, data) => {
          withConnectedClient().sendTerminalInput(terminalId, { type: "input", data });
        },
        serverId: selectedServerId,
        // The terminal is spawned and fed its command before this runs, so skipping the
        // navigation costs nothing: it is standalone, and `reconcileTabs` auto-opens standalone
        // terminals when the workspace is next visited.
        navigate: (targetServerId, workspaceId, target) => {
          if (!isStillOnCreateScreen()) {
            return;
          }
          outcome = "navigated";
          leaveFullscreen();
          navigateToWorkspace({ serverId: targetServerId, workspaceId, target });
        },
      });
      finishTitle();
      if (mainDraftRef.current) void saveMainDraft(null).catch(reportMainDraftStorageError);
      if (outcome === "background") {
        setPendingAction(null);
      }
    } catch (error) {
      const message = toErrorMessage(error);
      setPendingAction(null);
      setErrorMessage(message);
      toast.error(message);
    }
  }, [
    ensureWorkspace,
    finishTitle,
    isStillOnCreateScreen,
    launchTarget,
    mainDraftRef,
    queryClient,
    reportMainDraftStorageError,
    saveMainDraft,
    selectedServerId,
    selectedTerminalProfile,
    t,
    terminalPromptText,
    toast,
    leaveFullscreen,
    updateFormPreferences,
    withConnectedClient,
    workingDirectory,
  ]);

  const agentControlsWithDisabled = useMemo(() => {
    if (!composerState) return undefined;
    const controls = composerState.agentControls;
    if (!isTimelineFork) return { ...controls, disabled: isPending, workspaceMain };
    function trackEdit<Args extends unknown[], Result>(action: (...args: Args) => Result) {
      return (...args: Args) => {
        const result = action(...args);
        if (result !== false) markAgentConfigEdited();
        return result;
      };
    }
    return {
      ...controls,
      disabled: isPending,
      onSelectMode: trackEdit(controls.onSelectMode),
      onSelectModel: trackEdit(controls.onSelectModel),
      onSelectProviderAndModel: trackEdit(controls.onSelectProviderAndModel),
      onSelectThinkingOption: trackEdit(controls.onSelectThinkingOption),
      onApplyAgentProfile: trackEdit(controls.onApplyAgentProfile),
      onSetOption: trackEdit(controls.onSetOption),
      optionControls: controls.optionControls && {
        ...controls.optionControls,
        onSetOption: trackEdit(controls.optionControls.onSetOption),
      },
    };
  }, [composerState, isPending, isTimelineFork, workspaceMain, markAgentConfigEdited]);

  const pickerEmptyText =
    branchSuggestionsQuery.isFetching || githubPrSearchQuery.isFetching
      ? t("newWorkspace.refPicker.searching")
      : t("newWorkspace.refPicker.noMatchingRefs");

  const formStack = useNewWorkspaceForm({
    isCompact,
    isPending,
    pluginItems: (
      <PluginNewWorkspaceItems serverId={selectedServerId} screen={pluginScreen} setup={setup} />
    ),
    project: {
      anchorRef: projectPickerAnchorRef,
      open: openProjectPicker,
      openState: projectPickerOpen,
      onOpenChange: handleProjectPickerOpenChange,
      options: projectPickerOptions,
      projectByOptionId,
      iconDataByProjectViewKey: projectIconDataByProjectViewKey,
      selectedProject,
      selectedOptionId: selectedProjectOptionId,
      triggerLabel: projectTriggerLabel,
      selectedServerId,
      supportsWorkspaceMultiplicity,
      onSelect: handleSelectProjectOption,
      onAddProject: handleAddProject,
    },
    host: {
      anchorRef: hostPickerAnchorRef,
      open: openHostPicker,
      openState: hostPickerOpen,
      onOpenChange: handleHostPickerOpenChange,
      allHosts,
      selectedServerId,
      onSelect: handleSelectWorkspaceHost,
      onAddHost: handleAddHost,
    },
    isolation: {
      anchorRef: isolationPickerAnchorRef,
      open: openIsolationPicker,
      openState: isolationPickerOpen,
      onOpenChange: handleIsolationPickerOpenChange,
      choice,
      canCreateWorktree,
      onSelect: setIsolation,
      existingWorktrees,
      existingWorktreePath,
      onChooseExistingWorktree: setup.chooseExistingWorktree,
    },
    base: {
      anchorRef: pickerAnchorRef,
      open: openPicker,
      openState: pickerOpen,
      onOpenChange: handlePickerOpenChange,
      selectedSourceDirectory,
      selectedItem,
      triggerLabel,
      options,
      itemById,
      selectedOptionId,
      onSelect: handleSelectOption,
      setSearchQuery: setPickerSearchQuery,
      emptyText: pickerEmptyText,
      showRefPicker,
      worktrees: projectWorktrees,
      actionFor: refActionFor,
      onActionChange: setup.chooseRefAction,
      canChooseAction: supportsRefActions,
      changeRequestContext,
    },
    launch: launchControl,
  });

  const importSession = useImportSession({ serverId: selectedServerId });

  const isComposerFullscreen = composerEditing.isFullscreen(isTerminalLaunch);
  const composerCwd = workingDirectory ?? "";
  const composer = isTerminalLaunch ? (
    <Composer
      key="terminal"
      inputMode="terminal"
      editingSession={composerEditing.terminal}
      readOnly={!terminalTakesPrompt}
      placeholder={terminalPlaceholder}
      submitLabel={terminalSubmitLabel}
      agentId={draftKey}
      serverId={selectedServerId}
      isPaneFocused={isScreenFocused}
      onSubmitMessage={handleSubmitTerminalLaunch}
      allowEmptySubmit={true}
      submitButtonAccessibilityLabel={t("newWorkspace.launch.submit")}
      submitButtonTestID="new-workspace-launch-submit"
      isSubmitLoading={isPending}
      submitBehavior="preserve-and-lock"
      blurOnSubmit={true}
      textSource={terminalTextSource}
      onChangeText={setTerminalPromptText}
      textReplacement={terminalTextReplacement}
      attachments={NO_TERMINAL_ATTACHMENTS}
      onChangeAttachments={noopChangeAttachments}
      cwd={composerCwd}
      clearDraft={noopClearDraft}
      autoFocus={terminalTakesPrompt}
      autoFocusKey={launchFocusKey}
    />
  ) : (
    <Composer
      key="chat"
      editingSession={composerEditing.chat}
      agentId={draftKey}
      serverId={selectedServerId}
      isPaneFocused={isScreenFocused}
      onSubmitMessage={handleSubmitNewWorkspace}
      allowEmptySubmit={true}
      submitButtonAccessibilityLabel={t("newWorkspace.create")}
      submitButtonTestID="workspace-create-submit"
      submitIcon="return"
      isSubmitLoading={isPending}
      waitForForgeAutoAttachOnSubmit
      submitBehavior="preserve-and-lock"
      blurOnSubmit={true}
      textSource={chatDraft.textSource}
      onChangeText={chatDraft.editText}
      textReplacement={chatDraft.textReplacement}
      attachments={chatDraft.attachments}
      attachmentScopeKeys={visibleDraftContextScopeKeys}
      onChangeAttachments={chatDraft.setAttachments}
      onForgeChangeRequestDetected={handleForgeChangeRequestDetected}
      onForgeChangeRequestAutoAttach={handleForgeChangeRequestAutoAttach}
      cwd={composerCwd}
      clearDraft={handleClearDraft}
      autoFocus
      autoFocusKey={launchFocusKey}
      commandDraft={composerState?.commandDraft}
      agentControls={agentControlsWithDisabled}
    />
  );
  const title = useMemo(
    () => (
      <DraftTitleEditor
        value={creationIdentity.title}
        onCommit={commitTitle}
        compact={isCompact}
        disabled={isPending || creationIdentity.submitted}
      />
    ),
    [creationIdentity.title, creationIdentity.submitted, commitTitle, isCompact, isPending],
  );
  return (
    <FileDropZone style={styles.container}>
      <NewWorkspaceLayout
        isCompact={isCompact}
        fullscreen={isComposerFullscreen}
        title={title}
        formStack={formStack}
        onImportSession={importSession.open}
      >
        {composer}
        {errorMessage ? (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {errorMessage}
          </Text>
        ) : null}
      </NewWorkspaceLayout>
      {importSession.sheet}
    </FileDropZone>
  );
}

/**
 * The setup model, built with what the screen has this render so a plugin item's mount effect can
 * already run commands, and kept current on every commit.
 */
function usePluginSetup(input: {
  serverId: string;
  project: Parameters<typeof getHostProjectId>[0] | null;
  worktrees: SetupInputs["worktrees"];
  supportsMultiplicity: boolean;
  restoredWorktree?: ForkWorktreeSubmission;
  pendingAction: Parameters<typeof isNewWorkspacePending>[0]["pendingAction"];
  isDraftHandoffActive: boolean;
  beforeIsolationChange: { current: SetupEffects["beforeIsolationChange"] };
  updatePreferences: ReturnType<typeof useFormPreferences>["updatePreferences"];
  setAttachments: ReturnType<typeof useAgentInputDraft>["setAttachments"];
}) {
  const {
    serverId,
    project,
    worktrees,
    supportsMultiplicity,
    restoredWorktree,
    pendingAction,
    isDraftHandoffActive,
    updatePreferences,
    setAttachments,
  } = input;
  const worktreeSupport = project
    ? getWorktreeSupportForHostProject({ project, serverId })
    : "unsupported";
  const canCreateWorktree = supportsMultiplicity && worktreeSupport !== "unsupported";
  const locked = isNewWorkspacePending({ pendingAction, isDraftHandoffActive });
  const supportsMetadata = useHostFeature(serverId, "entityMetadata");
  const projectId = project ? getHostProjectId(project, serverId) : null;
  const projectName = project?.projectName ?? null;
  const pluginProject = useMemo(
    () => (projectId && projectName ? { id: projectId, name: projectName } : null),
    [projectId, projectName],
  );
  const supportsRefActions = useHostFeature(serverId, "worktreeRefActions");
  const inputs: SetupInputs = {
    serverId,
    locked,
    project: pluginProject,
    canCreateWorktree,
    supportsMetadata,
    supportsRefActions,
    worktrees,
  };
  // Both are stable for the life of the screen: preferences write through the query client, and
  // the draft is keyed per mount. A command and a pick run the same effects.
  const [setup] = useState(() =>
    createNewWorkspaceSetup(
      inputs,
      {
        beforeIsolationChange: (next) => input.beforeIsolationChange.current?.(next) !== false,
        persistIsolation: (isolation) => void updatePreferences({ isolation }),
        syncBaseAttachment: (item) =>
          setAttachments((attachments) => syncPickerPrAttachment({ attachments, item })),
      },
      restoredWorktree,
    ),
  );
  useLayoutEffect(() => setup.syncInputs(inputs));
  return { setup, pluginProject, projectId, canCreateWorktree, isPending: locked };
}

/** Terminal and chat launches edit in separate sessions; the screen follows the mounted one. */
function useNewWorkspaceComposerEditing() {
  const terminal = useComposerEditingSession("terminal");
  const chat = useComposerEditingSession("chat");
  const isTerminalFullscreen = useComposerFullscreen(terminal);
  const isChatFullscreen = useComposerFullscreen(chat);
  // The sessions outlive the screen (its draft keeps them), so a launch that leaves
  // the screen also leaves fullscreen; the next draft starts inline.
  const leaveFullscreen = useCallback(() => {
    terminal.setFullscreen(false);
    chat.setFullscreen(false);
  }, [chat, terminal]);
  return {
    terminal,
    chat,
    leaveFullscreen,
    isFullscreen: (isTerminalLaunch: boolean) =>
      isTerminalLaunch ? isTerminalFullscreen : isChatFullscreen,
  };
}

function NewWorkspaceLayout({
  isCompact,
  fullscreen,
  title,
  formStack,
  onImportSession,
  children,
}: {
  isCompact: boolean;
  /** The composer covers the screen; the header leaves and the dock fills the content. */
  fullscreen: boolean;
  title: ReactNode;
  formStack: ReactNode;
  onImportSession: () => void;
  children: ReactNode;
}) {
  // In the header on compact layouts, under the composer otherwise.
  const importSessionButton = useMemo(
    () => <ImportSessionButton compact={isCompact} onPress={onImportSession} />,
    [isCompact, onImportSession],
  );
  // On compact screens the fields sit above the composer, within reach of the thumb.
  const setupFields = isCompact ? (
    <>
      <View style={styles.compactSetupSpace} pointerEvents="none" />
      {formStack}
    </>
  ) : (
    <>
      <View style={styles.composerTitleContainer}>{title}</View>
      {formStack}
    </>
  );
  const headerActions = useMemo(
    () =>
      isCompact ? (
        <View style={styles.compactActions}>
          <View style={styles.compactTitle}>{title}</View>
          {importSessionButton}
        </View>
      ) : undefined,
    [isCompact, title, importSessionButton],
  );
  return (
    <>
      {fullscreen ? null : <MenuHeader borderless rightContent={headerActions} />}
      <View style={styles.content}>
        <TitlebarDragRegion />
        <ComposerDock centered={!isCompact} fullscreen={fullscreen}>
          {setupFields}
          <>
            {children}
            {isCompact || fullscreen ? null : importSessionButton}
          </>
        </ComposerDock>
      </View>
    </>
  );
}

const styles = StyleSheet.create((theme, runtime) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    userSelect: "none",
  },
  content: {
    position: "relative",
    flex: 1,
  },
  titleLoading: { flex: 1, justifyContent: "center", alignItems: "center" },
  compactActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    // Reserve the menu island, both header gaps, side padding and safe area.
    width: Math.max(
      0,
      runtime.screen.width -
        runtime.insets.left -
        runtime.insets.right -
        ICON_BUTTON_SIZES.large.touch -
        theme.spacing[2] * 2 -
        theme.spacing[3] * 2,
    ),
  },
  compactTitle: { minWidth: 0, flex: 1 },
  compactSetupSpace: {
    flex: 1,
  },
  composerTitleContainer: {
    marginBottom: theme.spacing[8],
    paddingLeft: theme.spacing[6],
    paddingRight: theme.spacing[4],
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.destructive,
    lineHeight: 20,
  },
}));

/**
 * The project's forge names its change requests: pull requests, or merge requests on GitLab.
 * The forge is looked up once the ref picker opens or a change request is chosen.
 */
function useChangeRequestContext(input: {
  serverId: string;
  cwd: string | null;
  pickerOpen: boolean;
  selectedItem: PickerItem | null;
}): "mr" | undefined {
  const { forge } = useCheckoutPrStatusQuery({
    serverId: input.serverId,
    cwd: input.cwd ?? "",
    enabled: input.pickerOpen || input.selectedItem?.kind === "github-pr",
  });
  return getForgePresentation(forge).changeRequestContext;
}
