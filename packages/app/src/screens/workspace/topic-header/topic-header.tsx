import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptorPayload, WorkspaceTopic } from "@getpaseo/protocol/messages";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  EyeOff,
  Folder,
  GitBranch,
  PanelLeft,
  Users,
} from "lucide-react-native";
import type { TFunction } from "i18next";
import { memo, type ReactNode, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useFetchQuery } from "@/data/query";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { useHostFeature } from "@/runtime/host-features";
import type { TeamDirectorySummary } from "@/subagents/team-directory";
import type { Theme } from "@/styles/theme";
import {
  EMPTY_REPOS,
  getRebaseConflictLabel,
  useTopicHeaderGitRepos,
} from "./compact-rebase-conflict-action";
import {
  deriveTopicHeaderModel,
  fetchAllPendingDurableItemCount,
  type TopicHeaderActionStatus,
  type TopicHeaderDurableItemsState,
  type TopicHeaderEnvStatus,
  type TopicHeaderGitStatus,
  type TopicHeaderTeamStatus,
} from "./model";

const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const warningIcon = (theme: Theme) => ({ color: theme.colors.statusWarning });
const ThemedPanelLeft = withUnistyles(PanelLeft, mutedIcon);
const ThemedChevronDown = withUnistyles(ChevronDown, mutedIcon);
const ThemedChevronRight = withUnistyles(ChevronRight, mutedIcon);
const ThemedEyeOff = withUnistyles(EyeOff, mutedIcon);
const ThemedGitBranch = withUnistyles(GitBranch, mutedIcon);
const ThemedFolder = withUnistyles(Folder, mutedIcon);
const ThemedAlertTriangle = withUnistyles(AlertTriangle, warningIcon);
const ThemedUsers = withUnistyles(Users, mutedIcon);

const GIT_BRANCH_ICON = <ThemedGitBranch size={12} />;
const ALERT_TRIANGLE_ICON = <ThemedAlertTriangle size={12} />;
const FOLDER_ICON = <ThemedFolder size={12} />;
const USERS_ICON = <ThemedUsers size={12} />;

function resolveGitBadge(
  git: TopicHeaderGitStatus,
  t: TFunction,
): { label: string; variant: StatusBadgeVariant; leading: ReactNode } {
  if (git.kind === "rebase_conflict") {
    return {
      label: getRebaseConflictLabel(git.conflictCount, t),
      variant: "warning",
      leading: ALERT_TRIANGLE_ICON,
    };
  }
  if (git.kind === "multi_repo") {
    return {
      label: t("topicWorkbench.header.gitReposCount", { count: git.repoCount }),
      variant: "muted",
      leading: GIT_BRANCH_ICON,
    };
  }
  if (git.kind === "branch") {
    return { label: git.branchName, variant: "muted", leading: GIT_BRANCH_ICON };
  }
  if (git.kind === "detached") {
    return {
      label: t("topicWorkbench.header.gitDetached"),
      variant: "muted",
      leading: GIT_BRANCH_ICON,
    };
  }
  return { label: git.directoryName, variant: "muted", leading: FOLDER_ICON };
}

function resolveEnvBadge(
  env: TopicHeaderEnvStatus,
  t: TFunction,
): { label: string; variant: StatusBadgeVariant } {
  switch (env.kind) {
    case "running":
      return { label: t("topicWorkbench.header.envSettingUp"), variant: "warning" };
    case "failed":
      return { label: t("topicWorkbench.header.envFailed"), variant: "error" };
    case "blocked":
      return { label: t("topicWorkbench.header.envBlocked"), variant: "warning" };
    case "checking":
      return { label: t("topicWorkbench.header.envChecking"), variant: "muted" };
    case "ready":
      return { label: t("topicWorkbench.header.envReady"), variant: "muted" };
  }
}

