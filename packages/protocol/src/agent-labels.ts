import type { AgentAddress } from "./addresses.js";
export const PARENT_SERVER_ID_LABEL = "paseo.parent-server-id";
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const PARENT_REPORTING_LABEL = "paseo.parent-reporting";
export const EXPLICIT_PARENT_REPORTING = "explicit";
export const WORKSPACE_ROLE_LABEL = "paseo.workspace-role";
export const WORKSPACE_MAIN_ROLE = "main";
export const MAIN_PRIOR_MODE_ID_LABEL = "paseo.main-prior-mode-id";
const OPEN_AGENT_TAB_LABEL_PREFIX = "paseo.open-agent-tab.";

export function getOpenAgentTabLabel(clientId: string): string {
  return `${OPEN_AGENT_TAB_LABEL_PREFIX}${clientId}`;
}

export function isOpenAgentTabLabel(label: string): boolean {
  return label.startsWith(OPEN_AGENT_TAB_LABEL_PREFIX);
}

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function isExplicitParentReportingLabels(
  labels: Record<string, unknown> | null | undefined,
): boolean {
  return labels?.[PARENT_REPORTING_LABEL] === EXPLICIT_PARENT_REPORTING;
}

export function isMainControlAgentLabels(
  labels: Record<string, unknown> | null | undefined,
): boolean {
  return labels?.[WORKSPACE_ROLE_LABEL] === WORKSPACE_MAIN_ROLE;
}

export function isMainControlAgent(agent: AgentLabelSource): boolean {
  return isMainControlAgentLabels(agent.labels);
}

export function getMainPriorModeIdFromLabels(
  labels: Record<string, unknown> | null | undefined,
): string | null {
  const raw = labels?.[MAIN_PRIOR_MODE_ID_LABEL];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

export function resolveAgentHierarchyDepth(
  agentId: string,
  getParentId: (id: string) => string | null | undefined,
  maxHops = 10,
): number {
  const visited = new Set([agentId]);
  let currentId = agentId;
  let depth = 0;
  while (depth < maxHops) {
    const parentId = getParentId(currentId)?.trim();
    if (!parentId || visited.has(parentId)) {
      break;
    }
    visited.add(parentId);
    currentId = parentId;
    depth += 1;
  }
  return depth;
}

export function hasOpenAgentTab(labels: Record<string, unknown> | null | undefined): boolean {
  return Object.entries(labels ?? {}).some(
    ([label, value]) => isOpenAgentTabLabel(label) && value === "true",
  );
}

// Absent parent server label means the same host.
export function getParentAddressFromLabels(
  labels: Record<string, unknown> | null | undefined,
  serverId: string,
): AgentAddress | null {
  const agentId = getParentAgentIdFromLabels(labels);
  if (!agentId) return null;
  const parentServerId = labels?.[PARENT_SERVER_ID_LABEL];
  return {
    serverId:
      typeof parentServerId === "string" && parentServerId.trim()
        ? parentServerId.trim()
        : serverId,
    agentId,
  };
}
export function parentAddressLabels(parent: AgentAddress): Record<string, string> {
  return { [PARENT_AGENT_ID_LABEL]: parent.agentId, [PARENT_SERVER_ID_LABEL]: parent.serverId };
}
