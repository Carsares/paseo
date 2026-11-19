import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";

export interface NavigateToAgentInput {
  serverId: string;
  agentId: string;
  // Used as the workspace target when the agent is not yet in the session store
  // (cold deep-links). Otherwise the workspace is read from the store.
  workspaceId?: string | null;
  pin?: boolean;
  /** Opens the agent with its composer, where a compact layout would show a sheet without one. */
  asTab?: boolean;
}

export interface AgentNavTarget {
  agentWorkspaceId: string | null | undefined;
}

export interface NavigateToAgentDeps {
  readAgentNavTarget: (input: { serverId: string; agentId: string }) => AgentNavTarget;
  navigateToHostAgent: (route: string) => void;
  navigateToWorkspace: (input: NavigateToWorkspaceInput) => string;
}

export function resolveNavigateToAgent(
  input: NavigateToAgentInput,
  deps: NavigateToAgentDeps,
): string {
  const agentWorkspaceId =
    deps.readAgentNavTarget({ serverId: input.serverId, agentId: input.agentId })
      .agentWorkspaceId ?? input.workspaceId;
  const workspaceId = normalizeWorkspaceOpaqueId(agentWorkspaceId);

  if (!workspaceId) {
    const route = buildHostAgentDetailRoute(input.serverId, input.agentId);
    deps.navigateToHostAgent(route);
    return route;
  }

  return deps.navigateToWorkspace({
    serverId: input.serverId,
    workspaceId,
    target: { kind: "agent", agentId: input.agentId },
    pin: input.pin,
    asTab: input.asTab,
  });
}

export interface OpenForkSourceAgentInput {
  serverId: string | undefined;
  sourceAgentId: string | undefined;
  onNotFound?: () => void;
}

interface ForkSourceAgentLookup {
  found: boolean;
  workspaceId?: string | null;
}

export interface OpenForkSourceAgentDeps {
  readCachedAgent: (input: { serverId: string; agentId: string }) => ForkSourceAgentLookup;
  fetchRemoteAgent?: (input: {
    serverId: string;
    agentId: string;
  }) => Promise<ForkSourceAgentLookup>;
  navigate: (input: NavigateToAgentInput) => void;
}

/**
 * Opens the agent a fork was created from. Never navigates when the source agent no
 * longer exists, so the user stays on their current tab.
 */
export async function resolveOpenForkSourceAgent(
  input: OpenForkSourceAgentInput,
  deps: OpenForkSourceAgentDeps,
): Promise<boolean> {
  const serverId = input.serverId?.trim();
  const agentId = input.sourceAgentId?.trim();
  if (!serverId || !agentId) {
    return false;
  }

  const cached = deps.readCachedAgent({ serverId, agentId });
  if (cached.found) {
    deps.navigate({
      serverId,
      agentId,
      workspaceId: cached.workspaceId,
      pin: true,
      asTab: true,
    });
    return true;
  }

  if (!deps.fetchRemoteAgent) {
    deps.navigate({ serverId, agentId, pin: true, asTab: true });
    return true;
  }

  let remote: ForkSourceAgentLookup;
  try {
    remote = await deps.fetchRemoteAgent({ serverId, agentId });
  } catch {
    input.onNotFound?.();
    return false;
  }
  if (!remote.found) {
    input.onNotFound?.();
    return false;
  }
  deps.navigate({
    serverId,
    agentId,
    workspaceId: remote.workspaceId,
    pin: true,
    asTab: true,
  });
  return true;
}
