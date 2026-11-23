import type { AgentAddress } from "@getpaseo/protocol/addresses";
import {
  getParentAddressFromLabels,
  getParentAgentIdFromLabels,
  getResidentRoleFromLabels,
  hasOpenAgentTab,
  isMainControlAgent,
  isResidentAgent,
  resolveAgentHierarchyDepth,
} from "@getpaseo/protocol/agent-labels";
import type { Agent } from "@/stores/session-store";

type TreeAgent = Pick<
  Agent,
  | "id"
  | "workspaceId"
  | "labels"
  | "title"
  | "turn"
  | "status"
  | "backgroundWork"
  | "createdAt"
  | "archivedAt"
  | "background"
> &
  Partial<Pick<Agent, "lastActivityAt" | "updatedAt">>;

export interface MainControlSession {
  serverId: string;
  agents: ReadonlyMap<string, TreeAgent>;
}

export interface MainControlTreeNode extends AgentAddress {
  depth: 0 | 1 | 2;
  title: string;
  processState: "running" | "idle" | "closed";
  roleBadge?: "main" | "standalone";
  residentRole?: string | null;
  isArchived: boolean;
  lastActivityAt: Date;
}

export interface MainControlWorkspaceSections {
  residentGroups: MainControlResidentGroup[];
  active: MainControlTreeNode[];
  closed: MainControlTreeNode[];
}

export interface MainControlResidentGroup {
  parent: AgentAddress | null;
  parentTitle: string | null;
  nodes: MainControlTreeNode[];
}

export function mainControlTreeNodeKey({ serverId, agentId }: AgentAddress): string {
  return `${serverId}:${agentId}`;
}

function getLocalParentId(session: MainControlSession, agentId: string): string | null {
  const parent = getParentAddressFromLabels(session.agents.get(agentId)?.labels, session.serverId);
  return parent?.serverId === session.serverId ? parent.agentId : null;
}

function indexChildren(session: MainControlSession, include: (agent: TreeAgent) => boolean) {
  const children = new Map<string, TreeAgent[]>();
  for (const agent of session.agents.values()) {
    if (!include(agent)) continue;
    const parentId = getLocalParentId(session, agent.id);
    if (!parentId) continue;
    const siblings = children.get(parentId);
    if (siblings) siblings.push(agent);
    else children.set(parentId, [agent]);
  }
  return children;
}

interface LocatedAgent extends AgentAddress {
  agent: TreeAgent;
}

interface WorkspaceAddress {
  serverId: string;
  workspaceId: string;
}

function belongsToWorkspace(entry: LocatedAgent, workspace: WorkspaceAddress): boolean {
  return entry.serverId === workspace.serverId && entry.agent.workspaceId === workspace.workspaceId;
}

function lastActivity(agent: TreeAgent): Date {
  return agent.lastActivityAt ?? agent.updatedAt ?? agent.archivedAt ?? agent.createdAt;
}

function collectDirectoryEntries({
  agentMaps,
  archivedAgents,
  workspaceAddress,
}: {
  agentMaps: Readonly<Record<string, MainControlSession["agents"]>>;
  archivedAgents?: Iterable<TreeAgent>;
  workspaceAddress: WorkspaceAddress;
}): LocatedAgent[] {
  const byAddress = new Map<string, LocatedAgent>();
  for (const agent of archivedAgents ?? []) {
    const entry = { serverId: workspaceAddress.serverId, agentId: agent.id, agent };
    if (!agent.archivedAt || agent.background || !belongsToWorkspace(entry, workspaceAddress))
      continue;
    const key = mainControlTreeNodeKey(entry);
    byAddress.set(key, entry);
  }
  for (const [serverId, agents] of Object.entries(agentMaps)) {
    for (const agent of agents.values()) {
      const entry = { serverId, agentId: agent.id, agent };
      const key = mainControlTreeNodeKey(entry);
      const archived = byAddress.get(key);
      // The directory owns lifecycle state; history can supply newer metadata for an archive.
      if (
        !agent.archivedAt ||
        agent.background ||
        !archived ||
        !belongsToWorkspace(entry, workspaceAddress) ||
        lastActivity(agent) >= lastActivity(archived.agent)
      ) {
        byAddress.set(key, entry);
      }
    }
  }
  return [...byAddress.values()].sort(
    (a, b) => a.agent.createdAt.getTime() - b.agent.createdAt.getTime(),
  );
}

