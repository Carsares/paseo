import { useFetchQuery } from "@/data/query";
import { useMemo } from "react";
import { isMainControlAgent } from "@getpaseo/protocol/agent-labels";
import { createQuoteAttachment } from "@/attachments/quote";
import type { ComposerQuote } from "@/assistant-selection-copy/composer-quote";
import { isHandoffInputLocked } from "@/composer/handoff-input-lock";
import { resolveTopicFirstQuestionDraftId } from "@/composer/draft/workspace-main-intent";
import { usePaneContext } from "@/panels/pane-context";
import { selectWorkspaceAgentRecipients } from "@/review/feedback/recipients";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { buildDraftStoreKey, buildNewWorkspaceDraftKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

export function useGraphRecipients(enabled: boolean) {
  const { serverId, workspaceId, openTab } = usePaneContext();
  const client = useHostRuntimeClient(serverId);
  const supportsTopic = useHostFeature(serverId, "topicWorkbenchV1");
  const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const layout = useWorkspaceLayoutStore((state) =>
    key ? state.layoutByWorkspace[key] : undefined,
  );
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const descriptor = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    enabled: enabled && supportsTopic && !!client,
    queryKey: ["git-graph-recipient-workspace", serverId, workspaceId],
    queryFn: () => client!.findWorkspace(workspaceId),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const topic = descriptor.data?.topic;
  const recipients = useMemo(() => {
    if (!enabled || (supportsTopic && descriptor.data === undefined)) return [];
    const tabs = key && layout ? useWorkspaceLayoutStore.getState().getWorkspaceTabs(key) : [];
    return selectWorkspaceAgentRecipients({
      serverId,
      workspaceId,
      agents: agents?.values() ?? [],
      tabs,
      scope: topic ? { kind: "topic", mainAgentId: topic.mainAgentId } : { kind: "legacy" },
    }).flatMap((recipient) => {
      if (recipient.kind !== "agent") return [];
      const { agent } = recipient;
      const isMain = topic?.mainAgentId === agent.id || isMainControlAgent(agent);
      return [
        {
          id: agent.id,
          title: agent.title?.trim() || agent.id,
          isMain,
        },
      ];
    });
  }, [agents, descriptor.data, enabled, key, layout, serverId, supportsTopic, topic, workspaceId]);

  async function appendDraft(quote: ComposerQuote, agentId: string | null, prompt?: string) {
    const draftId =
      agentId === null ? await resolveTopicFirstQuestionDraftId(serverId, workspaceId) : null;
    const draftKey = draftId
      ? buildNewWorkspaceDraftKey(draftId)
      : buildDraftStoreKey({ serverId, agentId: agentId! });
    const attachment = createQuoteAttachment({ text: quote.quote, label: quote.label });
    await useDraftStore.getState().hydrateDraftInput({ draftKey });
    if (agentId !== null && isHandoffInputLocked(serverId, agentId)) return false;
    useDraftStore.getState().updateDraftInput({
      draftKey,
      update: (current) => ({
        ...current,
        text: prompt ? [current.text, prompt].filter(Boolean).join("\n\n") : current.text,
        attachments: [...current.attachments, attachment],
      }),
    });
    if (draftId) openTab({ kind: "draft", draftId });
    else if (agentId) openTab({ kind: "agent", agentId });
    return true;
  }

  return { recipients, appendDraft, unbound: topic?.mainAgentId === null };
}
