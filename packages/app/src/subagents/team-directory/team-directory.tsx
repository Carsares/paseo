import type { AgentAddress } from "@getpaseo/protocol/addresses";
import type {
  AgentProfile,
  ServerInfoStatusPayload,
  WorkspaceDurableItem,
} from "@getpaseo/protocol/messages";
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
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { HoverEnvelope } from "@/agent-stream/topic-card/hover-envelope";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useOpenKebabMenuVisibility } from "@/components/sidebar/use-open-kebab-menu-visibility";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { useReplicaQuery } from "@/data/query";
import { useWorkspaceDurableItems } from "@/durable-items/queries";
import {
  applyArchivedAgentCloseResults,
  clearArchiveAgentPending,
  setAgentArchiving,
  usePendingArchiveAgentKeys,
} from "@/hooks/use-archive-agent";
import { useHostFeature } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import { planTimelineResumeFetch } from "@/timeline/timeline-sync-plan";
import {
  useTeamDirectoryViewStore,
  type TeamDirectoryAgentGroupMode,
  type TeamDirectoryTab,
} from "@/stores/team-directory-view-store";
import {
  buildTopicInboxReadScopeKey,
  useTopicInboxReadStore,
} from "@/stores/topic-inbox-read-store";
import type { Theme } from "@/styles/theme";
import type { StreamItem } from "@/types/stream";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
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
import { selectTeamDirectoryMessages, type TeamTopicReadContext } from "./messages-model";
import { DirectoryMessagesView } from "./messages-view";
import { useWorkspaceTopicReadState } from "@/topic-read/queries";
import { useWorkspaceTopicEntries } from "@/topic-threads/queries";
import { useWorkspaceTasks } from "@/composer/workspace-task-ledger/query";
import { DirectoryTodosView } from "./todos-view";
import { useWorkspaceTodos } from "@/todos/queries";
import {
  isDirectlyCleanableTaskMember,
  selectTeamActivityGroups,
  selectTeamAttributeGroups,
  selectTeamDirectoryData,
  teamDirectoryNodeKey,
  type TeamDirectoryActivityGroups,
  type TeamDirectoryAgent,
  type TeamDirectoryAttributeGroups,
  type TeamDirectoryData,
  type TeamDirectoryMemberNode,
  type TeamDirectoryNativeSubrunNode,
  type TeamDirectoryPresetResident,
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
const EMPTY_STREAM_ITEMS: readonly StreamItem[] = [];
const EMPTY_DURABLE_ITEMS: readonly WorkspaceDurableItem[] = [];

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

function DirectoryTabBody({
  activeTab,
  serverId,
  workspaceId,
  mainAgentId,
  readScopeKey,
  client,
  messagesProjection,
  durableItems,
  onFocusAgentById,
  agentsContent,
}: {
  activeTab: TeamDirectoryTab;
  serverId: string;
  workspaceId: string;
  mainAgentId: string | null;
  readScopeKey: string;
  client: ReturnType<typeof useHostRuntimeClient>;
  messagesProjection: ReturnType<typeof selectTeamDirectoryMessages>;
  durableItems: readonly WorkspaceDurableItem[];
  onFocusAgentById: (agentId: string) => void;
  agentsContent: React.ReactNode;
}) {
  if (activeTab === "messages") {
    return (
      <DirectoryMessagesView
        serverId={serverId}
        workspaceId={workspaceId}
        mainAgentId={mainAgentId}
        readScopeKey={readScopeKey}
        client={client}
        projection={messagesProjection}
        onFocusAgentById={onFocusAgentById}
      />
    );
  }
  if (activeTab === "todos") {
    return (
      <DirectoryTodosView
        serverId={serverId}
        workspaceId={workspaceId}
        mainAgentId={mainAgentId}
        client={client}
        durableItems={durableItems}
        onFocusAgentById={onFocusAgentById}
      />
    );
  }
  return agentsContent;
}

function buildDirectoryTabOptions(input: {
  unreadCount: number;
  totalTodosTabCount: number;
  runningCount: number;
  t: TFunction;
}): SegmentedControlOption<TeamDirectoryTab>[] {
  const { unreadCount, totalTodosTabCount, runningCount, t } = input;
  return [
    {
      value: "messages",
      label:
        unreadCount > 0
          ? t("topicWorkbench.directory.tabMessagesCount", { count: unreadCount })
          : t("topicWorkbench.directory.tabMessages"),
      testID: "team-directory-tab-messages",
    },
    {
      value: "todos",
      label:
        totalTodosTabCount > 0
          ? t("topicWorkbench.directory.tabTodosCount", { count: totalTodosTabCount })
          : t("topicWorkbench.directory.tabTodos"),
      testID: "team-directory-tab-todos",
    },
    {
      value: "agents",
      label:
        runningCount > 0
          ? t("topicWorkbench.directory.tabAgentsCount", { count: runningCount })
          : t("topicWorkbench.directory.tabAgents"),
      testID: "team-directory-tab-agents",
    },
  ];
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

function resolveMemberRoleTag(
  node: TeamDirectoryMemberNode,
  mode: TeamDirectoryAgentGroupMode,
  t: TFunction,
): string | null {
  if (node.isMain) return t("topicWorkbench.directory.mainBadge");
  if (node.isSideChat) return t("topicWorkbench.directory.sideChatBadge");
  if (node.isResident) {
    return node.isSilentSeat
      ? `${t("topicWorkbench.directory.residentBadge")} · ${t("topicWorkbench.directory.silentRegistered")}`
      : t("topicWorkbench.directory.residentBadge");
  }
  if (node.isSilentSeat) return t("topicWorkbench.directory.silentRegistered");
  if (mode === "activity" && !node.isArchived) {
    if (node.depth === 2) return t("topicWorkbench.directory.levelTwoBadge");
    if (node.depth === 1) return t("topicWorkbench.directory.levelOneBadge");
  }
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

function useScopedExpansion(scopeKey: string, initialExpanded = false) {
  const [state, setState] = useState<{ scopeKey: string; expanded: boolean }>({
    scopeKey,
    expanded: initialExpanded,
  });
  const expanded = state.scopeKey === scopeKey ? state.expanded : initialExpanded;
  const toggle = useCallback(() => {
    setState((current) => ({
      scopeKey,
      expanded: current.scopeKey === scopeKey ? !current.expanded : !initialExpanded,
    }));
  }, [initialExpanded, scopeKey]);
  return [expanded, toggle] as const;
}

function useMainAgentTimelineStreams(serverId: string, mainAgentId: string | null) {
  const mainStreamTail = useSessionStore((state) =>
    mainAgentId
      ? (state.sessions[serverId]?.agentStreamTail.get(mainAgentId) ?? EMPTY_STREAM_ITEMS)
      : EMPTY_STREAM_ITEMS,
  );
  const mainStreamHead = useSessionStore((state) =>
    mainAgentId
      ? (state.sessions[serverId]?.agentStreamHead.get(mainAgentId) ?? EMPTY_STREAM_ITEMS)
      : EMPTY_STREAM_ITEMS,
  );
  const mainTimelineHasNewer = useSessionStore((state) =>
    mainAgentId ? state.sessions[serverId]?.agentTimelineHasNewer.get(mainAgentId) === true : false,
  );
  const currentMainEpoch = useSessionStore((state) =>
    mainAgentId
      ? (state.sessions[serverId]?.agentTimelineCursor.get(mainAgentId)?.epoch ?? null)
      : null,
  );
  return { mainStreamTail, mainStreamHead, mainTimelineHasNewer, currentMainEpoch };
}

interface InboxSyncLoopState {
  running: boolean;
  dirty: boolean;
  latestStamp: string;
  sessionGeneration: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_INBOX_FORWARD_CATCH_UP_PAGES = 50;
const INBOX_CATCH_UP_RETRY_DELAY_MS = 2_000;

function clearInboxSyncRetryTimer(state: InboxSyncLoopState): void {
  if (state.retryTimer !== null) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
}

type InboxPageDecision = "apply" | "superseded_epoch" | "superseded_seq" | "reject";

interface InboxTimelineCandidatePage {
  direction: "tail" | "before" | "after";
  reset?: boolean;
  error: string | null;
  epoch: string;
  window?: { maxSeq: number };
  endCursor: { epoch: string; seq: number } | null;
}

function isSameEpochPageSuperseded(
  page: InboxTimelineCandidatePage,
  currentEndSeq: number,
  requestedAfterSeq: number | null,
): boolean {
  const pageMaxSeq = page.endCursor?.seq ?? page.window?.maxSeq ?? -1;
  if (page.direction === "tail" && !page.reset && pageMaxSeq < currentEndSeq) {
    return true;
  }
  return (
    page.direction === "after" &&
    requestedAfterSeq !== null &&
    currentEndSeq > requestedAfterSeq &&
    pageMaxSeq <= currentEndSeq
  );
}

function evaluateInboxTimelinePage(input: {
  serverId: string;
  mainAgentId: string;
  page: InboxTimelineCandidatePage;
  baselineEpoch: string | null;
  requestedAfterSeq: number | null;
}): InboxPageDecision {
  const { serverId, mainAgentId, page, baselineEpoch, requestedAfterSeq } = input;
  if (page.error) return "reject";

  const session = useSessionStore.getState().sessions[serverId];
  const latest = selectAgentTimelineState(session, mainAgentId);
  const currentRange = latest.status === "synced" ? latest.range : undefined;
  const isReplacementPage = page.reset === true || page.direction === "tail";
  if (!currentRange) {
    return baselineEpoch === null || isReplacementPage ? "apply" : "reject";
  }
  if (baselineEpoch !== currentRange.epoch) {
    return "superseded_epoch";
  }
  if (page.epoch !== currentRange.epoch) {
    return isReplacementPage ? "apply" : "reject";
  }
  return isSameEpochPageSuperseded(page, currentRange.endSeq, requestedAfterSeq)
    ? "superseded_seq"
    : "apply";
}

function didTimelineAdvancePastRequest(
  serverId: string,
  mainAgentId: string,
  baselineEpoch: string | null,
  requestedAfterSeq: number | null,
): boolean {
  const afterApply = selectAgentTimelineState(
    useSessionStore.getState().sessions[serverId],
    mainAgentId,
  );
  if (afterApply.status !== "synced" || !afterApply.range) return false;
  if (afterApply.range.epoch !== baselineEpoch) return true;
  return requestedAfterSeq !== null && afterApply.range.endSeq > requestedAfterSeq;
}

async function catchUpMainTimelineOnce(
  serverId: string,
  mainAgentId: string,
  isCurrentSession: () => boolean,
): Promise<boolean> {
  const runtime = getHostRuntimeStore();
  if (typeof runtime.fetchAgentTimeline !== "function") return true;
  await runtime.prepareAgentTimeline?.(serverId, mainAgentId);
  if (!isCurrentSession()) return false;

  for (let pageCount = 0; pageCount < MAX_INBOX_FORWARD_CATCH_UP_PAGES; pageCount += 1) {
    if (!isCurrentSession()) return false;
    const session = useSessionStore.getState().sessions[serverId];
    if (!session?.viewedTimelineSync) return false;
    const timeline = selectAgentTimelineState(session, mainAgentId);
    const range = timeline.status === "synced" ? timeline.range : null;
    const baselineEpoch = range?.epoch ?? null;
    const request = planTimelineResumeFetch(range);
    const requestedAfterSeq = request.direction === "after" ? request.cursor.seq : null;
    let decision: InboxPageDecision = "reject";

    const page = await runtime.fetchAgentTimeline(serverId, mainAgentId, request, {
      canApply: (candidate) => {
        if (!isCurrentSession()) {
          decision = "reject";
          return false;
        }
        decision = evaluateInboxTimelinePage({
          serverId,
          mainAgentId,
          page: candidate,
          baselineEpoch,
          requestedAfterSeq,
        });
        return decision === "apply";
      },
    });
    if (!isCurrentSession() || page.error || decision === "reject") return false;

    if (decision === "superseded_epoch") {
      continue;
    }

    const syncedAfter =
      selectAgentTimelineState(useSessionStore.getState().sessions[serverId], mainAgentId)
        .status === "synced";
    if (!syncedAfter) return false;
    if (!page.hasNewer) return true;
    if (!didTimelineAdvancePastRequest(serverId, mainAgentId, baselineEpoch, requestedAfterSeq)) {
      return false;
    }
  }
  return false;
}

async function drainInboxTimelineSyncLoop(input: {
  state: InboxSyncLoopState;
  generation: number;
  serverId: string;
  mainAgentId: string;
  onSyncedStamp: (stamp: string) => void;
}): Promise<void> {
  const { state, generation, serverId, mainAgentId, onSyncedStamp } = input;
  const isCurrentSession = () => state.sessionGeneration === generation;
  try {
    while (state.dirty && isCurrentSession()) {
      state.dirty = false;
      const stampBefore = state.latestStamp;
      let caughtUp = false;
      try {
        caughtUp = await catchUpMainTimelineOnce(serverId, mainAgentId, isCurrentSession);
      } catch {
        caughtUp = false;
      }
      if (!isCurrentSession()) return;
      if (caughtUp && !state.dirty) {
        clearInboxSyncRetryTimer(state);
        onSyncedStamp(stampBefore);
      } else if (!caughtUp && !state.dirty && state.retryTimer === null) {
        state.retryTimer = setTimeout(() => {
          state.retryTimer = null;
          if (!isCurrentSession()) return;
          state.dirty = true;
          if (!state.running) {
            state.running = true;
            void drainInboxTimelineSyncLoop(input);
          }
        }, INBOX_CATCH_UP_RETRY_DELAY_MS);
      }
    }
  } finally {
    if (isCurrentSession()) {
      state.running = false;
    }
  }
}

function useMainTimelineInboxSync(input: {
  serverId: string;
  mainAgentId: string | null;
  active: boolean;
  activeTab: string;
  isConnected: boolean;
  hasMain: boolean;
  isMainSilent: boolean;
}): boolean {
  const { serverId, mainAgentId, active, activeTab, isConnected, hasMain, isMainSilent } = input;
  const client = useHostRuntimeClient(serverId);
  const shouldSync = Boolean(
    active &&
    activeTab === "messages" &&
    isConnected &&
    client &&
    mainAgentId &&
    hasMain &&
    !isMainSilent,
  );
  const mainUpdateStamp = useSessionStore((state) => {
    if (!mainAgentId) return "";
    const agent = state.sessions[serverId]?.agents.get(mainAgentId);
    if (!agent) return "";
    return `${agent.updatedAt.getTime()}:${agent.attentionTimestamp?.getTime() ?? 0}:${agent.turn.phase}:${agent.pendingSubagentInbox?.count ?? 0}`;
  });
  const [syncedStamp, setSyncedStamp] = useState<string>("");
  const loopStateRef = useRef<InboxSyncLoopState>({
    running: false,
    dirty: false,
    latestStamp: "",
    sessionGeneration: 0,
    retryTimer: null,
  });

  useEffect(() => {
    const state = loopStateRef.current;
    state.sessionGeneration += 1;
    const generation = state.sessionGeneration;
    state.running = false;
    clearInboxSyncRetryTimer(state);
    if (!shouldSync || !mainAgentId || !client) {
      state.dirty = false;
      return;
    }
    return () => {
      if (state.sessionGeneration === generation) {
        state.sessionGeneration += 1;
        state.dirty = false;
        state.running = false;
        clearInboxSyncRetryTimer(state);
      }
    };
  }, [client, mainAgentId, serverId, shouldSync]);

  useEffect(() => {
    if (!shouldSync || !mainAgentId || !client) return;
    if (typeof getHostRuntimeStore().fetchAgentTimeline !== "function") {
      setSyncedStamp(mainUpdateStamp);
      return;
    }
    const state = loopStateRef.current;
    clearInboxSyncRetryTimer(state);
    state.latestStamp = mainUpdateStamp;
    state.dirty = true;
    if (!state.running) {
      state.running = true;
      void drainInboxTimelineSyncLoop({
        state,
        generation: state.sessionGeneration,
        serverId,
        mainAgentId,
        onSyncedStamp: setSyncedStamp,
      });
    }
  }, [client, mainAgentId, mainUpdateStamp, serverId, shouldSync]);

  if (!shouldSync || typeof getHostRuntimeStore().fetchAgentTimeline !== "function") return false;
  return syncedStamp !== mainUpdateStamp;
}

function useTeamTopicReadContext(
  serverId: string,
  workspaceId: string,
  mainAgentId: string | null,
  active: boolean,
): TeamTopicReadContext | undefined {
  const { snapshot, isSupported } = useWorkspaceTopicReadState(
    serverId,
    workspaceId,
    mainAgentId,
    active,
  );
  const supportsTaskLedger = useHostFeature(serverId, "workspaceTaskLedger");
  const { query: tasksQuery } = useWorkspaceTasks(
    serverId,
    workspaceId,
    active && isSupported && supportsTaskLedger && Boolean(mainAgentId),
  );
  const { entries: threadEntries, anchors: topicAnchors } = useWorkspaceTopicEntries(
    serverId,
    workspaceId,
    mainAgentId,
    active && isSupported,
  );
  return useMemo(() => {
    if (!isSupported || !mainAgentId) return undefined;
    return { snapshot, tasks: tasksQuery.data, threadEntries, topicAnchors };
  }, [isSupported, mainAgentId, snapshot, tasksQuery.data, threadEntries, topicAnchors]);
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

  const activeTab = useTeamDirectoryViewStore((state) => state.activeTab);
  const setActiveTab = useTeamDirectoryViewStore((state) => state.setActiveTab);
  const agentGroupMode = useTeamDirectoryViewStore((state) => state.agentGroupMode);
  const setAgentGroupMode = useTeamDirectoryViewStore((state) => state.setAgentGroupMode);

  const scopeKey = `${serverId}\0${workspaceId}`;
  const [historyExpanded, toggleHistory] = useScopedExpansion(scopeKey, false);
  const [activityInactiveExpanded, toggleActivityInactive] = useScopedExpansion(scopeKey, false);
  const [l1InactiveExpanded, toggleL1Inactive] = useScopedExpansion(`${scopeKey}\0l1`, false);
  const [l2InactiveExpanded, toggleL2Inactive] = useScopedExpansion(`${scopeKey}\0l2`, false);

  const agentMaps = useSessionStore(
    useShallow(
      (state): Record<string, ReadonlyMap<string, TeamDirectoryAgent>> =>
        Object.fromEntries(
          Object.entries(state.sessions).map(([id, session]) => [id, session.agents]),
        ),
    ),
  );
  const localAgents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const { mainStreamTail, mainStreamHead, mainTimelineHasNewer, currentMainEpoch } =
    useMainAgentTimelineStreams(serverId, mainAgentId);

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
    enabled: active && activeTab === "agents" && historyExpanded,
    workspaceAgentMembership,
  });
  const retainedHistory = useRef({ scopeKey, history: liveHistory });
  useLayoutEffect(() => {
    if (active) retainedHistory.current = { scopeKey, history: liveHistory };
  }, [active, liveHistory, scopeKey]);
  const history =
    !active && retainedHistory.current.scopeKey === scopeKey
      ? retainedHistory.current.history
      : liveHistory;

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

  const isMainTimelineStale = useMainTimelineInboxSync({
    serverId,
    mainAgentId,
    active,
    activeTab,
    isConnected,
    hasMain: directory.summary.hasMain,
    isMainSilent: directory.summary.isMainSilent,
  });

  const focusedAddress = useMemo<AgentAddress | null>(
    () => (focusedAgentId ? { serverId, agentId: focusedAgentId } : null),
    [focusedAgentId, serverId],
  );

  const activityGroups = useMemo(
    () => selectTeamActivityGroups(directory, focusedAddress, focusedProviderSubagentId),
    [directory, focusedAddress, focusedProviderSubagentId],
  );
  const attributeGroups = useMemo(
    () => selectTeamAttributeGroups(directory, focusedAddress),
    [directory, focusedAddress],
  );

  const durableQuery = useWorkspaceDurableItems(serverId, workspaceId, active);
  const durableItems = durableQuery.result.data ?? EMPTY_DURABLE_ITEMS;
  const readScopeKey = useMemo(
    () => buildTopicInboxReadScopeKey({ serverId, workspaceId, mainAgentId }),
    [mainAgentId, serverId, workspaceId],
  );
  const readScope = useTopicInboxReadStore((state) => state.scopes[readScopeKey]);
  const topicRead = useTeamTopicReadContext(
    serverId,
    workspaceId,
    isTopicWorkspace ? mainAgentId : null,
    active,
  );

  const messagesProjection = useMemo(
    () =>
      selectTeamDirectoryMessages({
        workspaceId,
        mainAgentId,
        agents: localAgents,
        mainStreamTail,
        mainStreamHead,
        mainTimelineHasNewer,
        isMainTimelineStale,
        currentMainEpoch,
        durableItems,
        readScope,
        topicRead,
        fallbackAgentTitle: fallbackTitle,
      }),
    [
      currentMainEpoch,
      durableItems,
      fallbackTitle,
      isMainTimelineStale,
      localAgents,
      mainAgentId,
      mainStreamHead,
      mainStreamTail,
      mainTimelineHasNewer,
      readScope,
      topicRead,
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

  const liveNodeByAgentId = useMemo(() => {
    const map = new Map<string, TeamDirectoryMemberNode>();
    const allNodes = [
      ...(directory.mainSeat ? [directory.mainSeat] : []),
      ...directory.standaloneRoots,
      ...directory.residentGroups.flatMap((group) => group.nodes),
      ...directory.residentSubtasks,
      ...directory.taskTree.flatMap((branch) => [branch.node, ...branch.children]),
      ...directory.sideChats,
    ];
    for (const node of allNodes) {
      if (node.serverId === serverId) {
        map.set(node.agentId, node);
      }
    }
    return map;
  }, [directory, serverId]);

  const handleFocusAgentById = useCallback(
    (targetAgentId: string) => {
      const existing = liveNodeByAgentId.get(targetAgentId);
      if (existing) {
        onOpenAgent(existing);
        return;
      }
      const fallbackAgent = localAgents?.get(targetAgentId);
      if (!fallbackAgent) return;
      onOpenAgent({
        serverId,
        agentId: targetAgentId,
        depth: 0,
        title: fallbackAgent.title?.trim() || fallbackTitle,
        parentAgentId: fallbackAgent.parentAgentId,
        parentTitle: null,
        bucket: "done",
        sortPriority: 3,
        isArchived: Boolean(fallbackAgent.archivedAt),
        isRunning: false,
        isSilentSeat: false,
        isMain: targetAgentId === mainAgentId,
        isStandalone: false,
        isResident: false,
        isSideChat: false,
        residentRole: null,
        residentSlug: null,
        profileId: null,
        lastActivityAt: fallbackAgent.lastActivityAt,
        createdAt: fallbackAgent.createdAt,
      });
    },
    [fallbackTitle, liveNodeByAgentId, localAgents, mainAgentId, onOpenAgent, serverId],
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

  const { pendingCount: pendingTodoCount } = useWorkspaceTodos(serverId, workspaceId);
  const pendingDurableCount = useMemo(
    () => durableItems.filter((item) => item.status === "pending").length,
    [durableItems],
  );
  const totalTodosTabCount = pendingTodoCount + pendingDurableCount;
  const unreadCount = messagesProjection.unread.length;
  const runningCount = directory.summary.runningCount;
  const tabOptions = useMemo<SegmentedControlOption<TeamDirectoryTab>[]>(
    () => buildDirectoryTabOptions({ unreadCount, totalTodosTabCount, runningCount, t }),
    [runningCount, t, totalTodosTabCount, unreadCount],
  );

  const groupModeOptions = useMemo<SegmentedControlOption<TeamDirectoryAgentGroupMode>[]>(
    () => [
      {
        value: "activity",
        label: t("topicWorkbench.directory.groupByActivity"),
        testID: "team-directory-group-activity",
      },
      {
        value: "attribute",
        label: t("topicWorkbench.directory.groupByAttribute"),
        testID: "team-directory-group-attribute",
      },
    ],
    [t],
  );

  return (
    <View
      style={inSheet ? styles.sheet : [styles.sidebar, overlay && styles.overlay]}
      testID="workspace-team-directory"
    >
      <View style={styles.header}>
        <SegmentedControl
          size="sm"
          options={tabOptions}
          value={activeTab}
          onValueChange={setActiveTab}
          style={styles.tabsControl}
          testID="team-directory-tabs"
        />
        {inSheet ? null : (
          <ToolbarButton
            compact
            testID="team-directory-hide"
            label={t("topicWorkbench.directory.hide")}
            onPress={onHide}
          >
            <ThemedPanelLeftClose size={16} />
          </ToolbarButton>
        )}
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
        <View style={styles.list}>
          <DirectoryTabBody
            activeTab={activeTab}
            serverId={serverId}
            workspaceId={workspaceId}
            mainAgentId={mainAgentId}
            readScopeKey={readScopeKey}
            client={client}
            messagesProjection={messagesProjection}
            durableItems={durableItems}
            onFocusAgentById={handleFocusAgentById}
            agentsContent={
              <>
                <View style={styles.groupSwitcherRow}>
                  <SegmentedControl
                    size="sm"
                    options={groupModeOptions}
                    value={agentGroupMode}
                    onValueChange={setAgentGroupMode}
                    testID="team-directory-agent-group-mode"
                  />
                </View>

                {agentGroupMode === "activity" ? (
                  <DirectoryActivityModeContent
                    directory={directory}
                    activityGroups={activityGroups}
                    isTopicWorkspace={isTopicWorkspace}
                    focusedProviderSubagentId={focusedProviderSubagentId}
                    inactiveExpanded={activityInactiveExpanded}
                    onToggleInactive={toggleActivityInactive}
                    supportsIdleArchive={supportsIdleArchive}
                    cleanupStatus={cleanupStatus}
                    onCleanupPress={handleCleanupPress}
                    onCreateResident={createResidentAction}
                    onActivatePreset={handleActivatePreset}
                    onOpenProviderSubrun={onOpenProviderSubrun}
                    onAskFirstQuestion={onAskFirstQuestion}
                    rowActions={rowActions}
                  />
                ) : (
                  <DirectoryAttributeModeContent
                    directory={directory}
                    attributeGroups={attributeGroups}
                    isTopicWorkspace={isTopicWorkspace}
                    focusedProviderSubagentId={focusedProviderSubagentId}
                    l1InactiveExpanded={l1InactiveExpanded}
                    onToggleL1Inactive={toggleL1Inactive}
                    l2InactiveExpanded={l2InactiveExpanded}
                    onToggleL2Inactive={toggleL2Inactive}
                    supportsIdleArchive={supportsIdleArchive}
                    cleanupStatus={cleanupStatus}
                    onCleanupPress={handleCleanupPress}
                    onCreateResident={createResidentAction}
                    onActivatePreset={handleActivatePreset}
                    onOpenProviderSubrun={onOpenProviderSubrun}
                    onAskFirstQuestion={onAskFirstQuestion}
                    rowActions={rowActions}
                  />
                )}

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
                  groupMode={agentGroupMode}
                  rowActions={rowActions}
                />
              </>
            }
          />
        </View>
      </ScrollView>
    </View>
  );
});

const AddResidentTrigger = memo(function AddResidentTrigger({
  presetResidents,
  onCreateResident,
  onActivatePreset,
}: {
  presetResidents: readonly TeamDirectoryPresetResident[];
  onCreateResident?: () => void;
  onActivatePreset: (profileId: string) => void;
}) {
  const { t } = useTranslation();
  if (!onCreateResident && presetResidents.length === 0) return null;

  if (presetResidents.length === 0 && onCreateResident) {
    return (
      <ToolbarButton
        compact
        testID="team-directory-create-resident"
        label={t("subagents.resident.createAction")}
        onPress={onCreateResident}
      >
        <ThemedPlus size={14} />
      </ToolbarButton>
    );
  }

  return (
    <DropdownMenu>
      <ToolbarButton
        kind="menu"
        compact
        testID="team-directory-create-resident"
        label={t("topicWorkbench.directory.addResidentMenuTitle")}
      >
        <ThemedPlus size={14} />
      </ToolbarButton>
      <DropdownMenuContent align="end">
        {presetResidents.map((preset) => (
          <PresetResidentMenuItem
            key={preset.profileId}
            preset={preset}
            onActivate={onActivatePreset}
          />
        ))}
        {presetResidents.length > 0 && onCreateResident ? <DropdownMenuSeparator /> : null}
        {onCreateResident ? (
          <DropdownMenuItem leading={USER_PLUS_ICON} onSelect={onCreateResident}>
            {t("topicWorkbench.directory.createCustomResident")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

function PresetResidentMenuItem({
  preset,
  onActivate,
}: {
  preset: TeamDirectoryPresetResident;
  onActivate: (profileId: string) => void;
}) {
  const handleSelect = useCallback(
    () => onActivate(preset.profileId),
    [onActivate, preset.profileId],
  );
  return (
    <DropdownMenuItem
      leading={USER_PLUS_ICON}
      onSelect={handleSelect}
      testID={`team-directory-preset-${preset.profileId}`}
    >
      {preset.name}
    </DropdownMenuItem>
  );
}

const CleanupActionButton = memo(function CleanupActionButton({
  cleanableCount,
  supportsIdleArchive,
  cleanupStatus,
  onCleanupPress,
}: {
  cleanableCount: number;
  supportsIdleArchive: boolean;
  cleanupStatus: CleanupStatus;
  onCleanupPress: () => void;
}) {
  const { t } = useTranslation();
  const cleanupTooltip = useMemo(
    () => <Text style={styles.tooltipText}>{t("topicWorkbench.directory.cleanupTooltip")}</Text>,
    [t],
  );
  const showCleanupAction =
    supportsIdleArchive && (cleanableCount > 0 || cleanupStatus.kind !== "idle");
  if (!showCleanupAction) return null;
  const cleanupLabel = resolveCleanupLabel(cleanupStatus, cleanableCount, t);

  return (
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
  );
});

const DirectoryActivityModeContent = memo(function DirectoryActivityModeContent({
  directory,
  activityGroups,
  isTopicWorkspace,
  focusedProviderSubagentId,
  inactiveExpanded,
  onToggleInactive,
  supportsIdleArchive,
  cleanupStatus,
  onCleanupPress,
  onCreateResident,
  onActivatePreset,
  onOpenProviderSubrun,
  onAskFirstQuestion,
  rowActions,
}: {
  directory: TeamDirectoryData;
  activityGroups: TeamDirectoryActivityGroups;
  isTopicWorkspace: boolean;
  focusedProviderSubagentId: string | null;
  inactiveExpanded: boolean;
  onToggleInactive: () => void;
  supportsIdleArchive: boolean;
  cleanupStatus: CleanupStatus;
  onCleanupPress: () => void;
  onCreateResident?: () => void;
  onActivatePreset: (profileId: string) => void;
  onOpenProviderSubrun: (parentAgentId: string, subagentId: string) => void;
  onAskFirstQuestion?: () => void;
  rowActions: MemberRowActionHandlers;
}) {
  const { t } = useTranslation();
  const activeCount = activityGroups.activeMembers.length + activityGroups.activeSubruns.length;
  const hasCollapsibleInactive =
    activityGroups.collapsibleInactiveMembers.length > 0 ||
    activityGroups.inactiveSubruns.length > 0;
  const showInactiveSection =
    activityGroups.totalInactiveCount > 0 || cleanupStatus.kind !== "idle";
  const inactiveExpandedState = useMemo(() => ({ expanded: inactiveExpanded }), [inactiveExpanded]);

  return (
    <>
      <View style={styles.section} testID="team-directory-activity-active">
        <View style={styles.sectionHeader}>
          <Text accessibilityRole="header" numberOfLines={1} style={styles.sectionTitle}>
            {t("topicWorkbench.directory.activityActiveSection", { count: activeCount })}
          </Text>
          <AddResidentTrigger
            presetResidents={directory.presetResidents}
            onCreateResident={onCreateResident}
            onActivatePreset={onActivatePreset}
          />
        </View>

        {!directory.mainSeat && isTopicWorkspace ? (
          <UnboundMainBlock onAskFirstQuestion={onAskFirstQuestion} />
        ) : null}

        {activeCount === 0 && (directory.mainSeat || !isTopicWorkspace) ? (
          <Text style={styles.historyMeta}>
            {t("topicWorkbench.directory.activityEmptyActive")}
          </Text>
        ) : null}

        {activityGroups.activeMembers.map((node) => (
          <TeamMemberRow
            key={teamDirectoryNodeKey(node)}
            node={node}
            groupMode="activity"
            showParentSubtitle={node.depth === 2}
            rowActions={rowActions}
          />
        ))}
        {activityGroups.activeSubruns.map((subrun) => (
          <NativeSubrunRow
            key={`${subrun.parentAgentId}:${subrun.id}`}
            subrun={subrun}
            isFocused={focusedProviderSubagentId === subrun.id}
            onOpen={onOpenProviderSubrun}
          />
        ))}
      </View>

      {showInactiveSection ? (
        <View style={styles.section} testID="team-directory-activity-inactive">
          <View style={styles.sectionHeader}>
            <PressHighlight
              style={styles.sectionToggleButton}
              highlightStyle={styles.rowHighlight}
              accessibilityRole="button"
              accessibilityState={inactiveExpandedState}
              disabled={!hasCollapsibleInactive}
              onPress={onToggleInactive}
              testID="team-directory-toggle-inactive"
            >
              {renderSectionChevron(hasCollapsibleInactive, inactiveExpanded)}
              <Text numberOfLines={1} style={styles.sectionTitle}>
                {t("topicWorkbench.directory.activityInactiveSection", {
                  count: activityGroups.totalInactiveCount,
                })}
              </Text>
            </PressHighlight>
            <CleanupActionButton
              cleanableCount={directory.cleanableTaskMembers.length}
              supportsIdleArchive={supportsIdleArchive}
              cleanupStatus={cleanupStatus}
              onCleanupPress={onCleanupPress}
            />
          </View>

          {activityGroups.pinnedInactiveMembers.map((node) => (
            <TeamMemberRow
              key={teamDirectoryNodeKey(node)}
              node={node}
              groupMode="activity"
              showParentSubtitle={node.depth === 2}
              rowActions={rowActions}
            />
          ))}

          {inactiveExpanded ? (
            <View style={styles.historyBody}>
              {activityGroups.collapsibleInactiveMembers.map((node) => (
                <TeamMemberRow
                  key={teamDirectoryNodeKey(node)}
                  node={node}
                  groupMode="activity"
                  showParentSubtitle={node.depth === 2}
                  rowActions={rowActions}
                />
              ))}
              {activityGroups.inactiveSubruns.map((subrun) => (
                <NativeSubrunRow
                  key={`${subrun.parentAgentId}:${subrun.id}`}
                  subrun={subrun}
                  isFocused={focusedProviderSubagentId === subrun.id}
                  onOpen={onOpenProviderSubrun}
                />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </>
  );
});

const DirectoryAttributeModeContent = memo(function DirectoryAttributeModeContent({
  directory,
  attributeGroups,
  isTopicWorkspace,
  focusedProviderSubagentId,
  l1InactiveExpanded,
  onToggleL1Inactive,
  l2InactiveExpanded,
  onToggleL2Inactive,
  supportsIdleArchive,
  cleanupStatus,
  onCleanupPress,
  onCreateResident,
  onActivatePreset,
  onOpenProviderSubrun,
  onAskFirstQuestion,
  rowActions,
}: {
  directory: TeamDirectoryData;
  attributeGroups: TeamDirectoryAttributeGroups;
  isTopicWorkspace: boolean;
  focusedProviderSubagentId: string | null;
  l1InactiveExpanded: boolean;
  onToggleL1Inactive: () => void;
  l2InactiveExpanded: boolean;
  onToggleL2Inactive: () => void;
  supportsIdleArchive: boolean;
  cleanupStatus: CleanupStatus;
  onCleanupPress: () => void;
  onCreateResident?: () => void;
  onActivatePreset: (profileId: string) => void;
  onOpenProviderSubrun: (parentAgentId: string, subagentId: string) => void;
  onAskFirstQuestion?: () => void;
  rowActions: MemberRowActionHandlers;
}) {
  const { t } = useTranslation();
  const hasLevelOne =
    attributeGroups.levelOne.expandedMembers.length > 0 ||
    attributeGroups.levelOne.foldedInactiveMembers.length > 0 ||
    Boolean(onCreateResident) ||
    directory.presetResidents.length > 0 ||
    cleanupStatus.kind !== "idle";
  const hasLevelTwo =
    attributeGroups.levelTwo.expandedMembers.length > 0 ||
    attributeGroups.levelTwo.foldedInactiveMembers.length > 0 ||
    attributeGroups.levelTwoSubruns.length > 0;

  return (
    <>
      <View style={styles.section} testID="team-directory-attribute-main">
        <View style={styles.sectionHeader}>
          <Text accessibilityRole="header" numberOfLines={1} style={styles.sectionTitle}>
            {t("topicWorkbench.directory.attributeMainSection")}
          </Text>
        </View>
        {attributeGroups.mainSeat ? (
          <TeamMemberRow
            node={attributeGroups.mainSeat}
            groupMode="attribute"
            rowActions={rowActions}
          />
        ) : null}
        {!attributeGroups.mainSeat && isTopicWorkspace ? (
          <UnboundMainBlock onAskFirstQuestion={onAskFirstQuestion} />
        ) : null}
        {attributeGroups.standaloneRoots.map((node) => (
          <TeamMemberRow
            key={teamDirectoryNodeKey(node)}
            node={node}
            groupMode="attribute"
            rowActions={rowActions}
          />
        ))}
        {attributeGroups.sideChats.map((node) => (
          <TeamMemberRow
            key={teamDirectoryNodeKey(node)}
            node={node}
            groupMode="attribute"
            rowActions={rowActions}
          />
        ))}
      </View>

      {hasLevelOne ? (
        <View style={styles.section} testID="team-directory-attribute-l1">
          <View style={styles.sectionHeader}>
            <Text accessibilityRole="header" numberOfLines={1} style={styles.sectionTitle}>
              {t("topicWorkbench.directory.attributeLevelOneSection")}
            </Text>
            <View style={styles.headerActions}>
              <CleanupActionButton
                cleanableCount={directory.cleanableTaskMembers.length}
                supportsIdleArchive={supportsIdleArchive}
                cleanupStatus={cleanupStatus}
                onCleanupPress={onCleanupPress}
              />
              <AddResidentTrigger
                presetResidents={directory.presetResidents}
                onCreateResident={onCreateResident}
                onActivatePreset={onActivatePreset}
              />
            </View>
          </View>

          {attributeGroups.levelOne.expandedMembers.map((node) => (
            <TeamMemberRow
              key={teamDirectoryNodeKey(node)}
              node={node}
              groupMode="attribute"
              rowActions={rowActions}
            />
          ))}

          <InactiveSectionFold
            foldedNodes={attributeGroups.levelOne.foldedInactiveMembers}
            expanded={l1InactiveExpanded}
            onToggle={onToggleL1Inactive}
            showParentSubtitle={false}
            testID="team-directory-toggle-l1-inactive"
            rowActions={rowActions}
          />
        </View>
      ) : null}

      {hasLevelTwo ? (
        <View style={styles.section} testID="team-directory-attribute-l2">
          <View style={styles.sectionHeader}>
            <Text accessibilityRole="header" numberOfLines={1} style={styles.sectionTitle}>
              {t("topicWorkbench.directory.attributeLevelTwoSection")}
            </Text>
          </View>

          {attributeGroups.levelTwo.expandedMembers.map((node) => (
            <TeamMemberRow
              key={teamDirectoryNodeKey(node)}
              node={node}
              groupMode="attribute"
              showParentSubtitle
              rowActions={rowActions}
            />
          ))}

          {attributeGroups.levelTwoSubruns.map((subrun) => (
            <NativeSubrunRow
              key={`${subrun.parentAgentId}:${subrun.id}`}
              subrun={subrun}
              isFocused={focusedProviderSubagentId === subrun.id}
              onOpen={onOpenProviderSubrun}
            />
          ))}

          <InactiveSectionFold
            foldedNodes={attributeGroups.levelTwo.foldedInactiveMembers}
            expanded={l2InactiveExpanded}
            onToggle={onToggleL2Inactive}
            showParentSubtitle
            testID="team-directory-toggle-l2-inactive"
            rowActions={rowActions}
          />
        </View>
      ) : null}
    </>
  );
});

const InactiveSectionFold = memo(function InactiveSectionFold({
  foldedNodes,
  expanded,
  onToggle,
  showParentSubtitle,
  testID,
  rowActions,
}: {
  foldedNodes: readonly TeamDirectoryMemberNode[];
  expanded: boolean;
  onToggle: () => void;
  showParentSubtitle: boolean;
  testID: string;
  rowActions: MemberRowActionHandlers;
}) {
  const { t } = useTranslation();
  const expandedState = useMemo(() => ({ expanded }), [expanded]);
  if (foldedNodes.length === 0) return null;

  return (
    <View style={styles.historyBody}>
      <PressHighlight
        style={styles.historyToggleRow}
        highlightStyle={styles.rowHighlight}
        accessibilityRole="button"
        accessibilityState={expandedState}
        onPress={onToggle}
        testID={testID}
      >
        {expanded ? <ThemedChevronDown size={13} /> : <ThemedChevronRight size={13} />}
        <Text numberOfLines={1} style={styles.foldLabel}>
          {expanded
            ? t("topicWorkbench.directory.hideInactiveFold", { count: foldedNodes.length })
            : t("topicWorkbench.directory.inactiveFoldToggle", { count: foldedNodes.length })}
        </Text>
      </PressHighlight>
      {expanded
        ? foldedNodes.map((node) => (
            <TeamMemberRow
              key={teamDirectoryNodeKey(node)}
              node={node}
              groupMode="attribute"
              showParentSubtitle={showParentSubtitle}
              rowActions={rowActions}
            />
          ))
        : null}
    </View>
  );
});

function UnboundMainBlock({ onAskFirstQuestion }: { onAskFirstQuestion?: () => void }) {
  const { t } = useTranslation();
  return (
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
  );
}

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
  groupMode,
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
  groupMode: TeamDirectoryAgentGroupMode;
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
            ? t("topicWorkbench.directory.activityArchivedSectionCount", { count: members.length })
            : t("topicWorkbench.directory.activityArchivedSection")}
        </Text>
      </PressHighlight>

      {expanded ? (
        <View style={styles.historyBody}>
          {members.map((node) => (
            <TeamMemberRow
              key={teamDirectoryNodeKey(node)}
              node={node}
              groupMode={groupMode}
              rowActions={rowActions}
            />
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

function renderSectionChevron(visible: boolean, expanded: boolean) {
  if (!visible) return null;
  return expanded ? <ThemedChevronDown size={14} /> : <ThemedChevronRight size={14} />;
}

function deriveTeamMemberRowCapabilities(
  node: TeamDirectoryMemberNode,
  rowActions: MemberRowActionHandlers,
): {
  canResetTopicMain: boolean;
  canDetach: boolean;
  canArchive: boolean;
} {
  const canResetTopicMain = Boolean(
    rowActions.isTopicWorkspace &&
    node.isMain &&
    !node.isArchived &&
    rowActions.onResidentAction &&
    supportsResidentAction(rowActions.features, "reset") &&
    allowsTopicMainResetPermissions(rowActions.permissions),
  );
  return {
    canResetTopicMain,
    canDetach: !node.isArchived && !node.isMain && !node.isStandalone && !node.isSideChat,
    canArchive: !node.isArchived && !node.isMain && !node.isResident,
  };
}

const TeamMemberRow = memo(function TeamMemberRow({
  node,
  groupMode,
  showParentSubtitle = false,
  rowActions,
}: {
  node: TeamDirectoryMemberNode;
  groupMode: TeamDirectoryAgentGroupMode;
  showParentSubtitle?: boolean;
  rowActions: MemberRowActionHandlers;
}) {
  const {
    serverId,
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

  const { canResetTopicMain, canDetach, canArchive } = deriveTeamMemberRowCapabilities(
    node,
    rowActions,
  );
  const statusText = resolveMemberStatusText(node, t);
  const trailingTag = resolveMemberRoleTag(node, groupMode, t);
  const parentLine =
    showParentSubtitle && node.parentTitle
      ? t("topicWorkbench.directory.parentPrefix", { parent: node.parentTitle })
      : null;
  const accessibilityLabel = parentLine
    ? `${label}, ${parentLine}, ${statusText}`
    : `${label}, ${statusText}`;

  return (
    <HoverEnvelope
      style={[
        styles.rowContainer,
        isHovered && !isFocused && styles.rowHovered,
        isFocused && styles.rowFocused,
      ]}
      onHoverChange={setIsHovered}
    >
      <PressHighlight
        testID={`team-directory-row-${node.agentId}`}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={selectedAccessibilityState}
        style={styles.row}
        highlightStyle={styles.rowHighlight}
        onPress={handlePress}
      >
        <StatusDot bucket={node.bucket} />
        <View style={styles.rowTextColumn}>
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={node.isArchived ? styles.rowTitleMuted : styles.rowTitle}
          >
            {label}
          </Text>
          {parentLine ? (
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              style={styles.rowSubtitle}
              testID={`team-directory-parent-${node.agentId}`}
            >
              {parentLine}
            </Text>
          ) : null}
        </View>
        {trailingTag ? (
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
    </HoverEnvelope>
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
    width: 256,
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
    justifyContent: "space-between",
    minHeight: 38,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    gap: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  tabsControl: {
    flex: 1,
    minWidth: 0,
  },
  groupSwitcherRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[1],
    paddingBottom: theme.spacing[1],
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0.5],
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
  sectionToggleButton: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    minHeight: 28,
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  sectionTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  foldLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rowContainer: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius.md,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  row: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    minHeight: 32,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[1],
    gap: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  rowFocused: {
    backgroundColor: theme.colors.surface2,
  },
  rowHighlight: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  rowTextColumn: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  rowTitleMuted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  rowSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
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
    minHeight: 30,
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