function indexLocatedChildren(entries: LocatedAgent[]): Map<string, LocatedAgent[]> {
  const childrenByParent = new Map<string, LocatedAgent[]>();
  for (const entry of entries) {
    const parent = getParentAddressFromLabels(entry.agent.labels, entry.serverId);
    if (!parent) continue;
    const key = mainControlTreeNodeKey(parent);
    const siblings = childrenByParent.get(key);
    if (siblings) siblings.push(entry);
    else childrenByParent.set(key, [entry]);
  }
  return childrenByParent;
}

function resolveProcessState(
  entry: LocatedAgent,
  {
    isMain,
    openTabAgentIds,
    workspaceAddress,
  }: {
    isMain: boolean;
    openTabAgentIds: ReadonlySet<string>;
    workspaceAddress: WorkspaceAddress;
  },
): MainControlTreeNode["processState"] {
  const { agent, agentId, serverId } = entry;
  if (agent.archivedAt) return "closed";
  if (
    agent.turn.phase === "open" ||
    agent.status === "running" ||
    agent.status === "initializing" ||
    (agent.backgroundWork?.count ?? 0) > 0
  ) {
    return "running";
  }
  if (isMain) return "idle";
  if (serverId === workspaceAddress.serverId && openTabAgentIds.has(agentId)) return "idle";
  if (belongsToWorkspace(entry, workspaceAddress)) {
    // Presence in this workspace's layout is authoritative for closing its idle tabs.
    return "closed";
  }
  // For descendants owned elsewhere, the daemon labels report open tabs.
  return hasOpenAgentTab(agent.labels) ? "idle" : "closed";
}

