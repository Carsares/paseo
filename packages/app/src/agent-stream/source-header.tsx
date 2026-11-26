import { Columns2, Quote } from "lucide-react-native";
import { createContext, memo, useCallback, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useComposerQuote } from "@/assistant-selection-copy/composer-quote";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { useOptionalPaneContext } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { openSubagentFromTopic } from "@/subagents/open-from-topic";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { useDisclosureHold } from "./disclosure";
import {
  agentSourceKey,
  type AgentSourceGroup,
  type AgentSourceInfo,
  type AgentSourceStatus,
} from "./agent-interactions";
import {
  extractReplyQuoteSummary,
  extractSubagentPreviewText,
  resolveSourceDisplayTitle,
  stripReplyTemplate,
} from "./reply-quote";

const ThemedColumns2 = withUnistyles(Columns2);
const ThemedQuote = withUnistyles(Quote);
const mutedIconProps = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const expandedAccessibilityState = { expanded: true };
const collapsedAccessibilityState = { expanded: false };

/**
 * The first item id of the newest source group while the viewed agent holds an unread
 * "finished" attention. The matching card paints a success stripe. A context keeps the rows
 * that do not match from re-rendering when it flips.
 */
export const UnreadAgentSourceContext = createContext<string | null>(null);

function statusLabel(status: AgentSourceStatus, t: (key: string) => string): string {
  switch (status) {
    case "message":
      return t("agentStream.source.status.message");
    case "finished":
      return t("agentStream.source.status.finished");
    case "completed":
      return t("agentStream.source.status.completed");
    case "blocked":
      return t("agentStream.source.status.blocked");
    case "error":
      return t("agentStream.source.status.error");
    case "permission-required":
      return t("agentStream.source.status.permission");
    case "closed":
      return t("agentStream.source.status.closed");
  }
}

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

interface SourceDetailsToggle {
  expanded: boolean;
  onToggle: () => void;
}

function resolveSourceTopicKey(source: AgentSourceInfo): string | undefined {
  if (source.taskId) return `task:${source.taskId}`;
  if (source.rootMessageId) return `msg:${source.rootMessageId}`;
  return undefined;
}

function resolveSourceOpenParams(input: {
  source: AgentSourceInfo;
  host: string;
  fallbackServerId?: string;
  mainAgentId?: string;
  workspaceId?: string;
  parentTabId?: string | null;
  title: string;
  paneContext: ReturnType<typeof useOptionalPaneContext>;
}) {
  const {
    source,
    host,
    fallbackServerId,
    mainAgentId,
    workspaceId,
    parentTabId,
    title,
    paneContext,
  } = input;
  const session = useSessionStore.getState().sessions[host];
  const targetAgent =
    session?.agents.get(source.sender.id) ?? session?.agentDetails.get(source.sender.id);
  const resolvedWorkspaceId = workspaceId ?? targetAgent?.workspaceId ?? paneContext?.workspaceId;
  const paneAgentId = paneContext?.target.kind === "agent" ? paneContext.target.agentId : undefined;
  const resolvedMainAgentId = mainAgentId ?? paneAgentId ?? targetAgent?.parentAgentId ?? undefined;
  return {
    resolvedWorkspaceId,
    serverId: fallbackServerId ?? host,
    targetServerId: host,
    targetAgentId: source.sender.id,
    mainAgentId: resolvedMainAgentId,
    topicKey: resolveSourceTopicKey(source),
    promptPreview: extractSubagentPreviewText(source.text).slice(0, 60) || title,
    parentTabId: parentTabId ?? paneContext?.tabId ?? null,
  };
}

