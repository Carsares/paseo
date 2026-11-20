import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { DaemonConnectionError, type DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useQueryClient } from "@tanstack/react-query";
import {
  getOpenAgentTabLabel,
  getParentAddressFromLabels,
  isMainControlAgent,
  PARENT_AGENT_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import {
  isWorkspaceAttachment,
  userAttachmentsOnly,
} from "@/attachments/workspace-attachment-utils";
import type { ToastApi } from "@/components/toast-host";
import type { QueuedComposerMessage } from "@/composer/actions";
import { lockHandoffInput } from "@/composer/handoff-input-lock";
import { useComposerInput, type ComposerInput } from "@/composer/session";
import { useToast } from "@/contexts/toast-api-context";
import type { DraftComposerTextSource } from "@/composer/draft/input-draft";
import type { UserComposerAttachment } from "@/attachments/types";
import { applyArchivedAgentCloseResults, type ArchiveAgentInput } from "@/hooks/use-archive-agent";
import { buildChatHistoryAttachment } from "@/hooks/use-fork-agent";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useOptionalPaneContext, type PaneContextValue } from "@/panels/pane-context";
import { selectHostFeature, useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
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
type MainControlHandoffClient = Pick<
  DaemonClient,
  "createAgent" | "fetchAgentHistory" | "setAgentMainControl" | "setAgentParent"
>;

interface CrossProviderHandoffDeps {
  supportsAgentForkContext: boolean;
  mainControlClient?: MainControlHandoffClient;
  includeBackgroundChildren?: boolean;
  supportsAgentInitialPromptOrigin: () => boolean;
  client: Pick<DaemonClient, "buildAgentForkContext" | "updateAgent"> | null;
  paneContext: HandoffPane | null;
  inFlight?: { current: boolean };
  getAgent: () => HandoffAgent | null;
  hasUnsettledMessage: () => boolean;
  hasQueuedMessages: () => boolean;
  takeQueuedMessages: () => { messages: readonly QueuedComposerMessage[]; restore: () => boolean };
  getComposerInput: () =>
    | (Pick<ComposerInput, "isLocked"> & {
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
  > &
    Partial<
      Pick<ReturnType<typeof useWorkspaceAttachmentsStore.getState>, "addWorkspaceAttachment">
    >;
  getWorkspaceLayoutStore: () => Pick<
    ReturnType<typeof useWorkspaceLayoutStore.getState>,
    "retainAgentTabForHandoff" | "unpinAgent" | "hideAgent" | "openTab"
  >;
  confirmDialog: typeof confirmDialog;
  getOrCreateClientId: typeof getOrCreateClientId;
  generateDraftId: typeof generateDraftId;
  archiveAgent: (input: ArchiveAgentInput) => Promise<void>;
  confirmSourceArchived: (input: ArchiveAgentInput) => Promise<boolean | null>;
  toast: Pick<ToastApi, "error">;
  t: (key: string) => string;
}

function isHandoffPane(paneContext: HandoffPane | null): paneContext is HandoffPane {
  return Boolean(paneContext && paneContext.host !== "sheet" && paneContext.workspaceId.trim());
}

export function canSwitchAgentProvider(input: {
  serverId: string;
  supportsAgentForkContext: boolean;
  supportsAgentHierarchyControl?: boolean;
  client: Pick<DaemonClient, "buildAgentForkContext" | "updateAgent"> | null;
  paneContext: HandoffPane | null;
  agent: Pick<Agent, "labels"> | null;
}): boolean {
  const parent = getParentAddressFromLabels(input.agent?.labels, input.serverId);
  return Boolean(
    input.supportsAgentForkContext &&
    input.client &&
    isHandoffPane(input.paneContext) &&
    input.agent &&
    (!parent || parent.serverId === input.serverId) &&
    (!isMainControlAgent(input.agent) || input.supportsAgentHierarchyControl === true),
  );
}

interface MainControlChildrenInput {
  client: Pick<MainControlHandoffClient, "fetchAgentHistory">;
  serverId: string;
  workspaceId: string;
  sourceAgentId: string;
  includeBackground: boolean;
}

async function readMainControlChildren(input: MainControlChildrenInput): Promise<Set<string>> {
  const { client, serverId, workspaceId, sourceAgentId, includeBackground } = input;
  const children = new Set<string>();
  let cursor: string | undefined;
  do {
    // History also includes stored sessions whose provider is temporarily unavailable.
    const page = await client.fetchAgentHistory({
      filter: {
        labels: { [PARENT_AGENT_ID_LABEL]: sourceAgentId },
        includeArchived: false,
        ...(includeBackground ? { includeBackground: true } : {}),
      },
      page: { limit: 200, cursor },
    });
    for (const { agent } of page.entries) {
      if (agent.archivedAt || agent.workspaceId !== workspaceId) continue;
      const parent = getParentAddressFromLabels(agent.labels, serverId);
      if (parent?.serverId === serverId && parent.agentId === sourceAgentId) children.add(agent.id);
    }
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return children;
}

async function moveMainControl(
  input: MainControlChildrenInput & {
    client: MainControlHandoffClient;
    setup: WorkspaceDraftTabSetup;
  },
): Promise<string> {
  const { client, workspaceId, sourceAgentId, setup } = input;
  const replacement = await client.createAgent({
    workspaceId,
    config: {
      provider: setup.provider,
      cwd: setup.cwd,
      modeId: setup.modeId ?? undefined,
      model: setup.model ?? undefined,
      thinkingOptionId: setup.thinkingOptionId ?? undefined,
      providerOptions: setup.providerOptions,
    },
  });
  const movedChildren: string[] = [];
  const moveChild = async (childId: string) => {
    // Include this child in recovery if the daemon writes its parent but loses the reply.
    movedChildren.push(childId);
    await client.setAgentParent(childId, replacement.id);
  };
  let promoted = false;
  try {
    await client.setAgentMainControl(replacement.id, true);
    promoted = true;
    for (const childId of await readMainControlChildren(input)) {
      await moveChild(childId);
    }
    // A client may have submitted a subagent draft while the first page was being read.
    const remaining = await readMainControlChildren(input);
    for (const childId of remaining) {
      await moveChild(childId);
    }
    if (remaining.size > 0 && (await readMainControlChildren(input)).size > 0) {
      throw new Error("New subagents are still joining Main Control. Try again when they finish.");
    }
  } catch (error) {
    // Keep the source available when any part of the hierarchy transfer fails.
    for (const childId of movedChildren.toReversed()) {
      await client.setAgentParent(childId, sourceAgentId).catch(() => undefined);
    }
    if (promoted || error instanceof DaemonConnectionError) {
      await client.setAgentMainControl(sourceAgentId, true).catch(() => undefined);
    }
    throw error;
  }
  return replacement.id;
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
    attachments: [...(storedSourceDraft?.attachments ?? [])],
    metadata: draftStore.metadataByDraftKey[sourceDraftKey],
  };
}

function buildHandoffDraftSetup(
  agent: Pick<HandoffAgent, "cwd" | "parentAgentId">,
  selection: CrossProviderHandoffSelection,
  restoreChatHistory: boolean,
): WorkspaceDraftTabSetup {
  const parentAgentId = agent.parentAgentId?.trim();
  return {
    provider: selection.provider,
    cwd: agent.cwd,
    restoreChatHistory,
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
  confirmKeepQueue: () => Promise<boolean>;
  archiveAndCommit: (agent: HandoffAgent) => Promise<boolean>;
  commit: (agent: HandoffAgent) => Promise<boolean>;
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
      if (!(await input.confirmKeepQueue())) return false;
      const current = input.getCurrentAgent();
      if (!current) return false;
      if (resolveCloseAgentTabPolicy(current).kind !== "layout-only") continue;
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

function saveMainControlHandoffDraft(
  input: {
    serverId: string;
    workspaceId: string;
    cwd: string;
    replacementId: string;
    sourceDraftKey: string;
    history: ReturnType<typeof buildChatHistoryAttachment> | null;
    unsent: ReturnType<typeof snapshotUnsentDraft>;
    queuedMessages: readonly QueuedComposerMessage[];
  },
  deps: CrossProviderHandoffDeps,
): void {
  const {
    serverId,
    workspaceId,
    cwd,
    replacementId,
    sourceDraftKey,
    history,
    unsent,
    queuedMessages,
  } = input;
  const draftStore = deps.getDraftStore();
  const replacementDraftKey = buildDraftStoreKey({ serverId, agentId: replacementId });
  const queuedAttachments = queuedMessages.flatMap((message) => message.attachments);
  const attachments: UserComposerAttachment[] = [
    ...userAttachmentsOnly(queuedAttachments),
    ...unsent.attachments,
  ];
  if (history?.kind === "chat_history") {
    // A live agent's draft is scoped to the session. A workspace attachment is shared by tabs.
    attachments.push({ kind: "quote", id: history.id, text: history.attachment.text });
  }
  const workspaceAttachments = queuedAttachments.filter(isWorkspaceAttachment);
  if (workspaceAttachments.length > 0) {
    const scopeKey = buildWorkspaceAttachmentScopeKey({
      serverId,
      workspaceId,
      cwd,
    });
    for (const attachment of workspaceAttachments) {
      deps.getWorkspaceAttachmentsStore().addWorkspaceAttachment?.({ scopeKey, attachment });
    }
  }
  const text = [...queuedMessages.map((message) => message.text), unsent.text]
    .filter((part) => part.length > 0)
    .join("\n\n");
  if (text || attachments.length > 0) {
    draftStore.saveDraftInput({ draftKey: replacementDraftKey, draft: { text, attachments } });
  }
  if (unsent.metadata && Object.keys(unsent.metadata).length > 0) {
    draftStore.patchDraftMetadata({ draftKey: replacementDraftKey, patch: unsent.metadata });
  }
  deps.getComposerInput()?.textSource.cancelPendingText?.();
  draftStore.clearDraftInput({ draftKey: sourceDraftKey, lifecycle: "abandoned" });
  draftStore.clearDraftMetadata({ draftKey: sourceDraftKey });
}

async function handoffMainControl(
  input: {
    serverId: string;
    agentId: string;
    workspaceId: string;
    workspaceKey: string;
    sourceAgent: HandoffAgent;
    sourceTab: NonNullable<
      ReturnType<
        ReturnType<CrossProviderHandoffDeps["getWorkspaceLayoutStore"]>["retainAgentTabForHandoff"]
      >
    >;
    paneContext: HandoffPane;
    selection: CrossProviderHandoffSelection;
    sourceDraftKey: string;
    tryLockInput: () => boolean;
    readHistory: () => Promise<ReturnType<typeof buildChatHistoryAttachment>>;
  },
  deps: CrossProviderHandoffDeps,
): Promise<boolean> {
  const {
    serverId,
    agentId,
    workspaceId,
    workspaceKey,
    sourceAgent,
    sourceTab,
    paneContext,
    selection,
    sourceDraftKey,
    tryLockInput,
    readHistory,
  } = input;
  const { mainControlClient, t, toast } = deps;
  if (!mainControlClient || !sourceTab.isCurrent()) return false;
  const busy = sourceAgent.status === "running" || sourceAgent.status === "initializing";
  if (busy || deps.hasUnsettledMessage() || deps.getComposerInput()?.isLocked()) {
    toast.error(t("composer.errors.alreadyLoading"));
    return false;
  }
  if (!tryLockInput()) return false;
  const unsent = snapshotUnsentDraft(sourceDraftKey, deps);
  const queued = deps.takeQueuedMessages();
  let replacementId: string;
  try {
    replacementId = await moveMainControl({
      client: mainControlClient,
      serverId,
      workspaceId,
      sourceAgentId: agentId,
      setup: buildHandoffDraftSetup(sourceAgent, selection, false),
      includeBackground: deps.includeBackgroundChildren === true,
    });
  } catch (error) {
    queued.restore();
    throw error;
  }

  let archiveError: unknown;
  const source = { serverId, agentId, expectedWorkspaceId: workspaceId };
  try {
    await deps.archiveAgent(source);
  } catch (error) {
    if (!(await deps.confirmSourceArchived(source).catch(() => false))) archiveError = error;
  }
  const history = await readHistory().catch((error) => {
    toast.error(toErrorMessage(error) || t("message.actions.forkFailed"));
    return null;
  });
  saveMainControlHandoffDraft(
    {
      serverId,
      workspaceId,
      cwd: sourceAgent.cwd,
      replacementId,
      sourceDraftKey,
      history,
      unsent,
      queuedMessages: queued.messages,
    },
    deps,
  );
  if (sourceTab.isCurrent()) {
    paneContext.retargetCurrentTab({ kind: "agent", agentId: replacementId });
  }
  if (archiveError) throw archiveError;
  const layoutStore = deps.getWorkspaceLayoutStore();
  layoutStore.unpinAgent(workspaceKey, agentId);
  layoutStore.hideAgent(workspaceKey, agentId);
  return true;
}

async function maybeConfirmHandoffArchive(input: {
  agent: HandoffAgent;
  needsArchiveConfirmation: (agent: HandoffAgent) => boolean;
  confirmArchive: () => Promise<boolean>;
}): Promise<boolean | null> {
  if (isMainControlAgent(input.agent) || !input.needsArchiveConfirmation(input.agent)) return false;
  return (await input.confirmArchive()) ? true : null;
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
  let releaseInput: (() => void) | undefined;

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

    const getCurrentAgent = (allowMainControl = false): HandoffAgent | null => {
      if (!sourceTab.isCurrent()) return null;
      const current = deps.getAgent();
      if (
        !current ||
        current.archivedAt ||
        current.workspaceId?.trim() !== workspaceId ||
        (isMainControlAgent(current) && !allowMainControl)
      )
        return null;
      const parent = getParentAddressFromLabels(current.labels, serverId);
      return parent?.serverId === serverId && current.parentAgentId !== parent.agentId
        ? { ...current, parentAgentId: parent.agentId }
        : current;
    };
    // COMPAT(agentInitialPromptOrigin): added in v0.16.0, remove gate after 2027-05-19.
    const canKeepParent = (agent: HandoffAgent): boolean => {
      const parent = getParentAddressFromLabels(agent.labels, serverId);
      if (
        (!parent || parent.serverId === serverId) &&
        (!(parent || agent.parentAgentId?.trim()) || deps.supportsAgentInitialPromptOrigin())
      )
        return true;
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

    const sourceAgent = getCurrentAgent(true);
    if (!sourceAgent || !canKeepParent(sourceAgent)) return false;
    const confirmedArchive = await maybeConfirmHandoffArchive({
      agent: sourceAgent,
      needsArchiveConfirmation,
      confirmArchive,
    });
    if (confirmedArchive === null) return false;

    const draftId = deps.generateDraftId();
    const readHistory = async () =>
      buildChatHistoryAttachment({
        draftId,
        serverId,
        agentId,
        payload: await client.buildAgentForkContext(agentId),
        missingAttachmentMessage: t("message.actions.forkFailed"),
      });
    const sourceDraftKey = buildDraftStoreKey({ serverId, agentId });
    const tryLockInput = () => {
      releaseInput = lockHandoffInput(sourceDraftKey) ?? undefined;
      if (releaseInput) return true;
      toast.error(t("composer.errors.alreadyLoading"));
      return false;
    };
    if (isMainControlAgent(sourceAgent)) {
      return await handoffMainControl(
        {
          serverId,
          agentId,
          workspaceId,
          workspaceKey,
          sourceAgent,
          sourceTab,
          paneContext,
          selection,
          sourceDraftKey,
          tryLockInput,
          readHistory,
        },
        deps,
      );
    }

    // An attached child stays live, so its history is safe to read before closing the tab.
    // Root history must be read after the archive has stopped and drained the old run.
    const childHistory =
      resolveCloseAgentTabPolicy(sourceAgent).kind === "layout-only" ? await readHistory() : null;
    if (!getCurrentAgent()) return false;
    const targetDraftKey = buildDraftStoreKey({ serverId, agentId: paneContext.tabId, draftId });
    const commit = (
      agent: HandoffAgent,
      unsent: ReturnType<typeof snapshotUnsentDraft>,
      history: Awaited<ReturnType<typeof readHistory>> | null,
      queued: readonly QueuedComposerMessage[] = [],
      replaceSource = true,
    ) => {
      const queuedAttachments = queued.flatMap((message) => message.attachments);
      const text = [...queued.map((message) => message.text), unsent.text]
        .filter((part) => part.length > 0)
        .join("\n\n");
      const attachments = [...userAttachmentsOnly(queuedAttachments), ...unsent.attachments];
      const draftStore = deps.getDraftStore();
      const workspaceAttachments = [
        ...(history ? [history] : []),
        ...queuedAttachments.filter(isWorkspaceAttachment),
      ];
      if (
        !replaceSource &&
        !text &&
        attachments.length === 0 &&
        workspaceAttachments.length === 0 &&
        !unsent.metadata
      )
        return false;
      deps.getWorkspaceAttachmentsStore().setWorkspaceAttachments({
        scopeKey: buildDraftWorkspaceAttachmentScopeKey(draftId),
        attachments: workspaceAttachments,
      });
      if (text.length > 0 || attachments.length > 0) {
        draftStore.saveDraftInput({ draftKey: targetDraftKey, draft: { text, attachments } });
      }
      if (unsent.metadata && Object.keys(unsent.metadata).length > 0) {
        draftStore.patchDraftMetadata({ draftKey: targetDraftKey, patch: unsent.metadata });
      }
      const target = {
        kind: "draft" as const,
        draftId,
        setup: buildHandoffDraftSetup(agent, selection, history !== null),
      };
      const layoutStore = deps.getWorkspaceLayoutStore();
      if (!replaceSource && !layoutStore.openTab({ workspaceKey, target, intent: "background" })) {
        return false;
      }
      deps.getComposerInput()?.textSource.cancelPendingText?.();
      draftStore.clearDraftInput({ draftKey: sourceDraftKey, lifecycle: "abandoned" });
      draftStore.clearDraftMetadata({ draftKey: sourceDraftKey });
      if (!replaceSource) return true;
      paneContext.retargetCurrentTab(target);
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
      confirmKeepQueue: () =>
        !deps.hasQueuedMessages()
          ? Promise.resolve(true)
          : deps.confirmDialog({
              title: t("workspace.tabs.confirmations.handoffKeepQueueTitle"),
              message: t("workspace.tabs.confirmations.handoffKeepQueueMessage"),
              confirmLabel: t("workspace.tabs.confirmations.handoffKeepQueueConfirm"),
              cancelLabel: t("workspace.tabs.confirmations.cancel"),
            }),
      releaseTabLabel: async (clientId) => {
        await client.updateAgent(agentId, {
          labels: { [getOpenAgentTabLabel(clientId)]: "false" },
        });
      },
      archiveAndCommit: async (agent) => {
        if (!canKeepParent(agent)) return false;
        // The queue removes a message during delivery and returns it only if the send fails.
        if (deps.hasUnsettledMessage() || deps.getComposerInput()?.isLocked()) {
          toast.error(t("composer.errors.alreadyLoading"));
          return false;
        }
        if (!tryLockInput()) return false;
        const unsent = snapshotUnsentDraft(sourceDraftKey, deps);
        const queued = deps.takeQueuedMessages();
        const source = { serverId, agentId, expectedWorkspaceId: workspaceId };
        try {
          await deps.archiveAgent(source);
        } catch (error) {
          // Archive persistence can succeed before runtime close or the reply fails.
          const archived = await deps.confirmSourceArchived(source).catch(() => null);
          const lostReply = error instanceof DaemonConnectionError;
          if (!archived || !lostReply) {
            // A timed-out request may still archive the agent after the lookup.
            if (archived !== false || lostReply || !queued.restore()) {
              commit(agent, unsent, null, queued.messages, false);
            }
            throw error;
          }
        }
        let history: Awaited<ReturnType<typeof readHistory>> | null = null;
        try {
          history = await readHistory();
        } catch (error) {
          toast.error(toErrorMessage(error) || t("message.actions.forkFailed"));
        }
        const current = deps.getAgent();
        const canReplaceSource =
          sourceTab.isCurrent() &&
          (!current ||
            (current.workspaceId?.trim() === workspaceId && !isMainControlAgent(current)));
        return commit(agent, unsent, history, queued.messages, canReplaceSource);
      },
      commit: async (agent) => {
        if (!canKeepParent(agent)) return false;
        const history = childHistory ?? (await readHistory());
        const current = getCurrentAgent();
        if (!current || !canKeepParent(current)) return false;
        if (!tryLockInput()) return false;
        return commit(current, snapshotUnsentDraft(sourceDraftKey, deps), history);
      },
    });
  } catch (error) {
    toast.error(toErrorMessage(error) || t("message.actions.forkFailed"));
    return false;
  } finally {
    releaseInput?.();
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
  const supportsAgentHierarchyControl = useHostFeature(serverId, "agentHierarchyControl");
  const supportsBackgroundWorkspaces = useHostFeature(serverId, "backgroundWorkspaces");
  const paneContext = useOptionalPaneContext();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const agentLabels = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.labels,
  );
  const composerInput = useComposerInput();
  const getComposerInput = useStableEvent(() => composerInput);
  const inFlightRef = useRef(false);
  const canSwitchProvider = canSwitchAgentProvider({
    serverId,
    supportsAgentForkContext,
    supportsAgentHierarchyControl,
    client,
    paneContext,
    agent: agentLabels ? { labels: agentLabels } : null,
  });

  const handoffToProvider = useStableEvent((selection: CrossProviderHandoffSelection) =>
    performCrossProviderAgentHandoff(
      { serverId, agentId, selection },
      {
        supportsAgentForkContext,
        mainControlClient: supportsAgentHierarchyControl ? (client ?? undefined) : undefined,
        includeBackgroundChildren: supportsBackgroundWorkspaces,
        supportsAgentInitialPromptOrigin: () =>
          selectHostFeature(useSessionStore.getState(), serverId, "agentInitialPromptOrigin"),
        client,
        paneContext,
        inFlight: inFlightRef,
        getAgent: () => useSessionStore.getState().sessions[serverId]?.agents?.get(agentId) ?? null,
        hasUnsettledMessage: () =>
          getHostRuntimeStore().isDrainingQueuedAgentMessage(serverId, agentId) ||
          (useSessionStore
            .getState()
            .sessions[serverId]?.messageSubmissions.get(agentId)
            ?.some((submission) => !submission.rpcSettled) ??
            false),
        hasQueuedMessages: () =>
          Boolean(
            useSessionStore.getState().sessions[serverId]?.queuedMessages.get(agentId)?.length,
          ),
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
              if (messages.length === 0) return true;
              const latest = useSessionStore.getState();
              const agent = latest.sessions[serverId]?.agents.get(agentId);
              if (!agent || agent.archivedAt) return false;
              latest.setQueuedMessages(serverId, (current) =>
                new Map(current).set(agentId, [...messages, ...(current.get(agentId) ?? [])]),
              );
              return true;
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
          if (!client) return null;
          const { agent } =
            (await client.fetchAgent({ agentId: target.agentId, timeout: 5_000 })) ?? {};
          if (!agent) return null;
          if (!agent.archivedAt) return false;
          if (agent.workspaceId !== target.expectedWorkspaceId) return null;
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
