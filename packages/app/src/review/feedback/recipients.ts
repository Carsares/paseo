import {
  getParentAddressFromLabels,
  isMainControlAgent,
  isResidentAgent,
  isSideChatAgent,
} from "@getpaseo/protocol/agent-labels";
import type { Agent } from "@/stores/session-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";

export type WorkspaceRecipientAgent = Pick<
  Agent,
  | "id"
  | "serverId"
  | "workspaceId"
  | "labels"
  | "status"
  | "turn"
  | "backgroundWork"
  | "background"
  | "archivedAt"
  | "title"
>;

export interface WorkspaceAgentRecipient {
  kind: "agent";
  agent: WorkspaceRecipientAgent;
  tab: WorkspaceTab | null;
}

export type WorkspaceRecipient = WorkspaceAgentRecipient | { kind: "bind_main" };

export type WorkspaceRecipientScope =
  | { kind: "topic"; mainAgentId: string | null }
  | { kind: "legacy" };

export function selectWorkspaceAgentRecipients({
  serverId,
  workspaceId,
  scope,
  agents,
  tabs,
}: {
  serverId: string;
  workspaceId: string;
  scope: WorkspaceRecipientScope;
  agents: Iterable<WorkspaceRecipientAgent>;
  tabs: readonly WorkspaceTab[];
}): WorkspaceRecipient[] {
  const openTabs = new Map<string, WorkspaceTab>();
  for (const tab of tabs) {
    if (tab.target.kind === "agent" && !openTabs.has(tab.target.agentId)) {
      openTabs.set(tab.target.agentId, tab);
    }
  }
  const eligible = [...agents].filter(
    (agent) =>
      agent.serverId === serverId &&
      agent.workspaceId === workspaceId &&
      agent.id.trim().length > 0 &&
      !agent.archivedAt &&
      !agent.background,
  );
  const mainIds = selectMainIds(scope, eligible);
  const groups: WorkspaceAgentRecipient[][] = [[], [], []];
  const seen = new Set<string>();
  for (const agent of eligible) {
    if (seen.has(agent.id)) continue;
    const tab = openTabs.get(agent.id) ?? null;
    const parent = getParentAddressFromLabels(agent.labels, serverId);
    const isFirstLevel = parent?.serverId === serverId && mainIds.has(parent.agentId);
    let group: number;
    if (mainIds.has(agent.id)) group = 0;
    else if (isSideChatAgent(agent)) {
      if (!tab) continue;
      group = 2;
    } else if (isResidentAgent(agent) || (isFirstLevel && isActiveAgent(agent))) group = 1;
    else {
      if (!tab || parent) continue;
      group = 2;
    }
    seen.add(agent.id);
    groups[group].push({ kind: "agent", agent, tab });
  }
  const recipients: WorkspaceRecipient[] = groups.flat();
  if (scope.kind === "topic" && scope.mainAgentId === null) {
    recipients.unshift({ kind: "bind_main" });
  }
  return recipients;
}

function selectMainIds(
  scope: WorkspaceRecipientScope,
  agents: WorkspaceRecipientAgent[],
): Set<string> {
  if (scope.kind === "topic") return new Set(scope.mainAgentId === null ? [] : [scope.mainAgentId]);
  return new Set(agents.filter(isMainControlAgent).map((agent) => agent.id));
}

function isActiveAgent(agent: WorkspaceRecipientAgent): boolean {
  return (
    agent.status === "running" ||
    agent.status === "initializing" ||
    agent.turn.phase === "open" ||
    (agent.backgroundWork?.runningCount ?? agent.backgroundWork?.count ?? 0) > 0
  );
}
