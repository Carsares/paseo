import { useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  DaemonConnectionError,
  type DaemonClient,
  type FetchAgentOptions,
  type FetchAgentResult,
} from "@getpaseo/client/internal/daemon-client";
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
import { retainAttachmentForGarbageCollection } from "@/attachments/service";
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
> & { fetchAgent: (options: FetchAgentOptions) => Promise<FetchAgentResult | null> };

interface OtherHandoffHost {
  serverId: string;
  label: string;
  client: Pick<DaemonClient, "fetchAgentHistory"> | null;
  includeBackground: boolean;
}

interface CrossProviderHandoffDeps {
  supportsAgentForkContext: boolean;
  mainControlClient?: MainControlHandoffClient;
  includeBackgroundChildren?: boolean;
  readOtherHosts: () => Promise<OtherHandoffHost[]>;
  supportsAgentInitialPromptOrigin: () => boolean;
  client: Pick<DaemonClient, "buildAgentForkContext" | "updateAgent"> | null;
  paneContext: HandoffPane | null;
  inFlight?: { current: boolean };
  getAgent: () => HandoffAgent | null;
  hasUnsettledMessage: () => boolean;
  hasQueuedMessages: () => boolean;
  takeQueuedMessages: (retain: (messages: readonly QueuedComposerMessage[]) => void) => {
    messages: readonly QueuedComposerMessage[];
    restore: () => boolean;
  };
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
    "setWorkspaceAttachments" | "addWorkspaceAttachment"
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

function takeRetainedQueuedMessages(deps: Pick<CrossProviderHandoffDeps, "takeQueuedMessages">) {
  const releases = new Map<string, () => void>();
  const retain = (messages: readonly QueuedComposerMessage[]) => {
    for (const message of messages) {
      for (const attachment of message.attachments) {
        let id: string | undefined;
        if (attachment.kind === "image") id = attachment.metadata.id;
        if (attachment.kind === "browser_element") id = attachment.attachment.screenshot?.id;
        if (id && !releases.has(id)) releases.set(id, retainAttachmentForGarbageCollection(id));
      }
    }
  };
  const release = () => {
    for (const free of releases.values()) free();
  };
  try {
    const queued = deps.takeQueuedMessages(retain);
    retain(queued.messages);
    return { ...queued, release };
  } catch (error) {
    release();
    throw error;
  }
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
  workspaceId?: string;
  sourceAgentId: string;
  parentServerId?: string;
  includeBackground: boolean;
}

async function readMainControlChildren(input: MainControlChildrenInput): Promise<Set<string>> {
  const {
    client,
    serverId,
    workspaceId,
    sourceAgentId,
    parentServerId = serverId,
    includeBackground,
  } = input;
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
      if (agent.archivedAt || (workspaceId && agent.workspaceId !== workspaceId)) continue;
      const parent = getParentAddressFromLabels(agent.labels, serverId);
      if (parent?.serverId === parentServerId && parent.agentId === sourceAgentId)
        children.add(agent.id);
    }
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return children;
}

async function assertNoRemoteMainControlChildren(input: {
  serverId: string;
  agentId: string;
  readOtherHosts: CrossProviderHandoffDeps["readOtherHosts"];
}): Promise<void> {
  const hosts = await input.readOtherHosts();
  await Promise.all(
    hosts.map(async (host) => {
      if (!host.client) {
        throw new Error(
          `Cannot check Main Control subagents on ${host.label}: host is unreachable.`,
        );
      }
      const children = await readMainControlChildren({
        client: host.client,
        serverId: host.serverId,
        parentServerId: input.serverId,
        sourceAgentId: input.agentId,
        includeBackground: host.includeBackground,
      }).catch(() => {
        throw new Error(
          `Cannot check Main Control subagents on ${host.label}. Reconnect the host and try again.`,
        );
      });
      if (children.size > 0) {
        throw new Error(
          `Main Control has active subagents on ${host.label}. Detach or archive them before switching providers.`,
        );
      }
    }),
  );
}

type MainControlHandoffInput = MainControlChildrenInput & {
  client: MainControlHandoffClient;
  workspaceId: string;
  setup: WorkspaceDraftTabSetup;
};
type MainControlHandoffDeps = Pick<
  CrossProviderHandoffDeps,
  "readOtherHosts" | "archiveAgent" | "confirmSourceArchived"
>;

