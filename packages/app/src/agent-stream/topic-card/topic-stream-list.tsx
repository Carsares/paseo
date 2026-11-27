import { useMessageImageReader } from "@/components/user-message/image-reader";
import type {
  AgentAttachment,
  TopicReplyRouteMode,
  WorkspaceDurableItem,
  WorkspaceTodoItem,
} from "@getpaseo/protocol/messages";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/react/shallow";
import type { ComposerAttachment } from "@/attachments/types";
import type { QuoteComposerAttachment } from "@/attachments/quote";
import { uploadFileAttachments } from "@/composer/actions";
import { isHandoffInputLocked } from "@/composer/handoff-input-lock";
import { useDraftStore } from "@/stores/draft-store";
import {
  isTopicComposerDraftSubmitting,
  resolveReplyComposerDraftKey,
  submitActiveTopicReply,
} from "./submit-topic-reply";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Button } from "@/components/ui/button";
import { useWorkspaceTasks } from "@/composer/workspace-task-ledger/query";
import { submitDurableItemDecision } from "@/durable-items/model";
import {
  getOnlineDurableItemsClient,
  reconcileDurableItemDecision,
  useWorkspaceDurableItems,
} from "@/durable-items/queries";
import { useLoadOlderAgentHistory } from "@/hooks/use-load-older-agent-history";
import { useFilePicker } from "@/hooks/use-file-picker";
import { useAppVisible } from "@/hooks/use-app-visible";
import { usePaneContext } from "@/panels/pane-context";
import { useHostFeature } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import {
  buildTopicInboxReadScopeKey,
  useTopicInboxReadStore,
} from "@/stores/topic-inbox-read-store";
import { useTeamDirectoryViewStore } from "@/stores/team-directory-view-store";
import {
  buildDurableDecisionDraftKey,
  buildDurableDecisionKey,
  buildTopicAgentKey,
  useTopicStreamViewStore,
  type DurableTopicDecisionRequest,
  type PendingTopicScrollTarget,
} from "@/stores/topic-stream-view-store";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { openSubagentFromTopic } from "@/subagents/open-from-topic";
import {
  useOptionalTeamMessageJumpStore,
  usePendingTeamMessageJump,
} from "@/subagents/team-directory/message-jump-store";
import { useTeamDirectoryShell } from "@/subagents/team-directory/shell-context";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import { useSetWorkspaceTodoStatus, useWorkspaceTodos } from "@/todos/queries";
import {
  markAllTopicsReadOnHost,
  markTopicReadOnHost,
  useWorkspaceTopicReadState,
} from "@/topic-read/queries";
import {
  applyTopicAnchorToCache,
  decideWorkspaceTopicOnHost,
  replyToWorkspaceTopic,
  TopicReplyRejectedError,
  useWorkspaceTopicEntries,
} from "@/topic-threads/queries";
import type { PendingPermission } from "@/types/shared";
import { generateMessageId, type StreamItem } from "@/types/stream";
import { DisclosureRow } from "../disclosure";
import type { DisclosureTriggerEdge, StreamViewportHandle } from "../strategy";
import {
  canDecideDurableItemInTopic,
  projectTopicUnits,
  getTopicProjectionAgentAddresses,
  type TopicAgentRuntime,
  type TopicRedirectTarget,
  type TopicUnit,
} from "./model";
import type { TopicDecisionSubmitInput, TopicDecisionSubmitResult } from "./topic-decision-slot";
import {
  resolveFlushableTaskId,
  computeTopicReadSequence,
  TopicThreadCard,
  type TopicLayoutRect,
  type TopicViewportBounds,
} from "./topic-thread-card";

const MAX_JUMP_HISTORY_FETCHES = 4;
// Keep the request ID if the topic view closes before the host acknowledges a retry.
const retryIntents = new Map<
  string,
  { clientMessageId: string; attachments?: AgentAttachment[] }
>();

const PENDING_FOLLOWUP_REFRESH_MS = 2_000;

function readRetryUploadNames(error: TopicReplyRejectedError): string[] | null {
  const prefix = "topic_attachments_reupload_required:";
  if (!error.message.startsWith(prefix)) return null;
  try {
    const names: unknown = JSON.parse(error.message.slice(prefix.length));
    if (Array.isArray(names) && names.length && names.every((name) => typeof name === "string"))
      return names;
  } catch {
    return null;
  }
  return null;
}

interface ActiveDisclosureHold {
  rowId: string;
  triggerEdge: DisclosureTriggerEdge;
  beforeY: number;
  beforeHeight: number;
  beforeScrollY: number;
}

function topicMatchesJumpIntent(
  topic: TopicUnit,
  jump: { itemId: string | null; messageId: string | null; seq: number | null },
): boolean {
  if (topic.redirectedTo) return false;
  if (jump.itemId) {
    if (topic.rootItemId === jump.itemId) return true;
    if (topic.replies.some((reply) => reply.id === jump.itemId)) return true;
  }
  if (jump.messageId) {
    if (topic.rootMessageId === jump.messageId) return true;
    if (
      topic.replies.some(
        (reply) =>
          ((reply.kind === "main_conclusion" || reply.kind === "main_progress") &&
            reply.messageId === jump.messageId) ||
          (reply.kind === "thread_entry" && reply.entry.sourceMessageId === jump.messageId) ||
          (reply.kind === "attributed_user_message" && reply.sourceMessageId === jump.messageId),
      )
    ) {
      return true;
    }
  }
  if (typeof jump.seq === "number") {
    if (topic.rootPrompt.seq === jump.seq) return true;
    if (topic.replies.some((reply) => reply.seq === jump.seq)) return true;
  }
  return false;
}

/**
 * Matches a topic unit against a pending scroll target across `topicKey`, `taskId`, and
 * `rootMessageId` so targets recorded before a topic bound to a task (`msg:<root>` -> `task:<id>`)
 * still resolve cleanly to the upgraded topic card.
 */
export function topicMatchesScrollTarget(
  topic: TopicUnit,
  target: Pick<PendingTopicScrollTarget, "topicKey" | "taskId" | "rootMessageId">,
): boolean {
  if (topic.redirectedTo) return false;
  if (topic.topicKey === target.topicKey) return true;
  const targetTaskId =
    target.taskId ?? (target.topicKey.startsWith("task:") ? target.topicKey.slice(5) : undefined);
  if (targetTaskId) {
    return topic.taskId === targetTaskId;
  }
  if (
    target.rootMessageId &&
    (topic.rootMessageId === target.rootMessageId ||
      topic.rootItemId === target.rootMessageId ||
      topic.rootPrompt.messageId === target.rootMessageId)
  ) {
    return true;
  }
  if (target.topicKey.startsWith("msg:")) {
    const rawMsgId = target.topicKey.slice(4);
    if (
      topic.rootMessageId === rawMsgId ||
      topic.rootItemId === rawMsgId ||
      topic.rootPrompt.messageId === rawMsgId ||
      topic.rootPrompt.item?.clientMessageId === rawMsgId
    ) {
      return true;
    }
  }
  return false;
}

