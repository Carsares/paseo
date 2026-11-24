import { AgentTurnStartCanceledError } from "../agent/agent-sdk-types.js";
import { z } from "zod";

export const AgentLimitContinuationSchema = z.object({
  serverId: z.string(),
  workspaceId: z.string(),
  workspaceRevision: z.string(),
  turnId: z.string(),
  fingerprint: z.string(),
  messageId: z.string(),
  runAt: z.iso.datetime(),
  status: z.enum(["scheduled", "unknown", "accepted", "cancelled", "failed"]),
});

export type AgentLimitContinuation = z.infer<typeof AgentLimitContinuationSchema>;

export function projectLimitContinuation(state: AgentLimitContinuation | undefined) {
  if (!state) return undefined;
  const { turnId, runAt, status } = state;
  return { turnId, runAt, status };
}

/** The automatic prompt was withdrawn before reaching the provider. */
export class AgentLimitContinuationWithdrawnError extends AgentTurnStartCanceledError {
  constructor(message: string, options?: ErrorOptions) {
    super();
    this.name = "AgentLimitContinuationWithdrawnError";
    this.message = message;
    this.cause = options?.cause;
  }
}
