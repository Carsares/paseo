import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CheckoutGitRepo } from "@getpaseo/protocol/messages";
import type { TFunction } from "i18next";
import { AlertTriangle } from "lucide-react-native";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { TOUCH_TARGET } from "@/components/ui/control-geometry";
import { StatusBadge } from "@/components/ui/status-badge";
import { useFetchQuery } from "@/data/query";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { useHostFeature } from "@/runtime/host-features";
import { deriveTopicHeaderGitStatus } from "./model";

export const EMPTY_REPOS: CheckoutGitRepo[] = [];
const CONFLICT_REFRESH_MS = 10_000;

const ThemedAlertTriangle = withUnistyles(AlertTriangle, (theme) => ({
  color: theme.colors.statusWarning,
}));
const WARNING_ICON = <ThemedAlertTriangle size={12} />;

export function getRebaseConflictLabel(conflictCount: number, t: TFunction): string {
  return conflictCount > 1
    ? t("topicWorkbench.header.gitRebaseConflictCount", { count: conflictCount })
    : t("topicWorkbench.header.gitRebaseConflict");
}

interface TopicHeaderGitSource {
  serverId: string;
  isConnected: boolean;
  isRouteFocused: boolean;
  workspaceDirectory: string | null;
  client: Pick<DaemonClient, "checkoutGitReposDiscover"> | null;
}

export function useTopicHeaderGitRepos(
  { serverId, client, isConnected, isRouteFocused, workspaceDirectory }: TopicHeaderGitSource,
  purpose: "summary" | "compact-conflict" = "summary",
) {
  // COMPAT(checkoutGitMultiRepoV1): added in v0.18.0, remove after 2027-06-01 once daemon floor >= v0.18.0.
  const supportsMultiRepo = useHostFeature(serverId, "checkoutGitMultiRepoV1");
  const active = useRetainedPanelActive();
  const watchConflicts = purpose === "compact-conflict";
  const enabled = Boolean(
    active && isRouteFocused && isConnected && client && workspaceDirectory && supportsMultiRepo,
  );
  const query = useFetchQuery({
    queryKey: ["topic-header-git-repos", serverId, workspaceDirectory, purpose],
    enabled,
    dataShape: "list",
    staleTimeMs: watchConflicts ? 0 : 30_000,
    // Checkout status pushes don't report per-repository operation state.
    refetchInterval: watchConflicts && enabled ? CONFLICT_REFRESH_MS : false,
    retry: false,
    queryFn: async () => {
      if (!client || !workspaceDirectory) return EMPTY_REPOS;
      const result = await client.checkoutGitReposDiscover(
        watchConflicts
          ? { cwd: workspaceDirectory, maxDepth: 2, includeWorktrees: true }
          : { cwd: workspaceDirectory },
      );
      if (result.error) throw new Error(result.error);
      return result.repos ?? EMPTY_REPOS;
    },
  });
  return { query, supportsMultiRepo };
}

const NO_SHORTCUTS: [] = [];

export function CompactWorkspaceRebaseConflictAction({
  onOpenGitGraph,
  ...source
}: TopicHeaderGitSource & { onOpenGitGraph: (repoRoot: string) => void }) {
  const { t } = useTranslation();
  // COMPAT(checkoutGitRebaseV1): added in v0.18.0, remove after 2027-06-01 once daemon floor >= v0.18.0.
  const supportsRebase = useHostFeature(source.serverId, "checkoutGitRebaseV1");
  const supportsStaging = useHostFeature(source.serverId, "checkoutGitStagingV1");
  const supportsGitGraph = useHostFeature(source.serverId, "checkoutGitGraphV1");
  const enabled = supportsRebase && supportsStaging && supportsGitGraph && source.isConnected;
  const appActive = useAppActivelyVisible();
  const { query: repos, supportsMultiRepo } = useTopicHeaderGitRepos(
    { ...source, isRouteFocused: enabled && appActive && source.isRouteFocused },
    "compact-conflict",
  );
  const discoveredRepos = repos.isPlaceholderData ? EMPTY_REPOS : (repos.data ?? EMPTY_REPOS);
  const git = deriveTopicHeaderGitStatus({
    workspaceDirectory: source.workspaceDirectory,
    isGitCheckout: false,
    currentBranchName: null,
    discoveredRepos,
    supportsGitGraph,
  });
  const repoRoot = git.kind === "rebase_conflict" ? git.conflictRepoRoot : null;
  const openConflict = useCallback(() => {
    if (repoRoot) onOpenGitGraph(repoRoot);
  }, [onOpenGitGraph, repoRoot]);
  if (!enabled || !supportsMultiRepo || git.kind !== "rebase_conflict" || !repoRoot) return null;

  const badgeLabel = getRebaseConflictLabel(git.conflictCount, t);
  const label = t("topicWorkbench.header.gitOpenConflict");
  return (
    <HeaderToggleButton
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={openConflict}
      tooltipLabel={label}
      tooltipKeys={NO_SHORTCUTS}
      tooltipSide="bottom"
      testID="workspace-header-rebase-conflict"
      style={styles.compactConflictAction}
    >
      <StatusBadge size="xs" variant="warning" leading={WARNING_ICON} label={badgeLabel} />
    </HeaderToggleButton>
  );
}

const styles = StyleSheet.create((theme) => ({
  compactConflictAction: {
    width: "auto",
    minWidth: TOUCH_TARGET,
    paddingHorizontal: theme.spacing[1],
  },
}));
