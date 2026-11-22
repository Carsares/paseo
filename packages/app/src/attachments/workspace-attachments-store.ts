import { useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ReviewAttachmentSchema, TextAttachmentSchema } from "@getpaseo/protocol/messages";
import { create } from "zustand";
import { useShallow } from "zustand/shallow";
import { z } from "zod";
import { AttachmentMetadataSchema } from "@/stores/draft-store/state";
import type { WorkspaceComposerAttachment } from "./types";

const EMPTY_WORKSPACE_ATTACHMENTS: readonly WorkspaceComposerAttachment[] = [];
const DRAFT_SCOPE_PREFIX = "workspace-attachments:draft=";
const STORAGE_KEY = "paseo:draft-chat-history-attachments";
const ChatHistoryAttachmentSchema = z.object({
  kind: z.literal("chat_history"),
  id: z.string(),
  attachment: TextAttachmentSchema,
  source: z.object({
    serverId: z.string(),
    agentId: z.string(),
    boundaryMessageId: z.string().nullish(),
    boundaryCursor: z.object({ epoch: z.string(), seq: z.number().int().nonnegative() }).nullish(),
    itemCount: z.number().int().nonnegative().optional(),
  }),
});
const WorkspaceAttachmentSchema: z.ZodType<WorkspaceComposerAttachment> = z.union([
  ChatHistoryAttachmentSchema,
  z.object({
    kind: z.literal("review"),
    attachment: ReviewAttachmentSchema,
    reviewDraftKey: z.string(),
    commentCount: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.enum([
      "forge.change_request_comment",
      "forge.change_request_review",
      "forge.change_request_check",
      "github.pull_request_comment",
      "github.pull_request_review",
      "github.pull_request_check",
    ]),
    id: z.string(),
    title: z.string(),
    subtitle: z.string().optional(),
    text: z.string(),
    url: z.string().nullish(),
  }),
  z.object({
    kind: z.literal("browser_element"),
    attachment: z.object({
      url: z.string(),
      selector: z.string(),
      tag: z.string(),
      text: z.string(),
      outerHTML: z.string(),
      computedStyles: z.record(z.string(), z.string()),
      boundingRect: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
      reactSource: z
        .object({
          fileName: z.string().nullable(),
          lineNumber: z.number().nullable(),
          columnNumber: z.number().nullable(),
          componentName: z.string().nullable(),
        })
        .nullable(),
      parentChain: z.array(z.string()),
      children: z.array(z.string()),
      comment: z.string().optional(),
      screenshot: AttachmentMetadataSchema.optional(),
      formatted: z.string(),
    }),
  }),
]);
const StoredAttachmentsSchema = z.record(z.string(), z.array(z.unknown()));

export interface WorkspaceAttachmentScopeInput {
  kind?: "workspace";
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
}

export interface DraftWorkspaceAttachmentScopeInput {
  kind: "draft";
  draftId: string;
}

export type WorkspaceAttachmentScope =
  | WorkspaceAttachmentScopeInput
  | DraftWorkspaceAttachmentScopeInput;

interface WorkspaceAttachmentsStoreState {
  attachmentsByScope: Record<string, readonly WorkspaceComposerAttachment[]>;
  draftHistoryHydrated: boolean;
}

interface WorkspaceAttachmentsStoreActions {
  setWorkspaceAttachments: (input: {
    scopeKey: string;
    attachments: readonly WorkspaceComposerAttachment[];
  }) => void;
  addWorkspaceAttachment: (input: {
    scopeKey: string;
    attachment: WorkspaceComposerAttachment;
  }) => void;
  clearWorkspaceAttachments: (input: { scopeKey: string }) => void;
  clearDraftChatHistory: (input: { draftId: string }) => void;
}

type WorkspaceAttachmentsStore = WorkspaceAttachmentsStoreState & WorkspaceAttachmentsStoreActions;

function encodeScopePart(value: string): string {
  return encodeURIComponent(value.trim());
}

function normalizeCwd(cwd: string): string {
  const trimmed = cwd.trim();
  if (trimmed === "/") {
    return trimmed;
  }
  return trimmed.replace(/\/+$/, "");
}

export function buildWorkspaceAttachmentScopeKey(input: WorkspaceAttachmentScopeInput): string {
  const workspaceId = input.workspaceId?.trim();
  // workspaceId is opaque; do not parse this key back into a path.
  const workspacePart = workspaceId
    ? `workspace=${encodeScopePart(workspaceId)}`
    : `cwd=${encodeScopePart(normalizeCwd(input.cwd))}`;

  return ["workspace-attachments", `server=${encodeScopePart(input.serverId)}`, workspacePart].join(
    ":",
  );
}

