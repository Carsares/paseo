import { join } from "node:path";
import type { Logger } from "pino";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import { DurableItemEvidenceError } from "./evidence.js";
import { DurableItemConflictError, DurableItemStore } from "./store.js";

type DurableItemRequest = Extract<
  SessionInboundMessage,
  { type: "workspace.durable_item.list.request" | "workspace.durable_item.decide.request" }
>;
type DurableItemResponse = Extract<
  SessionOutboundMessage,
  { type: "workspace.durable_item.list.response" | "workspace.durable_item.decide.response" }
>;

export function openDurableItemStore(input: {
  paseoHome: string;
  serverId: string;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  agentStorage: Pick<AgentStorage, "get">;
}): DurableItemStore {
  return new DurableItemStore({
    filePath: join(input.paseoHome, "durable-items", "items.json"),
    serverId: input.serverId,
    getWorkspace: (id) => input.workspaceRegistry.get(id),
    getSourceAgent: (id) => input.agentStorage.get(id),
  });
}

export async function handleDurableItemRequest(
  request: DurableItemRequest,
  context: {
    store: DurableItemStore;
    serverId: string;
    principalId: string;
    logger: Logger;
  },
): Promise<DurableItemResponse> {
  const { type, requestId, ...input } = request;
  if (type === "workspace.durable_item.list.request") {
    try {
      const page = await context.store.list({ ...input, serverId: context.serverId });
      return {
        type: "workspace.durable_item.list.response",
        payload: { requestId, ...page, error: null },
      };
    } catch (error) {
      context.logger.warn({ err: error }, "Failed to list durable items");
      return {
        type: "workspace.durable_item.list.response",
        payload: { requestId, items: [], nextCursor: null, error: "Unable to list durable items." },
      };
    }
  }

  const { workspaceId, durableItemRequestId } = request;
  const reply = { requestId, workspaceId, durableItemRequestId };
  try {
    const item = await context.store.decide({
      workspaceId,
      durableItemRequestId,
      expectedRevision: request.expectedRevision,
      decision: request.decision,
      note: request.note,
      serverId: context.serverId,
      principalId: context.principalId,
    });
    return {
      type: "workspace.durable_item.decide.response",
      payload: { ...reply, item, error: null },
    };
  } catch (error) {
    if (error instanceof DurableItemEvidenceError) {
      return {
        type: "workspace.durable_item.decide.response",
        payload: { ...reply, item: null, error: error.message, errorCode: error.errorCode },
      };
    }
    if (error instanceof DurableItemConflictError) {
      return {
        type: "workspace.durable_item.decide.response",
        payload: { ...reply, item: error.item, error: error.message },
      };
    }
    context.logger.warn({ err: error, workspaceId }, "Failed to decide durable item");
    return {
      type: "workspace.durable_item.decide.response",
      payload: { ...reply, item: null, error: "Unable to decide this durable item." },
    };
  }
}