function resolveTeamBadge(
  team: TopicHeaderTeamStatus,
  t: TFunction,
): { label: string; variant: StatusBadgeVariant } {
  switch (team.kind) {
    case "unbound":
      return { label: t("topicWorkbench.header.teamUnbound"), variant: "muted" };
    case "running":
      return {
        label: t("topicWorkbench.header.teamRunning", { count: team.runningCount }),
        variant: "success",
      };
    case "quiet":
      return { label: t("topicWorkbench.header.teamQuiet"), variant: "muted" };
    case "idle":
      return { label: t("topicWorkbench.header.teamIdle"), variant: "muted" };
  }
}

function resolveActionBadge(
  action: TopicHeaderActionStatus,
  t: TFunction,
): { label: string; variant: StatusBadgeVariant } {
  if (action.durableLoadState === "error") {
    return action.pendingCount > 0
      ? {
          label: t("topicWorkbench.header.actionPendingPartial", { count: action.pendingCount }),
          variant: "warning",
        }
      : { label: t("topicWorkbench.header.actionLoadFailed"), variant: "error" };
  }
  if (action.pendingCount > 0) {
    return {
      label: t("topicWorkbench.header.actionPending", { count: action.pendingCount }),
      variant: "warning",
    };
  }
  if (action.durableLoadState === "loading") {
    return { label: t("topicWorkbench.header.actionChecking"), variant: "muted" };
  }
  return { label: t("topicWorkbench.header.actionClear"), variant: "muted" };
}

function resolveDurableItemsState(input: {
  supportsDurableItems: boolean;
  isError: boolean;
  isSuccess: boolean;
  count: number | undefined;
}): TopicHeaderDurableItemsState {
  if (!input.supportsDurableItems) return { status: "disabled", pendingCount: 0 };
  if (input.isError) return { status: "error", pendingCount: 0 };
  if (input.isSuccess) return { status: "ready", pendingCount: input.count ?? 0 };
  return { status: "loading", pendingCount: 0 };
}

function TopicHeaderGitChip({
  git,
  badge,
  onOpenGitGraph,
}: {
  git: TopicHeaderGitStatus;
  badge: { label: string; variant: StatusBadgeVariant; leading: ReactNode };
  onOpenGitGraph: (conflictRepoRoot?: string | null) => void;
}) {
  const { t } = useTranslation();
  const conflictRepoRoot = git.kind === "rebase_conflict" ? git.conflictRepoRoot : null;
  const handlePress = useCallback(() => {
    onOpenGitGraph(conflictRepoRoot);
  }, [conflictRepoRoot, onOpenGitGraph]);
  if (!badge.label) return null;
  if (!git.canOpenGraph) {
    return (
      <View testID="topic-header-git-chip">
        <StatusBadge
          size="xs"
          variant={badge.variant}
          leading={badge.leading}
          label={badge.label}
        />
      </View>
    );
  }
  return (
    <PressHighlight
      style={styles.chipButton}
      highlightStyle={styles.chipHighlight}
      accessibilityRole="button"
      accessibilityLabel={
        git.kind === "rebase_conflict"
          ? t("topicWorkbench.header.gitOpenConflict")
          : t("topicWorkbench.header.gitOpenGraph")
      }
      onPress={handlePress}
      testID="topic-header-git-chip"
    >
      <StatusBadge size="xs" variant={badge.variant} leading={badge.leading} label={badge.label} />
    </PressHighlight>
  );
}

export interface TopicHeaderBarProps {
  serverId: string;
  workspaceId: string;
  client: DaemonClient | null;
  isConnected: boolean;
  isRouteFocused: boolean;
  topic: WorkspaceTopic | null | undefined;
  workspaceDirectory: string | null;
  isGitCheckout: boolean;
  currentBranchName: string | null;
  setupStatus: WorkspaceDescriptorPayload["setupStatus"];
  showWorkspaceSetup: boolean;
  isCheckoutStatusLoading: boolean;
  teamSummary: TeamDirectorySummary;
  isDirectoryVisible: boolean;
  onToggleDirectory: () => void;
  onOpenGitGraph: (conflictRepoRoot?: string | null) => void;
  onOpenSetupTab: () => void;
  onFocusAttentionAgent: (agentId: string | null) => void;
}