export function selectMainControlWorkspaceSections({
  session,
  agentMaps = {},
  archivedAgents,
  mainAgentId,
  workspaceId,
  fallbackTitle,
  openTabAgentIds,
  pendingArchiveIds,
}: {
  session: MainControlSession | undefined;
  agentMaps?: Readonly<Record<string, MainControlSession["agents"]>>;
  archivedAgents?: Iterable<TreeAgent>;
  mainAgentId: string;
  workspaceId: string;
  fallbackTitle: string;
  openTabAgentIds: ReadonlySet<string>;
  pendingArchiveIds?: ReadonlySet<string>;
}): MainControlWorkspaceSections | null {
  const main = session?.agents.get(mainAgentId);
  if (!session || !isWorkspaceRootAgent(main, workspaceId) || !isMainControlAgent(main)) {
    return null;
  }

  const workspaceAddress = { serverId: session.serverId, workspaceId };
  const mainEntry = { serverId: session.serverId, agentId: main.id, agent: main };
  const mainKey = mainControlTreeNodeKey(mainEntry);
  const entries = collectDirectoryEntries({
    agentMaps: { ...agentMaps, [session.serverId]: session.agents },
    archivedAgents,
    workspaceAddress,
  });
  const childrenByParent = indexLocatedChildren(entries);
  const entriesByAddress = new Map(entries.map((entry) => [mainControlTreeNodeKey(entry), entry]));
  const residentGroups = new Map<string | null, MainControlResidentGroup>();
  const active: MainControlTreeNode[] = [];
  const closed: MainControlTreeNode[] = [];
  const visited = new Set<string>();
  function addResident(entry: LocatedAgent, node: MainControlTreeNode): boolean {
    if (node.isArchived || !isResidentAgent(entry.agent)) return false;
    const parent = getParentAddressFromLabels(entry.agent.labels, entry.serverId);
    const parentKey = parent ? mainControlTreeNodeKey(parent) : null;
    let group = residentGroups.get(parentKey);
    if (!group) {
      const parentAgent = parentKey ? entriesByAddress.get(parentKey)?.agent : undefined;
      group = {
        parent,
        parentTitle: parent ? parentAgent?.title?.trim() || fallbackTitle : null,
        nodes: [],
      };
      residentGroups.set(parentKey, group);
    }
    group.nodes.push({ ...node, residentRole: getResidentRoleFromLabels(entry.agent.labels) });
    return true;
  }

  function add(entry: LocatedAgent, depth: MainControlTreeNode["depth"]) {
    const { agent, agentId, serverId } = entry;
    const key = mainControlTreeNodeKey(entry);
    if (visited.has(key)) return;
    visited.add(key);
    const isArchived = Boolean(agent.archivedAt);
    if (
      agent.background ||
      (isArchived && !belongsToWorkspace(entry, workspaceAddress)) ||
      (!isArchived && pendingArchiveIds?.has(key))
    )
      return;

    const isMain = key === mainKey;
    const processState = resolveProcessState(entry, {
      isMain,
      openTabAgentIds,
      workspaceAddress,
    });
    const isStandalone = !getParentAgentIdFromLabels(agent.labels) && !isMain;
    const roleBadge = isStandalone ? "standalone" : undefined;
    const node: MainControlTreeNode = {
      agentId,
      serverId,
      depth,
      title: agent.title?.trim() || fallbackTitle,
      processState,
      roleBadge: isMain ? "main" : roleBadge,
      isArchived,
      lastActivityAt: lastActivity(agent),
    };
    if (addResident(entry, node)) return;
    (processState !== "closed" ? active : closed).push(node);
  }

  const pending: { entry: LocatedAgent; depth: MainControlTreeNode["depth"] }[] = [
    { entry: mainEntry, depth: 0 },
  ];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || visited.has(mainControlTreeNodeKey(node.entry))) continue;
    add(node.entry, node.depth);
    const children = childrenByParent.get(mainControlTreeNodeKey(node.entry));
    if (!children) continue;
    const depth = node.depth === 0 ? 1 : 2;
    for (let i = children.length - 1; i >= 0; i--) {
      pending.push({ entry: children[i], depth });
    }
  }
  for (const entry of entries) {
    if (belongsToWorkspace(entry, workspaceAddress)) add(entry, 0);
  }
  closed.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  const orderedResidentGroups = [...visited].flatMap((key) => {
    const group = residentGroups.get(key);
    if (!group) return [];
    residentGroups.delete(key);
    return [group];
  });
  return { residentGroups: [...orderedResidentGroups, ...residentGroups.values()], active, closed };
}

export function isWorkspaceRootAgent(
  agent: TreeAgent | undefined,
  workspaceId: string | undefined,
): agent is TreeAgent & { workspaceId: string } {
  return Boolean(
    workspaceId &&
    agent &&
    agent.workspaceId === workspaceId &&
    !agent.archivedAt &&
    !agent.background &&
    !getParentAgentIdFromLabels(agent.labels),
  );
}

export function findWorkspaceMainAgentId(
  session: MainControlSession | undefined,
  workspaceId: string,
): string | null {
  if (!session) return null;
  for (const agent of session.agents.values()) {
    if (isWorkspaceRootAgent(agent, workspaceId) && isMainControlAgent(agent)) return agent.id;
  }
  return null;
}

export function canAdoptTabUnderMainAgent({
  session,
  agentId,
  mainAgentId,
}: {
  session: MainControlSession | undefined;
  agentId: string;
  mainAgentId: string | null;
}): boolean {
  if (!session || !mainAgentId || agentId === mainAgentId) return false;
  const main = session.agents.get(mainAgentId);
  const agent = session.agents.get(agentId);
  if (
    !isWorkspaceRootAgent(main, agent?.workspaceId) ||
    !isMainControlAgent(main) ||
    !isWorkspaceRootAgent(agent, main.workspaceId) ||
    isMainControlAgent(agent)
  )
    return false;

  // Finished sessions still count toward the depth limit until they are archived.
  const children = indexChildren(session, (child) => !child.archivedAt);
  return !(children.get(agentId) ?? []).some((child) => children.has(child.id));
}