function computeDisclosureScrollCompensation(
  hold: ActiveDisclosureHold,
  nextLayout: TopicLayoutRect,
): number | null {
  if (hold.triggerEdge === "bottom") {
    const beforeBottom = hold.beforeY + hold.beforeHeight;
    const nextBottom = nextLayout.y + nextLayout.height;
    const delta = nextBottom - beforeBottom;
    return Math.abs(delta) > 1 ? Math.max(0, hold.beforeScrollY + delta) : null;
  }
  const deltaY = nextLayout.y - hold.beforeY;
  return Math.abs(deltaY) > 1 ? Math.max(0, hold.beforeScrollY + deltaY) : null;
}

const TopicCardLayoutSlot = memo(function TopicCardLayoutSlot({
  topicKey,
  onRecordLayout,
  onClearLayout,
  children,
}: {
  topicKey: string;
  onRecordLayout: (topicKey: string, event: LayoutChangeEvent) => void;
  onClearLayout: (topicKey: string) => void;
  children: React.ReactNode;
}) {
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onRecordLayout(topicKey, event),
    [onRecordLayout, topicKey],
  );
  useEffect(() => {
    return () => {
      onClearLayout(topicKey);
    };
  }, [onClearLayout, topicKey]);
  return <View onLayout={handleLayout}>{children}</View>;
});

export interface TopicStreamListProps {
  serverId: string;
  workspaceId: string;
  mainAgentId: string;
  streamItems: readonly StreamItem[];
  streamHead: readonly StreamItem[];
  pendingPermissions: readonly PendingPermission[];
  pendingPermissionsNode?: React.ReactNode;
  isTurnActive: boolean;
  isPaneFocused: boolean;
  bottomClearance?: number;
  onFocusCompactComposer?: () => void;
  onErrorToast?: (message: string) => void;
}

function useTopicStreamScrollTargets(input: {
  serverId: string;
  mainAgentId: string;
  agentKey: string;
  topics: readonly TopicUnit[];
  visibleTopics: readonly TopicUnit[];
  unreadOnly: boolean;
  isTimelineSynced: boolean;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  loadOlder: () => Promise<boolean>;
  cardLayoutsRef: React.RefObject<Map<string, TopicLayoutRect>>;
  layoutVersion: number;
  scrollViewRef: React.RefObject<ScrollView | null>;
  setUnreadOnly: (agentKey: string, unreadOnly: boolean) => void;
  setHighlightedTopicKey: (topicKey: string | null) => void;
}) {
  const {
    serverId,
    mainAgentId,
    agentKey,
    topics,
    visibleTopics,
    unreadOnly,
    isTimelineSynced,
    hasOlder,
    isLoadingOlder,
    loadOlder,
    cardLayoutsRef,
    layoutVersion,
    scrollViewRef,
    setUnreadOnly,
    setHighlightedTopicKey,
  } = input;

  const pendingScroll = useTopicStreamViewStore(
    (state) => state.pendingScrollTopicByAgentKey[agentKey] ?? null,
  );
  const acknowledgeScroll = useTopicStreamViewStore((state) => state.acknowledgeScrollToTopic);
  const jumpStore = useOptionalTeamMessageJumpStore();
  const pendingTeamJump = usePendingTeamMessageJump(serverId, mainAgentId);
  const historyFetchAttemptsRef = useRef<Map<string, number>>(new Map());
  const teamPromptJumpInFlightRef = useRef<number | null>(null);
  const [teamPromptJumpSettled, setTeamPromptJumpSettled] = useState(0);

  // Team directory jump consumption: only acknowledge once the target card is mounted & measured,
  // or after initial history sync finishes AND older history is genuinely exhausted.
  useEffect(() => {
    if (!pendingTeamJump || !jumpStore) return;
    const matchedTopic = topics.find((topic) => topicMatchesJumpIntent(topic, pendingTeamJump));
    if (matchedTopic) {
      if (unreadOnly && !visibleTopics.some((t) => t.topicKey === matchedTopic.topicKey)) {
        setUnreadOnly(agentKey, false);
        return;
      }
      const layout = cardLayoutsRef.current.get(matchedTopic.topicKey);
      if (!layout) {
        return;
      }
      scrollViewRef.current?.scrollTo({ y: Math.max(0, layout.y - 12), animated: true });
      setHighlightedTopicKey(matchedTopic.topicKey);
      jumpStore.acknowledgeJump(pendingTeamJump.requestId);
      return;
    }

    // Never consume a jump during cold start before authoritative timeline sync has landed.
    if (!isTimelineSynced) return;

    const attemptKey = `team:${pendingTeamJump.requestId}`;
    const attempts = historyFetchAttemptsRef.current.get(attemptKey) ?? 0;
    if (
      pendingTeamJump.epoch &&
      typeof pendingTeamJump.seq === "number" &&
      attempts === 0 &&
      teamPromptJumpInFlightRef.current !== pendingTeamJump.requestId
    ) {
      historyFetchAttemptsRef.current.set(attemptKey, 1);
      teamPromptJumpInFlightRef.current = pendingTeamJump.requestId;
      void getHostRuntimeStore()
        .fetchAgentTimeline(
          serverId,
          mainAgentId,
          planTimelinePromptJump({ epoch: pendingTeamJump.epoch, seq: pendingTeamJump.seq }),
        )
        .catch(() => {
          // A failed targeted fetch leaves normal history paging available.
        })
        .finally(() => {
          if (teamPromptJumpInFlightRef.current === pendingTeamJump.requestId) {
            teamPromptJumpInFlightRef.current = null;
            setTeamPromptJumpSettled((revision) => revision + 1);
          }
        });
      return;
    }

    if (hasOlder) {
      if (!isLoadingOlder && attempts < MAX_JUMP_HISTORY_FETCHES) {
        historyFetchAttemptsRef.current.set(attemptKey, attempts + 1);
        void loadOlder();
      }
      // Keep the jump pending while older history still exists (even after auto-fetch cap).
      return;
    }

    if (!isLoadingOlder && teamPromptJumpInFlightRef.current !== pendingTeamJump.requestId) {
      jumpStore.acknowledgeJump(pendingTeamJump.requestId);
    }
  }, [
    agentKey,
    cardLayoutsRef,
    hasOlder,
    isLoadingOlder,
    isTimelineSynced,
    jumpStore,
    layoutVersion,
    loadOlder,
    mainAgentId,
    pendingTeamJump,
    scrollViewRef,
    serverId,
    setHighlightedTopicKey,
    setUnreadOnly,
    teamPromptJumpSettled,
    topics,
    unreadOnly,
    visibleTopics,
  ]);

  // Direct topic scroll consumption (from Todo jump, Notification deep-link, Return-to-topic):
  // matches across topicKey / taskId / rootMessageId, waits for initial sync & layout, and never
  // discards the jump while older history still exists.
  useEffect(() => {
    if (!pendingScroll) return;
    const matchedTopic = topics.find((topic) => topicMatchesScrollTarget(topic, pendingScroll));
    if (matchedTopic) {
      if (unreadOnly && !visibleTopics.some((t) => t.topicKey === matchedTopic.topicKey)) {
        setUnreadOnly(agentKey, false);
        return;
      }
      const layout = cardLayoutsRef.current.get(matchedTopic.topicKey);
      if (!layout) {
        return;
      }
      scrollViewRef.current?.scrollTo({ y: Math.max(0, layout.y - 12), animated: true });
      if (pendingScroll.highlight) {
        setHighlightedTopicKey(matchedTopic.topicKey);
      }
      acknowledgeScroll(agentKey, pendingScroll.requestId);
      return;
    }

    if (!isTimelineSynced) return;

    const attemptKey = `scroll:${pendingScroll.requestId}`;
    const attempts = historyFetchAttemptsRef.current.get(attemptKey) ?? 0;
    if (hasOlder) {
      if (!isLoadingOlder && attempts < MAX_JUMP_HISTORY_FETCHES) {
        historyFetchAttemptsRef.current.set(attemptKey, attempts + 1);
        void loadOlder();
      }
      return;
    }

    if (!isLoadingOlder) {
      acknowledgeScroll(agentKey, pendingScroll.requestId);
    }
  }, [
    acknowledgeScroll,
    agentKey,
    cardLayoutsRef,
    hasOlder,
    isLoadingOlder,
    isTimelineSynced,
    layoutVersion,
    loadOlder,
    pendingScroll,
    scrollViewRef,
    setHighlightedTopicKey,
    setUnreadOnly,
    topics,
    unreadOnly,
    visibleTopics,
  ]);
}

