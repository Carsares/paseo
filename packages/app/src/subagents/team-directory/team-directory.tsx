import type { AgentAddress } from "@getpaseo/protocol/addresses";
import type { AgentProfile, ServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Columns2,
  ExternalLink,
  MoreVertical,
  PanelLeftClose,
  Plus,
  RotateCcw,
  Trash2,
  Unlink,
  UserMinus,
  UserPlus,
} from "lucide-react-native";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { useOpenKebabMenuVisibility } from "@/components/sidebar/use-open-kebab-menu-visibility";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { useReplicaQuery } from "@/data/query";
import {
  applyArchivedAgentCloseResults,
  clearArchiveAgentPending,
  setAgentArchiving,
  usePendingArchiveAgentKeys,
} from "@/hooks/use-archive-agent";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { getStatusDotColor } from "@/utils/status-dot-color";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { useWorkspaceArchivedAgents } from "../main-control-tree/use-workspace-archived-agents";
import { refreshProviderSubagents, useProviderSubagentStore } from "../provider-store";
import {
  residentActionsForAgent,
  supportsResidentAction,
  type ResidentAction,
} from "../resident-actions";
import { useCreateResidentAction, useOpenResidentDialog } from "../resident-dialog";
import { useArchiveSubagent } from "../use-archive-subagent";
import { useDetachSubagent } from "../use-detach-subagent";
import {
  isDirectlyCleanableTaskMember,
  selectTeamDirectoryData,
  teamDirectoryNodeKey,
  type TeamDirectoryAgent,
  type TeamDirectoryMemberNode,
  type TeamDirectoryNativeSubrunNode,
  type TeamDirectoryPresetResident,
  type TeamDirectoryResidentGroup,
  type TeamDirectoryTaskBranch,
} from "./model";

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedChevronDown = withUnistyles(ChevronDown, mutedIconMapping);
const ThemedChevronRight = withUnistyles(ChevronRight, mutedIconMapping);
const ThemedPanelLeftClose = withUnistyles(PanelLeftClose, mutedIconMapping);
const ThemedPlus = withUnistyles(Plus, mutedIconMapping);
const ThemedMoreVertical = withUnistyles(MoreVertical, mutedIconMapping);
const ThemedTrash2 = withUnistyles(Trash2, mutedIconMapping);
const ThemedExternalLink = withUnistyles(ExternalLink, mutedIconMapping);
const ThemedColumns2 = withUnistyles(Columns2, mutedIconMapping);
const ThemedRotateCcw = withUnistyles(RotateCcw, mutedIconMapping);
const ThemedUserPlus = withUnistyles(UserPlus, mutedIconMapping);
const ThemedUserMinus = withUnistyles(UserMinus, mutedIconMapping);
const ThemedUnlink = withUnistyles(Unlink, mutedIconMapping);
const ThemedArchive = withUnistyles(Archive, mutedIconMapping);

const EXTERNAL_LINK_ICON = <ThemedExternalLink size={14} />;
const COLUMNS2_ICON = <ThemedColumns2 size={14} />;
const ROTATE_CCW_ICON = <ThemedRotateCcw size={14} />;
const USER_PLUS_ICON = <ThemedUserPlus size={14} />;
const USER_MINUS_ICON = <ThemedUserMinus size={14} />;
const UNLINK_ICON = <ThemedUnlink size={14} />;
const ARCHIVE_ICON = <ThemedArchive size={14} />;

const EMPTY_PROFILES: AgentProfile[] = [];

type CleanupStatus =
  | { kind: "idle" }
  | { kind: "running"; completed: number; total: number }
  | { kind: "failed"; failed: number; total: number };

export interface WorkspaceTeamDirectoryProps {
  serverId: string;
  workspaceId: string;
  mainAgentId: string | null;
  isTopicWorkspace: boolean;
  focusedAgentId: string | null;
  focusedProviderSubagentId: string | null;
  overlay?: boolean;
  inSheet?: boolean;
  onHide: () => void;
  onOpenAgent: (node: TeamDirectoryMemberNode) => void;
  onOpenAgentBeside: (address: AgentAddress) => void;
  onOpenProviderSubrun: (parentAgentId: string, subagentId: string) => void;
  onAskFirstQuestion?: () => void;
}

interface MemberRowActionHandlers {
  serverId: string;
  isTopicWorkspace: boolean;
  focusedAgentId: string | null;
  features: ServerInfoStatusPayload["features"];
  permissions: ServerInfoStatusPayload["permissions"];
  onOpen: (node: TeamDirectoryMemberNode) => void;
  onOpenBeside: (address: AgentAddress) => void;
  onArchive: (address: AgentAddress) => void;
  onDetach: (address: AgentAddress) => void;
  onResidentAction: ReturnType<typeof useOpenResidentDialog>;
}

function allowsTopicMainResetPermissions(
  permissions: ServerInfoStatusPayload["permissions"],
): boolean {
  if (!permissions) return true;
  return permissions.includes("workspace.write") && permissions.includes("hub.execute");
}

