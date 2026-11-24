import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import { AgentTurnStartRejectedError, type AgentUsage } from "../agent-sdk-types.js";

// No provider-wide threshold is available. Leave 20% for the next prompt and response.
export const TASK_REUSE_CONTEXT_THRESHOLD = 0.8;

export function isLocalTaskChild(
  labels: Record<string, string> | undefined,
  callerId: string,
  serverId: string,
): boolean {
  const parent = getParentAddressFromLabels(labels, serverId);
  return parent?.serverId === serverId && parent.agentId === callerId;
}

export function isTaskParticipantAddress(
  participant: { serverId?: string; boundBy?: string },
  callerId: string,
  serverId: string,
) {
  return (
    (participant.serverId === undefined || participant.serverId === serverId) &&
    (participant.boundBy === undefined || participant.boundBy === callerId)
  );
}

export class TaskDispatchRejectedError extends AgentTurnStartRejectedError {}

const reasons = {
  idle: "Idle",
  resumable: "Closed, can reopen",
  busy: "Busy, wait or interrupt",
  session_error: "Session error, reset required",
  context_limit: `Context at or above ${TASK_REUSE_CONTEXT_THRESHOLD * 100}%, reset required`,
  archived: "Archived",
  missing: "Agent not found",
  not_direct_child: "Not a local direct child",
  different_workspace: "Agent moved to another workspace",
  provider_unavailable: "Provider unavailable",
  provider_unconfirmed: "Provider cannot confirm task dispatch",
} as const;

type ReuseReason = keyof typeof reasons;
type ReuseAction = "reuse" | "wait" | "reset" | "unavailable";

export interface TaskReuseState {
  lifecycle: string;
  busy?: boolean;
  archived?: boolean;
  providerUnavailable?: boolean;
  providerCanConfirmPrompt?: boolean;
  lastUsage?: AgentUsage;
  resetEpoch?: number;
  consecutiveErrors?: number;
  lastTurnCompletedAt?: string;
}

function inspectContext(usage?: AgentUsage) {
  const used = usage?.contextWindowUsedTokens;
  const max = usage?.contextWindowMaxTokens;
  if (
    used === undefined ||
    !Number.isFinite(used) ||
    used < 0 ||
    max === undefined ||
    !Number.isFinite(max) ||
    max <= 0
  )
    return undefined;
  return { usedTokens: used, maxTokens: max, threshold: TASK_REUSE_CONTEXT_THRESHOLD };
}

export function taskReuseDecision(state?: TaskReuseState, unavailable?: ReuseReason) {
  const context = inspectContext(state?.lastUsage);
  function result(action: ReuseAction, reason: ReuseReason) {
    return {
      action,
      reason,
      description: reasons[reason],
      ...(state && { resetEpoch: state.resetEpoch ?? 0 }),
      ...(state && { context: context ?? { threshold: TASK_REUSE_CONTEXT_THRESHOLD } }),
      ...(state?.lastTurnCompletedAt && { lastTurnCompletedAt: state.lastTurnCompletedAt }),
    };
  }
  if (unavailable) return result("unavailable", unavailable);
  if (!state) return result("unavailable", "missing");
  if (state.archived) return result("unavailable", "archived");
  if (state.providerUnavailable) return result("unavailable", "provider_unavailable");
  if (state.providerCanConfirmPrompt === false)
    return result("unavailable", "provider_unconfirmed");
  if (state.lifecycle === "error" || (state.consecutiveErrors ?? 0) > 0)
    return result("reset", "session_error");
  if (context && context.usedTokens >= context.maxTokens * context.threshold)
    return result("reset", "context_limit");
  if (state.busy || state.lifecycle === "initializing" || state.lifecycle === "running")
    return result("wait", "busy");
  return result("reuse", state.lifecycle === "closed" ? "resumable" : "idle");
}

export type TaskReuseDecision = ReturnType<typeof taskReuseDecision>;
