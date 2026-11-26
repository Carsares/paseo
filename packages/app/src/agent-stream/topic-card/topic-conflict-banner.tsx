import type {
  WorkspaceTaskFileConflict,
  WorkspaceTaskFileConflictPeer,
} from "@getpaseo/protocol/messages";
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  FileText,
} from "lucide-react-native";
import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { buildTopicDisclosureKey, useTopicStreamViewStore } from "@/stores/topic-stream-view-store";
import type { Theme } from "@/styles/theme";
import { useDisclosureHold } from "../disclosure";

const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedAlertTriangle = withUnistyles(AlertTriangle, warningIconMapping);
const ThemedArrowUpRight = withUnistyles(ArrowUpRight, warningIconMapping);
const ThemedChevronDown = withUnistyles(ChevronDown, mutedIconMapping);
const ThemedChevronRight = withUnistyles(ChevronRight, mutedIconMapping);
const ThemedFileText = withUnistyles(FileText, mutedIconMapping);

const EXPANDED_STATE = { expanded: true } as const;
const COLLAPSED_STATE = { expanded: false } as const;

export interface TopicConflictBannerProps {
  agentKey: string;
  topicKey: string;
  conflicts: readonly WorkspaceTaskFileConflict[];
  onJumpToPeerTopic?: (peerTaskId: string) => void;
}

const PeerJumpPill = memo(function PeerJumpPill({
  peer,
  onJump,
}: {
  peer: WorkspaceTaskFileConflictPeer;
  onJump: (peerTaskId: string) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onJump(peer.taskId);
  }, [onJump, peer.taskId]);

  return (
    <PressHighlight
      accessibilityRole="button"
      onPress={handlePress}
      style={styles.jumpPill}
      testID={`topic-conflict-jump-${peer.taskId}`}
    >
      <Text style={styles.jumpPillText} numberOfLines={1}>
        {t("topicWorkbench.topicStream.conflictJumpToPeer")}
      </Text>
      <ThemedArrowUpRight size={12} />
    </PressHighlight>
  );
});

const FilePeerChip = memo(function FilePeerChip({
  peer,
  onJump,
}: {
  peer: WorkspaceTaskFileConflictPeer;
  onJump?: (peerTaskId: string) => void;
}) {
  const handlePress = useCallback(() => {
    onJump?.(peer.taskId);
  }, [onJump, peer.taskId]);

  return (
    <PressHighlight
      accessibilityRole="button"
      disabled={!onJump}
      onPress={handlePress}
      style={styles.filePeerChip}
      testID={`topic-conflict-file-peer-${peer.taskId}`}
    >
      <Text style={styles.filePeerText} numberOfLines={1}>
        {peer.leadTitle ? `${peer.title} · ${peer.leadTitle}` : peer.title}
      </Text>
    </PressHighlight>
  );
});

function formatConflictSummary(
  t: ReturnType<typeof useTranslation>["t"],
  uniquePeers: readonly WorkspaceTaskFileConflictPeer[],
  fileCount: number,
): string {
  const primaryPeer = uniquePeers[0];
  if (uniquePeers.length > 1 && primaryPeer) {
    return t("topicWorkbench.topicStream.conflictSummaryMultiplePeers", {
      peerTitle: primaryPeer.title,
      peerCount: uniquePeers.length,
      fileCount,
    });
  }
  if (primaryPeer) {
    return t("topicWorkbench.topicStream.conflictSummarySinglePeer", {
      peerTitle: primaryPeer.title,
      fileCount,
    });
  }
  return t("topicWorkbench.topicStream.conflictSummaryGeneric", { fileCount });
}

export const TopicConflictBanner = memo(function TopicConflictBanner({
  agentKey,
  topicKey,
  conflicts,
  onJumpToPeerTopic,
}: TopicConflictBannerProps) {
  const { t } = useTranslation();
  const hold = useDisclosureHold();
  const disclosureKey = buildTopicDisclosureKey(agentKey, topicKey);
  const expanded = useTopicStreamViewStore(
    (state) => state.expandedConflictsByTopicKey[disclosureKey] ?? false,
  );
  const setConflictsExpanded = useTopicStreamViewStore((state) => state.setConflictsExpanded);

  const uniquePeers = useMemo(() => {
    const byTaskId = new Map<string, WorkspaceTaskFileConflictPeer>();
    for (const conflict of conflicts) {
      for (const peer of conflict.peers) {
        if (!byTaskId.has(peer.taskId)) {
          byTaskId.set(peer.taskId, peer);
        }
      }
    }
    return [...byTaskId.values()];
  }, [conflicts]);

  const toggleExpanded = useCallback(() => {
    hold(() => setConflictsExpanded(disclosureKey, !expanded));
  }, [disclosureKey, expanded, hold, setConflictsExpanded]);

  if (conflicts.length === 0) return null;

  const primaryPeer = uniquePeers[0];
  const summaryText = formatConflictSummary(t, uniquePeers, conflicts.length);

  return (
    <View style={styles.container} testID={`topic-conflict-banner-${topicKey}`}>
      <View style={styles.headerRow}>
        <View style={styles.summaryRow}>
          <ThemedAlertTriangle size={14} />
          <Text style={styles.summaryText} numberOfLines={2}>
            {summaryText}
          </Text>
        </View>
        <View style={styles.headerActions}>
          {primaryPeer && onJumpToPeerTopic ? (
            <PeerJumpPill peer={primaryPeer} onJump={onJumpToPeerTopic} />
          ) : null}
          <PressHighlight
            accessibilityRole="button"
            accessibilityState={expanded ? EXPANDED_STATE : COLLAPSED_STATE}
            onPress={toggleExpanded}
            style={styles.expandButton}
            testID={`topic-conflict-toggle-${topicKey}`}
          >
            {expanded ? <ThemedChevronDown size={13} /> : <ThemedChevronRight size={13} />}
            <Text style={styles.expandLabel}>
              {t(
                expanded
                  ? "topicWorkbench.topicStream.conflictHideFiles"
                  : "topicWorkbench.topicStream.conflictShowFiles",
              )}
            </Text>
          </PressHighlight>
        </View>
      </View>

      {expanded ? (
        <View style={styles.fileList} testID={`topic-conflict-files-${topicKey}`}>
          {conflicts.map((conflict) => (
            <View key={conflict.path} style={styles.fileRow}>
              <View style={styles.filePathRow}>
                <ThemedFileText size={12} />
                <Text style={styles.filePathText} numberOfLines={1}>
                  {conflict.path}
                </Text>
              </View>
              {conflict.peers.length > 0 ? (
                <View style={styles.filePeersRow}>
                  {conflict.peers.map((peer) => (
                    <FilePeerChip
                      key={`${conflict.path}:${peer.taskId}`}
                      peer={peer}
                      onJump={onJumpToPeerTopic}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusWarning,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  headerRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  summaryRow: {
    flex: 1,
    minWidth: 160,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  summaryText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  jumpPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: 26,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusWarning,
    backgroundColor: theme.colors.surface1,
  },
  jumpPillText: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  expandButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0.5],
    minHeight: 26,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.md,
  },
  expandLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  fileList: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1.5],
  },
  fileRow: {
    gap: theme.spacing[1],
  },
  filePathRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  filePathText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.code,
    fontFamily: theme.fontFamily.mono,
  },
  filePeersRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[4],
  },
  filePeerChip: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  filePeerText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