function createNoopStreamViewportHandle(
  onHoldRow: (rowId: string, apply: () => void, triggerEdge?: DisclosureTriggerEdge) => void,
): StreamViewportHandle {
  return {
    scrollToBottom: () => undefined,
    scrollToMessage: () => false,
    prepareForViewportChange: () => undefined,
    holdRow: onHoldRow,
  };
}

async function submitLegacyDurableDecisionResult(input: {
  queryClient: ReturnType<typeof useQueryClient>;
  serverId: string;
  workspaceId: string;
  durableItem: WorkspaceDurableItem;
  decision: NonNullable<TopicDecisionSubmitInput["decision"]>;
  disconnectedMessage: string;
  unconfirmedMessage: string;
}): Promise<TopicDecisionSubmitResult> {
  const onlineClient = getOnlineDurableItemsClient(input.serverId);
  if (!onlineClient) {
    return { outcome: "error", message: input.disconnectedMessage };
  }
  const legacyResult = await submitDurableItemDecision(
    onlineClient,
    input.durableItem,
    input.decision,
  );
  await reconcileDurableItemDecision(
    input.queryClient,
    input.serverId,
    input.workspaceId,
    legacyResult.item,
  );
  if (legacyResult.outcome === "saved") return { outcome: "saved" };
  if (legacyResult.outcome === "evidenceStale") return { outcome: "evidenceStale" };
  if (legacyResult.outcome === "conflict") return { outcome: "conflict" };
  return { outcome: "error", message: input.unconfirmedMessage };
}

function mapTopicDurableDecideResponse(
  response: Awaited<ReturnType<typeof decideWorkspaceTopicOnHost>>,
  expectedRevision: number,
  conflictMessage: string,
  unconfirmedMessage: string,
): TopicDecisionSubmitResult {
  if (response.errorCode === "topic_decision_resume_required") {
    return { outcome: "resumeRequired", message: response.error ?? undefined };
  }
  // A recorded decision can carry a warning when a changed task prevented follow-up.
  if (response.entry) return { outcome: "saved", message: response.error ?? undefined };
  if (
    response.errorCode === "durable_item_evidence_stale" ||
    response.errorCode === "DURABLE_ITEM_STALE_EVIDENCE"
  ) {
    return { outcome: "evidenceStale", message: response.error ?? undefined };
  }
  if (response.accepted === false || response.error) {
    if (response.durableItem && response.durableItem.revision > expectedRevision) {
      return { outcome: "conflict", message: response.error ?? conflictMessage };
    }
    return { outcome: "error", message: response.error ?? unconfirmedMessage };
  }
  return { outcome: "saved" };
}

async function sendDurableTopicDecision(input: {
  queryClient: ReturnType<typeof useQueryClient>;
  serverId: string;
  scopeKey: string;
  request: DurableTopicDecisionRequest;
  conflictMessage: string;
  unconfirmedMessage: string;
}): Promise<TopicDecisionSubmitResult> {
  const { serverId, scopeKey, request, queryClient } = input;
  const { durableDecisionIntents, setDurableDecisionIntent } = useTopicStreamViewStore.getState();
  const previouslyConfirmed = durableDecisionIntents[scopeKey]?.status === "resumeRequired";
  setDurableDecisionIntent(scopeKey, { request, status: "sending" });
  let response;
  try {
    response = await decideWorkspaceTopicOnHost({ ...request, queryClient, serverId });
  } catch {
    setDurableDecisionIntent(scopeKey, {
      request,
      status: previouslyConfirmed ? "resumeRequired" : "unconfirmed",
    });
    return { outcome: "resumeRequired" };
  }
  const result = mapTopicDurableDecideResponse(
    response,
    request.expectedRevision,
    input.conflictMessage,
    input.unconfirmedMessage,
  );
  if (result.outcome === "resumeRequired") {
    setDurableDecisionIntent(scopeKey, { request, status: "resumeRequired" });
  } else {
    setDurableDecisionIntent(scopeKey, null);
    if (result.outcome === "saved") {
      const drafts = useTopicStreamViewStore.getState();
      const draftKey = buildDurableDecisionDraftKey(scopeKey, request.durableItemRequestId);
      if (drafts.decisionDraftByTopicKey[draftKey]?.trim() === (request.note ?? "")) {
        drafts.setDecisionDraft(draftKey, "");
      }
    }
  }
  return result;
}

function mapTopicBlockingDecideResponse(
  response: Awaited<ReturnType<typeof decideWorkspaceTopicOnHost>>,
  unconfirmedMessage: string,
): TopicDecisionSubmitResult {
  if (response.errorCode === "stale_blocking_question") {
    return {
      outcome: "staleBlockingQuestion",
      message: response.error ?? undefined,
      latestBlockingQuestionGeneration: response.task?.blockingQuestionGeneration,
      hasLatestTask: true,
    };
  }
  if (response.accepted === false || response.error) {
    return { outcome: "error", message: response.error ?? unconfirmedMessage };
  }
  return { outcome: "saved" };
}

