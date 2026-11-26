import type { QueuedTopicReply } from "@/composer/actions";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getParentAddressFromLabels, isMainControlAgent } from "@getpaseo/protocol/agent-labels";
import type { TFunction } from "i18next";
import { SquarePen, X } from "lucide-react-native";
import { AgentLimitRecovery } from "./agent-limit-recovery";
import { PendingSubagentInboxBar } from "./agent-panel-inbox";
import { TopicStreamList } from "@/agent-stream/topic-card/topic-stream-list";
import {
  TopicStreamModeControl,
  useTopicStreamModeInHeader,
  useTopicStreamMode,
} from "@/agent-stream/topic-card/topic-stream-mode-control";
import { PaneContentToolbar } from "@/components/ui/pane-content-toolbar";
import {
  buildTopicAgentKey,
  type ActiveTopicReplyTarget,
  useTopicStreamViewStore,
} from "@/stores/topic-stream-view-store";
import {
  deliverQueuedTopicReply,
  finishTopicSubmission,
  getTopicReplyRecoveryId,
  isTopicComposerDraftSubmitting,
  resolveReplyComposerDraftKey,
  rememberTopicSubmission,
  submitActiveTopicReply,
  TopicDecisionStaleQuestionError,
} from "@/agent-stream/topic-card/submit-topic-reply";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { MessagePayload } from "@/composer/types";
import React, {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet as RNStyleSheet, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { shallow, useShallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useAgentStreamTail } from "@/agent-stream/use-agent-stream-tail";
import {
  AgentStreamView,
  renderPendingPermissionsNode,
  type AgentStreamViewHandle,
} from "@/agent-stream/view";
import { AgentDurableItems } from "@/durable-items/card";
import { CHAT_COLUMN_RAIL_DATASET, ChatColumnRailSurface } from "@/chat-rail";
import { ArchivedAgentCallout } from "@/components/archived-agent-callout";
import { ComposerDock } from "@/composer/dock";
import { FileDropZone } from "@/components/file-drop/file-drop-zone";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { RetainedChatContent } from "./retained-chat-content";
import { Composer } from "@/composer";
import { isHandoffInputLocked } from "@/composer/handoff-input-lock";
import { AgentCommandsProvider } from "@/agent-commands";
import {
  useComposerEditingSession,
  useComposerFullscreen,
  type ComposerEditingSession,
} from "@/composer/editing-session";
import {
  resolveComposerTrackControlClearance,
  resolveComposerTrackTailClearance,
} from "@/composer/pill-styles";
import { getActiveMessageSubmissions } from "@/composer/submission/model";
import {
  RewindCommandCenterRegistration,
  RewindComposerRestoreProvider,
} from "@/components/rewind";
import { usePendingRewindFileRecovery } from "@/components/rewind/use-rewind-agent-mutation";
import { ToastApiProvider } from "@/contexts/toast-context";
import { useAgentDescriptor } from "@/agent-presentation";
import {
  ComposerQuoteProvider,
  type ComposerQuoteTarget,
} from "@/assistant-selection-copy/composer-quote";
import {
  useToastHost,
  type DismissToastById,
  type ToastApi,
  type ToastState,
} from "@/components/toast-host";
import { createQuoteAttachment } from "@/attachments/quote";
import {
  buildDecisionRecoveryScope,
  useDecisionRecoveryStore,
  useDraftStore,
  type RecoveredTopicReplyTarget,
} from "@/stores/draft-store";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import { useWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import { COMPACT_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { useAgentAttentionClear } from "@/hooks/use-agent-attention-clear";
import {
  appendSideChatReplyToDraft,
  buildSideChatDraftSetup,
  openSideChatDraft,
} from "@/hooks/use-fork-agent";
import { useAgentInputDraft, type AgentInputDraft } from "@/composer/draft/input-draft";
import {
  type AgentScreenAgent,
  type AgentScreenContinuity,
  type AgentScreenMissingState,
  type AgentScreenViewState,
  useAgentScreenStateMachine,
  type AgentScreenReadySyncState,
} from "@/hooks/use-agent-screen-state-machine";
import { useQueryClient } from "@tanstack/react-query";
import { TopicEmptyState, useTopicWorkspace } from "@/panels/topic-empty-state";
import { useHostFeature } from "@/runtime/host-features";
import { isAgentArchiving, useArchiveAgent } from "@/hooks/use-archive-agent";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { reconcileMissingAgentStateWithPresentAgent } from "@/panels/agent-panel-load-state";
import { TimelineSyncStatus } from "@/timeline/sync-status";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { useAgentFactsLine } from "@/panels/agent-facts-line";
import { PaneSubtitle } from "@/panels/pane-subtitle";
import { definePanel } from "@/panels/panel-registry";
import { RenderProfile } from "@/utils/render-profiler";
import { buildDraftPanelDescriptor } from "@/panels/draft-panel-descriptor";
import {
  type HostRuntimeConnectionStatus,
  useHostRuntimeClient,
  useHostRuntimeConnectionStatus,
  useHostRuntimeIsConnected,
  useHostRuntimeLastError,
  useHosts,
} from "@/runtime/host-runtime";
import {
  deriveRouteBottomAnchorIntent,
  deriveRouteBottomAnchorRequest,
} from "@/screens/agent/agent-ready-screen-bottom-anchor";
import { WorkspaceDraftComposer } from "@/composer/draft/workspace-tab";
import { type DraftConversation, useDraftTimeline } from "@/composer/draft/timeline";
import { AgentTracks } from "@/panels/agent-tracks";
import { OverlayDismissalScope } from "@/components/ui/overlay-dismissal";
import { ParentAgentCallout, useParentAgentId } from "@/subagents/parent";
import { MainControlTreeLayout } from "@/subagents/main-control-tree";
import { isWorkspaceRootAgent } from "@/subagents/main-control-tree/select-tree";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { selectHostFeature } from "@/runtime/host-features";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  selectAgentTimelineState,
  selectAgentTimelineTurnPresentation,
  type Agent,
  useSessionStore,
} from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
import { openWorkspaceChanges } from "@/workspace-tabs/open-supporting-view";
import { useSettings } from "@/hooks/use-settings";
import type { Theme } from "@/styles/theme";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import type { ViewedTimelineStatus, ViewedTimelineUiBridge } from "@/timeline/viewed-timeline-sync";
import { getInitDeferred, getInitKey } from "@/utils/agent-initialization";
import { derivePendingPermissionKey, normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import { buildDraftAgentSetup, type ClientSlashCommand } from "@/client-slash-commands";
import { getSideChatSourceAgentId } from "@/subagents/close-tab-policy";

interface ChatAgentStateShape {
  serverId: string | null;
  id: string | null;
  provider?: Agent["provider"];
  status: Agent["status"] | null;
  cwd: string | null;
  workspaceId?: string;
  capabilities?: Agent["capabilities"];
  currentModeId?: Agent["currentModeId"];
  model?: Agent["model"];
  thinkingOptionId?: Agent["thinkingOptionId"];
  runtimeInfo?: Agent["runtimeInfo"];
  options?: Agent["options"];
  subagentDraftOptions?: Agent["subagentDraftOptions"];
  controls?: Agent["controls"];
  lastError?: Agent["lastError"] | null;
}

interface ChatAgentSelectedState extends ChatAgentStateShape {
  archivedAt: Date | null;
  requiresAttention: boolean;
  attentionReason: Agent["attentionReason"] | null;
}

function resolveChatAgentFromSession(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string,
  agentId: string | undefined,
): Agent | null {
  if (!agentId) return null;
  const session = state.sessions[serverId];
  return session?.agents?.get(agentId) ?? session?.agentDetails?.get(agentId) ?? null;
}

function isSideChatMainAgent(agent: Agent | null, workspaceId: string, serverId: string): boolean {
  return Boolean(
    agent &&
    isWorkspaceRootAgent(agent, workspaceId) &&
    isMainControlAgent(agent) &&
    !agent.parentAgentId &&
    !getParentAddressFromLabels(agent.labels, serverId),
  );
}

function readViewedTimelineError(input: {
  agentId: string | undefined;
  status: ViewedTimelineStatus;
  sync: ViewedTimelineUiBridge | null;
}): string | null {
  if (!input.agentId || input.status !== "error" || !input.sync) return null;
  return input.sync.getAgentTimelineError(input.agentId);
}

const EMPTY_CHAT_AGENT_STATE: ChatAgentSelectedState = {
  serverId: null,
  id: null,
  status: null,
  cwd: null,
  lastError: null,
  archivedAt: null,
  requiresAttention: false,
  attentionReason: null,
};

function selectChatAgentState(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string,
  agentId: string | undefined,
): ChatAgentSelectedState {
  const agent = resolveChatAgentFromSession(state, serverId, agentId);
  if (!agent) return EMPTY_CHAT_AGENT_STATE;
  return {
    serverId: agent.serverId,
    id: agent.id,
    provider: agent.provider,
    status: agent.status,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    capabilities: agent.capabilities,
    currentModeId: agent.currentModeId,
    model: agent.model,
    thinkingOptionId: agent.thinkingOptionId,
    runtimeInfo: agent.runtimeInfo,
    options: agent.options,
    subagentDraftOptions: agent.subagentDraftOptions,
    controls: agent.controls,
    lastError: agent.lastError ?? null,
    archivedAt: agent.archivedAt ?? null,
    requiresAttention: agent.requiresAttention ?? false,
    attentionReason: agent.attentionReason ?? null,
  };
}

function buildChatAgentFromState(
  state: ChatAgentStateShape,
  projectPlacement: Agent["projectPlacement"] | null,
): AgentScreenAgent | null {
  if (!state.serverId || !state.id || !state.status || !state.cwd) {
    return null;
  }
  return {
    serverId: state.serverId,
    id: state.id,
    provider: state.provider,
    status: state.status,
    cwd: state.cwd,
    workspaceId: state.workspaceId,
    capabilities: state.capabilities,
    currentModeId: state.currentModeId,
    model: state.model,
    thinkingOptionId: state.thinkingOptionId,
    runtimeInfo: state.runtimeInfo,
    options: state.options,
    subagentDraftOptions: state.subagentDraftOptions,
    controls: state.controls,
    lastError: state.lastError ?? null,
    projectPlacement,
  };
}

function AgentLoadErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.container} testID="agent-load-error">
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{t("agentPanel.states.failedToLoad")}</Text>
        <Text style={styles.statusText}>{message}</Text>
        <View style={styles.errorAction}>
          <Button variant="secondary" onPress={onRetry} testID="agent-load-error-retry">
            {t("common.actions.retry")}
          </Button>
        </View>
      </View>
    </View>
  );
}

/** A draft has no agent to wait for; an agent shows its loading and error states until ready. */
function renderConversationNonReadyView(args: {
  draft: DraftConversation | null;
  agentId: string | undefined;
  cwd: string | null;
  viewState: AgentScreenViewState;
  effectiveAgent: AgentScreenAgent | null;
  t: TFunction;
  onRetryLoad: () => void;
}): React.ReactElement | null {
  if (args.draft) {
    return null;
  }
  const nonReadyView = renderChatAgentNonReadyView(args);
  if (nonReadyView) {
    return nonReadyView;
  }
  invariant(args.agentId, "agent id is defined when agent content is ready");
  invariant(args.effectiveAgent, "effectiveAgent is defined when the non-ready view is absent");
  invariant(args.cwd, "agent cwd is defined when agent content is ready");
  return null;
}

