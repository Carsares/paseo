import { useTranslation } from "react-i18next";
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/shallow";
import { useGlobalDurableItems } from "@/durable-items/queries";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import {
  useSidebarWorkspacesList,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacesListResult,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarWorkspaceEntries } from "@/hooks/use-sidebar-workspace-entries";
import { filterDeferredSidebarProjects } from "@/hooks/sidebar-workspaces-view-model";
import { usePinnedSidebarKeys, type PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarTopicCompletionStore } from "@/stores/sidebar-topic-completion-store";
import {
  hasActiveSidebarLabelFilter,
  resolveEffectiveSidebarGroupMode,
  useSidebarViewStore,
  type SidebarGroupMode,
} from "@/stores/sidebar-view-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import type { SidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import { buildSidebarProjection } from "./sidebar-projection";
import { isWorkspaceDeferred } from "@/workspace-deferral/model";
import type { SidebarProjectIconTarget } from "@/utils/sidebar-project-row-model";
import { filterWorkspacesByLabels, type SidebarWorkspaceGroup } from "./sidebar-labels";
import { filterWorkspacesByProjects, resolveActiveProjectFilters } from "./sidebar-project-filter";
import {
  buildWorkspaceTopicFacts,
  resolveWorkspaceLatestWorkSignalMs,
  type TopicWorkspaceFacts,
} from "./sidebar-topic-view-model";
import {
  hasAuthoritativeWorkspaceLabelCatalog,
  useWorkspaceLabelProjection,
} from "@/workspace-labels";

interface SidebarModel extends SidebarWorkspacesListResult {
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  /**
   * Every project the sidebar could show, before any filter narrows it.
   *
   * `projects` is the FILTERED list. A surface that offers a filter picker must read this one, or
   * narrowing the filter deletes the rows that would undo it.
   */
  allProjects: SidebarProjectEntry[];
  /** The project filter as it is actually being applied — see `resolveActiveProjectFilters`. */
  resolvedProjectFilters: readonly string[];
  hasProjectsBeforeFilter: boolean;
  supportsTopicWorkbench: boolean;
  topicWorkbenchByServer: Readonly<Record<string, boolean>>;
  hasAnyTopicsBeforeFilter: boolean;
  hiddenNonTopicCount: number;
  hasMultipleTopicProjects: boolean;
  topicFactsByWorkspaceKey: ReadonlyMap<string, TopicWorkspaceFacts>;
  groupMode: SidebarGroupMode;
  workspaceGroups: SidebarWorkspaceGroup[];
  projectIconTargets: SidebarProjectIconTarget[];
  pinnedGroups: PinnedSidebarGroups;
  collapsedProjectKeys: ReadonlySet<string>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  shortcutModel: SidebarShortcutModel;
}

function resolveActiveSidebarServerIds(
  allServerIds: readonly string[],
  hostFilters: readonly string[],
): readonly string[] {
  if (hostFilters.length === 0) return allServerIds;
  const selected = new Set(hostFilters);
  const matched = allServerIds.filter((id) => selected.has(id));
  return matched.length > 0 ? matched : allServerIds;
}

function groupLiveAgentsByWorkspaceIdentity(
  agentsByServer: Readonly<Record<string, ReadonlyMap<string, Agent>>>,
): Map<string, Agent[]> {
  const result = new Map<string, Agent[]>();
  for (const [serverId, agents] of Object.entries(agentsByServer)) {
    for (const agent of agents.values()) {
      if (!agent.workspaceId || agent.archivedAt || agent.background) continue;
      const identity = `${serverId}\0${agent.workspaceId}`;
      const bucket = result.get(identity);
      if (bucket) bucket.push(agent);
      else result.set(identity, [agent]);
    }
  }
  return result;
}

function computeGlobalTopicWorkSignals(input: {
  workspacesByServer: Readonly<
    Record<string, ReadonlyMap<string, import("@/stores/session-store").WorkspaceDescriptor>>
  >;
  agentsByWorkspaceIdentity: ReadonlyMap<string, Agent[]>;
  pendingDurableStatsByIdentity: ReadonlyMap<
    string,
    { count: number; latestCreatedAtMs: number | null }
  >;
}): Record<string, number> {
  const signals: Record<string, number> = {};
  for (const [serverId, workspaces] of Object.entries(input.workspacesByServer)) {
    for (const descriptor of workspaces.values()) {
      if (!descriptor.topic) continue;
      const identity = `${serverId}\0${descriptor.id}`;
      const signalMs = resolveWorkspaceLatestWorkSignalMs({
        workspace: descriptor,
        workspaceAgents: input.agentsByWorkspaceIdentity.get(identity) ?? [],
        latestPendingDurableCreatedAtMs:
          input.pendingDurableStatsByIdentity.get(identity)?.latestCreatedAtMs ?? null,
      });
      if (signalMs !== null) {
        signals[`${serverId}:${descriptor.id}`] = signalMs;
      }
    }
  }
  return signals;
}

