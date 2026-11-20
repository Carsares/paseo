import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import type {
  AgentForkContextOptions,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import { isMainControlAgent, type AgentLabelSource } from "@getpaseo/protocol/agent-labels";
import { appendQuoteAttachment } from "@/attachments/quote";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import { hasDraftContent } from "@/composer/draft/input-draft-core";
import type { AssistantForkTarget } from "@/components/assistant-fork-menu";
import type { ToastApi } from "@/components/toast-host";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useSettings, type OpenInSidePanePreferences } from "@/hooks/use-settings";
import { useHostFeature } from "@/runtime/host-features";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import type { DraftRecord } from "@/stores/draft-store/state";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { toErrorMessage } from "@/utils/error-messages";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceDraftTabSetup,
  type WorkspaceTabTarget,
} from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";

/**
 * The subset of an agent record that a fork needs in order to seed the new
 * draft. Kept structural so both `AgentScreenAgent` (the agent-stream view's
 * live context) and the session store's `Agent` record satisfy it without a
 * projection step.
 */
export type ForkAgentSource = Pick<
  AgentScreenAgent,
  | "provider"
  | "cwd"
  | "currentModeId"
  | "model"
  | "thinkingOptionId"
  | "runtimeInfo"
  | "options"
  | "subagentDraftOptions"
  | "projectPlacement"
>;

/**
 * Boundary marking where the forked context should stop. Omit it entirely to
 * fork the whole timeline *up to now* — including a partially streamed
 * in-flight turn. `selectForkContextRows` projects the full timeline when
 * neither field is present, which is what makes mid-run forking work.
 */
export type ForkAgentBoundary = Pick<
  AgentForkContextOptions,
  "boundaryCursor" | "boundaryMessageId"
>;

export interface ForkAgentRequest {
  agentId: string;
  agent: ForkAgentSource & AgentLabelSource;
  workspaceId?: string;
  parentTabId?: string;
  parentAgentId?: string | null;
  quoteText?: string;
  target: AssistantForkTarget;
  boundary?: ForkAgentBoundary;
}

export interface UseForkAgentInput {
  serverId: string;
  toast?: ToastApi | null;
  /** Read-only surfaces (provider subagent panes) must never fork. */
  readOnly?: boolean;
}

export function buildChatHistoryAttachment(input: {
  draftId: string;
  serverId: string;
  agentId: string;
  payload: Awaited<ReturnType<DaemonClient["buildAgentForkContext"]>>;
  missingAttachmentMessage: string;
}): WorkspaceComposerAttachment {
  if (!input.payload.attachment) {
    throw new Error(input.missingAttachmentMessage);
  }
  const forkContext = input.payload.attachment.forkContext;
  const sourceAgentId = input.agentId.trim() || forkContext?.sourceAgentId?.trim();
  const boundaryMessageId =
    input.payload.boundaryMessageId?.trim() || forkContext?.boundaryMessageId?.trim();
  return {
    kind: "chat_history",
    id: `chat_history:${input.draftId}`,
    attachment: {
      ...input.payload.attachment,
      ...(sourceAgentId || boundaryMessageId
        ? {
            forkContext: {
              ...(sourceAgentId ? { sourceAgentId } : {}),
              ...(boundaryMessageId ? { boundaryMessageId } : {}),
            },
          }
        : {}),
    },
    source: {
      serverId: input.serverId,
      agentId: input.agentId,
      boundaryMessageId: input.payload.boundaryMessageId,
      boundaryCursor: input.payload.boundaryCursor,
      itemCount: input.payload.itemCount,
    },
  };
}

function buildForkDraftSetup(agent: ForkAgentSource): WorkspaceDraftTabSetup | undefined {
  if (!agent.provider) {
    return undefined;
  }

  return {
    provider: agent.provider,
    cwd: agent.cwd,
    modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    providerOptions: { ...agent.options },
  };
}

const MAIN_CONTROL_CLAUDE_DISALLOWED_TOOLS = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Bash",
]);

function stripMainControlReadOnlyProviderOptions(
  providerOptions: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...providerOptions };
  if (next.sandbox_mode === "read-only") {
    delete next.sandbox_mode;
  }
  if (next.approval_policy === "never") {
    delete next.approval_policy;
  }
  if (Array.isArray(next.disallowedTools)) {
    const remaining = next.disallowedTools.filter(
      (tool) => typeof tool !== "string" || !MAIN_CONTROL_CLAUDE_DISALLOWED_TOOLS.has(tool),
    );
    if (remaining.length > 0) {
      next.disallowedTools = remaining;
    } else {
      delete next.disallowedTools;
    }
  }
  return next;
}

