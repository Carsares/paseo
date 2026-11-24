import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { workspaceDeferralKind } from "./model";
import { useDeferralOperation, type WorkspaceDeferralTarget } from "./operations";

export function useSearchWorkspaceDeferral(serverId: string | null, workspaceId: string | null) {
  return useWorkspaceFields(serverId, workspaceId, workspaceDeferralKind);
}

export function WorkspaceDeferralSearchControl({
  serverId,
  workspaceId,
  kind,
}: WorkspaceDeferralTarget & { kind: NonNullable<ReturnType<typeof useSearchWorkspaceDeferral>> }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { supported, online, pending, run } = useDeferralOperation(serverId);
  const restore = useCallback(
    () =>
      void run(
        (client) => client.setWorkspaceDeferral({ workspaceId, action: "restore" }),
        (error) => toast.error(error),
      ),
    [run, toast, workspaceId],
  );
  return (
    <View style={styles.controls} testID="search-workspace-deferral">
      <Text style={styles.status} numberOfLines={1}>
        {t(`sidebar.workspace.deferral.${kind}`)}
      </Text>
      <Button
        size="sm"
        variant="ghost"
        disabled={!supported || !online}
        loading={pending}
        onPress={restore}
        testID="search-workspace-restore"
      >
        {t("sidebar.workspace.deferral.restore")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingRight: theme.spacing[4],
  },
  status: { color: theme.colors.foregroundMuted, fontSize: 12 },
}));
