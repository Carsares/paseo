import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import type { ProjectPlacementPayload } from "@getpaseo/protocol/messages";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { resolveProjectPlacement } from "@/utils/project-placement";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export type HistoryGroupMode = "project" | "workspace";
export type HistoryTimeField = "updated_at" | "created_at" | "archived_at";
export type HistorySortDirection = "desc" | "asc";

export interface HistorySortOption {
  readonly field: HistoryTimeField;
  readonly direction: HistorySortDirection;
}

export const DEFAULT_HISTORY_SORT: HistorySortOption = {
  field: "updated_at",
  direction: "desc",
};

export interface HistorySubagentNode {
  agent: AggregatedAgent;
  sortTimestamp: Date;
}

export interface HistoryRootAgentNode {
  /** `${serverId}:${agent.id}` */
  key: string;
  agent: AggregatedAgent;
  /** This root provides context for matching descendants and is absent from entries. */
  isAncestorShell: boolean;
  /** Matching descendants in this workspace, flattened in the selected sort order. */
  subagents: HistorySubagentNode[];
  /** Latest visible activity, excluding the root's own activity when it is a shell. */
  latestActivityAt: Date;
  sortTimestamp: Date;
  /** A descendant was included in the host's search results. */
  hasSearchMatchedSubagent: boolean;
}

export interface HistoryWorkspaceGroup {
  /** `${serverId}:${workspaceId}` or `${serverId}:cwd:${cwd}` for unregistered workspaces. */
  key: string;
  serverId: string;
  serverLabel: string;
  workspaceId: string | undefined;
  workspaceName: string;
  branch: string | null;
  isWorkspaceArchived: boolean;
  latestActivityAt: Date;
  sortTimestamp: Date;
  rootAgents: HistoryRootAgentNode[];
}

export interface HistoryProjectGroup {
  /** `eq:${projectEquivalenceKey}` unless ambiguous on the host, otherwise `${serverId}:${projectKey}`. */
  key: string;
  projectName: string;
  serverId: string;
  projectId: string;
  cwd: string;
  latestActivityAt: Date;
  sortTimestamp: Date;
  workspaces: HistoryWorkspaceGroup[];
}

export type HistoryFlatListItem =
  | {
      type: "project-header";
      key: string;
      project: HistoryProjectGroup;
      expanded: boolean;
    }
  | {
      type: "workspace-header";
      key: string;
      project: HistoryProjectGroup;
      workspace: HistoryWorkspaceGroup;
      expanded: boolean;
      showProjectBadge: boolean;
    }
  | {
      type: "root-agent";
      key: string;
      project: HistoryProjectGroup;
      workspace: HistoryWorkspaceGroup;
      node: HistoryRootAgentNode;
      expanded: boolean;
    }
  | {
      type: "subagent";
      key: string;
      project: HistoryProjectGroup;
      workspace: HistoryWorkspaceGroup;
      parentKey: string;
      agent: AggregatedAgent;
    };

interface WorkspaceDraft {
  workspace: HistoryWorkspaceGroup;
  placement: ProjectPlacementPayload;
  cwd: string;
}

interface LocalProjectDraft {
  project: HistoryProjectGroup;
  equivalenceKeys: Set<string>;
}

export function resolveHistoryAgentTimestamp(
  agent: AggregatedAgent,
  field: HistoryTimeField,
): Date {
  switch (field) {
    case "updated_at":
      return agent.lastActivityAt;
    case "created_at":
      return agent.createdAt;
    case "archived_at": {
      if (agent.archivedAt != null && !Number.isNaN(agent.archivedAt.getTime())) {
        return agent.archivedAt;
      }
      const workspaceArchivedAt = agent.projectPlacement?.workspaceArchivedAt;
      if (workspaceArchivedAt != null) {
        const timestamp = Date.parse(workspaceArchivedAt);
        if (!Number.isNaN(timestamp)) return new Date(timestamp);
      }
      return agent.lastActivityAt;
    }
  }
}

function compareTimestamps(left: Date, right: Date, direction: HistorySortDirection): number {
  const leftTime = left.getTime();
  const rightTime = right.getTime();
  // Unknown dates sort last in both directions so they cannot become a group's valid extremum.
  if (Number.isNaN(leftTime)) return Number.isNaN(rightTime) ? 0 : 1;
  if (Number.isNaN(rightTime)) return -1;
  const difference = leftTime - rightTime;
  return direction === "desc" ? -difference : difference;
}

