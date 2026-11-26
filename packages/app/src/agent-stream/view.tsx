import { NativeReadingEpochContext } from "@/agent-stream/native-reading-position";
import { getAssistantQuoteTopic } from "@/assistant-selection-copy/composer-quote";
import { ChatFind, ChatFindExpansion } from "@/agent-stream/chat-find";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import {
  View,
  Text,
  Pressable,
  Platform,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useMutation } from "@tanstack/react-query";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Check, ChevronDown, X } from "lucide-react-native";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { AllowSubagentForkContext } from "@/components/assistant-fork-menu";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import {
  AssistantMessage,
  SpeakMessage,
  UserMessage,
  Notification,
  ToolCall,
  TodoListCard,
  CompactionMarker,
  MessageOuterSpacingProvider,
  type InlinePathTarget,
} from "@/components/message";
import { PlanCard } from "@/components/plan-card";
import { getStreamItemMessageId, type StreamItem } from "@/types/stream";
import type { PendingMessageSubmission } from "@/composer/submission/model";
import type { TurnPresentation } from "@/timeline/turn-liveness";
import type { PendingPermission } from "@/types/shared";
import type {
  AgentCapabilityFlags,
  AgentPermissionAction,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { useSessionStore } from "@/stores/session-store";
import { useRevealedText } from "@/hooks/use-revealed-text";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { useLoadOlderAgentHistory } from "@/hooks/use-load-older-agent-history";
import { resolveContentMaxWidth, useSettings } from "@/hooks/use-settings";
import type { ToastApi } from "@/components/toast-host";
import { returnToTimelineTail } from "./timeline-tail-navigation";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ToolCallDetailsContent } from "@/components/tool-call-details";
import { QuestionFormCard } from "@/components/question-form-card";
import {
  ToolCallExpansionContext,
  useAgentToolCallExpansion,
  useExpandedToolCallGroups,
} from "@/tool-calls/expansion-context";
import {
  UserMessageExpansionContext,
  useAgentUserMessageExpansion,
} from "@/components/user-message/expansion-context";
import {
  AssistantMessageExpansionContext,
  useAgentAssistantMessageExpansion,
} from "@/components/assistant-message-expansion/expansion-context";
import { ToolCallSheetProvider } from "@/components/tool-call-sheet";
import { createStreamPresentation } from "./presentation";
import { OverviewToolCallGroupView } from "@/tool-calls/detail-level/overview/view";
import { IndentRail } from "@/components/indent-rail";
import { TurnSummaryLine } from "./turn-collapse/summary-line";
import { findLatestAgentSourceGroupId, getAgentSourcePresentation } from "./agent-interactions";
import { AgentSourceHeader, UnreadAgentSourceContext } from "./source-header";
import { type AgentStreamRenderModel, buildAgentStreamRenderModel } from "./model";
import { resolveStreamRenderStrategy } from "./strategy-resolver";
import type {
  StreamMessageScrollCompletion,
  StreamSegmentRenderers,
  StreamViewportHandle,
} from "./strategy";
import { renderStreamRow, type RenderStreamItem } from "./stream-row";
import { type NearBottom, useIsNearBottom, useNearBottom } from "./near-bottom";
import { ActivePromptBar } from "@/agent-stream/chat-outline/active-prompt-bar";
import { ChatOutlineRail } from "@/agent-stream/chat-outline/rail";
import {
  shouldTrackChatOutline,
  useChatOutline,
} from "@/agent-stream/chat-outline/use-chat-outline";
import { CHAT_COLUMN_RAIL_DATASET, useChatOutlineRail } from "@/chat-rail";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { planTimelinePromptJump, planTimelineTailFetch } from "@/timeline/timeline-sync-plan";
import {
  useOptionalTeamMessageJumpStore,
  usePendingTeamMessageJump,
} from "@/subagents/team-directory";
import {
  CompletedTurnFooterRow,
  TurnFooter,
  TURN_FOOTER_BOTTOM_SPACING,
  type AssistantTurnForkHandler,
  type InFlightTurnForkHandler,
  type TurnContentStrategy,
} from "./turn-footer";
import { resolveBottomOverlayTailInset } from "./bottom-overlay-inset";
import { layoutStream, type StreamLayoutItem } from "./layout";
import {
  type BottomAnchorLocalRequest,
  type BottomAnchorRouteRequest,
} from "./bottom-anchor-controller";
import { createAssistantImageOccurrenceKey } from "@/assistant-image/acquisition-cache";
import {
  AssistantSelectionCopySurface,
  type SelectionSubagentSpawnContext,
} from "@/assistant-selection-copy/surface";
import { AssistantFileLinkResolverProvider, createInlinePathOpener } from "@/assistant-file-links";
import { useOpenOutsideWorkspaceFolder } from "@/workspace/open-in-file-manager/outside-folder";
import {
  createWorkspaceFileTabTarget,
  type WorkspaceFileLocation,
  type OpenFileDisposition,
  type WorkspaceFileOpenRequest,
} from "@/workspace/file-open";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useForkAgent } from "@/hooks/use-fork-agent";
import { useOptionalPaneContext } from "@/panels/pane-context";
import { isNative, isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { recordRenderProfileReasons } from "@/utils/render-profiler";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useStreamHistoryWindow } from "./use-stream-history-window";
import { resolveSelectionForkBoundary, resolveSubagentSpawnTarget } from "./turn-boundary";
import { PluginTimelineItemView, useInstalledTimelineTransform } from "@/plugins/timeline";

function renderLiveAuxiliaryNode(input: {
  pendingPermissions: ReactNode;
  turnFooter: ReactNode;
  bottomOverlayInset: number;
}): ReactNode {
  if (!input.pendingPermissions && !input.turnFooter && input.bottomOverlayInset === 0) {
    return null;
  }
  return (
    <>
      {input.turnFooter}
      {input.pendingPermissions ? (
        <View style={stylesheet.contentWrapper}>
          <View style={stylesheet.listHeaderContent}>{input.pendingPermissions}</View>
        </View>
      ) : null}
      {input.bottomOverlayInset > 0 ? (
        <BottomOverlayInset height={input.bottomOverlayInset} />
      ) : null}
    </>
  );
}

function BottomOverlayInset({ height }: { height: number }) {
  const style = useMemo(() => ({ height }), [height]);
  return <View style={style} />;
}

export function renderPendingPermissionsNode(input: {
  pendingPermissions: readonly PendingPermission[];
  client: DaemonClient | null;
}): ReactNode {
  if (input.pendingPermissions.length === 0) {
    return null;
  }
  return (
    <View style={stylesheet.permissionsContainer}>
      {input.pendingPermissions.map((permission) => (
        <PermissionRequestCard key={permission.key} permission={permission} client={input.client} />
      ))}
    </View>
  );
}

/**
 * Where a row sits in an opened turn: its summary line's row, a row inside the turn, or the
 * turn's last row. The rail runs through the gaps between them so the turn reads as one block.
 */
type TurnIndent = "none" | "openedHost" | "nested" | "lastNested";

function renderStreamItemWithTurnFooter(input: {
  content: ReactNode;
  layoutItem: StreamLayoutItem;
  turnIndent: TurnIndent;
  strategy: TurnContentStrategy;
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}): ReactNode {
  if (!input.content) {
    return null;
  }

  const footerHost = input.layoutItem.completedFooter;
  const footer = footerHost ? (
    <CompletedTurnFooterRow
      strategy={input.strategy}
      items={footerHost.items}
      timing={footerHost.timing}
      startIndex={footerHost.startIndex}
      turnMetrics={footerHost.turnMetrics}
      supportsTimelineCursor={input.supportsTimelineCursor}
      onForkAssistantTurn={input.onForkAssistantTurn}
    />
  ) : null;
  const content = (
    <StreamItemWrapper gapBelow={input.layoutItem.gapBelow} turnIndent={input.turnIndent}>
      {input.content}
    </StreamItemWrapper>
  );

  if (input.layoutItem.frameOrder === "footer-then-content") {
    return (
      <>
        {footer}
        {content}
      </>
    );
  }

  return (
    <>
      {content}
      {footer}
    </>
  );
}

function renderListEmptyComponent(input: {
  renderModel: AgentStreamRenderModel;
  emptyStateStyle: StyleProp<ViewStyle>;
  emptyText: string;
}): ReactNode {
  if (
    input.renderModel.boundary.hasVirtualizedHistory ||
    input.renderModel.boundary.hasMountedHistory ||
    input.renderModel.boundary.hasLiveHead ||
    input.renderModel.auxiliary.pendingPermissions ||
    input.renderModel.auxiliary.turnFooter
  ) {
    return null;
  }

  return (
    <View style={input.emptyStateStyle}>
      <Text style={stylesheet.emptyStateText}>{input.emptyText}</Text>
    </View>
  );
}

export interface AgentStreamViewHandle {
  scrollToBottom(reason?: BottomAnchorLocalRequest["reason"]): void;
  prepareForViewportChange(): void;
}

type StreamPresentationResult = ReturnType<ReturnType<typeof createStreamPresentation>>;

function findLoadedTeamJumpItem(
  presentation: StreamPresentationResult,
  jump: NonNullable<ReturnType<typeof usePendingTeamMessageJump>>,
): StreamItem | undefined {
  const find = (matches: (item: StreamItem) => boolean) =>
    presentation.sourceTail.find(matches) ??
    presentation.sourceHead.find(matches) ??
    presentation.tail.find(matches) ??
    presentation.head.find(matches);
  return (
    (jump.itemId !== null ? find((item) => item.id === jump.itemId) : undefined) ??
    (jump.epoch !== null && jump.seq !== null
      ? find(
          (item) =>
            item.timelineCursor?.epoch === jump.epoch && item.timelineCursor?.seq === jump.seq,
        )
      : undefined) ??
    (jump.messageId !== null
      ? find((item) => getStreamItemMessageId(item) === jump.messageId)
      : undefined)
  );
}