export const TopicStreamList = memo(function TopicStreamList({
  serverId,
  workspaceId,
  mainAgentId,
  streamItems,
  streamHead,
  pendingPermissions,
  pendingPermissionsNode,
  isTurnActive,
  isPaneFocused,
  bottomClearance = 0,
  onFocusCompactComposer,
  onErrorToast,
}: TopicStreamListProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const online = useHostRuntimeIsConnected(serverId);
  const imageReader = useMessageImageReader(client, serverId, workspaceId);
  const appVisible = useAppVisible();
  const paneActive = useRetainedPanelActive();
  const { tabId } = usePaneContext();
  const teamDirectoryShell = useTeamDirectoryShell();
  const setTeamDirectoryTab = useTeamDirectoryViewStore((state) => state.setActiveTab);

  const agentKey = buildTopicAgentKey(serverId, mainAgentId);
  const lastLiveItem = isTurnActive ? streamHead.at(-1) : undefined;
  const streamingConclusionId =
    lastLiveItem?.kind === "assistant_message" ? lastLiveItem.id : undefined;
  const unreadOnly = useTopicStreamViewStore(
    (state) => state.unreadOnlyByAgentKey[agentKey] ?? false,
  );
  const durableDecisionIntents = useTopicStreamViewStore((state) => state.durableDecisionIntents);
  const setUnreadOnly = useTopicStreamViewStore((state) => state.setUnreadOnly);
  const setActiveReplyTopic = useTopicStreamViewStore((state) => state.setActiveReplyTopic);
  const requestScrollToTopic = useTopicStreamViewStore((state) => state.requestScrollToTopic);
  const openTodoEditor = useTopicStreamViewStore((state) => state.openTodoEditor);

  const supportsTopicThreads = useHostFeature(serverId, "workspaceTopicThreads");
  const supportsForgeAttachments = useHostFeature(serverId, "forgeSearch");
  const supportsTaskLedger = useHostFeature(serverId, "workspaceTaskLedger");
  // COMPAT(workspaceButlerV1): added in v0.18.0, remove gate after 2027-06-01.
  const supportsButlerV1 = useHostFeature(serverId, "workspaceButlerV1");

  const { query: tasksQuery } = useWorkspaceTasks(
    serverId,
    workspaceId,
    paneActive && supportsTaskLedger,
  );
  const {
    entries: threadEntries,
    anchors: topicAnchors,
    refetch: refetchTopicEntries,
  } = useWorkspaceTopicEntries(serverId, workspaceId, mainAgentId, paneActive);
  const hasPendingFollowup = threadEntries.some(
    (entry) =>
      entry.role === "user_followup" &&
      !entry.retryable &&
      (entry.status === "queued" || entry.status === "running"),
  );
  useEffect(() => {
    if (!online || !paneActive || !appVisible || !hasPendingFollowup) return;
    // The initial response is queued and later delivery updates can be missed.
    // Read the persisted entries so a different turn cannot settle this follow-up.
    const interval = setInterval(() => {
      void refetchTopicEntries({ cancelRefetch: false });
    }, PENDING_FOLLOWUP_REFRESH_MS);
    return () => clearInterval(interval);
  }, [appVisible, hasPendingFollowup, online, paneActive, refetchTopicEntries]);
  const supportsTopicAnchorEvents = useHostFeature(serverId, "workspaceTopicAnchorEvents");
  useEffect(() => {
    // COMPAT(workspaceTopicAnchorEvents): added in v0.18.0, remove gate after 2027-06-01.
    if (!supportsTopicAnchorEvents || !client || !paneActive) return;
    const observation = client.observeEvents(["workspace.topic.anchor.updated"]);
    const unsubscribe = observation.subscribe({
      snapshot: () => {
        void refetchTopicEntries().catch(() => undefined);
      },
      update: (message) => {
        if (message.type !== "workspace.topic.anchor.updated") return;
        const { payload } = message;
        if (payload.workspaceId !== workspaceId || payload.mainAgentId !== mainAgentId) return;
        applyTopicAnchorToCache(queryClient, serverId, payload);
      },
    });
    void observation.ready.catch(() => undefined);
    return () => {
      unsubscribe();
      void observation.release().catch(() => undefined);
    };
  }, [
    client,
    mainAgentId,
    paneActive,
    queryClient,
    refetchTopicEntries,
    serverId,
    supportsTopicAnchorEvents,
    workspaceId,
  ]);
  const { snapshot: readSnapshot } = useWorkspaceTopicReadState(
    serverId,
    workspaceId,
    mainAgentId,
    paneActive,
  );
  const { items: workspaceTodos } = useWorkspaceTodos(serverId, workspaceId, paneActive);
  const { result: durableResult, online: durableItemsOnline } = useWorkspaceDurableItems(
    serverId,
    workspaceId,
    isPaneFocused,
  );
  const durableItemsConfirmed =
    durableResult.isSuccess === undefined
      ? true
      : durableResult.isSuccess && durableResult.fetchStatus === "idle";
  const setTodoStatus = useSetWorkspaceTodoStatus(serverId);
  const { hasOlder, isLoadingOlder, loadOlder } = useLoadOlderAgentHistory({
    serverId,
    agentId: mainAgentId,
  });

  const readScopeKey = useMemo(
    () => buildTopicInboxReadScopeKey({ serverId, workspaceId, mainAgentId }),
    [mainAgentId, serverId, workspaceId],
  );
  const legacyReadScope = useTopicInboxReadStore((state) => state.scopes[readScopeKey]);

  // Individual primitive / reference-stable selectors for Zustand 5 + React 19 snapshot stability.
  const agentRequiresAttention = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(mainAgentId) ?? session?.agentDetails.get(mainAgentId);
    return agent?.requiresAttention === true;
  });
  const pendingInboxItems = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(mainAgentId) ?? session?.agentDetails.get(mainAgentId);
    return agent?.pendingSubagentInbox?.items;
  });
  const isTimelineSynced = useSessionStore(
    (state) => selectAgentTimelineState(state.sessions[serverId], mainAgentId).status === "synced",
  );
  const combinedItems = useMemo(
    () => (streamHead.length > 0 ? [...streamItems, ...streamHead] : [...streamItems]),
    [streamHead, streamItems],
  );
  const delegationAddresses = useMemo(
    () =>
      getTopicProjectionAgentAddresses(
        {
          items: combinedItems,
          topicAnchors,
          tasks: tasksQuery.data,
          threadEntries,
          pendingInboxItems,
        },
        serverId,
      ),
    [combinedItems, topicAnchors, tasksQuery.data, threadEntries, pendingInboxItems, serverId],
  );
  const delegationAgents = useSessionStore(
    useShallow((state) =>
      delegationAddresses.map(({ serverId: childServerId, agentId }) => {
        const session = state.sessions[childServerId];
        return session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      }),
    ),
  );
  const runtimeByAddress = useMemo(() => {
    const runtimes = new Map<string, TopicAgentRuntime>();
    for (const [index, address] of delegationAddresses.entries()) {
      const agent = delegationAgents[index];
      if (agent)
        runtimes.set(JSON.stringify([address.serverId, address.agentId]), {
          title: agent.title,
          status: agent.status,
          turn: agent.turn,
        });
    }
    return runtimes;
  }, [delegationAddresses, delegationAgents]);
  const readAgentRuntime = useCallback(
    (childServerId: string, agentId: string) =>
      runtimeByAddress.get(JSON.stringify([childServerId, agentId])),
    [runtimeByAddress],
  );
  const agentTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const [index, address] of delegationAddresses.entries()) {
      if (address.serverId !== serverId) continue;
      const title = delegationAgents[index]?.title?.trim();
      if (title) map.set(address.agentId, title);
    }
    return map;
  }, [delegationAddresses, delegationAgents, serverId]);

  const projection = useMemo(
    () =>
      projectTopicUnits({
        items: combinedItems,
        tasks: tasksQuery.data,
        threadEntries,
        topicAnchors,
        pendingInboxItems,
        todos: workspaceTodos,
        durableItems: durableResult.data,
        pendingPermissions,
        readSnapshot,
        legacyReadScope,
        isTurnActive,
        agentRequiresAttention,
        localServerId: serverId,
        readAgentRuntime,
        agentTitleById,
      }),
    [
      agentRequiresAttention,
      agentTitleById,
      combinedItems,
      durableResult.data,
      isTurnActive,
      legacyReadScope,
      pendingInboxItems,
      pendingPermissions,
      readAgentRuntime,
      readSnapshot,
      serverId,
      tasksQuery.data,
      threadEntries,
      topicAnchors,
      workspaceTodos,
    ],
  );

  const visibleTopics = useMemo(
    () =>
      unreadOnly
        ? projection.topics.filter(
            (topic) =>
              topic.hasUnread ||
              (supportsButlerV1 &&
                durableDecisionIntents[
                  buildDurableDecisionKey(serverId, workspaceId, agentKey, topic.topicKey)
                ]),
          )
        : projection.topics,
    [
      agentKey,
      durableDecisionIntents,
      projection.topics,
      serverId,
      supportsButlerV1,
      unreadOnly,
      workspaceId,
    ],
  );

  const scrollViewRef = useRef<ScrollView>(null);
  const cardLayoutsRef = useRef<Map<string, TopicLayoutRect>>(new Map());
  const viewportBoundsRef = useRef<TopicViewportBounds>({ scrollY: 0, height: 0, measured: false });
  const activeDisclosureHoldRef = useRef<ActiveDisclosureHold | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [viewportBounds, setViewportBounds] = useState<TopicViewportBounds>({
    scrollY: 0,
    height: 0,
    measured: false,
  });
  const [highlightedTopicKey, setHighlightedTopicKey] = useState<string | null>(null);
  useEffect(() => {
    if (!highlightedTopicKey) return;
    const timer = setTimeout(() => setHighlightedTopicKey(null), 2400);
    return () => clearTimeout(timer);
  }, [highlightedTopicKey]);
  const [replyingTopics, setReplyingTopics] = useState<ReadonlySet<string>>(() => new Set());
  const [retryUploadNames, setRetryUploadNames] = useState<ReadonlyMap<string, string[]>>(
    () => new Map(),
  );
  const { pickFiles } = useFilePicker();
  const [flushingTopicKey, setFlushingTopicKey] = useState<string | null>(null);

  const disclosureViewportRef = useRef<StreamViewportHandle | null>(null);
  if (disclosureViewportRef.current === null) {
    disclosureViewportRef.current = createNoopStreamViewportHandle(
      (rowId, apply, triggerEdge = "top") => {
        const beforeLayout = cardLayoutsRef.current.get(rowId);
        if (beforeLayout) {
          activeDisclosureHoldRef.current = {
            rowId,
            triggerEdge,
            beforeY: beforeLayout.y,
            beforeHeight: beforeLayout.height,
            beforeScrollY: viewportBoundsRef.current.scrollY,
          };
        }
        apply();
      },
    );
  }

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement } = event.nativeEvent;
    const height = layoutMeasurement.height;
    const next: TopicViewportBounds = {
      scrollY: contentOffset.y,
      height: height > 0 ? height : viewportBoundsRef.current.height,
      measured: height > 0 || viewportBoundsRef.current.measured,
    };
    viewportBoundsRef.current = next;
    setViewportBounds(next);
  }, []);

  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    if (height <= 0) return;
    setViewportBounds((prev) => {
      if (prev.measured && prev.height === height) return prev;
      const next: TopicViewportBounds = { ...prev, height, measured: true };
      viewportBoundsRef.current = next;
      return next;
    });
  }, []);

  const recordCardLayout = useCallback((topicKey: string, event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    const prev = cardLayoutsRef.current.get(topicKey);
    const nextLayout: TopicLayoutRect = { y, height };
    cardLayoutsRef.current.set(topicKey, nextLayout);

    const activeHold = activeDisclosureHoldRef.current;
    if (activeHold && activeHold.rowId === topicKey) {
      activeDisclosureHoldRef.current = null;
      const compensatedY = computeDisclosureScrollCompensation(activeHold, nextLayout);
      if (compensatedY !== null) {
        scrollViewRef.current?.scrollTo({ y: compensatedY, animated: false });
      }
    }

    if (!prev || prev.y !== y || prev.height !== height) {
      setLayoutVersion((version) => version + 1);
    }
  }, []);

  const clearCardLayout = useCallback((topicKey: string) => {
    if (cardLayoutsRef.current.delete(topicKey)) {
      setLayoutVersion((version) => version + 1);
    }
  }, []);

  useTopicStreamScrollTargets({
    serverId,
    mainAgentId,
    agentKey,
    topics: projection.topics,
    visibleTopics,
    unreadOnly,
    isTimelineSynced,
    hasOlder,
    isLoadingOlder,
    loadOlder,
    cardLayoutsRef,
    layoutVersion,
    scrollViewRef,
    setUnreadOnly,
    setHighlightedTopicKey,
  });

  const handleAutoMarkRead = useCallback(
    (input: {
      topicKey: string;
      seq: number | null;
      epoch?: string | null;
      timestampMs: number;
      fallbackItemIds: string[];
    }) => {
      void markTopicReadOnHost({
        queryClient,
        serverId,
        workspaceId,
        mainAgentId,
        topicKey: input.topicKey,
        mode: "read",
        epoch: input.epoch,
        seq: input.epoch ? (input.seq ?? undefined) : undefined,
        timestampMs: input.timestampMs,
        fallbackItemIds: input.fallbackItemIds,
      }).catch(() => undefined);
    },
    [mainAgentId, queryClient, serverId, workspaceId],
  );

  const handleMarkTopicMode = useCallback(
    (topic: TopicUnit, mode: "read" | "unread") => {
      void markTopicReadOnHost({
        queryClient,
        serverId,
        workspaceId,
        mainAgentId,
        topicKey: topic.topicKey,
        mode,
        epoch: projection.watermark.epoch,
        seq: computeTopicReadSequence(topic, projection.watermark.epoch) ?? undefined,
        timestampMs: topic.latestTimestampMs,
        fallbackItemIds: topic.replies.map((reply) => reply.id),
      }).catch((err) => {
        onErrorToast?.(err instanceof Error ? err.message : String(err));
      });
    },
    [mainAgentId, onErrorToast, projection.watermark.epoch, queryClient, serverId, workspaceId],
  );

  const handleFlushTopicInbox = useCallback(
    (topic: TopicUnit) => {
      const taskId = resolveFlushableTaskId(topic);
      if (!client || !taskId || flushingTopicKey) return;
      setFlushingTopicKey(topic.topicKey);
      void client
        .flushAgentInbox(mainAgentId, { taskId })
        .catch((err) => {
          onErrorToast?.(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          setFlushingTopicKey(null);
        });
    },
    [client, flushingTopicKey, mainAgentId, onErrorToast],
  );

  const handleOpenAgentBeside = useCallback(
    (input: { targetAgentId: string; targetServerId?: string; topic: TopicUnit }) => {
      openSubagentFromTopic({
        serverId,
        workspaceId,
        targetServerId: input.targetServerId,
        targetAgentId: input.targetAgentId,
        mainAgentId,
        topicKey: input.topic.topicKey,
        taskId: input.topic.taskId,
        rootMessageId: input.topic.rootMessageId,
        promptPreview: input.topic.rootPrompt.text.slice(0, 60),
        parentTabId: tabId,
        location: "side",
      });
    },
    [mainAgentId, serverId, tabId, workspaceId],
  );

  const submitLocks = useRef(new Set<string>());
  const handleSubmitDesktopReply = useCallback(
    async (
      topic: TopicUnit,
      text: string,
      routeMode: TopicReplyRouteMode,
      clientMessageId?: string,
      attachments: ComposerAttachment[] = [],
    ): Promise<boolean> => {
      if (submitLocks.current.has(topic.topicKey)) return false;
      submitLocks.current.add(topic.topicKey);
      setReplyingTopics(new Set(submitLocks.current));
      try {
        return await submitActiveTopicReply({
          queryClient,
          serverId,
          workspaceId,
          agentId: mainAgentId,
          activeReplyTopic: {
            topicKey: topic.topicKey,
            taskId: topic.taskId,
            rootMessageId: topic.rootMessageId,
            promptPreview: topic.rootPrompt.text.slice(0, 240),
            leadTitle: topic.leadTitle,
            routeMode,
          },
          payload: { text, attachments, cwd: "" },
          clientMessageId,
          supportsTopicThreads,
          supportsForgeAttachments,
          disconnectedMessage: t("workspace.terminal.hostDisconnected"),
        });
      } catch (err) {
        onErrorToast?.(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        submitLocks.current.delete(topic.topicKey);
        setReplyingTopics(new Set(submitLocks.current));
      }
    },
    [
      mainAgentId,
      onErrorToast,
      queryClient,
      serverId,
      supportsForgeAttachments,
      supportsTopicThreads,
      t,
      workspaceId,
    ],
  );

  const pickRetryAttachments = useCallback(
    async (names: string[]) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      // The picker must start during the retry button's press on web.
      const files = await pickFiles();
      if (!files) return;
      if (files.length !== names.length) {
        onErrorToast?.(
          t("topicWorkbench.topicStream.retryUploadFiles", { files: names.join(", ") }),
        );
        return;
      }
      return (await uploadFileAttachments({ client, files })).map(({ attachment }) => attachment);
    },
    [client, onErrorToast, pickFiles, t],
  );

  const handleRetryTopic = useCallback(
    async (topic: TopicUnit, retry: { entryId: string; text: string }) => {
      if (!supportsTopicThreads || submitLocks.current.has(topic.topicKey)) return;
      const key = JSON.stringify([
        serverId,
        workspaceId,
        mainAgentId,
        topic.topicKey,
        retry.entryId,
      ]);
      submitLocks.current.add(topic.topicKey);
      setReplyingTopics(new Set(submitLocks.current));
      let intent = retryIntents.get(key);
      let acknowledged = false;
      try {
        const names = retryUploadNames.get(retry.entryId);
        if (names && !intent?.attachments) {
          const attachments = await pickRetryAttachments(names);
          if (!attachments) return;
          intent = {
            clientMessageId: intent?.clientMessageId ?? generateMessageId(),
            attachments,
          };
        }
        intent ??= { clientMessageId: generateMessageId() };
        retryIntents.set(key, intent);
        await replyToWorkspaceTopic({
          queryClient,
          serverId,
          workspaceId,
          mainAgentId,
          topicKey: topic.topicKey,
          retryOfEntryId: retry.entryId,
          text: retry.text.trim() || "[attachment]",
          ...intent,
        });
        acknowledged = true;
        setRetryUploadNames((current) => {
          if (!current.has(retry.entryId)) return current;
          const next = new Map(current);
          next.delete(retry.entryId);
          return next;
        });
      } catch (err) {
        acknowledged = err instanceof TopicReplyRejectedError;
        const names = err instanceof TopicReplyRejectedError ? readRetryUploadNames(err) : null;
        if (names) {
          setRetryUploadNames((current) => new Map(current).set(retry.entryId, names));
          return;
        }
        onErrorToast?.(err instanceof Error ? err.message : String(err));
      } finally {
        if (acknowledged && retryIntents.get(key) === intent) retryIntents.delete(key);
        submitLocks.current.delete(topic.topicKey);
        setReplyingTopics(new Set(submitLocks.current));
      }
    },
    [
      mainAgentId,
      onErrorToast,
      pickRetryAttachments,
      queryClient,
      retryUploadNames,
      serverId,
      supportsTopicThreads,
      workspaceId,
    ],
  );

  const handleActivateCompactReply = useCallback(
    (topic: TopicUnit, routeMode: TopicReplyRouteMode, quote?: QuoteComposerAttachment) => {
      const active = useTopicStreamViewStore.getState().activeReplyTopicByAgentKey[agentKey];
      const target = {
        topicKey: topic.topicKey,
        taskId: topic.taskId,
        rootMessageId: topic.rootMessageId,
        leadAgentId: topic.leadAgentId,
        leadTitle: topic.leadTitle,
        promptPreview: topic.rootPrompt.text.slice(0, 60),
        routeMode:
          quote && active?.topicKey === topic.topicKey && !active.decisionContext
            ? active.routeMode
            : routeMode,
      };
      if (quote && isHandoffInputLocked(serverId, mainAgentId)) return;
      const draftKey = quote
        ? resolveReplyComposerDraftKey({ serverId, workspaceId, agentId: mainAgentId, target })
        : null;
      if (draftKey && isTopicComposerDraftSubmitting(draftKey)) {
        onErrorToast?.(t("topicWorkbench.topicStream.quoteAfterSending"));
        return;
      }
      setActiveReplyTopic(agentKey, target);
      if (quote && draftKey) {
        useDraftStore.getState().updateDraftInput({
          draftKey,
          update: (draft) => ({ ...draft, attachments: [...draft.attachments, quote] }),
        });
      }
      onFocusCompactComposer?.();
    },
    [
      agentKey,
      mainAgentId,
      onErrorToast,
      onFocusCompactComposer,
      serverId,
      setActiveReplyTopic,
      t,
      workspaceId,
    ],
  );

  const handleActivateCompactDecision = useCallback(
    (topic: TopicUnit, question: string, blockingQuestionGeneration?: string) => {
      setActiveReplyTopic(agentKey, {
        topicKey: topic.topicKey,
        taskId: topic.taskId,
        rootMessageId: topic.rootMessageId,
        leadAgentId: topic.leadAgentId,
        leadTitle: topic.leadTitle,
        promptPreview: topic.rootPrompt.text.slice(0, 120),
        routeMode: "auto",
        decisionContext: {
          kind: "task_blocking_question",
          taskId: topic.taskId,
          question,
          blockingQuestionGeneration,
        },
      });
      onFocusCompactComposer?.();
    },
    [agentKey, onFocusCompactComposer, setActiveReplyTopic],
  );

  const handleOpenStandaloneDurableItem = useCallback(
    (item: WorkspaceDurableItem) => {
      setTeamDirectoryTab("todos");
      if (teamDirectoryShell.openDirectory) {
        teamDirectoryShell.openDirectory();
        return;
      }
      if (teamDirectoryShell.isOwnedByWorkspaceShell) {
        if (!teamDirectoryShell.isDirectoryVisible) {
          teamDirectoryShell.toggleDirectory();
        }
        return;
      }
      if (item.sourceAgentId && item.sourceAgentId !== mainAgentId) {
        openSubagentFromTopic({
          serverId,
          workspaceId,
          targetAgentId: item.sourceAgentId,
          mainAgentId,
          topicKey:
            item.topicKey ?? (item.taskId ? `task:${item.taskId}` : `durable:${item.requestId}`),
          taskId: item.taskId,
          rootMessageId: item.rootMessageId,
          promptPreview: item.title.slice(0, 60),
          parentTabId: tabId,
          location: "side",
        });
        return;
      }
      if (!teamDirectoryShell.isDirectoryVisible) {
        teamDirectoryShell.toggleDirectory();
      }
    },
    [mainAgentId, serverId, setTeamDirectoryTab, tabId, teamDirectoryShell, workspaceId],
  );

  const handleJumpToPeerTopic = useCallback(
    (peerTaskId: string) => {
      requestScrollToTopic(agentKey, `task:${peerTaskId}`, true, { taskId: peerTaskId });
    },
    [agentKey, requestScrollToTopic],
  );

  const handleJumpToRedirectTarget = useCallback(
    (target: TopicRedirectTarget) => {
      requestScrollToTopic(agentKey, target.topicKey, true, {
        taskId: target.taskId,
        rootMessageId: target.rootMessageId,
      });
    },
    [agentKey, requestScrollToTopic],
  );

  const handleRefreshDurableItems = useCallback(() => {
    void durableResult.refetch?.();
  }, [durableResult]);

  const sendDurableDecision = useCallback(
    (scopeKey: string, request: DurableTopicDecisionRequest) =>
      sendDurableTopicDecision({
        queryClient,
        serverId,
        scopeKey,
        request,
        conflictMessage: t("topicWorkbench.durableItems.conflict"),
        unconfirmedMessage: t("topicWorkbench.durableItems.unconfirmed"),
      }),
    [queryClient, serverId, t],
  );

  const handleResumeTopicDecision = useCallback(
    (topicKey: string) => {
      const scopeKey = buildDurableDecisionKey(serverId, workspaceId, agentKey, topicKey);
      const intent = useTopicStreamViewStore.getState().durableDecisionIntents[scopeKey];
      if (!supportsButlerV1 || !intent || intent.status === "sending") return;
      void sendDurableDecision(scopeKey, intent.request).then((result) => {
        if (result.outcome !== "resumeRequired" && result.message) onErrorToast?.(result.message);
        return undefined;
      });
    },
    [agentKey, onErrorToast, sendDurableDecision, serverId, supportsButlerV1, workspaceId],
  );

  const handleSubmitTopicDecision = useCallback(
    async (input: TopicDecisionSubmitInput): Promise<TopicDecisionSubmitResult> => {
      const unconfirmedMessage = t("topicWorkbench.durableItems.unconfirmed");
      if (input.resolutionKind === "durable_item" && input.durableItem && input.decision) {
        if (
          !supportsButlerV1 ||
          !canDecideDurableItemInTopic(input.durableItem, input.topic.taskId)
        ) {
          return submitLegacyDurableDecisionResult({
            queryClient,
            serverId,
            workspaceId,
            durableItem: input.durableItem,
            decision: input.decision,
            disconnectedMessage: t("workspace.terminal.hostDisconnected"),
            unconfirmedMessage,
          });
        }
        const scopeKey = buildDurableDecisionKey(
          serverId,
          workspaceId,
          agentKey,
          input.topic.topicKey,
        );
        if (useTopicStreamViewStore.getState().durableDecisionIntents[scopeKey]) {
          return { outcome: "resumeRequired" };
        }
        const result = await sendDurableDecision(scopeKey, {
          workspaceId,
          mainAgentId,
          topicKey: input.topic.topicKey,
          taskId: input.topic.taskId,
          rootMessageId: input.topic.rootMessageId,
          clientMessageId: input.clientMessageId,
          resolutionKind: "durable_item",
          durableItemRequestId: input.durableItem.requestId,
          expectedRevision: input.durableItem.revision,
          decision: input.decision,
          note: input.note,
        });
        if (result.outcome === "saved" && result.message) onErrorToast?.(result.message);
        return result;
      }

      if (!supportsButlerV1) {
        return {
          outcome: "error",
          message: t("topicWorkbench.topicStream.decisionLegacyHostNotice"),
        };
      }

      const response = await decideWorkspaceTopicOnHost({
        queryClient,
        serverId,
        workspaceId,
        mainAgentId,
        topicKey: input.topic.topicKey,
        taskId: input.topic.taskId,
        rootMessageId: input.topic.rootMessageId,
        clientMessageId: input.clientMessageId,
        resolutionKind: "task_blocking_question",
        expectedBlockingQuestionGeneration: input.expectedBlockingQuestionGeneration,
        note: input.note,
      });
      return mapTopicBlockingDecideResponse(response, unconfirmedMessage);
    },
    [
      agentKey,
      mainAgentId,
      onErrorToast,
      queryClient,
      sendDurableDecision,
      serverId,
      supportsButlerV1,
      t,
      workspaceId,
    ],
  );

  const handleConvertToTodo = useCallback(
    (input: {
      topic: TopicUnit;
      title: string;
      note?: string;
      sourceMessageId?: string;
      authorAgentId?: string;
    }) => {
      openTodoEditor({
        serverId,
        workspaceId,
        initialTitle: input.title,
        initialNote: input.note,
        source: {
          mainAgentId,
          topicKey: input.topic.topicKey,
          taskId: input.topic.taskId,
          rootMessageId: input.topic.rootMessageId,
          sourceMessageId: input.sourceMessageId,
          authorAgentId: input.authorAgentId,
          topicTitlePreview: input.topic.rootPrompt.text.slice(0, 80) || input.topic.topicKey,
        },
      });
    },
    [mainAgentId, openTodoEditor, serverId, workspaceId],
  );

  const handleToggleTodoStatus = useCallback(
    (todo: WorkspaceTodoItem) => {
      setTodoStatus.mutate({
        workspaceId,
        todoId: todo.todoId,
        expectedRevision: todo.revision,
        status: todo.status === "completed" ? "pending" : "completed",
      });
    },
    [setTodoStatus, workspaceId],
  );

  const handleEditTodo = useCallback(
    (todo: WorkspaceTodoItem) => {
      openTodoEditor({
        serverId,
        workspaceId,
        existingTodo: todo,
      });
    },
    [openTodoEditor, serverId, workspaceId],
  );

  const handleShowAllTopics = useCallback(() => {
    setUnreadOnly(agentKey, false);
  }, [agentKey, setUnreadOnly]);

  const handleLoadOlderPress = useCallback(() => {
    void loadOlder();
  }, [loadOlder]);

  // Read layoutVersion to ensure cards receive freshly measured cardLayout props after layout.
  const measuredLayoutSnapshot = useMemo(() => {
    void layoutVersion;
    return new Map(cardLayoutsRef.current);
  }, [layoutVersion]);

  return (
    <View style={styles.root} onLayout={handleViewportLayout} testID="topic-stream-list">
      <ScrollView
        ref={scrollViewRef}
        style={styles.scroll}
        contentContainerStyle={[
          styles.contentContainer,
          bottomClearance > 0
            ? inlineUnistylesStyle({ paddingBottom: bottomClearance + 24 })
            : null,
        ]}
        keyboardShouldPersistTaps="handled"
        onScroll={handleScroll}
        scrollEventThrottle={120}
      >
        {hasOlder ? (
          <View style={styles.loadOlderBar}>
            <Button
              size="sm"
              variant="ghost"
              disabled={isLoadingOlder}
              onPress={handleLoadOlderPress}
              testID="topic-stream-load-older"
            >
              {isLoadingOlder
                ? t("topicWorkbench.directory.loadingHistory")
                : t("topicWorkbench.directory.loadMoreHistory")}
            </Button>
          </View>
        ) : null}

        {visibleTopics.length === 0 ? (
          <View style={styles.emptyCard} testID="topic-stream-empty">
            <Text style={styles.emptyTitle}>
              {t(
                unreadOnly
                  ? "topicWorkbench.topicStream.emptyUnreadTitle"
                  : "topicWorkbench.topicStream.emptyQuietTitle",
              )}
            </Text>
            <Text style={styles.emptyDescription}>
              {t(
                unreadOnly
                  ? "topicWorkbench.topicStream.emptyUnreadDescription"
                  : "topicWorkbench.topicStream.emptyQuietDescription",
              )}
            </Text>
            {unreadOnly ? (
              <Button size="sm" variant="secondary" onPress={handleShowAllTopics}>
                {t("topicWorkbench.topicStream.showAllTopics")}
              </Button>
            ) : null}
          </View>
        ) : (
          visibleTopics.map((topic) => (
            <DisclosureRow
              key={topic.topicKey}
              rowId={topic.topicKey}
              viewportRef={disclosureViewportRef}
            >
              <TopicCardLayoutSlot
                topicKey={topic.topicKey}
                onRecordLayout={recordCardLayout}
                onClearLayout={clearCardLayout}
              >
                <TopicThreadCard
                  agentKey={agentKey}
                  serverId={serverId}
                  workspaceId={workspaceId}
                  topic={topic}
                  imageReader={imageReader}
                  isPaneFocused={isPaneFocused}
                  viewportBounds={viewportBounds}
                  cardLayout={measuredLayoutSnapshot.get(topic.topicKey) ?? null}
                  isHighlighted={highlightedTopicKey === topic.topicKey}
                  isReplying={replyingTopics.has(topic.topicKey)}
                  streamingConclusionId={streamingConclusionId}
                  isFlushingInbox={flushingTopicKey === topic.topicKey}
                  supportsButlerV1={supportsButlerV1}
                  durableItemsOnline={durableItemsOnline}
                  durableItemsConfirmed={durableItemsConfirmed}
                  onRefreshDurableItems={handleRefreshDurableItems}
                  onOpenStandaloneDurableItem={handleOpenStandaloneDurableItem}
                  onJumpToPeerTopic={handleJumpToPeerTopic}
                  onJumpToTopic={handleJumpToRedirectTarget}
                  onSubmitTopicDecision={handleSubmitTopicDecision}
                  onResumeTopicDecision={handleResumeTopicDecision}
                  onActivateCompactDecision={handleActivateCompactDecision}
                  readEpoch={projection.watermark.epoch}
                  onAutoMarkRead={handleAutoMarkRead}
                  onMarkTopicMode={handleMarkTopicMode}
                  onFlushTopicInbox={handleFlushTopicInbox}
                  onOpenAgentBeside={handleOpenAgentBeside}
                  onSubmitDesktopReply={handleSubmitDesktopReply}
                  onRetryTopic={supportsTopicThreads ? handleRetryTopic : undefined}
                  retryUploadNames={retryUploadNames}
                  onActivateCompactReply={handleActivateCompactReply}
                  onConvertToTodo={handleConvertToTodo}
                  onToggleTodoStatus={handleToggleTodoStatus}
                  onEditTodo={handleEditTodo}
                />
              </TopicCardLayoutSlot>
            </DisclosureRow>
          ))
        )}
        {pendingPermissionsNode}
      </ScrollView>
    </View>
  );
});

