import { useLocalSearchParams } from "expo-router";
import { useNavigation } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import {
  ComposerEditingScope,
  WorkspaceComposerEditingSessionsProvider,
} from "@/composer/editing-session";
import { NewWorkspaceScreen } from "@/screens/new-workspace-screen";
import { buildNewWorkspaceDraftKey } from "@/stores/draft-keys";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";

/** New workspace drafts share one editing-session home, keyed like a tab by draft. */
const NEW_WORKSPACE_SESSIONS_KEY = "new-workspace";

function DraftSetupBoundary({
  draftId,
  serverId,
  children,
}: {
  draftId: string | undefined;
  serverId: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const draftSetupStatus = useWorkspaceDraftSubmissionStore((state) =>
    draftId && Object.hasOwn(state.draftSetupStatusById, draftId)
      ? state.draftSetupStatusById[draftId]
      : undefined,
  );
  useEffect(() => {
    if (draftId) void useWorkspaceDraftSubmissionStore.getState().hydrateDraftSetup(draftId);
  }, [draftId]);
  // Mount the form with its restored Fork defaults, before any launch path can submit.
  if (draftId && (!draftSetupStatus || draftSetupStatus === "loading")) {
    return (
      <View style={styles.status}>
        <ActivityIndicator />
      </View>
    );
  }
  if (
    draftSetupStatus === "unavailable" ||
    (typeof draftSetupStatus === "object" &&
      draftSetupStatus.sourceServerId !== null &&
      draftSetupStatus.sourceServerId !== serverId.trim())
  ) {
    return (
      <View style={styles.status}>
        <Text accessibilityRole="alert" style={styles.error}>
          {t("message.actions.forkUnavailable")}
        </Text>
      </View>
    );
  }
  return children;
}

export default function NewWorkspaceRoute() {
  const params = useLocalSearchParams<{
    serverId?: string;
    dir?: string;
    name?: string;
    projectId?: string;
    draftId?: string;
    creationDraftId?: string;
  }>();
  const navigation = useNavigation<{ setParams: (params: { creationDraftId: string }) => void }>();
  const rememberCreationDraft = useCallback(
    (creationDraftId: string) => navigation.setParams({ creationDraftId }),
    [navigation],
  );
  // Ordinary messages still share their composer draft. Only creation identity belongs in the URL.
  const creationDraftId =
    typeof params.creationDraftId === "string"
      ? params.creationDraftId.trim() || undefined
      : undefined;
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const sourceDirectory = typeof params.dir === "string" ? params.dir : undefined;
  const displayName = typeof params.name === "string" ? params.name : undefined;
  const projectId = typeof params.projectId === "string" ? params.projectId : undefined;
  const draftId =
    typeof params.draftId === "string" ? params.draftId.trim() || undefined : undefined;
  const screenKey = JSON.stringify([
    serverId,
    sourceDirectory ?? null,
    displayName ?? null,
    projectId ?? null,
    draftId ?? null,
  ]);

  // The shell remounts this route when the viewport crosses the compact breakpoint;
  // the draft's editing session (fullscreen, retained caret) lives above the shell.
  const draftKey = buildNewWorkspaceDraftKey(draftId);
  const sessionTabIds = useMemo(() => [draftKey], [draftKey]);

  return (
    <HostRouteBootstrapBoundary>
      <DraftSetupBoundary draftId={draftId} serverId={serverId}>
        <WorkspaceComposerEditingSessionsProvider
          workspaceKey={NEW_WORKSPACE_SESSIONS_KEY}
          tabIds={sessionTabIds}
        >
          <ComposerEditingScope tabId={draftKey} targetKey={draftKey}>
            <NewWorkspaceScreen
              key={screenKey}
              creationDraftId={creationDraftId}
              rememberCreationDraft={rememberCreationDraft}
              serverId={serverId}
              sourceDirectory={sourceDirectory}
              displayName={displayName}
              projectId={projectId}
              draftId={draftId}
            />
          </ComposerEditingScope>
        </WorkspaceComposerEditingSessionsProvider>
      </DraftSetupBoundary>
    </HostRouteBootstrapBoundary>
  );
}

const styles = StyleSheet.create((theme) => ({
  status: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { color: theme.colors.foreground },
}));
