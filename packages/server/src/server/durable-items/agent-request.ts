import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentManager } from "../agent/agent-manager.js";
import type { DurableItemStore } from "./store.js";

const evidencePath = z.string().min(1).max(4096);
const evidenceTarget = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("file"), path: evidencePath }),
  z.strictObject({ type: z.literal("git"), repoRoot: evidencePath, path: evidencePath }),
]);

export const agentDurableItemRequestSchema = z
  .strictObject({
    kind: z.enum(["decision", "acceptance"]),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(4000).optional(),
    evidence: z
      .array(evidenceTarget)
      .max(16)
      .describe("File paths in your workspace or Git paths relative to their repository."),
  })
  .refine(({ kind, evidence }) => kind !== "acceptance" || evidence.length > 0, {
    message: "Acceptance requests require at least one evidence path.",
    path: ["evidence"],
  });

export async function requestDurableItemFromAgent({
  store,
  serverId,
  agentManager,
  callerAgentId,
  verifiedCallerAgentId,
  input,
}: {
  store: DurableItemStore;
  serverId: string;
  agentManager: Pick<AgentManager, "getAgent" | "isTaskAgentArchivePending">;
  callerAgentId?: string;
  verifiedCallerAgentId?: string;
  input: z.infer<typeof agentDurableItemRequestSchema>;
}) {
  if (!callerAgentId || callerAgentId !== verifiedCallerAgentId) {
    throw new Error("Human decision requests require a verified agent identity.");
  }

  const readSource = () => {
    const agent = agentManager.getAgent(callerAgentId);
    const sourceTurnId = agent?.activeForegroundTurnId ?? agent?.activeTurnId;
    if (
      !agent?.workspaceId ||
      agent.lifecycle === "closed" ||
      agent.internal ||
      agent.background ||
      agentManager.isTaskAgentArchivePending(callerAgentId) ||
      !sourceTurnId
    ) {
      throw new Error("Human decision requests require an active turn in the caller's workspace.");
    }
    return { workspaceId: agent.workspaceId, sourceTurnId };
  };
  const source = readSource();

  return store.create(
    { ...input, ...source, serverId, sourceAgentId: callerAgentId, requestId: randomUUID() },
    () => {
      const latest = readSource();
      if (
        latest.workspaceId !== source.workspaceId ||
        latest.sourceTurnId !== source.sourceTurnId
      ) {
        throw new Error("The caller's workspace or active turn changed while capturing evidence.");
      }
    },
  );
}