function renderChatAgentNonReadyView(args: {
  viewState: AgentScreenViewState;
  effectiveAgent: AgentScreenAgent | null;
  t: TFunction;
  onRetryLoad: () => void;
}): React.ReactElement | null {
  const { viewState, effectiveAgent, t, onRetryLoad } = args;
  if (viewState.tag === "not_found") {
    return (
      <View style={styles.container} testID="agent-not-found">
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{t("agentPanel.states.notFound")}</Text>
        </View>
      </View>
    );
  }
  if (viewState.tag === "error") {
    return <AgentLoadErrorView message={viewState.message} onRetry={onRetryLoad} />;
  }
  if (viewState.tag === "boot" || !effectiveAgent) {
    return (
      <View style={styles.container} testID="agent-loading">
        <View style={styles.errorContainer}>
          <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
        </View>
      </View>
    );
  }
  return null;
}

function shouldStoreFetchedAgentInActiveDirectory(agent: Agent): boolean {
  return !agent.archivedAt && Boolean(agent.projectPlacement);
}

type FetchAgentResult = Awaited<ReturnType<DaemonClient["fetchAgent"]>>;

function storeFetchedAgentDetail(input: {
  serverId: string;
  result: NonNullable<FetchAgentResult>;
}): Agent {
  const normalized = normalizeAgentSnapshot(input.result.agent, input.serverId);
  const hydrated: Agent = applyLegacyDaemonWorkspaceOwnership({
    serverId: input.serverId,
    agent: {
      ...normalized,
      projectPlacement: input.result.project,
    },
  });
  const store = useSessionStore.getState();

  if (shouldStoreFetchedAgentInActiveDirectory(hydrated)) {
    getHostRuntimeStore().acceptAgentSnapshot(input.serverId, hydrated);
  } else {
    store.setAgentDetails(input.serverId, (previous) => {
      const next = new Map(previous);
      next.set(hydrated.id, hydrated);
      return next;
    });
  }

  store.setPendingPermissions(input.serverId, (previous) => {
    const next = new Map(previous);
    for (const [key, pending] of next.entries()) {
      if (pending.agentId === hydrated.id) {
        next.delete(key);
      }
    }
    for (const request of hydrated.pendingPermissions) {
      const key = derivePendingPermissionKey(hydrated.id, request);
      next.set(key, { key, agentId: hydrated.id, request });
    }
    return next;
  });

  return hydrated;
}

type ConversationTarget = Extract<WorkspaceTabTarget, { kind: "agent" } | { kind: "draft" }>;

/** The agent a conversation shows; a draft has none until its first prompt creates one. */
function resolveConversationAgentId(target: ConversationTarget): string | undefined {
  return target.kind === "agent" ? target.agentId.trim() || undefined : undefined;
}

/**
 * Drafts and agents render through one chain so the timeline stays mounted when the draft's
 * first prompt creates the agent and the tab retargets. The agent gates are idle for a draft.
 */
export function AgentConversationPanel() {
  const { serverId, workspaceId, target, openFileInWorkspace } = usePaneContext();
  const { isInteractive } = usePaneFocus();
  invariant(
    target.kind === "agent" || target.kind === "draft",
    "AgentConversationPanel requires an agent or draft target",
  );

  return (
    <RetainedChatContent>
      <AgentPanelContent
        serverId={serverId}
        workspaceId={workspaceId}
        target={target}
        isPaneFocused={isInteractive}
        onOpenWorkspaceFile={openFileInWorkspace}
      />
    </RetainedChatContent>
  );
}

export const agentPanelRegistration = definePanel("agent", {
  component: AgentConversationPanel,
  useDescriptor: useAgentDescriptor,
});

export function useDraftPanelDescriptor(
  target: { kind: "draft"; draftId: string },
  context: { serverId: string },
) {
  const createDescriptorState = useCreateFlowStore(
    useShallow((state) => {
      const pending = state.pendingByDraftId[target.draftId];
      if (pending?.serverId !== context.serverId || pending.lifecycle !== "active") {
        return {
          isCreating: false,
          pendingPrompt: null,
        };
      }
      return {
        isCreating: true,
        pendingPrompt: pending.text,
      };
    }),
  );

  return buildDraftPanelDescriptor({
    ...createDescriptorState,
    icon: SquarePen,
  });
}

const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const EMPTY_MESSAGE_SUBMISSIONS = [] as const;
const EMPTY_PENDING_PERMISSIONS = new Map<string, PendingPermission>();
const EMPTY_PENDING_PERMISSION_LIST: PendingPermission[] = [];

type RouteBottomAnchorRequest = ReturnType<typeof deriveRouteBottomAnchorRequest>;

