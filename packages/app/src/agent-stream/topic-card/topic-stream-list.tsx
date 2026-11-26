import type { TopicReplyRouteMode, WorkspaceTodoItem } from "@getpaseo/protocol/messages";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCheck, Filter, Plus } from "lucide-react-native";
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
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { composePromptTextWithQuotes, createQuoteAttachment } from "@/attachments/quote";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useWorkspaceTasks } from "@/composer/workspace-task-ledger/query";
import { useWorkspaceDurableItems } from "@/durable-items/queries";
import { useLoadOlderAgentHistory } from "@/hooks/use-load-older-agent-history";
import { usePaneContext } from "@/panels/pane-context";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore, useHostRuntimeClient } from "@/runtime/host-runtime";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import {
  buildTopicInboxReadScopeKey,
  useTopicInboxReadStore,
} from "@/stores/topic-inbox-read-store";
import {
  buildTopicAgentKey,
  useTopicStreamViewStore,
  type PendingTopicScrollTarget,
  type TopicStreamViewMode,
} from "@/stores/topic-stream-view-store";
import type { Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { openSubagentFromTopic } from "@/subagents/open-from-topic";
import {
  useOptionalTeamMessageJumpStore,
  usePendingTeamMessageJump,
} from "@/subagents/team-directory/message-jump-store";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import { useSetWorkspaceTodoStatus, useWorkspaceTodos } from "@/todos/queries";
import {
  markAllTopicsReadOnHost,
  markTopicReadOnHost,
  useWorkspaceTopicReadState,
} from "@/topic-read/queries";
import { replyToWorkspaceTopic, useWorkspaceTopicEntries } from "@/topic-threads/queries";
import type { PendingPermission } from "@/types/shared";
import { generateMessageId, type StreamItem } from "@/types/stream";
import { DisclosureRow } from "../disclosure";
import type { DisclosureTriggerEdge, StreamViewportHandle } from "../strategy";
import { projectTopicUnits, type TopicUnit } from "./model";
import {
  resolveFlushableTaskId,
  TopicThreadCard,
  type TopicLayoutRect,
  type TopicViewportBounds,
} from "./topic-thread-card";

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedCheckCheck = withUnistyles(CheckCheck, mutedIconMapping);
const ThemedPlus = withUnistyles(Plus, mutedIconMapping);
const ThemedFilter = withUnistyles(Filter, mutedIconMapping);
const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;
const MAX_JUMP_HISTORY_FETCHES = 4;

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
  if (jump.itemId) {
    if (topic.rootItemId === jump.itemId) return true;
    if (topic.replies.some((reply) => reply.id === jump.itemId)) return true;
  }
  if (jump.messageId) {
    if (topic.rootMessageId === jump.messageId) return true;
    if (
      topic.replies.some(
        (reply) =>
          (reply.kind === "main_conclusion" && reply.messageId === jump.messageId) ||
          (reply.kind === "thread_entry" && reply.entry.sourceMessageId === jump.messageId),
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
  if (topic.topicKey === target.topicKey) return true;
  if (target.taskId && topic.taskId === target.taskId) return true;
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
  } else if (target.topicKey.startsWith("task:")) {
    const rawTaskId = target.topicKey.slice(5);
    if (topic.taskId === rawTaskId) return true;
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

export interface TopicStreamTopBarProps {
  serverId: string;
  workspaceId: string;
  mainAgentId: string;
  viewMode: TopicStreamViewMode;
  unreadOnly: boolean;
  totalUnreadTopics: number;
  onChangeViewMode: (mode: TopicStreamViewMode) => void;
  onToggleUnreadOnly: () => void;
  onMarkAllRead: () => void;
  onOpenAddTodo: () => void;
}

export const TopicStreamTopBar = memo(function TopicStreamTopBar({
  viewMode,
  unreadOnly,
  totalUnreadTopics,
  onChangeViewMode,
  onToggleUnreadOnly,
  onMarkAllRead,
  onOpenAddTodo,
}: TopicStreamTopBarProps) {
  const { t } = useTranslation();
  const modeOptions = useMemo<SegmentedControlOption<TopicStreamViewMode>[]>(
    () => [
      {
        value: "topics",
        label: t("topicWorkbench.topicStream.modeTopics"),
        testID: "topic-stream-mode-topics",
      },
      {
        value: "timeline",
        label: t("topicWorkbench.topicStream.modeTimeline"),
        testID: "topic-stream-mode-timeline",
      },
    ],
    [t],
  );

  return (
    <View style={styles.topBar} testID="topic-stream-top-bar">
      <SegmentedControl
        size="sm"
        options={modeOptions}
        value={viewMode}
        onValueChange={onChangeViewMode}
        testID="topic-stream-mode-switch"
      />
      <View style={styles.topBarActions}>
        {viewMode === "topics" ? (
          <PressHighlight
            accessibilityRole="button"
            accessibilityState={unreadOnly ? SELECTED_STATE : UNSELECTED_STATE}
            onPress={onToggleUnreadOnly}
            style={[styles.unreadOnlyPill, unreadOnly && styles.unreadOnlyPillActive]}
            testID="topic-stream-unread-only"
          >
            <ThemedFilter size={13} />
            <Text style={[styles.unreadOnlyText, unreadOnly && styles.unreadOnlyTextActive]}>
              {t("topicWorkbench.topicStream.unreadOnly")}
            </Text>
          </PressHighlight>
        ) : null}
        <ToolbarButton
          compact
          disabled={totalUnreadTopics === 0}
          label={t("topicWorkbench.topicStream.markAllRead")}
          onPress={onMarkAllRead}
          testID="topic-stream-mark-all-read"
        >
          <ThemedCheckCheck size={14} />
        </ToolbarButton>
        <ToolbarButton
          compact
          label={t("topicWorkbench.topicStream.addTodo")}
          onPress={onOpenAddTodo}
          testID="topic-stream-add-todo"
        >
          <ThemedPlus size={14} />
        </ToolbarButton>
      </View>
    </View>
  );
});

export interface TopicStreamListProps {
  serverId: string;
  workspaceId: string;
  mainAgentId: string;
  streamItems: readonly StreamItem[];
  streamHead: readonly StreamItem[];
  pendingPermissions: readonly PendingPermission[];
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

export const TopicStreamList = memo(function TopicStreamList({
  serverId,
  workspaceId,
  mainAgentId,
  streamItems,
  streamHead,
  pendingPermissions,
  isTurnActive,
  isPaneFocused,
  bottomClearance = 0,
  onFocusCompactComposer,
  onErrorToast,
}: TopicStreamListProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const paneActive = useRetainedPanelActive();
  const { tabId } = usePaneContext();

  const agentKey = buildTopicAgentKey(serverId, mainAgentId);
  const unreadOnly = useTopicStreamViewStore(
    (state) => state.unreadOnlyByAgentKey[agentKey] ?? false,
  );
  const setUnreadOnly = useTopicStreamViewStore((state) => state.setUnreadOnly);
  const setActiveReplyTopic = useTopicStreamViewStore((state) => state.setActiveReplyTopic);
  const openTodoEditor = useTopicStreamViewStore((state) => state.openTodoEditor);

  const supportsTopicThreads = useHostFeature(serverId, "workspaceTopicThreads");
  const supportsTaskLedger = useHostFeature(serverId, "workspaceTaskLedger");

  const { query: tasksQuery } = useWorkspaceTasks(
    serverId,
    workspaceId,
    paneActive && supportsTaskLedger,
  );
  const { entries: threadEntries } = useWorkspaceTopicEntries(
    serverId,
    workspaceId,
    mainAgentId,
    paneActive,
  );
  const { snapshot: readSnapshot } = useWorkspaceTopicReadState(
    serverId,
    workspaceId,
    mainAgentId,
    paneActive,
  );
  const { items: workspaceTodos } = useWorkspaceTodos(serverId, workspaceId, paneActive);
  const { result: durableResult } = useWorkspaceDurableItems(serverId, workspaceId, isPaneFocused);
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
  const sessionAgents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const isTimelineSynced = useSessionStore(
    (state) => selectAgentTimelineState(state.sessions[serverId], mainAgentId).status === "synced",
  );

  const agentTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, agent] of sessionAgents ?? []) {
      if (agent.title?.trim()) map.set(id, agent.title.trim());
    }
    return map;
  }, [sessionAgents]);

  const combinedItems = useMemo(
    () => (streamHead.length > 0 ? [...streamItems, ...streamHead] : [...streamItems]),
    [streamHead, streamItems],
  );

  const projection = useMemo(
    () =>
      projectTopicUnits({
        items: combinedItems,
        tasks: tasksQuery.data,
        threadEntries,
        pendingInboxItems,
        todos: workspaceTodos,
        durableItems: durableResult.data,
        pendingPermissions,
        readSnapshot,
        legacyReadScope,
        isTurnActive,
        agentRequiresAttention,
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
      readSnapshot,
      tasksQuery.data,
      threadEntries,
      workspaceTodos,
    ],
  );

  const visibleTopics = useMemo(
    () => (unreadOnly ? projection.topics.filter((topic) => topic.hasUnread) : projection.topics),
    [projection.topics, unreadOnly],
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
  const [replyingTopicKey, setReplyingTopicKey] = useState<string | null>(null);
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
        seq: input.seq ?? undefined,
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
        seq: topic.latestSeq ?? undefined,
        timestampMs: topic.latestTimestampMs,
        fallbackItemIds: topic.replies.map((reply) => reply.id),
      }).catch((err) => {
        onErrorToast?.(err instanceof Error ? err.message : String(err));
      });
    },
    [mainAgentId, onErrorToast, queryClient, serverId, workspaceId],
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

  const handleSubmitDesktopReply = useCallback(
    async (
      topic: TopicUnit,
      text: string,
      routeMode: TopicReplyRouteMode,
      clientMessageId?: string,
    ): Promise<boolean> => {
      const effectiveMessageId = clientMessageId?.trim() || generateMessageId();
      if (!supportsTopicThreads) {
        if (!client) {
          onErrorToast?.(t("workspace.terminal.hostDisconnected"));
          return false;
        }
        setReplyingTopicKey(topic.topicKey);
        try {
          const preview = topic.rootPrompt.text.slice(0, 120) || topic.topicKey;
          const quote = createQuoteAttachment({
            text: preview,
            label: topic.leadTitle || topic.topicKey,
          });
          const quotedText = composePromptTextWithQuotes(text, quote.text ? [quote] : []);
          await client.sendAgentMessage(mainAgentId, quotedText, {
            messageId: effectiveMessageId,
          });
          return true;
        } catch (err) {
          onErrorToast?.(err instanceof Error ? err.message : String(err));
          return false;
        } finally {
          setReplyingTopicKey((current) => (current === topic.topicKey ? null : current));
        }
      }
      setReplyingTopicKey(topic.topicKey);
      try {
        await replyToWorkspaceTopic({
          queryClient,
          serverId,
          workspaceId,
          mainAgentId,
          topicKey: topic.topicKey,
          taskId: topic.taskId,
          rootMessageId: topic.rootMessageId,
          clientMessageId: effectiveMessageId,
          text,
          routeMode,
        });
        return true;
      } catch (err) {
        onErrorToast?.(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setReplyingTopicKey((current) => (current === topic.topicKey ? null : current));
      }
    },
    [
      client,
      mainAgentId,
      onErrorToast,
      queryClient,
      serverId,
      supportsTopicThreads,
      t,
      workspaceId,
    ],
  );

  const handleActivateCompactReply = useCallback(
    (topic: TopicUnit, routeMode: TopicReplyRouteMode) => {
      setActiveReplyTopic(agentKey, {
        topicKey: topic.topicKey,
        taskId: topic.taskId,
        rootMessageId: topic.rootMessageId,
        leadAgentId: topic.leadAgentId,
        leadTitle: topic.leadTitle,
        promptPreview: topic.rootPrompt.text.slice(0, 60),
        routeMode,
      });
      onFocusCompactComposer?.();
    },
    [agentKey, onFocusCompactComposer, setActiveReplyTopic],
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
                  topic={topic}
                  isPaneFocused={isPaneFocused}
                  viewportBounds={viewportBounds}
                  cardLayout={measuredLayoutSnapshot.get(topic.topicKey) ?? null}
                  isHighlighted={highlightedTopicKey === topic.topicKey}
                  isReplying={replyingTopicKey === topic.topicKey}
                  isFlushingInbox={flushingTopicKey === topic.topicKey}
                  onAutoMarkRead={handleAutoMarkRead}
                  onMarkTopicMode={handleMarkTopicMode}
                  onFlushTopicInbox={handleFlushTopicInbox}
                  onOpenAgentBeside={handleOpenAgentBeside}
                  onSubmitDesktopReply={handleSubmitDesktopReply}
                  onActivateCompactReply={handleActivateCompactReply}
                  onConvertToTodo={handleConvertToTodo}
                  onToggleTodoStatus={handleToggleTodoStatus}
                  onEditTodo={handleEditTodo}
                />
              </TopicCardLayoutSlot>
            </DisclosureRow>
          ))
        )}
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
  const { entries: threadEntries } = useWorkspaceTopicEntries(
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
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  topBarActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  unreadOnlyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  unreadOnlyPillActive: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
  },
  unreadOnlyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  unreadOnlyTextActive: {
    color: theme.colors.foreground,
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