export interface WorkspaceHierarchyTabState {
  mainAgentId: string | null;
  rootAgentIds: ReadonlySet<string>;
  adoptableAgentIds: ReadonlySet<string>;
}

const EMPTY_WORKSPACE_HIERARCHY_TAB_STATE: WorkspaceHierarchyTabState = {
  mainAgentId: null,
  rootAgentIds: new Set(),
  adoptableAgentIds: new Set(),
};

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const item of left) {
    if (!right.has(item)) return false;
  }
  return true;
}

export function deriveWorkspaceHierarchyTabState(
  session: MainControlSession | undefined,
  workspaceId: string,
): WorkspaceHierarchyTabState {
  if (!session || !workspaceId) return EMPTY_WORKSPACE_HIERARCHY_TAB_STATE;
  let mainAgentId: string | null = null;
  const rootAgentIds = new Set<string>();
  for (const agent of session.agents.values()) {
    if (!isWorkspaceRootAgent(agent, workspaceId)) continue;
    rootAgentIds.add(agent.id);
    if (!mainAgentId && isMainControlAgent(agent)) {
      mainAgentId = agent.id;
    }
  }
  const adoptableAgentIds = new Set<string>();
  if (mainAgentId && rootAgentIds.size > 1) {
    // Finished sessions still count toward the depth limit until they are archived.
    const children = indexChildren(session, (child) => !child.archivedAt);
    for (const agentId of rootAgentIds) {
      if (agentId === mainAgentId) continue;
      const agent = session.agents.get(agentId);
      if (!agent || isMainControlAgent(agent)) continue;
      if (!(children.get(agentId) ?? []).some((child) => children.has(child.id))) {
        adoptableAgentIds.add(agentId);
      }
    }
  }
  return { mainAgentId, rootAgentIds, adoptableAgentIds };
}

export function createWorkspaceHierarchyTabStateSelector(input: {
  serverId: string;
  workspaceId: string;
}): (state: {
  sessions: Record<string, { agents: ReadonlyMap<string, TreeAgent> } | undefined>;
}) => WorkspaceHierarchyTabState {
  let previousAgents: ReadonlyMap<string, TreeAgent> | undefined;
  let previousState: WorkspaceHierarchyTabState | null = null;

  return (state) => {
    const agents = state.sessions[input.serverId]?.agents;
    if (previousState && agents === previousAgents) {
      return previousState;
    }
    const next = deriveWorkspaceHierarchyTabState(
      agents ? { serverId: input.serverId, agents } : undefined,
      input.workspaceId,
    );
    previousAgents = agents;
    if (
      !previousState ||
      previousState.mainAgentId !== next.mainAgentId ||
      !setsEqual(previousState.rootAgentIds, next.rootAgentIds) ||
      !setsEqual(previousState.adoptableAgentIds, next.adoptableAgentIds)
    ) {
      previousState = next;
    }
    return previousState;
  };
}

export function hasUnarchivedWorkspaceDescendants(
  session: MainControlSession,
  mainAgentId: string,
  workspaceId: string,
): boolean {
  for (const agent of session.agents.values()) {
    if (agent.id === mainAgentId || agent.archivedAt || agent.workspaceId !== workspaceId) continue;
    // Stop the parent walk at the main agent so deep and hidden descendants are protected too.
    let reachesMain = false;
    resolveAgentHierarchyDepth(
      agent.id,
      (id) => {
        if (id === mainAgentId) {
          reachesMain = true;
          return null;
        }
        return getLocalParentId(session, id);
      },
      session.agents.size,
    );
    if (reachesMain) return true;
  }
  return false;
}