function findActiveCreateHandoff(input: {
  pendingByDraftId: ReturnType<typeof useCreateFlowStore.getState>["pendingByDraftId"];
  serverId: string;
  agentId?: string;
}): boolean {
  if (!input.agentId) {
    return false;
  }
  return Object.values(input.pendingByDraftId).some(
    (pending) =>
      pending.lifecycle === "sent" &&
      pending.serverId === input.serverId &&
      pending.agentId === input.agentId,
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isNotFoundErrorMessage(message: string): boolean {
  return /agent not found|not found/i.test(message);
}

type AgentLookupState =
  | { tag: "idle" }
  | { tag: "loading" }
  | { tag: "not_found"; message: string }
  | { tag: "error"; message: string };

function AgentPanelContent({
  serverId,
  workspaceId,
  target,
  isPaneFocused,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  workspaceId: string;
  target: ConversationTarget;
  isPaneFocused: boolean;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const resolvedAgentId = resolveConversationAgentId(target);
  const resolvedServerId = serverId.trim() || undefined;
  const daemons = useHosts();
  const runtimeServerId = resolvedServerId ?? "";
  const runtimeClient = useHostRuntimeClient(runtimeServerId);
  const runtimeIsConnected = useHostRuntimeIsConnected(runtimeServerId);
  const runtimeConnectionStatus = useHostRuntimeConnectionStatus(runtimeServerId);
  const runtimeLastError = useHostRuntimeLastError(runtimeServerId);
  const hasCachedAgent = useSessionStore((state) => {
    if (!resolvedServerId || !resolvedAgentId) return false;
    const session = state.sessions[resolvedServerId];
    return Boolean(
      session?.agents.has(resolvedAgentId) || session?.agentDetails.has(resolvedAgentId),
    );
  });

  const connectionServerId = resolvedServerId ?? null;
  const daemon = connectionServerId
    ? (daemons.find((entry) => entry.serverId === connectionServerId) ?? null)
    : null;
  const serverLabel =
    daemon?.label ?? connectionServerId ?? t("agentPanel.unavailable.selectedHost");
  const isUnknownDaemon = Boolean(connectionServerId && !daemon);
  const connectionStatus: HostRuntimeConnectionStatus =
    isUnknownDaemon && runtimeConnectionStatus === "connecting"
      ? "offline"
      : runtimeConnectionStatus;
  const lastConnectionError = runtimeLastError;

  if (target.kind === "agent" && (!resolvedServerId || (!runtimeClient && !hasCachedAgent))) {
    return (
      <AgentSessionUnavailableState
        serverLabel={serverLabel}
        connectionStatus={connectionStatus}
        lastError={lastConnectionError}
        isUnknownDaemon={isUnknownDaemon}
        t={t}
      />
    );
  }

  return (
    <AgentPanelBody
      serverId={resolvedServerId ?? serverId}
      workspaceId={workspaceId}
      target={target}
      isPaneFocused={isPaneFocused}
      client={runtimeClient}
      isConnected={runtimeIsConnected}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
    />
  );
}

function AgentPanelBody({
  serverId,
  workspaceId,
  target,
  isPaneFocused,
  client,
  isConnected,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  workspaceId: string;
  target: ConversationTarget;
  isPaneFocused: boolean;
  client: ReturnType<typeof useHostRuntimeClient>;
  isConnected: boolean;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const agentId = resolveConversationAgentId(target);
  const supportsTopic = useHostFeature(serverId, "topicWorkbenchV1");
  const isMainBeforeFirstQuestion = useSessionStore((state) => {
    if (!supportsTopic) return false;
    const agent = resolveChatAgentFromSession(state, serverId, agentId);
    return Boolean(
      agent &&
      agent.status === "closed" &&
      !agent.lastUserMessageAt &&
      !agent.archivedAt &&
      isWorkspaceRootAgent(agent, workspaceId) &&
      isMainControlAgent(agent),
    );
  });
  const [openTopicConversation, setOpenTopicConversation] = useState<string>();
  const askFirstTopicQuestion = useCallback(() => setOpenTopicConversation(agentId), [agentId]);
  const { workspace: topicWorkspace, isLoading: isLoadingTopicWorkspace } = useTopicWorkspace({
    serverId,
    workspaceId,
    client,
    enabled: isMainBeforeFirstQuestion && isConnected,
  });
  const { isArchivingAgent: _isArchivingAgent } = useArchiveAgent();
  const hasSession = useSessionStore((state) => Boolean(state.sessions[serverId]));
  const projectPlacement = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!agentId) {
        return null;
      }
      const session = state.sessions[serverId];
      return (
        session?.agents?.get(agentId)?.projectPlacement ??
        session?.agentDetails?.get(agentId)?.projectPlacement ??
        null
      );
    },
    (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b),
  );
  const agentState = useSessionStore(
    useShallow((state) => selectChatAgentState(state, serverId, agentId)),
  );
  const [lookupState, setLookupState] = useState<AgentLookupState>({ tag: "idle" });
  const lookupAttemptTokenRef = useRef(0);
  const retryAgentLookup = useCallback(() => setLookupState({ tag: "idle" }), []);

  useEffect(() => {
    lookupAttemptTokenRef.current += 1;
    setLookupState({ tag: "idle" });
  }, [agentId, serverId]);

  useEffect(() => {
    if (!agentId) {
      return;
    }
    if (agentState.id) {
      if (lookupState.tag !== "idle") {
        setLookupState({ tag: "idle" });
      }
      return;
    }
    if (!client || !isConnected || !hasSession) {
      return;
    }
    if (lookupState.tag === "loading" || lookupState.tag === "not_found") {
      return;
    }

    setLookupState({ tag: "loading" });
    const attemptToken = ++lookupAttemptTokenRef.current;

    client
      .fetchAgent({ agentId })
      .then((result) => {
        if (attemptToken !== lookupAttemptTokenRef.current) {
          return;
        }
        if (!result) {
          setLookupState({
            tag: "not_found",
            message: `Agent not found: ${agentId}`,
          });
          return;
        }

        storeFetchedAgentDetail({ serverId, result });
        setLookupState({ tag: "idle" });
        return;
      })
      .catch((error) => {
        if (attemptToken !== lookupAttemptTokenRef.current) {
          return;
        }
        const message = toErrorMessage(error);
        if (isNotFoundErrorMessage(message)) {
          setLookupState({ tag: "not_found", message });
          return;
        }
        setLookupState({ tag: "error", message });
      });
  }, [agentId, agentState.id, client, hasSession, isConnected, lookupState.tag, serverId]);

  if (lookupState.tag === "not_found") {
    return (
      <View style={styles.container} testID="agent-not-found">
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{t("agentPanel.states.notFound")}</Text>
        </View>
      </View>
    );
  }

  if (lookupState.tag === "error") {
    return <AgentLoadErrorView message={lookupState.message} onRetry={retryAgentLookup} />;
  }

  const agent: AgentScreenAgent | null =
    agentState.serverId && agentState.id && agentState.status && agentState.cwd
      ? {
          serverId: agentState.serverId,
          id: agentState.id,
          provider: agentState.provider,
          status: agentState.status,
          cwd: agentState.cwd,
          workspaceId: agentState.workspaceId,
          capabilities: agentState.capabilities,
          currentModeId: agentState.currentModeId,
          model: agentState.model,
          thinkingOptionId: agentState.thinkingOptionId,
          runtimeInfo: agentState.runtimeInfo,
          options: agentState.options,
          controls: agentState.controls,
          lastError: agentState.lastError ?? null,
          projectPlacement,
        }
      : null;

  if (
    (target.kind === "agent" && !agent) ||
    (isMainBeforeFirstQuestion && isLoadingTopicWorkspace)
  ) {
    return (
      <View style={styles.container} testID="agent-loading">
        <View style={styles.errorContainer}>
          <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
        </View>
      </View>
    );
  }

  if (
    isMainBeforeFirstQuestion &&
    agentId &&
    topicWorkspace?.topic?.mainAgentId === agentId &&
    openTopicConversation !== agentId
  ) {
    return <TopicEmptyState workspace={topicWorkspace} onAsk={askFirstTopicQuestion} />;
  }

  return (
    <ChatAgentContent
      serverId={serverId}
      workspaceId={workspaceId}
      target={target}
      isPaneFocused={isPaneFocused}
      client={client}
      isConnected={isConnected}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
    />
  );
}

function useSuppressTopicFocusClear(
  serverId: string,
  workspaceId: string,
  agentId: string | undefined,
): boolean {
  const isTopicMainControl = useSessionStore((state) => {
    const agent = resolveChatAgentFromSession(state, serverId, agentId);
    return Boolean(agent && isWorkspaceRootAgent(agent, workspaceId) && isMainControlAgent(agent));
  });
  const supportsTopicReadState = useHostFeature(serverId, "workspaceTopicReadState");
  const topicViewMode = useTopicStreamMode(serverId, agentId);
  return isTopicMainControl && supportsTopicReadState && topicViewMode === "topics";
}

function FallbackTopicStreamToolbar({
  serverId,
  workspaceId,
  agentId,
  enabled,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  enabled: boolean;
}) {
  const { host } = usePaneContext();
  const modeInHeader = useTopicStreamModeInHeader(serverId, agentId);
  const compact = useIsCompactFormFactor();
  if (!enabled || (host !== "sheet" && modeInHeader)) return null;
  return (
    <PaneContentToolbar testID="topic-stream-top-bar">
      <TopicStreamModeControl
        serverId={serverId}
        agentId={agentId}
        workspaceId={workspaceId}
        compact={compact}
      />
    </PaneContentToolbar>
  );
}

function ChatAgentContent({
  serverId,
  workspaceId,
  target,
  isPaneFocused,
  client,
  isConnected,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  workspaceId: string;
  target: ConversationTarget;
  isPaneFocused: boolean;
  client: ReturnType<typeof useHostRuntimeClient>;
  isConnected: boolean;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const { tabId } = usePaneContext();
  const agentId = resolveConversationAgentId(target);
  const isPaneVisible = useRetainedPanelActive();
  const { api: toastApi, toast: toastState, dismiss: dismissToast } = useToastHost();
  const { isArchivingAgent } = useArchiveAgent();
  const streamViewRef = useRef<AgentStreamViewHandle>(null);
  const initAttemptTokenRef = useRef(0);
  const routeBottomAnchorRequestRef = useRef<{
    routeKey: string;
    reason: "initial-entry" | "resume";
  } | null>(null);
  const agentState = useSessionStore(
    useShallow((state) => selectChatAgentState(state, serverId, agentId)),
  );
  const projectPlacement = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!agentId) {
        return null;
      }
      const session = state.sessions[serverId];
      return (
        session?.agents?.get(agentId)?.projectPlacement ??
        session?.agentDetails?.get(agentId)?.projectPlacement ??
        null
      );
    },
    (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b),
  );
  const isInitializingFromMap = useSessionStore((state) =>
    agentId ? (state.sessions[serverId]?.initializingAgents?.get(agentId) ?? false) : false,
  );
  const historySyncGeneration = useSessionStore(
    (state) => state.sessions[serverId]?.historySyncGeneration ?? 0,
  );
  const replicaTimelineStatus = useSessionStore((state) =>
    agentId
      ? selectAgentTimelineState(state.sessions[serverId], agentId).status
      : ("cold" as const),
  );
  const hasAppliedAuthoritativeHistory = replicaTimelineStatus === "synced";
  const agentHistorySyncGeneration = useSessionStore((state) =>
    agentId ? (state.sessions[serverId]?.agentHistorySyncGeneration?.get(agentId) ?? -1) : -1,
  );
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  const subscribeToVisibilityCatchUp = useCallback(
    (listener: () => void) => viewedTimelineSync?.subscribe(listener) ?? (() => {}),
    [viewedTimelineSync],
  );
  const readTimelineStatus = useCallback((): ViewedTimelineStatus => {
    if (!agentId) return "ready";
    // Until the owner is published nothing has confirmed this chat, so its check has not begun.
    return viewedTimelineSync?.getAgentTimelineStatus(agentId) ?? "checking";
  }, [agentId, viewedTimelineSync]);
  const timelineStatus = useSyncExternalStore(
    subscribeToVisibilityCatchUp,
    readTimelineStatus,
    readTimelineStatus,
  );
  const visibilityCatchUpStatus = isPaneVisible ? timelineStatus : "ready";
  const visibilityCatchUpError = readViewedTimelineError({
    agentId,
    status: visibilityCatchUpStatus,
    sync: viewedTimelineSync,
  });
  const hasActiveCreateHandoff = useCreateFlowStore((state) =>
    findActiveCreateHandoff({ pendingByDraftId: state.pendingByDraftId, serverId, agentId }),
  );
  const hasSession = useSessionStore((state) => Boolean(state.sessions[serverId]));
  const [missingAgentState, setMissingAgentState] = useState<AgentScreenMissingState>({
    kind: "idle",
  });

  const hasHydratedHistoryBefore =
    hasAppliedAuthoritativeHistory || replicaTimelineStatus === "painted";

  const focusRequest = useWorkspaceLayoutStore((state) => {
    const request = state.focusRequest;
    return request?.workspaceKey === `${serverId}:${workspaceId}` && request.tabId === tabId
      ? request
      : null;
  });
  const reportAttentionError = useCallback(
    (error: unknown) => {
      toastApi.error(toErrorMessage(error));
    },
    [toastApi],
  );
  const suppressTopicFocusClear = useSuppressTopicFocusClear(serverId, workspaceId, agentId);
  const attentionController = useAgentAttentionClear({
    agentId,
    client,
    isConnected,
    isAgentDataReady: agentHistorySyncGeneration === historySyncGeneration,
    requiresAttention: agentState.requiresAttention,
    attentionReason: agentState.attentionReason,
    isScreenFocused: isPaneFocused,
    focusRequest,
    suppressFocusClear: suppressTopicFocusClear,
    onError: reportAttentionError,
  });
  const isArchivingCurrentAgent = Boolean(agentId && isArchivingAgent({ serverId, agentId }));

  const isInitializing = agentId ? isInitializingFromMap : false;
  const isHistorySyncing = useMemo(() => {
    if (!agentId || !isInitializing) {
      return false;
    }
    const initKey = getInitKey(serverId, agentId);
    return Boolean(getInitDeferred(initKey));
  }, [agentId, isInitializing, serverId]);
  const needsAuthoritativeSync = useMemo(() => {
    if (!agentId) {
      return false;
    }
    return agentHistorySyncGeneration < historySyncGeneration;
  }, [agentHistorySyncGeneration, agentId, historySyncGeneration]);

  const agent = useMemo<AgentScreenAgent | null>(
    () => buildChatAgentFromState(agentState, projectPlacement),
    [agentState, projectPlacement],
  );
  const continuity = useMemo<AgentScreenContinuity>(() => {
    if (!hasActiveCreateHandoff || !agentId) {
      return { kind: "none" };
    }
    return {
      kind: "optimistic-create",
      agent: {
        serverId,
        id: agentId,
        status: "running",
        cwd: agent?.cwd ?? ".",
        projectPlacement: agent?.projectPlacement ?? null,
      },
    };
  }, [agent, agentId, hasActiveCreateHandoff, serverId]);

  const viewState = useAgentScreenStateMachine({
    routeKey: `${serverId}:${agentId ?? ""}`,
    input: {
      agent: agent ?? null,
      isArchived: agentState.archivedAt !== null,
      missingAgentState,
      isConnected,
      isArchivingCurrentAgent,
      isHistorySyncing,
      needsAuthoritativeSync,
      visibilityCatchUpStatus,
      visibilityCatchUpError,
      continuity,
      hasHydratedHistoryBefore,
    },
  });

  const effectiveAgent = viewState.tag === "ready" ? viewState.agent : null;
  const routeEntryKey = agentId ? `${serverId}:${agentId}` : null;
  routeBottomAnchorRequestRef.current = deriveRouteBottomAnchorIntent({
    cachedIntent: routeBottomAnchorRequestRef.current,
    routeKey: routeEntryKey,
    hasAppliedAuthoritativeHistoryAtEntry: hasAppliedAuthoritativeHistory,
  });
  const routeBottomAnchorRequest = useMemo(
    () =>
      deriveRouteBottomAnchorRequest({
        intent: routeBottomAnchorRequestRef.current,
        effectiveAgentId: effectiveAgent?.id ?? null,
      }),
    [effectiveAgent?.id],
  );

  const handleComposerHeightChange = useCallback(
    (_height: number) => {
      if (!agentId) {
        return;
      }
      streamViewRef.current?.prepareForViewportChange();
    },
    [agentId],
  );

  const handleMessageSent = useCallback(() => {
    if (!agentId) {
      return;
    }
    streamViewRef.current?.scrollToBottom("message-sent");
  }, [agentId]);

  const retryAgentLoad = useCallback(() => {
    setMissingAgentState({ kind: "idle" });
    if (!agentId || !viewedTimelineSync) return;
    viewedTimelineSync.retryVisibleAgentTimeline(agentId);
  }, [agentId, viewedTimelineSync]);

  const retryTimelineSync = useCallback(() => {
    if (!agentId || !viewedTimelineSync) return;
    viewedTimelineSync.retryVisibleAgentTimeline(agentId);
  }, [agentId, viewedTimelineSync]);

  useEffect(() => {
    initAttemptTokenRef.current += 1;
    setMissingAgentState({ kind: "idle" });
  }, [agentId, serverId]);

  useEffect(() => {
    if (!agentId) {
      return;
    }
    if (agentState.archivedAt) {
      return;
    }
    if (agentState.id && hasAppliedAuthoritativeHistory) {
      if (
        missingAgentState.kind === "resolving" ||
        missingAgentState.kind === "not_found" ||
        missingAgentState.kind === "error"
      ) {
        setMissingAgentState(reconcileMissingAgentStateWithPresentAgent);
      }
      return;
    }
    if (
      !client ||
      !viewedTimelineSync ||
      !isPaneVisible ||
      !isConnected ||
      !hasSession ||
      visibilityCatchUpStatus !== "ready"
    ) {
      return;
    }
    if (
      missingAgentState.kind === "resolving" ||
      missingAgentState.kind === "not_found" ||
      missingAgentState.kind === "error"
    ) {
      return;
    }

    setMissingAgentState({ kind: "resolving" });
    const attemptToken = ++initAttemptTokenRef.current;

    Promise.resolve()
      .then(async () => {
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        const currentSession = useSessionStore.getState().sessions[serverId];
        const currentAgent =
          currentSession?.agents.get(agentId) ?? currentSession?.agentDetails.get(agentId);
        if (!currentAgent) {
          const result = await client.fetchAgent({ agentId });
          if (attemptToken !== initAttemptTokenRef.current) {
            return;
          }
          if (!result) {
            setMissingAgentState({
              kind: "not_found",
              message: `Agent not found: ${agentId}`,
            });
            return;
          }
          storeFetchedAgentDetail({ serverId, result });
        }
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        setMissingAgentState({ kind: "idle" });
        return;
      })
      .catch((error) => {
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        const message = toErrorMessage(error);
        if (isNotFoundErrorMessage(message)) {
          setMissingAgentState({ kind: "not_found", message });
          return;
        }
        setMissingAgentState({ kind: "error", message });
      });
  }, [
    agentState.id,
    agentState.archivedAt,
    hasAppliedAuthoritativeHistory,
    agentId,
    client,
    hasSession,
    isConnected,
    isPaneVisible,
    missingAgentState.kind,
    serverId,
    viewedTimelineSync,
    visibilityCatchUpStatus,
  ]);

  const draft = useMemo<DraftConversation | null>(
    () =>
      target.kind === "draft"
        ? { tabId, workspaceId, draftId: target.draftId, setup: target.setup }
        : null,
    [tabId, target, workspaceId],
  );
  const nonReadyView = renderConversationNonReadyView({
    draft,
    agentId,
    cwd: agentState.cwd,
    viewState,
    effectiveAgent,
    t,
    onRetryLoad: retryAgentLoad,
  });
  if (nonReadyView) return nonReadyView;
  const showHistorySyncOverlay =
    viewState.tag === "ready" &&
    viewState.sync.status === "catching_up" &&
    viewState.sync.ui === "overlay";
  const showHistorySyncError = viewState.tag === "ready" && viewState.sync.status === "sync_error";
  const isRetryingHistorySync =
    viewState.tag === "ready" &&
    viewState.sync.status === "sync_error" &&
    viewState.sync.isRetrying;

  return (
    <ChatAgentReadyContent
      serverId={serverId}
      workspaceId={workspaceId}
      agentId={agentId ?? tabId}
      draft={draft}
      isPaneFocused={isPaneFocused}
      isArchivingCurrentAgent={isArchivingCurrentAgent}
      agentState={agentState}
      effectiveAgent={effectiveAgent}
      routeBottomAnchorRequest={routeBottomAnchorRequest}
      hasAppliedAuthoritativeHistory={hasAppliedAuthoritativeHistory}
      hasCachedHistory={replicaTimelineStatus === "painted"}
      toastApi={toastApi}
      toast={toastState}
      dismiss={dismissToast}
      streamViewRef={streamViewRef}
      handleComposerHeightChange={handleComposerHeightChange}
      handleMessageSent={handleMessageSent}
      timelineSync={isPaneVisible && viewState.tag === "ready" ? viewState.sync : null}
      showHistorySyncOverlay={showHistorySyncOverlay}
      showHistorySyncError={showHistorySyncError}
      isRetryingHistorySync={isRetryingHistorySync}
      cwd={agentState.cwd ?? ""}
      retryTimelineSync={retryTimelineSync}
      onAttentionInputFocus={attentionController.clearOnInputFocus}
      onAttentionUserInteraction={attentionController.clearOnUserInteraction}
      onAttentionPromptSend={attentionController.clearOnPromptSend}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
    />
  );
}

