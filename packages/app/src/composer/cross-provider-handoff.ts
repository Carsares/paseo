import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { DaemonConnectionError, type DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useQueryClient } from "@tanstack/react-query";
import { getOpenAgentTabLabel, isMainControlAgent } from "@getpaseo/protocol/agent-labels";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import {
  isWorkspaceAttachment,
  userAttachmentsOnly,
} from "@/attachments/workspace-attachment-utils";
import type { ToastApi } from "@/components/toast-host";
import type { QueuedComposerMessage } from "@/composer/actions";
import { useComposerInput, type ComposerInput } from "@/composer/session";
import { useToast } from "@/contexts/toast-api-context";
import type { DraftComposerTextSource } from "@/composer/draft/input-draft";
import { applyArchivedAgentCloseResults, type ArchiveAgentInput } from "@/hooks/use-archive-agent";
import { buildChatHistoryAttachment } from "@/hooks/use-fork-agent";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useOptionalPaneContext, type PaneContextValue } from "@/panels/pane-context";
import { selectHostFeature, useHostFeature } from "@/runtime/host-features";
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
  supportsAgentInitialPromptOrigin: () => boolean;
  client: Pick<DaemonClient, "buildAgentForkContext" | "updateAgent"> | null;
  paneContext: HandoffPane | null;
  inFlight?: { current: boolean };
  getAgent: () => HandoffAgent | null;
  hasUnsettledMessage: () => boolean;
  takeQueuedMessages: () => { messages: readonly QueuedComposerMessage[]; restore: () => void };
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
    "retainAgentTabForHandoff" | "unpinAgent" | "hideAgent"
  >;
  confirmDialog: typeof confirmDialog;
  getOrCreateClientId: typeof getOrCreateClientId;
  generateDraftId: typeof generateDraftId;
  archiveAgent: (input: ArchiveAgentInput) => Promise<void>;
  confirmSourceArchived: (input: ArchiveAgentInput) => Promise<boolean>;
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

function snapshotUnsentDraft(
  sourceDraftKey: string,
  deps: Pick<CrossProviderHandoffDeps, "getComposerInput" | "getDraftStore">,
) {
  const composerInput = deps.getComposerInput();
  const draftStore = deps.getDraftStore();
  const storedSourceDraft = draftStore.getDraftInput(sourceDraftKey);
  return {
    text:
      composerInput?.textSource.peekPendingText?.() ??
      composerInput?.textSource.getSnapshot() ??
      storedSourceDraft?.text ??
      "",
    attachments: [...(composerInput?.attachments ?? storedSourceDraft?.attachments ?? [])],
    metadata: draftStore.metadataByDraftKey[sourceDraftKey],
  };
}

function buildHandoffDraftSetup(
  agent: Pick<HandoffAgent, "cwd" | "parentAgentId">,
  selection: CrossProviderHandoffSelection,
): WorkspaceDraftTabSetup {
  const parentAgentId = agent.parentAgentId?.trim();
  return {
    provider: selection.provider,
    cwd: agent.cwd,
    restoreChatHistory: true,
    ...(parentAgentId ? { parentAgentId } : {}),
    modeId: selection.modeId?.trim() || null,
    model: selection.modelId?.trim() || null,
    thinkingOptionId: selection.thinkingOptionId?.trim() || null,
    providerOptions: { ...selection.providerOptions },
  };
}

