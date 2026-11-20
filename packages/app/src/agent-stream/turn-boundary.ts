import {
  getParentAddressFromLabels,
  resolveAgentHierarchyDepth,
} from "@getpaseo/protocol/agent-labels";
import type { StreamItem, TimelinePosition } from "@/types/stream";

export type AssistantTurnForkBoundary =
  | { boundaryCursor: TimelinePosition; boundaryMessageId?: string }
  | { boundaryCursor?: undefined; boundaryMessageId: string };

export function resolveAssistantTurnForkBoundary(input: {
  items: readonly StreamItem[];
  startIndex: number;
  supportsTimelineCursor: boolean;
}): AssistantTurnForkBoundary | undefined {
  const item = input.items[input.startIndex];
  if (item?.kind !== "assistant_message") {
    return undefined;
  }
  if (input.supportsTimelineCursor && item.timelineCursor) {
    return {
      boundaryCursor: item.timelineCursor,
      ...(item.messageId ? { boundaryMessageId: item.messageId } : {}),
    };
  }
  return item.messageId ? { boundaryMessageId: item.messageId } : undefined;
}

const REMOTE_HIERARCHY_DEPTH_LABEL = "paseo.remote-hierarchy-depth";
const MAX_SUBAGENT_DEPTH = 2;

export interface SubagentSpawnAgentEntry {
  archivedAt?: Date | string | null;
  parentAgentId?: string | null;
  labels?: Record<string, unknown> | null;
}

export interface SubagentSpawnTarget {
  mode: "child" | "sibling";
  parentAgentId: string;
}

export function resolveSubagentSpawnTarget({
  agentId,
  serverId,
  features,
  getAgent,
}: {
  agentId: string;
  serverId: string;
  features?: { agentHierarchyControl?: boolean; agentForkContext?: boolean };
  getAgent: (id: string) => SubagentSpawnAgentEntry | null | undefined;
}): SubagentSpawnTarget | null {
  if (features?.agentHierarchyControl !== true || features?.agentForkContext !== true) {
    return null;
  }

  const current = getAgent(agentId);
  if (!current || current.archivedAt) return null;

  const parentAddress = getParentAddressFromLabels(current.labels, serverId);
  if (parentAddress && parentAddress.serverId !== serverId) return null;

  const currentParentId = parentAddress?.agentId ?? current.parentAgentId?.trim();
  const targetParentId = currentParentId || agentId;
  if (currentParentId) {
    const targetParent = getAgent(targetParentId);
    if (!targetParent || targetParent.archivedAt) return null;
  }

  let remoteDepth = 0;
  const depth = resolveAgentHierarchyDepth(
    targetParentId,
    (id) => {
      const entry = getAgent(id);
      if (entry?.labels?.[REMOTE_HIERARCHY_DEPTH_LABEL] === String(MAX_SUBAGENT_DEPTH)) {
        remoteDepth = MAX_SUBAGENT_DEPTH;
        return null;
      }
      const parent = getParentAddressFromLabels(entry?.labels, serverId);
      if (parent && parent.serverId !== serverId) {
        // Count the remote hop without looking up its ID in the local session.
        remoteDepth = 1;
        return null;
      }
      return parent?.agentId ?? entry?.parentAgentId;
    },
    MAX_SUBAGENT_DEPTH,
  );
  if (depth + remoteDepth >= MAX_SUBAGENT_DEPTH) return null;

  return { mode: currentParentId ? "sibling" : "child", parentAgentId: targetParentId };
}

export function resolveSelectionForkBoundary({
  messageRowId,
  isTurnActive,
  historyItemById,
  liveHeadItemById,
  supportsTimelineCursor,
}: {
  messageRowId: string | null | undefined;
  isTurnActive: boolean;
  historyItemById: ReadonlyMap<string, { item: StreamItem }>;
  liveHeadItemById: ReadonlyMap<string, { item: StreamItem }>;
  supportsTimelineCursor: boolean;
}): AssistantTurnForkBoundary | undefined {
  if (!messageRowId || (isTurnActive && liveHeadItemById.has(messageRowId))) {
    return undefined;
  }
  const row = historyItemById.get(messageRowId) ?? liveHeadItemById.get(messageRowId);
  if (row?.item.kind !== "assistant_message") return undefined;

  return resolveAssistantTurnForkBoundary({
    items: [row.item],
    startIndex: 0,
    supportsTimelineCursor,
  });
}