function resolveLoadedTeamJumpRowId(
  loadedItem: StreamItem,
  presentation: StreamPresentationResult,
  setToolCallGroupExpanded: (groupId: string, expanded: boolean) => void,
): string {
  const displayedRows = [...presentation.tail, ...presentation.head];
  const exactRow = displayedRows.find((row) => row.id === loadedItem.id);
  if (exactRow && !presentation.groupsByHostId.get(exactRow.id)) {
    return getStreamItemMessageId(exactRow);
  }
  for (const row of displayedRows) {
    const group = presentation.groupsByHostId.get(row.id);
    if (!group?.run.calls.some((call) => call.id === loadedItem.id)) continue;
    setToolCallGroupExpanded(group.run.id, true);
    return getStreamItemMessageId(row);
  }
  const replacementRowId = presentation.readingRowReplacements.get(loadedItem.id);
  if (replacementRowId) {
    const replacementRow = displayedRows.find((row) => row.id === replacementRowId);
    if (replacementRow) {
      const group = presentation.groupsByHostId.get(replacementRow.id);
      if (group) setToolCallGroupExpanded(group.run.id, true);
      return getStreamItemMessageId(replacementRow);
    }
  }
  return getStreamItemMessageId(loadedItem);
}

async function runTeamJumpTimelineFetch(input: {
  resolvedServerId: string;
  agentId: string;
  epoch: string;
  seq: number;
  requestId: number;
  isCurrentRequest: () => boolean;
  inFlightRef: React.MutableRefObject<number | null>;
  settledRef: React.MutableRefObject<number | null>;
  onSettledSuccess: () => void;
  onError: () => void;
}): Promise<void> {
  const {
    resolvedServerId,
    agentId,
    epoch,
    seq,
    requestId,
    isCurrentRequest,
    inFlightRef,
    settledRef,
    onSettledSuccess,
    onError,
  } = input;
  inFlightRef.current = requestId;
  try {
    await getHostRuntimeStore().fetchAgentTimeline(
      resolvedServerId,
      agentId,
      planTimelinePromptJump({ epoch, seq }),
      { canApply: isCurrentRequest },
    );
    if (inFlightRef.current === requestId) inFlightRef.current = null;
    if (!isCurrentRequest()) return;
    settledRef.current = requestId;
    onSettledSuccess();
  } catch {
    if (inFlightRef.current === requestId) inFlightRef.current = null;
    if (!isCurrentRequest()) return;
    settledRef.current = requestId;
    onError();
  }
}

function useTeamMessageJumpEffect(input: {
  isActive: boolean;
  resolvedServerId: string;
  agentId: string;
  presentation: StreamPresentationResult;
  mountedMessageIds: { has: (messageId: string) => boolean };
  revealLoadedMessage: (messageId: string) => boolean;
  setToolCallGroupExpanded: (groupId: string, expanded: boolean) => void;
  scrollToBottom: () => void;
  scrollToMessage: (messageId: string, completion: StreamMessageScrollCompletion) => boolean;
  handleTimelineHistoryLoadError: () => void;
}): void {
  const {
    isActive,
    resolvedServerId,
    agentId,
    presentation,
    mountedMessageIds,
    revealLoadedMessage,
    setToolCallGroupExpanded,
    scrollToBottom,
    scrollToMessage,
    handleTimelineHistoryLoadError,
  } = input;
  const teamMessageJumpStore = useOptionalTeamMessageJumpStore();
  const pendingTeamMessageJump = usePendingTeamMessageJump(resolvedServerId, agentId);
  const inFlightJumpRequestIdRef = useRef<number | null>(null);
  const settledJumpRequestIdRef = useRef<number | null>(null);
  const [jumpFetchTick, setJumpFetchTick] = useState(0);
  const scrollAbort = useRef<AbortController | null>(null);
  const activeJumpId = pendingTeamMessageJump?.requestId;
  useEffect(
    () => () => {
      const request = scrollAbort.current;
      scrollAbort.current = null;
      request?.abort();
    },
    [isActive, activeJumpId],
  );

  useEffect(() => {
    if (!pendingTeamMessageJump || !isActive) return;
    const { requestId, itemId, messageId, epoch, seq } = pendingTeamMessageJump;

    if (!itemId && !messageId && seq === null) {
      scrollToBottom();
      teamMessageJumpStore?.acknowledgeJump(requestId);
      return;
    }

    const loadedItem = findLoadedTeamJumpItem(presentation, pendingTeamMessageJump);
    if (loadedItem) {
      if (scrollAbort.current) return;
      const loadedMessageId = getStreamItemMessageId(loadedItem);
      if (
        presentation.turns.hostIdByFoldedMessageId.has(loadedMessageId) &&
        revealLoadedMessage(loadedMessageId)
      )
        return;

      const scrollRowMessageId = resolveLoadedTeamJumpRowId(
        loadedItem,
        presentation,
        setToolCallGroupExpanded,
      );
      if (!mountedMessageIds.has(scrollRowMessageId) && revealLoadedMessage(scrollRowMessageId)) {
        return;
      }
      const request = new AbortController();
      scrollAbort.current = request;
      let retryFrame: number | undefined;
      let attempts = 0;
      const onSettled = (landed: boolean) => {
        if (request.signal.aborted || teamMessageJumpStore?.getIntent()?.requestId !== requestId)
          return;
        if (landed) teamMessageJumpStore.acknowledgeJump(requestId);
        else teamMessageJumpStore.discardJump(requestId);
      };
      function startScroll() {
        if (request.signal.aborted) return;
        if (scrollToMessage(scrollRowMessageId, { signal: request.signal, onSettled })) return;
        if (++attempts < 24) retryFrame = requestAnimationFrame(startScroll);
        else {
          handleTimelineHistoryLoadError();
          onSettled(false);
        }
      }
      request.signal.addEventListener(
        "abort",
        () => {
          if (retryFrame !== undefined) cancelAnimationFrame(retryFrame);
        },
        { once: true },
      );
      startScroll();
      return;
    }

    if (!epoch || seq === null || settledJumpRequestIdRef.current === requestId) {
      handleTimelineHistoryLoadError();
      teamMessageJumpStore?.discardJump(requestId);
      return;
    }

    if (inFlightJumpRequestIdRef.current !== requestId) {
      const isCurrentRequest = () => teamMessageJumpStore?.getIntent()?.requestId === requestId;
      void runTeamJumpTimelineFetch({
        resolvedServerId,
        agentId,
        epoch,
        seq,
        requestId,
        isCurrentRequest,
        inFlightRef: inFlightJumpRequestIdRef,
        settledRef: settledJumpRequestIdRef,
        onSettledSuccess: () => setJumpFetchTick((v) => v + 1),
        onError: () => {
          handleTimelineHistoryLoadError();
          teamMessageJumpStore?.discardJump(requestId);
        },
      });
    }
  }, [
    agentId,
    handleTimelineHistoryLoadError,
    isActive,
    jumpFetchTick,
    mountedMessageIds,
    pendingTeamMessageJump,
    presentation,
    resolvedServerId,
    revealLoadedMessage,
    scrollToBottom,
    scrollToMessage,
    setToolCallGroupExpanded,
    teamMessageJumpStore,
  ]);
}

export interface AgentStreamViewProps {
  agentId: string;
  serverId?: string;
  context: AgentScreenAgent;
  streamItems: StreamItem[];
  streamHead?: StreamItem[];
  pendingPermissions: Map<string, PendingPermission>;
  pendingMessageSubmissions?: readonly PendingMessageSubmission[];
  turnPresentation: TurnPresentation;
  routeBottomAnchorRequest?: BottomAnchorRouteRequest | null;
  isAuthoritativeHistoryReady?: boolean;
  isInitialHistoryLoading?: boolean;
  revealInitialHistory?: boolean;
  /** Tail space required by a transparent overlay rendered at the bottom edge. */
  bottomOverlayTailClearance?: number;
  /** Bottom offset required for controls floating above that overlay. */
  bottomOverlayControlClearance?: number;
  toast?: ToastApi | null;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
  readOnly?: boolean;
  canSubmitSelection?: (agentId: string, workspaceId: string) => boolean;
  /** Detail panes opt into the complete interaction transcript. */
  showAgentInteractions?: boolean;
  historyPagination?: {
    hasOlder: boolean;
    isLoadingOlder: boolean;
    progressKey: string | null;
    onLoadOlder: () => boolean | Promise<boolean>;
  };
}

const AGENT_CAPABILITY_FLAG_KEYS: (keyof AgentCapabilityFlags)[] = [
  "supportsStreaming",
  "supportsSessionPersistence",
  "supportsDynamicModes",
  "supportsMcpServers",
  "supportsReasoningStream",
  "supportsToolInvocations",
  "supportsRewindConversation",
  "supportsRewindFiles",
  "supportsRewindBoth",
];

const EMPTY_STREAM_HEAD: StreamItem[] = [];

function useRetainedValue<T>(value: T, active: boolean): T {
  const retainedRef = useRef(value);
  if (active) {
    retainedRef.current = value;
  }
  return active ? value : retainedRef.current;
}
const EMPTY_PENDING_MESSAGE_SUBMISSIONS: readonly PendingMessageSubmission[] = [];
const GROUPED_TOOL_CALL_DETAIL_MAX_HEIGHT = 200;

function resolveBottomOverlayControlOffset(clearance: number | undefined): number {
  return Math.max(16, clearance ?? 0);
}

// Keep entry/exit animations off on Android due to RN dispatchDraw crashes
// tracked in react-native-reanimated#8422.
const shouldDisableEntryExitAnimations = Platform.OS === "android";
const scrollIndicatorFadeIn = shouldDisableEntryExitAnimations ? undefined : FadeIn.duration(200);
const scrollIndicatorFadeOut = shouldDisableEntryExitAnimations ? undefined : FadeOut.duration(200);