const SourceEntry = memo(function SourceEntry({
  source,
  fallbackServerId,
  mainAgentId,
  workspaceId,
  parentTabId,
  showPreview,
  details,
}: {
  source: AgentSourceInfo;
  fallbackServerId?: string;
  mainAgentId?: string;
  workspaceId?: string;
  parentTabId?: string | null;
  showPreview: boolean;
  details?: SourceDetailsToggle;
}) {
  const { t } = useTranslation();
  const composerQuote = useComposerQuote();
  const paneContext = useOptionalPaneContext();
  const host = source.sender.serverId ?? fallbackServerId;
  const id = source.sender.id;
  const liveTitle = useSessionStore((state) => {
    const session = host ? state.sessions[host] : undefined;
    return session?.agents.get(id)?.title ?? session?.agentDetails.get(id)?.title;
  });
  const title = resolveSourceDisplayTitle({ liveTitle, senderTitle: source.sender.title, id });
  const status = statusLabel(source.status, t);
  const preview = useMemo(
    () => (showPreview ? extractSubagentPreviewText(source.text) : ""),
    [showPreview, source.text],
  );
  const hasQuotableText = useMemo(
    () => composerQuote !== null && stripReplyTemplate(source.text).length > 0,
    [composerQuote, source.text],
  );
  const openSource = useCallback(() => {
    if (!host) return;
    const params = resolveSourceOpenParams({
      source,
      host,
      fallbackServerId,
      mainAgentId,
      workspaceId,
      parentTabId,
      title,
      paneContext,
    });
    if (params.resolvedWorkspaceId) {
      openSubagentFromTopic({
        serverId: params.serverId,
        workspaceId: params.resolvedWorkspaceId,
        targetServerId: params.targetServerId,
        targetAgentId: params.targetAgentId,
        mainAgentId: params.mainAgentId,
        topicKey: params.topicKey,
        promptPreview: params.promptPreview,
        parentTabId: params.parentTabId,
        location: "side",
      });
      return;
    }
    navigateToAgent({ serverId: host, agentId: id });
  }, [
    fallbackServerId,
    host,
    id,
    mainAgentId,
    paneContext,
    parentTabId,
    source,
    title,
    workspaceId,
  ]);
  const quoteReply = useCallback(() => {
    const quote = extractReplyQuoteSummary(source.text, { sourceTitle: title });
    if (!quote) return;
    const topicKey = resolveSourceTopicKey(source);
    composerQuote?.addQuote({
      quote,
      label: title,
      ...(topicKey ? { topicKey } : {}),
      ...(source.rootMessageId ? { rootMessageId: source.rootMessageId } : {}),
      ...(source.taskId ? { taskId: source.taskId } : {}),
    });
  }, [composerQuote, source, title]);

  return (
    <View style={styles.entry} testID="agent-source-entry">
      <View style={styles.titleRow}>
        <StatusBadge size="xs" variant={statusVariant(source.status)} label={status} />
        <Text style={styles.title} numberOfLines={1} testID="agent-source-title">
          {title}
        </Text>
        <View style={styles.actions}>
          {hasQuotableText ? (
            <ToolbarButton
              compact
              label={t("agentStream.source.actions.quoteReply")}
              onPress={quoteReply}
              testID="agent-source-quote"
            >
              <ThemedQuote size={ICON_SIZE.sm} uniProps={mutedIconProps} />
            </ToolbarButton>
          ) : null}
          <ToolbarButton
            compact
            label={t("agentStream.source.actions.openSubagent")}
            onPress={openSource}
            disabled={!host}
            testID="agent-source-tag"
          >
            <ThemedColumns2 size={ICON_SIZE.sm} uniProps={mutedIconProps} />
          </ToolbarButton>
          {details ? (
            <Button
              variant="ghost"
              size="sm"
              onPress={details.onToggle}
              accessibilityState={
                details.expanded ? expandedAccessibilityState : collapsedAccessibilityState
              }
              testID="agent-source-details"
            >
              {t(
                details.expanded
                  ? "agentStream.source.actions.collapse"
                  : "agentStream.source.actions.viewDetails",
              )}
            </Button>
          ) : null}
        </View>
      </View>
      {preview ? (
        <Text
          style={styles.preview}
          numberOfLines={2}
          ellipsizeMode="tail"
          testID="agent-source-preview"
        >
          {preview}
        </Text>
      ) : null}
    </View>
  );
});

export function AgentSourceHeader({
  group,
  fallbackServerId,
  mainAgentId,
  workspaceId,
  parentTabId,
  expanded,
  onExpandedChange,
}: {
  group: AgentSourceGroup;
  fallbackServerId?: string;
  mainAgentId?: string;
  workspaceId?: string;
  parentTabId?: string | null;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const hold = useDisclosureHold();
  const unreadGroupId = useContext(UnreadAgentSourceContext);
  const unread = unreadGroupId !== null && unreadGroupId === group.firstItemId;
  const toggle = useCallback(() => {
    if (!onExpandedChange || expanded === undefined) return;
    hold(() => onExpandedChange(!expanded));
  }, [expanded, hold, onExpandedChange]);
  const details = useMemo<SourceDetailsToggle | undefined>(
    () => (onExpandedChange && expanded !== undefined ? { expanded, onToggle: toggle } : undefined),
    [expanded, onExpandedChange, toggle],
  );
  // The expanded body, or the message an inline header sits above, already shows the text.
  const showPreview = details !== undefined && !details.expanded;

  return (
    <View
      style={[styles.card, !onExpandedChange && styles.inlineCard]}
      testID={onExpandedChange ? "turn-summary" : "agent-source-header"}
    >
      {unread ? <View style={styles.unreadBar} testID="agent-source-unread" /> : null}
      {group.sources.map((source, index) => (
        <SourceEntry
          key={agentSourceKey(source)}
          source={source}
          fallbackServerId={fallbackServerId}
          mainAgentId={mainAgentId}
          workspaceId={workspaceId}
          parentTabId={parentTabId}
          showPreview={showPreview}
          details={index === 0 ? details : undefined}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    gap: theme.spacing[2],
    minWidth: 0,
    overflow: "hidden",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  inlineCard: {
    alignSelf: "flex-start",
    width: "100%",
  },
  unreadBar: {
    backgroundColor: theme.colors.statusSuccess,
    bottom: 0,
    left: 0,
    position: "absolute",
    top: 0,
    width: theme.borderWidth[2],
  },
  entry: {
    gap: theme.spacing[1],
    minWidth: 0,
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  title: {
    color: theme.colors.foreground,
    flexGrow: 1,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    minWidth: 0,
  },
  actions: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 0,
    gap: theme.spacing[1],
  },
  preview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));