function resolveChatReadyFlags(input: {
  mainAgentId: string | null;
  draft: DraftConversation | null;
  routeBottomAnchorReason: NonNullable<RouteBottomAnchorRequest>["reason"] | undefined;
  hasCachedHistory: boolean;
  showHistorySyncError: boolean;
}) {
  return {
    isMainControlStream: input.mainAgentId !== null && !input.draft,
    isInitialHistoryLoading:
      input.routeBottomAnchorReason === "initial-entry" &&
      !input.hasCachedHistory &&
      !input.showHistorySyncError,
    revealInitialHistory: input.hasCachedHistory || input.showHistorySyncError,
  };
}

const ChatAgentReadyContent = memo(function ChatAgentReadyContent({
  serverId,
  workspaceId,
  agentId,
  draft,
  isPaneFocused,
  isArchivingCurrentAgent,
  agentState,
  effectiveAgent,
  routeBottomAnchorRequest,
  hasAppliedAuthoritativeHistory,
  hasCachedHistory,
  toastApi,
  toast,
  dismiss,
  streamViewRef,
  handleComposerHeightChange,
  handleMessageSent,
  timelineSync,
  showHistorySyncOverlay,
  showHistorySyncError,
  isRetryingHistorySync,
  retryTimelineSync,
  cwd,
  onAttentionInputFocus,
  onAttentionUserInteraction,
  onAttentionPromptSend,
  onOpenWorkspaceFile,
}: {
  serverId: string;
  workspaceId: string;
  /** The agent's id, or the tab id while a draft has no agent yet. */
  agentId: string;
  draft: DraftConversation | null;
  isPaneFocused: boolean;
  isArchivingCurrentAgent: boolean;
  agentState: ChatAgentSelectedState;
  effectiveAgent: AgentScreenAgent | null;
  routeBottomAnchorRequest: RouteBottomAnchorRequest;
  hasAppliedAuthoritativeHistory: boolean;
  hasCachedHistory: boolean;
  toastApi: ToastApi;
  toast: ToastState | null;
  dismiss: DismissToastById;
  streamViewRef: React.RefObject<AgentStreamViewHandle | null>;
  handleComposerHeightChange: (height: number) => void;
  handleMessageSent: () => void;
  timelineSync: AgentScreenReadySyncState | null;
  showHistorySyncOverlay: boolean;
  showHistorySyncError: boolean;
  isRetryingHistorySync: boolean;
  retryTimelineSync: () => void;
  cwd: string;
  onAttentionInputFocus: () => void;
  onAttentionUserInteraction: () => void;
  onAttentionPromptSend: () => void;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  // The workspace sheet is for looking; Open as tab brings the agent back with its composer.
  const paneHost = usePaneContext().host;
  const showsComposer = draft !== null || paneHost !== "sheet";
  // The dock lays out fullscreen for the same session the composer edits in.
  const mainAgentId = useSessionStore((state) => {
    const agent = resolveChatAgentFromSession(state, serverId, effectiveAgent?.id);
    return agent && isWorkspaceRootAgent(agent, workspaceId) && isMainControlAgent(agent)
      ? agent.id
      : null;
  });
  const composerEditingSession = useComposerEditingSession("chat");
  const isComposerFullscreen = useComposerFullscreen(composerEditingSession);
  const hasActiveComposer = !agentState.archivedAt && !isArchivingCurrentAgent;
  const hasAgentComposer = showsComposer && hasActiveComposer && !draft;
  const queryClient = useQueryClient();
  const canSubmitSelection = useStableEvent(
    (selectedAgentId: string, selectedWorkspaceId: string) => {
      if (!hasAgentComposer || selectedAgentId !== agentId || selectedWorkspaceId !== workspaceId) {
        return false;
      }
      const agent = resolveChatAgentFromSession(useSessionStore.getState(), serverId, agentId);
      return Boolean(
        agent &&
        agent.workspaceId === workspaceId &&
        !agent.archivedAt &&
        !isAgentArchiving({ queryClient, serverId, agentId }),
      );
    },
  );
  const focusRestoredComposer = useStableEvent(() => {
    if (isPaneFocused && showsComposer && hasActiveComposer) {
      composerEditingSession.focus();
    }
  });
  const handleRewindComplete = useCallback(
    (restoredComposerText: boolean) => {
      streamViewRef.current?.scrollToBottom("rewind");
      if (restoredComposerText) {
        // Defer focus so the editor can apply the restored draft and the menu can start closing.
        requestAnimationFrame(focusRestoredComposer);
      }
    },
    [focusRestoredComposer, streamViewRef],
  );
  const parentAgentId = useParentAgentId(serverId, agentId);
  const isSubagent = useSessionStore((state) => {
    const agent = resolveChatAgentFromSession(state, serverId, agentId);
    return Boolean(agent && getParentAddressFromLabels(agent.labels, serverId));
  });
  // With a composer the parent is a pill above it; without one, the box takes the composer's place.
  const parentPillAgentId = showsComposer ? parentAgentId : null;
  const rawAgentInputDraft = useAgentInputDraft({
    draftKey: buildDraftStoreKey({
      serverId,
      agentId,
    }),
  });
  // Stabilize the agentInputDraft object identity so that memo(AgentComposerSection) can bail out
  // when only toast state changes (which does not affect any draft field).
  const {
    textSource,
    editText,
    replaceText,
    textReplacement,
    attachments,
    setAttachments,
    clear,
    isHydrated,
    attachmentFocusRequestId,
    composerState,
  } = rawAgentInputDraft;
  const agentInputDraft = useMemo(
    (): AgentInputDraft => ({
      textSource,
      editText,
      replaceText,
      textReplacement,
      attachments,
      setAttachments,
      clear,
      isHydrated,
      attachmentFocusRequestId,
      composerState,
    }),
    [
      textSource,
      editText,
      replaceText,
      textReplacement,
      attachments,
      setAttachments,
      clear,
      isHydrated,
      attachmentFocusRequestId,
      composerState,
    ],
  );
  const parentCallout = parentAgentId ? (
    <ParentAgentCallout serverId={serverId} parentAgentId={parentAgentId} childAgentId={agentId} />
  ) : null;
  const { isMainControlStream, isInitialHistoryLoading, revealInitialHistory } =
    resolveChatReadyFlags({
      mainAgentId,
      draft,
      routeBottomAnchorReason: routeBottomAnchorRequest?.reason,
      hasCachedHistory,
      showHistorySyncError,
    });
  const useTopicCards = useTopicStreamMode(serverId, agentId) === "topics" && isMainControlStream;
  const handleFocusCompactComposer = useCallback(() => {
    composerEditingSession.focus();
  }, [composerEditingSession]);
  const agentComposerSection = showsComposer ? (
    <RenderProfile id={`AgentComposerSection:${agentId}`}>
      <AgentLimitRecovery serverId={serverId} workspaceId={workspaceId} agentId={agentId} />
      <AgentComposerSection
        agentId={agentId}
        serverId={serverId}
        isPaneFocused={isPaneFocused}
        isArchivingCurrentAgent={isArchivingCurrentAgent}
        archivedAt={agentState.archivedAt}
        cwd={cwd}
        isSubmitLoading={false}
        agentInputDraft={agentInputDraft}
        editingSession={composerEditingSession}
        hidePendingInboxBar={useTopicCards}
        onAttentionInputFocus={onAttentionInputFocus}
        onAttentionPromptSend={onAttentionPromptSend}
        onComposerHeightChange={handleComposerHeightChange}
        onMessageSent={handleMessageSent}
        onErrorToast={toastApi.error}
      />
    </RenderProfile>
  ) : (
    parentCallout
  );
  const composerSection = draft ? (
    <DraftComposerSection
      serverId={serverId}
      draft={draft}
      isPaneFocused={isPaneFocused}
      editingSession={composerEditingSession}
    />
  ) : (
    agentComposerSection
  );
  const handleAttentionInteraction = useCallback(() => {
    onAttentionUserInteraction();
    return false;
  }, [onAttentionUserInteraction]);
  const sideChatSourceId = useSessionStore((state) =>
    getSideChatSourceAgentId(resolveChatAgentFromSession(state, serverId, agentId)),
  );
  const quoteSideChatReply = useStableEvent(async (quoteText: string) => {
    if (!sideChatSourceId || !workspaceId || !quoteText.trim()) return;
    const resolveSourceDraftKey = () =>
      resolveVisibleReplyDraftKey(serverId, workspaceId, sideChatSourceId);
    const draftKey = resolveSourceDraftKey();
    const appended = await appendSideChatReplyToDraft({
      draftKey,
      text: quoteText,
      canQuote: () => {
        const state = useSessionStore.getState();
        const source = resolveChatAgentFromSession(state, serverId, sideChatSourceId);
        return (
          isSideChatMainAgent(source, workspaceId, serverId) &&
          !isHandoffInputLocked(serverId, sideChatSourceId) &&
          !isTopicComposerDraftSubmitting(draftKey) &&
          draftKey === resolveSourceDraftKey()
        );
      },
    });
    if (!appended) {
      toastApi.error(
        isTopicComposerDraftSubmitting(draftKey)
          ? t("topicWorkbench.topicStream.quoteAfterSending")
          : t("message.actions.forkUnavailable"),
      );
      return;
    }
    navigateToWorkspace({
      serverId,
      workspaceId,
      target: { kind: "agent", agentId: sideChatSourceId },
      asTab: true,
    });
  });
  const quoteTarget = useMemo<ComposerQuoteTarget | null>(
    () =>
      showsComposer && hasActiveComposer && !draft
        ? {
            addQuoteAttachment: (quoteText: string, label?: string) => {
              if (sideChatSourceId) {
                void quoteSideChatReply(quoteText).catch(() =>
                  toastApi.error(t("message.actions.forkFailed")),
                );
                return;
              }
              if (isHandoffInputLocked(serverId, agentId)) return;
              const quote = createQuoteAttachment({ text: quoteText, label });
              if (!quote.text) return;
              const draftKey = resolveVisibleReplyDraftKey(serverId, workspaceId, agentId);
              if (isTopicComposerDraftSubmitting(draftKey)) {
                toastApi.error(t("topicWorkbench.topicStream.quoteAfterSending"));
                return;
              }
              useDraftStore.getState().updateDraftInput({
                draftKey,
                update: (current) => ({
                  ...current,
                  attachments: [...current.attachments, quote],
                }),
              });
            },
          }
        : null,
    [
      agentId,
      serverId,
      workspaceId,
      draft,
      hasActiveComposer,
      showsComposer,
      sideChatSourceId,
      quoteSideChatReply,
      t,
      toastApi,
    ],
  );
  const streamContent = (
    <View style={animatedStaticStyles.content}>
      {showsComposer ? null : <SheetAgentFacts serverId={serverId} agentId={agentId} />}
      <FallbackTopicStreamToolbar
        enabled={isMainControlStream}
        serverId={serverId}
        workspaceId={workspaceId}
        agentId={agentId}
      />
      <RenderProfile id={`AgentStreamSection:${agentId}`}>
        <AgentStreamSection
          isSubagent={isSubagent}
          useTopicCards={useTopicCards}
          isPaneFocused={isPaneFocused}
          workspaceId={workspaceId}
          streamViewRef={streamViewRef}
          serverId={serverId}
          agentId={agentId}
          agent={effectiveAgent}
          draft={draft}
          routeBottomAnchorRequest={routeBottomAnchorRequest}
          hasAppliedAuthoritativeHistory={hasAppliedAuthoritativeHistory}
          isInitialHistoryLoading={isInitialHistoryLoading}
          revealInitialHistory={revealInitialHistory}
          hasActiveComposer={hasActiveComposer}
          toast={toastApi}
          quoteTarget={quoteTarget}
          canSubmitSelection={canSubmitSelection}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          onFocusCompactComposer={handleFocusCompactComposer}
        />
      </RenderProfile>
      <AgentDurableItems
        serverId={serverId}
        workspaceId={workspaceId}
        agentId={agentState.id}
        isPaneFocused={isPaneFocused}
      />
      {hasActiveComposer && !draft ? (
        <AgentTracks
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agentId}
          parentAgentId={parentPillAgentId}
        />
      ) : null}
    </View>
  );

  const dockContent = (
    <View style={styles.contentContainer}>
      {streamContent}
      <AgentPendingRewindFiles
        serverId={serverId}
        agent={effectiveAgent}
        draft={draft}
        isArchiving={isArchivingCurrentAgent}
        cwd={cwd}
        toastApi={toastApi}
      />

      {showHistorySyncError ? (
        <TimelineSyncErrorCallout isRetrying={isRetryingHistorySync} onRetry={retryTimelineSync} />
      ) : null}
    </View>
  );

  const dockOverlay = (
    <>
      {showHistorySyncOverlay ? (
        <View style={styles.historySyncOverlay} testID="agent-history-overlay">
          <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
        </View>
      ) : null}

      <TimelineSyncStatus sync={timelineSync} toast={toast} onDismiss={dismiss} />
    </>
  );

  const dock = (
    <ChatSurface
      serverId={serverId}
      disabled={isArchivingCurrentAgent}
      fullscreen={isComposerFullscreen}
    >
      {dockContent}
      {composerSection}
      {dockOverlay}
    </ChatSurface>
  );

  const chat = (
    <View style={styles.root} onStartShouldSetResponderCapture={handleAttentionInteraction}>
      {dock}

      {isArchivingCurrentAgent ? (
        <View style={styles.archivingOverlay} testID="agent-archiving-overlay">
          <ThemedLoadingSpinner size="large" uniProps={foregroundColorMapping} />
          <Text style={styles.archivingTitle}>{t("agentPanel.states.archivingTitle")}</Text>
          <Text style={styles.archivingSubtitle}>{t("agentPanel.states.archivingSubtitle")}</Text>
        </View>
      ) : null}
    </View>
  );
  const content = (
    <ChatAgentReadyFrame
      textSource={agentInputDraft.textSource}
      setText={agentInputDraft.replaceText}
      onRewindComplete={handleRewindComplete}
      mainAgentId={mainAgentId}
    >
      {hasAgentComposer ? (
        <RewindCommandCenterRegistration
          serverId={serverId}
          agentId={agentId}
          capabilities={agentState.capabilities}
          timelineSync={timelineSync}
          enabled={isPaneFocused}
        />
      ) : null}
      {chat}
    </ChatAgentReadyFrame>
  );
  return wrapAgentCommandProvider({
    enabled: hasAgentComposer,
    serverId,
    agentId,
    editingSession: composerEditingSession,
    children: content,
  });
});

