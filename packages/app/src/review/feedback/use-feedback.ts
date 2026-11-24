import { createElement, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  useReviewDraftComments,
  getReviewDraftComments,
  clearSentReviewDraftComments,
} from "../store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { deriveWorkspaceTabModel } from "@/screens/workspace/workspace-tab-model";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useFetchQuery } from "@/data/query";
import { useAppSettings } from "@/hooks/use-settings";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { useSessionStore, selectAgentTurnPresentation } from "@/stores/session-store";
import { FLOATING_ACTION_BUTTON_CLEARANCE } from "@/components/ui/floating-action-button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { controlHeightForLayout } from "@/components/ui/control-geometry";
import { SPACING } from "@/styles/theme";
import { i18n } from "@/i18n/i18next";
import {
  createReviewFeedbackScope,
  type FeedbackAttachment,
  type FeedbackRecipient,
} from "./index";
import { useToast } from "@/contexts/toast-context";
import { FeedbackSentMessage } from "./surface";
import { selectWorkspaceAgentRecipients, type WorkspaceRecipientScope } from "./recipients";

const feedbackScope = createReviewFeedbackScope();

export function useReviewFeedback(input: {
  reviewDraftKey: string;
  serverId: string;
  workspaceId?: string;
  attachment: FeedbackAttachment | null;
}) {
  const { serverId, reviewDraftKey, workspaceId } = input;
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const workspaceKey = workspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId })
    : null;
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const { settings } = useAppSettings();
  const comments = useReviewDraftComments(reviewDraftKey);
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const supportsStaging = useHostFeature(serverId, "checkoutGitStagingV1");
  const supportsTopic = useHostFeature(serverId, "topicWorkbenchV1");
  const topic = useFetchQuery({
    queryKey: ["review-workspace-topic", serverId, workspaceId],
    dataShape: "value",
    staleTimeMs: 30_000,
    enabled: Boolean(
      supportsStaging && supportsTopic && connected && client && workspaceId && comments?.length,
    ),
    retry: false,
    queryFn: async () => {
      if (!client || !workspaceId) return null;
      return (await client.findWorkspace(workspaceId))?.topic ?? null;
    },
  }).data;
  const topicMainAgentId = topic?.mainAgentId;
  const waitingForTopic = supportsTopic && topic === undefined;
  const recipientScope = useMemo<WorkspaceRecipientScope | "tabs" | "loading">(() => {
    if (!supportsStaging) return "tabs";
    if (waitingForTopic) return "loading";
    if (supportsTopic && topicMainAgentId !== undefined)
      return { kind: "topic", mainAgentId: topicMainAgentId };
    return { kind: "legacy" };
  }, [supportsStaging, supportsTopic, waitingForTopic, topicMainAgentId]);
  const layout = useWorkspaceLayoutStore((store) =>
    workspaceKey ? store.layoutByWorkspace[workspaceKey] : undefined,
  );
  // The adapter keeps live host and diff inputs available to commands without reconstructing the workflow.
  const live = useRef({
    client,
    connected,
    attachment: input.attachment,
    recipientScope,
    sendBehavior: settings.sendBehavior,
    toast,
  });
  live.current = {
    client,
    connected,
    attachment: input.attachment,
    recipientScope,
    sendBehavior: settings.sendBehavior,
    toast,
  };
  const model = useMemo(
    () =>
      feedbackScope.connect(reviewDraftKey, {
        read: () => ({
          comments: getReviewDraftComments(reviewDraftKey) ?? [],
          attachment: live.current.attachment,
          connected: live.current.connected,
          recipients: readRecipients(
            serverId,
            workspaceId,
            workspaceKey,
            live.current.recipientScope,
          ),
        }),
        send: async (recipient, attachment) => {
          const { client: targetClient, sendBehavior } = live.current;
          if (!targetClient) throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
          const activeTurnBehavior = sendBehavior === "steer" ? "steer" : "interrupt";
          await dispatchComposerAgentMessage({
            client: targetClient,
            agentId: recipient.agentId,
            text: i18n.t("review.feedback.prompt"),
            attachments: [attachment],
            encodeImages: async () => [],
            submission: createMessageSubmissionWriter(serverId),
            activeTurnBehavior,
            activeTurnId:
              activeTurnBehavior === "steer"
                ? (selectAgentTurnPresentation(
                    useSessionStore.getState().sessions[serverId],
                    recipient.agentId,
                  ).turnId ?? undefined)
                : undefined,
          });
          live.current.toast.show(
            createElement(FeedbackSentMessage, {
              recipient,
              serverId,
              workspaceId: workspaceId ?? "",
            }),
            { variant: "success" },
          );
        },
        clearSent: (sentComments) =>
          clearSentReviewDraftComments({ key: reviewDraftKey, comments: sentComments }),
        failedMessage: () => i18n.t("review.feedback.failed"),
      }),
    [reviewDraftKey, serverId, workspaceKey, workspaceId],
  );
  useEffect(() => {
    model.refresh();
  }, [model, comments, layout, agents, connected, input.attachment, recipientScope]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  return {
    model,
    state,
    clearance:
      state.commentCount > 0
        ? (isCompact
            ? FLOATING_ACTION_BUTTON_CLEARANCE
            : controlHeightForLayout("md", isCompact) + SPACING[4]) + 44
        : 0,
  };
}

function readRecipients(
  serverId: string,
  workspaceId: string | undefined,
  workspaceKey: string | null,
  scope: WorkspaceRecipientScope | "tabs" | "loading",
): FeedbackRecipient[] {
  if (!workspaceId || !workspaceKey || scope === "loading") return [];
  const tabs = useWorkspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey);
  const descriptors = deriveWorkspaceTabModel({ tabs }).tabs.map(({ descriptor }) => descriptor);
  if (scope === "tabs") {
    return descriptors.flatMap((tab) =>
      tab.target.kind === "agent" ? [{ agentId: tab.target.agentId, tab }] : [],
    );
  }
  const descriptorsById = new Map(descriptors.map((tab) => [tab.tabId, tab]));
  const agents = useSessionStore.getState().sessions[serverId]?.agents;
  return selectWorkspaceAgentRecipients({
    serverId,
    workspaceId,
    scope,
    agents: agents?.values() ?? [],
    tabs,
  }).flatMap((recipient) => {
    if (recipient.kind !== "agent") return [];
    const agentId = recipient.agent.id;
    const existing = recipient.tab && descriptorsById.get(recipient.tab.tabId);
    return [
      {
        agentId,
        tab: existing || {
          key: "review-recipient:" + agentId,
          tabId: "review-recipient:" + agentId,
          kind: "agent",
          target: { kind: "agent", agentId },
        },
      },
    ];
  });
}
