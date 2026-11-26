import type { ComposerAttachment } from "@/attachments/types";
import { createQuoteAttachment, type QuoteComposerAttachment } from "@/attachments/quote";
import { QuoteTopicProvider, type ComposerQuote } from "@/assistant-selection-copy/composer-quote";
import type { TopicRetryCandidate } from "./model";
import type {
  TopicReplyRouteMode,
  WorkspaceDurableItem,
  WorkspaceTodoItem,
} from "@getpaseo/protocol/messages";
import {
  ArrowUpRight,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  Columns2,
  CornerDownRight,
  Inbox,
  Mail,
  MailOpen,
  MoreHorizontal,
  RotateCcw,
  Square,
} from "lucide-react-native";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useOpenKebabMenuVisibility } from "@/components/sidebar/use-open-kebab-menu-visibility";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import {
  buildDurableDecisionKey,
  buildTopicDisclosureKey,
  buildTopicReplyDraftKey,
  useTopicStreamViewStore,
} from "@/stores/topic-stream-view-store";
import type { Theme } from "@/styles/theme";
import { formatTodoDueTimestamp, isTodoOverdue } from "@/todos/model";
import { useDisclosureHold } from "../disclosure";
import { HoverEnvelope } from "./hover-envelope";
import type { TopicLifecycleStatus, TopicRedirectTarget, TopicReplyItem, TopicUnit } from "./model";
import { TopicConflictBanner } from "./topic-conflict-banner";
import {
  TopicDecisionSlot,
  TopicDecisionResume,
  type TopicDecisionSubmitInput,
  type TopicDecisionSubmitResult,
} from "./topic-decision-slot";
import { TopicInlineComposer } from "./topic-inline-composer";
import type { MessageImageReader } from "@/components/read-only-message-images";
import { TopicReplyRow, TopicUserMessage } from "./topic-reply-row";
import { type SeenTopicWatermark, useTopicViewportRead } from "./use-topic-viewport-read";

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const ThemedColumns2 = withUnistyles(Columns2, mutedIconMapping);
const ThemedMore = withUnistyles(MoreHorizontal, mutedIconMapping);
const ThemedChevronDown = withUnistyles(ChevronDown, mutedIconMapping);
const ThemedChevronRight = withUnistyles(ChevronRight, mutedIconMapping);
const ThemedInbox = withUnistyles(Inbox, mutedIconMapping);
const ThemedMail = withUnistyles(Mail, mutedIconMapping);
const ThemedMailOpen = withUnistyles(MailOpen, mutedIconMapping);
const ThemedCheckSquare = withUnistyles(CheckSquare, mutedIconMapping);
const ThemedSquare = withUnistyles(Square, mutedIconMapping);
const ThemedCheck = withUnistyles(Check, successIconMapping);
const ThemedClock = withUnistyles(Clock, dangerIconMapping);
const ThemedRetry = withUnistyles(RotateCcw, mutedIconMapping);
const ThemedCornerDownRight = withUnistyles(CornerDownRight, mutedIconMapping);
const ThemedArrowUpRight = withUnistyles(ArrowUpRight, mutedIconMapping);

const MAIL_ICON = <ThemedMail size={14} />;
const MAIL_OPEN_ICON = <ThemedMailOpen size={14} />;
const CHECK_SQUARE_ICON = <ThemedCheckSquare size={14} />;
const COLUMNS2_ICON = <ThemedColumns2 size={14} />;

const EXPANDED_STATE = { expanded: true } as const;
const COLLAPSED_STATE = { expanded: false } as const;
const CHECKED_STATE = { checked: true } as const;
const UNCHECKED_STATE = { checked: false } as const;

export interface TopicViewportBounds {
  scrollY: number;
  height: number;
  measured: boolean;
}

export interface TopicLayoutRect {
  y: number;
  height: number;
}

/**
 * Returns the single taskId that can be safely flushed locally for this topic card, or `null`
 * if the topic has no concrete taskId (preventing accidental global inbox flushes).
 */
export function resolveFlushableTaskId(topic: TopicUnit): string | null {
  if (topic.taskId) return topic.taskId;
  const distinctTaskIds = new Set(
    topic.pendingInboxItems
      .map((item) => item.taskId)
      .filter((taskId): taskId is string => typeof taskId === "string" && taskId.length > 0),
  );
  if (distinctTaskIds.size === 1) {
    return [...distinctTaskIds][0] ?? null;
  }
  return null;
}

function isRectMeaningfullySeen(
  absTop: number,
  height: number,
  viewTop: number,
  viewBottom: number,
  minPx: number,
): boolean {
  if (height <= 0) return false;
  const absBottom = absTop + height;
  const overlap = Math.min(absBottom, viewBottom) - Math.max(absTop, viewTop);
  if (overlap < Math.min(height, minPx)) return false;
  // For taller blocks, require either the bottom to be in view or at least half (capped at 160px) visible.
  if (height > minPx) {
    return absBottom <= viewBottom + 24 || overlap >= Math.min(height * 0.5, 160);
  }
  return true;
}

