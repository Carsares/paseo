import { router, type Href } from "expo-router";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { i18n } from "@/i18n/i18next";
import {
  resolveNavigateToAgent,
  resolveOpenForkSourceAgent,
  type NavigateToAgentInput,
  type OpenForkSourceAgentInput,
} from "./resolve";

export type { NavigateToAgentInput, OpenForkSourceAgentInput } from "./resolve";

export function navigateToAgent(input: NavigateToAgentInput): string {
  return resolveNavigateToAgent(input, {
    readAgentNavTarget: ({ serverId, agentId }) => {
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      return {
        agentWorkspaceId: agent?.workspaceId,
      };
    },
    navigateToHostAgent: (route) => {
      router.navigate(route as Href);
    },
    navigateToWorkspace,
  });
}

export function openForkSourceAgent(input: OpenForkSourceAgentInput): Promise<boolean> {
  const session = input.serverId
    ? useSessionStore.getState().sessions[input.serverId.trim()]
    : undefined;
  const client = session?.client;
  const runtime = getHostRuntimeStore();
  return resolveOpenForkSourceAgent(
    {
      ...input,
      onHostRemoved:
        input.onHostRemoved ??
        (() => input.onError?.(new Error(i18n.t("message.actions.forkSourceHostRemoved")))),
    },
    {
      isHostRemoved: (serverId) =>
        runtime.getHostRegistryStatus() === "ready" &&
        !runtime.getHosts().some((host) => host.serverId === serverId),
      isHostOffline: (serverId) => !isHostRuntimeConnected(runtime.getSnapshot(serverId)),
      readCachedAgent: ({ serverId, agentId }) => {
        const cachedSession = useSessionStore.getState().sessions[serverId];
        const agent =
          cachedSession?.agents.get(agentId) ?? cachedSession?.agentDetails.get(agentId);
        return { found: Boolean(agent), workspaceId: agent?.workspaceId };
      },
      fetchRemoteAgent: client
        ? async ({ agentId }) => {
            const result = await client.fetchAgent({ agentId });
            return { found: Boolean(result?.agent), workspaceId: result?.agent?.workspaceId };
          }
        : undefined,
      navigate: navigateToAgent,
    },
  );
}