async function archiveUnusedReplacement(
  input: MainControlHandoffInput,
  deps: MainControlHandoffDeps,
  replacement: Awaited<ReturnType<MainControlHandoffClient["createAgent"]>>,
): Promise<string> {
  const { client, serverId, workspaceId } = input;
  const [children] = await Promise.all([
    readMainControlChildren({ ...input, sourceAgentId: replacement.id, workspaceId: undefined }),
    assertNoRemoteMainControlChildren({
      serverId,
      agentId: replacement.id,
      readOtherHosts: deps.readOtherHosts,
    }),
  ]);
  if (children.size > 0) {
    throw new Error(`still has subagents: ${[...children].join(", ")}`);
  }
  const current = await client.fetchAgent({ agentId: replacement.id, timeout: 5_000 });
  const agent = current?.agent;
  if (!agent || agent.workspaceId !== workspaceId) {
    throw new Error("could not verify the session in its original workspace");
  }
  if (agent.archivedAt) return `replacement ${replacement.id} was already archived`;
  if (
    isMainControlAgent(agent) ||
    agent.lastUserMessageAt !== replacement.lastUserMessageAt ||
    agent.activeTurn ||
    agent.status === "running" ||
    agent.status === "initializing" ||
    agent.pendingPermissions.length > 0 ||
    (agent.backgroundWork?.count ?? 0) > 0
  ) {
    throw new Error("has a Main Control role or new activity");
  }
  await deps.archiveAgent({
    serverId,
    agentId: replacement.id,
    expectedWorkspaceId: workspaceId,
  });
  return `replacement ${replacement.id} archived`;
}

async function recoverMainControlHandoff(
  input: MainControlHandoffInput,
  deps: MainControlHandoffDeps,
  {
    replacement,
    movedChildren,
    promoted,
    attemptedArchive,
    error,
  }: {
    replacement: Awaited<ReturnType<MainControlHandoffClient["createAgent"]>>;
    movedChildren: readonly string[];
    promoted: boolean;
    attemptedArchive: boolean;
    error: unknown;
  },
): Promise<string> {
  const { client, serverId, workspaceId, sourceAgentId } = input;
  const lostReply = error instanceof DaemonConnectionError;
  if (attemptedArchive || !promoted) {
    const archived = await deps
      .confirmSourceArchived({
        serverId,
        agentId: sourceAgentId,
        expectedWorkspaceId: workspaceId,
      })
      .catch(() => null);
    if (archived === true) {
      const current = await client
        .fetchAgent({ agentId: replacement.id, timeout: 5_000 })
        .catch(() => null);
      if (
        current?.agent.workspaceId === workspaceId &&
        !current.agent.archivedAt &&
        isMainControlAgent(current.agent)
      ) {
        return replacement.id;
      }
      throw new Error(
        `Original Main Control is archived. Replacement ${replacement.id} was kept because its role could not be confirmed.`,
        { cause: error },
      );
    }
    if (
      (attemptedArchive && (archived === null || lostReply)) ||
      (archived === null && lostReply)
    ) {
      throw new Error(
        `Could not confirm whether the original Main Control was archived. Replacement ${replacement.id} was kept with its subagents.`,
        { cause: error },
      );
    }
  }

  const rollback: string[] = [];
  if (promoted || lostReply) {
    try {
      await client.setAgentMainControl(sourceAgentId, true);
      rollback.push("original Main Control restored");
    } catch (restoreError) {
      rollback.push(`original Main Control restore failed (${toErrorMessage(restoreError)})`);
    }
  }
  for (const childId of movedChildren.toReversed()) {
    try {
      await client.setAgentParent(childId, sourceAgentId);
      rollback.push(`subagent ${childId} restored`);
    } catch (restoreError) {
      rollback.push(`subagent ${childId} restore failed (${toErrorMessage(restoreError)})`);
    }
  }
  try {
    rollback.push(await archiveUnusedReplacement(input, deps, replacement));
  } catch (cleanupError) {
    rollback.push(
      `replacement ${replacement.id} cleanup not confirmed (${toErrorMessage(cleanupError)})`,
    );
  }
  throw new Error(`${toErrorMessage(error)}. Handoff recovery: ${rollback.join("; ")}.`, {
    cause: error,
  });
}