function ScrollToBottomButton({
  nearBottom,
  isTimelineDetached,
  bottomOffset,
  onPress,
}: {
  nearBottom: NearBottom;
  isTimelineDetached: boolean;
  bottomOffset: number;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const isNearBottom = useIsNearBottom(nearBottom);
  const containerStyle = useMemo(
    () => [stylesheet.scrollToBottomContainer, { bottom: bottomOffset }],
    [bottomOffset],
  );
  if (isNearBottom && !isTimelineDetached) return null;
  return (
    <View style={containerStyle} dataSet={CHAT_COLUMN_RAIL_DATASET} pointerEvents="box-none">
      <Animated.View entering={scrollIndicatorFadeIn} exiting={scrollIndicatorFadeOut}>
        <Pressable
          style={stylesheet.scrollToBottomButton}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={t("agentStream.scrollToBottom")}
          testID="scroll-to-bottom-button"
        >
          <ChevronDown size={24} color={stylesheet.scrollToBottomIcon.color} />
        </Pressable>
      </Animated.View>
    </View>
  );
}

function useStreamSubagentActions({
  serverId,
  agentId,
  context,
  toast,
  readOnly,
  selectionBoundary,
}: {
  serverId: string;
  agentId: string;
  context: AgentScreenAgent;
  toast?: ToastApi | null;
  readOnly: boolean;
  selectionBoundary: Omit<Parameters<typeof resolveSelectionForkBoundary>[0], "messageRowId">;
}) {
  const { t } = useTranslation();
  const forkAgent = useForkAgent({ serverId, toast, readOnly });
  const tabId = useOptionalPaneContext()?.tabId;
  const sourceAgentLabels = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return session?.agents.get(agentId)?.labels ?? session?.agentDetails.get(agentId)?.labels;
  });
  const spawnTarget = useSessionStore(
    useShallow((state) => {
      if (readOnly || !context.workspaceId || !context.provider) return null;
      const session = state.sessions[serverId];
      return resolveSubagentSpawnTarget({
        agentId,
        serverId,
        features: session?.serverInfo?.features,
        getAgent: (id) => session?.agents.get(id) ?? session?.agentDetails.get(id),
      });
    }),
  );
  const handleForkAssistantTurn: AssistantTurnForkHandler = useStableEvent(
    async ({ target, boundary }) => {
      if (target === "subagent" && !spawnTarget) return;
      await forkAgent({
        agentId,
        agent: { ...context, labels: sourceAgentLabels },
        workspaceId: context.workspaceId,
        parentTabId: tabId,
        target,
        ...(target === "subagent" && spawnTarget
          ? { parentAgentId: spawnTarget.parentAgentId }
          : {}),
        boundary,
      });
    },
  );

  // The in-flight turn forks with no boundary at all: `selectForkContextRows`
  // projects the whole timeline when neither boundary field is given, so the
  // fork carries everything up to now, including the response still streaming
  // in front of the user.
  const handleForkInFlightTurn: InFlightTurnForkHandler = useStableEvent(async (target) => {
    if (target === "subagent" && !spawnTarget) return;
    await forkAgent({
      agentId,
      agent: { ...context, labels: sourceAgentLabels },
      workspaceId: context.workspaceId,
      parentTabId: tabId,
      target,
      ...(target === "subagent" && spawnTarget ? { parentAgentId: spawnTarget.parentAgentId } : {}),
    });
  });
  const handleSpawnSubagentFromSelection = useStableEvent(
    (selectedMarkdown: string, selectionContext?: SelectionSubagentSpawnContext) => {
      if (!spawnTarget || !context.workspaceId) return;
      const boundary = resolveSelectionForkBoundary({
        ...selectionBoundary,
        messageRowId: selectionContext?.messageRowId,
      });
      if (boundary === null) {
        toast?.error(
          t("agentStream.quote.reselectToFork", {
            defaultValue: "The selected reply is unavailable. Select the text again to fork.",
          }),
        );
        return;
      }
      void forkAgent({
        agentId,
        agent: { ...context, labels: sourceAgentLabels },
        workspaceId: context.workspaceId,
        parentTabId: tabId,
        target: "subagent",
        parentAgentId: spawnTarget.parentAgentId,
        quoteText: selectedMarkdown,
        boundary,
      });
    },
  );
  return {
    spawnTarget,
    handleForkAssistantTurn,
    handleForkInFlightTurn,
    onSpawnSubagentFromSelection: spawnTarget ? handleSpawnSubagentFromSelection : undefined,
  };
}

interface StreamExpansionProvidersProps {
  toolCallExpansion: ReturnType<typeof useAgentToolCallExpansion>;
  userMessageExpansion: ReturnType<typeof useAgentUserMessageExpansion>;
  assistantMessageExpansion: ReturnType<typeof useAgentAssistantMessageExpansion>;
  unreadSourceGroupId: string | null;
  children: ReactNode;
}

function StreamExpansionProviders({
  toolCallExpansion,
  userMessageExpansion,
  assistantMessageExpansion,
  unreadSourceGroupId,
  children,
}: StreamExpansionProvidersProps) {
  return (
    <ToolCallExpansionContext.Provider value={toolCallExpansion}>
      <UserMessageExpansionContext.Provider value={userMessageExpansion}>
        <AssistantMessageExpansionContext.Provider value={assistantMessageExpansion}>
          <UnreadAgentSourceContext.Provider value={unreadSourceGroupId}>
            {children}
          </UnreadAgentSourceContext.Provider>
        </AssistantMessageExpansionContext.Provider>
      </UserMessageExpansionContext.Provider>
    </ToolCallExpansionContext.Provider>
  );
}

function renderChatOutlineRail(outlineInset: number, outline: ReturnType<typeof useChatOutline>) {
  if (outlineInset <= 0 || outline.prompts.length < 2) return null;
  return (
    <ChatOutlineRail
      prompts={outline.prompts}
      activePrompt={outline.activePrompt}
      onJumpToPrompt={outline.jumpToPrompt}
    />
  );
}

function createActivePromptBarSlots(props: ComponentProps<typeof ActivePromptBar>) {
  const bar = <ActivePromptBar {...props} />;
  // Web mounts beside the find widget. Native mounts inside the transcript's own viewport.
  return isWeb ? { web: bar, native: null } : { web: null, native: bar };
}

