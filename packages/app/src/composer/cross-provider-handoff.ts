import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getOpenAgentTabLabel } from "@getpaseo/protocol/agent-labels";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import type { ToastApi } from "@/components/toast-host";
import { useComposerInput, type ComposerInput } from "@/composer/session";
import { useToast } from "@/contexts/toast-api-context";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { buildChatHistoryAttachment } from "@/hooks/use-fork-agent";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useOptionalPaneContext, type PaneContextValue } from "@/panels/pane-context";
import { useHostFeature } from "@/runtime/host-features";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { resolveCloseAgentTabPolicy } from "@/subagents";
import { getOrCreateClientId } from "@/utils/client-id";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceDraftTabSetup,
} from "@/workspace-tabs/model";

export interface CrossProviderHandoffSelection {
  provider: AgentProvider;
  modelId?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  providerOptions?: Record<string, unknown>;
}

export interface CrossProviderAgentHandoff {
  canSwitchProvider: boolean;
  handoffToProvider: (selection: CrossProviderHandoffSelection) => Promise<boolean>;
}

type HandoffPane = Pick<PaneContextValue, "host" | "workspaceId" | "tabId" | "retargetCurrentTab">;

interface CrossProviderHandoffDeps {
  supportsAgentForkContext: boolean;
  client: Pick<DaemonClient, "buildAgentForkContext" | "updateAgent"> | null;
  paneContext: HandoffPane | null;
  inFlight?: { current: boolean };
  getAgent: () => Pick<Agent, "archivedAt" | "cwd" | "parentAgentId" | "status"> | null;
  getComposerInput: () => Pick<ComposerInput, "textSource" | "attachments" | "setText"> | null;
  getDraftStore: () => Pick<
    ReturnType<typeof useDraftStore.getState>,
    | "getDraftInput"
    | "metadataByDraftKey"
    | "saveDraftInput"
    | "patchDraftMetadata"
    | "clearDraftInput"
    | "clearDraftMetadata"
  >;
  getWorkspaceAttachmentsStore: () => Pick<
    ReturnType<typeof useWorkspaceAttachmentsStore.getState>,
    "setWorkspaceAttachments"
  >;
  getWorkspaceLayoutStore: () => Pick<
    ReturnType<typeof useWorkspaceLayoutStore.getState>,
    "unpinAgent" | "hideAgent"
  >;
  confirmDialog: typeof confirmDialog;
  getOrCreateClientId: typeof getOrCreateClientId;
  generateDraftId: typeof generateDraftId;
  archiveAgent: ReturnType<typeof useArchiveAgent>["archiveAgent"];
  toast: Pick<ToastApi, "error">;
  t: (key: string) => string;
}

function isHandoffPane(paneContext: HandoffPane | null): paneContext is HandoffPane {
  return Boolean(paneContext && paneContext.host !== "sheet" && paneContext.workspaceId.trim());
}

export function canSwitchAgentProvider(input: {
  supportsAgentForkContext: boolean;
  client: Pick<DaemonClient, "buildAgentForkContext" | "updateAgent"> | null;
  paneContext: HandoffPane | null;
}): boolean {
  return Boolean(
    input.supportsAgentForkContext && input.client && isHandoffPane(input.paneContext),
  );
}

function moveUnsentDraft(
  input: { sourceDraftKey: string; targetDraftKey: string },
  deps: Pick<CrossProviderHandoffDeps, "getComposerInput" | "getDraftStore">,
): void {
  const { sourceDraftKey, targetDraftKey } = input;
  const composerInput = deps.getComposerInput();
  const draftStore = deps.getDraftStore();
  const storedSourceDraft = draftStore.getDraftInput(sourceDraftKey);
  const unsentText = composerInput?.textSource.getSnapshot() ?? storedSourceDraft?.text ?? "";
  const unsentAttachments = [
    ...(composerInput?.attachments ?? storedSourceDraft?.attachments ?? []),
  ];
  const sourceMetadata = draftStore.metadataByDraftKey[sourceDraftKey];
  if (unsentText.length > 0 || unsentAttachments.length > 0) {
    draftStore.saveDraftInput({
      draftKey: targetDraftKey,
      draft: { text: unsentText, attachments: unsentAttachments },
    });
  }
  if (sourceMetadata && Object.keys(sourceMetadata).length > 0) {
    draftStore.patchDraftMetadata({ draftKey: targetDraftKey, patch: sourceMetadata });
  }
  composerInput?.setText("");
  draftStore.clearDraftInput({ draftKey: sourceDraftKey, lifecycle: "abandoned" });
  draftStore.clearDraftMetadata({ draftKey: sourceDraftKey });
}

function buildHandoffDraftSetup(
  cwd: string,
  selection: CrossProviderHandoffSelection,
): WorkspaceDraftTabSetup {
  return {
    provider: selection.provider,
    cwd,
    modeId: selection.modeId?.trim() || null,
    model: selection.modelId?.trim() || null,
    thinkingOptionId: selection.thinkingOptionId?.trim() || null,
    providerOptions: { ...selection.providerOptions },
  };
}