function hasTopicOnServers(
  serverIds: readonly string[],
  workspacesByServer: Readonly<
    Record<string, ReadonlyMap<string, { topic?: unknown }> | undefined>
  >,
): boolean {
  for (const serverId of serverIds) {
    const workspaces = workspacesByServer[serverId];
    if (!workspaces) continue;
    for (const descriptor of workspaces.values()) {
      if (descriptor.topic) return true;
    }
  }
  return false;
}

function resolveCompletedTopicServerIds(
  completedAtByWorkspaceKey: Readonly<Record<string, string>>,
  hostServerIds: readonly string[],
): string[] {
  const keys = Object.keys(completedAtByWorkspaceKey);
  if (keys.length === 0 || hostServerIds.length === 0) return [];
  const sortedServers = [...hostServerIds].sort((left, right) => right.length - left.length);
  const needed = new Set<string>();
  for (const workspaceKey of keys) {
    for (const serverId of sortedServers) {
      if (workspaceKey.startsWith(`${serverId}:`)) {
        needed.add(serverId);
        break;
      }
    }
  }
  return [...needed];
}

function useCompletedTopicDirectoryDemand(
  completedAtByWorkspaceKey: Readonly<Record<string, string>>,
): void {
  const allHosts = useHosts();
  const completedTopicServerIds = useMemo(
    () =>
      resolveCompletedTopicServerIds(
        completedAtByWorkspaceKey,
        allHosts.map((host) => host.serverId),
      ),
    [allHosts, completedAtByWorkspaceKey],
  );
  const releasesByServerRef = useRef<Map<string, () => void>>(new Map());

  useEffect(() => {
    const runtime = getHostRuntimeStore();
    if (typeof runtime.acquireDirectoryDemand !== "function") return;
    const desired = new Set(completedTopicServerIds);
    const held = releasesByServerRef.current;

    for (const [serverId, release] of held) {
      if (!desired.has(serverId)) {
        held.delete(serverId);
        release();
      }
    }
    for (const serverId of desired) {
      if (!held.has(serverId)) {
        held.set(serverId, runtime.acquireDirectoryDemand(serverId));
      }
    }
  }, [completedTopicServerIds]);

  useEffect(() => {
    const held = releasesByServerRef.current;
    return () => {
      for (const release of held.values()) {
        release();
      }
      held.clear();
    };
  }, []);
}

const SidebarModelContext = createContext<SidebarModel | null>(null);

