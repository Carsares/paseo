import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  isResidentAgent,
  isSideChatAgent,
  SIDE_OF_AGENT_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { Agent } from "@/stores/session-store";

export function isSideChat(agent: Partial<Pick<Agent, "labels">> | null | undefined): boolean {
  return !!agent && isSideChatAgent(agent);
}

export function getSideChatSourceAgentId(agent: Agent | null | undefined): string | null {
  return isSideChat(agent) ? agent?.labels[SIDE_OF_AGENT_ID_LABEL]?.trim() || null : null;
}

export async function discardSideChatIfEmpty(input: {
  agent: Pick<Agent, "id" | "lastUserMessageAt">;
  client: Pick<DaemonClient, "deleteAgent"> | null;
  supportsSideChat: boolean;
}): Promise<void> {
  if (!input.supportsSideChat || !input.client || input.agent.lastUserMessageAt) return;
  try {
    await input.client.deleteAgent(input.agent.id, { onlyIfEmptySideChat: true });
  } catch (error) {
    // A first question admitted in another window wins over closing this tab.
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      error.code === "side_chat_not_empty"
    ) {
      return;
    }
    throw error;
  }
}

export type CloseAgentTabPolicy =
  | { kind: "archive-on-close" }
  | { kind: "layout-only" }
  | { kind: "side-chat" };

export function resolveCloseAgentTabPolicy(
  agent: (Pick<Agent, "parentAgentId"> & Partial<Pick<Agent, "labels">>) | null | undefined,
): CloseAgentTabPolicy {
  if (isSideChat(agent)) {
    return { kind: "side-chat" };
  }
  if (agent && (agent.parentAgentId || isResidentAgent(agent))) {
    return { kind: "layout-only" };
  }

  return { kind: "archive-on-close" };
}