function AgentPendingRewindFiles({
  agent,
  draft,
  isArchiving,
  toastApi,
  ...scope
}: {
  serverId: string;
  agent: AgentScreenAgent | null;
  draft: DraftConversation | null;
  isArchiving: boolean;
  cwd: string;
  toastApi: ToastApi;
}) {
  if (!agent || draft || isArchiving) return null;
  return (
    <ToastApiProvider api={toastApi}>
      <AgentPendingRewindFileNotice {...scope} agentId={agent.id} />
    </ToastApiProvider>
  );
}

function AgentPendingRewindFileNotice({
  serverId,
  agentId,
  cwd,
}: {
  serverId: string;
  agentId: string;
  cwd: string;
}) {
  const active = useRetainedPanelActive();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const recovery = usePendingRewindFileRecovery({
    serverId,
    agentId,
    cwd,
    client,
    enabled: active && connected,
  });
  if (!recovery?.length) return null;
  return (
    <View style={styles.timelineSyncCalloutRail} testID="agent-pending-rewind-files">
      <View style={styles.timelineSyncCalloutContent}>{recovery}</View>
    </View>
  );
}

function ChatAgentReadyFrame({
  mainAgentId,
  children,
  ...rewind
}: React.ComponentProps<typeof RewindComposerRestoreProvider> & { mainAgentId: string | null }) {
  return (
    <RewindComposerRestoreProvider {...rewind}>
      <MainControlTreeLayout mainAgentId={mainAgentId}>{children}</MainControlTreeLayout>
    </RewindComposerRestoreProvider>
  );
}

function wrapAgentCommandProvider({
  enabled,
  serverId,
  agentId,
  editingSession,
  children,
}: {
  enabled: boolean;
  serverId: string;
  agentId: string;
  editingSession: ComposerEditingSession;
  children: ReactNode;
}) {
  return (
    <AgentCommandsProvider
      serverId={serverId}
      agentId={agentId}
      editingSession={editingSession}
      enabled={enabled}
    >
      {children}
    </AgentCommandsProvider>
  );
}

function ChatSurface({
  serverId,
  children,
  disabled,
  fullscreen,
}: {
  serverId: string;
  children: [ReactNode, ReactNode, ReactNode];
  disabled: boolean;
  fullscreen: boolean;
}) {
  // The tracks above the composer open their pages from outside it, so focusing the composer
  // closes everything the chat opened.
  return (
    <OverlayDismissalScope>
      <ChatColumnRailSurface serverId={serverId}>
        <FileDropZone style={styles.container} disabled={disabled}>
          <ComposerDock fullscreen={fullscreen}>{children}</ComposerDock>
        </FileDropZone>
      </ChatColumnRailSurface>
    </OverlayDismissalScope>
  );
}

