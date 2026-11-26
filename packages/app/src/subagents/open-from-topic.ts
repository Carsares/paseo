import { buildTopicAgentKey, useTopicStreamViewStore } from "@/stores/topic-stream-view-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openWorkspaceTargetAtLocation } from "@/workspace-tabs/open-beside";

export interface OpenSubagentFromTopicInput {
  serverId: string;
  workspaceId: string;
  targetServerId?: string;
  targetAgentId: string;
  mainAgentId?: string | null;
  topicKey?: string;
  taskId?: string;
  rootMessageId?: string;
  promptPreview?: string;
  parentTabId?: string | null;
  location?: "side" | "main";
}

/**
 * Unified split-open entry used by topic cards, collaboration rows, task ledger rows, and
 * team directory members. Records a return-to-topic anchor so the specialist header/callout can
 * restore the user back to the originating topic card on desktop or compact layouts.
 */
export function openSubagentFromTopic(input: OpenSubagentFromTopicInput): string | null {
  const destinationServerId = input.targetServerId ?? input.serverId;
  if (input.mainAgentId && input.topicKey) {
    const subagentKey = buildTopicAgentKey(destinationServerId, input.targetAgentId);
    useTopicStreamViewStore.getState().setReturnTopicAnchor(subagentKey, {
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      mainAgentId: input.mainAgentId,
      topicKey: input.topicKey,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.rootMessageId ? { rootMessageId: input.rootMessageId } : {}),
      promptPreview: input.promptPreview?.trim() || "",
    });
  }

  if (destinationServerId === input.serverId && input.workspaceId) {
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: input.serverId,
      workspaceId: input.workspaceId,
    });
    if (workspaceKey) {
      return openWorkspaceTargetAtLocation({
        workspaceKey,
        target: { kind: "agent", agentId: input.targetAgentId },
        location: input.location ?? "side",
        parentTabId: input.parentTabId,
      });
    }
  }

  navigateToAgent({
    serverId: destinationServerId,
    agentId: input.targetAgentId,
    workspaceId: destinationServerId === input.serverId ? input.workspaceId : undefined,
    asTab: true,
  });
  return null;
}

/** Navigates from a subagent back to its originating topic card and restores scroll focus. */
export function returnFromSubagentToTopic(serverId: string, subagentId: string): boolean {
  const store = useTopicStreamViewStore.getState();
  const subagentKey = buildTopicAgentKey(serverId, subagentId);
  const anchor = store.returnTopicAnchorByAgentKey[subagentKey];
  if (!anchor) return false;

  const mainKey = buildTopicAgentKey(anchor.serverId, anchor.mainAgentId);
  store.setViewMode(mainKey, "topics");
  store.requestScrollToTopic(mainKey, anchor.topicKey, true, {
    taskId: anchor.taskId,
    rootMessageId: anchor.rootMessageId,
  });
  store.setReturnTopicAnchor(subagentKey, null);

  navigateToAgent({
    serverId: anchor.serverId,
    agentId: anchor.mainAgentId,
    workspaceId: anchor.workspaceId,
    asTab: true,
  });
  return true;
}
