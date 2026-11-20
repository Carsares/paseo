import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useQueryClient } from "@tanstack/react-query";
import { getOpenAgentTabLabel, isMainControlAgent } from "@getpaseo/protocol/agent-labels";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import type { ToastApi } from "@/components/toast-host";
import { useComposerInput, type ComposerInput } from "@/composer/session";
import { useToast } from "@/contexts/toast-api-context";
import type { DraftComposerTextSource } from "@/composer/draft/input-draft";
import { applyArchivedAgentCloseResults, type ArchiveAgentInput } from "@/hooks/use-archive-agent";
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
type HandoffAgent = Pick<
  Agent,
  "archivedAt" | "cwd" | "labels" | "parentAgentId" | "status" | "workspaceId"
>;

interface CrossProviderHandoffDeps {
  supportsAgentForkContext: boolean;
  client: Pick<DaemonClient, "buildAgentForkContext" | "updateAgent"> | null;
  paneContext: HandoffPane | null;
  inFlight?: { current: boolean };
  getAgent: () => HandoffAgent | null;
  getComposerInput: () =>
    | (Pick<ComposerInput, "attachments" | "setText"> & {
        textSource: ComposerInput["textSource"] & Partial<DraftComposerTextSource>;
      })
    | null;
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
    "getWorkspaceTabs" | "unpinAgent" | "hideAgent"
  >;
  confirmDialog: typeof confirmDialog;
  getOrCreateClientId: typeof getOrCreateClientId;
  generateDraftId: typeof generateDraftId;
  archiveAgent: (input: ArchiveAgentInput) => Promise<void>;
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
  agent: Pick<Agent, "labels"> | null;
}): boolean {
  return Boolean(
    input.supportsAgentForkContext &&
    input.client &&
    isHandoffPane(input.paneContext) &&
    input.agent &&
    !isMainControlAgent(input.agent),
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
  const unsentText =
    composerInput?.textSource.peekPendingText?.() ??
    composerInput?.textSource.getSnapshot() ??
    storedSourceDraft?.text ??
    "";
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
  draftStore.clearDraftInput({ draftKey: sourceDraftKey, lifecycle: "abandoned" });
  draftStore.clearDraftMetadata({ draftKey: sourceDraftKey });
  composerInput?.setText("");
}

function buildHandoffDraftSetup(
  agent: Pick<HandoffAgent, "cwd" | "parentAgentId">,
  selection: CrossProviderHandoffSelection,
): WorkspaceDraftTabSetup {
  const parentAgentId = agent.parentAgentId?.trim();
  return {
    provider: selection.provider,
    cwd: agent.cwd,
    ...(parentAgentId ? { parentAgentId } : {}),
    modeId: selection.modeId?.trim() || null,
    model: selection.modelId?.trim() || null,
    thinkingOptionId: selection.thinkingOptionId?.trim() || null,
    providerOptions: { ...selection.providerOptions },
  };
}

async function closeHandoffSource(input: {
  getCurrentAgent: (allowArchived?: boolean) => HandoffAgent | null;
  confirmArchive: () => Promise<boolean>;
  needsArchiveConfirmation: (agent: HandoffAgent) => boolean;
  confirmedArchive: boolean;
  getClientId: () => Promise<string>;
  releaseTabLabel: (clientId: string) => Promise<void>;
  archiveAgent: () => Promise<void>;
  commit: (agent: HandoffAgent) => void;
}): Promise<boolean> {
  let { confirmedArchive } = input;
  let clientId: string | null = null;
  let releasedTabLabel = false;
  // Recheck the target and close policy after each wait.
  while (true) {
    const agent = input.getCurrentAgent();
    if (!agent) return false;
    const closePolicy = resolveCloseAgentTabPolicy(agent);
    if (closePolicy.kind === "layout-only") {
      if (releasedTabLabel) {
        input.commit(agent);
        return true;
      }
      if (clientId === null) {
        clientId = await input.getClientId();
        continue;
      }
      await input.releaseTabLabel(clientId);
      releasedTabLabel = true;
      continue;
    }
    if (!confirmedArchive && input.needsArchiveConfirmation(agent)) {
      confirmedArchive = await input.confirmArchive();
      if (!confirmedArchive) return false;
      continue;
    }
    await input.archiveAgent();
    // The archive can mark the source archived during the wait. Its tab and workspace must match.
    const archivedSource = input.getCurrentAgent(true);
    if (!archivedSource) return false;
    input.commit(archivedSource);
    return true;
  }
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

    const workspaceId = paneContext.workspaceId.trim();
    const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
    if (!workspaceKey) {
      return false;
    }

    const getCurrentAgent = (allowArchived = false): HandoffAgent | null => {
      const tab = deps
        .getWorkspaceLayoutStore()
        .getWorkspaceTabs(workspaceKey)
        .find((candidate) => candidate.tabId === paneContext.tabId);
      if (tab?.target.kind !== "agent" || tab.target.agentId !== agentId) return null;
      const current = deps.getAgent();
      if (
        !current ||
        (!allowArchived && current.archivedAt) ||
        current.workspaceId?.trim() !== workspaceId ||
        isMainControlAgent(current)
      )
        return null;
      return current;
    };
    const needsArchiveConfirmation = (agent: HandoffAgent) =>
      resolveCloseAgentTabPolicy(agent).kind === "archive-on-close" &&
      (agent.status === "running" || agent.status === "initializing");
    const confirmArchive = () =>
      deps.confirmDialog({
        title: t("workspace.tabs.confirmations.archiveRunningAgentTitle"),
        message: t("workspace.tabs.confirmations.archiveRunningAgentMessage"),
        confirmLabel: t("workspace.tabs.confirmations.archive"),
        cancelLabel: t("workspace.tabs.confirmations.cancel"),
        destructive: true,
      });

    const sourceAgent = getCurrentAgent();
    if (!sourceAgent) return false;
    let confirmedArchive = false;
    if (needsArchiveConfirmation(sourceAgent)) {
      confirmedArchive = await confirmArchive();
      if (!confirmedArchive || !getCurrentAgent()) return false;
    }

    const payload = await client.buildAgentForkContext(agentId);
    if (!getCurrentAgent()) return false;
    const draftId = deps.generateDraftId();
    const attachment = buildChatHistoryAttachment({
      draftId,
      serverId,
      agentId,
      payload,
      missingAttachmentMessage: t("message.actions.forkFailed"),
    });

    return await closeHandoffSource({
      getCurrentAgent,
      needsArchiveConfirmation,
      confirmArchive,
      confirmedArchive,
      getClientId: deps.getOrCreateClientId,
      releaseTabLabel: async (clientId) => {
        await client.updateAgent(agentId, {
          labels: { [getOpenAgentTabLabel(clientId)]: "false" },
        });
      },
      archiveAgent: () => deps.archiveAgent({ serverId, agentId }),
      commit: (agent) => {
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
        const layoutStore = deps.getWorkspaceLayoutStore();
        layoutStore.unpinAgent(workspaceKey, agentId);
        layoutStore.hideAgent(workspaceKey, agentId);
        const setup = buildHandoffDraftSetup(agent, selection);
        paneContext.retargetCurrentTab({ kind: "draft", draftId, setup });
      },
    });
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
  const queryClient = useQueryClient();
  const supportsAgentForkContext = useHostFeature(serverId, "agentForkContext");
  const paneContext = useOptionalPaneContext();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const agentLabels = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.labels,
  );
  const composerInput = useComposerInput();
  const getComposerInput = useStableEvent(() => composerInput);
  const inFlightRef = useRef(false);
  const canSwitchProvider = canSwitchAgentProvider({
    supportsAgentForkContext,
    client,
    paneContext,
    agent: agentLabels ? { labels: agentLabels } : null,
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
        archiveAgent: async (target) => {
          if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
          const { archivedAt } = await client.archiveAgent(target.agentId);
          applyArchivedAgentCloseResults({
            queryClient,
            serverId: target.serverId,
            results: [{ agentId: target.agentId, archivedAt }],
          });
        },
        toast,
        t,
      },
    ),
  );

  return { canSwitchProvider, handoffToProvider };
}
