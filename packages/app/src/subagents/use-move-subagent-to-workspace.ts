import type { AgentAddress } from "@getpaseo/protocol/addresses";
import { useCallback, useMemo } from "react";
import { useToast } from "@/contexts/toast-context";
import { i18n } from "@/i18n/i18next";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import {
  createCanMoveSubagentToWorkspaceSelector,
  requestMoveSubagentToWorkspace,
} from "./move-subagent-to-workspace";

export function useCanMoveSubagentToWorkspace(
  serverId: string,
  workspaceId: string,
  agentId: string | null,
): boolean {
  const normalizedWorkspaceId = normalizeWorkspaceOpaqueId(workspaceId);
  const selectCanMove = useMemo(
    () =>
      createCanMoveSubagentToWorkspaceSelector({
        serverId,
        workspaceId: normalizedWorkspaceId,
        agentId,
      }),
    [agentId, normalizedWorkspaceId, serverId],
  );
  return useSessionStore(selectCanMove);
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
