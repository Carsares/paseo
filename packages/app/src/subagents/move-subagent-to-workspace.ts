import type { Agent } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { isWorkspaceRootAgent } from "./workspace-root-policy";

export type MovableWorkspaceAgent = Pick<
  Agent,
  "id" | "parentAgentId" | "workspaceId" | "archivedAt" | "background"
>;

interface MoveSubagentSessionEntry {
  serverInfo?: { features?: { agentMoveToWorkspace?: boolean } } | null;
  agents: ReadonlyMap<string, MovableWorkspaceAgent>;
  agentDetails: ReadonlyMap<string, MovableWorkspaceAgent>;
}

export interface MoveSubagentSessionSnapshot {
  sessions: Record<string, MoveSubagentSessionEntry | undefined>;
}

function lookupParentAgent(
  parentAgentId: string | null | undefined,
  agents: ReadonlyMap<string, MovableWorkspaceAgent> | undefined,
  agentDetails: ReadonlyMap<string, Pick<Agent, "workspaceId">> | undefined,
): Pick<Agent, "workspaceId"> | undefined {
  if (!parentAgentId) {
    return undefined;
  }
  return agents?.get(parentAgentId) ?? agentDetails?.get(parentAgentId);
}

export function hasSiblingWorkspaceRootAgent(input: {
  workspaceId: string | null | undefined;
  agentId: string;
  agents: ReadonlyMap<string, MovableWorkspaceAgent> | undefined;
  agentDetails?: ReadonlyMap<string, Pick<Agent, "workspaceId">> | undefined;
}): boolean {
  const normalizedWorkspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!normalizedWorkspaceId || !input.agents) {
    return false;
  }
  for (const candidate of input.agents.values()) {
    if (candidate.id === input.agentId || candidate.archivedAt || candidate.background) {
      continue;
    }
    if (normalizeWorkspaceOpaqueId(candidate.workspaceId) !== normalizedWorkspaceId) {
      continue;
    }
    const candidateParent = lookupParentAgent(
      candidate.parentAgentId,
      input.agents,
      input.agentDetails,
    );
    if (isWorkspaceRootAgent(candidate, candidateParent)) {
      return true;
    }
  }
  return false;
}

export function canMoveSubagentToWorkspace(input: {
  featureEnabled: boolean;
  workspaceId?: string | null;
  agent:
    | (Pick<Agent, "parentAgentId" | "workspaceId" | "archivedAt"> & {
        id?: string;
        background?: boolean;
      })
    | null
    | undefined;
  parentAgent: Pick<Agent, "workspaceId"> | undefined;
  hasOtherWorkspaceRootAgent?: boolean;
}): boolean {
  if (!input.featureEnabled || !input.agent) {
    return false;
  }
  if (input.agent.archivedAt || input.agent.background) {
    return false;
  }
  if (input.workspaceId !== undefined) {
    const normalizedTarget = normalizeWorkspaceOpaqueId(input.workspaceId);
    if (
      !normalizedTarget ||
      normalizeWorkspaceOpaqueId(input.agent.workspaceId) !== normalizedTarget
    ) {
      return false;
    }
  }
  if (!isWorkspaceRootAgent(input.agent, input.parentAgent)) {
    return true;
  }
  return input.hasOtherWorkspaceRootAgent === true;
}

function evaluateCanMoveSubagentToWorkspace(input: {
  featureEnabled: boolean;
  workspaceId: string;
  agentId: string;
  agents: ReadonlyMap<string, MovableWorkspaceAgent> | undefined;
  agentDetails: ReadonlyMap<string, MovableWorkspaceAgent> | undefined;
}): boolean {
  if (!input.featureEnabled) {
    return false;
  }
  const agent = input.agents?.get(input.agentId) ?? input.agentDetails?.get(input.agentId);
  if (!agent || agent.archivedAt || agent.background) {
    return false;
  }
  if (normalizeWorkspaceOpaqueId(agent.workspaceId) !== input.workspaceId) {
    return false;
  }
  const parentAgent = lookupParentAgent(agent.parentAgentId, input.agents, input.agentDetails);
  let hasOtherWorkspaceRootAgent = false;
  if (isWorkspaceRootAgent(agent, parentAgent)) {
    hasOtherWorkspaceRootAgent = hasSiblingWorkspaceRootAgent({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      agents: input.agents,
      agentDetails: input.agentDetails,
    });
  }
  return canMoveSubagentToWorkspace({
    featureEnabled: input.featureEnabled,
    workspaceId: input.workspaceId,
    agent,
    parentAgent,
    hasOtherWorkspaceRootAgent,
  });
}

// Session-store selectors run on every stream tick, which updates session without changing
// agent maps or feature flags. Reuse the previous result until a relevant source changes.
export function createCanMoveSubagentToWorkspaceSelector(input: {
  serverId: string;
  workspaceId: string | null | undefined;
  agentId: string | null;
}): (state: MoveSubagentSessionSnapshot) => boolean {
  const { serverId, agentId } = input;
  const normalizedWorkspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!agentId || !serverId || !normalizedWorkspaceId) {
    return () => false;
  }

  let previousAgents: ReadonlyMap<string, MovableWorkspaceAgent> | undefined;
  let previousAgentDetails: ReadonlyMap<string, MovableWorkspaceAgent> | undefined;
  let previousFeatureEnabled: boolean | undefined;
  let previousResult: boolean | null = null;

  return (state) => {
    const session = state.sessions[serverId];
    const agents = session?.agents;
    const agentDetails = session?.agentDetails;
    const featureEnabled = session?.serverInfo?.features?.agentMoveToWorkspace === true;

    if (
      previousResult !== null &&
      agents === previousAgents &&
      agentDetails === previousAgentDetails &&
      featureEnabled === previousFeatureEnabled
    ) {
      return previousResult;
    }

    const nextResult = evaluateCanMoveSubagentToWorkspace({
      featureEnabled,
      workspaceId: normalizedWorkspaceId,
      agentId,
      agents,
      agentDetails,
    });
    previousAgents = agents;
    previousAgentDetails = agentDetails;
    previousFeatureEnabled = featureEnabled;
    previousResult = nextResult;
    return nextResult;
  };
}

export interface MoveSubagentToWorkspaceDeps {
  createIdempotencyKey?: () => string;
  moveAgentToWorkspace: (input: {
    serverId: string;
    agentId: string;
    idempotencyKey: string;
  }) => Promise<{ workspaceId: string }>;
  openMovedWorkspace: (input: {
    serverId: string;
    workspaceId: string;
    agentId: string;
  }) => Promise<void> | void;
  reportError: (error: unknown) => void;
}

const inFlightKeys = new Set<string>();

export async function requestMoveSubagentToWorkspace(
  input: { serverId: string; subagentId: string },
  deps: MoveSubagentToWorkspaceDeps,
): Promise<void> {
  const { serverId, subagentId } = input;
  const key = `${serverId}:${subagentId}`;
  if (inFlightKeys.has(key)) {
    return;
  }
  inFlightKeys.add(key);

  try {
    const idempotencyKey =
      deps.createIdempotencyKey?.() ??
      `move_ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const { workspaceId } = await deps.moveAgentToWorkspace({
      serverId,
      agentId: subagentId,
      idempotencyKey,
    });
    await deps.openMovedWorkspace({ serverId, workspaceId, agentId: subagentId });
  } catch (error) {
    deps.reportError(error);
  } finally {
    inFlightKeys.delete(key);
  }
}
