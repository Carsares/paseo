import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptorPayload, WorkspaceTopic } from "@getpaseo/protocol/messages";
import { PanelLeft } from "lucide-react-native";
import type { TFunction } from "i18next";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { useFetchQuery } from "@/data/query";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useHostFeature } from "@/runtime/host-features";
import type { TeamDirectorySummary } from "@/subagents/team-directory";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
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

const ThemedPanelLeft = withUnistyles(PanelLeft, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

export function TopicDirectoryToggle({
  visible,
  onToggle,
}: {
  visible: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ToolbarButton
      compact
      selected={visible}
      label={t("topicWorkbench.header.toggleDirectory")}
      onPress={onToggle}
      testID="topic-header-toggle-directory"
    >
      <ThemedPanelLeft size={16} />
    </ToolbarButton>
  );
}

function resolveGitLabel(git: TopicHeaderGitStatus, t: TFunction): string {
  switch (git.kind) {
    case "rebase_conflict":
      return getRebaseConflictLabel(git.conflictCount, t);
    case "multi_repo":
      return t("topicWorkbench.header.gitReposCount", { count: git.repoCount });
    case "branch":
      return git.branchName;
    case "detached":
      return t("topicWorkbench.header.gitDetached");
    case "directory":
      return git.directoryName;
  }
}

function resolveEnvLabel(env: TopicHeaderEnvStatus, t: TFunction): string {
  switch (env.kind) {
    case "running":
      return t("topicWorkbench.header.envSettingUp");
    case "failed":
      return t("topicWorkbench.header.envFailed");
    case "blocked":
      return t("topicWorkbench.header.envBlocked");
    case "checking":
      return t("topicWorkbench.header.envChecking");
    case "ready":
      return t("topicWorkbench.header.envReady");
  }
}

function resolveTeamLabel(team: TopicHeaderTeamStatus, t: TFunction): string {
  switch (team.kind) {
    case "unbound":
      return t("topicWorkbench.header.teamUnbound");
    case "running":
      return t("topicWorkbench.header.teamRunning", { count: team.runningCount });
    case "quiet":
      return t("topicWorkbench.header.teamQuiet");
    case "idle":
      return t("topicWorkbench.header.teamIdle");
  }
}

function resolveActionLabel(action: TopicHeaderActionStatus, t: TFunction): string {
  if (action.durableLoadState === "error") {
    return action.pendingCount > 0
      ? t("topicWorkbench.header.actionPendingPartial", { count: action.pendingCount })
      : t("topicWorkbench.header.actionLoadFailed");
  }
  if (action.pendingCount > 0) {
    return t("topicWorkbench.header.actionPending", { count: action.pendingCount });
  }
  if (action.durableLoadState === "loading") {
    return t("topicWorkbench.header.actionChecking");
  }
  return t("topicWorkbench.header.actionClear");
}

export interface TopicHeaderMenuStatus {
  direction: string | null;
  hideFromModel: boolean;
  needsAttention: boolean;
  gitLabel: string;
  onOpenGit?: () => void;
  envLabel: string;
  teamLabel: string;
  pendingLabel: string;
  onOpenPending: () => boolean;
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

interface TopicHeaderStatusInput {
  enabled: boolean;
  compact: boolean;
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
  onOpenGitGraph: (conflictRepoRoot?: string | null) => void;
  onFocusAttentionAgent: (agentId: string | null) => void;
}

export function useTopicHeaderMenuStatus({
  enabled,
  compact,
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
  onOpenGitGraph,
  onFocusAttentionAgent,
}: TopicHeaderStatusInput): TopicHeaderMenuStatus | undefined {
  const { t } = useTranslation();
  const appActive = useAppActivelyVisible();
  // COMPAT(checkoutGitGraphV1): added in v0.18.0, remove after 2027-06-01 once daemon floor >= v0.18.0.
  const supportsGitGraph = useHostFeature(serverId, "checkoutGitGraphV1");
  // COMPAT(checkoutGitRebaseV1): added in v0.18.0, remove after 2027-06-01 once daemon floor >= v0.18.0.
  const supportsRebase = useHostFeature(serverId, "checkoutGitRebaseV1");
  const supportsStaging = useHostFeature(serverId, "checkoutGitStagingV1");
  const watchConflicts = compact && supportsGitGraph && supportsRebase && supportsStaging;
  // COMPAT(workspaceDurableItemsV1): added in v0.18.0, remove after 2027-06-01 once daemon floor >= v0.18.0.
  const supportsDurableItems = useHostFeature(serverId, "workspaceDurableItemsV1");

  const { query: reposQuery } = useTopicHeaderGitRepos(
    {
      serverId,
      client,
      isConnected,
      isRouteFocused: enabled && isRouteFocused && (!watchConflicts || appActive),
      workspaceDirectory,
    },
    watchConflicts ? "compact-conflict" : "summary",
  );

  // Paginate all pending durable items so counts >50 never truncate and errors stay visible.
  const durableItemsQuery = useFetchQuery({
    queryKey: ["topic-header-durable-items", serverId, workspaceId],
    enabled: Boolean(
      enabled && isRouteFocused && isConnected && client && workspaceId && supportsDurableItems,
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
        discoveredRepos: reposQuery.isPlaceholderData
          ? EMPTY_REPOS
          : (reposQuery.data ?? EMPTY_REPOS),
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
      reposQuery.isPlaceholderData,
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
      if (!model.action.firstAttentionAgentId) return false;
    }
    onFocusAttentionAgent(model.action.firstAttentionAgentId);
    return model.action.firstAttentionAgentId === null;
  }, [
    model.action.durableLoadState,
    model.action.firstAttentionAgentId,
    onFocusAttentionAgent,
    refetchDurableItems,
  ]);
  const conflictRepoRoot = model.git.kind === "rebase_conflict" ? model.git.conflictRepoRoot : null;
  const handleOpenGit = useCallback(() => {
    onOpenGitGraph(conflictRepoRoot);
  }, [conflictRepoRoot, onOpenGitGraph]);
  return useMemo(
    () =>
      enabled
        ? {
            direction: model.directionSummary,
            hideFromModel: model.hideFromModel,
            needsAttention:
              model.git.kind === "rebase_conflict" ||
              model.env.kind === "failed" ||
              model.env.kind === "blocked" ||
              model.action.pendingCount > 0 ||
              model.action.durableLoadState === "error",
            gitLabel: resolveGitLabel(model.git, t),
            onOpenGit: model.git.canOpenGraph ? handleOpenGit : undefined,
            envLabel: resolveEnvLabel(model.env, t),
            teamLabel: resolveTeamLabel(model.team, t),
            pendingLabel: resolveActionLabel(model.action, t),
            onOpenPending: handleActionChipPress,
          }
        : undefined,
    [enabled, handleActionChipPress, handleOpenGit, model, t],
  );
}