export function SidebarModelProvider({
  active,
  keyboardNavigationActive = false,
  children,
}: {
  active?: boolean;
  keyboardNavigationActive?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const modelActive = active !== false || keyboardNavigationActive;
  const showBackground = useSidebarViewStore((state) => state.showBackground);
  const storedGroupMode = useSidebarViewStore((state) => state.groupMode);
  const hasExplicitGroupMode = useSidebarViewStore((state) => state.hasExplicitGroupMode);
  const workspaceSort = useSidebarViewStore((state) => state.workspaceSort);
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const labelFilter = useSidebarViewStore((state) => state.labelFilter);
  const projectFilters = useSidebarViewStore((state) => state.projectFilters);
  const reconcileLabelFilter = useSidebarViewStore((state) => state.reconcileLabelFilter);
  const completedAtByWorkspaceKey = useSidebarTopicCompletionStore(
    (state) => state.completedAtByWorkspaceKey,
  );
  const lastWorkAtByWorkspaceKey = useSidebarTopicCompletionStore(
    (state) => state.lastWorkAtByWorkspaceKey,
  );
  const recordTopicWorkSignals = useSidebarTopicCompletionStore(
    (state) => state.recordTopicWorkSignals,
  );
  useCompletedTopicDirectoryDemand(completedAtByWorkspaceKey);
  const topicWorkbenchByServer = useSessionStore(
    useShallow((state) =>
      Object.fromEntries(
        Object.entries(state.sessions).map(([serverId, session]) => [
          serverId,
          session.serverInfo?.features?.topicWorkbenchV1 === true,
        ]),
      ),
    ),
  );
  const workspacesByServer = useSessionStore(
    useShallow((state) =>
      Object.fromEntries(
        Object.entries(state.sessions).map(([serverId, session]) => [serverId, session.workspaces]),
      ),
    ),
  );
  const activeServerIds = useMemo(
    () => resolveActiveSidebarServerIds(Object.keys(workspacesByServer), hostFilters),
    [hostFilters, workspacesByServer],
  );
  const supportsTopicWorkbench = useMemo(
    () => activeServerIds.some((serverId) => topicWorkbenchByServer[serverId] === true),
    [activeServerIds, topicWorkbenchByServer],
  );
  const hasAnyTopicWorkspace = useMemo(
    () => hasTopicOnServers(activeServerIds, workspacesByServer),
    [activeServerIds, workspacesByServer],
  );
  const groupMode = resolveEffectiveSidebarGroupMode({
    groupMode: storedGroupMode,
    hasExplicitGroupMode,
    supportsTopicWorkbench,
    hasAnyTopicWorkspace,
  });
  const list = useSidebarWorkspacesList({ enabled: modelActive, groupMode });
  const agentsByServer = useSessionStore(
    useShallow((state) =>
      Object.fromEntries(
        Object.entries(state.sessions).map(([serverId, session]) => [serverId, session.agents]),
      ),
    ),
  );
  const activityByServer = useSessionStore(
    useShallow((state) =>
      Object.fromEntries(
        Object.entries(state.sessions).map(([serverId, session]) => [
          serverId,
          session.workspaceAgentActivity,
        ]),
      ),
    ),
  );
  const { items: pendingDurableItems } = useGlobalDurableItems();
  const pendingDurableStatsByIdentity = useMemo(() => {
    const stats = new Map<string, { count: number; latestCreatedAtMs: number | null }>();
    for (const { serverId, item } of pendingDurableItems) {
      const identity = `${serverId}\0${item.workspaceId}`;
      const createdMs = Date.parse(item.createdAt);
      const validMs = Number.isFinite(createdMs) ? createdMs : null;
      const existing = stats.get(identity);
      if (existing) {
        existing.count += 1;
        if (validMs !== null) {
          existing.latestCreatedAtMs =
            existing.latestCreatedAtMs === null
              ? validMs
              : Math.max(existing.latestCreatedAtMs, validMs);
        }
      } else {
        stats.set(identity, { count: 1, latestCreatedAtMs: validMs });
      }
    }
    return stats;
  }, [pendingDurableItems]);

  const agentsByWorkspaceIdentity = useMemo(
    () => groupLiveAgentsByWorkspaceIdentity(agentsByServer),
    [agentsByServer],
  );
  const globalWorkSignalsByWorkspaceKey = useMemo(
    () =>
      computeGlobalTopicWorkSignals({
        workspacesByServer,
        agentsByWorkspaceIdentity,
        pendingDurableStatsByIdentity,
      }),
    [agentsByWorkspaceIdentity, pendingDurableStatsByIdentity, workspacesByServer],
  );

  useEffect(() => {
    recordTopicWorkSignals(globalWorkSignalsByWorkspaceKey);
  }, [globalWorkSignalsByWorkspaceKey, recordTopicWorkSignals]);

  const topicFactsByWorkspaceKey = useMemo(() => {
    const factsMap = new Map<string, TopicWorkspaceFacts>();
    for (const placement of list.workspacePlacements) {
      const descriptor = workspacesByServer[placement.serverId]?.get(placement.workspaceId);
      const activity = activityByServer[placement.serverId]?.get(placement.workspaceId);
      const identity = `${placement.serverId}\0${placement.workspaceId}`;
      const durableStats = pendingDurableStatsByIdentity.get(identity);
      const facts = buildWorkspaceTopicFacts({
        workspace: descriptor,
        workspaceAgents: agentsByWorkspaceIdentity.get(identity) ?? [],
        completedAtIso: completedAtByWorkspaceKey[placement.workspaceKey],
        lastWorkAtIso: lastWorkAtByWorkspaceKey[placement.workspaceKey],
        pendingDurableCount: durableStats?.count ?? 0,
        latestPendingDurableCreatedAtMs: durableStats?.latestCreatedAtMs ?? null,
        isDispatchInProgress: activity?.status === "running",
      });
      factsMap.set(placement.workspaceKey, facts);
    }
    return factsMap;
  }, [
    activityByServer,
    agentsByWorkspaceIdentity,
    completedAtByWorkspaceKey,
    lastWorkAtByWorkspaceKey,
    list.workspacePlacements,
    pendingDurableStatsByIdentity,
    workspacesByServer,
  ]);

  const { hosts: labelHosts } = useWorkspaceLabelProjection();
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const collapsedWorkspaceGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedWorkspaceGroupKeys,
  );
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const pinnedWorkspaceOrder = useSidebarOrderStore((state) => state.pinnedWorkspaceOrder);
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );
  const availableLabelNames = useMemo(
    () => labelHosts.flatMap((host) => host.labels.map((label) => label.name)),
    [labelHosts],
  );
  const hasAuthoritativeLabelCatalog = hasAuthoritativeWorkspaceLabelCatalog(labelHosts);
  useEffect(() => {
    if (!hasAuthoritativeLabelCatalog) return;
    reconcileLabelFilter(availableLabelNames);
  }, [availableLabelNames, hasAuthoritativeLabelCatalog, reconcileLabelFilter]);
  const hasActiveLabelFilter = hasActiveSidebarLabelFilter(labelFilter);
  const resolvedProjectFilters = useMemo(
    () =>
      resolveActiveProjectFilters(
        projectFilters,
        new Set(list.projects.map((project) => project.viewKey)),
      ),
    [projectFilters, list.projects],
  );
  const hasActiveProjectFilter = resolvedProjectFilters.length > 0;
  // The project filter is deliberately absent from this gate. It reads `projectViewKey`, which
  // lives on the project and the placement, so it can narrow the project list without hydrating
  // anything; the label filter reads `labels`, which only exists on an entry. Hydration opens a
  // live session-store subscription over every workspace on every visible host, so widening this
  // for a filter that does not need it costs a retained-but-inactive sidebar real work.
  // Hardware keyboard navigation needs the same filtered targets while the sidebar is hidden.
  const needsWorkspaceEntries = groupMode !== "project" || hasActiveLabelFilter;
  const workspaceEntriesByKey = useSidebarWorkspaceEntries(
    list.workspacePlacements,
    modelActive || needsWorkspaceEntries,
  );
  const { filteredWorkspaceEntriesByKey, hiddenNonTopicCount, hasAnyTopicsBeforeFilter } =
    useMemo(() => {
      const nonDeferred = [...workspaceEntriesByKey.values()].filter(
        (workspace) => !isWorkspaceDeferred(workspace) && (showBackground || !workspace.background),
      );
      const anyTopicsBeforeFilter = nonDeferred.some(
        (workspace) => topicFactsByWorkspaceKey.get(workspace.workspaceKey)?.isTopic === true,
      );
      const byProject = filterWorkspacesByProjects({
        workspaces: nonDeferred,
        projectFilters: resolvedProjectFilters,
      });
      const filtered = filterWorkspacesByLabels({
        workspaces: byProject,
        ...labelFilter,
      });
      if (groupMode !== "topic") {
        return {
          filteredWorkspaceEntriesByKey: new Map(
            filtered.map((workspace) => [workspace.workspaceKey, workspace]),
          ),
          hiddenNonTopicCount: 0,
          hasAnyTopicsBeforeFilter: anyTopicsBeforeFilter,
        };
      }
      const topicOnly = filtered.filter(
        (workspace) => topicFactsByWorkspaceKey.get(workspace.workspaceKey)?.isTopic === true,
      );
      return {
        filteredWorkspaceEntriesByKey: new Map(
          topicOnly.map((workspace) => [workspace.workspaceKey, workspace]),
        ),
        hiddenNonTopicCount: filtered.length - topicOnly.length,
        hasAnyTopicsBeforeFilter: anyTopicsBeforeFilter,
      };
    }, [
      groupMode,
      labelFilter,
      resolvedProjectFilters,
      showBackground,
      topicFactsByWorkspaceKey,
      workspaceEntriesByKey,
    ]);
  const visibleWorkspaceKeys = useMemo(
    () => new Set(filteredWorkspaceEntriesByKey.keys()),
    [filteredWorkspaceEntriesByKey],
  );
  const hasMultipleTopicProjects = useMemo(() => {
    if (groupMode !== "topic" || resolvedProjectFilters.length === 1) return false;
    const projectKeys = new Set<string>();
    for (const entry of filteredWorkspaceEntriesByKey.values()) {
      projectKeys.add(entry.projectViewKey);
      if (projectKeys.size > 1) return true;
    }
    return false;
  }, [filteredWorkspaceEntriesByKey, groupMode, resolvedProjectFilters.length]);
  // The two filters prune differently on purpose. The project filter is a membership test on the
  // project itself, so a project you filtered TO survives even with no workspaces — it still owns
  // a header row you can create your first workspace under. The label filter can only ask about
  // workspaces, so a project it empties has nothing left to show.
  const filteredProjects = useMemo(() => {
    let projects = filterDeferredSidebarProjects(list.projects, workspaceEntriesByKey);
    if (hasActiveProjectFilter) {
      const included = new Set(resolvedProjectFilters);
      projects = projects.filter((project) => included.has(project.viewKey));
    }
    if (groupMode === "topic" || hasActiveLabelFilter || !showBackground) {
      projects = projects.flatMap((project) => {
        const workspaces = project.workspaces.filter((workspace) =>
          visibleWorkspaceKeys.has(workspace.workspaceKey),
        );
        return workspaces.length > 0 ||
          (groupMode !== "topic" && !hasActiveLabelFilter && project.workspaces.length === 0)
          ? [workspaces.length === project.workspaces.length ? project : { ...project, workspaces }]
          : [];
      });
    }
    return projects;
  }, [
    groupMode,
    showBackground,
    hasActiveLabelFilter,
    hasActiveProjectFilter,
    resolvedProjectFilters,
    list.projects,
    visibleWorkspaceKeys,
    workspaceEntriesByKey,
  ]);
  const pinnedKeys = usePinnedSidebarKeys(filteredProjects);
  const projectionInput = useMemo(
    () => ({
      projects: filteredProjects,
      pinnedKeys,
      pinnedWorkspaceOrder,
      workspaceEntriesByKey: filteredWorkspaceEntriesByKey,
      projectNamesByViewKey: list.projectNamesByViewKey,
      groupMode,
      workspaceSort,
      topicFactsByWorkspaceKey,
      pinnedCollapsed,
      collapsedProjectKeys,
      collapsedWorkspaceGroupKeys,
      t,
    }),
    [
      collapsedProjectKeys,
      collapsedWorkspaceGroupKeys,
      groupMode,
      workspaceSort,
      topicFactsByWorkspaceKey,
      list.projectNamesByViewKey,
      filteredProjects,
      pinnedCollapsed,
      pinnedKeys,
      pinnedWorkspaceOrder,
      filteredWorkspaceEntriesByKey,
      t,
    ],
  );
  const projection = useMemo(() => buildSidebarProjection(projectionInput), [projectionInput]);
  const value = useMemo(
    () => ({
      ...list,
      projects: filteredProjects,
      allProjects: list.projects,
      resolvedProjectFilters,
      hasProjectsBeforeFilter: list.projects.length > 0,
      supportsTopicWorkbench,
      topicWorkbenchByServer,
      hasAnyTopicsBeforeFilter,
      hiddenNonTopicCount,
      hasMultipleTopicProjects,
      topicFactsByWorkspaceKey,
      workspaceEntriesByKey: filteredWorkspaceEntriesByKey,
      groupMode,
      workspaceGroups: projection.workspaceGroups,
      projectIconTargets: projection.projectIconTargets,
      pinnedGroups: projection.pinnedGroups,
      collapsedProjectKeys,
      toggleProjectCollapsed,
      shortcutModel: projection.shortcutModel,
    }),
    [
      resolvedProjectFilters,
      collapsedProjectKeys,
      groupMode,
      supportsTopicWorkbench,
      topicWorkbenchByServer,
      hasAnyTopicsBeforeFilter,
      hiddenNonTopicCount,
      hasMultipleTopicProjects,
      topicFactsByWorkspaceKey,
      list,
      filteredProjects,
      projection,
      toggleProjectCollapsed,
      filteredWorkspaceEntriesByKey,
    ],
  );

  return <SidebarModelContext.Provider value={value}>{children}</SidebarModelContext.Provider>;
}

export function useSidebarModel(): SidebarModel {
  const model = useContext(SidebarModelContext);
  if (!model) throw new Error("SidebarModelProvider is required");
  return model;
}
