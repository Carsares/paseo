import {
  getParentAddressFromLabels,
  getParentAgentIdFromLabels,
  isMainControlAgent,
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
>;

export interface MainControlSession {
  serverId: string;
  agents: ReadonlyMap<string, TreeAgent>;
}

export interface MainControlTreeNode {
  agentId: string;
  depth: 0 | 1 | 2;
  title: string;
  processState: "active" | "terminated";
  children: MainControlTreeNode[];
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

export function selectMainControlTree({
  session,
  mainAgentId,
  fallbackTitle,
}: {
  session: MainControlSession | undefined;
  mainAgentId: string;
  fallbackTitle: string;
}): MainControlTreeNode | null {
  const main = session?.agents.get(mainAgentId);
  if (!session || !main || !isMainControlAgent(main) || getParentAgentIdFromLabels(main.labels)) {
    return null;
  }

  const childrenByParent = indexChildren(
    session,
    (agent) => !agent.archivedAt && !agent.background,
  );
  const visited = new Set<string>();
  const build = (agent: TreeAgent, depth: MainControlTreeNode["depth"]): MainControlTreeNode => {
    visited.add(agent.id);
    const children =
      depth === 2
        ? []
        : (childrenByParent.get(agent.id) ?? []).filter((child) => !visited.has(child.id));
    const active =
      !agent.archivedAt &&
      (agent.turn.phase === "open" ||
        agent.status === "running" ||
        agent.status === "initializing" ||
        (agent.backgroundWork?.count ?? 0) > 0);
    return {
      agentId: agent.id,
      depth,
      title: agent.title?.trim() || fallbackTitle,
      processState: active ? "active" : "terminated",
      children: children
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((child) => build(child, depth === 0 ? 1 : 2)),
    };
  };
  return build(main, 0);
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
