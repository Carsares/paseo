import { randomUUID } from "node:crypto";
import type { TopicThreadEntry, WorkspaceDurableItem } from "@getpaseo/protocol/messages";
import { z } from "zod";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { taskEvent } from "../agent/task-ledger/events.js";
import type { WorkspaceTask } from "../agent/task-ledger/index.js";
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

interface DurableItemSource {
  workspaceId: string;
  sourceTurnId: string;
}

type DurableItemTopic = Pick<WorkspaceDurableItem, "taskId" | "topicKey" | "rootMessageId">;

export interface PendingDurableItemTaskBinding {
  messageId: string;
  agentId: string;
  workspaceId: string;
  taskId: string;
  rootMessageId?: string;
}

interface DurableItemTurnTopic {
  agentId: string;
  resetEpoch?: number;
  messageIds: ReadonlySet<string>;
  pendingBindings?: readonly PendingDurableItemTaskBinding[];
  tasks: readonly WorkspaceTask[];
  entries: readonly TopicThreadEntry[];
}

const projectedAgentMessagePrefix = "paseo-agent-message:";

export function readDurableItemTurnMessageIds(rows: readonly AgentTimelineRow[], turnId: string) {
  const messageIds = new Set<string>();
  for (const { item, turnId: rowTurn, providerMessageId } of rows) {
    if (rowTurn !== turnId) continue;
    if (item.type === "user_message") {
      for (const id of [item.messageId, item.clientMessageId, providerMessageId]) {
        if (id) messageIds.add(id);
      }
    } else if (
      item.type === "tool_call" &&
      item.agentMessage?.event === "message" &&
      item.callId.startsWith(projectedAgentMessagePrefix)
    ) {
      messageIds.add(item.callId.slice(projectedAgentMessagePrefix.length));
    }
  }
  return messageIds;
}

export function resolveDurableItemTurnTopic({
  agentId,
  resetEpoch,
  messageIds,
  pendingBindings = [],
  tasks,
  entries,
}: DurableItemTurnTopic): DurableItemTopic | undefined {
  const followups = entries.filter(
    (entry) =>
      entry.role === "user_followup" &&
      entry.routedAgentId === agentId &&
      (messageIds.has(entry.entryId) ||
        (entry.sourceMessageId && messageIds.has(entry.sourceMessageId))),
  );
  if (followups.length > 0) {
    const [entry] = followups;
    if (followups.length !== 1) return;
    const { taskId, topicKey, rootMessageId } = entry;
    return { taskId, topicKey, rootMessageId };
  }
  const dispatchIds = new Set(
    [...messageIds].map((id) => taskEvent(agentId, "dispatched", resetEpoch, undefined, id, 0).id),
  );
  const candidates = new Map(
    tasks
      .filter((task) =>
        task.events?.some(({ kind, id }) => kind === "dispatched" && dispatchIds.has(id)),
      )
      .map((task) => [task.taskId, task.rootMessageId]),
  );
  for (const binding of pendingBindings) {
    if (
      binding.agentId === agentId &&
      messageIds.has(binding.messageId) &&
      !candidates.has(binding.taskId)
    )
      candidates.set(binding.taskId, binding.rootMessageId);
  }
  if (candidates.size !== 1) return;
  const [[taskId, rootMessageId]] = candidates;
  return { taskId, topicKey: `task:${taskId}`, rootMessageId };
}

export async function requestDurableItemFromAgent({
  store,
  serverId,
  agentManager,
  callerAgentId,
  verifiedCallerAgentId,
  input,
  resolveTopic,
}: {
  store: DurableItemStore;
  serverId: string;
  agentManager: Pick<AgentManager, "getAgent" | "isTaskAgentArchivePending">;
  callerAgentId?: string;
  verifiedCallerAgentId?: string;
  input: z.infer<typeof agentDurableItemRequestSchema>;
  resolveTopic?: (source: DurableItemSource) => Promise<DurableItemTopic | undefined>;
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
  const topic = await resolveTopic?.(source);

  return store.create(
    {
      ...input,
      ...source,
      ...topic,
      serverId,
      sourceAgentId: callerAgentId,
      requestId: randomUUID(),
    },
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
