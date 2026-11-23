import { Check, CircleDot, ShieldAlert, TriangleAlert, XCircle } from "lucide-react-native";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ExpandableBadge } from "@/components/message";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { useDisclosureHold } from "./disclosure";
import {
  agentSourceKey,
  type AgentSourceGroup,
  type AgentSourceInfo,
  type AgentSourceStatus,
} from "./agent-interactions";

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

function statusIcon(status: AgentSourceStatus) {
  switch (status) {
    case "completed":
    case "finished":
      return Check;
    case "blocked":
    case "permission-required":
      return ShieldAlert;
    case "error":
      return TriangleAlert;
    case "closed":
      return XCircle;
    case "message":
      return CircleDot;
  }
}

function SourceTag({
  source,
  fallbackServerId,
}: {
  source: AgentSourceInfo;
  fallbackServerId?: string;
}) {
  const { t } = useTranslation();
  const host = source.sender.serverId ?? fallbackServerId;
  const id = source.sender.id;
  const title = useSessionStore((state) => {
    const session = host ? state.sessions[host] : undefined;
    return session?.agents.get(id)?.title ?? session?.agentDetails.get(id)?.title;
  });
  const name = title?.trim() || source.sender.title?.trim() || id;
  const chars = Array.from(name);
  const label = chars.length <= 28 ? name : `${chars.slice(0, 25).join("")}…`;
  const status = statusLabel(source.status, t);
  const Icon = statusIcon(source.status);
  const emphasized =
    source.status === "blocked" ||
    source.status === "error" ||
    source.status === "permission-required";
  const renderIcon = useCallback(
    (color: string) => <Icon size={14} color={emphasized ? styles.emphasizedText.color : color} />,
    [Icon, emphasized],
  );
  const openSource = useCallback(() => {
    if (host) navigateToAgent({ serverId: host, agentId: id });
  }, [host, id]);

  return (
    <Button
      variant="ghost"
      size="sm"
      leftIcon={renderIcon}
      onPress={openSource}
      disabled={!host}
      accessibilityLabel={`${name}, ${status}`}
      testID="agent-source-tag"
      style={styles.tag}
      textStyle={[styles.tagText, emphasized && styles.emphasizedText]}
      numberOfLines={1}
    >
      {label} · {status}
    </Button>
  );
}

export function AgentSourceHeader({
  group,
  fallbackServerId,
  expanded,
  onExpandedChange,
}: {
  group: AgentSourceGroup;
  fallbackServerId?: string;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const hold = useDisclosureHold();
  const toggle = useCallback(() => {
    if (!onExpandedChange || expanded === undefined) return;
    hold(() => onExpandedChange(!expanded));
  }, [expanded, hold, onExpandedChange]);

  return (
    <View
      style={[styles.header, !onExpandedChange && styles.inlineHeader]}
      testID={onExpandedChange ? "turn-summary" : "agent-source-header"}
    >
      <View style={[styles.tags, !onExpandedChange && styles.inlineTags]}>
        {group.sources.map((source) => (
          <SourceTag
            key={agentSourceKey(source)}
            source={source}
            fallbackServerId={fallbackServerId}
          />
        ))}
      </View>
      {onExpandedChange && expanded !== undefined ? (
        <ExpandableBadge
          testID="agent-source-details"
          label={t("turnSummary.details")}
          isExpanded={expanded}
          onToggle={toggle}
          borderlessWhenExpanded
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    minWidth: 0,
  },
  inlineHeader: {
    alignSelf: "flex-end",
    maxWidth: "85%",
  },
  tags: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    flexShrink: 1,
    maxWidth: "100%",
    minWidth: 0,
  },
  inlineTags: {
    justifyContent: "flex-end",
  },
  tag: {
    maxWidth: "100%",
    paddingHorizontal: theme.spacing[1],
    paddingRight: 0,
  },
  tagText: {
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
  },
  emphasizedText: {
    color: theme.colors.statusDanger,
    fontWeight: theme.fontWeight.medium,
  },
}));