function resolveDotToneStyle(bucket: SidebarStateBucket) {
  switch (bucket) {
    case "needs_input":
      return styles.dotNeedsInput;
    case "failed":
      return styles.dotFailed;
    case "running":
      return styles.dotRunning;
    case "attention":
      return styles.dotAttention;
    default:
      return styles.dotDone;
  }
}

function resolveCleanupLabel(
  cleanupStatus: CleanupStatus,
  cleanableCount: number,
  t: TFunction,
): string {
  if (cleanupStatus.kind === "running") {
    return t("topicWorkbench.directory.cleanupProgress", {
      completed: cleanupStatus.completed,
      total: cleanupStatus.total,
    });
  }
  if (cleanupStatus.kind === "failed") {
    return t("topicWorkbench.directory.cleanupRetry", {
      failed: cleanupStatus.failed,
      total: cleanupStatus.total,
    });
  }
  return t("topicWorkbench.directory.cleanupFinished", { count: cleanableCount });
}

function resolveMemberStatusText(node: TeamDirectoryMemberNode, t: TFunction): string {
  switch (node.bucket) {
    case "needs_input":
      return t("topicWorkbench.directory.statusNeedsInput");
    case "failed":
      return t("topicWorkbench.directory.statusFailed");
    case "running":
      return t("topicWorkbench.directory.statusRunning");
    case "attention":
      return t("topicWorkbench.directory.statusUnread");
    default:
      break;
  }
  if (node.isSilentSeat) return t("topicWorkbench.directory.silentRegistered");
  if (node.isArchived) return t("topicWorkbench.directory.statusClosed");
  return t("topicWorkbench.directory.statusIdle");
}

function resolveMemberTrailingTag(node: TeamDirectoryMemberNode, t: TFunction): string | null {
  if (node.isMain) return t("topicWorkbench.directory.mainBadge");
  if (node.isSilentSeat) return t("topicWorkbench.directory.silentRegistered");
  return null;
}

function StatusDot({ bucket, hollow = false }: { bucket: SidebarStateBucket; hollow?: boolean }) {
  if (hollow) {
    return <View style={[styles.dot, styles.dotHollow]} />;
  }
  return <View style={[styles.dot, resolveDotToneStyle(bucket)]} />;
}

function useCompactFinishedCleanup(
  scopeKey: string,
  workspaceId: string,
  cleanableTaskMembers: readonly AgentAddress[],
  supportsIdleArchive: boolean,
) {
  const queryClient = useQueryClient();
  const [cleanupStatus, setCleanupStatus] = useState<CleanupStatus>({ kind: "idle" });
  const cleanupRunRef = useRef<symbol | null>(null);
  const cleanupScopeRef = useRef(scopeKey);
  if (cleanupScopeRef.current !== scopeKey) {
    cleanupScopeRef.current = scopeKey;
    cleanupRunRef.current = null;
    if (cleanupStatus.kind !== "idle") {
      setCleanupStatus({ kind: "idle" });
    }
  }

  const runCleanup = useCallback(async () => {
    if (
      !supportsIdleArchive ||
      cleanupScopeRef.current !== scopeKey ||
      cleanupRunRef.current !== null ||
      cleanableTaskMembers.length === 0
    )
      return;
    const targets = [...cleanableTaskMembers];
    const run = Symbol();
    cleanupRunRef.current = run;
    let completed = 0;
    let failed = 0;
    setCleanupStatus({ kind: "running", completed: 0, total: targets.length });
    for (const address of targets) {
      const session = useSessionStore.getState().sessions[address.serverId];
      const latest = session?.agents.get(address.agentId);
      const targetSupportsIdleArchive =
        session?.serverInfo?.features?.agentIdleArchiveV1 === true && Boolean(session.client);
      if (
        latest?.workspaceId === workspaceId &&
        isDirectlyCleanableTaskMember(latest, address.serverId)
      ) {
        if (!targetSupportsIdleArchive || !session?.client) {
          failed += 1;
        } else {
          setAgentArchiving({
            queryClient,
            serverId: address.serverId,
            agentId: address.agentId,
            isArchiving: true,
          });
          try {
            const result = await session.client.archiveAgent(address.agentId, workspaceId, {
              onlyIfIdle: true,
            });
            applyArchivedAgentCloseResults({
              queryClient,
              serverId: address.serverId,
              results: [{ agentId: address.agentId, archivedAt: result.archivedAt }],
            });
          } catch {
            failed += 1;
          } finally {
            clearArchiveAgentPending({
              queryClient,
              serverId: address.serverId,
              agentId: address.agentId,
            });
          }
        }
      }
      if (cleanupRunRef.current !== run) return;
      completed += 1;
      setCleanupStatus({ kind: "running", completed, total: targets.length });
    }
    cleanupRunRef.current = null;
    setCleanupStatus(
      failed > 0 ? { kind: "failed", failed, total: targets.length } : { kind: "idle" },
    );
  }, [cleanableTaskMembers, queryClient, scopeKey, supportsIdleArchive, workspaceId]);

  const handleCleanupPress = useCallback(() => {
    void runCleanup();
  }, [runCleanup]);

  return { cleanupStatus, handleCleanupPress };
}