const AgentStreamViewComponent = forwardRef<AgentStreamViewHandle, AgentStreamViewProps>(
  function AgentStreamView(
    {
      agentId,
      serverId,
      context,
      streamItems,
      streamHead: providedStreamHead,
      pendingPermissions,
      pendingMessageSubmissions = EMPTY_PENDING_MESSAGE_SUBMISSIONS,
      turnPresentation,
      routeBottomAnchorRequest = null,
      isAuthoritativeHistoryReady = true,
      isInitialHistoryLoading,
      revealInitialHistory,
      bottomOverlayTailClearance = 0,
      bottomOverlayControlClearance,
      toast,
      onOpenWorkspaceFile,
      readOnly = false,
      canSubmitSelection,
      showAgentInteractions: showAgentInteractionsOverride,
      historyPagination,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const autoExpandReasoning = useSettings((settings) => settings.autoExpandReasoning);
    const configuredShowAgentInteractions = useSettings(
      (settings) => settings.showAgentInteractions,
    );
    const showAgentInteractions = showAgentInteractionsOverride ?? configuredShowAgentInteractions;
    const chatDisplay = useSettings((settings) => settings.chatDisplay);
    const contentMaxWidth = useSettings(resolveContentMaxWidth);
    const viewportRef = useRef<StreamViewportHandle | null>(null);
    const pendingClientMessageIds = useMemo(
      () => new Set(pendingMessageSubmissions.map((submission) => submission.clientMessageId)),
      [pendingMessageSubmissions],
    );
    const isMobile = useIsCompactFormFactor();
    const streamRenderStrategy = useMemo(
      () =>
        resolveStreamRenderStrategy({
          platform: Platform.OS,
          isMobileBreakpoint: isMobile,
        }),
      [isMobile],
    );
    const nearBottom = useNearBottom(agentId);
    const [expandedInlineToolCallIds, setExpandedInlineToolCallIds] = useState<Set<string>>(
      new Set(),
    );
    const toolCallExpansion = useAgentToolCallExpansion(agentId);
    const userMessageExpansion = useAgentUserMessageExpansion(agentId);
    const assistantMessageExpansion = useAgentAssistantMessageExpansion(agentId);
    const expandedToolCallGroups = useExpandedToolCallGroups(toolCallExpansion);
    const [expandedTurnHostIds, setExpandedTurnHostIds] = useState<ReadonlySet<string>>(new Set());

    // Get serverId (fallback to agent's serverId if not provided)
    const resolvedServerId = serverId ?? context.serverId ?? "";
    const transformTimelineItem = useInstalledTimelineTransform(resolvedServerId);

    const client = useSessionStore((state) => state.sessions[resolvedServerId]?.client ?? null);
    const sessionStreamHead = useSessionStore((state) =>
      state.sessions[resolvedServerId]?.agentStreamHead?.get(agentId),
    );
    const streamHead = providedStreamHead ?? sessionStreamHead;
    const supportsAgentForkContextCursor = useSessionStore(
      (state) =>
        state.sessions[resolvedServerId]?.serverInfo?.features?.agentForkContextCursor === true,
    );
    const timelineEpoch = useSessionStore(
      (state) => state.sessions[resolvedServerId]?.agentTimelineCursor.get(agentId)?.epoch ?? null,
    );
    const hasUnreadFinished = useSessionStore((state) => {
      const session = state.sessions[resolvedServerId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      return agent?.requiresAttention === true && agent.attentionReason === "finished";
    });
    const isTimelineDetached = useSessionStore(
      (state) => state.sessions[resolvedServerId]?.agentTimelineHasNewer.get(agentId) === true,
    );

    const workspaceRoot = context.cwd?.trim() || "";
    const { revealDirectory } = useFileExplorerActions({
      serverId: resolvedServerId,
      workspaceId: context.workspaceId,
      workspaceRoot,
    });
    const agentHistoryPagination = useLoadOlderAgentHistory({
      serverId: resolvedServerId,
      agentId,
      toast,
    });
    const {
      isLoadingOlder: remoteIsLoadingOlder,
      hasOlder: remoteHasOlder,
      progressKey: remoteProgressKey,
      loadOlder: loadRemoteOlder,
    } = historyPagination
      ? {
          isLoadingOlder: historyPagination.isLoadingOlder,
          hasOlder: historyPagination.hasOlder,
          progressKey: historyPagination.progressKey,
          loadOlder: historyPagination.onLoadOlder,
        }
      : agentHistoryPagination;

    const isActive = useRetainedPanelActive();
    const openInlineFile = useStableEvent(
      (location: WorkspaceFileLocation, disposition: OpenFileDisposition) => {
        if (onOpenWorkspaceFile) {
          onOpenWorkspaceFile({ location, disposition });
        } else if (context.workspaceId) {
          navigateToWorkspace({
            serverId: resolvedServerId,
            workspaceId: context.workspaceId,
            target: createWorkspaceFileTabTarget(location),
          });
        }
      },
    );
    const openInlineDirectory = useStableEvent((directoryPath: string) => {
      void revealDirectory(directoryPath);
      openExplorerSidebarView({
        isCompact: isMobile,
        workspaceKey: buildWorkspaceTabPersistenceKey({
          serverId: resolvedServerId,
          workspaceId: context.workspaceId ?? "",
        }),
        view: "files",
      });
    });
    const openInlineOutsideDirectory = useOpenOutsideWorkspaceFolder(resolvedServerId);
    const inlinePathOpener = useMemo(
      () =>
        createInlinePathOpener({
          workspaceRoot,
          resolveRelativeFiles: true,
          client,
          openFile: openInlineFile,
          openDirectory: openInlineDirectory,
          openOutsideDirectory: openInlineOutsideDirectory,
        }),
      [workspaceRoot, client, openInlineFile, openInlineDirectory, openInlineOutsideDirectory],
    );
    useEffect(() => {
      if (!isActive) inlinePathOpener.cancel();
      return () => inlinePathOpener.cancel();
    }, [inlinePathOpener, isActive]);
    const handleInlinePathPress = useStableEvent(
      (target: InlinePathTarget, disposition: OpenFileDisposition) => {
        if (isActive) void inlinePathOpener.open(target, disposition);
      },
    );

    const handleToolCallOpenFile = useStableEvent((filePath: string) => {
      handleInlinePathPress({ raw: filePath, path: filePath }, "preferred");
    });

    // Freeze stream presentation while this tab slot is hidden to prevent offscreen
    // cell-window and turn-lifecycle renders from background agents.
    // When isActive flips back to true, the context change triggers a re-render and
    // the component reads the current (fresh) streamItems/streamHead from props.
    const effectiveStreamItems = useRetainedValue(streamItems, isActive);
    const effectiveStreamHead = useRetainedValue(streamHead, isActive);
    const effectiveTurnPresentation = useRetainedValue(turnPresentation, isActive);
    const isTurnActive = effectiveTurnPresentation.isActive;
    const presentStream = useMemo(() => createStreamPresentation(), []);
    const presentation = useMemo(
      () =>
        presentStream({
          tail: effectiveStreamItems,
          head: effectiveStreamHead ?? EMPTY_STREAM_HEAD,
          transform: transformTimelineItem,
          display: chatDisplay,
          autoExpandReasoning,
          expandedTurnHostIds,
          isTurnActive,
          activeTurnId: effectiveTurnPresentation.turnId,
          showAgentInteractions,
        }),
      [
        presentStream,
        effectiveStreamItems,
        effectiveStreamHead,
        transformTimelineItem,
        chatDisplay,
        autoExpandReasoning,
        expandedTurnHostIds,
        isTurnActive,
        effectiveTurnPresentation.turnId,
        showAgentInteractions,
      ],
    );
    const unreadSourceGroupId = useMemo(
      () =>
        hasUnreadFinished && !isTimelineDetached
          ? findLatestAgentSourceGroupId(presentation.head, presentation.tail)
          : null,
      [hasUnreadFinished, isTimelineDetached, presentation.head, presentation.tail],
    );
    const {
      start: historyWindowStart,
      hasLocalHistory,
      revealLoadedHistory,
      loadOlder,
    } = useStreamHistoryWindow({
      items: presentation.tail,
      loadRemoteOlder,
    });
    const isLoadingOlder = remoteIsLoadingOlder;
    const hasOlder = hasLocalHistory || remoteHasOlder;
    const progressKey = `${remoteProgressKey ?? "local"}:${historyWindowStart}`;

    const baseRenderModel = useMemo(() => {
      return buildAgentStreamRenderModel({
        isTurnActive,
        activeTurnStartedAt: effectiveTurnPresentation.startedAt,
        tail: presentation.tail,
        head: presentation.head,
        platform: isWeb ? "web" : "native",
        isMobileBreakpoint: isMobile,
        historyStart: historyWindowStart,
      });
    }, [
      isMobile,
      isTurnActive,
      presentation.head,
      presentation.tail,
      effectiveTurnPresentation.startedAt,
      historyWindowStart,
    ]);
    const streamLayout = useMemo(
      () =>
        layoutStream({
          strategy: streamRenderStrategy,
          isTurnActive,
          history: baseRenderModel.history,
          liveHead: baseRenderModel.segments.liveHead,
          timingByItemId: baseRenderModel.turnTiming.byItemId,
        }),
      [
        baseRenderModel.history,
        baseRenderModel.segments.liveHead,
        baseRenderModel.turnTiming.byItemId,
        isTurnActive,
        streamRenderStrategy,
      ],
    );
    const handleTimelineHistoryLoadError = useCallback(() => {
      toast?.error(t("agentStream.historyLoadFailed"));
    }, [t, toast]);
    // Chat find and the chat outline address messages, and an assistant message is a
    // group of block rows, so these hold message ids and never row ids. Only the head
    // changes per streamed delta, so the history set is keyed on mounted history alone.
    const mountedHistoryMessageIds = useMemo(
      () => new Set(baseRenderModel.history.map(getStreamItemMessageId)),
      [baseRenderModel.history],
    );
    const mountedMessageIds = useMemo(() => {
      const liveHeadMessageIds = new Set(
        baseRenderModel.segments.liveHead.map(getStreamItemMessageId),
      );
      return {
        has: (messageId: string) =>
          mountedHistoryMessageIds.has(messageId) || liveHeadMessageIds.has(messageId),
      };
    }, [baseRenderModel.segments.liveHead, mountedHistoryMessageIds]);
    const outlineRail = useChatOutlineRail();
    const supportsPromptIndex = useSessionStore(
      (state) =>
        state.sessions[resolvedServerId]?.serverInfo?.features?.agentTimelinePromptIndex === true,
    );
    const outlineTrackingEnabled = shouldTrackChatOutline({
      isNative,
      railEnabled: outlineRail.enabled,
      supportsPromptIndex,
    });
    const outlineInset = outlineRail.inset;
    const chatOutline = useChatOutline({
      agentId,
      serverId: resolvedServerId,
      timelineEpoch,
      tail: presentation.sourceTail,
      head: presentation.sourceHead,
      enabled: outlineTrackingEnabled,
      viewportRef,
      onJumpError: handleTimelineHistoryLoadError,
      mountedHistoryMessageIds,
      revealLoadedMessage: revealLoadedHistory,
    });

    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom(reason = "jump-to-bottom") {
          viewportRef.current?.scrollToBottom(reason);
        },
        prepareForViewportChange() {
          viewportRef.current?.prepareForViewportChange();
        },
      }),
      [],
    );

    const scrollToBottom = useCallback(() => {
      if (!isTimelineDetached) {
        viewportRef.current?.scrollToBottom("jump-to-bottom");
        return;
      }
      void returnToTimelineTail({
        fetchTail: () =>
          getHostRuntimeStore().fetchAgentTimeline(resolvedServerId, agentId, {
            ...planTimelineTailFetch(),
          }),
        scrollToBottom: () => viewportRef.current?.scrollToBottom("jump-to-bottom"),
        onError: handleTimelineHistoryLoadError,
      });
    }, [agentId, handleTimelineHistoryLoadError, isTimelineDetached, resolvedServerId]);

    const setInlineDetailsExpanded = useCallback(
      (itemId: string, expanded: boolean) => {
        if (!streamRenderStrategy.shouldDisableParentScrollOnInlineDetailsExpansion()) {
          return;
        }
        setExpandedInlineToolCallIds((previous) => {
          const next = new Set(previous);
          if (expanded) {
            next.add(itemId);
          } else {
            next.delete(itemId);
          }
          return next;
        });
      },
      [streamRenderStrategy],
    );

    // The summary line holds its row around this; chat find opens a turn without a hold.
    const setTurnExpanded = useCallback((hostId: string, expanded: boolean) => {
      setExpandedTurnHostIds((previous) => {
        if (previous.has(hostId) === expanded) return previous;
        const next = new Set(previous);
        if (expanded) {
          next.add(hostId);
        } else {
          next.delete(hostId);
        }
        return next;
      });
    }, []);
    // Chat find reveals a match inside a collapsed turn by opening the turn first.
    const revealLoadedMessage = useStableEvent((messageId: string): boolean => {
      const hostId = presentation.turns.hostIdByFoldedMessageId.get(messageId);
      if (hostId && presentation.turns.summaryRowsByHostId.get(hostId)?.expanded === false) {
        setTurnExpanded(hostId, true);
        return true;
      }
      return revealLoadedHistory(messageId);
    });
    // Read through a stable event so a collapse rerun does not change the renderer identity;
    // nested rows are revised through `historyRowRevision`.
    const getTurnIndent = useStableEvent((layoutItem: StreamLayoutItem): TurnIndent => {
      const { nestedItemIds } = presentation.turns;
      const { item } = layoutItem;
      if (nestedItemIds.has(item.id)) {
        const below = layoutItem.belowItem;
        return below && nestedItemIds.has(below.id) ? "nested" : "lastNested";
      }
      return item.kind === "turn_summary" && item.expanded ? "openedHost" : "none";
    });

    const setToolCallGroupExpanded = toolCallExpansion.setGroupExpanded;
    const scrollViewportToMessage = useStableEvent(
      (messageId: string, completion: StreamMessageScrollCompletion) =>
        viewportRef.current?.scrollToMessage?.(messageId, undefined, completion) === true,
    );
    useTeamMessageJumpEffect({
      isActive,
      resolvedServerId,
      agentId,
      presentation,
      mountedMessageIds,
      revealLoadedMessage,
      setToolCallGroupExpanded,
      scrollToBottom,
      scrollToMessage: scrollViewportToMessage,
      handleTimelineHistoryLoadError,
    });

    const renderUserMessageItem = useCallback(
      (layoutItem: StreamLayoutItem, item: Extract<StreamItem, { kind: "user_message" }>) => {
        const sourcePresentation = getAgentSourcePresentation(item);
        const { nestedItemIds } = presentation.turns;
        if (sourcePresentation || item.sender) {
          return (
            <View
              style={stylesheet.subagentReportCard}
              testID={`timeline-subagent-report-${item.id}`}
            >
              {sourcePresentation?.isGroupStart && !nestedItemIds.has(item.id) ? (
                <AgentSourceHeader
                  group={sourcePresentation.group}
                  fallbackServerId={resolvedServerId}
                  mainAgentId={agentId}
                  workspaceId={context.workspaceId ?? undefined}
                />
              ) : null}
              <Text style={stylesheet.subagentReportText}>{item.text}</Text>
            </View>
          );
        }
        return (
          <UserMessage
            itemId={item.id}
            serverId={resolvedServerId}
            agentId={agentId}
            messageId={item.messageId}
            message={item.text}
            sender={item.sender}
            images={item.images}
            attachments={item.attachments}
            timestamp={item.timestamp.getTime()}
            capabilities={context.capabilities}
            client={client}
            isFirstInGroup={layoutItem.isFirstInUserGroup}
            isLastInGroup={layoutItem.isLastInUserGroup}
            isPending={
              item.clientMessageId !== undefined &&
              pendingClientMessageIds.has(item.clientMessageId)
            }
          />
        );
      },
      [
        context.capabilities,
        context.workspaceId,
        agentId,
        client,
        pendingClientMessageIds,
        presentation.turns.nestedItemIds,
        resolvedServerId,
      ],
    );

    const renderAssistantMessageItem = useCallback(
      (layoutItem: StreamLayoutItem, item: Extract<StreamItem, { kind: "assistant_message" }>) => {
        return (
          <AssistantFileLinkResolverProvider
            client={client}
            serverId={resolvedServerId}
            workspaceRoot={workspaceRoot}
            onOpenWorkspaceFile={handleInlinePathPress}
            toast={toast}
          >
            <ChatFindExpansion messageId={getStreamItemMessageId(item)}>
              {(renderFullContent) => (
                <AssistantMessage
                  itemId={item.id}
                  renderFullContent={renderFullContent}
                  occurrenceKey={createAssistantImageOccurrenceKey({ agentId, itemId: item.id })}
                  message={item.text}
                  timestamp={item.timestamp.getTime()}
                  workspaceRoot={workspaceRoot}
                  serverId={resolvedServerId}
                  client={client}
                  spacing={layoutItem.assistantSpacing}
                  phase={layoutItem.phase}
                />
              )}
            </ChatFindExpansion>
          </AssistantFileLinkResolverProvider>
        );
      },
      [agentId, client, handleInlinePathPress, resolvedServerId, toast, workspaceRoot],
    );

    const renderThoughtItem = useCallback(
      (layoutItem: StreamLayoutItem, item: Extract<StreamItem, { kind: "thought" }>) => {
        return (
          <ThoughtSlot
            itemId={item.id}
            onInlineDetailsExpandedChangeByItemId={setInlineDetailsExpanded}
            text={item.text}
            status={item.status}
            isLastInSequence={layoutItem.isLastInToolSequence}
            defaultExpanded={autoExpandReasoning}
          />
        );
      },
      [autoExpandReasoning, setInlineDetailsExpanded],
    );

    const renderSingleToolCallItem = useCallback(
      (
        item: Extract<StreamItem, { kind: "tool_call" }>,
        isLastInSequence: boolean,
        options: { maxDetailHeight?: number; standalone?: boolean } = {},
      ) => {
        const { payload } = item;

        if (payload.source === "agent") {
          const data = payload.data;

          if (
            data.name === "speak" &&
            data.detail.type === "unknown" &&
            typeof data.detail.input === "string" &&
            data.detail.input.trim()
          ) {
            return (
              <SpeakMessage message={data.detail.input} timestamp={item.timestamp.getTime()} />
            );
          }

          return (
            <ToolCallSlot
              itemId={item.id}
              onInlineDetailsExpandedChangeByItemId={setInlineDetailsExpanded}
              toolName={data.name}
              error={data.error}
              status={data.status}
              detail={data.detail}
              cwd={context.cwd}
              serverId={resolvedServerId}
              metadata={data.metadata}
              agentMessage={data.agentMessage}
              isLastInSequence={isLastInSequence}
              onOpenFilePath={handleToolCallOpenFile}
              standalone={options.standalone}
              maxDetailHeight={options.maxDetailHeight}
            />
          );
        }

        const data = payload.data;
        return (
          <ToolCallSlot
            itemId={item.id}
            onInlineDetailsExpandedChangeByItemId={setInlineDetailsExpanded}
            toolName={data.toolName}
            args={data.arguments}
            result={data.result}
            status={data.status}
            isLastInSequence={isLastInSequence}
            onOpenFilePath={handleToolCallOpenFile}
            standalone={options.standalone}
            maxDetailHeight={options.maxDetailHeight}
          />
        );
      },
      [context.cwd, resolvedServerId, setInlineDetailsExpanded, handleToolCallOpenFile],
    );

    // Read through a stable event so live group updates do not change the renderer identity
    // every tick; history hosts whose group changed are revised through `historyRowRevision`.
    const getToolCallGroup = useStableEvent((hostId: string) =>
      presentation.groupsByHostId.get(hostId),
    );
    const renderToolCallItem = useCallback(
      (
        layoutItem: StreamLayoutItem,
        item: Extract<StreamItem, { kind: "tool_call" | "thought" }>,
      ) => {
        const group = getToolCallGroup(item.id);
        if (!group) {
          return item.kind === "thought"
            ? renderThoughtItem(layoutItem, item)
            : renderSingleToolCallItem(item, layoutItem.isLastInToolSequence);
        }
        const expanded = expandedToolCallGroups.has(group.run.id);
        return (
          <OverviewToolCallGroupView
            group={group}
            expanded={expanded}
            isLastInSequence={layoutItem.isLastInToolSequence}
            onExpandedChange={setToolCallGroupExpanded}
          >
            {expanded
              ? group.run.calls.map((call, index) => (
                  <React.Fragment key={call.id}>
                    {call.kind === "thought" ? (
                      // Reasoning is grouped only while Expand thinking is off, so an opened
                      // group shows each thought as a closed row like any other call.
                      <ThoughtSlot
                        itemId={call.id}
                        text={call.text}
                        status={call.status}
                        isLastInSequence={index === group.run.calls.length - 1}
                        defaultExpanded={false}
                        maxDetailHeight={GROUPED_TOOL_CALL_DETAIL_MAX_HEIGHT}
                        standalone={false}
                        onInlineDetailsExpandedChangeByItemId={setInlineDetailsExpanded}
                      />
                    ) : (
                      renderSingleToolCallItem(call, index === group.run.calls.length - 1, {
                        maxDetailHeight: GROUPED_TOOL_CALL_DETAIL_MAX_HEIGHT,
                        standalone: false,
                      })
                    )}
                  </React.Fragment>
                ))
              : null}
          </OverviewToolCallGroupView>
        );
      },
      [
        expandedToolCallGroups,
        renderThoughtItem,
        setInlineDetailsExpanded,
        getToolCallGroup,
        renderSingleToolCallItem,
        setToolCallGroupExpanded,
      ],
    );

    const renderStreamItemContent = useCallback(
      (item: StreamItem, layoutItem: StreamLayoutItem) => {
        switch (item.kind) {
          case "user_message":
            return renderUserMessageItem(layoutItem, item);

          case "assistant_message":
            return renderAssistantMessageItem(layoutItem, item);

          case "thought":
            return renderToolCallItem(layoutItem, item);

          case "tool_call":
            return renderToolCallItem(layoutItem, item);

          case "turn_summary":
            return (
              <TurnSummaryLine
                item={item}
                serverId={resolvedServerId}
                onExpandedChange={setTurnExpanded}
              />
            );

          case "notification":
            return <Notification level={item.level} message={item.message} />;

          case "todo_list":
            return <TodoListCard items={item.items} activity={item.activity} />;

          case "compaction":
            return (
              <CompactionMarker
                status={item.status}
                trigger={item.trigger}
                preTokens={item.preTokens}
              />
            );

          case "plugin":
            return (
              <PluginTimelineItemView agentId={agentId} item={item} serverId={resolvedServerId} />
            );

          default:
            return null;
        }
      },
      [
        agentId,
        renderUserMessageItem,
        renderAssistantMessageItem,
        renderToolCallItem,
        setTurnExpanded,
        resolvedServerId,
      ],
    );

    const layoutHistoryItemById = useMemo(() => {
      const itemById = new Map<string, StreamLayoutItem>();
      for (const item of streamLayout.history) {
        itemById.set(item.item.id, item);
      }
      return itemById;
    }, [streamLayout.history]);

    const layoutLiveHeadItemById = useMemo(() => {
      const itemById = new Map<string, StreamLayoutItem>();
      for (const item of streamLayout.liveHead) {
        itemById.set(item.item.id, item);
      }
      return itemById;
    }, [streamLayout.liveHead]);

    const resolveQuoteTopicByRowId = useStableEvent((rowId: string) =>
      getAssistantQuoteTopic(
        (layoutHistoryItemById.get(rowId) ?? layoutLiveHeadItemById.get(rowId))?.item,
      ),
    );
    const webSelectionProps = { resolveQuoteTopicByRowId };

    const {
      spawnTarget,
      handleForkAssistantTurn,
      handleForkInFlightTurn,
      onSpawnSubagentFromSelection,
    } = useStreamSubagentActions({
      serverId: resolvedServerId,
      agentId,
      context,
      toast,
      readOnly,
      selectionBoundary: {
        isTurnActive,
        historyItemById: layoutHistoryItemById,
        liveHeadItemById: layoutLiveHeadItemById,
        supportsTimelineCursor: supportsAgentForkContextCursor,
      },
    });
    const allowSubagentFork = spawnTarget?.mode ?? false;
    const bottomTurnFooterHost = streamLayout.auxiliaryTurnFooter;

    const renderStreamItem = useCallback<RenderStreamItem>(
      (item, layoutItem) => {
        const content = renderStreamItemContent(item, layoutItem);
        return renderStreamItemWithTurnFooter({
          content,
          layoutItem,
          turnIndent: getTurnIndent(layoutItem),
          strategy: streamRenderStrategy,
          supportsTimelineCursor: supportsAgentForkContextCursor,
          onForkAssistantTurn: readOnly ? undefined : handleForkAssistantTurn,
        });
      },
      [
        getTurnIndent,
        handleForkAssistantTurn,
        readOnly,
        renderStreamItemContent,
        streamRenderStrategy,
        supportsAgentForkContextCursor,
      ],
    );

    const pendingPermissionItems = useMemo(
      () => Array.from(pendingPermissions.values()).filter((perm) => perm.agentId === agentId),
      [pendingPermissions, agentId],
    );

    const pendingPermissionsNode = useMemo(
      () =>
        renderPendingPermissionsNode({
          pendingPermissions: pendingPermissionItems,
          client,
        }),
      [client, pendingPermissionItems],
    );
    const turnFooterNode = useMemo(
      () =>
        isTurnActive || bottomTurnFooterHost ? (
          <TurnFooter
            isRunning={isTurnActive}
            inFlightTurnStartedAt={baseRenderModel.turnTiming.runningStartedAt}
            host={bottomTurnFooterHost}
            strategy={streamRenderStrategy}
            supportsTimelineCursor={supportsAgentForkContextCursor}
            onForkAssistantTurn={readOnly ? undefined : handleForkAssistantTurn}
            onForkInFlightTurn={readOnly ? undefined : handleForkInFlightTurn}
          />
        ) : null,
      [
        handleForkAssistantTurn,
        handleForkInFlightTurn,
        readOnly,
        isTurnActive,
        baseRenderModel.turnTiming.runningStartedAt,
        bottomTurnFooterHost,
        streamRenderStrategy,
        supportsAgentForkContextCursor,
      ],
    );
    const renderModel = useMemo<AgentStreamRenderModel>(() => {
      return {
        ...baseRenderModel,
        boundary: baseRenderModel.boundary,
        auxiliary: {
          pendingPermissions: pendingPermissionsNode,
          turnFooter: turnFooterNode,
        },
      };
    }, [baseRenderModel, pendingPermissionsNode, turnFooterNode]);

    const emptyStateStyle = useMemo(() => [stylesheet.emptyState, stylesheet.contentWrapper], []);
    const scrollToBottomOffset = resolveBottomOverlayControlOffset(bottomOverlayControlClearance);
    const listEmptyComponent = useMemo(
      () =>
        renderListEmptyComponent({
          renderModel,
          emptyStateStyle,
          emptyText: t("agentStream.empty"),
        }),
      [renderModel, emptyStateStyle, t],
    );

    const { boundary, auxiliary } = renderModel;

    const handleReadingPositionChange = useStableEvent((rowId: string | null) => {
      const row =
        rowId === null
          ? undefined
          : (layoutHistoryItemById.get(rowId) ?? layoutLiveHeadItemById.get(rowId));
      chatOutline.reportReadingPosition(
        row?.item.timelineCursor?.seq ?? null,
        row?.item.kind === "user_message",
      );
    });

    const renderHistoryRow = useCallback(
      (item: StreamItem) =>
        renderStreamRow({
          item,
          layoutItemById: layoutHistoryItemById,
          renderStreamItem,
          viewportRef,
        }),
      [layoutHistoryItemById, renderStreamItem],
    );

    const renderHistoryVirtualizedRow = useCallback<
      StreamSegmentRenderers["renderHistoryVirtualizedRow"]
    >((item) => renderHistoryRow(item), [renderHistoryRow]);
    const renderHistoryMountedRow = useCallback<StreamSegmentRenderers["renderHistoryMountedRow"]>(
      (item) => renderHistoryRow(item),
      [renderHistoryRow],
    );
    // useStableEvent keeps the function reference stable across flushes.
    // layoutLiveHeadItemById and renderStreamItem are read from the ref at call time,
    // so the live-head render always uses the latest layout without causing renderers
    // to be a new object on every text-chunk flush.
    const renderLiveHeadRow: StreamSegmentRenderers["renderLiveHeadRow"] = useStableEvent(
      (item: StreamItem) =>
        renderStreamRow({
          item,
          layoutItemById: layoutLiveHeadItemById,
          renderStreamItem,
          viewportRef,
        }),
    );
    const renderLiveAuxiliary = useCallback<StreamSegmentRenderers["renderLiveAuxiliary"]>(() => {
      const existingTailSpacing =
        auxiliary.turnFooter && !auxiliary.pendingPermissions ? TURN_FOOTER_BOTTOM_SPACING : 0;
      const bottomOverlayInset = resolveBottomOverlayTailInset({
        requiredTailClearance: bottomOverlayTailClearance,
        existingTailSpacing,
      });
      return renderLiveAuxiliaryNode({
        pendingPermissions: auxiliary.pendingPermissions,
        turnFooter: auxiliary.turnFooter,
        bottomOverlayInset,
      });
    }, [auxiliary.pendingPermissions, auxiliary.turnFooter, bottomOverlayTailClearance]);

    const renderers = useMemo<StreamSegmentRenderers>(
      () => ({
        renderHistoryVirtualizedRow,
        renderHistoryMountedRow,
        renderLiveHeadRow,
        renderLiveAuxiliary,
      }),
      [
        renderHistoryVirtualizedRow,
        renderHistoryMountedRow,
        renderLiveHeadRow,
        renderLiveAuxiliary,
      ],
    );

    const streamScrollEnabled =
      !streamRenderStrategy.shouldDisableParentScrollOnInlineDetailsExpansion() ||
      expandedInlineToolCallIds.size === 0;
    const { nestedItemIds } = presentation.turns;
    const historyRowRevision = useMemo(
      () => ({
        contentById: {
          has: (id: string) => presentation.historyGroupUpdatesByHostId.has(id),
        },
        displayStateById: {
          // An opened lone call also marks its future group open; that row stays unrevised
          // until a group actually forms there.
          has: (id: string) =>
            (expandedToolCallGroups.has(id) && getToolCallGroup(id) !== undefined) ||
            nestedItemIds.has(id),
        },
        globalDisplayState: isMobile,
      }),
      [
        expandedToolCallGroups,
        getToolCallGroup,
        isMobile,
        nestedItemIds,
        presentation.historyGroupUpdatesByHostId,
      ],
    );

    const findItems = useMemo(
      () => [...presentation.sourceTail, ...presentation.sourceHead],
      [presentation.sourceHead, presentation.sourceTail],
    );
    const activePromptBar = createActivePromptBarSlots({
      prompts: chatOutline.prompts,
      activePrompt: chatOutline.activePrompt,
      contentMaxWidth,
      onJumpToPrompt: chatOutline.jumpToPrompt,
    });
    return (
      <ChatFind
        agentId={agentId}
        serverId={resolvedServerId}
        epoch={timelineEpoch}
        items={findItems}
        showAgentInteractions={showAgentInteractions}
        viewportRef={viewportRef}
        revealLoadedMessage={revealLoadedMessage}
        visibleMessageIds={mountedMessageIds}
      >
        <ToolCallSheetProvider>
          <AllowSubagentForkContext.Provider value={allowSubagentFork}>
            <AssistantSelectionCopySurface
              {...webSelectionProps}
              style={stylesheet.container}
              serverId={resolvedServerId}
              workspaceId={context.workspaceId}
              agentId={agentId}
              canSubmitSelection={readOnly ? undefined : canSubmitSelection}
              subagentSpawnMode={spawnTarget?.mode}
              onSpawnSubagentFromSelection={onSpawnSubagentFromSelection}
            >
              <MessageOuterSpacingProvider disableOuterSpacing>
                <StreamExpansionProviders
                  toolCallExpansion={toolCallExpansion}
                  userMessageExpansion={userMessageExpansion}
                  assistantMessageExpansion={assistantMessageExpansion}
                  unreadSourceGroupId={unreadSourceGroupId}
                >
                  <NativeReadingEpochContext.Provider value={timelineEpoch}>
                    {streamRenderStrategy.render({
                      readingRowReplacements: presentation.readingRowReplacements,
                      agentId,
                      segments: renderModel.segments,
                      historyRowRevision,
                      liveHeadRowRevision: expandedToolCallGroups,
                      boundary,
                      renderers,
                      listEmptyComponent,
                      viewportRef,
                      routeBottomAnchorRequest,
                      isAuthoritativeHistoryReady,
                      isInitialHistoryLoading,
                      revealInitialHistory,
                      onNearBottomChange: nearBottom.set,
                      onReadingPositionChange: handleReadingPositionChange,
                      onNearHistoryStart: loadOlder,
                      isLoadingOlderHistory: isLoadingOlder,
                      hasOlderHistory: hasOlder,
                      olderHistoryProgressKey: progressKey,
                      scrollEnabled: streamScrollEnabled,
                      listStyle: stylesheet.list,
                      baseListContentContainerStyle: stylesheet.listContentContainer,
                      forwardListContentContainerStyle: stylesheet.forwardListContentContainer,
                      contentMaxWidth,
                      outlineInset,
                    })}
                  </NativeReadingEpochContext.Provider>
                </StreamExpansionProviders>
              </MessageOuterSpacingProvider>
              {renderChatOutlineRail(outlineInset, chatOutline)}
              {activePromptBar.native}
              <ScrollToBottomButton
                nearBottom={nearBottom}
                isTimelineDetached={isTimelineDetached}
                bottomOffset={scrollToBottomOffset}
                onPress={scrollToBottom}
              />
            </AssistantSelectionCopySurface>
          </AllowSubagentForkContext.Provider>
        </ToolCallSheetProvider>
        {activePromptBar.web}
      </ChatFind>
    );
  },
);