async function moveMainControl(
  input: MainControlHandoffInput,
  deps: MainControlHandoffDeps,
): Promise<string> {
  const { client, serverId, workspaceId, sourceAgentId, setup } = input;
  await assertNoRemoteMainControlChildren({
    serverId,
    agentId: sourceAgentId,
    readOtherHosts: deps.readOtherHosts,
  });
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
  const source = { serverId, agentId: sourceAgentId, expectedWorkspaceId: workspaceId };
  const movedChildren: string[] = [];
  const moveChild = async (childId: string) => {
    // Include this child in recovery if the daemon writes its parent but loses the reply.
    movedChildren.push(childId);
    await client.setAgentParent(childId, replacement.id);
  };
  let promoted = false;
  let attemptedArchive = false;
  try {
    const result = await client.setAgentMainControl(replacement.id, true, {
      handoffFromAgentId: sourceAgentId,
      archiveSource: true,
    });
    if (result.archivedSource === true) return replacement.id;
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
    attemptedArchive = true;
    await deps.archiveAgent(source);
  } catch (error) {
    return recoverMainControlHandoff(input, deps, {
      replacement,
      movedChildren,
      promoted,
      attemptedArchive,
      error,
    });
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
      deps.getWorkspaceAttachmentsStore().addWorkspaceAttachment({ scopeKey, attachment });
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
    recoverDraft: (
      unsent: ReturnType<typeof snapshotUnsentDraft>,
      queued: readonly QueuedComposerMessage[],
    ) => void;
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
    recoverDraft,
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
  const queued = takeRetainedQueuedMessages(deps);
  let transferred = false;
  try {
    const replacementId = await moveMainControl(
      {
        client: mainControlClient,
        serverId,
        workspaceId,
        sourceAgentId: agentId,
        setup: buildHandoffDraftSetup(sourceAgent, selection, false),
        includeBackground: deps.includeBackgroundChildren === true,
      },
      deps,
    );
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
    transferred = true;
    if (sourceTab.isCurrent()) {
      paneContext.retargetCurrentTab({ kind: "agent", agentId: replacementId });
    }
    const layoutStore = deps.getWorkspaceLayoutStore();
    layoutStore.unpinAgent(workspaceKey, agentId);
    layoutStore.hideAgent(workspaceKey, agentId);
    return true;
  } catch (error) {
    if (!transferred && !queued.restore()) recoverDraft(unsent, queued.messages);
    throw error;
  } finally {
    queued.release();
  }
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
          recoverDraft: (unsent, queued) => {
            commit(sourceAgent, unsent, null, queued, false);
          },
        },
        deps,
      );
    }

    // An attached child stays live, so its history is safe to read before closing the tab.
    // Root history must be read after the archive has stopped and drained the old run.
    const childHistory =
      resolveCloseAgentTabPolicy(sourceAgent).kind === "layout-only" ? await readHistory() : null;
    if (!getCurrentAgent()) return false;
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
        const queued = takeRetainedQueuedMessages(deps);
        try {
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
        } finally {
          queued.release();
        }
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
        readOtherHosts: async () => {
          const runtime = getHostRuntimeStore();
          const hosts = new Map(runtime.getHosts().map((host) => [host.serverId, host.label]));
          if (client && selectHostFeature(useSessionStore.getState(), serverId, "connectedHosts")) {
            for (const host of (await client.listHosts()).hosts) {
              if (!host.enabled) continue;
              if (!host.serverId) {
                throw new Error(
                  `Cannot check Main Control subagents on ${host.label ?? host.targetDescription}: host is unreachable.`,
                );
              }
              hosts.set(host.serverId, host.label ?? hosts.get(host.serverId) ?? host.serverId);
            }
          }
          hosts.delete(serverId);
          return [...hosts].map(([id, label]) => {
            const snapshot = runtime.getSnapshot(id);
            return {
              serverId: id,
              label: label || id,
              client: snapshot?.connectionStatus === "online" ? snapshot.client : null,
              includeBackground: selectHostFeature(
                useSessionStore.getState(),
                id,
                "backgroundWorkspaces",
              ),
            };
          });
        },
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
        takeQueuedMessages: (retain) => {
          const store = useSessionStore.getState();
          const messages = store.sessions[serverId]?.queuedMessages.get(agentId) ?? [];
          if (messages.length > 0) {
            retain(messages);
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
          if (!agent || agent.workspaceId !== target.expectedWorkspaceId) return null;
          if (!agent.archivedAt) return false;
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
