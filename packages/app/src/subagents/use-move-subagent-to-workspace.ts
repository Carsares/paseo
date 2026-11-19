import type { AgentAddress } from "@getpaseo/protocol/addresses";
import { useCallback } from "react";
import { useToast } from "@/contexts/toast-context";
import { i18n } from "@/i18n/i18next";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { requestMoveSubagentToWorkspace } from "./move-subagent-to-workspace";
import { isWorkspaceRootAgent } from "./workspace-root-policy";

export function useCanMoveSubagentToWorkspace(
  serverId: string,
  workspaceId: string,
  agentId: string | null,
): boolean {
  const normalizedWorkspaceId = normalizeWorkspaceOpaqueId(workspaceId);
  return useSessionStore((state) => {
    if (!agentId || !serverId || !normalizedWorkspaceId) {
      return false;
    }

    const session = state.sessions[serverId];
    if (session?.serverInfo?.features?.agentMoveToWorkspace !== true) {
      return false;
    }

    const agent = session.agents.get(agentId) ?? session.agentDetails.get(agentId);
    if (
      !agent ||
      agent.archivedAt ||
      !agent.parentAgentId ||
      normalizeWorkspaceOpaqueId(agent.workspaceId) !== normalizedWorkspaceId
    ) {
      return false;
    }

    const parentAgent =
      session.agents.get(agent.parentAgentId) ?? session.agentDetails.get(agent.parentAgentId);
    return !isWorkspaceRootAgent(agent, parentAgent);
  });
}

export function useMoveSubagentToWorkspace(): (address: AgentAddress) => void {
  const toast = useToast();

  return useCallback(
    ({ serverId, agentId: subagentId }: AgentAddress) => {
      void requestMoveSubagentToWorkspace(
        { serverId, subagentId },
        {
          moveAgentToWorkspace: async ({ serverId: targetServerId, agentId, idempotencyKey }) => {
            const client = useSessionStore.getState().sessions[targetServerId]?.client;
            if (!client) {
              throw new Error(i18n.t("workspaceSetup.errors.hostDisconnected"));
            }
            return client.moveAgentToWorkspace(agentId, { idempotencyKey });
          },
          openMovedWorkspace: ({
            serverId: targetServerId,
            workspaceId: targetWorkspaceId,
            agentId,
          }) => {
            navigateToWorkspace({
              serverId: targetServerId,
              workspaceId: targetWorkspaceId,
              target: { kind: "agent", agentId },
            });
          },
          reportError: (error) => {
            toast.error(toErrorMessage(error));
          },
        },
      );
    },
    [toast],
  );
}