function computeSeenReplyPrefix(
  replies: TopicUnit["replies"],
  isVisible: (id: string) => boolean,
  epoch?: string | null,
): SeenTopicWatermark | null {
  let seenSeq: number | null = null;
  let seenTimestampMs = 0;
  let unseenSeq = Infinity;
  let unseenTimestampMs = Infinity;
  let reachedUnseenReply = false;
  const fallbackItemIds: string[] = [];

  for (const reply of replies) {
    if (!reply.isUnread) continue;
    const isSeen = !reachedUnseenReply && isVisible(reply.id);
    const seq =
      reply.kind === "thread_entry" || (epoch !== undefined && (!epoch || reply.epoch !== epoch))
        ? null
        : reply.seq;
    if (!isSeen) {
      reachedUnseenReply = true;
      if (seq !== null) unseenSeq = Math.min(unseenSeq, seq);
      unseenTimestampMs = Math.min(unseenTimestampMs, reply.timestampMs);
      continue;
    }
    if (seq !== null) seenSeq = Math.max(seenSeq ?? -1, seq);
    seenTimestampMs = Math.max(seenTimestampMs, reply.timestampMs);
    fallbackItemIds.push(reply.id);
  }

  if (fallbackItemIds.length === 0) return null;
  // Display order follows timestamps, which can differ from the daemon's sequence order.
  // Advance each watermark only if it cannot cover an unseen reply.
  return {
    seq: seenSeq !== null && seenSeq < unseenSeq ? seenSeq : null,
    timestampMs: seenTimestampMs < unseenTimestampMs ? seenTimestampMs : 0,
    fallbackItemIds,
  };
}

export function computeTopicReadSequence(topic: TopicUnit, epoch: string | null) {
  if (!epoch) return null;
  let seq = topic.rootPrompt.epoch === epoch ? topic.rootPrompt.seq : null;
  for (const reply of topic.replies) {
    if (reply.kind !== "thread_entry" && reply.epoch === epoch && reply.seq !== null) {
      seq = Math.max(seq ?? -1, reply.seq);
    }
  }
  return seq;
}

export function computeSeenTopicWatermark(input: {
  topic: TopicUnit;
  viewportBounds?: TopicViewportBounds;
  cardLayout?: TopicLayoutRect | null;
  railBodyOffsetY: number;
  replyLayouts: ReadonlyMap<string, TopicLayoutRect>;
  isVisibleInViewport?: boolean;
  epoch?: string | null;
}): SeenTopicWatermark | null {
  const {
    topic,
    viewportBounds,
    cardLayout,
    railBodyOffsetY,
    replyLayouts,
    isVisibleInViewport,
    epoch,
  } = input;
  if (!topic.hasUnread) return null;

  if (viewportBounds) {
    if (
      !viewportBounds.measured ||
      viewportBounds.height <= 0 ||
      !cardLayout ||
      cardLayout.height <= 0
    ) {
      return null;
    }
    const viewTop = viewportBounds.scrollY;
    const viewBottom = viewportBounds.scrollY + viewportBounds.height;

    if (topic.unreadReplyCount > 0) {
      return computeSeenReplyPrefix(
        topic.replies,
        (id) => {
          const rowLayout = replyLayouts.get(id);
          return Boolean(
            rowLayout &&
            isRectMeaningfullySeen(
              cardLayout.y + railBodyOffsetY + rowLayout.y,
              rowLayout.height,
              viewTop,
              viewBottom,
              48,
            ),
          );
        },
        epoch,
      );
    }

    if (isRectMeaningfullySeen(cardLayout.y, cardLayout.height, viewTop, viewBottom, 80)) {
      return {
        seq: epoch === undefined ? topic.latestSeq : computeTopicReadSequence(topic, epoch),
        timestampMs: topic.latestTimestampMs,
        fallbackItemIds: topic.replies.map((reply) => reply.id),
      };
    }
    return null;
  }

  // Fallback for direct component tests that pass explicit visibility without scroll viewport metrics.
  if (isVisibleInViewport === true) {
    return {
      seq: epoch === undefined ? topic.latestSeq : computeTopicReadSequence(topic, epoch),
      timestampMs: topic.latestTimestampMs,
      fallbackItemIds: topic.replies.filter((reply) => reply.isUnread).map((reply) => reply.id),
    };
  }
  return null;
}

function lifecycleBadgeVariant(status: TopicLifecycleStatus): StatusBadgeVariant {
  switch (status) {
    case "unread":
    case "completed":
      return "success";
    case "blocked":
    case "interrupted":
      return "warning";
    case "error":
      return "error";
    case "dispatching":
    case "aggregating":
    case "awaitingReport":
    case "replied":
      return "muted";
  }
}

function resolveAccentBarStyle(topic: TopicUnit) {
  if (topic.lifecycleStatus === "error") return styles.accentError;
  if (topic.lifecycleStatus === "blocked" || topic.lifecycleStatus === "interrupted") {
    return styles.accentWarning;
  }
  if (topic.hasUnread) return styles.accentUnread;
  return null;
}

