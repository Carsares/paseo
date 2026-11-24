import { useEffect, useMemo, useReducer } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { formatDeferralTime } from "@/workspace-deferral/model";
import { useDeferralOperation } from "@/workspace-deferral/operations";
import {
  selectAgentLimitRecovery,
  type AgentRecoveryTarget,
} from "@/workspace-deferral/agent-recovery";

function selectAgent(
  state: ReturnType<typeof useSessionStore.getState>,
  { serverId, agentId }: AgentRecoveryTarget,
) {
  const session = state.sessions[serverId];
  return session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
}

export function AgentLimitRecovery(target: AgentRecoveryTarget) {
  return (
    <AgentLimitRecoveryContent
      key={JSON.stringify([target.serverId, target.workspaceId, target.agentId])}
      {...target}
    />
  );
}

function AgentLimitRecoveryContent(target: AgentRecoveryTarget) {
  const { t, i18n } = useTranslation();
  const agent = useSessionStore((state) => selectAgent(state, target));
  const { supported, online, pending, error, run } = useDeferralOperation(target.serverId);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const recovery = selectAgentLimitRecovery(agent, target, Date.now());
  const expiry = supported && recovery?.state === "limited" ? recovery.time : null;
  useEffect(() => {
    if (!expiry) return;
    const expiresAt = Date.parse(expiry);
    // Refresh the controls when the evidence expires. The host owns all scheduled work.
    let timer: ReturnType<typeof setTimeout> | undefined;
    function checkExpiry() {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) redraw();
      else timer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
    }
    checkExpiry();
    return () => clearTimeout(timer);
  }, [expiry]);

  const buttons = useMemo(
    () =>
      recovery?.actions.map((action) => ({
        action,
        onPress: () =>
          void run((client) => {
            const current = selectAgentLimitRecovery(
              selectAgent(useSessionStore.getState(), target),
              target,
              Date.now(),
            );
            if (
              !current ||
              current.turnId !== recovery.turnId ||
              !current.actions.includes(action)
            ) {
              throw new Error(t("agentPanel.limitRecovery.changed"));
            }
            return client.setAgentLimitRecovery({
              workspaceId: target.workspaceId,
              agentId: target.agentId,
              turnId: recovery.turnId,
              action,
            });
          }),
      })),
    [recovery, run, t, target],
  );

  if (!supported || !recovery) return null;
  return (
    <View style={styles.container} testID="agent-limit-recovery">
      <Text style={styles.message} accessibilityLiveRegion="polite">
        {t(`agentPanel.limitRecovery.${recovery.state}`, {
          time: formatDeferralTime(recovery.time, i18n.language),
        })}
      </Text>
      {recovery.actions.length ? (
        <View style={styles.actions}>
          {buttons?.map(({ action, onPress }) => (
            <Button
              key={action}
              size="sm"
              disabled={pending || !online}
              testID={`agent-limit-recovery-${action}`}
              onPress={onPress}
            >
              {t(`agentPanel.limitRecovery.${action}`)}
            </Button>
          ))}
        </View>
      ) : null}
      {error || pending || !online ? (
        <Text
          style={styles.message}
          accessibilityLiveRegion="polite"
          testID="agent-limit-recovery-feedback"
        >
          {error ??
            t(
              pending ? "sidebar.workspace.deferral.pending" : "sidebar.workspace.deferral.offline",
            )}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  message: { color: theme.colors.foregroundMuted, fontSize: 13 },
}));
