import type { SetAgentLimitRecoveryParameters } from "@getpaseo/client";
import type { Agent } from "@/stores/session-store";
import type { WorkspaceDeferralTarget } from "./operations";

export interface AgentRecoveryTarget extends WorkspaceDeferralTarget {
  agentId: string;
}

type RecoveryAction = SetAgentLimitRecoveryParameters["action"];

export function selectAgentLimitRecovery(
  agent: Agent | undefined,
  target: AgentRecoveryTarget,
  now: number,
) {
  if (
    !agent ||
    agent.serverId !== target.serverId ||
    agent.id !== target.agentId ||
    agent.workspaceId !== target.workspaceId ||
    agent.archivedAt ||
    agent.status === "closed"
  )
    return null;

  const limit = agent.conversationLimit;
  const continuation = agent.rateLimitContinuation;
  // At provider handoff the host may clear the failed-turn evidence before it
  // knows whether the continuation was accepted.
  if (continuation?.status === "unknown" && (!limit || continuation.turnId === limit.turnId)) {
    return {
      turnId: continuation.turnId,
      time: continuation.runAt,
      state: continuation.status,
      actions: [] as RecoveryAction[],
    };
  }
  // Conversation limit evidence is scoped to the most recent real failed turn by the host.
  if (!limit || !agent.lastError || agent.turn.phase !== "idle") return null;
  if (continuation?.turnId === limit.turnId) {
    const actions: RecoveryAction[] = [];
    if (continuation.status === "scheduled") actions.push("cancel");
    return { turnId: limit.turnId, time: continuation.runAt, state: continuation.status, actions };
  }

  if (!(Date.parse(limit.resetsAt) > now)) return null;
  const actions: RecoveryAction[] = ["sleep", "continue"];
  return { turnId: limit.turnId, time: limit.resetsAt, state: "limited" as const, actions };
}