async function closeHandoffSource(input: {
  getCurrentAgent: () => HandoffAgent | null;
  confirmArchive: () => Promise<boolean>;
  needsArchiveConfirmation: (agent: HandoffAgent) => boolean;
  confirmedArchive: boolean;
  getClientId: () => Promise<string>;
  releaseTabLabel: (clientId: string) => Promise<void>;
  archiveAndCommit: (agent: HandoffAgent) => Promise<boolean>;
  commit: (agent: HandoffAgent) => boolean;
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
        return input.commit(agent);
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
    return input.archiveAndCommit(agent);
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
  let releaseSourceTab: (() => void) | undefined;

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

    const sourceTab = deps
      .getWorkspaceLayoutStore()
      .retainAgentTabForHandoff(workspaceKey, paneContext.tabId, agentId);
    if (!sourceTab) return false;
    releaseSourceTab = sourceTab.release;

    const getCurrentAgent = (): HandoffAgent | null => {
      if (!sourceTab.isCurrent()) return null;
      const current = deps.getAgent();
      if (
        !current ||
        current.archivedAt ||
        current.workspaceId?.trim() !== workspaceId ||
        isMainControlAgent(current)
      )
        return null;
      return current;
    };
    // COMPAT(agentInitialPromptOrigin): added in v0.16.0, remove gate after 2027-05-19.
    const canKeepParent = (agent: HandoffAgent): boolean => {
      if (!agent.parentAgentId?.trim() || deps.supportsAgentInitialPromptOrigin()) return true;
      toast.error(t("message.actions.forkUnavailable"));
      return false;
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
    if (!sourceAgent || !canKeepParent(sourceAgent)) return false;
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
    const sourceDraftKey = buildDraftStoreKey({ serverId, agentId });
    const targetDraftKey = buildDraftStoreKey({ serverId, agentId: paneContext.tabId, draftId });
    const commit = (
      agent: HandoffAgent,
      unsent: ReturnType<typeof snapshotUnsentDraft>,
      queued: readonly QueuedComposerMessage[] = [],
    ) => {
      const queuedAttachments = queued.flatMap((message) => message.attachments);
      const text = [...queued.map((message) => message.text), unsent.text]
        .filter((part) => part.length > 0)
        .join("\n\n");
      const attachments = [...userAttachmentsOnly(queuedAttachments), ...unsent.attachments];
      const draftStore = deps.getDraftStore();
      deps.getWorkspaceAttachmentsStore().setWorkspaceAttachments({
        scopeKey: buildDraftWorkspaceAttachmentScopeKey(draftId),
        attachments: [attachment, ...queuedAttachments.filter(isWorkspaceAttachment)],
      });
      if (text.length > 0 || attachments.length > 0) {
        draftStore.saveDraftInput({ draftKey: targetDraftKey, draft: { text, attachments } });
      }
      if (unsent.metadata && Object.keys(unsent.metadata).length > 0) {
        draftStore.patchDraftMetadata({ draftKey: targetDraftKey, patch: unsent.metadata });
      }
      draftStore.clearDraftInput({ draftKey: sourceDraftKey, lifecycle: "abandoned" });
      draftStore.clearDraftMetadata({ draftKey: sourceDraftKey });
      deps.getComposerInput()?.setText("");
      paneContext.retargetCurrentTab({
        kind: "draft",
        draftId,
        setup: buildHandoffDraftSetup(agent, selection),
      });
      const layoutStore = deps.getWorkspaceLayoutStore();
      layoutStore.unpinAgent(workspaceKey, agentId);
      layoutStore.hideAgent(workspaceKey, agentId);
      return true;
    };

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
      archiveAndCommit: async (agent) => {
        if (!canKeepParent(agent)) return false;
        // The queue removes a message during delivery and returns it only if the send fails.
        if (deps.hasUnsettledMessage()) {
          toast.error(t("composer.errors.alreadyLoading"));
          return false;
        }
        const unsent = snapshotUnsentDraft(sourceDraftKey, deps);
        const queued = deps.takeQueuedMessages();
        const source = { serverId, agentId, expectedWorkspaceId: workspaceId };
        try {
          await deps.archiveAgent(source);
        } catch (error) {
          // A lost reply can follow a successful archive. A missing directory entry alone
          // does not prove the agent was archived in this workspace.
          const archived =
            error instanceof DaemonConnectionError &&
            sourceTab.isCurrent() &&
            (await deps.confirmSourceArchived(source).catch(() => false));
          if (!archived) {
            queued.restore();
            throw error;
          }
        }
        const current = deps.getAgent();
        if (
          !sourceTab.isCurrent() ||
          (current && (current.workspaceId?.trim() !== workspaceId || isMainControlAgent(current)))
        ) {
          return false;
        }
        return commit(agent, unsent, queued.messages);
      },
      commit: (agent) =>
        canKeepParent(agent) && commit(agent, snapshotUnsentDraft(sourceDraftKey, deps)),
    });
  } catch (error) {
    toast.error(toErrorMessage(error) || t("message.actions.forkFailed"));
    return false;
  } finally {
    releaseSourceTab?.();
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
        supportsAgentInitialPromptOrigin: () =>
          selectHostFeature(useSessionStore.getState(), serverId, "agentInitialPromptOrigin"),
        client,
        paneContext,
        inFlight: inFlightRef,
        getAgent: () => useSessionStore.getState().sessions[serverId]?.agents?.get(agentId) ?? null,
        hasUnsettledMessage: () =>
          useSessionStore
            .getState()
            .sessions[serverId]?.messageSubmissions.get(agentId)
            ?.some((submission) => !submission.rpcSettled) ?? false,
        takeQueuedMessages: () => {
          const store = useSessionStore.getState();
          const messages = store.sessions[serverId]?.queuedMessages.get(agentId) ?? [];
          if (messages.length > 0) {
            // Cancelling the old run during archive can otherwise deliver queued messages to it.
            store.setQueuedMessages(serverId, (current) => {
              const next = new Map(current);
              next.delete(agentId);
              return next;
            });
          }
          return {
            messages,
            restore: () => {
              const latest = useSessionStore.getState();
              const agent = latest.sessions[serverId]?.agents.get(agentId);
              if (messages.length === 0 || !agent || agent.archivedAt) return;
              latest.setQueuedMessages(serverId, (current) =>
                new Map(current).set(agentId, [...messages, ...(current.get(agentId) ?? [])]),
              );
            },
          };
        },
        getComposerInput,
        getDraftStore: useDraftStore.getState,
        getWorkspaceAttachmentsStore: useWorkspaceAttachmentsStore.getState,
        getWorkspaceLayoutStore: useWorkspaceLayoutStore.getState,
        confirmDialog,
        getOrCreateClientId,
        generateDraftId,
        archiveAgent: async (target) => {
          if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
          const { archivedAt } = await client.archiveAgent(
            target.agentId,
            target.expectedWorkspaceId,
          );
          applyArchivedAgentCloseResults({
            queryClient,
            serverId: target.serverId,
            results: [{ agentId: target.agentId, archivedAt }],
          });
        },
        confirmSourceArchived: async (target) => {
          if (!client) return false;
          const { agent } =
            (await client.fetchAgent({ agentId: target.agentId, timeout: 5_000 })) ?? {};
          if (!agent?.archivedAt || agent.workspaceId !== target.expectedWorkspaceId) return false;
          applyArchivedAgentCloseResults({
            queryClient,
            serverId: target.serverId,
            results: [{ agentId: target.agentId, archivedAt: agent.archivedAt }],
          });
          return true;
        },
        toast,
        t,
      },
    ),
  );

  return { canSwitchProvider, handoffToProvider };
}