export const WorkspaceTeamDirectory = memo(function WorkspaceTeamDirectory({
  serverId,
  workspaceId,
  mainAgentId,
  isTopicWorkspace,
  focusedAgentId,
  focusedProviderSubagentId,
  overlay = false,
  inSheet = false,
  onHide,
  onOpenAgent,
  onOpenAgentBeside,
  onOpenProviderSubrun,
  onAskFirstQuestion,
}: WorkspaceTeamDirectoryProps) {
  const { t } = useTranslation();
  const active = useRetainedPanelActive();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supportsResidents = useHostFeature(serverId, "agentResidentSpecialists");
  const supportsProfiles = useHostFeature(serverId, "agentProfiles");
  const supportsProviderSubagents = useHostFeature(serverId, "providerSubagents");
  // COMPAT(agentIdleArchiveV1): added in v0.18.0, remove gate after 2027-06-01.
  const supportsIdleArchive = useHostFeature(serverId, "agentIdleArchiveV1");
  const features = useSessionStore((state) => state.sessions[serverId]?.serverInfo?.features);
  const permissions = useSessionStore(
    (state) => state.sessions[serverId]?.client?.getLastServerInfoMessage?.()?.permissions,
  );
  const openResidentDialog = useOpenResidentDialog();
  const createResidentAction = useCreateResidentAction(serverId, mainAgentId);
  const archiveSubagent = useArchiveSubagent();
  const detachSubagent = useDetachSubagent();

  // History expands strictly on user click and resets when switching workspaces.
  const scopeKey = `${serverId}\0${workspaceId}`;
  const [historyScope, setHistoryScope] = useState<{ scopeKey: string; expanded: boolean }>({
    scopeKey,
    expanded: false,
  });
  const historyExpanded = historyScope.scopeKey === scopeKey && historyScope.expanded;
  const toggleHistory = useCallback(() => {
    setHistoryScope((current) => ({
      scopeKey,
      expanded: current.scopeKey === scopeKey ? !current.expanded : true,
    }));
  }, [scopeKey]);

  const agentMaps = useSessionStore(
    useShallow(
      (state): Record<string, ReadonlyMap<string, TeamDirectoryAgent>> =>
        Object.fromEntries(
          Object.entries(state.sessions).map(([id, session]) => [id, session.agents]),
        ),
    ),
  );
  const localAgents = agentMaps[serverId];

  const workspaceAgentMembership = useMemo(() => {
    const entries: Array<[string, boolean]> = [];
    for (const agent of localAgents?.values() ?? []) {
      if (agent.workspaceId === workspaceId && !agent.background) {
        entries.push([agent.id, agent.archivedAt != null]);
      }
    }
    return JSON.stringify(entries.sort());
  }, [localAgents, workspaceId]);

  const liveHistory = useWorkspaceArchivedAgents({
    serverId,
    workspaceId,
    enabled: active && historyExpanded,
    workspaceAgentMembership,
  });
  // The disabled query has no page observers. Keep the last rows in the hidden scroll view.
  const retainedHistory = useRef({ scopeKey, history: liveHistory });
  useLayoutEffect(() => {
    if (active) retainedHistory.current = { scopeKey, history: liveHistory };
  }, [active, liveHistory, scopeKey]);
  const history =
    !active && retainedHistory.current.scopeKey === scopeKey
      ? retainedHistory.current.history
      : liveHistory;

  // Load resident presets only when resident specialists + profiles are supported.
  const daemonConfigQuery = useReplicaQuery({
    queryKey: daemonConfigQueryKey(serverId),
    enabled: Boolean(
      active && client && isConnected && supportsResidents && supportsProfiles && mainAgentId,
    ),
    pushEvent: "status:daemon_config_changed",
    queryFn: async () => {
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      return (await client.getDaemonConfig()).config;
    },
  });
  const residentProfiles = daemonConfigQuery.data?.agentProfiles ?? EMPTY_PROFILES;

  useEffect(() => {
    if (!active || !client || !isConnected || !supportsProviderSubagents || !mainAgentId) return;
    void refreshProviderSubagents(client, serverId, mainAgentId).catch(() => undefined);
  }, [active, client, isConnected, mainAgentId, serverId, supportsProviderSubagents]);

  const providerSubagents = useProviderSubagentStore(
    useShallow((state) => {
      if (!supportsProviderSubagents) return [];
      const prefix = `${serverId}\0`;
      const result = [];
      for (const [key, descriptor] of state.descriptors) {
        if (!key.startsWith(prefix) || state.hiddenFromTrack.has(key)) continue;
        result.push(descriptor);
      }
      return result;
    }),
  );

  const pendingArchiveIds = usePendingArchiveAgentKeys();
  const fallbackTitle = t("workspace.tabs.fallback.agent");

  const directory = useMemo(
    () =>
      selectTeamDirectoryData({
        serverId,
        workspaceId,
        mainAgentId,
        agentMaps,
        archivedAgents: history.data,
        residentProfiles,
        providerSubagents,
        pendingArchiveIds,
        fallbackTitle,
      }),
    [
      agentMaps,
      fallbackTitle,
      history.data,
      mainAgentId,
      pendingArchiveIds,
      providerSubagents,
      residentProfiles,
      serverId,
      workspaceId,
    ],
  );

  const { cleanupStatus, handleCleanupPress } = useCompactFinishedCleanup(
    scopeKey,
    workspaceId,
    directory.cleanableTaskMembers,
    supportsIdleArchive,
  );

  const handleActivatePreset = useCallback(
    (profileId: string) => {
      if (!mainAgentId || !openResidentDialog) return;
      openResidentDialog({
        serverId,
        agentId: mainAgentId,
        action: "create",
        initialProfileId: profileId,
      });
    },
    [mainAgentId, openResidentDialog, serverId],
  );

  const rowActions = useMemo<MemberRowActionHandlers>(
    () => ({
      serverId,
      isTopicWorkspace,
      focusedAgentId,
      features,
      permissions,
      onOpen: onOpenAgent,
      onOpenBeside: onOpenAgentBeside,
      onArchive: archiveSubagent,
      onDetach: detachSubagent,
      onResidentAction: openResidentDialog,
    }),
    [
      archiveSubagent,
      detachSubagent,
      features,
      focusedAgentId,
      isTopicWorkspace,
      onOpenAgent,
      onOpenAgentBeside,
      openResidentDialog,
      permissions,
      serverId,
    ],
  );

  return (
    <View
      style={inSheet ? styles.sheet : [styles.sidebar, overlay && styles.overlay]}
      testID="workspace-team-directory"
    >
      {inSheet ? null : (
        <View style={styles.header}>
          <Text numberOfLines={1} style={styles.headerTitle}>
            {t("topicWorkbench.directory.title")}
          </Text>
          <ToolbarButton
            compact
            testID="team-directory-hide"
            label={t("topicWorkbench.directory.hide")}
            onPress={onHide}
          >
            <ThemedPanelLeftClose size={16} />
          </ToolbarButton>
        </View>
      )}

      <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
        <View style={styles.list}>
          <DirectoryMainSection
            mainSeat={directory.mainSeat}
            standaloneRoots={directory.standaloneRoots}
            isTopicWorkspace={isTopicWorkspace}
            onAskFirstQuestion={onAskFirstQuestion}
            rowActions={rowActions}
          />

          <DirectoryResidentsSection
            residentGroups={directory.residentGroups}
            flattenResidentGroups={directory.flattenResidentGroups}
            presetResidents={directory.presetResidents}
            onCreateResident={createResidentAction}
            onActivatePreset={handleActivatePreset}
            rowActions={rowActions}
          />

          <DirectoryTasksSection
            taskTree={directory.taskTree}
            cleanableCount={directory.cleanableTaskMembers.length}
            supportsIdleArchive={supportsIdleArchive}
            cleanupStatus={cleanupStatus}
            onCleanupPress={handleCleanupPress}
            rowActions={rowActions}
          />

          {directory.sideChats.length > 0 ? (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text accessibilityRole="header" numberOfLines={1} style={styles.sectionTitle}>
                  {t("topicWorkbench.directory.sideChatsSection")}
                </Text>
              </View>
              {directory.sideChats.map((node) => (
                <TeamMemberRow
                  key={teamDirectoryNodeKey(node)}
                  node={node}
                  rowActions={rowActions}
                />
              ))}
            </View>
          ) : null}

          {directory.nativeSubruns.length > 0 ? (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text accessibilityRole="header" numberOfLines={1} style={styles.sectionTitle}>
                  {t("topicWorkbench.directory.nativeSubrunsSection")}
                </Text>
              </View>
              {directory.nativeSubruns.map((subrun) => (
                <NativeSubrunRow
                  key={`${subrun.parentAgentId}:${subrun.id}`}
                  subrun={subrun}
                  isFocused={focusedProviderSubagentId === subrun.id}
                  onOpen={onOpenProviderSubrun}
                />
              ))}
            </View>
          ) : null}

          <DirectoryHistorySection
            expanded={historyExpanded}
            onToggle={toggleHistory}
            members={directory.historyMembers}
            hasLoadedOnce={history.hasLoadedOnce}
            hasMore={history.hasMore}
            isLoading={history.isLoading}
            isLoadingMore={history.isLoadingMore}
            isError={history.isError}
            supportsWorkspaceHistory={history.supportsWorkspaceHistory}
            onLoadMore={history.loadMore}
            onRetry={history.refetch}
            rowActions={rowActions}
          />
        </View>
      </ScrollView>
    </View>
  );
});

