import type { AgentAddress } from "./addresses.js";
export const PARENT_SERVER_ID_LABEL = "paseo.parent-server-id";
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const PARENT_REPORTING_LABEL = "paseo.parent-reporting";
export const EXPLICIT_PARENT_REPORTING = "explicit";
export const WORKSPACE_ROLE_LABEL = "paseo.workspace-role";
export const WORKSPACE_MAIN_ROLE = "main";
export const SIDE_CHAT_LABEL = "paseo.side-chat";
export const SIDE_OF_AGENT_ID_LABEL = "paseo.side-of";
export const MAIN_PRIOR_MODE_ID_LABEL = "paseo.main-prior-mode-id";
export const RESIDENT_AGENT_LABEL = "paseo.resident";
export const RESIDENT_ROLE_LABEL = "paseo.resident-role";
export const RESIDENT_SLUG_LABEL = "paseo.resident-slug";
export const AGENT_PROFILE_ID_LABEL = "paseo.profile-id";
export const RESIDENT_INBOX_BYPASS_LABEL = "paseo.resident-urgent-report";
export const RESIDENT_KEEPALIVE_LABEL = "paseo.resident-keepalive";
export const LEAD_PLAYBOOK_LABEL = "paseo.lead-playbook";
export const LEAD_COMMIT_POLICY_LABEL = "paseo.lead-commit-policy";
export const LEAD_PLAYBOOKS = ["batch_implement", "cr_fix_loop", "readonly_cr"] as const;
export type LeadPlaybook = (typeof LEAD_PLAYBOOKS)[number];
export const LEAD_COMMIT_POLICIES = ["none", "scoped_only"] as const;
export type LeadCommitPolicy = (typeof LEAD_COMMIT_POLICIES)[number];
export const RESERVED_LEAD_PLAYBOOK_LABELS = [
  LEAD_PLAYBOOK_LABEL,
  LEAD_COMMIT_POLICY_LABEL,
] as const;
export const RESIDENT_ROLE_MAX_LENGTH = 500;
export const RESIDENT_ROLE_SLUG_MAX_LENGTH = 64;
export const RESIDENT_ROLE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
export const AGENT_PROFILE_ID_MAX_LENGTH = 128;
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

export function isSideChatAgentLabels(labels: AgentLabelSource["labels"]): boolean {
  return labels?.[SIDE_CHAT_LABEL] === "true";
}

export function isSideChatAgent(agent: AgentLabelSource): boolean {
  return isSideChatAgentLabels(agent.labels);
}

export function isResidentAgentLabels(labels: AgentLabelSource["labels"]): boolean {
  return labels?.[RESIDENT_AGENT_LABEL] === "true";
}

export function isResidentAgent(agent: AgentLabelSource): boolean {
  return isResidentAgentLabels(agent.labels);
}

export function getResidentRoleFromLabels(labels: AgentLabelSource["labels"]): string | null {
  const raw = labels?.[RESIDENT_ROLE_LABEL];
  if (typeof raw !== "string") return null;
  const role = raw.trim();
  return role.length > 0 && role.length <= RESIDENT_ROLE_MAX_LENGTH ? role : null;
}

export function getResidentRoleSlugFromLabels(labels: AgentLabelSource["labels"]): string | null {
  const slug = labels?.[RESIDENT_SLUG_LABEL];
  return typeof slug === "string" && RESIDENT_ROLE_SLUG_PATTERN.test(slug) ? slug : null;
}

export function getAgentProfileIdFromLabels(labels: AgentLabelSource["labels"]): string | null {
  const id = labels?.[AGENT_PROFILE_ID_LABEL];
  return typeof id === "string" && id.length <= AGENT_PROFILE_ID_MAX_LENGTH && id.trim().length > 0
    ? id
    : null;
}

export function hasResidentInboxBypass(labels: AgentLabelSource["labels"]): boolean {
  return labels?.[RESIDENT_INBOX_BYPASS_LABEL] === "true";
}

export function hasResidentKeepAlive(labels: AgentLabelSource["labels"]): boolean {
  return labels?.[RESIDENT_KEEPALIVE_LABEL] === "true";
}

export function isExplicitParentReportingLabels(
  labels: Record<string, unknown> | null | undefined,
): boolean {
  return labels?.[PARENT_REPORTING_LABEL] === EXPLICIT_PARENT_REPORTING;
}

export function getLeadPlaybookFromLabels(
  labels: Record<string, unknown> | null | undefined,
): LeadPlaybook | null {
  const raw = labels?.[LEAD_PLAYBOOK_LABEL];
  return typeof raw === "string" && (LEAD_PLAYBOOKS as readonly string[]).includes(raw)
    ? (raw as LeadPlaybook)
    : null;
}

export function getLeadCommitPolicyFromLabels(
  labels: Record<string, unknown> | null | undefined,
): LeadCommitPolicy {
  if (getLeadPlaybookFromLabels(labels) === "readonly_cr") return "none";
  return labels?.[LEAD_COMMIT_POLICY_LABEL] === "scoped_only" ? "scoped_only" : "none";
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
