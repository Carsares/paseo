import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import type { ProjectPlacementPayload } from "@getpaseo/protocol/messages";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { resolveProjectPlacement } from "@/utils/project-placement";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export interface HistorySubagentNode {
  agent: AggregatedAgent;
}

export interface HistoryRootAgentNode {
  /** `${serverId}:${agent.id}` */
  key: string;
  agent: AggregatedAgent;
  /** This root provides context for matching descendants and is absent from entries. */
  isAncestorShell: boolean;
  /** Matching descendants in this workspace, flattened and sorted newest first. */
  subagents: HistorySubagentNode[];
  /** Latest visible activity, excluding the root's own activity when it is a shell. */
  latestActivityAt: Date;
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
  workspaces: HistoryWorkspaceGroup[];
}

export type HistoryFlatListItem =
  | { type: "project-header"; key: string; project: HistoryProjectGroup }
  | {
      type: "workspace-header";
      key: string;
      project: HistoryProjectGroup;
      workspace: HistoryWorkspaceGroup;
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
}): WorkspaceDraft {
  const { entry, key, activeIds } = input;
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

function groupWorkspacesByProject(workspaces: Iterable<WorkspaceDraft>): HistoryProjectGroup[] {
  const localProjects = new Map<string, LocalProjectDraft>();
  const equivalenceCountsByServer = new Map<string, Map<string, number>>();

  for (const { workspace, placement, cwd } of workspaces) {
    const { serverId, latestActivityAt } = workspace;
    const { projectKey: projectId, projectName } = placement;
    const key = `${serverId}:${projectId}`;
    let localProject = localProjects.get(key);
    if (!localProject) {
      localProject = {
        project: { key, projectName, serverId, projectId, cwd, latestActivityAt, workspaces: [] },
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
    project.workspaces.sort(
      (left, right) =>
        right.latestActivityAt.getTime() - left.latestActivityAt.getTime() ||
        left.workspaceName.localeCompare(right.workspaceName) ||
        left.key.localeCompare(right.key),
    );
  }
  return [...projects.values()].sort(
    (left, right) =>
      right.latestActivityAt.getTime() - left.latestActivityAt.getTime() ||
      left.projectName.localeCompare(right.projectName) ||
      left.key.localeCompare(right.key),
  );
}

/** With a search query, entries are the matching results and ancestors supply parent context. */
export function buildHistoryProjectGroups(input: {
  entries: readonly AggregatedAgent[];
  ancestors?: readonly AggregatedAgent[];
  activeWorkspaceIdsByServer?: ReadonlyMap<string, ReadonlySet<string>>;
  search?: string;
}): HistoryProjectGroup[] {
  const entriesByKey = new Map(input.entries.map((agent) => [agentKey(agent), agent]));
  const agentsByKey = new Map((input.ancestors ?? []).map((agent) => [agentKey(agent), agent]));
  for (const [key, entry] of entriesByKey) agentsByKey.set(key, entry);

  // The host matches entries before grouping, including typos and fields other than the title.
  const isSearching = Boolean(input.search?.trim());
  const rootsByAgentKey = new Map<string, AggregatedAgent>();
  const nodesByKey = new Map<string, HistoryRootAgentNode>();
  const workspaces = new Map<string, WorkspaceDraft>();
  // The first matching entry supplies the most recent activity and workspace metadata.
  const newestFirst = [...entriesByKey.values()].sort(
    (left, right) =>
      right.lastActivityAt.getTime() - left.lastActivityAt.getTime() ||
      agentKey(left).localeCompare(agentKey(right)),
  );

  for (const entry of newestFirst) {
    const key = workspaceKey(entry);
    let draft = workspaces.get(key);
    if (!draft) {
      draft = createWorkspaceDraft({
        entry,
        key,
        activeIds: input.activeWorkspaceIdsByServer?.get(entry.serverId),
      });
      workspaces.set(key, draft);
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
        hasSearchMatchedSubagent: false,
      };
      nodesByKey.set(rootKey, node);
      draft.workspace.rootAgents.push(node);
    }
    if (entry !== root) {
      node.subagents.push({ agent: entry });
      node.hasSearchMatchedSubagent = isSearching;
    }
  }

  for (const { workspace } of workspaces.values()) {
    workspace.rootAgents.sort(
      (left, right) =>
        right.latestActivityAt.getTime() - left.latestActivityAt.getTime() ||
        left.key.localeCompare(right.key),
    );
  }
  return groupWorkspacesByProject(workspaces.values());
}

export function flattenHistoryProjectGroups(input: {
  groups: readonly HistoryProjectGroup[];
  expandedOverrides: ReadonlyMap<string, boolean>;
  isSearching: boolean;
}): HistoryFlatListItem[] {
  const items: HistoryFlatListItem[] = [];
  for (const project of input.groups) {
    items.push({ type: "project-header", key: `project:${project.key}`, project });
    for (const workspace of project.workspaces) {
      items.push({
        type: "workspace-header",
        key: `workspace:${workspace.key}`,
        project,
        workspace,
      });
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
  }
  return items;
}