export function buildDraftWorkspaceAttachmentScopeKey(draftId: string): string {
  return `${DRAFT_SCOPE_PREFIX}${encodeScopePart(draftId)}`;
}

function areWorkspaceAttachmentsEqual(
  left: readonly WorkspaceComposerAttachment[],
  right: readonly WorkspaceComposerAttachment[],
): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((attachment, index) => attachment === right[index]);
}

function getContextAttachmentKey(attachment: WorkspaceComposerAttachment): string | null {
  if (
    attachment.kind !== "chat_history" &&
    attachment.kind !== "forge.change_request_comment" &&
    attachment.kind !== "forge.change_request_review" &&
    attachment.kind !== "forge.change_request_check" &&
    attachment.kind !== "github.pull_request_comment" &&
    attachment.kind !== "github.pull_request_review" &&
    attachment.kind !== "github.pull_request_check"
  ) {
    return null;
  }
  return JSON.stringify({
    kind: attachment.kind,
    id: attachment.id,
  });
}

export function appendWorkspaceAttachment(
  current: readonly WorkspaceComposerAttachment[],
  attachment: WorkspaceComposerAttachment,
): WorkspaceComposerAttachment[] {
  const contextKey = getContextAttachmentKey(attachment);
  if (contextKey === null) {
    return [...current, attachment];
  }

  const next = current.filter(
    (currentAttachment) => getContextAttachmentKey(currentAttachment) !== contextKey,
  );
  return [...next, attachment];
}

export function createWorkspaceAttachmentsStore(
  storage: Pick<typeof AsyncStorage, "getItem" | "setItem" | "removeItem"> = AsyncStorage,
) {
  // A clear before hydration is an intentional edit even if the in-memory scope is empty.
  const editedBeforeHydration = new Set<string>();
  let lastStored: string | null = null;
  let writes = Promise.resolve();
  const store = create<WorkspaceAttachmentsStore>()((set, get) => ({
    attachmentsByScope: {},
    draftHistoryHydrated: false,
    setWorkspaceAttachments: ({ scopeKey, attachments }) => {
      const { attachmentsByScope, draftHistoryHydrated } = get();
      const current = attachmentsByScope[scopeKey] ?? EMPTY_WORKSPACE_ATTACHMENTS;
      const changed =
        attachments.length === 0
          ? Object.hasOwn(attachmentsByScope, scopeKey)
          : !areWorkspaceAttachmentsEqual(current, attachments);
      if (scopeKey.startsWith(DRAFT_SCOPE_PREFIX) && (changed || !draftHistoryHydrated)) {
        if (!draftHistoryHydrated) editedBeforeHydration.add(scopeKey);
        queueWrite();
      }
      if (!changed) return;
      set((state) => {
        const next = { ...state.attachmentsByScope };
        if (attachments.length > 0) next[scopeKey] = attachments;
        else delete next[scopeKey];
        return { attachmentsByScope: next };
      });
    },
    addWorkspaceAttachment: ({ scopeKey, attachment }) => {
      const current = get().attachmentsByScope[scopeKey] ?? EMPTY_WORKSPACE_ATTACHMENTS;
      get().setWorkspaceAttachments({
        scopeKey,
        attachments: appendWorkspaceAttachment(current, attachment),
      });
    },
    clearWorkspaceAttachments: ({ scopeKey }) => {
      get().setWorkspaceAttachments({ scopeKey, attachments: EMPTY_WORKSPACE_ATTACHMENTS });
    },
    clearDraftChatHistory: ({ draftId }) => {
      const scopeKey = buildDraftWorkspaceAttachmentScopeKey(draftId);
      const current = get().attachmentsByScope[scopeKey] ?? EMPTY_WORKSPACE_ATTACHMENTS;
      get().setWorkspaceAttachments({
        scopeKey,
        attachments: current.some((item) => item.kind === "chat_history")
          ? current.filter((item) => item.kind !== "chat_history")
          : current,
      });
    },
  }));

  async function hydrate() {
    let attachmentsByScope: WorkspaceAttachmentsStoreState["attachmentsByScope"] | undefined;
    try {
      lastStored = await storage.getItem(STORAGE_KEY);
      if (!lastStored) return;
      const result = StoredAttachmentsSchema.safeParse(JSON.parse(lastStored));
      if (!result.success) return;
      const current = store.getState().attachmentsByScope;
      const restored = { ...current };
      for (const [scopeKey, values] of Object.entries(result.data)) {
        if (
          !scopeKey.startsWith(DRAFT_SCOPE_PREFIX) ||
          editedBeforeHydration.has(scopeKey) ||
          Object.hasOwn(current, scopeKey)
        )
          continue;
        const attachments = values.flatMap((value) => {
          const parsed = WorkspaceAttachmentSchema.safeParse(value);
          if (!parsed.success) return [];
          if (
            parsed.data.kind === "chat_history" &&
            parsed.data.attachment.contextKind !== "chat_history"
          )
            return [];
          return [parsed.data];
        });
        if (attachments.length > 0) restored[scopeKey] = attachments;
      }
      attachmentsByScope = restored;
    } catch {
      // Unreadable storage does not prevent the composer from using its in-memory attachments.
    } finally {
      editedBeforeHydration.clear();
      store.setState({
        draftHistoryHydrated: true,
        ...(attachmentsByScope ? { attachmentsByScope } : {}),
      });
    }
  }
  const hydration = hydrate();

  async function writeDraftAttachments() {
    await hydration;
    const persisted = Object.entries(store.getState().attachmentsByScope).flatMap(
      ([key, values]) => {
        return key.startsWith(DRAFT_SCOPE_PREFIX) && values.length > 0
          ? [[key, values] as const]
          : [];
      },
    );
    const next = persisted.length > 0 ? JSON.stringify(Object.fromEntries(persisted)) : null;
    if (next === lastStored) return;
    if (next === null) await storage.removeItem(STORAGE_KEY);
    else await storage.setItem(STORAGE_KEY, next);
    lastStored = next;
  }

  function queueWrite() {
    writes = writes.then(writeDraftAttachments).catch(() => {
      // Keep accepting edits if the storage operation fails.
    });
  }

  return Object.assign(store, { hydration });
}

