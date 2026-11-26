import type { MessageImageAttachment } from "@getpaseo/protocol/agent-types";
import {
  ReadOnlyMessageImages,
  type MessageImageReader,
} from "@/components/read-only-message-images";
import { useUserMessageAlignment } from "@/hooks/use-settings";
import type { UserMessageImageAttachment } from "@/types/stream";
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Columns2,
  CornerDownRight,
  Quote,
  RotateCcw,
  Sparkles,
} from "lucide-react-native";
import { memo, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ComposerQuote } from "@/assistant-selection-copy/composer-quote";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { buildTopicDisclosureKey, useTopicStreamViewStore } from "@/stores/topic-stream-view-store";
import type { Theme } from "@/styles/theme";
import type { AgentSourceStatus } from "../agent-interactions";
import { useDisclosureHold } from "../disclosure";
import {
  extractReplyQuoteSummary,
  extractScopedWebSelection,
  extractSubagentPreviewText,
} from "../reply-quote";
import { HoverEnvelope } from "./hover-envelope";
import type { TopicReplyItem } from "./model";

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const ThemedColumns2 = withUnistyles(Columns2, mutedIconMapping);
const ThemedCheckSquare = withUnistyles(CheckSquare, mutedIconMapping);
const ThemedChevronDown = withUnistyles(ChevronDown, mutedIconMapping);
const ThemedChevronRight = withUnistyles(ChevronRight, mutedIconMapping);
const ThemedSparkles = withUnistyles(Sparkles, accentIconMapping);
const ThemedCornerDownRight = withUnistyles(CornerDownRight, mutedIconMapping);
const ThemedRetry = withUnistyles(RotateCcw, mutedIconMapping);
const ThemedQuote = withUnistyles(Quote, mutedIconMapping);

const COLLAPSE_THRESHOLD_CHARS = 260;
const toggleBoolean = (value: boolean) => !value;

function statusVariant(status: AgentSourceStatus): StatusBadgeVariant {
  switch (status) {
    case "completed":
    case "finished":
      return "success";
    case "blocked":
    case "permission-required":
      return "warning";
    case "error":
      return "error";
    case "closed":
    case "message":
      return "muted";
  }
}

function statusLabelKey(status: AgentSourceStatus): string {
  switch (status) {
    case "message":
      return "agentStream.source.status.message";
    case "finished":
      return "agentStream.source.status.finished";
    case "completed":
      return "agentStream.source.status.completed";
    case "blocked":
      return "agentStream.source.status.blocked";
    case "error":
      return "agentStream.source.status.error";
    case "permission-required":
      return "agentStream.source.status.permission";
    case "closed":
      return "agentStream.source.status.closed";
  }
}

function extractFirstTodoLine(rawText: string): string {
  const firstLine =
    rawText
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/^#+\s*/, "")
          .replace(/^[-*>]\s+/, "")
          .trim(),
      )
      .find((line) => line.length > 0) ?? rawText.trim();
  return firstLine.length > 90 ? `${firstLine.slice(0, 89)}…` : firstLine;
}

function resolveReplySourceMessageId(reply: TopicReplyItem): string | undefined {
  if (reply.kind === "main_conclusion" || reply.kind === "main_progress") return reply.messageId;
  if (reply.kind === "thread_entry") return reply.entry.sourceMessageId;
  return reply.id;
}

function resolveReplyAuthorAgentId(reply: TopicReplyItem): string | undefined {
  if (reply.kind === "subagent_report") return reply.senderId;
  if (reply.kind === "thread_entry") return reply.entry.authorAgentId;
  return undefined;
}