function agentCapabilityFlagsEqual(
  left: AgentCapabilityFlags | undefined,
  right: AgentCapabilityFlags | undefined,
): boolean {
  return AGENT_CAPABILITY_FLAG_KEYS.every((key) => left?.[key] === right?.[key]);
}

function collectAgentProjectPlacementDiffs(
  left: AgentScreenAgent["projectPlacement"],
  right: AgentScreenAgent["projectPlacement"],
): string[] {
  const reasons: string[] = [];
  if (left?.checkout?.cwd !== right?.checkout?.cwd) {
    reasons.push("agent.projectPlacement.checkout.cwd");
  }
  if (left?.checkout?.isGit !== right?.checkout?.isGit) {
    reasons.push("agent.projectPlacement.checkout.isGit");
  }
  if (left?.projectName !== right?.projectName) {
    reasons.push("agent.projectPlacement.projectName");
  }
  if (left?.projectKey !== right?.projectKey) {
    reasons.push("agent.projectPlacement.projectKey");
  }
  return reasons;
}

function collectAgentSetupDiffs(left: AgentScreenAgent, right: AgentScreenAgent): string[] {
  const reasons: string[] = [];
  if (left.provider !== right.provider) reasons.push("agent.provider");
  if (left.currentModeId !== right.currentModeId) reasons.push("agent.currentModeId");
  if (left.model !== right.model) reasons.push("agent.model");
  if (left.thinkingOptionId !== right.thinkingOptionId) {
    reasons.push("agent.thinkingOptionId");
  }
  if (left.runtimeInfo?.modeId !== right.runtimeInfo?.modeId) {
    reasons.push("agent.runtimeInfo.modeId");
  }
  if (left.runtimeInfo?.model !== right.runtimeInfo?.model) {
    reasons.push("agent.runtimeInfo.model");
  }
  if (left.runtimeInfo?.thinkingOptionId !== right.runtimeInfo?.thinkingOptionId) {
    reasons.push("agent.runtimeInfo.thinkingOptionId");
  }
  if (left.options !== right.options) reasons.push("agent.options");
  if (left.subagentDraftOptions !== right.subagentDraftOptions) {
    reasons.push("agent.subagentDraftOptions");
  }
  if (left.controls !== right.controls) reasons.push("agent.controls");
  return reasons;
}