const DirectoryMainSection = memo(function DirectoryMainSection({
  mainSeat,
  standaloneRoots,
  isTopicWorkspace,
  onAskFirstQuestion,
  rowActions,
}: {
  mainSeat: TeamDirectoryMemberNode | null;
  standaloneRoots: readonly TeamDirectoryMemberNode[];
  isTopicWorkspace: boolean;
  onAskFirstQuestion?: () => void;
  rowActions: MemberRowActionHandlers;
}) {
  const { t } = useTranslation();
  return (
    <>
      {mainSeat ? <TeamMemberRow node={mainSeat} rowActions={rowActions} /> : null}
      {!mainSeat && isTopicWorkspace ? (
        <View style={styles.unboundBlock} testID="team-directory-unbound-main">
          <Text style={styles.mutedText} numberOfLines={1}>
            {t("topicWorkbench.directory.unboundMain")}
          </Text>
          {onAskFirstQuestion ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={onAskFirstQuestion}
              testID="team-directory-bind-main"
            >
              {t("topicWorkbench.directory.bindMainAction")}
            </Button>
          ) : null}
        </View>
      ) : null}
      {standaloneRoots.map((node) => (
        <TeamMemberRow key={teamDirectoryNodeKey(node)} node={node} rowActions={rowActions} />
      ))}
    </>
  );
});