export function buildMainSubagentTabDraftSetup(input: {
  mainAgent: Pick<ForkAgentSource, "provider" | "cwd">;
  mainAgentId: string;
  preferredProvider?: string;
}): WorkspaceDraftTabSetup | undefined {
  const provider = input.preferredProvider || input.mainAgent.provider;
  const parentAgentId = input.mainAgentId.trim();
  if (!provider || !parentAgentId) return undefined;
  // The persisted draft needs a provider; the composer resolves the other fields from preferences.
  return {
    provider,
    cwd: input.mainAgent.cwd,
    parentAgentId,
    modeId: null,
    model: null,
    thinkingOptionId: null,
    providerOptions: {},
  };
}

export function buildSubagentDraftSetup(
  agent: ForkAgentSource & AgentLabelSource,
  parentAgentId: string,
  preferredProvider?: string,
): WorkspaceDraftTabSetup | undefined {
  const isMainControl = isMainControlAgent(agent);
  const hasSafeInheritedOptions =
    agent.subagentDraftOptions || agent.provider === "codex" || agent.provider === "claude";
  if (isMainControl && (preferredProvider || !hasSafeInheritedOptions)) {
    return buildMainSubagentTabDraftSetup({
      mainAgent: agent,
      mainAgentId: parentAgentId,
      preferredProvider,
    });
  }
  const normalizedParentId = parentAgentId.trim();
  if (!normalizedParentId) return undefined;
  const setup = buildForkDraftSetup(agent);
  if (!setup) return undefined;
  if (!isMainControl) return { ...setup, parentAgentId: normalizedParentId };
  const modeId = setup.modeId === "read-only" ? null : setup.modeId;
  if (agent.subagentDraftOptions) {
    return {
      ...setup,
      modeId,
      parentAgentId: normalizedParentId,
      providerOptions: agent.subagentDraftOptions,
    };
  }
  // COMPAT(subagentDraftOptions): added in v0.16.0, remove after 2027-05-01.
  return {
    ...setup,
    parentAgentId: normalizedParentId,
    modeId,
    providerOptions: stripMainControlReadOnlyProviderOptions(setup.providerOptions),
  };
}

function buildForkDraftTabTarget(
  setup: WorkspaceDraftTabSetup | undefined,
  draftId: string,
): WorkspaceTabTarget {
  return setup ? { kind: "draft", draftId, setup } : { kind: "draft", draftId };
}

function openForkDraftInWorkspace(input: {
  serverId: string;
  workspaceId: string;
  draftTarget: WorkspaceTabTarget;
  parentTabId?: string;
  target: "tab" | "subagent";
  preferences: OpenInSidePanePreferences;
}) {
  const { serverId, workspaceId, draftTarget, parentTabId, target, preferences } = input;
  if (target === "subagent") {
    const tabId = openPreferredWorkspaceTarget({
      workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
      target: draftTarget,
      source: "subagents",
      preferences,
      parentTabId,
    });
    if (tabId) return;
  }
  navigateToWorkspace({ serverId, workspaceId, target: draftTarget });
}

function resolveForkDraftSetup(input: {
  target: AssistantForkTarget;
  agent: ForkAgentSource & AgentLabelSource;
  agentId: string;
  parentAgentId?: string | null;
  preferredProvider?: string;
  unavailableMessage: string;
}): WorkspaceDraftTabSetup | undefined {
  if (input.target !== "subagent") {
    return buildForkDraftSetup(input.agent);
  }
  const targetParentId = input.parentAgentId?.trim() || input.agentId;
  const setup = buildSubagentDraftSetup(input.agent, targetParentId, input.preferredProvider);
  if (!setup) {
    throw new Error(input.unavailableMessage);
  }
  return setup;
}

function seedForkQuoteDraft(serverId: string, draftId: string, quoteText: string): void {
  const quotes = appendQuoteAttachment([], quoteText);
  if (quotes.length === 0) return;

  const draftKey = buildDraftStoreKey({ serverId, agentId: "", draftId });
  const saveIfEmpty = () => {
    const { drafts, getDraftInput, saveDraftInput } = useDraftStore.getState();
    const current = getDraftInput(draftKey);
    if (drafts[draftKey] && (!current || hasDraftContent(current))) return;
    saveDraftInput({ draftKey, draft: { text: "", attachments: quotes } });
  };

  saveIfEmpty();
  const { hasHydrated, onFinishHydration } = useDraftStore.persist;
  if (!hasHydrated()) {
    const seed = useDraftStore.getState().drafts[draftKey];
    let editedDraft: DraftRecord | undefined;
    const stopTracking = useDraftStore.subscribe((state, previous) => {
      const current = state.drafts[draftKey];
      const before = previous.drafts[draftKey];
      // The draft's edit and clear actions advance its revision. Hydration can
      // replace the entire drafts map with a snapshot from before this draft existed.
      if (before && current?.version === before.version + 1) editedDraft = current;
    });
    const unsubscribe = onFinishHydration(() => {
      unsubscribe();
      stopTracking();
      const restored = useDraftStore.getState().drafts[draftKey];
      const draftToKeep = editedDraft ?? (restored === seed ? seed : undefined);
      if (!draftToKeep) {
        saveIfEmpty();
        return;
      }
      // Writes during the storage read can be skipped, even if the seed survived hydration.
      useDraftStore.setState((state) => ({ drafts: { ...state.drafts, [draftKey]: draftToKeep } }));
    });
  }
}