function collectAgentScreenAgentDiffs(left: AgentScreenAgent, right: AgentScreenAgent): string[] {
  const reasons: string[] = [];
  if (left.serverId !== right.serverId) reasons.push("agent.serverId");
  if (left.id !== right.id) reasons.push("agent.id");
  if (left.workspaceId !== right.workspaceId) reasons.push("agent.workspaceId");
  if (left.status !== right.status) reasons.push("agent.status");
  if (left.cwd !== right.cwd) reasons.push("agent.cwd");
  if (!agentCapabilityFlagsEqual(left.capabilities, right.capabilities)) {
    reasons.push("agent.capabilities");
  }
  if (left.lastError !== right.lastError) reasons.push("agent.lastError");
  reasons.push(...collectAgentSetupDiffs(left, right));
  reasons.push(...collectAgentProjectPlacementDiffs(left.projectPlacement, right.projectPlacement));
  return reasons;
}

function bottomAnchorRouteRequestsEqual(
  left: BottomAnchorRouteRequest | null | undefined,
  right: BottomAnchorRouteRequest | null | undefined,
): boolean {
  return (
    left?.agentId === right?.agentId &&
    left?.reason === right?.reason &&
    left?.requestKey === right?.requestKey
  );
}

function historyPaginationPropsEqual(
  left: AgentStreamViewProps["historyPagination"],
  right: AgentStreamViewProps["historyPagination"],
): boolean {
  return (
    left?.hasOlder === right?.hasOlder &&
    left?.isLoadingOlder === right?.isLoadingOlder &&
    left?.progressKey === right?.progressKey &&
    left?.onLoadOlder === right?.onLoadOlder
  );
}