export function TopicUserMessage({
  text,
  textTestId,
  images,
  imageAttachments,
  imageReader,
  children,
}: {
  text: string;
  textTestId?: string;
  images?: readonly UserMessageImageAttachment[];
  imageAttachments?: readonly MessageImageAttachment[];
  imageReader?: MessageImageReader;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const alignment = useUserMessageAlignment();
  return (
    <View
      style={[
        styles.userBubble,
        alignment === "left" ? styles.userBubbleLeft : styles.userBubbleRight,
      ]}
      testID="topic-user-message"
    >
      <Text style={styles.userLabel}>{t("topicWorkbench.topicStream.userMessageLabel")}</Text>
      {images?.length || imageAttachments?.length ? (
        <ReadOnlyMessageImages
          images={images}
          imageAttachments={imageAttachments}
          imageReader={imageReader}
        />
      ) : null}
      {text || textTestId ? (
        <Text style={styles.bodyText} testID={textTestId}>
          {text}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

export interface TopicReplyRowProps {
  agentKey?: string;
  topicKey?: string;
  reply: TopicReplyItem;
  imageReader?: MessageImageReader;
  showNewDivider?: boolean;
  unreadCountForDivider?: number;
  isRetrying?: boolean;
  isStreaming?: boolean;
  quoteLabel?: string;
  onQuote?: (input: ComposerQuote) => void;
  onOpenAgentBeside: (agentId: string, serverId?: string) => void;
  onConvertToTodo: (input: {
    title: string;
    note?: string;
    sourceMessageId?: string;
    authorAgentId?: string;
  }) => void;
  onRetryReply?: (reply: TopicReplyItem) => void;
}

function TopicReplyQuoteButton({
  id,
  text,
  sourceTitle,
  bodyRef,
  quoteLabel,
  onQuote,
}: {
  id: string;
  text: string;
  sourceTitle: string;
  bodyRef: React.RefObject<View | null>;
  quoteLabel?: string;
  onQuote?: TopicReplyRowProps["onQuote"];
}) {
  const { t } = useTranslation();
  // The button can clear the selection before onPress, so capture it before focus moves.
  const captured = useRef<{ selection: string | null } | null>(null);
  const readSelection = useCallback(
    () =>
      isWeb ? extractScopedWebSelection(bodyRef.current as unknown as HTMLElement | null) : null,
    [bodyRef],
  );
  const handlePointerDown = useCallback(() => {
    captured.current = { selection: readSelection() };
  }, [readSelection]);
  const clearCapture = useCallback(() => {
    captured.current = null;
  }, []);
  const handleKeyDown = useCallback(() => {
    clearCapture();
  }, [clearCapture]);
  const handlePress = useCallback(() => {
    const selection = captured.current ? captured.current.selection : readSelection();
    clearCapture();
    const quote = selection ?? extractReplyQuoteSummary(text, { sourceTitle });
    if (quote) onQuote?.({ quote, label: sourceTitle });
  }, [clearCapture, onQuote, readSelection, sourceTitle, text]);

  if (!onQuote || !text.trim()) return null;

  return (
    <View
      onPointerDown={isWeb ? handlePointerDown : undefined}
      onPointerCancel={isWeb ? clearCapture : undefined}
      {...(isWeb ? { onKeyDown: handleKeyDown } : undefined)}
    >
      <ToolbarButton
        compact
        label={quoteLabel ?? t("message.actions.quoteReply")}
        onPress={handlePress}
        testID={`topic-reply-quote-${id}`}
      >
        <ThemedQuote size={13} />
      </ToolbarButton>
    </View>
  );
}

function TopicReportBody({
  bodyRef,
  text,
  isCollapsed,
  isStreaming,
}: {
  bodyRef: React.RefObject<View | null>;
  text: string;
  isCollapsed: boolean;
  isStreaming?: boolean;
}) {
  return (
    <View ref={bodyRef}>
      {isCollapsed ? (
        <Text style={styles.bodyText} selectable>
          {extractSubagentPreviewText(text, COLLAPSE_THRESHOLD_CHARS)}
        </Text>
      ) : (
        <MarkdownRenderer text={text} compact streaming={isStreaming} />
      )}
    </View>
  );
}

const NewRepliesDivider = memo(function NewRepliesDivider({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <View style={styles.newDividerRow} testID="topic-new-replies-divider">
      <View style={styles.newDividerLine} />
      <Text style={styles.newDividerText}>
        {t("topicWorkbench.topicStream.newRepliesDivider", { count: Math.max(1, count) })}
      </Text>
      <View style={styles.newDividerLine} />
    </View>
  );
});

const SubagentReportRow = memo(function SubagentReportRow({
  disclosureKey,
  reply,
  showActions,
  isRetrying,
  isStreaming,
  quoteLabel,
  onQuote,
  onHoverChange,
  onConvertToTodo,
  onOpenBeside,
  onRetry,
}: {
  disclosureKey: string | null;
  reply: Extract<TopicReplyItem, { kind: "subagent_report" }>;
  showActions: boolean;
  isRetrying: boolean;
  isStreaming?: boolean;
  quoteLabel?: string;
  onQuote?: TopicReplyRowProps["onQuote"];
  onHoverChange: (hovered: boolean) => void;
  onConvertToTodo: () => void;
  onOpenBeside: () => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const bodyRef = useRef<View>(null);
  const hold = useDisclosureHold();
  const [localExpanded, setLocalExpanded] = useState(false);
  const storeExpanded = useTopicStreamViewStore((state) =>
    disclosureKey ? (state.expandedHistoryByTopicKey[disclosureKey] ?? false) : false,
  );
  const setHistoryExpanded = useTopicStreamViewStore((state) => state.setHistoryExpanded);
  const expanded = disclosureKey ? storeExpanded : localExpanded;
  const toggleExpand = useCallback(() => {
    hold(
      () => {
        if (disclosureKey) {
          setHistoryExpanded(disclosureKey, !expanded);
        } else {
          setLocalExpanded(toggleBoolean);
        }
      },
      { triggerEdge: "bottom" },
    );
  }, [disclosureKey, expanded, hold, setHistoryExpanded]);

  const isLong = reply.text.length > COLLAPSE_THRESHOLD_CHARS;
  const canRetry = Boolean(onRetry && (reply.status === "error" || reply.status === "closed"));

  return (
    <HoverEnvelope
      style={styles.rowHoverEnvelope}
      onHoverChange={onHoverChange}
      testID={`topic-reply-subagent-${reply.id}`}
    >
      <View style={[styles.reportRow, reply.isUnread && styles.rowUnreadSurface]}>
        <View style={styles.rowHeader}>
          <StatusBadge
            size="xs"
            variant={statusVariant(reply.status)}
            label={t(statusLabelKey(reply.status))}
          />
          <Text style={styles.senderTitle} numberOfLines={1}>
            {reply.senderTitle}
          </Text>
          <View
            style={[
              styles.actionsGroup,
              showActions ? styles.actionsVisible : styles.actionsHidden,
            ]}
            pointerEvents={showActions ? "auto" : "none"}
          >
            <TopicReplyQuoteButton
              id={reply.id}
              text={reply.text}
              sourceTitle={reply.senderTitle}
              bodyRef={bodyRef}
              quoteLabel={quoteLabel}
              onQuote={onQuote}
            />
            <ToolbarButton
              compact
              label={t("topicWorkbench.topicStream.convertToTodo")}
              onPress={onConvertToTodo}
              testID={`topic-reply-todo-${reply.id}`}
            >
              <ThemedCheckSquare size={13} />
            </ToolbarButton>
            <ToolbarButton
              compact
              label={t("topicWorkbench.topicStream.openLeadBeside")}
              onPress={onOpenBeside}
              testID={`topic-reply-open-beside-${reply.id}`}
            >
              <ThemedColumns2 size={13} />
            </ToolbarButton>
          </View>
        </View>
        <TopicReportBody
          bodyRef={bodyRef}
          text={reply.text}
          isCollapsed={isLong && !expanded}
          isStreaming={isStreaming}
        />
        <View style={styles.rowFooter}>
          {isLong ? (
            <PressHighlight
              accessibilityRole="button"
              onPress={toggleExpand}
              style={styles.expandToggle}
              testID={`topic-reply-expand-${reply.id}`}
            >
              {expanded ? <ThemedChevronDown size={13} /> : <ThemedChevronRight size={13} />}
              <Text style={styles.expandLabel}>
                {t(
                  expanded
                    ? "agentStream.source.actions.collapse"
                    : "agentStream.source.actions.viewDetails",
                )}
              </Text>
            </PressHighlight>
          ) : null}
          {canRetry ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={isRetrying}
              onPress={onRetry}
              testID={`topic-reply-retry-${reply.id}`}
            >
              <ThemedRetry size={12} />
              {t("topicWorkbench.topicStream.retryInTopic")}
            </Button>
          ) : null}
        </View>
      </View>
    </HoverEnvelope>
  );
});

const ThreadEntryStatusBadge = memo(function ThreadEntryStatusBadge({
  status,
}: {
  status: Extract<TopicReplyItem, { kind: "thread_entry" }>["entry"]["status"];
}) {
  const { t } = useTranslation();
  if (status === "running" || status === "queued") {
    return (
      <StatusBadge
        size="xs"
        variant="muted"
        label={t("topicWorkbench.topicStream.status.dispatching")}
      />
    );
  }
  if (status === "error") {
    return (
      <StatusBadge size="xs" variant="error" label={t("topicWorkbench.topicStream.status.error")} />
    );
  }
  return null;
});

type ThreadEntryValue = Extract<TopicReplyItem, { kind: "thread_entry" }>["entry"];

function resolveThreadReportStatus(entry: ThreadEntryValue): AgentSourceStatus {
  if (entry.status === "error") return "error";
  if (entry.reportStatus === "blocked") return "blocked";
  return "completed";
}

function resolveThreadAuthorLabel(
  entry: ThreadEntryValue,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (entry.origin === "subagent_report") {
    return entry.authorTitle?.trim() || t("topicWorkbench.topicStream.leadFallbackName");
  }
  if (entry.role === "user_followup") {
    if (entry.origin === "butler_dispatch") {
      return t("topicWorkbench.topicStream.butlerDispatchLabel");
    }
    if (entry.origin === "decision_reply") {
      return t("topicWorkbench.topicStream.decisionReplyLabel");
    }
    return t("topicWorkbench.topicStream.followupLabel");
  }
  if (entry.role === "system_note") {
    return t("topicWorkbench.topicStream.decisionSettledLabel");
  }
  return entry.authorTitle || t("topicWorkbench.topicStream.mainConclusionLabel");
}

const ThreadEntryActions = memo(function ThreadEntryActions({
  entry,
  showActions,
  children,
  onConvertToTodo,
  onOpenBeside,
}: {
  entry: ThreadEntryValue;
  showActions: boolean;
  children?: React.ReactNode;
  onConvertToTodo: () => void;
  onOpenBeside: () => void;
}) {
  const { t } = useTranslation();
  const isUserFollowup = entry.role === "user_followup";
  const isSystemNote = entry.role === "system_note";

  return (
    <View
      style={[styles.actionsGroup, showActions ? styles.actionsVisible : styles.actionsHidden]}
      pointerEvents={showActions ? "auto" : "none"}
    >
      {children}
      {!isUserFollowup && !isSystemNote ? (
        <ToolbarButton
          compact
          label={t("topicWorkbench.topicStream.convertToTodo")}
          onPress={onConvertToTodo}
          testID={`topic-reply-todo-${entry.entryId}`}
        >
          <ThemedCheckSquare size={13} />
        </ToolbarButton>
      ) : null}
      {!isUserFollowup && entry.authorAgentId ? (
        <ToolbarButton
          compact
          label={t("topicWorkbench.topicStream.openLeadBeside")}
          onPress={onOpenBeside}
          testID={`topic-reply-open-beside-${entry.entryId}`}
        >
          <ThemedColumns2 size={13} />
        </ToolbarButton>
      ) : null}
    </View>
  );
});

const ThreadEntryFooter = memo(function ThreadEntryFooter({
  entryId,
  isLong,
  expanded,
  canRetry,
  isRetrying,
  onToggleExpand,
  onRetry,
}: {
  entryId: string;
  isLong: boolean;
  expanded: boolean;
  canRetry: boolean;
  isRetrying: boolean;
  onToggleExpand: () => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  if (!isLong && !canRetry) return null;

  return (
    <View style={styles.rowFooter}>
      {isLong ? (
        <PressHighlight
          accessibilityRole="button"
          onPress={onToggleExpand}
          style={styles.expandToggle}
          testID={`topic-reply-expand-${entryId}`}
        >
          {expanded ? <ThemedChevronDown size={13} /> : <ThemedChevronRight size={13} />}
          <Text style={styles.expandLabel}>
            {t(
              expanded
                ? "agentStream.source.actions.collapse"
                : "agentStream.source.actions.viewDetails",
            )}
          </Text>
        </PressHighlight>
      ) : null}
      {canRetry ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={isRetrying}
          onPress={onRetry}
          testID={`topic-reply-retry-${entryId}`}
        >
          <ThemedRetry size={12} />
          {t("topicWorkbench.topicStream.retryInTopic")}
        </Button>
      ) : null}
    </View>
  );
});

const ThreadEntryRow = memo(function ThreadEntryRow({
  disclosureKey,
  reply,
  imageReader,
  showActions,
  isRetrying,
  isStreaming,
  quoteLabel,
  onQuote,
  onHoverChange,
  onConvertToTodo,
  onOpenBeside,
  onRetry,
}: {
  disclosureKey: string | null;
  imageReader?: MessageImageReader;
  reply: Extract<TopicReplyItem, { kind: "thread_entry" }>;
  showActions: boolean;
  isRetrying: boolean;
  isStreaming?: boolean;
  quoteLabel?: string;
  onQuote?: TopicReplyRowProps["onQuote"];
  onHoverChange: (hovered: boolean) => void;
  onConvertToTodo: () => void;
  onOpenBeside: () => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const bodyRef = useRef<View>(null);
  const hold = useDisclosureHold();
  const [localExpanded, setLocalExpanded] = useState(false);
  const storeExpanded = useTopicStreamViewStore((state) =>
    disclosureKey ? (state.expandedHistoryByTopicKey[disclosureKey] ?? false) : false,
  );
  const setHistoryExpanded = useTopicStreamViewStore((state) => state.setHistoryExpanded);
  const expanded = disclosureKey ? storeExpanded : localExpanded;
  const toggleExpand = useCallback(() => {
    hold(
      () => {
        if (disclosureKey) {
          setHistoryExpanded(disclosureKey, !expanded);
        } else {
          setLocalExpanded(toggleBoolean);
        }
      },
      { triggerEdge: "bottom" },
    );
  }, [disclosureKey, expanded, hold, setHistoryExpanded]);

  const entry = reply.entry;
  const isSilentReport = entry.origin === "subagent_report";
  const isUserFollowup = entry.role === "user_followup";
  const reportStatus = resolveThreadReportStatus(entry);
  const authorLabel = resolveThreadAuthorLabel(entry, t);
  const isLong = isSilentReport && entry.text.length > COLLAPSE_THRESHOLD_CHARS;
  const hasMarkdownBody =
    !isUserFollowup &&
    entry.role !== "system_note" &&
    (isSilentReport || entry.role === "agent_reply");
  const canRetry = Boolean(onRetry && entry.retryable === true);

  if (isUserFollowup && entry.origin !== "butler_dispatch") {
    return (
      <View testID={`topic-reply-thread-${entry.entryId}`}>
        <TopicUserMessage
          text={entry.text}
          images={reply.images}
          imageAttachments={entry.imageAttachments}
          imageReader={imageReader}
        >
          {entry.status === "completed" ? null : <ThreadEntryStatusBadge status={entry.status} />}
          <ThreadEntryFooter
            entryId={entry.entryId}
            isLong={false}
            expanded={false}
            canRetry={canRetry}
            isRetrying={isRetrying}
            onToggleExpand={toggleExpand}
            onRetry={onRetry}
          />
        </TopicUserMessage>
      </View>
    );
  }

  return (
    <HoverEnvelope
      style={styles.rowHoverEnvelope}
      onHoverChange={onHoverChange}
      testID={`topic-reply-thread-${entry.entryId}`}
    >
      <View
        style={[
          isUserFollowup ? styles.followupRow : styles.reportRow,
          reply.isUnread && styles.rowUnreadSurface,
        ]}
      >
        <View style={styles.rowHeader}>
          {isSilentReport ? (
            <StatusBadge
              size="xs"
              variant={statusVariant(reportStatus)}
              label={t(statusLabelKey(reportStatus))}
            />
          ) : (
            <ThemedCornerDownRight size={13} />
          )}
          <Text style={styles.senderTitle} numberOfLines={1}>
            {authorLabel}
          </Text>
          {!isSilentReport ? <ThreadEntryStatusBadge status={entry.status} /> : null}
          <ThreadEntryActions
            entry={entry}
            showActions={showActions}
            onConvertToTodo={onConvertToTodo}
            onOpenBeside={onOpenBeside}
          >
            {hasMarkdownBody && onQuote ? (
              <TopicReplyQuoteButton
                id={entry.entryId}
                text={entry.text}
                sourceTitle={authorLabel}
                bodyRef={bodyRef}
                quoteLabel={quoteLabel}
                onQuote={onQuote}
              />
            ) : null}
          </ThreadEntryActions>
        </View>
        {hasMarkdownBody ? (
          <TopicReportBody
            bodyRef={bodyRef}
            text={entry.text}
            isCollapsed={isLong && !expanded}
            isStreaming={isStreaming}
          />
        ) : (
          <Text style={styles.bodyText}>{entry.text}</Text>
        )}
        <ThreadEntryFooter
          entryId={entry.entryId}
          isLong={isLong}
          expanded={expanded}
          canRetry={canRetry}
          isRetrying={isRetrying}
          onToggleExpand={toggleExpand}
          onRetry={onRetry}
        />
      </View>
    </HoverEnvelope>
  );
});

function MainReplyRow({
  reply,
  showNewDivider,
  unreadCountForDivider,
  isStreaming,
  quoteLabel,
  onQuote,
  onHoverChange,
  showActions,
  onConvertToTodo,
}: Pick<
  TopicReplyRowProps,
  "showNewDivider" | "unreadCountForDivider" | "isStreaming" | "quoteLabel" | "onQuote"
> & {
  reply: Extract<TopicReplyItem, { kind: "main_conclusion" | "main_progress" }>;
  onHoverChange: (hovered: boolean) => void;
  showActions: boolean;
  onConvertToTodo: () => void;
}) {
  const { t } = useTranslation();
  const bodyRef = useRef<View>(null);
  const isProgress = reply.kind === "main_progress";
  let sourceTitle = t("topicWorkbench.topicStream.mainConclusionLabel");
  if (isProgress) {
    sourceTitle = t(
      reply.dispatched
        ? "topicWorkbench.topicStream.mainDispatchedLabel"
        : "topicWorkbench.topicStream.mainProgressLabel",
    );
  }
  return (
    <View>
      {showNewDivider && !isProgress ? (
        <NewRepliesDivider count={unreadCountForDivider ?? 0} />
      ) : null}
      <HoverEnvelope
        style={styles.rowHoverEnvelope}
        onHoverChange={onHoverChange}
        testID={`topic-reply-${isProgress ? "progress" : "conclusion"}-${reply.id}`}
      >
        <View
          style={[
            isProgress ? styles.progressRow : styles.conclusionRow,
            !isProgress && reply.isUnread && styles.rowUnreadSurface,
          ]}
        >
          <View style={styles.rowHeader}>
            {isProgress && reply.isUnread ? (
              <View style={styles.progressUnreadDot} testID="topic-progress-unread" />
            ) : null}
            {!isProgress ? <ThemedSparkles size={13} /> : null}
            <Text
              style={[styles.conclusionLabel, isProgress && styles.progressLabel]}
              numberOfLines={1}
            >
              {sourceTitle}
            </Text>
            <View
              style={[
                styles.actionsGroup,
                showActions ? styles.actionsVisible : styles.actionsHidden,
              ]}
              pointerEvents={showActions ? "auto" : "none"}
            >
              <TopicReplyQuoteButton
                id={reply.id}
                text={reply.text}
                sourceTitle={sourceTitle}
                bodyRef={bodyRef}
                quoteLabel={quoteLabel}
                onQuote={onQuote}
              />
              <ToolbarButton
                compact
                label={t("topicWorkbench.topicStream.convertToTodo")}
                onPress={onConvertToTodo}
                testID={`topic-conclusion-todo-${reply.id}`}
              >
                <ThemedCheckSquare size={13} />
              </ToolbarButton>
            </View>
          </View>
          <TopicReportBody
            bodyRef={bodyRef}
            text={reply.text}
            isCollapsed={false}
            isStreaming={isStreaming}
          />
        </View>
      </HoverEnvelope>
    </View>
  );
}

export const TopicReplyRow = memo(function TopicReplyRow({
  agentKey,
  topicKey,
  reply,
  imageReader,
  showNewDivider = false,
  unreadCountForDivider = 0,
  isRetrying = false,
  isStreaming,
  quoteLabel,
  onQuote,
  onOpenAgentBeside,
  onConvertToTodo,
  onRetryReply,
}: TopicReplyRowProps) {
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);

  const showActions = isHovered || isNative || isCompact;

  const handleOpenBeside = useCallback(() => {
    if (reply.kind === "subagent_report") {
      onOpenAgentBeside(reply.senderId, reply.senderServerId);
    } else if (reply.kind === "thread_entry" && reply.entry.authorAgentId) {
      onOpenAgentBeside(reply.entry.authorAgentId);
    }
  }, [onOpenAgentBeside, reply]);

  const handleConvertToTodo = useCallback(() => {
    const rawText = reply.kind === "thread_entry" ? reply.entry.text : reply.text;
    onConvertToTodo({
      title: extractFirstTodoLine(rawText),
      note: rawText.length > 90 ? rawText.slice(0, 600) : undefined,
      sourceMessageId: resolveReplySourceMessageId(reply),
      authorAgentId: resolveReplyAuthorAgentId(reply),
    });
  }, [onConvertToTodo, reply]);

  const handleRetry = useCallback(() => {
    onRetryReply?.(reply);
  }, [onRetryReply, reply]);

  if (reply.kind === "subagent_report") {
    const replyDisclosureKey =
      agentKey && topicKey
        ? buildTopicDisclosureKey(agentKey, `${topicKey}:reply:${reply.id}`)
        : null;
    return (
      <View>
        {showNewDivider ? <NewRepliesDivider count={unreadCountForDivider} /> : null}
        <SubagentReportRow
          disclosureKey={replyDisclosureKey}
          reply={reply}
          showActions={showActions}
          isRetrying={isRetrying}
          isStreaming={isStreaming}
          quoteLabel={quoteLabel}
          onQuote={onQuote}
          onHoverChange={setIsHovered}
          onConvertToTodo={handleConvertToTodo}
          onOpenBeside={handleOpenBeside}
          onRetry={onRetryReply ? handleRetry : undefined}
        />
      </View>
    );
  }

  if (reply.kind === "main_conclusion" || reply.kind === "main_progress") {
    return (
      <MainReplyRow
        reply={reply}
        showNewDivider={showNewDivider}
        unreadCountForDivider={unreadCountForDivider}
        isStreaming={isStreaming}
        quoteLabel={quoteLabel}
        onQuote={onQuote}
        onHoverChange={setIsHovered}
        showActions={showActions}
        onConvertToTodo={handleConvertToTodo}
      />
    );
  }

  const threadDisclosureKey =
    agentKey && topicKey
      ? buildTopicDisclosureKey(agentKey, `${topicKey}:reply:${reply.id}`)
      : null;

  return (
    <View>
      {showNewDivider ? <NewRepliesDivider count={unreadCountForDivider} /> : null}
      <ThreadEntryRow
        disclosureKey={threadDisclosureKey}
        reply={reply}
        imageReader={imageReader}
        showActions={showActions}
        isRetrying={isRetrying}
        isStreaming={isStreaming}
        quoteLabel={quoteLabel}
        onQuote={onQuote}
        onHoverChange={setIsHovered}
        onConvertToTodo={handleConvertToTodo}
        onOpenBeside={handleOpenBeside}
        onRetry={onRetryReply ? handleRetry : undefined}
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  rowHoverEnvelope: {
    position: "relative",
  },
  reportRow: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  conclusionRow: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  progressRow: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  progressLabel: {
    color: theme.colors.foregroundMuted,
  },
  progressUnreadDot: {
    width: 5,
    height: 5,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  userBubble: {
    maxWidth: "85%",
    minWidth: 0,
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface3,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderLeftColor: theme.colors.accentBright,
    borderLeftWidth: 3,
    borderRadius: theme.borderRadius.xl,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  userBubbleLeft: {
    alignSelf: "flex-start",
    borderTopLeftRadius: theme.borderRadius.sm,
  },
  userBubbleRight: {
    alignSelf: "flex-end",
    borderTopRightRadius: theme.borderRadius.sm,
  },
  userLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  followupRow: {
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[1],
  },
  rowUnreadSurface: {
    borderColor: theme.colors.statusSuccess,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 24,
    gap: theme.spacing[1.5],
  },
  senderTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  conclusionLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  bodyText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.lineHeight.content,
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
  },
  actionsGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0.5],
  },
  actionsVisible: {
    opacity: 1,
  },
  actionsHidden: {
    opacity: 0,
  },
  rowFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  expandToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    alignSelf: "flex-start",
    paddingVertical: theme.spacing[0.5],
  },
  expandLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  newDividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginVertical: theme.spacing[1.5],
  },
  newDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.statusSuccess,
    opacity: 0.45,
  },
  newDividerText: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));