export async function prepareForkDraft(input: {
  client: Pick<DaemonClient, "buildAgentForkContext">;
  serverId: string;
  agentId: string;
  boundary?: ForkAgentBoundary;
  quoteText?: string;
  missingAttachmentMessage: string;
}): Promise<string> {
  const { client, serverId, agentId, boundary, quoteText, missingAttachmentMessage } = input;
  const draftId = generateDraftId();
  const payload = await client.buildAgentForkContext(agentId, boundary);
  const attachment = buildChatHistoryAttachment({
    draftId,
    serverId,
    agentId,
    payload,
    missingAttachmentMessage,
  });
  useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
    scopeKey: buildDraftWorkspaceAttachmentScopeKey(draftId),
    attachments: [attachment],
  });
  if (quoteText !== undefined) seedForkQuoteDraft(serverId, draftId, quoteText);
  return draftId;
}

function openForkDraftInNewWorkspace(input: {
  router: ReturnType<typeof useRouter>;
  serverId: string;
  draftId: string;
  agent: ForkAgentSource;
  draftSetup: WorkspaceDraftTabSetup | undefined;
}) {
  const { router, serverId, draftId, agent, draftSetup } = input;
  const sourceDirectory =
    agent.projectPlacement?.checkout?.cwd?.trim() || agent.cwd.trim() || undefined;
  if (draftSetup) {
    useWorkspaceDraftSubmissionStore.getState().setDraftSetup({
      draftId,
      setup: draftSetup,
      sourceDirectory,
    });
  }
  router.push(
    buildNewWorkspaceRoute({
      serverId,
      sourceDirectory,
      displayName: agent.projectPlacement?.projectName,
      projectId: agent.projectPlacement?.projectKey,
      draftId,
    }),
  );
}

/**
 * Shared fork driver behind both turn-footer fork affordances: the completed
 * turn's footer (which supplies a boundary pinned to that turn) and the
 * in-flight turn's footer next to the progress loader (which omits the boundary
 * so the fork captures the still-streaming response).
 */
export function useForkAgent(
  input: UseForkAgentInput,
): (request: ForkAgentRequest) => Promise<void> {
  const { serverId, toast, readOnly = false } = input;
  const { t } = useTranslation();
  const router = useRouter();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const supportsAgentForkContext = useHostFeature(serverId, "agentForkContext") && !readOnly;
  const supportsAgentHierarchyControl = useHostFeature(serverId, "agentHierarchyControl");
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const { preferences } = useFormPreferences();

  return useStableEvent(async (request: ForkAgentRequest) => {
    const { agentId, agent, workspaceId, parentTabId, parentAgentId, target, boundary, quoteText } =
      request;
    try {
      const canForkTarget =
        supportsAgentForkContext && (target !== "subagent" || supportsAgentHierarchyControl);
      if (!canForkTarget) {
        toast?.error(t("message.actions.forkUnavailable"));
        return;
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const draftSetup = resolveForkDraftSetup({
        target,
        agent,
        agentId,
        parentAgentId,
        preferredProvider: preferences.provider,
        unavailableMessage: t("message.actions.forkUnavailable"),
      });
      const prepareDraft = () =>
        prepareForkDraft({
          client,
          serverId,
          agentId,
          boundary,
          quoteText,
          missingAttachmentMessage: t("message.actions.forkFailed"),
        });

      if (target !== "workspace") {
        if (!workspaceId) {
          throw new Error(t("message.actions.forkMissingWorkspace"));
        }
        const draftId = await prepareDraft();
        openForkDraftInWorkspace({
          serverId,
          workspaceId,
          draftTarget: buildForkDraftTabTarget(draftSetup, draftId),
          parentTabId,
          target,
          preferences: openInSidePane,
        });
        return;
      }

      const draftId = await prepareDraft();
      openForkDraftInNewWorkspace({ router, serverId, draftId, agent, draftSetup });
    } catch (error) {
      toast?.error(toErrorMessage(error) || t("message.actions.forkFailed"));
    }
  });
}
