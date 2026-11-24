import type { WorkspaceTaskSummary } from "@getpaseo/protocol/messages";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostFeature } from "@/runtime/host-features";
import { useWorkspaceTasks } from "./query";

interface WorkspaceTaskLedgerProps {
  serverId: string;
  workspaceId: string;
}

const recentProgressKinds = [
  "created",
  "dispatched",
  "turn_completed",
  "turn_failed",
  "turn_canceled",
  "idle",
  "error",
  "closed",
  "reset",
  "reported_completed",
  "reported_blocked",
  "archived",
] as const;

export function WorkspaceTaskLedger({ serverId, workspaceId }: WorkspaceTaskLedgerProps) {
  // COMPAT(workspaceTaskLedger): added in v0.17.0, remove gate after 2027-05-24.
  const supported = useHostFeature(serverId, "workspaceTaskLedger");
  if (!supported || !workspaceId) return null;
  return <WorkspaceTaskLedgerTrack serverId={serverId} workspaceId={workspaceId} />;
}

function WorkspaceTaskLedgerTrack({ serverId, workspaceId }: WorkspaceTaskLedgerProps) {
  const { t, i18n } = useTranslation();
  const active = useRetainedPanelActive();
  const { query, available } = useWorkspaceTasks(serverId, workspaceId, active);
  const { data: tasks, isError, isFetching, refetch } = query;
  const retry = useCallback(() => {
    if (active && available && !isFetching) void refetch();
  }, [active, available, isFetching, refetch]);
  const title = t("workspaceTaskLedger.title");
  const count = new Intl.NumberFormat(i18n.resolvedLanguage).format(tasks?.length ?? 0);
  const label = tasks ? t("workspaceTaskLedger.count", { total: count }) : title;
  const retryLabel = t("common.actions.retry");
  let notice: string | null = null;
  if (!available) {
    notice = t("workspace.terminal.hostDisconnected");
  } else if (isError) {
    notice = t("workspaceTaskLedger.loadFailed");
  } else if (!tasks) {
    notice = t("common.loading");
  } else if (tasks.length === 0) {
    notice = t("workspaceTaskLedger.empty");
  }

  return (
    <ComposerTrackPill
      key={JSON.stringify([serverId, workspaceId])}
      testID="workspace-task-ledger"
      segments={[{ bucket: null, text: label }]}
      panelTitle={title}
    >
      {notice ? (
        <ComposerTrackRow>
          <Text style={styles.detail}>{notice}</Text>
        </ComposerTrackRow>
      ) : null}
      {available && isError ? (
        <ComposerTrackRow
          accessibilityLabel={retryLabel}
          onPress={retry}
          closeOnSelect={false}
          disabled={isFetching}
        >
          <Text style={styles.title}>{retryLabel}</Text>
        </ComposerTrackRow>
      ) : null}
      {tasks?.map((task) => (
        <WorkspaceTaskRow key={task.taskId} task={task} />
      ))}
    </ComposerTrackPill>
  );
}

function WorkspaceTaskRow({ task }: { task: WorkspaceTaskSummary }) {
  const { t, i18n } = useTranslation();
  const boundCount = new Intl.NumberFormat(i18n.resolvedLanguage).format(task.participants.length);
  // The progress event lacks a host ID and is displayed at task level.
  const recent = task.latestProgress;
  const progressKind = recentProgressKinds.find((kind) => kind === recent?.kind) ?? "updated";
  return (
    <ComposerTrackRow>
      <View style={styles.row}>
        <Text style={styles.title}>{task.title}</Text>
        <Text style={styles.detail}>
          {t(`workspaceTaskLedger.status.${task.status}`)} · {task.tier} ·{" "}
          {t("workspaceTaskLedger.boundSessions", { total: boundCount })}
        </Text>
        {recent ? (
          <Text style={styles.detail}>
            {t("workspaceTaskLedger.recentProgress", {
              event: t(`workspaceTaskLedger.progressKind.${progressKind}`),
            })}
          </Text>
        ) : null}
        {task.verificationState ? (
          <Text style={styles.detail}>
            {t("workspaceTaskLedger.verification", {
              state: t(`workspaceTaskLedger.verificationState.${task.verificationState}`),
            })}
          </Text>
        ) : null}
        {task.blockingQuestion ? (
          <Text style={styles.detail}>
            {t("workspaceTaskLedger.blockingQuestion", { question: task.blockingQuestion })}
          </Text>
        ) : null}
        {task.handoffSummary ? <Text style={styles.detail}>{task.handoffSummary}</Text> : null}
      </View>
    </ComposerTrackRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0, gap: theme.spacing[1] },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