function TimelineSyncErrorCallout({
  isRetrying,
  onRetry,
}: {
  isRetrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.timelineSyncCalloutRail} dataSet={CHAT_COLUMN_RAIL_DATASET}>
      <View style={styles.timelineSyncCalloutContent}>
        <View style={styles.timelineSyncCallout} testID="agent-timeline-sync-error">
          <Text style={styles.timelineSyncCalloutText}>
            {t("agentPanel.states.timelineSyncFailed")}
          </Text>
          <Button
            variant="secondary"
            onPress={onRetry}
            disabled={isRetrying}
            testID="agent-timeline-sync-retry"
          >
            {isRetrying ? t("agentPanel.states.timelineSyncRetrying") : t("common.actions.retry")}
          </Button>
        </View>
      </View>
    </View>
  );
}

/**
 * What the composer's controls and context meter would show, as one line, for an agent shown
 * without its composer.
 */
function SheetAgentFacts({ serverId, agentId }: { serverId: string; agentId: string }) {
  const text = useAgentFactsLine(serverId, agentId);
  return text ? <PaneSubtitle text={text} testID="agent-pane-subtitle" /> : null;
}

const AgentStreamSection = memo(function AgentStreamSection({
  isSubagent,
  useTopicCards = false,
  isPaneFocused = true,
  workspaceId = "",
  streamViewRef,
  serverId,
  agentId,
  agent,
  draft,
  routeBottomAnchorRequest,
  hasAppliedAuthoritativeHistory,
  isInitialHistoryLoading,
  revealInitialHistory,
  hasActiveComposer,
  toast,
  quoteTarget,
  canSubmitSelection,
  onOpenWorkspaceFile,
  onFocusCompactComposer,
}: {
  isSubagent: boolean;
  useTopicCards?: boolean;
  isPaneFocused?: boolean;
  workspaceId?: string;
  streamViewRef: React.RefObject<AgentStreamViewHandle | null>;
  serverId: string;
  agentId?: string;
  agent: AgentScreenAgent | null;
  draft: DraftConversation | null;
  routeBottomAnchorRequest: RouteBottomAnchorRequest;
  hasAppliedAuthoritativeHistory: boolean;
  isInitialHistoryLoading: boolean;
  revealInitialHistory: boolean;
  hasActiveComposer: boolean;
  toast: ReturnType<typeof useToastHost>["api"];
  quoteTarget: ComposerQuoteTarget | null;
  canSubmitSelection?: (agentId: string, workspaceId: string) => boolean;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
  onFocusCompactComposer?: () => void;
}) {
  const isCompactFormFactor = useIsCompactFormFactor();
  // The track bar's space is reserved whenever the bar is mounted, pills or not: pills come and go
  // every turn, and the transcript must not jump with them.
  const bottomOverlayTailClearance = hasActiveComposer
    ? resolveComposerTrackTailClearance(isCompactFormFactor)
    : 0;
  const bottomOverlayControlClearance = hasActiveComposer
    ? resolveComposerTrackControlClearance(isCompactFormFactor)
    : 0;
  const streamItemsRaw = useAgentStreamTail(serverId, agentId);
  const streamHeadRaw = useSessionStore((state) =>
    useTopicCards && agentId ? state.sessions[serverId]?.agentStreamHead.get(agentId) : undefined,
  );
  const pendingMessageSubmissions = useSessionStore(
    useShallow((state) =>
      agentId
        ? getActiveMessageSubmissions(state.sessions[serverId]?.messageSubmissions.get(agentId))
        : EMPTY_MESSAGE_SUBMISSIONS,
    ),
  );
  const turnPresentation = useSessionStore(
    useShallow((state) =>
      agentId
        ? selectAgentTimelineTurnPresentation(state.sessions[serverId], agentId)
        : { isActive: false, isCancelling: false, startedAt: null, turnId: null },
    ),
  );
  const streamItems = streamItemsRaw ?? EMPTY_STREAM_ITEMS;
  const permissionClient = useSessionStore((state) =>
    useTopicCards ? (state.sessions[serverId]?.client ?? null) : null,
  );
  const pendingPermissionList = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!agentId) {
        return EMPTY_PENDING_PERMISSION_LIST;
      }
      const allPendingPermissions = state.sessions[serverId]?.pendingPermissions;
      if (!allPendingPermissions) {
        return EMPTY_PENDING_PERMISSION_LIST;
      }
      const filtered: PendingPermission[] = [];
      for (const permission of allPendingPermissions.values()) {
        if (permission.agentId === agentId) {
          filtered.push(permission);
        }
      }
      return filtered.length > 0 ? filtered : EMPTY_PENDING_PERMISSION_LIST;
    },
    shallow,
  );
  const pendingPermissions = useMemo(() => {
    if (pendingPermissionList.length === 0) {
      return EMPTY_PENDING_PERMISSIONS;
    }
    return new Map(pendingPermissionList.map((permission) => [permission.key, permission]));
  }, [pendingPermissionList]);
  // A draft's timeline exists only while its first prompt creates the agent. The created agent's
  // timeline then replaces this input in the same mounted view.
  const draftTimeline = useDraftTimeline({ serverId, draft });

  if (draftTimeline) {
    return (
      <AgentStreamView
        ref={streamViewRef}
        agentId={draftTimeline.agent.id}
        serverId={serverId}
        context={draftTimeline.agent}
        streamItems={draftTimeline.streamItems}
        pendingPermissions={EMPTY_PENDING_PERMISSIONS}
        bottomOverlayTailClearance={bottomOverlayTailClearance}
        bottomOverlayControlClearance={bottomOverlayControlClearance}
        toast={toast}
        pendingMessageSubmissions={draftTimeline.pendingMessageSubmissions}
        turnPresentation={draftTimeline.turnPresentation}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    );
  }
  if (!agent) {
    return null;
  }
  if (useTopicCards && workspaceId) {
    return (
      <ComposerQuoteProvider target={quoteTarget}>
        <TopicStreamList
          serverId={serverId}
          workspaceId={workspaceId}
          mainAgentId={agent.id}
          streamItems={streamItems}
          streamHead={streamHeadRaw ?? EMPTY_STREAM_ITEMS}
          pendingPermissions={pendingPermissionList}
          pendingPermissionsNode={renderPendingPermissionsNode({
            pendingPermissions: pendingPermissionList,
            client: permissionClient,
          })}
          isTurnActive={turnPresentation.isActive}
          isPaneFocused={isPaneFocused}
          bottomClearance={bottomOverlayTailClearance}
          onFocusCompactComposer={onFocusCompactComposer}
          onErrorToast={toast.error}
        />
      </ComposerQuoteProvider>
    );
  }
  return (
    <ComposerQuoteProvider target={quoteTarget}>
      <AgentStreamView
        ref={streamViewRef}
        agentId={agent.id}
        serverId={serverId}
        context={agent}
        streamItems={streamItems}
        pendingPermissions={pendingPermissions}
        routeBottomAnchorRequest={routeBottomAnchorRequest}
        isAuthoritativeHistoryReady={hasAppliedAuthoritativeHistory}
        isInitialHistoryLoading={isInitialHistoryLoading}
        revealInitialHistory={revealInitialHistory}
        bottomOverlayTailClearance={bottomOverlayTailClearance}
        bottomOverlayControlClearance={bottomOverlayControlClearance}
        toast={toast}
        pendingMessageSubmissions={pendingMessageSubmissions}
        turnPresentation={turnPresentation}
        showAgentInteractions={isSubagent ? true : undefined}
        canSubmitSelection={quoteTarget ? canSubmitSelection : undefined}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    </ComposerQuoteProvider>
  );
});

/** The draft's composer, which creates the agent and retargets this tab to it. */
function DraftComposerSection({
  serverId,
  draft,
  isPaneFocused,
  editingSession,
}: {
  serverId: string;
  draft: DraftConversation;
  isPaneFocused: boolean;
  editingSession: ComposerEditingSession;
}) {
  const { openImportSheet, retargetCurrentTab } = usePaneContext();
  const handleCreated = useCallback(
    (agentSnapshot: Parameters<typeof normalizeAgentSnapshot>[0]) => {
      const normalized = normalizeAgentSnapshot(agentSnapshot, serverId);
      const agent = applyLegacyDaemonWorkspaceOwnership({ serverId, agent: normalized });
      getHostRuntimeStore().acceptAgentSnapshot(serverId, agent);
      retargetCurrentTab({ kind: "agent", agentId: agentSnapshot.id });
    },
    [retargetCurrentTab, serverId],
  );

  return (
    <WorkspaceDraftComposer
      serverId={serverId}
      workspaceId={draft.workspaceId}
      tabId={draft.tabId}
      draftId={draft.draftId}
      initialSetup={draft.setup}
      isPaneFocused={isPaneFocused}
      editingSession={editingSession}
      onCreated={handleCreated}
      onOpenImportSheet={openImportSheet}
    />
  );
}

const AgentComposerSection = memo(function AgentComposerSection({
  agentId,
  serverId,
  isPaneFocused,
  isArchivingCurrentAgent,
  archivedAt,
  cwd,
  isSubmitLoading,
  agentInputDraft,
  editingSession,
  hidePendingInboxBar = false,
  onAttentionInputFocus,
  onAttentionPromptSend,
  onComposerHeightChange,
  onMessageSent,
  onErrorToast,
}: {
  agentId?: string;
  serverId: string;
  isPaneFocused: boolean;
  isArchivingCurrentAgent: boolean;
  archivedAt: Date | null;
  cwd: string;
  isSubmitLoading: boolean;
  agentInputDraft: AgentInputDraft;
  editingSession: ComposerEditingSession;
  hidePendingInboxBar?: boolean;
  onAttentionInputFocus: () => void;
  onAttentionPromptSend: () => void;
  onComposerHeightChange: (height: number) => void;
  onMessageSent: () => void;
  onErrorToast?: (message: string) => void;
}) {
  if (!agentId) {
    return null;
  }
  if (archivedAt) {
    return <ArchivedAgentCallout serverId={serverId} agentId={agentId} />;
  }
  if (isArchivingCurrentAgent) {
    return null;
  }

  return (
    <ActiveAgentComposer
      agentId={agentId}
      serverId={serverId}
      isPaneFocused={isPaneFocused}
      cwd={cwd}
      isSubmitLoading={isSubmitLoading}
      agentInputDraft={agentInputDraft}
      editingSession={editingSession}
      hidePendingInboxBar={hidePendingInboxBar}
      onAttentionInputFocus={onAttentionInputFocus}
      onAttentionPromptSend={onAttentionPromptSend}
      onComposerHeightChange={onComposerHeightChange}
      onMessageSent={onMessageSent}
      onErrorToast={onErrorToast}
    />
  );
});

