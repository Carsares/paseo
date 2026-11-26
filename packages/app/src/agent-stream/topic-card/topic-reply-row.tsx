import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Columns2,
  CornerDownRight,
  RotateCcw,
  Sparkles,
} from "lucide-react-native";
import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { buildTopicDisclosureKey, useTopicStreamViewStore } from "@/stores/topic-stream-view-store";
import type { Theme } from "@/styles/theme";
import type { AgentSourceStatus } from "../agent-interactions";
import { useDisclosureHold } from "../disclosure";
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
  if (reply.kind === "main_conclusion") return reply.messageId;
  if (reply.kind === "thread_entry") return reply.entry.sourceMessageId;
  return reply.id;
}

function resolveReplyAuthorAgentId(reply: TopicReplyItem): string | undefined {
  if (reply.kind === "subagent_report") return reply.senderId;
  if (reply.kind === "thread_entry") return reply.entry.authorAgentId;
  return undefined;
}

export interface TopicReplyRowProps {
  agentKey?: string;
  topicKey?: string;
  reply: TopicReplyItem;
  showNewDivider?: boolean;
  unreadCountForDivider?: number;
  isRetrying?: boolean;
  onOpenAgentBeside: (agentId: string, serverId?: string) => void;
  onConvertToTodo: (input: {
    title: string;
    note?: string;
    sourceMessageId?: string;
    authorAgentId?: string;
  }) => void;
  onRetryReply?: (reply: TopicReplyItem) => void;
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
  onHoverChange,
  onConvertToTodo,
  onOpenBeside,
  onRetry,
}: {
  disclosureKey: string | null;
  reply: Extract<TopicReplyItem, { kind: "subagent_report" }>;
  showActions: boolean;
  isRetrying: boolean;
  onHoverChange: (hovered: boolean) => void;
  onConvertToTodo: () => void;
  onOpenBeside: () => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
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
  const displayText =
    isLong && !expanded ? `${reply.text.slice(0, COLLAPSE_THRESHOLD_CHARS)}…` : reply.text;
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
        <Text style={styles.bodyText}>{displayText}</Text>
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
  onConvertToTodo,
  onOpenBeside,
}: {
  entry: ThreadEntryValue;
  showActions: boolean;
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
  showActions,
  isRetrying,
  onHoverChange,
  onConvertToTodo,
  onOpenBeside,
  onRetry,
}: {
  disclosureKey: string | null;
  reply: Extract<TopicReplyItem, { kind: "thread_entry" }>;
  showActions: boolean;
  isRetrying: boolean;
  onHoverChange: (hovered: boolean) => void;
  onConvertToTodo: () => void;
  onOpenBeside: () => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
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
  const displayText =
    isLong && !expanded ? `${entry.text.slice(0, COLLAPSE_THRESHOLD_CHARS)}…` : entry.text;
  const canRetry = Boolean(onRetry && entry.retryable === true);

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
          />
        </View>
        <Text style={styles.bodyText}>{displayText}</Text>
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

export const TopicReplyRow = memo(function TopicReplyRow({
  agentKey,
  topicKey,
  reply,
  showNewDivider = false,
  unreadCountForDivider = 0,
  isRetrying = false,
  onOpenAgentBeside,
  onConvertToTodo,
  onRetryReply,
}: TopicReplyRowProps) {
  const { t } = useTranslation();
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
          onHoverChange={setIsHovered}
          onConvertToTodo={handleConvertToTodo}
          onOpenBeside={handleOpenBeside}
          onRetry={onRetryReply ? handleRetry : undefined}
        />
      </View>
    );
  }

  if (reply.kind === "main_conclusion") {
    return (
      <View>
        {showNewDivider ? <NewRepliesDivider count={unreadCountForDivider} /> : null}
        <HoverEnvelope
          style={styles.rowHoverEnvelope}
          onHoverChange={setIsHovered}
          testID={`topic-reply-conclusion-${reply.id}`}
        >
          <View style={[styles.conclusionRow, reply.isUnread && styles.rowUnreadSurface]}>
            <View style={styles.rowHeader}>
              <ThemedSparkles size={13} />
              <Text style={styles.conclusionLabel} numberOfLines={1}>
                {t("topicWorkbench.topicStream.mainConclusionLabel")}
              </Text>
              <View
                style={[
                  styles.actionsGroup,
                  showActions ? styles.actionsVisible : styles.actionsHidden,
                ]}
                pointerEvents={showActions ? "auto" : "none"}
              >
                <ToolbarButton
                  compact
                  label={t("topicWorkbench.topicStream.convertToTodo")}
                  onPress={handleConvertToTodo}
                  testID={`topic-conclusion-todo-${reply.id}`}
                >
                  <ThemedCheckSquare size={13} />
                </ToolbarButton>
              </View>
            </View>
            <Text style={styles.conclusionBody}>{reply.text}</Text>
          </View>
        </HoverEnvelope>
      </View>
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
        showActions={showActions}
        isRetrying={isRetrying}
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
  },
  conclusionBody: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.lineHeight.content,
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