function compareKeys(left: string, right: string): number {
  const order = left.localeCompare(right);
  if (order !== 0 || left === right) return order;
  // Distinct identifiers can compare equal under locale collation.
  return left < right ? -1 : 1;
}

function agentKey(agent: AggregatedAgent): string {
  return `${agent.serverId}:${agent.id}`;
}

function workspaceKey(agent: AggregatedAgent): string {
  const workspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
  return `${agent.serverId}:${workspaceId ?? `cwd:${agent.cwd}`}`;
}

function createWorkspaceDraft(input: {
  entry: AggregatedAgent;
  key: string;
  activeIds: ReadonlySet<string> | undefined;
  sortTimestamp: Date;
}): WorkspaceDraft {
  const { entry, key, activeIds, sortTimestamp } = input;
  const { serverId, serverLabel, cwd, lastActivityAt } = entry;
  const placement = resolveProjectPlacement({
    projectPlacement: entry.projectPlacement,
    cwd,
  });
  const workspaceId = normalizeWorkspaceOpaqueId(entry.workspaceId) ?? undefined;
  const archivedAt = placement.workspaceArchivedAt;
  return {
    placement,
    cwd,
    workspace: {
      key,
      serverId,
      serverLabel,
      workspaceId,
      workspaceName: placement.workspaceName?.trim() || cwd.split(/[\\/]/).findLast(Boolean) || cwd,
      branch: placement.checkout.isGit ? (placement.checkout.currentBranch ?? null) : null,
      isWorkspaceArchived:
        archivedAt === undefined
          ? workspaceId !== undefined && activeIds !== undefined && !activeIds.has(workspaceId)
          : Boolean(archivedAt),
      latestActivityAt: lastActivityAt,
      sortTimestamp,
      rootAgents: [],
    },
  };
}

function resolveRootAgent(input: {
  entry: AggregatedAgent;
  agentsByKey: ReadonlyMap<string, AggregatedAgent>;
  rootsByAgentKey: Map<string, AggregatedAgent>;
}): AggregatedAgent {
  const { entry, agentsByKey, rootsByAgentKey } = input;
  const workspaceId = normalizeWorkspaceOpaqueId(entry.workspaceId);
  const visitedKeys = new Set<string>();
  const path: AggregatedAgent[] = [];
  let root = entry;

  for (;;) {
    const key = agentKey(root);
    const cachedRoot = rootsByAgentKey.get(key);
    if (cachedRoot) {
      root = cachedRoot;
      break;
    }
    if (visitedKeys.has(key)) {
      // Pick the same root regardless of which descendant reaches the cycle first.
      for (const candidate of path.slice(path.indexOf(root))) {
        if (candidate.id < root.id) root = candidate;
      }
      break;
    }
    visitedKeys.add(key);
    path.push(root);
    const parentAddress = getParentAddressFromLabels(root.labels, root.serverId);
    if (!parentAddress || parentAddress.serverId !== entry.serverId) break;
    const parent = agentsByKey.get(`${parentAddress.serverId}:${parentAddress.agentId}`);
    if (!parent || normalizeWorkspaceOpaqueId(parent.workspaceId) !== workspaceId) break;
    if (workspaceId === null && parent.cwd !== entry.cwd) break;
    root = parent;
  }

  for (const key of visitedKeys) rootsByAgentKey.set(key, root);
  return root;
}

