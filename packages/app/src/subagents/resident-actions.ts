import type { AgentAddress } from "@getpaseo/protocol/addresses";
import {
  getParentAddressFromLabels,
  isMainControlAgent,
  isResidentAgent,
} from "@getpaseo/protocol/agent-labels";
import type { ServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import type { Agent } from "@/stores/session-store";

export type ResidentAction = "create" | "bind" | "unbind" | "reset";
export type ResidentRequest = AgentAddress & { action: ResidentAction };

const actionKeys = {
  create: "subagents.resident.createAction",
  bind: "subagents.resident.bindAction",
  unbind: "subagents.resident.unbindAction",
  reset: "subagents.resident.resetAction",
} as const;

export const residentActionLabel = (action: ResidentAction) => actionKeys[action];

type ResidentTarget = Pick<Agent, "id" | "workspaceId" | "labels" | "archivedAt" | "background">;

function visibleAgent(agent: ResidentTarget | undefined): agent is ResidentTarget {
  return Boolean(agent && !agent.archivedAt && !agent.background);
}

function canBind(agent: ResidentTarget, parent: ResidentTarget | undefined): boolean {
  return Boolean(parent && parent.workspaceId === agent.workspaceId && !isMainControlAgent(agent));
}

type Permission = NonNullable<ServerInfoStatusPayload["permissions"]>[number];

function allows(permissions: readonly Permission[] | undefined, permission: Permission) {
  return permissions?.includes(permission) ?? true;
}

export function residentActionsForAgent({
  serverId,
  agentId,
  agents,
  permissions,
}: AgentAddress & {
  agents: ReadonlyMap<string, ResidentTarget> | undefined;
  permissions: ServerInfoStatusPayload["permissions"];
}): ResidentAction[] {
  const agent = agents?.get(agentId);
  if (!visibleAgent(agent) || !agent.workspaceId || !allows(permissions, "workspace.write")) {
    return [];
  }

  const address = getParentAddressFromLabels(agent.labels, serverId);
  const candidateParent = address?.serverId === serverId ? agents?.get(address.agentId) : undefined;
  const parent =
    visibleAgent(candidateParent) && candidateParent.id !== agentId ? candidateParent : undefined;
  const parentIsRoot = parent && !getParentAddressFromLabels(parent.labels, serverId);
  const canExecute = allows(permissions, "hub.execute");
  const resident = isResidentAgent(agent);
  const actions: ResidentAction[] = [];

  if (canExecute && allows(permissions, "daemon.read") && (!address || parentIsRoot)) {
    actions.push("create");
  }
  if (resident) actions.push("unbind");
  else if (canBind(agent, parent)) actions.push("bind");
  if (resident && canExecute) actions.push("reset");
  return actions;
}

export function supportsResidentAction(
  features: ServerInfoStatusPayload["features"],
  action: ResidentAction,
): boolean {
  // COMPAT(agentResidentSpecialists/agentSessionReset): added in v0.18.0, remove after 2027-06-01.
  return action === "reset"
    ? features?.agentSessionReset === true
    : features?.agentResidentSpecialists === true;
}