const DirectoryResidentsSection = memo(function DirectoryResidentsSection({
  residentGroups,
  flattenResidentGroups,
  presetResidents,
  onCreateResident,
  onActivatePreset,
  rowActions,
}: {
  residentGroups: readonly TeamDirectoryResidentGroup[];
  flattenResidentGroups: boolean;
  presetResidents: readonly TeamDirectoryPresetResident[];
  onCreateResident?: () => void;
  onActivatePreset: (profileId: string) => void;
  rowActions: MemberRowActionHandlers;
}) {
  const { t } = useTranslation();
  if (residentGroups.length === 0 && presetResidents.length === 0 && !onCreateResident) {
    return null;
  }
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text accessibilityRole="header" numberOfLines={1} style={styles.sectionTitle}>
          {t("topicWorkbench.directory.residentsSection")}
        </Text>
        {onCreateResident ? (
          <ToolbarButton
            compact
            testID="team-directory-create-resident"
            label={t("subagents.resident.createAction")}
            onPress={onCreateResident}
          >
            <ThemedPlus size={14} />
          </ToolbarButton>
        ) : null}
      </View>

      {residentGroups.map((group) => (
        <View key={group.parent ? teamDirectoryNodeKey(group.parent) : "standalone"}>
          {!flattenResidentGroups ? (
            <View style={styles.subGroupHeader}>
              <Text numberOfLines={1} style={styles.subGroupTitle}>
                {group.parentTitle ?? t("topicWorkbench.directory.standalone")}
              </Text>
            </View>
          ) : null}
          {group.nodes.map((node) => (
            <TeamMemberRow key={teamDirectoryNodeKey(node)} node={node} rowActions={rowActions} />
          ))}
        </View>
      ))}

      {presetResidents.map((preset) => (
        <PresetResidentRow key={preset.profileId} preset={preset} onActivate={onActivatePreset} />
      ))}
    </View>
  );
});

const TaskBranchItem = memo(function TaskBranchItem({
  branch,
  rowActions,
}: {
  branch: TeamDirectoryTaskBranch;
  rowActions: MemberRowActionHandlers;
}) {
  return (
    <View>
      <TeamMemberRow node={branch.node} rowActions={rowActions} />
      {branch.children.length > 0 ? (
        <View style={styles.nestedTreeRail}>
          {branch.children.map((child) => (
            <TeamMemberRow key={teamDirectoryNodeKey(child)} node={child} rowActions={rowActions} />
          ))}
        </View>
      ) : null}
    </View>
  );
});

const DirectoryTasksSection = memo(function DirectoryTasksSection({
  taskTree,
  cleanableCount,
  supportsIdleArchive,
  cleanupStatus,
  onCleanupPress,
  rowActions,
}: {
  taskTree: readonly TeamDirectoryTaskBranch[];
  cleanableCount: number;
  supportsIdleArchive: boolean;
  cleanupStatus: CleanupStatus;
  onCleanupPress: () => void;
  rowActions: MemberRowActionHandlers;
}) {
  const { t } = useTranslation();
  const cleanupTooltip = useMemo(
    () => <Text style={styles.tooltipText}>{t("topicWorkbench.directory.cleanupTooltip")}</Text>,
    [t],
  );
  if (taskTree.length === 0 && cleanupStatus.kind === "idle") {
    return null;
  }
  const showCleanupAction =
    supportsIdleArchive && (cleanableCount > 0 || cleanupStatus.kind !== "idle");
  const cleanupLabel = resolveCleanupLabel(cleanupStatus, cleanableCount, t);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text accessibilityRole="header" numberOfLines={1} style={styles.sectionTitle}>
          {t("topicWorkbench.directory.tasksSection")}
        </Text>
        {showCleanupAction ? (
          <ToolbarButton
            compact
            disabled={cleanupStatus.kind === "running"}
            label={cleanupLabel}
            tooltip={cleanupTooltip}
            onPress={onCleanupPress}
            testID="team-directory-cleanup-finished"
          >
            <ThemedTrash2 size={14} />
          </ToolbarButton>
        ) : null}
      </View>

      <View style={styles.taskTreeRail}>
        {taskTree.map((branch) => (
          <TaskBranchItem
            key={teamDirectoryNodeKey(branch.node)}
            branch={branch}
            rowActions={rowActions}
          />
        ))}
      </View>
    </View>
  );
});