export const TopicHeaderBar = memo(function TopicHeaderBar({
  serverId,
  workspaceId,
  client,
  isConnected,
  isRouteFocused,
  topic,
  workspaceDirectory,
  isGitCheckout,
  currentBranchName,
  setupStatus,
  showWorkspaceSetup,
  isCheckoutStatusLoading,
  teamSummary,
  isDirectoryVisible,
  onToggleDirectory,
  onOpenGitGraph,
  onOpenSetupTab,
  onFocusAttentionAgent,
}: TopicHeaderBarProps) {
  const { t } = useTranslation();
  const scopeKey = `${serverId}\0${workspaceId}`;
  const [directionState, setDirectionState] = useState<{ scopeKey: string; expanded: boolean }>({
    scopeKey,
    expanded: false,
  });
  const directionExpanded = directionState.scopeKey === scopeKey && directionState.expanded;
  const toggleDirection = useCallback(() => {
    setDirectionState((current) => ({
      scopeKey,
      expanded: current.scopeKey === scopeKey ? !current.expanded : true,
    }));
  }, [scopeKey]);

  // COMPAT(checkoutGitGraphV1): added in v0.18.0, remove after 2027-06-01 once daemon floor >= v0.18.0.
  const supportsGitGraph = useHostFeature(serverId, "checkoutGitGraphV1");
  // COMPAT(workspaceDurableItemsV1): added in v0.18.0, remove after 2027-06-01 once daemon floor >= v0.18.0.
  const supportsDurableItems = useHostFeature(serverId, "workspaceDurableItemsV1");

  const { query: reposQuery } = useTopicHeaderGitRepos({
    serverId,
    client,
    isConnected,
    isRouteFocused,
    workspaceDirectory,
  });

  // Paginate all pending durable items so counts >50 never truncate and errors stay visible.
  const durableItemsQuery = useFetchQuery({
    queryKey: ["topic-header-durable-items", serverId, workspaceId],
    enabled: Boolean(
      isRouteFocused && isConnected && client && workspaceId && supportsDurableItems,
    ),
    dataShape: "value",
    staleTimeMs: 30_000,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      return fetchAllPendingDurableItemCount(client, workspaceId, signal);
    },
  });

  const durableItems = useMemo(
    () =>
      resolveDurableItemsState({
        supportsDurableItems,
        isError: durableItemsQuery.isError,
        isSuccess: durableItemsQuery.isSuccess,
        count: durableItemsQuery.data,
      }),
    [
      durableItemsQuery.data,
      durableItemsQuery.isError,
      durableItemsQuery.isSuccess,
      supportsDurableItems,
    ],
  );

  const model = useMemo(
    () =>
      deriveTopicHeaderModel({
        topic,
        workspaceDirectory,
        isGitCheckout,
        currentBranchName,
        discoveredRepos: reposQuery.data ?? EMPTY_REPOS,
        supportsGitGraph,
        setupStatus,
        showWorkspaceSetup,
        isCheckoutStatusLoading,
        teamSummary,
        durableItems,
      }),
    [
      currentBranchName,
      durableItems,
      isCheckoutStatusLoading,
      isGitCheckout,
      reposQuery.data,
      setupStatus,
      showWorkspaceSetup,
      supportsGitGraph,
      teamSummary,
      topic,
      workspaceDirectory,
    ],
  );

  const refetchDurableItems = durableItemsQuery.refetch;
  const handleActionChipPress = useCallback(() => {
    if (model.action.durableLoadState === "error") {
      void refetchDurableItems();
      if (!model.action.firstAttentionAgentId) return;
    }
    onFocusAttentionAgent(model.action.firstAttentionAgentId);
  }, [
    model.action.durableLoadState,
    model.action.firstAttentionAgentId,
    onFocusAttentionAgent,
    refetchDurableItems,
  ]);
  const directionAccessibilityState = useMemo(
    () => ({ expanded: directionExpanded }),
    [directionExpanded],
  );

  const gitBadge = resolveGitBadge(model.git, t);
  const envBadge = resolveEnvBadge(model.env, t);
  const teamBadge = resolveTeamBadge(model.team, t);
  const actionBadge = resolveActionBadge(model.action, t);

  return (
    <View style={styles.wrapper} testID="topic-header-bar">
      <View style={styles.row}>
        <View style={styles.leftGroup}>
          <ToolbarButton
            compact
            selected={isDirectoryVisible}
            label={t("topicWorkbench.header.toggleDirectory")}
            onPress={onToggleDirectory}
            testID="topic-header-toggle-directory"
          >
            <ThemedPanelLeft size={15} />
          </ToolbarButton>

          {model.directionSummary ? (
            <PressHighlight
              style={styles.directionToggle}
              highlightStyle={styles.chipHighlight}
              accessibilityRole="button"
              accessibilityState={directionAccessibilityState}
              onPress={toggleDirection}
              testID="topic-header-direction-toggle"
            >
              {directionExpanded ? (
                <ThemedChevronDown size={13} />
              ) : (
                <ThemedChevronRight size={13} />
              )}
              <Text numberOfLines={1} style={styles.directionToggleText}>
                {directionExpanded
                  ? t("topicWorkbench.header.hideDirection")
                  : t("topicWorkbench.header.showDirection")}
              </Text>
            </PressHighlight>
          ) : null}

          {model.hideFromModel ? (
            <View style={styles.privacyTag} testID="topic-header-hidden-from-model">
              <ThemedEyeOff size={12} />
              <Text numberOfLines={1} style={styles.privacyText}>
                {t("topicWorkbench.header.hiddenFromModel")}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={styles.statusCluster}>
          <TopicHeaderGitChip git={model.git} badge={gitBadge} onOpenGitGraph={onOpenGitGraph} />

          {model.env.canOpenSetup ? (
            <PressHighlight
              style={styles.chipButton}
              highlightStyle={styles.chipHighlight}
              accessibilityRole="button"
              accessibilityLabel={envBadge.label}
              onPress={onOpenSetupTab}
              testID="topic-header-env-chip"
            >
              <StatusBadge size="xs" variant={envBadge.variant} label={envBadge.label} />
            </PressHighlight>
          ) : (
            <View testID="topic-header-env-chip">
              <StatusBadge size="xs" variant={envBadge.variant} label={envBadge.label} />
            </View>
          )}

          <PressHighlight
            style={styles.chipButton}
            highlightStyle={styles.chipHighlight}
            accessibilityRole="button"
            accessibilityLabel={teamBadge.label}
            onPress={onToggleDirectory}
            testID="topic-header-team-chip"
          >
            <StatusBadge
              size="xs"
              variant={teamBadge.variant}
              leading={USERS_ICON}
              label={teamBadge.label}
            />
          </PressHighlight>

          <PressHighlight
            style={styles.chipButton}
            highlightStyle={styles.chipHighlight}
            accessibilityRole="button"
            accessibilityLabel={actionBadge.label}
            onPress={handleActionChipPress}
            testID="topic-header-action-chip"
          >
            <StatusBadge size="xs" variant={actionBadge.variant} label={actionBadge.label} />
          </PressHighlight>
        </View>
      </View>

      {directionExpanded && model.directionSummary ? (
        <View style={styles.directionPanel} testID="topic-header-direction-body">
          <Text style={styles.directionBody}>{model.directionSummary}</Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  wrapper: {
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    minHeight: 34,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    gap: theme.spacing[2],
  },
  leftGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
    flexShrink: 1,
  },
  directionToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.md,
  },
  directionToggleText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  privacyTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1.5],
  },
  privacyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  statusCluster: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  chipButton: {
    borderRadius: theme.borderRadius.full,
  },
  chipHighlight: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  directionPanel: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  directionBody: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
