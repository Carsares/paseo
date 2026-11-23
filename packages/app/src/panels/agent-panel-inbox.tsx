import { isMainControlAgent } from "@getpaseo/protocol/agent-labels";
import { Inbox } from "lucide-react-native";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";

function shortSourceId(id: string): string {
  const trimmed = id.trim();
  return trimmed.length <= 12 ? trimmed : `${trimmed.slice(0, 8)}…`;
}

export function PendingSubagentInboxBar({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}) {
  const { t } = useTranslation();
  const client = useSessionStore((state) => state.sessions[serverId]?.client);
  const isSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.subagentInbox === true,
  );
  const agent = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
  });
  const inbox = agent?.pendingSubagentInbox;
  const isMainControl = agent !== undefined && isMainControlAgent(agent);
  const [isFlushing, setIsFlushing] = useState(false);
  const [error, setError] = useState(false);
  const flushInFlight = useRef(false);
  const flush = useCallback(async () => {
    if (!client || !isSupported || !isMainControl || !inbox?.count || flushInFlight.current) return;
    flushInFlight.current = true;
    setIsFlushing(true);
    setError(false);
    try {
      await client.flushAgentInbox(agentId);
    } catch {
      setError(true);
    } finally {
      flushInFlight.current = false;
      setIsFlushing(false);
    }
  }, [agentId, client, inbox?.count, isMainControl, isSupported]);
  const shouldShow = isSupported && isMainControl && (inbox?.count ?? 0) > 0;
  if (!shouldShow || !inbox) return null;

  const sources = new Map(
    inbox.items.map((item) => [JSON.stringify([item.serverId ?? serverId, item.agentId]), item]),
  );
  const labels = [...sources.values()].map(
    (item) => item.title?.trim() || shortSourceId(item.agentId),
  );
  const visibleLabels = labels.slice(0, 3);
  const remaining = labels.length - visibleLabels.length;
  return (
    <View style={styles.inboxBar} testID="pending-subagent-inbox">
      <View style={styles.inboxCopy}>
        <View style={styles.inboxLabel}>
          <Inbox size={16} color={styles.inboxIcon.color} />
          <Text style={styles.inboxText}>
            {t("agentStream.inbox.pending", { count: inbox.count })}
          </Text>
        </View>
        {visibleLabels.length > 0 ? (
          <Text style={styles.inboxSources} numberOfLines={2}>
            {visibleLabels.join(", ")}
            {remaining > 0 ? ` +${remaining}` : ""}
          </Text>
        ) : null}
        {error ? (
          <Text style={styles.inboxError} accessibilityRole="alert">
            {t("agentStream.inbox.failed")}
          </Text>
        ) : null}
      </View>
      <Button
        variant="ghost"
        size="sm"
        onPress={flush}
        disabled={isFlushing || !client}
        testID="flush-subagent-inbox"
      >
        {isFlushing ? t("agentStream.inbox.flushing") : t("agentStream.inbox.flush")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  inboxBar: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  inboxCopy: {
    flex: 1,
    minWidth: 0,
  },
  inboxLabel: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  inboxIcon: {
    color: theme.colors.foregroundMuted,
  },
  inboxText: {
    color: theme.colors.foreground,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  inboxSources: {
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
  },
  inboxError: {
    color: theme.colors.statusDanger,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
  },
}));