export async function performCrossProviderAgentHandoff(
  input: { serverId: string; agentId: string; selection: CrossProviderHandoffSelection },
  deps: CrossProviderHandoffDeps,
): Promise<boolean> {
  const { serverId, agentId, selection } = input;
  const { client, inFlight, paneContext, t, toast } = deps;
  if (inFlight?.current) {
    return false;
  }
  if (inFlight) {
    inFlight.current = true;
  }

  try {
    if (!deps.supportsAgentForkContext) {
      toast.error(t("message.actions.forkUnavailable"));
      return false;
    }
    if (!client) {
      toast.error(t("workspace.terminal.hostDisconnected"));
      return false;
    }
    if (!isHandoffPane(paneContext)) {
      return false;
    }

    const agent = deps.getAgent();
    if (!agent || agent.archivedAt) {
      return false;
    }

    let closePolicy = resolveCloseAgentTabPolicy(agent);
    if (
      closePolicy.kind === "archive-on-close" &&
      (agent.status === "running" || agent.status === "initializing")
    ) {
      const confirmed = await deps.confirmDialog({
        title: t("workspace.tabs.confirmations.archiveRunningAgentTitle"),
        message: t("workspace.tabs.confirmations.archiveRunningAgentMessage"),
        confirmLabel: t("workspace.tabs.confirmations.archive"),
        cancelLabel: t("workspace.tabs.confirmations.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return false;
      }
    }

    const payload = await client.buildAgentForkContext(agentId);
    const draftId = deps.generateDraftId();
    const attachment = buildChatHistoryAttachment({
      draftId,
      serverId,
      agentId,
      payload,
      missingAttachmentMessage: t("message.actions.forkFailed"),
    });

    if (closePolicy.kind === "layout-only") {
      const clientId = await deps.getOrCreateClientId();
      await client.updateAgent(agentId, { labels: { [getOpenAgentTabLabel(clientId)]: "false" } });
      closePolicy = resolveCloseAgentTabPolicy(deps.getAgent());
    }

    deps.getWorkspaceAttachmentsStore().setWorkspaceAttachments({
      scopeKey: buildDraftWorkspaceAttachmentScopeKey(draftId),
      attachments: [attachment],
    });

    moveUnsentDraft(
      {
        sourceDraftKey: buildDraftStoreKey({ serverId, agentId }),
        targetDraftKey: buildDraftStoreKey({ serverId, agentId: paneContext.tabId, draftId }),
      },
      deps,
    );

    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId,
      workspaceId: paneContext.workspaceId,
    });
    if (workspaceKey) {
      const layoutStore = deps.getWorkspaceLayoutStore();
      layoutStore.unpinAgent(workspaceKey, agentId);
      layoutStore.hideAgent(workspaceKey, agentId);
    }

    const setup = buildHandoffDraftSetup(agent.cwd, selection);
    paneContext.retargetCurrentTab({ kind: "draft", draftId, setup });

    if (closePolicy.kind === "archive-on-close") {
      void deps.archiveAgent({ serverId, agentId }).catch(() => {});
    }
    return true;
  } catch (error) {
    toast.error(toErrorMessage(error) || t("message.actions.forkFailed"));
    return false;
  } finally {
    if (inFlight) {
      inFlight.current = false;
    }
  }
}

export function useCrossProviderAgentHandoff(input: {
  serverId: string;
  agentId: string;
}): CrossProviderAgentHandoff {
  const { serverId, agentId } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const { archiveAgent } = useArchiveAgent();
  const supportsAgentForkContext = useHostFeature(serverId, "agentForkContext");
  const paneContext = useOptionalPaneContext();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const composerInput = useComposerInput();
  const getComposerInput = useStableEvent(() => composerInput);
  const inFlightRef = useRef(false);
  const canSwitchProvider = canSwitchAgentProvider({
    supportsAgentForkContext,
    client,
    paneContext,
  });

  const handoffToProvider = useStableEvent((selection: CrossProviderHandoffSelection) =>
    performCrossProviderAgentHandoff(
      { serverId, agentId, selection },
      {
        supportsAgentForkContext,
        client,
        paneContext,
        inFlight: inFlightRef,
        getAgent: () => useSessionStore.getState().sessions[serverId]?.agents?.get(agentId) ?? null,
        getComposerInput,
        getDraftStore: useDraftStore.getState,
        getWorkspaceAttachmentsStore: useWorkspaceAttachmentsStore.getState,
        getWorkspaceLayoutStore: useWorkspaceLayoutStore.getState,
        confirmDialog,
        getOrCreateClientId,
        generateDraftId,
        archiveAgent,
        toast,
        t,
      },
    ),
  );

  return { canSwitchProvider, handoffToProvider };
}
