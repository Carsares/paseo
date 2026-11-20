import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getOpenAgentTabLabel } from "@getpaseo/protocol/agent-labels";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { getOrCreateClientId } from "@/utils/client-id";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { resolveCloseAgentTabPolicy } from "./close-tab-policy";

export async function clearSubagentOpenTabLabel(input: {
  client: Pick<DaemonClient, "updateAgent">;
  agentId: string;
  serverId: string;
  workspaceId: string;
}): Promise<boolean> {
  const { client, agentId, serverId, workspaceId } = input;
  const clientId = await getOrCreateClientId();
  await client.updateAgent(agentId, { labels: { [getOpenAgentTabLabel(clientId)]: "false" } });
  const session = useSessionStore.getState().sessions[serverId];
  const latestAgent = session?.agents.get(agentId);
  return (
    normalizeWorkspaceOpaqueId(latestAgent?.workspaceId) === workspaceId &&
    resolveCloseAgentTabPolicy(latestAgent).kind === "archive-on-close"
  );
}

export function needsOpenAgentTabLabel(
  agent: Agent | null | undefined,
  label: string,
  workspaceId?: string | null,
): agent is Agent {
  return Boolean(
    agent?.parentAgentId &&
    agent.labels[label] !== "true" &&
    (workspaceId === undefined ||
      normalizeWorkspaceOpaqueId(agent.workspaceId) === normalizeWorkspaceOpaqueId(workspaceId)),
  );
}

export function getAgentTabsNeedingOpenLabel(input: {
  tabs: WorkspaceTab[];
  getAgent: (agentId: string) => Agent | null | undefined;
  label: string;
  pendingAgentIds: ReadonlySet<string>;
  workspaceId?: string | null;
}): string[] {
  const agentIds = new Set<string>();
  for (const tab of input.tabs) {
    if (tab.target.kind !== "agent") {
      continue;
    }
    const agent = input.getAgent(tab.target.agentId);
    if (
      needsOpenAgentTabLabel(agent, input.label, input.workspaceId) &&
      !input.pendingAgentIds.has(agent.id)
    ) {
      agentIds.add(agent.id);
    }
  }
  return [...agentIds];
}

interface OpenTabAgentSource {
  sessions: Record<
    string,
    { agents: ReadonlyMap<string, Agent>; agentDetails: ReadonlyMap<string, Agent> } | undefined
  >;
}

/**
 * The agents behind the given open tabs, in tab order. Compared element by element, this changes
 * only when one of those agents changes, not on updates to other agents on the host.
 */
export function selectOpenTabAgents(
  state: OpenTabAgentSource,
  input: { serverId: string; agentIds: readonly string[] },
): (Agent | null)[] {
  const session = state.sessions[input.serverId];
  return input.agentIds.map(
    (agentId) => session?.agents.get(agentId) ?? session?.agentDetails.get(agentId) ?? null,
  );
}