const DirectoryHistorySection = memo(function DirectoryHistorySection({
  expanded,
  onToggle,
  members,
  hasLoadedOnce,
  hasMore,
  isLoading,
  isLoadingMore,
  isError,
  supportsWorkspaceHistory,
  onLoadMore,
  onRetry,
  rowActions,
}: {
  expanded: boolean;
  onToggle: () => void;
  members: readonly TeamDirectoryMemberNode[];
  hasLoadedOnce: boolean;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  isError: boolean;
  supportsWorkspaceHistory: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  rowActions: MemberRowActionHandlers;
}) {
  const { t } = useTranslation();
  const expandedState = useMemo(() => ({ expanded }), [expanded]);
  const showEmpty = hasLoadedOnce && members.length === 0 && !isLoading && !isError;

  return (
    <View style={styles.section}>
      <PressHighlight
        style={styles.historyToggleRow}
        highlightStyle={styles.rowHighlight}
        accessibilityRole="button"
        accessibilityState={expandedState}
        testID="team-directory-toggle-history"
        onPress={onToggle}
      >
        {expanded ? <ThemedChevronDown size={14} /> : <ThemedChevronRight size={14} />}
        <Text numberOfLines={1} style={styles.sectionTitle}>
          {expanded && hasLoadedOnce
            ? t("topicWorkbench.directory.historySection", { count: members.length })
            : t("topicWorkbench.directory.viewHistory")}
        </Text>
      </PressHighlight>

      {expanded ? (
        <View style={styles.historyBody}>
          {members.map((node) => (
            <TeamMemberRow key={teamDirectoryNodeKey(node)} node={node} rowActions={rowActions} />
          ))}
          {!supportsWorkspaceHistory ? (
            <Text style={styles.historyMeta}>
              {t("topicWorkbench.directory.historyUpgradeHost")}
            </Text>
          ) : null}
          {isLoading ? (
            <Text style={styles.historyMeta}>{t("topicWorkbench.directory.loadingHistory")}</Text>
          ) : null}
          {isError ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={onRetry}
              testID="team-directory-retry-history"
            >
              {t("topicWorkbench.directory.retryHistory")}
            </Button>
          ) : null}
          {showEmpty ? (
            <Text style={styles.historyMeta}>{t("topicWorkbench.directory.historyEmpty")}</Text>
          ) : null}
          {hasMore ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={isLoadingMore}
              onPress={onLoadMore}
              testID="team-directory-load-more-history"
            >
              {isLoadingMore
                ? t("topicWorkbench.directory.loadingHistory")
                : t("topicWorkbench.directory.loadMoreHistory")}
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

const TeamMemberRowMenu = memo(function TeamMemberRowMenu({
  node,
  showKebab,
  menuProps,
  residentActions,
  canResetTopicMain,
  canDetach,
  canArchive,
  onOpen,
  onOpenBeside,
  onDetach,
  onArchive,
  onResidentAction,
}: {
  node: TeamDirectoryMemberNode;
  showKebab: boolean;
  menuProps: ReturnType<typeof useOpenKebabMenuVisibility>["menuProps"];
  residentActions: readonly ResidentAction[];
  canResetTopicMain: boolean;
  canDetach: boolean;
  canArchive: boolean;
  onOpen: () => void;
  onOpenBeside: () => void;
  onDetach: () => void;
  onArchive: () => void;
  onResidentAction: ReturnType<typeof useOpenResidentDialog>;
}) {
  const { t } = useTranslation();
  const hasResidentReset = residentActions.includes("reset");
  const showReset = (hasResidentReset || canResetTopicMain) && Boolean(onResidentAction);
  const handleReset = useCallback(() => {
    onResidentAction?.({
      serverId: node.serverId,
      agentId: node.agentId,
      action: "reset",
      ...(canResetTopicMain && !hasResidentReset ? { allowTopicMainReset: true } : {}),
    });
  }, [canResetTopicMain, hasResidentReset, node.agentId, node.serverId, onResidentAction]);
  const handleBind = useCallback(() => {
    onResidentAction?.({ serverId: node.serverId, agentId: node.agentId, action: "bind" });
  }, [node.agentId, node.serverId, onResidentAction]);
  const handleUnbind = useCallback(() => {
    onResidentAction?.({ serverId: node.serverId, agentId: node.agentId, action: "unbind" });
  }, [node.agentId, node.serverId, onResidentAction]);

  return (
    <View style={styles.kebabSlot} pointerEvents={showKebab ? "auto" : "none"}>
      <View style={showKebab ? styles.kebabVisible : styles.kebabHidden}>
        <DropdownMenu {...menuProps}>
          <ToolbarButton
            kind="menu"
            compact
            label={t("topicWorkbench.directory.moreActions")}
            testID={`team-directory-menu-${node.agentId}`}
          >
            <ThemedMoreVertical size={14} />
          </ToolbarButton>
          <DropdownMenuContent align="end">
            <DropdownMenuItem leading={EXTERNAL_LINK_ICON} onSelect={onOpen}>
              {t("topicWorkbench.directory.openTab")}
            </DropdownMenuItem>
            {!node.isArchived ? (
              <DropdownMenuItem leading={COLUMNS2_ICON} onSelect={onOpenBeside}>
                {t("topicWorkbench.directory.openBeside")}
              </DropdownMenuItem>
            ) : null}
            {showReset ? (
              <DropdownMenuItem leading={ROTATE_CCW_ICON} onSelect={handleReset}>
                {t("subagents.resident.resetAction")}
              </DropdownMenuItem>
            ) : null}
            {residentActions.includes("bind") && onResidentAction ? (
              <DropdownMenuItem leading={USER_PLUS_ICON} onSelect={handleBind}>
                {t("subagents.resident.bindAction")}
              </DropdownMenuItem>
            ) : null}
            {residentActions.includes("unbind") && onResidentAction ? (
              <DropdownMenuItem leading={USER_MINUS_ICON} onSelect={handleUnbind}>
                {t("subagents.resident.unbindAction")}
              </DropdownMenuItem>
            ) : null}
            {canDetach ? (
              <DropdownMenuItem leading={UNLINK_ICON} onSelect={onDetach}>
                {t("subagents.detachTooltip")}
              </DropdownMenuItem>
            ) : null}
            {canArchive ? (
              <DropdownMenuItem leading={ARCHIVE_ICON} onSelect={onArchive}>
                {t("subagents.archiveTooltip")}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    </View>
  );
});

const TeamMemberRow = memo(function TeamMemberRow({
  node,
  rowActions,
}: {
  node: TeamDirectoryMemberNode;
  rowActions: MemberRowActionHandlers;
}) {
  const {
    serverId,
    isTopicWorkspace,
    focusedAgentId,
    features,
    permissions,
    onOpen,
    onOpenBeside,
    onArchive,
    onDetach,
    onResidentAction,
  } = rowActions;
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const isFocused = node.serverId === serverId && node.agentId === focusedAgentId;
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const { showKebab, menuProps } = useOpenKebabMenuVisibility(isHovered || isNative || isCompact);

  const label = node.residentRole ?? node.title;
  const handlePress = useCallback(() => onOpen(node), [node, onOpen]);
  const handleOpenBeside = useCallback(
    () => onOpenBeside({ serverId: node.serverId, agentId: node.agentId }),
    [node.agentId, node.serverId, onOpenBeside],
  );
  const handleArchive = useCallback(
    () => onArchive({ serverId: node.serverId, agentId: node.agentId }),
    [node.agentId, node.serverId, onArchive],
  );
  const handleDetach = useCallback(
    () => onDetach({ serverId: node.serverId, agentId: node.agentId }),
    [node.agentId, node.serverId, onDetach],
  );
  const selectedAccessibilityState = useMemo(() => ({ selected: isFocused }), [isFocused]);

  const residentActions = useMemo(() => {
    if (node.isArchived || !onResidentAction) return [];
    const agents = useSessionStore.getState().sessions[node.serverId]?.agents;
    return residentActionsForAgent({
      serverId: node.serverId,
      agentId: node.agentId,
      agents,
      permissions,
    }).filter((action) => action !== "create" && supportsResidentAction(features, action));
  }, [features, node.agentId, node.isArchived, node.serverId, onResidentAction, permissions]);

  const canResetTopicMain = Boolean(
    isTopicWorkspace &&
    node.isMain &&
    !node.isArchived &&
    onResidentAction &&
    supportsResidentAction(features, "reset") &&
    allowsTopicMainResetPermissions(permissions),
  );
  const canDetach = !node.isArchived && !node.isMain && !node.isStandalone && !node.isSideChat;
  const canArchive = !node.isArchived && !node.isMain && !node.isResident;
  const statusText = resolveMemberStatusText(node, t);
  const trailingTag = resolveMemberTrailingTag(node, t);

  return (
    <View
      style={[styles.rowContainer, isFocused && styles.rowFocused]}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <PressHighlight
        testID={`team-directory-row-${node.agentId}`}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${statusText}`}
        accessibilityState={selectedAccessibilityState}
        style={styles.row}
        highlightStyle={styles.rowHighlight}
        onPress={handlePress}
      >
        <StatusDot bucket={node.bucket} />
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={[styles.rowTitle, node.isArchived && styles.rowTitleMuted]}
        >
          {label}
        </Text>
        {trailingTag && !showKebab ? (
          <Text numberOfLines={1} style={styles.rowTrailingTag}>
            {trailingTag}
          </Text>
        ) : null}
      </PressHighlight>
      <TeamMemberRowMenu
        node={node}
        showKebab={showKebab}
        menuProps={menuProps}
        residentActions={residentActions}
        canResetTopicMain={canResetTopicMain}
        canDetach={canDetach}
        canArchive={canArchive}
        onOpen={handlePress}
        onOpenBeside={handleOpenBeside}
        onDetach={handleDetach}
        onArchive={handleArchive}
        onResidentAction={onResidentAction}
      />
    </View>
  );
});

const PresetResidentRow = memo(function PresetResidentRow({
  preset,
  onActivate,
}: {
  preset: TeamDirectoryPresetResident;
  onActivate: (profileId: string) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(
    () => onActivate(preset.profileId),
    [onActivate, preset.profileId],
  );
  return (
    <View style={styles.rowContainer}>
      <PressHighlight
        testID={`team-directory-preset-${preset.profileId}`}
        accessibilityRole="button"
        accessibilityLabel={`${preset.name}, ${t("topicWorkbench.directory.presetAvailable")}`}
        style={styles.row}
        highlightStyle={styles.rowHighlight}
        onPress={handlePress}
      >
        <StatusDot bucket="done" hollow />
        <Text numberOfLines={1} ellipsizeMode="tail" style={styles.rowTitleMuted}>
          {preset.name}
        </Text>
        <Text numberOfLines={1} style={styles.rowTrailingTag}>
          {t("topicWorkbench.directory.presetAvailable")}
        </Text>
      </PressHighlight>
    </View>
  );
});

const NativeSubrunRow = memo(function NativeSubrunRow({
  subrun,
  isFocused,
  onOpen,
}: {
  subrun: TeamDirectoryNativeSubrunNode;
  isFocused: boolean;
  onOpen: (parentAgentId: string, subagentId: string) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(
    () => onOpen(subrun.parentAgentId, subrun.id),
    [onOpen, subrun.id, subrun.parentAgentId],
  );
  const selectedAccessibilityState = useMemo(() => ({ selected: isFocused }), [isFocused]);

  return (
    <View style={styles.rowContainer}>
      <PressHighlight
        testID={`team-directory-subrun-${subrun.id}`}
        accessibilityRole="button"
        accessibilityLabel={`${subrun.title}, ${t("topicWorkbench.directory.readOnlyBadge")}`}
        accessibilityState={selectedAccessibilityState}
        style={[styles.row, isFocused && styles.rowFocused]}
        highlightStyle={styles.rowHighlight}
        onPress={handlePress}
      >
        <StatusDot bucket={subrun.bucket} />
        <Text numberOfLines={1} ellipsizeMode="tail" style={styles.rowTitleMuted}>
          {subrun.title}
        </Text>
        <Text numberOfLines={1} style={styles.rowTrailingTag}>
          {t("topicWorkbench.directory.readOnlyBadge")}
        </Text>
      </PressHighlight>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  sheet: {
    flex: 1,
    minHeight: 0,
  },
  sidebar: {
    width: 248,
    maxWidth: "100%",
    flexShrink: 0,
    backgroundColor: theme.colors.surfaceSidebar,
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
  },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    zIndex: 4,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 36,
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  scroll: {
    flex: 1,
  },
  list: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[2],
  },
  section: {
    gap: theme.spacing[0.5],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 28,
    paddingHorizontal: theme.spacing[1.5],
    gap: theme.spacing[1],
  },
  sectionTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  subGroupHeader: {
    paddingHorizontal: theme.spacing[1.5],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[0.5],
  },
  subGroupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  taskTreeRail: {
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    marginLeft: theme.spacing[2],
    paddingLeft: theme.spacing[1],
    gap: theme.spacing[0.5],
  },
  nestedTreeRail: {
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    marginLeft: theme.spacing[2],
    paddingLeft: theme.spacing[1],
    gap: theme.spacing[0.5],
  },
  rowContainer: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius.md,
  },
  row: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    minHeight: 32,
    paddingHorizontal: theme.spacing[1.5],
    gap: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  rowFocused: {
    backgroundColor: theme.colors.surface2,
  },
  rowHighlight: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  rowTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  rowTitleMuted: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  rowTrailingTag: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  kebabSlot: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  kebabVisible: {
    opacity: 1,
  },
  kebabHidden: {
    opacity: 0,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
  },
  dotHollow: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  dotNeedsInput: {
    backgroundColor:
      getStatusDotColor({ theme, bucket: "needs_input", showDoneAsInactive: true }) ??
      theme.colors.border,
  },
  dotFailed: {
    backgroundColor:
      getStatusDotColor({ theme, bucket: "failed", showDoneAsInactive: true }) ??
      theme.colors.border,
  },
  dotRunning: {
    backgroundColor:
      getStatusDotColor({ theme, bucket: "running", showDoneAsInactive: true }) ??
      theme.colors.border,
  },
  dotAttention: {
    backgroundColor:
      getStatusDotColor({ theme, bucket: "attention", showDoneAsInactive: true }) ??
      theme.colors.border,
  },
  dotDone: {
    backgroundColor:
      getStatusDotColor({ theme, bucket: "done", showDoneAsInactive: true }) ?? theme.colors.border,
  },
  unboundBlock: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[1],
    gap: theme.spacing[1],
    alignItems: "flex-start",
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  historyToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 32,
    paddingHorizontal: theme.spacing[1.5],
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  historyBody: {
    gap: theme.spacing[0.5],
  },
  historyMeta: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
