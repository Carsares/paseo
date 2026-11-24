import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { readTopicQuestion } from "@/composer/draft/topic-first-question";
import { resolveTopicFirstQuestionDraftId } from "@/composer/draft/workspace-main-intent";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";

export function useTopicWorkspace({
  serverId,
  workspaceId,
  client,
  enabled,
}: {
  serverId: string;
  workspaceId: string;
  client: DaemonClient | null;
  enabled: boolean;
}) {
  // COMPAT(topicWorkbenchV1): added in v0.18.0, remove gate after 2027-06-01 once daemon floor >= v0.18.0.
  const supportsTopic = useHostFeature(serverId, "topicWorkbenchV1");
  const query = useFetchQuery({
    queryKey: ["topic-empty-workspace", serverId, workspaceId],
    queryFn: () => client!.findWorkspace(workspaceId),
    enabled: supportsTopic && enabled && Boolean(client),
    dataShape: "value",
    staleTimeMs: 30_000,
    retry: false,
  });
  return {
    workspace: supportsTopic ? query.data : undefined,
    isLoading: supportsTopic && query.isLoading,
  };
}

export function getUnboundTopicWorkspace<T extends Pick<WorkspaceDescriptorPayload, "topic">>(
  workspace: T | null | undefined,
  hasActiveMainAgent: boolean | undefined,
): T | null {
  return workspace?.topic?.mainAgentId === null && hasActiveMainAgent !== true ? workspace : null;
}

export function TopicEmptyState({
  workspace,
  onAsk,
}: {
  workspace: Pick<WorkspaceDescriptorPayload, "title" | "topic">;
  onAsk?: () => void;
}) {
  const { t } = useTranslation();
  const title = workspace.title?.trim();
  const summary = workspace.topic?.summary?.trim();
  return (
    <View style={styles.container} testID="topic-empty-state">
      <View style={styles.body}>
        <Text accessibilityRole="header" style={styles.title}>
          {title || t("topicWorkbench.ready")}
        </Text>
        <Text style={styles.detail}>{t("topicWorkbench.noQuestion")}</Text>
        {summary && summary !== title ? (
          <Text numberOfLines={4} style={styles.detail}>
            {summary}
          </Text>
        ) : null}
        {onAsk ? (
          <Button variant="secondary" onPress={onAsk}>
            {t("topicWorkbench.ask")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

export function TopicQuestionResume({
  enabled,
  serverId,
  workspaceId,
  openTargets,
  onOpen,
}: {
  enabled: boolean;
  serverId: string;
  workspaceId: string;
  openTargets: readonly WorkspaceTabTarget[];
  onOpen: (draftId: string) => void;
}) {
  const { t } = useTranslation();
  const [identity, setIdentity] = useState<{ serverId: string; workspaceId: string; id: string }>();
  const [savedDraftId, setSavedDraftId] = useState<string>();
  const draftId =
    identity?.serverId === serverId && identity.workspaceId === workspaceId ? identity.id : null;
  const isOpen = openTargets.some(
    (target) => target.kind === "draft" && target.draftId === draftId,
  );
  const handleOpen = useCallback(() => {
    if (draftId) onOpen(draftId);
  }, [draftId, onOpen]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void resolveTopicFirstQuestionDraftId(serverId, workspaceId).then(
      (id) => {
        if (!active) return;
        return setIdentity({ serverId, workspaceId, id });
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [enabled, serverId, workspaceId]);

  useEffect(() => {
    setSavedDraftId(undefined);
    if (!enabled || !draftId || isOpen) return;
    let active = true;
    void readTopicQuestion(draftId).then(
      (saved) => {
        if (!active || saved?.request.workspaceId !== workspaceId) return;
        return setSavedDraftId(draftId);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [draftId, enabled, isOpen, workspaceId]);

  if (!enabled || !draftId || isOpen || draftId !== savedDraftId) return null;
  return (
    <View style={styles.resumeRow}>
      <Button variant="outline" onPress={handleOpen}>
        {t("topicWorkbench.resumeQuestion")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  resumeRow: {
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  container: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  body: { alignItems: "center", gap: theme.spacing[3], maxWidth: 420 },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.lg, textAlign: "center" },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