const ReplyLayoutSlot = memo(function ReplyLayoutSlot({
  replyId,
  onRecordReplyLayout,
  children,
}: {
  replyId: string;
  onRecordReplyLayout: (replyId: string, event: LayoutChangeEvent) => void;
  children: React.ReactNode;
}) {
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onRecordReplyLayout(replyId, event),
    [onRecordReplyLayout, replyId],
  );
  return <View onLayout={handleLayout}>{children}</View>;
});

const TopicCardHeader = memo(function TopicCardHeader({
  topic,
  onOpenLeadBeside,
  onToggleReadMode,
  onConvertPromptToTodo,
}: {
  topic: TopicUnit;
  onOpenLeadBeside: () => void;
  onToggleReadMode: () => void;
  onConvertPromptToTodo: () => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHeaderHovered, setIsHeaderHovered] = useState(false);
  const { showKebab: showHeaderActions, menuProps } = useOpenKebabMenuVisibility(
    isHeaderHovered || isNative || isCompact,
  );

  return (
    <HoverEnvelope style={styles.headerEnvelope} onHoverChange={setIsHeaderHovered}>
      <View style={styles.headerRow}>
        <View style={styles.headerContent}>
          <View style={styles.headerMeta}>
            {topic.lifecycleStatus ? (
              <StatusBadge
                size="xs"
                variant={lifecycleBadgeVariant(topic.lifecycleStatus)}
                label={t(`topicWorkbench.topicStream.status.${topic.lifecycleStatus}`)}
              />
            ) : null}
            {topic.leadTitle ? (
              <Text style={styles.leadChip} numberOfLines={1}>
                {topic.leadTitle}
              </Text>
            ) : null}
          </View>
        </View>

        <View
          style={[
            styles.headerActions,
            showHeaderActions ? styles.actionsVisible : styles.actionsHidden,
          ]}
          pointerEvents={showHeaderActions ? "auto" : "none"}
        >
          {topic.leadAgentId ? (
            <ToolbarButton
              compact
              label={t("topicWorkbench.topicStream.openLeadBeside")}
              onPress={onOpenLeadBeside}
              testID={`topic-card-open-beside-${topic.topicKey}`}
            >
              <ThemedColumns2 size={14} />
            </ToolbarButton>
          ) : null}
          <DropdownMenu {...menuProps}>
            <ToolbarButton
              kind="menu"
              compact
              label={t("topicWorkbench.topicStream.moreActions")}
              testID={`topic-card-menu-${topic.topicKey}`}
            >
              <ThemedMore size={14} />
            </ToolbarButton>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                leading={topic.hasUnread ? MAIL_OPEN_ICON : MAIL_ICON}
                onSelect={onToggleReadMode}
                testID={`topic-card-toggle-read-${topic.topicKey}`}
              >
                {t(
                  topic.hasUnread
                    ? "topicWorkbench.topicStream.markRead"
                    : "topicWorkbench.topicStream.markUnread",
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                leading={CHECK_SQUARE_ICON}
                onSelect={onConvertPromptToTodo}
                testID={`topic-card-convert-todo-${topic.topicKey}`}
              >
                {t("topicWorkbench.topicStream.convertToTodo")}
              </DropdownMenuItem>
              {topic.leadAgentId ? (
                <DropdownMenuItem
                  leading={COLUMNS2_ICON}
                  onSelect={onOpenLeadBeside}
                  testID={`topic-card-menu-open-beside-${topic.topicKey}`}
                >
                  {t("topicWorkbench.topicStream.openLeadBeside")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      </View>
    </HoverEnvelope>
  );
});

function TopicRootPrompt({
  topic,
  imageReader,
}: {
  topic: TopicUnit;
  imageReader?: MessageImageReader;
}) {
  return topic.rootPrompt.item ||
    topic.rootPrompt.text ||
    topic.rootPrompt.imageAttachments?.length ? (
    <TopicUserMessage
      text={topic.rootPrompt.text}
      textTestId="topic-card-root-prompt"
      images={topic.rootPrompt.item?.images}
      imageAttachments={topic.rootPrompt.imageAttachments}
      imageReader={imageReader}
    />
  ) : (
    <Text style={styles.rootPromptText} testID="topic-card-root-prompt">
      {topic.task?.title || topic.topicKey}
    </Text>
  );
}

function isStreamingMainReply(reply: TopicReplyItem, id: string | undefined) {
  return (
    (reply.kind === "main_conclusion" || reply.kind === "main_progress") && reply.item.id === id
  );
}

const TopicLinkedTodoRow = memo(function TopicLinkedTodoRow({
  todo,
  onToggleTodoStatus,
  onEditTodo,
}: {
  todo: WorkspaceTodoItem;
  onToggleTodoStatus: (todo: WorkspaceTodoItem) => void;
  onEditTodo: (todo: WorkspaceTodoItem) => void;
}) {
  const { i18n } = useTranslation();
  const overdue = isTodoOverdue(todo);
  const completed = todo.status === "completed";
  const handleToggle = useCallback(() => onToggleTodoStatus(todo), [onToggleTodoStatus, todo]);
  const handleEdit = useCallback(() => onEditTodo(todo), [onEditTodo, todo]);

  return (
    <View
      style={[styles.todoRow, overdue && styles.todoRowOverdue]}
      testID={`topic-linked-todo-${todo.todoId}`}
    >
      <PressHighlight
        accessibilityRole="checkbox"
        accessibilityState={completed ? CHECKED_STATE : UNCHECKED_STATE}
        onPress={handleToggle}
        style={styles.todoCheckButton}
        testID={`topic-linked-todo-toggle-${todo.todoId}`}
      >
        {completed ? <ThemedCheck size={14} /> : <ThemedSquare size={14} />}
      </PressHighlight>
      <PressHighlight accessibilityRole="button" onPress={handleEdit} style={styles.todoTextButton}>
        <Text style={[styles.todoTitle, completed && styles.todoTitleCompleted]} numberOfLines={1}>
          {todo.title}
        </Text>
        {todo.dueAt ? (
          <View style={styles.todoDueChip}>
            {overdue ? <ThemedClock size={12} /> : null}
            <Text style={[styles.todoDueText, overdue && styles.todoDueOverdueText]}>
              {formatTodoDueTimestamp(todo.dueAt, i18n.resolvedLanguage)}
            </Text>
          </View>
        ) : null}
      </PressHighlight>
    </View>
  );
});

const TopicProcessDisclosure = memo(function TopicProcessDisclosure({
  topicKey,
  processSteps,
  expanded,
  onToggle,
}: {
  topicKey: string;
  processSteps: TopicUnit["processSteps"];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  if (processSteps.length === 0) return null;

  return (
    <View style={styles.processContainer} testID={`topic-process-card-${topicKey}`}>
      <PressHighlight
        accessibilityRole="button"
        accessibilityState={expanded ? EXPANDED_STATE : COLLAPSED_STATE}
        onPress={onToggle}
        style={styles.processToggle}
        testID={`topic-process-toggle-${topicKey}`}
      >
        {expanded ? <ThemedChevronDown size={14} /> : <ThemedChevronRight size={14} />}
        <Text style={styles.processSummaryText} numberOfLines={1}>
          {t("topicWorkbench.topicStream.processSummary", { count: processSteps.length })}
        </Text>
      </PressHighlight>
      {expanded ? (
        <View style={styles.processList} testID={`topic-process-steps-${topicKey}`}>
          {processSteps.map((step) => (
            <View key={step.id} style={styles.processStepRow}>
              <Text style={styles.processStepText} numberOfLines={2}>
                {step.kind === "tool_call" ? `${step.toolName} (${step.status})` : step.text}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
});

export interface TopicThreadCardProps {
  imageReader?: MessageImageReader;
  agentKey: string;
  serverId?: string;
  workspaceId?: string;
  topic: TopicUnit;
  isPaneFocused: boolean;
  /** Optional explicit override for isolated tests; production passes viewportBounds + cardLayout. */
  isVisibleInViewport?: boolean;
  viewportBounds?: TopicViewportBounds;
  cardLayout?: TopicLayoutRect | null;
  isHighlighted?: boolean;
  isReplying?: boolean;
  streamingConclusionId?: string;
  isFlushingInbox?: boolean;
  supportsButlerV1?: boolean;
  durableItemsOnline?: boolean;
  durableItemsConfirmed?: boolean;
  onRefreshDurableItems?: () => void;
  onOpenStandaloneDurableItem?: (item: WorkspaceDurableItem) => void;
  onJumpToPeerTopic?: (peerTaskId: string) => void;
  onJumpToTopic?: (target: TopicRedirectTarget) => void;
  onSubmitTopicDecision?: (input: TopicDecisionSubmitInput) => Promise<TopicDecisionSubmitResult>;
  onResumeTopicDecision?: (topicKey: string) => void;
  onActivateCompactDecision?: (
    topic: TopicUnit,
    question: string,
    blockingQuestionGeneration?: string,
  ) => void;
  readEpoch?: string | null;
  onAutoMarkRead: (input: {
    topicKey: string;
    seq: number | null;
    epoch?: string | null;
    timestampMs: number;
    fallbackItemIds: string[];
  }) => void;
  onMarkTopicMode: (topic: TopicUnit, mode: "read" | "unread") => void;
  onFlushTopicInbox: (topic: TopicUnit) => void;
  onOpenAgentBeside: (input: {
    targetAgentId: string;
    targetServerId?: string;
    topic: TopicUnit;
  }) => void;
  onSubmitDesktopReply: (
    topic: TopicUnit,
    text: string,
    routeMode: TopicReplyRouteMode,
    clientMessageId?: string,
    attachments?: ComposerAttachment[],
  ) => Promise<boolean> | boolean;
  onRetryTopic?: (topic: TopicUnit, retry: TopicRetryCandidate) => void;
  retryUploadNames?: ReadonlyMap<string, string[]>;
  onActivateCompactReply: (
    topic: TopicUnit,
    routeMode: TopicReplyRouteMode,
    quote?: QuoteComposerAttachment,
  ) => void;
  onConvertToTodo: (input: {
    topic: TopicUnit;
    title: string;
    note?: string;
    sourceMessageId?: string;
    authorAgentId?: string;
  }) => void;
  onToggleTodoStatus: (todo: WorkspaceTodoItem) => void;
  onEditTodo: (todo: WorkspaceTodoItem) => void;
}

const TopicCardDecision = memo(function TopicCardDecision({
  agentKey,
  serverId,
  workspaceId,
  topic,
  supportsButlerV1 = false,
  durableItemsOnline = true,
  durableItemsConfirmed,
  onRefreshDurableItems,
  onOpenStandaloneDurableItem,
  onSubmitTopicDecision,
  onResumeTopicDecision,
  onActivateCompactDecision,
}: Pick<
  TopicThreadCardProps,
  | "agentKey"
  | "serverId"
  | "workspaceId"
  | "topic"
  | "supportsButlerV1"
  | "durableItemsOnline"
  | "durableItemsConfirmed"
  | "onRefreshDurableItems"
  | "onOpenStandaloneDurableItem"
  | "onSubmitTopicDecision"
  | "onResumeTopicDecision"
  | "onActivateCompactDecision"
>) {
  const decisionKey = buildDurableDecisionKey(serverId, workspaceId, agentKey, topic.topicKey);
  const decisionIntent = useTopicStreamViewStore(
    (state) => state.durableDecisionIntents[decisionKey],
  );
  const prompt = topic.activeBlockingPrompt;
  return (
    <>
      {supportsButlerV1 && decisionIntent && onResumeTopicDecision ? (
        <TopicDecisionResume
          intent={decisionIntent}
          online={durableItemsOnline}
          onResume={onResumeTopicDecision}
        />
      ) : null}
      {prompt ? (
        <TopicDecisionSlot
          key={prompt.kind === "durable_item" ? `durable:${prompt.item.requestId}` : "blocking"}
          agentKey={agentKey}
          serverId={serverId}
          workspaceId={workspaceId}
          topic={topic}
          prompt={prompt}
          supportsButlerV1={supportsButlerV1}
          durableItemsOnline={durableItemsOnline}
          durableItemsConfirmed={durableItemsConfirmed}
          hasPendingDurableDecision={supportsButlerV1 && Boolean(decisionIntent)}
          onRefreshDurableItems={onRefreshDurableItems}
          onOpenStandaloneDurableItem={onOpenStandaloneDurableItem}
          onSubmitDecision={onSubmitTopicDecision}
          onActivateCompactDecision={onActivateCompactDecision}
        />
      ) : null}
    </>
  );
});

function RetryUploadBar({
  names,
  reply,
  disabled,
  onRetry,
}: {
  names: string[];
  reply: Extract<TopicReplyItem, { kind: "thread_entry" }>;
  disabled: boolean;
  onRetry: (reply: TopicReplyItem) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onRetry(reply), [onRetry, reply]);
  return (
    <View style={styles.retryBar}>
      <Text style={styles.retryLabel}>
        {t("topicWorkbench.topicStream.retryUploadFiles", { files: names.join(", ") })}
      </Text>
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled}
        onPress={handlePress}
        testID={`topic-reply-reupload-${reply.entry.entryId}`}
      >
        {t("topicWorkbench.topicStream.retryWithUpload")}
      </Button>
    </View>
  );
}

const TopicRedirectCard = memo(function TopicRedirectCard({
  topic,
  redirectedTo,
  onJumpToTopic,
}: {
  topic: TopicUnit;
  redirectedTo: TopicRedirectTarget;
  onJumpToTopic?: (target: TopicRedirectTarget) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onJumpToTopic?.(redirectedTo);
  }, [onJumpToTopic, redirectedTo]);

  const label = t(
    redirectedTo.mode === "merge"
      ? "topicWorkbench.topicStream.mergedIntoTopic"
      : "topicWorkbench.topicStream.attributedToTopic",
    { target: redirectedTo.title },
  );

  return (
    <View style={styles.redirectCard} testID={`topic-redirect-card-${topic.topicKey}`}>
      <PressHighlight
        accessibilityRole="button"
        disabled={!onJumpToTopic}
        onPress={handlePress}
        style={styles.redirectRow}
        testID={`topic-redirect-jump-${topic.topicKey}`}
      >
        <ThemedCornerDownRight size={13} />
        <Text style={styles.redirectText} numberOfLines={1}>
          {label}
        </Text>
        <View style={styles.redirectAction}>
          <Text style={styles.redirectActionText} numberOfLines={1}>
            {t("topicWorkbench.topicStream.viewTargetTopic")}
          </Text>
          <ThemedArrowUpRight size={13} />
        </View>
      </PressHighlight>
    </View>
  );
});

const TopicFullThreadCard = memo(function TopicFullThreadCard({
  agentKey,
  serverId,
  workspaceId,
  topic,
  imageReader,
  isPaneFocused,
  isVisibleInViewport,
  viewportBounds,
  cardLayout,
  isHighlighted = false,
  isReplying = false,
  streamingConclusionId,
  isFlushingInbox = false,
  supportsButlerV1,
  durableItemsOnline,
  durableItemsConfirmed,
  onRefreshDurableItems,
  onOpenStandaloneDurableItem,
  onJumpToPeerTopic,
  onSubmitTopicDecision,
  onResumeTopicDecision,
  onActivateCompactDecision,
  readEpoch,
  onAutoMarkRead,
  onMarkTopicMode,
  onFlushTopicInbox,
  onOpenAgentBeside,
  onSubmitDesktopReply,
  onRetryTopic,
  retryUploadNames,
  onActivateCompactReply,
  onConvertToTodo,
  onToggleTodoStatus,
  onEditTodo,
}: TopicThreadCardProps) {
  const { t } = useTranslation();
  const hold = useDisclosureHold();
  const isCompact = useIsCompactFormFactor();
  const [quoteFocusId, setQuoteFocusId] = useState<string>();

  const disclosureKey = buildTopicDisclosureKey(agentKey, topic.topicKey);
  const processExpanded = useTopicStreamViewStore(
    (state) => state.expandedProcessByTopicKey[disclosureKey] ?? false,
  );
  const setProcessExpanded = useTopicStreamViewStore((state) => state.setProcessExpanded);

  const [railBodyOffsetY, setRailBodyOffsetY] = useState(0);
  const replyLayoutsRef = useRef<Map<string, TopicLayoutRect>>(new Map());
  const [replyLayoutVersion, setReplyLayoutVersion] = useState(0);

  const handleRailBodyLayout = useCallback((event: LayoutChangeEvent) => {
    const nextY = event.nativeEvent.layout.y;
    setRailBodyOffsetY((current) => (current === nextY ? current : nextY));
  }, []);

  const handleRecordReplyLayout = useCallback((replyId: string, event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    const prev = replyLayoutsRef.current.get(replyId);
    if (prev && prev.y === y && prev.height === height) return;
    replyLayoutsRef.current.set(replyId, { y, height });
    setReplyLayoutVersion((v) => v + 1);
  }, []);

  const seenWatermark = useMemo(
    () =>
      computeSeenTopicWatermark({
        topic,
        viewportBounds,
        cardLayout,
        railBodyOffsetY,
        replyLayouts: replyLayoutsRef.current,
        isVisibleInViewport,
        epoch: readEpoch,
      }),
    // replyLayoutVersion intentionally triggers re-computation when reply rows finish measuring
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      cardLayout,
      isVisibleInViewport,
      railBodyOffsetY,
      readEpoch,
      replyLayoutVersion,
      topic,
      viewportBounds,
    ],
  );

  useTopicViewportRead({
    enabled: true,
    isPaneFocused,
    hasUnread: topic.hasUnread,
    topicKey: topic.topicKey,
    seenWatermark,
    epoch: readEpoch,
    onAutoMarkRead,
  });

  const toggleProcess = useCallback(() => {
    hold(() => setProcessExpanded(disclosureKey, !processExpanded));
  }, [disclosureKey, hold, processExpanded, setProcessExpanded]);

  const handleOpenLeadBeside = useCallback(() => {
    if (!topic.leadAgentId) return;
    onOpenAgentBeside({
      targetAgentId: topic.leadAgentId,
      targetServerId: topic.leadServerId,
      topic,
    });
  }, [onOpenAgentBeside, topic]);

  const handleToggleReadMode = useCallback(() => {
    onMarkTopicMode(topic, topic.hasUnread ? "read" : "unread");
  }, [onMarkTopicMode, topic]);

  const handleOpenReplyAgentBeside = useCallback(
    (targetAgentId: string, targetServerId?: string) => {
      onOpenAgentBeside({ targetAgentId, targetServerId, topic });
    },
    [onOpenAgentBeside, topic],
  );

  const handleConvertPromptToTodo = useCallback(() => {
    const raw = topic.rootPrompt.text.trim();
    const title = raw.length > 90 ? `${raw.slice(0, 89)}…` : raw;
    onConvertToTodo({
      topic,
      title,
      sourceMessageId: topic.rootMessageId,
    });
  }, [onConvertToTodo, topic]);

  const handleConvertReplyToTodo = useCallback(
    (input: { title: string; note?: string; sourceMessageId?: string; authorAgentId?: string }) => {
      onConvertToTodo({ topic, ...input });
    },
    [onConvertToTodo, topic],
  );

  const handleSubmitDesktop = useCallback(
    (
      text: string,
      routeMode: TopicReplyRouteMode,
      clientMessageId: string,
      attachments?: ComposerAttachment[],
    ) => onSubmitDesktopReply(topic, text, routeMode, clientMessageId, attachments),
    [onSubmitDesktopReply, topic],
  );

  const handleRetryTopic = useCallback(() => {
    if (!topic.retryCandidate || isReplying) return;
    onRetryTopic?.(topic, topic.retryCandidate);
  }, [isReplying, onRetryTopic, topic]);

  const handleRetryReply = useCallback(
    (reply: TopicReplyItem) => {
      if (isReplying || reply.kind !== "thread_entry" || reply.entry.retryable !== true) return;
      onRetryTopic?.(topic, { entryId: reply.entry.entryId, text: reply.entry.text });
    },
    [isReplying, onRetryTopic, topic],
  );

  const handleActivateCompact = useCallback(
    (routeMode: TopicReplyRouteMode) => onActivateCompactReply(topic, routeMode),
    [onActivateCompactReply, topic],
  );
  const handleQuote = useCallback(
    ({ quote, label, topicKey, rootMessageId, taskId, sourceMessageId }: ComposerQuote) => {
      if (isReplying) return;
      const attachment = createQuoteAttachment({
        text: quote,
        label,
        topicKey: topicKey ?? topic.topicKey,
        rootMessageId: rootMessageId ?? topic.rootMessageId,
        taskId: taskId ?? topic.taskId,
        sourceMessageId,
      });
      if (!attachment.text) return;
      if (isCompact) {
        onActivateCompactReply(topic, "auto", attachment);
        return;
      }
      const draftKey = buildTopicReplyDraftKey({
        serverId: serverId ?? "",
        workspaceId: workspaceId ?? "",
        agentId: agentKey,
        topicKey: topic.topicKey,
      });
      useTopicStreamViewStore.getState().updateInlineReplyDraft(draftKey, (draft) => ({
        ...draft,
        attachments: [...draft.attachments, attachment],
      }));
      setQuoteFocusId(attachment.id);
    },
    [agentKey, isCompact, isReplying, onActivateCompactReply, serverId, topic, workspaceId],
  );
  const topicQuoteContext = useMemo(
    () => ({
      topicKey: topic.topicKey,
      rootMessageId: topic.rootMessageId,
      taskId: topic.taskId,
    }),
    [topic.rootMessageId, topic.taskId, topic.topicKey],
  );

  const flushableTaskId = resolveFlushableTaskId(topic);
  const handleFlushInbox = useCallback(() => {
    if (!flushableTaskId) return;
    onFlushTopicInbox(topic);
  }, [flushableTaskId, onFlushTopicInbox, topic]);

  const accentBarStyle = resolveAccentBarStyle(topic);
  const showRetryBanner =
    (topic.lifecycleStatus === "error" || topic.lifecycleStatus === "interrupted") &&
    topic.retryCandidate !== null &&
    !retryUploadNames?.has(topic.retryCandidate.entryId) &&
    Boolean(onRetryTopic);

  return (
    <QuoteTopicProvider topic={topicQuoteContext}>
      <View
        style={[styles.card, isHighlighted && styles.cardHighlighted]}
        testID={`topic-thread-card-${topic.topicKey}`}
      >
        {accentBarStyle ? (
          <View style={[styles.accentBar, accentBarStyle]} testID="topic-card-accent-bar" />
        ) : null}

        <TopicCardHeader
          topic={topic}
          onOpenLeadBeside={handleOpenLeadBeside}
          onToggleReadMode={handleToggleReadMode}
          onConvertPromptToTodo={handleConvertPromptToTodo}
        />

        <TopicRootPrompt topic={topic} imageReader={imageReader} />

        <View style={styles.railBody} onLayout={handleRailBodyLayout}>
          {topic.fileConflicts.length > 0 ? (
            <TopicConflictBanner
              agentKey={agentKey}
              topicKey={topic.topicKey}
              conflicts={topic.fileConflicts}
              onJumpToPeerTopic={onJumpToPeerTopic}
            />
          ) : null}

          <TopicProcessDisclosure
            topicKey={topic.topicKey}
            processSteps={topic.processSteps}
            expanded={processExpanded}
            onToggle={toggleProcess}
          />

          {topic.replies.map((reply, index) => {
            const uploadNames =
              reply.kind === "thread_entry" && reply.entry.retryable === true
                ? retryUploadNames?.get(reply.entry.entryId)
                : undefined;
            return (
              <ReplyLayoutSlot
                key={reply.id}
                replyId={reply.id}
                onRecordReplyLayout={handleRecordReplyLayout}
              >
                <TopicReplyRow
                  agentKey={agentKey}
                  topicKey={topic.topicKey}
                  reply={reply}
                  imageReader={imageReader}
                  showNewDivider={topic.firstUnreadReplyIndex === index}
                  unreadCountForDivider={topic.unreadReplyCount}
                  isRetrying={isReplying}
                  isStreaming={isStreamingMainReply(reply, streamingConclusionId) || undefined}
                  onQuote={handleQuote}
                  onOpenAgentBeside={handleOpenReplyAgentBeside}
                  onConvertToTodo={handleConvertReplyToTodo}
                  onRetryReply={
                    onRetryTopic &&
                    !uploadNames &&
                    reply.kind === "thread_entry" &&
                    reply.entry.retryable === true
                      ? handleRetryReply
                      : undefined
                  }
                />
                {uploadNames && onRetryTopic && reply.kind === "thread_entry" ? (
                  <RetryUploadBar
                    names={uploadNames}
                    reply={reply}
                    disabled={isReplying}
                    onRetry={handleRetryReply}
                  />
                ) : null}
              </ReplyLayoutSlot>
            );
          })}

          {showRetryBanner ? (
            <View style={styles.retryBar} testID={`topic-card-retry-bar-${topic.topicKey}`}>
              <Text style={styles.retryLabel} numberOfLines={1}>
                {t(`topicWorkbench.topicStream.status.${topic.lifecycleStatus}`)}
              </Text>
              <Button
                size="sm"
                variant="secondary"
                disabled={isReplying}
                onPress={handleRetryTopic}
                testID={`topic-card-retry-${topic.topicKey}`}
              >
                <ThemedRetry size={12} />
                {t("topicWorkbench.topicStream.retryInTopic")}
              </Button>
            </View>
          ) : null}

          {topic.pendingInboxItems.length > 0 ? (
            <View style={styles.aggregatingBar} testID={`topic-pending-inbox-${topic.topicKey}`}>
              <ThemedInbox size={14} />
              <Text style={styles.aggregatingText} numberOfLines={1}>
                {t("topicWorkbench.topicStream.aggregatingPending", {
                  count: topic.pendingInboxItems.length,
                })}
              </Text>
              {flushableTaskId ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={isFlushingInbox}
                  onPress={handleFlushInbox}
                  testID={`topic-flush-inbox-${topic.topicKey}`}
                >
                  {t("topicWorkbench.topicStream.flushTopicNow")}
                </Button>
              ) : null}
            </View>
          ) : null}

          {topic.linkedTodos.length > 0 ? (
            <View style={styles.todoStrip} testID={`topic-linked-todos-${topic.topicKey}`}>
              {topic.linkedTodos.map((todo) => (
                <TopicLinkedTodoRow
                  key={todo.todoId}
                  todo={todo}
                  onToggleTodoStatus={onToggleTodoStatus}
                  onEditTodo={onEditTodo}
                />
              ))}
            </View>
          ) : null}

          <TopicCardDecision
            agentKey={agentKey}
            serverId={serverId}
            workspaceId={workspaceId}
            topic={topic}
            supportsButlerV1={supportsButlerV1}
            durableItemsOnline={durableItemsOnline}
            durableItemsConfirmed={durableItemsConfirmed}
            onRefreshDurableItems={onRefreshDurableItems}
            onOpenStandaloneDurableItem={onOpenStandaloneDurableItem}
            onSubmitTopicDecision={onSubmitTopicDecision}
            onResumeTopicDecision={onResumeTopicDecision}
            onActivateCompactDecision={onActivateCompactDecision}
          />

          <TopicInlineComposer
            agentKey={agentKey}
            serverId={serverId}
            workspaceId={workspaceId}
            topicKey={topic.topicKey}
            leadTitle={topic.leadTitle}
            hasLeadAgent={Boolean(topic.leadAgentId)}
            isSubmitting={isReplying}
            quoteFocusId={quoteFocusId}
            onSubmitDesktopReply={handleSubmitDesktop}
            onActivateCompactReply={handleActivateCompact}
          />
        </View>
      </View>
    </QuoteTopicProvider>
  );
});

export const TopicThreadCard = memo(function TopicThreadCard(props: TopicThreadCardProps) {
  if (props.topic.redirectedTo) {
    return (
      <TopicRedirectCard
        topic={props.topic}
        redirectedTo={props.topic.redirectedTo}
        onJumpToTopic={props.onJumpToTopic}
      />
    );
  }
  return <TopicFullThreadCard {...props} />;
});

const styles = StyleSheet.create((theme) => ({
  card: {
    position: "relative",
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    overflow: "hidden",
  },
  cardHighlighted: {
    borderColor: theme.colors.borderAccent,
  },
  accentBar: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
  },
  accentUnread: {
    backgroundColor: theme.colors.statusSuccess,
  },
  accentWarning: {
    backgroundColor: theme.colors.statusWarning,
  },
  accentError: {
    backgroundColor: theme.colors.statusDanger,
  },
  headerEnvelope: {
    position: "relative",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  headerContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  headerMeta: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  leadChip: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  rootPromptText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    lineHeight: theme.lineHeight.content,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0.5],
    minHeight: 28,
  },
  actionsVisible: {
    opacity: 1,
  },
  actionsHidden: {
    opacity: 0,
  },
  railBody: {
    paddingLeft: theme.spacing[3],
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  processContainer: {
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  processToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
  },
  processSummaryText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  processList: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
  processStepRow: {
    paddingVertical: theme.spacing[0.5],
  },
  processStepText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  retryBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusWarning,
    backgroundColor: theme.colors.surface0,
  },
  retryLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  aggregatingBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  aggregatingText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  todoStrip: {
    gap: theme.spacing[1],
  },
  todoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  todoRowOverdue: {
    borderColor: theme.colors.statusDanger,
  },
  todoCheckButton: {
    padding: theme.spacing[0.5],
  },
  todoTextButton: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  todoTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  todoTitleCompleted: {
    color: theme.colors.foregroundMuted,
    textDecorationLine: "line-through",
  },
  todoDueChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  todoDueText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  todoDueOverdueText: {
    color: theme.colors.statusDanger,
    fontWeight: theme.fontWeight.medium,
  },
  redirectCard: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  redirectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
  },
  redirectText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  redirectAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0.5],
  },
  redirectActionText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