const ThemedCloseIcon = withUnistyles(X, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

function ActiveAgentComposer({
  agentId,
  serverId,
  isPaneFocused,
  cwd,
  isSubmitLoading,
  agentInputDraft,
  editingSession,
  hidePendingInboxBar = false,
  onAttentionInputFocus,
  onAttentionPromptSend,
  onComposerHeightChange,
  onMessageSent,
  onErrorToast,
}: {
  agentId: string;
  serverId: string;
  isPaneFocused: boolean;
  cwd: string;
  isSubmitLoading: boolean;
  agentInputDraft: AgentInputDraft;
  editingSession: ComposerEditingSession;
  hidePendingInboxBar?: boolean;
  onAttentionInputFocus: () => void;
  onAttentionPromptSend: () => void;
  onComposerHeightChange: (height: number) => void;
  onMessageSent: () => void;
  onErrorToast?: (message: string) => void;
}) {
  const isComposerFullscreen = useComposerFullscreen(editingSession);
  const isCompactFormFactor = useIsCompactFormFactor();
  const { onLayout: onInputAreaLayout, isBelow: isCompactComposerLayout } = useContainerWidthBelow(
    COMPACT_CONTENT_WIDTH,
    { initialIsBelow: isCompactFormFactor },
  );
  const paneContext = usePaneContext();
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const { workspaceId, tabId, target, retargetCurrentTab } = paneContext;
  const { t } = useTranslation();
  const isCurrentAgentTab =
    paneContext.serverId === serverId && target.kind === "agent" && target.agentId === agentId;
  const allowSideChat = useSessionStore(
    (state) =>
      isCurrentAgentTab &&
      // COMPAT(agentSideChat): added in v0.17.0, remove gate after 2027-06-01.
      selectHostFeature(state, serverId, "agentSideChat") &&
      isSideChatMainAgent(
        resolveChatAgentFromSession(state, serverId, agentId),
        workspaceId,
        serverId,
      ),
  );
  const { archiveAgent } = useArchiveAgent();
  const closeWorkspaceTab = useWorkspaceLayoutStore((state) => state.closeTab);
  const hideWorkspaceAgent = useWorkspaceLayoutStore((state) => state.hideAgent);
  const unpinWorkspaceAgent = useWorkspaceLayoutStore((state) => state.unpinAgent);
  const workspaceAttachmentScopeKey = useWorkspaceAttachmentScopeKey({
    serverId,
    cwd,
    workspaceId,
  });
  const attachmentScopeKeys = useMemo(
    () => [workspaceAttachmentScopeKey],
    [workspaceAttachmentScopeKey],
  );
  const handleOpenWorkspaceAttachment = useCallback(
    (attachment: WorkspaceComposerAttachment) => {
      if (attachment.kind !== "review") {
        return;
      }
      openWorkspaceChanges({
        isCompact: isCompactFormFactor,
        workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
        preferences: openInSidePane,
      });
    },
    [isCompactFormFactor, openInSidePane, serverId, workspaceId],
  );

  const handleClientSlashCommand = useCallback(
    async (command: ClientSlashCommand) => {
      const state = useSessionStore.getState();
      const agent = resolveChatAgentFromSession(state, serverId, agentId);
      if (!agent) {
        throw new Error("Agent not found");
      }
      if (command.kind === "side-chat") {
        if (
          !isCurrentAgentTab ||
          !selectHostFeature(state, serverId, "agentSideChat") ||
          !isSideChatMainAgent(agent, workspaceId, serverId) ||
          agent.cwd !== cwd
        ) {
          throw new Error(t("message.actions.forkUnavailable"));
        }
        const session = state.sessions[serverId];
        const setup = buildSideChatDraftSetup({
          agentId,
          agent,
          timeline: selectAgentTimelineState(session, agentId),
          liveItems: session?.agentStreamHead.get(agentId),
          text: command.argumentText,
        });
        if (!setup) throw new Error(t("message.actions.forkUnavailable"));
        openSideChatDraft({ serverId, workspaceId, setup });
        return;
      }

      const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
      if (workspaceKey) {
        unpinWorkspaceAgent(workspaceKey, agentId);
        hideWorkspaceAgent(workspaceKey, agentId);
      }

      if (command.kind === "replace-agent-with-draft") {
        retargetCurrentTab({
          kind: "draft",
          draftId: generateDraftId(),
          setup: buildDraftAgentSetup(agent),
        });
      } else if (workspaceKey) {
        closeWorkspaceTab(workspaceKey, tabId);
      }

      await archiveAgent({ serverId, agentId });
    },
    [
      agentId,
      archiveAgent,
      closeWorkspaceTab,
      cwd,
      hideWorkspaceAgent,
      isCurrentAgentTab,
      retargetCurrentTab,
      serverId,
      tabId,
      t,
      unpinWorkspaceAgent,
      workspaceId,
    ],
  );

  const {
    activeReplyTopic,
    topicDraftKey,
    submittingTopicDraftKey,
    topicQueue,
    recoveredTopicDecisions,
    handleOpenRecoveredDecision,
    handleToggleReplyRouteMode,
    handleCancelReplyTopic,
    handleSubmitTopicReply,
    sendQueuedTopicReply,
  } = useActiveTopicComposer({
    serverId,
    workspaceId,
    agentId,
    agentInputDraft,
    onErrorToast,
    onMessageSent,
  });
  const DraftComposer = topicDraftKey ? ScopedTopicDraftComposer : Composer;

  return (
    <View style={animatedStaticStyles.inputAreaWrapper} onLayout={onInputAreaLayout}>
      <PendingSubagentInboxBar
        key={JSON.stringify([serverId, agentId])}
        serverId={serverId}
        agentId={agentId}
        hidden={isComposerFullscreen || hidePendingInboxBar}
      />
      {activeReplyTopic && !isComposerFullscreen ? (
        <CompactTopicReplyContext
          activeReplyTopic={activeReplyTopic}
          onToggleRoute={handleToggleReplyRouteMode}
          onCancel={handleCancelReplyTopic}
        />
      ) : null}
      {!isComposerFullscreen
        ? recoveredTopicDecisions?.map((recovery) =>
            recovery.recoveryId !==
            (activeReplyTopic && getTopicReplyRecoveryId(activeReplyTopic)) ? (
              <RecoveredDecisionDraft
                key={recovery.recoveryId}
                recovery={recovery}
                onOpen={handleOpenRecoveredDecision}
              />
            ) : null,
          )
        : null}
      <DraftComposer
        key={topicDraftKey ?? agentId}
        topicDraftKey={topicDraftKey}
        topicQueue={topicQueue}
        onDeliverQueuedTopic={sendQueuedTopicReply}
        agentId={agentId}
        serverId={serverId}
        workspaceId={workspaceId}
        blurOnSubmit={isNative}
        isPaneFocused={isPaneFocused}
        textSource={agentInputDraft.textSource}
        onChangeText={agentInputDraft.editText}
        textReplacement={agentInputDraft.textReplacement}
        attachments={agentInputDraft.attachments}
        attachmentScopeKeys={attachmentScopeKeys}
        onOpenWorkspaceAttachment={handleOpenWorkspaceAttachment}
        onChangeAttachments={agentInputDraft.setAttachments}
        cwd={cwd}
        clearDraft={agentInputDraft.clear}
        editingSession={editingSession}
        autoFocus
        autoFocusKey={String(agentInputDraft.attachmentFocusRequestId)}
        isSubmitLoading={
          isSubmitLoading || Boolean(topicDraftKey && submittingTopicDraftKey === topicDraftKey)
        }
        onAttentionInputFocus={onAttentionInputFocus}
        onAttentionPromptSend={onAttentionPromptSend}
        onComposerHeightChange={onComposerHeightChange}
        onMessageSent={onMessageSent}
        onSubmitMessage={activeReplyTopic ? handleSubmitTopicReply : undefined}
        onClientSlashCommand={handleClientSlashCommand}
        allowSideChat={allowSideChat}
        isCompactLayout={isCompactComposerLayout}
      />
    </View>
  );
}

function CompactTopicReplyContext({
  activeReplyTopic,
  onToggleRoute,
  onCancel,
}: {
  activeReplyTopic: ActiveTopicReplyTarget;
  onToggleRoute: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.topicReplyContextRail} testID="compact-topic-reply-context">
      <View style={styles.topicReplyContextBar}>
        <Text style={styles.topicReplyContextText} numberOfLines={1}>
          {activeReplyTopic.decisionContext
            ? t("topicWorkbench.topicStream.decidingContextBanner", {
                preview:
                  activeReplyTopic.decisionContext.question.slice(0, 60) ||
                  activeReplyTopic.promptPreview ||
                  activeReplyTopic.topicKey,
              })
            : t("topicWorkbench.topicStream.replyingContextBanner", {
                preview: activeReplyTopic.promptPreview || activeReplyTopic.topicKey,
              })}
        </Text>
        {activeReplyTopic.leadAgentId && !activeReplyTopic.decisionContext ? (
          <PressHighlight
            accessibilityRole="button"
            onPress={onToggleRoute}
            style={styles.topicReplyRoutePill}
            testID="compact-topic-reply-route-toggle"
          >
            <Text style={styles.topicReplyRouteText}>
              {activeReplyTopic.routeMode === "main"
                ? t("topicWorkbench.topicStream.replyToMain")
                : t("topicWorkbench.topicStream.replyToLead", {
                    name:
                      activeReplyTopic.leadTitle ||
                      t("topicWorkbench.topicStream.leadFallbackName"),
                  })}
            </Text>
          </PressHighlight>
        ) : null}
        <PressHighlight
          accessibilityRole="button"
          accessibilityLabel={t("topicWorkbench.topicStream.cancelReplyContext")}
          onPress={onCancel}
          style={styles.topicReplyCloseButton}
          testID="compact-topic-reply-cancel"
        >
          <ThemedCloseIcon size={14} />
        </PressHighlight>
      </View>
      {activeReplyTopic.decisionContext?.staleNotice ? (
        <Text style={styles.topicDecisionStaleNotice} testID="compact-topic-decision-stale-notice">
          {activeReplyTopic.decisionContext.staleNotice}
        </Text>
      ) : null}
    </View>
  );
}

function resolveVisibleReplyDraftKey(serverId: string, workspaceId: string, agentId: string) {
  const target =
    useTopicStreamViewStore.getState().activeReplyTopicByAgentKey[
      buildTopicAgentKey(serverId, agentId)
    ] ?? null;
  return resolveReplyComposerDraftKey({ serverId, workspaceId, agentId, target });
}

function RecoveredDecisionDraft({
  recovery,
  onOpen,
}: {
  recovery: RecoveredTopicReplyTarget;
  onOpen: (recovery: RecoveredTopicReplyTarget) => void;
}) {
  const { t } = useTranslation();
  const open = useCallback(() => onOpen(recovery), [onOpen, recovery]);
  return (
    <View style={styles.topicReplyContextRail}>
      <View style={styles.topicReplyContextBar}>
        <Text style={styles.topicReplyContextText} numberOfLines={1}>
          {recovery.promptPreview || recovery.topicKey}
        </Text>
        <PressHighlight
          accessibilityRole="button"
          onPress={open}
          style={styles.topicReplyRoutePill}
        >
          <Text style={styles.topicReplyRouteText}>
            {t("topicWorkbench.topicStream.reviewRecoveredDecision")}
          </Text>
        </PressHighlight>
      </View>
    </View>
  );
}