function groupWorkspacesByProject(
  workspaces: Iterable<WorkspaceDraft>,
  direction: HistorySortDirection,
): HistoryProjectGroup[] {
  const localProjects = new Map<string, LocalProjectDraft>();
  const equivalenceCountsByServer = new Map<string, Map<string, number>>();

  for (const { workspace, placement, cwd } of workspaces) {
    const { serverId, latestActivityAt, sortTimestamp } = workspace;
    const { projectKey: projectId, projectName } = placement;
    const key = `${serverId}:${projectId}`;
    let localProject = localProjects.get(key);
    if (!localProject) {
      localProject = {
        project: {
          key,
          projectName,
          serverId,
          projectId,
          cwd,
          latestActivityAt,
          sortTimestamp,
          workspaces: [],
        },
        equivalenceKeys: new Set(),
      };
      localProjects.set(key, localProject);
    }
    localProject.project.workspaces.push(workspace);

    const equivalenceKey = placement.projectEquivalenceKey;
    if (!equivalenceKey?.trim() || localProject.equivalenceKeys.has(equivalenceKey)) continue;
    localProject.equivalenceKeys.add(equivalenceKey);
    let counts = equivalenceCountsByServer.get(serverId);
    if (!counts) {
      counts = new Map();
      equivalenceCountsByServer.set(serverId, counts);
    }
    counts.set(equivalenceKey, (counts.get(equivalenceKey) ?? 0) + 1);
  }

  const projects = new Map<string, HistoryProjectGroup>();
  for (const { project, equivalenceKeys } of localProjects.values()) {
    const [equivalenceKey] = equivalenceKeys;
    const key =
      equivalenceKeys.size === 1 &&
      equivalenceCountsByServer.get(project.serverId)?.get(equivalenceKey) === 1
        ? `eq:${equivalenceKey}`
        : project.key;
    const existing = projects.get(key);
    if (existing) {
      for (const workspace of project.workspaces) existing.workspaces.push(workspace);
    } else {
      projects.set(key, { ...project, key });
    }
  }

  for (const project of projects.values()) {
    for (const workspace of project.workspaces) {
      if (compareTimestamps(workspace.latestActivityAt, project.latestActivityAt, "desc") < 0) {
        project.latestActivityAt = workspace.latestActivityAt;
      }
      if (compareTimestamps(workspace.sortTimestamp, project.sortTimestamp, direction) < 0) {
        project.sortTimestamp = workspace.sortTimestamp;
      }
    }
    project.workspaces.sort(
      (left, right) =>
        compareTimestamps(left.sortTimestamp, right.sortTimestamp, direction) ||
        left.workspaceName.localeCompare(right.workspaceName) ||
        compareKeys(left.key, right.key),
    );
  }
  return [...projects.values()].sort(
    (left, right) =>
      compareTimestamps(left.sortTimestamp, right.sortTimestamp, direction) ||
      left.projectName.localeCompare(right.projectName) ||
      compareKeys(left.key, right.key),
  );
}

/** With a search query, entries are the matching results and ancestors supply parent context. */
export function buildHistoryProjectGroups(input: {
  entries: readonly AggregatedAgent[];
  ancestors?: readonly AggregatedAgent[];
  activeWorkspaceIdsByServer?: ReadonlyMap<string, ReadonlySet<string>>;
  search?: string;
  sort?: HistorySortOption;
}): HistoryProjectGroup[] {
  const { field, direction } = input.sort ?? DEFAULT_HISTORY_SORT;
  const entriesByKey = new Map(input.entries.map((agent) => [agentKey(agent), agent]));
  const agentsByKey = new Map((input.ancestors ?? []).map((agent) => [agentKey(agent), agent]));
  for (const [key, entry] of entriesByKey) agentsByKey.set(key, entry);

  // The host matches entries before grouping, including typos and fields other than the title.
  const isSearching = Boolean(input.search?.trim());
  const rootsByAgentKey = new Map<string, AggregatedAgent>();
  const nodesByKey = new Map<string, HistoryRootAgentNode>();
  const workspaces = new Map<string, WorkspaceDraft>();
  // Keep workspace metadata tied to the latest activity regardless of the selected sort.
  const newestFirst = [...entriesByKey.values()].sort(
    (left, right) =>
      compareTimestamps(left.lastActivityAt, right.lastActivityAt, "desc") ||
      compareKeys(agentKey(left), agentKey(right)),
  );

  for (const entry of newestFirst) {
    const sortTimestamp = resolveHistoryAgentTimestamp(entry, field);
    const key = workspaceKey(entry);
    let draft = workspaces.get(key);
    if (!draft) {
      draft = createWorkspaceDraft({
        entry,
        key,
        activeIds: input.activeWorkspaceIdsByServer?.get(entry.serverId),
        sortTimestamp,
      });
      workspaces.set(key, draft);
    } else if (compareTimestamps(sortTimestamp, draft.workspace.sortTimestamp, direction) < 0) {
      draft.workspace.sortTimestamp = sortTimestamp;
    }

    const root = resolveRootAgent({ entry, agentsByKey, rootsByAgentKey });
    const rootKey = agentKey(root);
    let node = nodesByKey.get(rootKey);
    if (!node) {
      node = {
        key: rootKey,
        agent: root,
        isAncestorShell: !entriesByKey.has(rootKey),
        subagents: [],
        latestActivityAt: entry.lastActivityAt,
        sortTimestamp,
        hasSearchMatchedSubagent: false,
      };
      nodesByKey.set(rootKey, node);
      draft.workspace.rootAgents.push(node);
    } else if (compareTimestamps(sortTimestamp, node.sortTimestamp, direction) < 0) {
      node.sortTimestamp = sortTimestamp;
    }
    if (entry !== root) {
      node.subagents.push({ agent: entry, sortTimestamp });
      node.hasSearchMatchedSubagent = isSearching;
    }
  }

  for (const { workspace } of workspaces.values()) {
    for (const node of workspace.rootAgents) {
      node.subagents.sort(
        (left, right) =>
          compareTimestamps(left.sortTimestamp, right.sortTimestamp, direction) ||
          compareKeys(agentKey(left.agent), agentKey(right.agent)),
      );
    }
    workspace.rootAgents.sort(
      (left, right) =>
        compareTimestamps(left.sortTimestamp, right.sortTimestamp, direction) ||
        compareKeys(left.key, right.key),
    );
  }
  return groupWorkspacesByProject(workspaces.values(), direction);
}