export const useWorkspaceAttachmentsStore = createWorkspaceAttachmentsStore();

export function isDraftChatHistoryReady(
  state: WorkspaceAttachmentsStoreState,
  scopeKey: string,
): boolean {
  return (
    state.draftHistoryHydrated ||
    state.attachmentsByScope[scopeKey]?.some((item) => item.kind === "chat_history") === true
  );
}

export function useWorkspaceAttachmentScopeKey(input: WorkspaceAttachmentScope): string {
  const isDraftScope = input.kind === "draft";
  const draftId = isDraftScope ? input.draftId : "";
  const serverId = isDraftScope ? "" : input.serverId;
  const workspaceId = isDraftScope ? undefined : input.workspaceId;
  const cwd = isDraftScope ? "" : input.cwd;
  return useMemo(() => {
    if (isDraftScope) {
      return buildDraftWorkspaceAttachmentScopeKey(draftId);
    }
    return buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd });
  }, [cwd, draftId, isDraftScope, serverId, workspaceId]);
}

export function useDraftWorkspaceAttachmentScopeKey(draftId: string | null | undefined): string {
  const normalizedDraftId = useMemo(() => draftId?.trim() ?? "", [draftId]);
  return useMemo(
    () => (normalizedDraftId ? buildDraftWorkspaceAttachmentScopeKey(normalizedDraftId) : ""),
    [normalizedDraftId],
  );
}

export function useWorkspaceAttachments(scopeKey: string): readonly WorkspaceComposerAttachment[] {
  return useWorkspaceAttachmentsStore(
    (state) => state.attachmentsByScope[scopeKey] ?? EMPTY_WORKSPACE_ATTACHMENTS,
  );
}

export function collectWorkspaceAttachmentsForScopes(input: {
  attachmentsByScope: Record<string, readonly WorkspaceComposerAttachment[]>;
  scopeKeys: readonly string[];
}): readonly WorkspaceComposerAttachment[] {
  const attachments: WorkspaceComposerAttachment[] = [];
  for (const scopeKey of input.scopeKeys) {
    const normalizedScopeKey = scopeKey.trim();
    if (!normalizedScopeKey) {
      continue;
    }
    attachments.push(
      ...(input.attachmentsByScope[normalizedScopeKey] ?? EMPTY_WORKSPACE_ATTACHMENTS),
    );
  }
  return attachments;
}

export function useWorkspaceAttachmentsForScopes(
  scopeKeys: readonly string[] | undefined,
): readonly WorkspaceComposerAttachment[] {
  const normalizedScopeKeys = useMemo(
    () => (scopeKeys ?? []).map((scopeKey) => scopeKey.trim()).filter(Boolean),
    [scopeKeys],
  );
  const attachmentsByScope = useWorkspaceAttachmentsStore(
    useShallow((state) => state.attachmentsByScope),
  );
  return useMemo(
    () =>
      collectWorkspaceAttachmentsForScopes({
        attachmentsByScope,
        scopeKeys: normalizedScopeKeys,
      }),
    [attachmentsByScope, normalizedScopeKeys],
  );
}

export function resetWorkspaceAttachmentsStore(): void {
  useWorkspaceAttachmentsStore.setState({ attachmentsByScope: {} });
}
