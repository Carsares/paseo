import { isMainControlAgent } from "@getpaseo/protocol/agent-labels";
import { Inbox } from "lucide-react-native";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CHAT_COLUMN_RAIL_DATASET } from "@/chat-rail";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE, ICON_STROKE_WIDTH, type Theme } from "@/styles/theme";

const ThemedInbox = withUnistyles(Inbox);
const foregroundMutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function shortSourceId(id: string): string {
  const trimmed = id.trim();
  return trimmed.length <= 12 ? trimmed : `${trimmed.slice(0, 8)}…`;
}

export function PendingSubagentInboxBar({
  serverId,
  agentId,
  hidden = false,
}: {
  serverId: string;
  agentId: string;
  hidden?: boolean;
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
  if (hidden || !shouldShow || !inbox) return null;

  const sources = new Map(
    inbox.items.map((item) => [JSON.stringify([item.serverId ?? serverId, item.agentId]), item]),
  );
  const labels = [...sources.values()].map(
    (item) => item.title?.trim() || shortSourceId(item.agentId),
  );
  const visibleLabels = labels.slice(0, 3);
  const remaining = labels.length - visibleLabels.length;
  return (
    <View
      style={styles.rail}
      dataSet={CHAT_COLUMN_RAIL_DATASET}
      testID="pending-subagent-inbox-rail"
    >
      <View style={styles.inboxCard} testID="pending-subagent-inbox">
        <View style={styles.inboxCopy}>
          <View style={styles.inboxLabel}>
            <View style={styles.inboxIcon}>
              <ThemedInbox
                size={ICON_SIZE.sm}
                strokeWidth={ICON_STROKE_WIDTH}
                uniProps={foregroundMutedIconMapping}
              />
            </View>
            <Text style={styles.inboxText} numberOfLines={1} ellipsizeMode="tail">
              {t("agentStream.inbox.pending", { count: inbox.count })}
            </Text>
          </View>
          {visibleLabels.length > 0 ? (
            <Text style={styles.inboxSources} numberOfLines={1} ellipsizeMode="tail">
              {visibleLabels.join(", ")}
              {remaining > 0 ? ` +${remaining}` : ""}
            </Text>
          ) : null}
          {error ? (
            <Text
              style={styles.inboxError}
              accessibilityRole="alert"
              numberOfLines={2}
              ellipsizeMode="tail"
            >
              {t("agentStream.inbox.failed")}
            </Text>
          ) : null}
        </View>
        <Button
          variant="secondary"
          size="sm"
          numberOfLines={1}
          style={styles.flushButton}
          onPress={flush}
          disabled={isFlushing || !client}
          testID="flush-subagent-inbox"
        >
          {isFlushing ? t("agentStream.inbox.flushing") : t("agentStream.inbox.flush")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Shares the chat column rail with AgentTracks above and the Composer below.
  rail: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  inboxCard: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: { xs: theme.spacing[2], md: theme.spacing[3] },
    paddingVertical: theme.spacing[2],
    paddingLeft: { xs: theme.spacing[3], md: theme.spacing[4] },
    paddingRight: { xs: theme.spacing[2], md: theme.spacing[3] },
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  inboxCopy: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  inboxLabel: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  inboxIcon: {
    flexShrink: 0,
  },
  inboxText: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  inboxSources: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  inboxError: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  flushButton: {
    flexShrink: 0,
  },
}));
