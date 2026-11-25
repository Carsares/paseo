import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { flushDraftPersistStorage, useDraftStore } from "@/stores/draft-store";
import { isWeb } from "@/constants/platform";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";

/**
 * The ready workspace's draft tab owns the draft once New workspace hands it off, including a
 * retry after the first agent start fails. Its metadata moves with it, like its text and setup.
 */
export function handOffDraftMetadata(input: {
  serverId: string;
  draftId: string;
  metadata: Readonly<Record<string, JsonValue>>;
}): void {
  if (Object.keys(input.metadata).length === 0) return;
  useDraftStore.getState().patchDraftMetadata({
    draftKey: buildDraftStoreKey({
      serverId: input.serverId,
      agentId: input.draftId,
      draftId: input.draftId,
    }),
    patch: { ...input.metadata },
  });
}

interface WorkspaceDraftCleanupInput {
  draftId?: string;
  draftKey: string;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  draftContextScopeKey: string | null;
}

type WorkspaceDraftCleanupScope = Omit<WorkspaceDraftCleanupInput, "clearDraft">;

export function captureWorkspaceDraftCleanupOwner(input: WorkspaceDraftCleanupScope) {
  const draft = useDraftStore.getState();
  const record = draft.drafts[input.draftKey];
  return JSON.stringify({
    draftKey: input.draftKey,
    draftId: input.draftId,
    scopeKey: input.draftContextScopeKey,
    record,
    metadata: draft.metadataByDraftKey[input.draftKey],
    setup: useWorkspaceDraftSubmissionStore.getState().setupByDraftId[input.draftId ?? ""],
    attachments:
      useWorkspaceAttachmentsStore.getState().attachmentsByScope[input.draftContextScopeKey ?? ""],
  });
}

/** Store ownership with the original submission before any request can leave the app. */
export async function saveWorkspaceDraftCleanupOwner(
  id: string,
  captured: string | undefined,
): Promise<void> {
  const owner = captured === undefined ? undefined : await digestCleanupOwner(captured);
  if (owner) await flushDraftPersistStorage();
  await useWorkspaceDraftSubmissionStore.getState().saveDraftCleanupOwner(id, owner);
}

async function digestCleanupOwner(contents: string) {
  try {
    if (isWeb) {
      const buffer = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(contents),
      );
      return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
    }
    const { CryptoDigestAlgorithm, digestStringAsync } = await import("expo-crypto");
    return await digestStringAsync(CryptoDigestAlgorithm.SHA256, contents);
  } catch {
    return undefined;
  }
}

export async function clearOwnedWorkspaceDraft(
  id: string,
  input: WorkspaceDraftCleanupInput,
): Promise<void> {
  const owner = await useWorkspaceDraftSubmissionStore.getState().readDraftCleanupOwner(id);
  if (!owner) return;
  const current = captureWorkspaceDraftCleanupOwner(input);
  if ((await digestCleanupOwner(current)) !== owner) return;
  // Another browser window can persist a newer body while this window still holds the old one.
  const { name, storage } = useDraftStore.persist.getOptions();
  const stored =
    name && storage ? await Promise.resolve(storage.getItem(name)).catch(() => null) : null;
  const record = stored?.state.drafts?.[input.draftKey];
  const live = useDraftStore.getState().drafts[input.draftKey];
  if (
    JSON.stringify(record) !== JSON.stringify(live) ||
    captureWorkspaceDraftCleanupOwner(input) !== current
  )
    return;
  if (input.draftContextScopeKey) {
    useWorkspaceAttachmentsStore.getState().clearWorkspaceAttachments({
      scopeKey: input.draftContextScopeKey,
    });
  }
  input.clearDraft("sent");
}

/** Capture ownership before workspace creation starts, not when its response arrives. */
export function captureWorkspaceDraftCleanup(input: WorkspaceDraftCleanupInput): () => void {
  const draftId = input.draftId?.trim() ?? "";
  const scopeKey = input.draftContextScopeKey ?? "";
  const draftVersion = useDraftStore.getState().drafts[input.draftKey]?.version;
  const setup = useWorkspaceDraftSubmissionStore.getState().setupByDraftId[draftId];
  const attachments = useWorkspaceAttachmentsStore.getState().attachmentsByScope[scopeKey];

  return () => {
    // These stores update independently. A context-only edit does not bump the text version.
    // Any newer draft state owns the whole draft, including its unchanged context.
    if (
      useDraftStore.getState().drafts[input.draftKey]?.version !== draftVersion ||
      useWorkspaceDraftSubmissionStore.getState().setupByDraftId[draftId] !== setup ||
      useWorkspaceAttachmentsStore.getState().attachmentsByScope[scopeKey] !== attachments
    ) {
      return;
    }
    useWorkspaceDraftSubmissionStore.getState().clearDraftSetup({ draftId });
    if (scopeKey) {
      useWorkspaceAttachmentsStore.getState().clearWorkspaceAttachments({ scopeKey });
    }
    input.clearDraft("sent");
  };
}

/**
 * The workspace draft tab normally issues create_agent once it mounts on the destination screen.
 * When the user leaves the New workspace screen before creation resolves, that tab never mounts,
 * so this path issues the request itself. The agent tab opens on its own when the workspace is
 * next visited — `reconcileTabs` auto-opens agents.
 *
 * The caller must not write a pending entry to the draft-submission or create-flow stores on this
 * path: those drive the draft tab's auto-submit, and the daemon does not dedupe create_agent by
 * clientMessageId, so a leftover entry would create a second agent when the workspace is opened.
 */
export async function createWorkspaceAgentInBackground(input: {
  clearConsumedDraft: () => void;
  createAgent: () => Promise<unknown>;
}): Promise<void> {
  await input.createAgent();
  input.clearConsumedDraft();
}