function useActiveTopicComposer({
  serverId,
  workspaceId,
  agentId,
  agentInputDraft,
  onErrorToast,
  onMessageSent,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  agentInputDraft: AgentInputDraft;
  onErrorToast?: (message: string) => void;
  onMessageSent: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const supportsTopicThreads = useHostFeature(serverId, "workspaceTopicThreads");
  // COMPAT(workspaceButlerV1): added in v0.18.0, remove gate after 2027-06-01.
  const supportsButlerV1 = useHostFeature(serverId, "workspaceButlerV1");
  const supportsForgeAttachments = useHostFeature(serverId, "forgeSearch");
  const topicAgentKey = buildTopicAgentKey(serverId, agentId);
  const activeReplyTopic = useTopicStreamViewStore(
    (state) => state.activeReplyTopicByAgentKey[topicAgentKey] ?? null,
  );
  const setActiveReplyTopic = useTopicStreamViewStore((state) => state.setActiveReplyTopic);
  const clearActiveReplyTopicIfMatches = useTopicStreamViewStore(
    (state) => state.clearActiveReplyTopicIfMatches,
  );
  const setActiveReplyRouteMode = useTopicStreamViewStore((state) => state.setActiveReplyRouteMode);
  const topicDraftKey = activeReplyTopic
    ? resolveReplyComposerDraftKey({ serverId, workspaceId, agentId, target: activeReplyTopic })
    : undefined;
  const recoveryScope = buildDecisionRecoveryScope(serverId, workspaceId, agentId);
  const recoveredTopicDecisions = useDecisionRecoveryStore((state) => state.byScope[recoveryScope]);
  const handleOpenRecoveredDecision = useCallback(
    (recovery: RecoveredTopicReplyTarget) => {
      if (!isHandoffInputLocked(serverId, agentId)) setActiveReplyTopic(topicAgentKey, recovery);
    },
    [agentId, serverId, setActiveReplyTopic, topicAgentKey],
  );
  const [submittingTopicDraftKey, setSubmittingTopicDraftKey] = useState<string>();
  const refreshActiveDecisionContext = useTopicStreamViewStore(
    (state) => state.refreshActiveDecisionContext,
  );
  const handleCancelReplyTopic = useCallback(() => {
    setActiveReplyTopic(topicAgentKey, null);
  }, [setActiveReplyTopic, topicAgentKey]);
  const handleToggleReplyRouteMode = useCallback(() => {
    if (!activeReplyTopic) return;
    setActiveReplyRouteMode(topicAgentKey, activeReplyTopic.routeMode === "main" ? "auto" : "main");
  }, [activeReplyTopic, setActiveReplyRouteMode, topicAgentKey]);
  const clearSubmittedTarget = useCallback(
    (clientMessageId: string) => {
      if (!activeReplyTopic || !topicDraftKey) return;
      finishTopicSubmission(topicDraftKey, clientMessageId);
      const recoveryId = getTopicReplyRecoveryId(activeReplyTopic);
      if (recoveryId) useDecisionRecoveryStore.getState().remove(recoveryScope, recoveryId);
      clearActiveReplyTopicIfMatches(topicAgentKey, {
        topicKey: activeReplyTopic.topicKey,
        taskId: activeReplyTopic.taskId,
        decisionKind: activeReplyTopic.decisionContext?.kind,
        decisionTaskId: activeReplyTopic.decisionContext?.taskId,
        blockingQuestionGeneration: activeReplyTopic.decisionContext?.blockingQuestionGeneration,
        selection: activeReplyTopic,
      });
    },
    [activeReplyTopic, clearActiveReplyTopicIfMatches, recoveryScope, topicAgentKey, topicDraftKey],
  );

  const sendQueuedTopicReply = useCallback(
    async (topicReply: QueuedTopicReply, payload: MessagePayload) => {
      const result = await deliverQueuedTopicReply({
        queryClient,
        serverId,
        agentId,
        topicReply,
        payload,
        supportsTopicThreads,
        supportsButlerV1,
        supportsForgeAttachments,
      });
      if (result === "recovered") return result;
      onMessageSent();
    },
    [
      agentId,
      onMessageSent,
      queryClient,
      serverId,
      supportsButlerV1,
      supportsForgeAttachments,
      supportsTopicThreads,
    ],
  );

  const handleSubmitTopicReply = useCallback(
    async (payload: MessagePayload) => {
      const submittedTarget = activeReplyTopic;
      if (!submittedTarget || !topicDraftKey) throw new Error(t("composer.errors.failedToSend"));
      const clientMessageId = rememberTopicSubmission(topicDraftKey, submittedTarget, payload);
      setSubmittingTopicDraftKey(topicDraftKey);
      try {
        const sent = await submitActiveTopicReply({
          queryClient,
          serverId,
          workspaceId,
          agentId,
          activeReplyTopic: submittedTarget,
          payload,
          supportsTopicThreads,
          supportsButlerV1,
          supportsForgeAttachments,
          clientMessageId,
          disconnectedMessage: t("workspace.terminal.hostDisconnected"),
        });
        if (!sent) throw new Error(t("composer.errors.failedToSend"));
        clearSubmittedTarget(clientMessageId);
      } catch (err) {
        if (err instanceof TopicDecisionStaleQuestionError && submittedTarget.decisionContext) {
          const staleMessage = t("topicWorkbench.topicStream.decisionBlockingQuestionStale");
          refreshActiveDecisionContext(topicAgentKey, {
            expectedTarget: {
              topicKey: submittedTarget.topicKey,
              taskId: submittedTarget.taskId,
              decisionKind: submittedTarget.decisionContext.kind,
              decisionTaskId: submittedTarget.decisionContext.taskId,
              blockingQuestionGeneration:
                submittedTarget.decisionContext.blockingQuestionGeneration,
              selection: submittedTarget,
            },
            question: err.latestTask?.blockingQuestion,
            blockingQuestionGeneration: err.latestTask?.blockingQuestionGeneration,
            staleNotice: staleMessage,
          });
          onErrorToast?.(staleMessage);
        } else {
          onErrorToast?.(err instanceof Error ? err.message : String(err));
        }
        throw err;
      } finally {
        setSubmittingTopicDraftKey((key) => (key === topicDraftKey ? undefined : key));
      }
    },
    [
      activeReplyTopic,
      agentId,
      clearSubmittedTarget,
      onErrorToast,
      queryClient,
      refreshActiveDecisionContext,
      serverId,
      supportsButlerV1,
      supportsForgeAttachments,
      supportsTopicThreads,
      t,
      topicAgentKey,
      topicDraftKey,
      workspaceId,
    ],
  );

  const topicQueue = useMemo(
    () =>
      activeReplyTopic && topicDraftKey
        ? {
            draftKey: topicDraftKey,
            target: activeReplyTopic,
            onQueued: clearSubmittedTarget,
            onEditOrdinary: (text: string, attachments: AgentInputDraft["attachments"]) => {
              agentInputDraft.replaceText(text);
              agentInputDraft.setAttachments(attachments);
              handleCancelReplyTopic();
            },
          }
        : undefined,
    [
      activeReplyTopic,
      agentInputDraft,
      clearSubmittedTarget,
      handleCancelReplyTopic,
      topicDraftKey,
    ],
  );
  return {
    activeReplyTopic,
    topicDraftKey,
    submittingTopicDraftKey,
    topicQueue,
    recoveredTopicDecisions,
    handleOpenRecoveredDecision,
    handleToggleReplyRouteMode,
    handleCancelReplyTopic,
    handleSubmitTopicReply,
    sendQueuedTopicReply,
  };
}

function ScopedTopicDraftComposer({
  topicDraftKey,
  ...props
}: React.ComponentProps<typeof Composer> & { topicDraftKey?: string }) {
  invariant(topicDraftKey, "A topic composer requires a draft key");
  const draft = useAgentInputDraft({ draftKey: topicDraftKey });
  return (
    <Composer
      {...props}
      textSource={draft.textSource}
      onChangeText={draft.editText}
      textReplacement={draft.textReplacement}
      attachments={draft.attachments}
      onChangeAttachments={draft.setAttachments}
      clearDraft={draft.clear}
      autoFocusKey={String(draft.attachmentFocusRequestId)}
      submitBehavior="preserve-and-lock"
    />
  );
}

function AgentSessionUnavailableState({
  serverLabel,
  connectionStatus,
  lastError,
  isUnknownDaemon = false,
  t,
}: {
  serverLabel: string;
  connectionStatus: HostRuntimeConnectionStatus;
  lastError: string | null;
  isUnknownDaemon?: boolean;
  t: TFunction;
}) {
  if (isUnknownDaemon) {
    return (
      <View style={styles.container}>
        <View style={styles.centerState}>
          <Text style={styles.errorText}>
            {t("agentPanel.unavailable.unknownHost", { serverLabel })}
          </Text>
          <Text style={styles.statusText}>{t("agentPanel.unavailable.addHost")}</Text>
        </View>
      </View>
    );
  }

  const isConnecting = connectionStatus === "connecting";
  const isPreparingSession = connectionStatus === "online";

  return (
    <View style={styles.container}>
      <View style={styles.centerState}>
        {isConnecting || isPreparingSession ? (
          <>
            <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
            <Text style={styles.loadingText}>
              {isPreparingSession
                ? t("agentPanel.unavailable.preparingSession", { serverLabel })
                : t("agentPanel.unavailable.connecting", { serverLabel })}
            </Text>
            <Text style={styles.statusText}>
              {isPreparingSession
                ? t("agentPanel.unavailable.showSoon")
                : t("agentPanel.unavailable.showWhenOnline")}
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.offlineTitle}>
              {t("agentPanel.unavailable.reconnectingTo", { serverLabel })}
            </Text>
            <Text style={styles.offlineDescription}>
              {t("agentPanel.unavailable.showAgainWhenReachable")}
            </Text>
            {lastError ? <Text style={styles.offlineDetails}>{lastError}</Text> : null}
          </>
        )}
      </View>
    </View>
  );
}

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const foregroundColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});

const animatedStaticStyles = RNStyleSheet.create({
  content: {
    flex: 1,
  },
  inputAreaWrapper: {
    width: "100%",
    flexShrink: 1,
    // Content-sized inline; fills the dock's fullscreen slot.
    flexGrow: 1,
  },
});

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  contentContainer: {
    flex: 1,
    overflow: "hidden",
    ...(isWeb ? { userSelect: "none" as const } : {}),
  },
  timelineSyncCalloutRail: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
  },
  timelineSyncCalloutContent: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
  },
  timelineSyncCallout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusDanger,
    borderRadius: theme.borderRadius["2xl"],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  timelineSyncCalloutText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  historySyncOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 40,
  },
  archivingOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(8, 10, 14, 0.86)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[8],
    gap: theme.spacing[3],
    zIndex: 50,
  },
  archivingTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  archivingSubtitle: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  loadingText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    gap: theme.spacing[3],
  },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  errorAction: {
    marginTop: theme.spacing[4],
  },
  statusText: {
    marginTop: theme.spacing[2],
    textAlign: "center",
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  offlineTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  offlineDescription: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  offlineDetails: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  topicReplyContextRail: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[1.5],
  },
  topicReplyContextBar: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusSuccess,
    backgroundColor: theme.colors.surface1,
  },
  topicReplyContextText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  topicReplyRoutePill: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  topicReplyRouteText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  topicReplyCloseButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  topicDecisionStaleNotice: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[1],
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
}));