function agentStreamViewPropsEqual(
  left: AgentStreamViewProps,
  right: AgentStreamViewProps,
): boolean {
  const reasons: string[] = [];
  if (left.agentId !== right.agentId) reasons.push("agentId");
  if (left.serverId !== right.serverId) reasons.push("serverId");
  reasons.push(...collectAgentScreenAgentDiffs(left.context, right.context));
  if (left.streamItems !== right.streamItems) reasons.push("streamItems");
  if (left.streamHead !== right.streamHead) reasons.push("streamHead");
  if (left.pendingPermissions !== right.pendingPermissions) reasons.push("pendingPermissions");
  if (left.pendingMessageSubmissions !== right.pendingMessageSubmissions) {
    reasons.push("pendingMessageSubmissions");
  }
  if (left.turnPresentation !== right.turnPresentation) reasons.push("turnPresentation");
  if (
    !bottomAnchorRouteRequestsEqual(left.routeBottomAnchorRequest, right.routeBottomAnchorRequest)
  ) {
    reasons.push("routeBottomAnchorRequest");
  }
  if (left.isAuthoritativeHistoryReady !== right.isAuthoritativeHistoryReady) {
    reasons.push("isAuthoritativeHistoryReady");
  }
  if (left.isInitialHistoryLoading !== right.isInitialHistoryLoading) {
    reasons.push("isInitialHistoryLoading");
  }
  if (left.revealInitialHistory !== right.revealInitialHistory) {
    reasons.push("revealInitialHistory");
  }
  if (left.bottomOverlayTailClearance !== right.bottomOverlayTailClearance) {
    reasons.push("bottomOverlayTailClearance");
  }
  if (left.bottomOverlayControlClearance !== right.bottomOverlayControlClearance) {
    reasons.push("bottomOverlayControlClearance");
  }
  if (left.toast !== right.toast) reasons.push("toast");
  if (left.onOpenWorkspaceFile !== right.onOpenWorkspaceFile) reasons.push("onOpenWorkspaceFile");
  if (left.readOnly !== right.readOnly) reasons.push("readOnly");
  if (left.canSubmitSelection !== right.canSubmitSelection) reasons.push("canSubmitSelection");
  if (left.showAgentInteractions !== right.showAgentInteractions) {
    reasons.push("showAgentInteractions");
  }
  if (!historyPaginationPropsEqual(left.historyPagination, right.historyPagination)) {
    reasons.push("historyPagination");
  }
  recordRenderProfileReasons(`AgentStreamView:${right.agentId}`, reasons);
  return reasons.length === 0;
}

export const AgentStreamView = memo(AgentStreamViewComponent, agentStreamViewPropsEqual);
AgentStreamView.displayName = "AgentStreamView";

interface ToolCallSlotProps extends Omit<
  ComponentProps<typeof ToolCall>,
  "onInlineDetailsExpandedChange"
> {
  itemId: string;
  onInlineDetailsExpandedChangeByItemId: (itemId: string, expanded: boolean) => void;
}

interface ThoughtSlotProps {
  itemId: string;
  onInlineDetailsExpandedChangeByItemId: (itemId: string, expanded: boolean) => void;
  text: string;
  status: Extract<StreamItem, { kind: "thought" }>["status"];
  isLastInSequence: boolean;
  defaultExpanded: boolean;
  standalone?: boolean;
  maxDetailHeight?: number;
}

// Reasoning text is paced the same way assistant text is; see @/hooks/use-revealed-text.
function ThoughtSlot({
  itemId,
  onInlineDetailsExpandedChangeByItemId,
  text,
  status,
  isLastInSequence,
  defaultExpanded,
  standalone,
  maxDetailHeight,
}: ThoughtSlotProps) {
  const revealedText = useRevealedText(text, status === "ready" ? "complete" : "streaming");
  return (
    <ToolCallSlot
      itemId={itemId}
      onInlineDetailsExpandedChangeByItemId={onInlineDetailsExpandedChangeByItemId}
      toolName="thinking"
      args={revealedText}
      status={status === "ready" ? "completed" : "executing"}
      isLastInSequence={isLastInSequence}
      defaultExpanded={defaultExpanded}
      standalone={standalone}
      maxDetailHeight={maxDetailHeight}
      forceInline={defaultExpanded}
    />
  );
}

function ToolCallSlot({
  itemId,
  onInlineDetailsExpandedChangeByItemId,
  ...rest
}: ToolCallSlotProps) {
  const handleExpandedChange = useCallback(
    (expanded: boolean) => onInlineDetailsExpandedChangeByItemId(itemId, expanded),
    [onInlineDetailsExpandedChangeByItemId, itemId],
  );
  return (
    <ToolCall {...rest} itemId={itemId} onInlineDetailsExpandedChange={handleExpandedChange} />
  );
}

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedCheckIcon = withUnistyles(Check);
const ThemedXIcon = withUnistyles(X);

const primaryColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const mutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const pressableStyle = ({
  pressed,
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) => [
  permissionStyles.optionButton,
  hovered ? permissionStyles.optionButtonHovered : null,
  pressed ? permissionStyles.optionButtonPressed : null,
];

interface PermissionActionButtonProps {
  action: AgentPermissionAction;
  isRespondingAction: boolean;
  isResponding: boolean;
  isPrimary: boolean;
  Icon: typeof ThemedCheckIcon;
  testID: string;
  onPress: (action: AgentPermissionAction) => void;
}

function PermissionActionButton({
  action,
  isRespondingAction,
  isResponding,
  isPrimary,
  Icon,
  testID,
  onPress,
}: PermissionActionButtonProps) {
  const handlePress = useCallback(() => onPress(action), [onPress, action]);
  const optionTextStyle = isPrimary
    ? [permissionStyles.optionText, permissionStyles.optionTextPrimary]
    : permissionStyles.optionText;
  const colorMapping = isPrimary ? primaryColorMapping : mutedColorMapping;
  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      style={pressableStyle}
      onPress={handlePress}
      disabled={isResponding}
    >
      {isRespondingAction ? (
        <ThemedLoadingSpinner size="small" uniProps={colorMapping} />
      ) : (
        <View style={permissionStyles.optionContent}>
          <Icon size={14} uniProps={colorMapping} />
          <Text style={optionTextStyle}>{action.label}</Text>
        </View>
      )}
    </Pressable>
  );
}

function PermissionRequestCard({
  permission,
  client,
}: {
  permission: PendingPermission;
  client: DaemonClient | null;
}) {
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();

  const { request } = permission;
  const isPlanRequest = request.kind === "plan";
  const title = isPlanRequest
    ? t("agentStream.permission.plan")
    : (request.title ?? request.name ?? t("agentStream.permission.required"));
  const description = request.description ?? "";
  const resolvedToolCallDetail = useMemo(
    () =>
      request.detail ?? {
        type: "unknown" as const,
        input: request.input ?? null,
        output: null,
      },
    [request.detail, request.input],
  );
  const resolvedActions = useMemo((): AgentPermissionAction[] => {
    if (request.kind === "question") {
      return [];
    }
    if (Array.isArray(request.actions) && request.actions.length > 0) {
      return request.actions;
    }
    return [
      {
        id: "reject",
        label: t("agentStream.permission.deny"),
        behavior: "deny",
        variant: "danger",
        intent: "dismiss",
      },
      {
        id: "accept",
        label: isPlanRequest
          ? t("agentStream.permission.implement")
          : t("agentStream.permission.accept"),
        behavior: "allow",
        variant: "primary",
      },
    ];
  }, [isPlanRequest, request, t]);

  const planMarkdown = useMemo(() => {
    if (!request) {
      return undefined;
    }
    const planFromMetadata =
      typeof request.metadata?.planText === "string" ? request.metadata.planText : undefined;
    if (planFromMetadata) {
      return planFromMetadata;
    }
    const candidate = request.input?.["plan"];
    if (typeof candidate === "string") {
      return candidate;
    }
    return undefined;
  }, [request]);

  const permissionMutation = useMutation({
    mutationFn: async (input: {
      agentId: string;
      requestId: string;
      response: AgentPermissionResponse;
    }) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return client.respondToPermissionAndWait(
        input.agentId,
        input.requestId,
        input.response,
        15000,
      );
    },
  });
  const {
    reset: resetPermissionMutation,
    mutateAsync: respondToPermission,
    isPending: isResponding,
  } = permissionMutation;

  const [respondingActionId, setRespondingActionId] = useState<string | null>(null);

  useEffect(() => {
    resetPermissionMutation();
    setRespondingActionId(null);
  }, [permission.request.id, resetPermissionMutation]);
  const handleResponse = useCallback(
    (response: AgentPermissionResponse) => {
      respondToPermission({
        agentId: permission.agentId,
        requestId: permission.request.id,
        response,
      }).catch((error) => {
        console.error("[PermissionRequestCard] Failed to respond to permission:", error);
      });
    },
    [permission.agentId, permission.request.id, respondToPermission],
  );
  const handleActionPress = useCallback(
    (action: AgentPermissionAction) => {
      setRespondingActionId(action.id);
      if (action.behavior === "allow") {
        handleResponse({
          behavior: "allow",
          selectedActionId: action.id,
        });
        return;
      }
      handleResponse({
        behavior: "deny",
        selectedActionId: action.id,
        message: "Denied by user",
      });
    },
    [handleResponse],
  );

  const optionsContainerStyle = useMemo(
    () => [
      permissionStyles.optionsContainer,
      !isMobile && permissionStyles.optionsContainerDesktop,
    ],
    [isMobile],
  );

  if (request.kind === "question") {
    const responseFailed =
      permissionMutation.isError &&
      permissionMutation.variables?.agentId === permission.agentId &&
      permissionMutation.variables?.requestId === permission.request.id;
    const responseError = responseFailed ? t("message.question.responseFailed") : null;
    return (
      <QuestionFormCard
        permission={permission}
        onRespond={handleResponse}
        isResponding={isResponding}
        responseError={responseError}
      />
    );
  }

  const footer = (
    <>
      <Text testID="permission-request-question" style={permissionStyles.question}>
        {t("agentStream.permission.question")}
      </Text>

      <View style={optionsContainerStyle}>
        {resolvedActions.map((action) => {
          const isPrimary = action.variant === "primary";
          const isRespondingAction = respondingActionId === action.id;
          const Icon = action.behavior === "allow" ? ThemedCheckIcon : ThemedXIcon;
          let testID: string;
          if (action.behavior === "deny") testID = "permission-request-deny";
          else if (action.id === "accept" || action.id === "implement")
            testID = "permission-request-accept";
          else testID = `permission-request-action-${action.id}`;

          return (
            <PermissionActionButton
              key={action.id}
              action={action}
              isRespondingAction={isRespondingAction}
              isResponding={isResponding}
              isPrimary={isPrimary}
              Icon={Icon}
              testID={testID}
              onPress={handleActionPress}
            />
          );
        })}
      </View>
    </>
  );

  if (isPlanRequest && planMarkdown) {
    return (
      <PlanCard
        title={title}
        description={description}
        text={planMarkdown}
        outcome="pending"
        footer={footer}
        testID="permission-plan-card"
        disableOuterSpacing
      />
    );
  }

  return (
    <View style={permissionStyles.container}>
      <Text style={permissionStyles.title}>{title}</Text>

      {description ? <Text style={permissionStyles.description}>{description}</Text> : null}

      {planMarkdown ? (
        <PlanCard
          title={t("agentStream.permission.proposedPlan")}
          text={planMarkdown}
          testID="permission-plan-card"
          disableOuterSpacing
        />
      ) : null}

      {!isPlanRequest ? (
        <ToolCallDetailsContent detail={resolvedToolCallDetail} maxHeight={200} />
      ) : null}

      {footer}
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  contentWrapper: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
  listContentContainer: {
    paddingVertical: 0,
    flexGrow: 1,
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
  },
  forwardListContentContainer: {
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  list: {
    flex: 1,
  },
  streamItemWrapper: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[12],
  },
  permissionsContainer: {
    gap: theme.spacing[2],
  },
  listHeaderContent: {
    gap: theme.spacing[3],
  },
  syncingIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingLeft: theme.spacing[2],
  },
  syncingIndicatorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  emptyStateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  scrollToBottomContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  scrollToBottomButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    ...theme.shadow.sm,
  },
  scrollToBottomIcon: {
    color: theme.colors.foreground,
  },
  subagentReportCard: {
    width: "100%",
    alignSelf: "flex-start",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
  },
  subagentReportText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.lineHeight.content,
  },
}));

const permissionStyles = StyleSheet.create((theme) => ({
  container: {
    marginVertical: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.spacing[2],
    borderWidth: 1,
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
  },
  title: {
    fontSize: theme.fontSize.base,
    lineHeight: 22,
    color: theme.colors.foreground,
  },
  description: {
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
  },
  question: {
    fontSize: theme.fontSize.base,
    marginTop: theme.spacing[1],
    marginBottom: theme.spacing[1],
    color: theme.colors.foregroundMuted,
  },
  optionsContainer: {
    gap: theme.spacing[2],
  },
  optionsContainerDesktop: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-start",
    alignItems: "center",
    width: "100%",
  },
  optionButton: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    borderWidth: theme.borderWidth[1],
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.borderAccent,
  },
  optionButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  optionButtonPressed: {
    opacity: 0.9,
  },
  optionContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  optionText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  optionTextPrimary: {
    color: theme.colors.foreground,
  },
}));

interface StreamItemWrapperProps {
  gapBelow: number;
  turnIndent: TurnIndent;
  children: ReactNode;
}

function StreamItemWrapper({ gapBelow, turnIndent, children }: StreamItemWrapperProps) {
  const wrapperStyle = useMemo(
    () => [
      stylesheet.streamItemWrapper,
      { marginBottom: turnIndent === "nested" || turnIndent === "openedHost" ? 0 : gapBelow },
    ],
    [gapBelow, turnIndent],
  );
  const gapStyle = useMemo(() => ({ paddingBottom: gapBelow }), [gapBelow]);
  switch (turnIndent) {
    case "none":
    case "openedHost":
      return (
        <View style={wrapperStyle}>
          {children}
          {turnIndent === "openedHost" ? <IndentRail style={gapStyle} /> : null}
        </View>
      );
    case "nested":
      return (
        <View style={wrapperStyle}>
          <IndentRail style={gapStyle}>{children}</IndentRail>
        </View>
      );
    case "lastNested":
      return (
        <View style={wrapperStyle}>
          <IndentRail>{children}</IndentRail>
        </View>
      );
  }
}