export function useTopicStreamMarkAllRead(input: {
  serverId: string;
  workspaceId: string;
  mainAgentId: string | null;
  streamItems: readonly StreamItem[];
  streamHead: readonly StreamItem[];
}) {
  const queryClient = useQueryClient();
  const { serverId, workspaceId, mainAgentId, streamItems, streamHead } = input;
  const enabled = Boolean(mainAgentId);
  const supportsTaskLedger = useHostFeature(serverId, "workspaceTaskLedger");
  const { query: tasksQuery } = useWorkspaceTasks(
    serverId,
    workspaceId,
    enabled && supportsTaskLedger,
  );
  const { entries: threadEntries, anchors: topicAnchors } = useWorkspaceTopicEntries(
    serverId,
    workspaceId,
    mainAgentId,
    enabled,
  );
  const { snapshot: readSnapshot } = useWorkspaceTopicReadState(
    serverId,
    workspaceId,
    mainAgentId,
    enabled,
  );
  const readScopeKey = useMemo(
    () => buildTopicInboxReadScopeKey({ serverId, workspaceId, mainAgentId }),
    [mainAgentId, serverId, workspaceId],
  );
  const legacyReadScope = useTopicInboxReadStore((state) => state.scopes[readScopeKey]);
  const agentRequiresAttention = useSessionStore((state) => {
    if (!mainAgentId) return false;
    const session = state.sessions[serverId];
    const agent = session?.agents.get(mainAgentId) ?? session?.agentDetails.get(mainAgentId);
    return agent?.requiresAttention === true;
  });

  const projection = useMemo(() => {
    if (!mainAgentId) return null;
    const combined = streamHead.length > 0 ? [...streamItems, ...streamHead] : [...streamItems];
    return projectTopicUnits({
      items: combined,
      tasks: tasksQuery.data,
      threadEntries,
      topicAnchors,
      readSnapshot,
      legacyReadScope,
      agentRequiresAttention,
    });
  }, [
    agentRequiresAttention,
    legacyReadScope,
    mainAgentId,
    readSnapshot,
    streamHead,
    streamItems,
    tasksQuery.data,
    threadEntries,
    topicAnchors,
  ]);

  const markAllRead = useCallback(() => {
    if (!mainAgentId || !projection) return;
    void markAllTopicsReadOnHost({
      queryClient,
      serverId,
      workspaceId,
      mainAgentId,
      epoch: projection.watermark.epoch,
      maxSeq: projection.watermark.maxSeq,
      maxTimestampMs: projection.watermark.maxTimestampMs,
      fallbackItemIds: projection.watermark.fallbackItemIds,
    }).catch(() => undefined);
  }, [mainAgentId, projection, queryClient, serverId, workspaceId]);

  return {
    totalUnreadTopics: projection?.totalUnreadTopics ?? 0,
    markAllRead,
  };
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[3],
  },
  loadOlderBar: {
    alignItems: "center",
    paddingVertical: theme.spacing[1],
  },
  emptyCard: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[8],
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