export function flattenHistoryProjectGroups(input: {
  groups: readonly HistoryProjectGroup[];
  expandedOverrides: ReadonlyMap<string, boolean>;
  projectExpandedOverrides?: ReadonlyMap<string, boolean>;
  workspaceExpandedOverrides?: ReadonlyMap<string, boolean>;
  groupMode?: HistoryGroupMode;
  sort?: HistorySortOption;
  isSearching: boolean;
}): HistoryFlatListItem[] {
  const showProjectBadge = input.groupMode === "workspace";
  const items: HistoryFlatListItem[] = [];

  function appendWorkspace(project: HistoryProjectGroup, workspace: HistoryWorkspaceGroup): void {
    const workspaceExpanded = input.workspaceExpandedOverrides?.get(workspace.key) ?? true;
    items.push({
      type: "workspace-header",
      key: `workspace:${workspace.key}`,
      project,
      workspace,
      expanded: workspaceExpanded,
      showProjectBadge,
    });
    if (!workspaceExpanded) return;

    for (const node of workspace.rootAgents) {
      const expanded =
        input.expandedOverrides.get(node.key) ??
        (input.isSearching && node.hasSearchMatchedSubagent);
      items.push({
        type: "root-agent",
        key: `root-agent:${node.key}`,
        project,
        workspace,
        node,
        expanded,
      });
      if (!expanded) continue;
      for (const { agent } of node.subagents) {
        items.push({
          type: "subagent",
          key: `subagent:${agentKey(agent)}`,
          project,
          workspace,
          parentKey: node.key,
          agent,
        });
      }
    }
  }

  if (showProjectBadge) {
    const { direction } = input.sort ?? DEFAULT_HISTORY_SORT;
    const workspaces = input.groups.flatMap((project) =>
      project.workspaces.map((workspace) => ({ project, workspace })),
    );
    workspaces.sort(
      (left, right) =>
        compareTimestamps(left.workspace.sortTimestamp, right.workspace.sortTimestamp, direction) ||
        left.workspace.workspaceName.localeCompare(right.workspace.workspaceName) ||
        left.project.projectName.localeCompare(right.project.projectName) ||
        compareKeys(left.workspace.key, right.workspace.key),
    );
    for (const { project, workspace } of workspaces) {
      appendWorkspace(project, workspace);
    }
    return items;
  }

  for (const project of input.groups) {
    const expanded = input.projectExpandedOverrides?.get(project.key) ?? true;
    items.push({ type: "project-header", key: `project:${project.key}`, project, expanded });
    if (!expanded) continue;
    for (const workspace of project.workspaces) {
      appendWorkspace(project, workspace);
    }
  }
  return items;
}

export function areAllHistoryWorkspacesCollapsed(input: {
  groups: readonly HistoryProjectGroup[];
  groupMode?: HistoryGroupMode;
  projectExpandedOverrides?: ReadonlyMap<string, boolean>;
  workspaceExpandedOverrides?: ReadonlyMap<string, boolean>;
}): boolean {
  let hasWorkspace = false;
  for (const project of input.groups) {
    const projectCollapsed =
      input.groupMode !== "workspace" && input.projectExpandedOverrides?.get(project.key) === false;
    for (const workspace of project.workspaces) {
      hasWorkspace = true;
      if (!projectCollapsed && input.workspaceExpandedOverrides?.get(workspace.key) !== false) {
        return false;
      }
    }
  }
  return hasWorkspace;
}

export function buildAllWorkspacesExpansionMap(
  groups: readonly HistoryProjectGroup[],
  expanded: boolean,
): Map<string, boolean> {
  const overrides = new Map<string, boolean>();
  if (expanded) return overrides;
  for (const project of groups) {
    for (const workspace of project.workspaces) {
      overrides.set(workspace.key, false);
    }
  }
  return overrides;
}
