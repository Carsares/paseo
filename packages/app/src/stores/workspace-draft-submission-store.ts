import {
  AgentForkSourceSchema,
  ForgeSearchItemSchema,
  WorkspaceCreateRequestSchema,
  type AgentSnapshotPayload,
} from "@getpaseo/protocol/messages";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create, type StateCreator } from "zustand";
import { z } from "zod";
import type { ComposerAttachment } from "@/attachments/types";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { generateDraftId } from "./draft-keys";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";

export interface PendingWorkspaceDraftSubmission {
  /** Already-running creation. Mounting the draft only observes its result. */
  agentCreation?: {
    result: Promise<AgentSnapshotPayload>;
  };
  serverId: string;
  workspaceId: string;
  draftId: string;
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
  provider: AgentProvider;
  clientMessageId: string;
  timestamp: number;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  providerOptions?: Record<string, unknown>;
  allowEmptyText?: boolean;
}

export interface PendingWorkspaceDraftSetup {
  setup: WorkspaceDraftTabSetup;
  sourceDirectory?: string | null;
}

const ForkAgentIntentSchema = z.object({
  config: WorkspaceCreateRequestSchema.shape.mainAgent.unwrap().shape.config.pick({
    provider: true,
    cwd: true,
    modeId: true,
    model: true,
    thinkingOptionId: true,
    providerOptions: true,
  }),
  createMainAgent: z.boolean(),
});

export type ForkAgentIntent = z.infer<typeof ForkAgentIntentSchema>;

const ForkWorktreeSubmissionSchema = z.object({
  source: WorkspaceCreateRequestSchema.shape.source.options[1].required({
    cwd: true,
    projectId: true,
    worktreeSlug: true,
  }),
  baseItem: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("branch"),
        name: z.string(),
        refName: z.string(),
        accessibilityLabel: z.string(),
        divergenceLabel: z.string().optional(),
        committerDate: z.number().optional(),
      }),
      z.object({ kind: z.literal("github-pr"), item: ForgeSearchItemSchema }),
    ])
    .nullable(),
  metadata: z.record(z.string(), z.json()),
  // Older worktree drafts stored the agent intent alongside their checkout choices.
  agentIntent: ForkAgentIntentSchema.optional(),
});

export type ForkWorktreeSubmission = z.infer<typeof ForkWorktreeSubmissionSchema>;

const StoredForkDraftSchema = z.object({
  sourceServerId: z.string().min(1),
  sourceDirectory: z.string().nullable(),
  worktreeSlug: z.string().min(1).optional(),
  worktreeSubmission: ForkWorktreeSubmissionSchema.optional(),
  agentIntent: ForkAgentIntentSchema.optional(),
  setup: z.object({
    provider: z.string().min(1),
    cwd: z.string().min(1),
    modeId: z.string().nullable(),
    model: z.string().nullable(),
    thinkingOptionId: z.string().nullable(),
    providerOptions: z.record(z.string(), z.json()),
    forkFrom: AgentForkSourceSchema,
  }),
});

type DraftSetupStatus =
  | "loading"
  | "unavailable"
  | {
      sourceServerId: string | null;
      worktreeSlug?: string;
      worktreeSubmission?: ForkWorktreeSubmission;
      agentIntent?: ForkAgentIntent;
    };

export function readForkAgentIntent(draft: Exclude<DraftSetupStatus, string> | null) {
  return draft?.agentIntent ?? draft?.worktreeSubmission?.agentIntent;
}

const DraftTitleSchema = z.object({
  draftId: z.string().min(1),
  worktreeSlug: z.string().min(1),
  title: z.string(),
  submitted: z.boolean(),
});

export type WorkspaceDraftTitle = z.infer<typeof DraftTitleSchema>;
type DraftStorage = Pick<typeof AsyncStorage, "getItem" | "setItem" | "removeItem">;

interface DraftTitles {
  titlesById: Partial<Record<string, WorkspaceDraftTitle>>;
  openDraftTitle: (input: {
    forkDraftId?: string;
    creationDraftId?: string;
    createWorktreeSlug: () => string;
  }) => Promise<string>;
  editDraftTitle: (id: string, value: string) => Promise<void>;
  submitDraftTitle: (id: string) => Promise<string>;
  finishDraftTitle: (id: string) => Promise<void>;
}

function createDraftTitles(
  storage: DraftStorage,
): StateCreator<WorkspaceDraftSubmissionState, [], [], DraftTitles> {
  // Blur can commit an edit while Submit is already handling the press. Order all
  // reads, writes and cleanup for this draft before sending the first request.
  const pending = new Map<string, Promise<unknown>>();
  function ordered<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = pending.get(key) ?? Promise.resolve();
    const next = previous.then(action, action);
    pending.set(key, next);
    const release = () => {
      if (pending.get(key) === next) pending.delete(key);
    };
    void next.then(release, release);
    return next;
  }
  const storageKey = (key: string) => `paseo:workspace-draft-title:${key}`;
  return (set, get) => {
    const publish = (key: string, record: WorkspaceDraftTitle) =>
      set((state) => ({ titlesById: { ...state.titlesById, [key]: record } }));
    const readStored = async (key: string) => {
      const raw = await storage.getItem(storageKey(key));
      return raw === null ? null : DraftTitleSchema.parse(JSON.parse(raw));
    };
    return {
      titlesById: {},
      openDraftTitle: ({ forkDraftId, creationDraftId, createWorktreeSlug }) => {
        const requested = forkDraftId ?? creationDraftId;
        const id = requested ?? generateDraftId();
        return ordered(id, async () => {
          if (Object.hasOwn(get().titlesById, id)) return id;
          const stored = requested && (await readStored(id));
          if (stored) {
            publish(id, stored);
            return id;
          }
          // Revisiting a consumed ordinary draft URL must not replay its creation.
          const next = creationDraftId && !forkDraftId ? generateDraftId() : id;
          const fork = forkDraftId && get().draftSetupStatusById[forkDraftId];
          const submitted =
            typeof fork === "object" &&
            Boolean(fork.worktreeSlug || fork.worktreeSubmission || readForkAgentIntent(fork));
          const record = {
            draftId: next,
            worktreeSlug: createWorktreeSlug(),
            title: "",
            submitted,
          };
          await storage.setItem(storageKey(next), JSON.stringify(record));
          publish(next, record);
          return next;
        });
      },
      editDraftTitle: (id, value) =>
        ordered(id, async () => {
          const current = get().titlesById[id];
          if (!current || current.submitted) return;
          const stored = await readStored(id);
          if (stored?.submitted) {
            publish(id, stored);
            return;
          }
          const record = { ...current, title: value.trim() };
          publish(id, record);
          await storage.setItem(storageKey(id), JSON.stringify(record));
        }),
      submitDraftTitle: (id) =>
        ordered(id, async () => {
          const current = get().titlesById[id];
          if (!current) throw new Error("The workspace draft has changed.");
          if (current.submitted) return current.title;
          const stored = await readStored(id);
          if (stored?.submitted) {
            publish(id, stored);
            return stored.title;
          }
          const record = { ...current, submitted: true };
          await storage.setItem(storageKey(id), JSON.stringify(record));
          publish(id, record);
          return record.title;
        }),
      finishDraftTitle: (id) =>
        ordered(id, async () => {
          await storage.removeItem(storageKey(id));
          set((state) => {
            const titlesById = { ...state.titlesById };
            delete titlesById[id];
            return { titlesById };
          });
        }),
    };
  };
}

interface WorkspaceDraftSubmissionState extends DraftTitles {
  pendingByDraftId: Record<string, PendingWorkspaceDraftSubmission>;
  setupByDraftId: Record<string, PendingWorkspaceDraftSetup>;
  draftSetupStatusById: Partial<Record<string, DraftSetupStatus>>;
  setPending: (submission: PendingWorkspaceDraftSubmission) => void;
  setDraftSetup: (input: {
    draftId: string;
    setup: WorkspaceDraftTabSetup;
    sourceDirectory?: string | null;
  }) => void;
  saveForkDraftSetup: (
    input: PendingWorkspaceDraftSetup & {
      draftId: string;
      sourceServerId: string;
    },
  ) => Promise<void>;
  recordForkSubmission: (input: {
    draftId: string;
    serverId: string;
    worktree?: ForkWorktreeSubmission;
    agentIntent?: ForkAgentIntent;
  }) => Promise<string | undefined>;
  hydrateDraftSetup: (draftId: string) => Promise<void>;
  clearDraftSetup: (input: { draftId: string }) => Promise<void>;
  consumePending: (input: {
    serverId: string;
    workspaceId: string;
    draftId: string;
  }) => PendingWorkspaceDraftSubmission | null;
}

function matchesPendingSubmission(
  pending: PendingWorkspaceDraftSubmission | null | undefined,
  input: { serverId: string; workspaceId: string; draftId: string },
): pending is PendingWorkspaceDraftSubmission {
  return (
    pending?.serverId === input.serverId &&
    pending.workspaceId === input.workspaceId &&
    pending.draftId === input.draftId
  );
}

function normalizeDraftId(draftId: string): string {
  return draftId.trim();
}

function forkDraftStorageKey(draftId: string): string {
  // Draft IDs are created locally and identify one draft globally. Store each separately
  // so another browser tab creating a draft cannot overwrite this draft's source.
  return `paseo:workspace-fork-draft:${draftId}`;
}

export function createWorkspaceDraftSubmissionStore(storage: DraftStorage = AsyncStorage) {
  const titles = createDraftTitles(storage);
  return create<WorkspaceDraftSubmissionState>((set, get, api) => ({
    ...titles(set, get, api),
    pendingByDraftId: {},
    setupByDraftId: {},
    draftSetupStatusById: {},
    setPending: (submission) =>
      set((state) => ({
        pendingByDraftId: {
          ...state.pendingByDraftId,
          [submission.draftId]: submission,
        },
      })),
    setDraftSetup: ({ draftId, setup, sourceDirectory }) => {
      const normalizedDraftId = normalizeDraftId(draftId);
      if (!normalizedDraftId) return;
      set((state) => ({
        setupByDraftId: {
          ...state.setupByDraftId,
          [normalizedDraftId]: { setup, sourceDirectory: sourceDirectory ?? null },
        },
        draftSetupStatusById: {
          ...state.draftSetupStatusById,
          [normalizedDraftId]: { sourceServerId: null },
        },
      }));
    },
    saveForkDraftSetup: async ({ draftId, sourceServerId, setup, sourceDirectory }) => {
      const id = normalizeDraftId(draftId);
      const stored = StoredForkDraftSchema.parse(
        JSON.parse(
          JSON.stringify({ sourceServerId, setup, sourceDirectory: sourceDirectory ?? null }),
        ),
      );
      await storage.setItem(forkDraftStorageKey(id), JSON.stringify(stored));
      set((state) => {
        return {
          setupByDraftId: {
            ...state.setupByDraftId,
            [id]: { setup, sourceDirectory: stored.sourceDirectory },
          },
          draftSetupStatusById: { ...state.draftSetupStatusById, [id]: { sourceServerId } },
        };
      });
    },
    recordForkSubmission: async ({ draftId, serverId, worktree, agentIntent }) => {
      const id = normalizeDraftId(draftId);
      const status = get().draftSetupStatusById[id];
      if (typeof status !== "object" || status.sourceServerId !== serverId) {
        throw new Error("The Fork draft is not available on this host.");
      }
      // Read the saved source here so this record doesn't replace the setup used
      // to track ownership of the composer's draft and attachments.
      const raw = await storage.getItem(forkDraftStorageKey(id));
      const stored = StoredForkDraftSchema.parse(raw === null ? null : JSON.parse(raw));
      if (stored.sourceServerId !== serverId || get().draftSetupStatusById[id] !== status) {
        throw new Error("The Fork draft changed before it was submitted.");
      }
      const slug =
        stored.worktreeSubmission?.source.worktreeSlug ??
        stored.worktreeSlug ??
        worktree?.source.worktreeSlug;
      // Keep the first submission for recovery. Later edits go to the host under the
      // same request key, where they can be compared with the accepted request.
      if (readForkAgentIntent(stored)) return slug;
      const savedWorktree =
        stored.worktreeSubmission ??
        (worktree && slug
          ? ForkWorktreeSubmissionSchema.parse({
              ...worktree,
              source: { ...worktree.source, worktreeSlug: slug },
            })
          : undefined);
      const savedIntent = agentIntent && ForkAgentIntentSchema.parse(agentIntent);
      if (!savedIntent && savedWorktree === stored.worktreeSubmission) return slug;
      const submission = {
        ...(savedWorktree && {
          worktreeSlug: savedWorktree.source.worktreeSlug,
          worktreeSubmission: savedWorktree,
        }),
        ...(savedIntent && { agentIntent: savedIntent }),
      };
      await storage.setItem(forkDraftStorageKey(id), JSON.stringify({ ...stored, ...submission }));
      set((state) => {
        if (state.draftSetupStatusById[id] !== status) return state;
        return {
          draftSetupStatusById: {
            ...state.draftSetupStatusById,
            [id]: { ...status, ...submission },
          },
        };
      });
      return slug;
    },
    hydrateDraftSetup: async (draftId) => {
      const id = normalizeDraftId(draftId);
      if (!id || Object.hasOwn(get().draftSetupStatusById, id)) return;
      set((state) => ({
        draftSetupStatusById: { ...state.draftSetupStatusById, [id]: "loading" },
      }));

      let status: DraftSetupStatus = "unavailable";
      let pending: PendingWorkspaceDraftSetup | null = null;
      try {
        const raw = await storage.getItem(forkDraftStorageKey(id));
        if (raw === null) {
          status = { sourceServerId: null };
        } else {
          const stored = StoredForkDraftSchema.parse(JSON.parse(raw));
          status = {
            sourceServerId: stored.sourceServerId,
            ...(stored.worktreeSlug ? { worktreeSlug: stored.worktreeSlug } : {}),
            ...(stored.worktreeSubmission ? { worktreeSubmission: stored.worktreeSubmission } : {}),
            ...(stored.agentIntent ? { agentIntent: stored.agentIntent } : {}),
          };
          pending = { setup: stored.setup, sourceDirectory: stored.sourceDirectory };
        }
      } catch {
        // An unreadable source must not turn a Fork into ordinary workspace creation.
      }
      set((state) => {
        if (state.draftSetupStatusById[id] !== "loading") return state;
        return {
          draftSetupStatusById: { ...state.draftSetupStatusById, [id]: status },
          ...(pending ? { setupByDraftId: { ...state.setupByDraftId, [id]: pending } } : {}),
        };
      });
    },
    clearDraftSetup: async ({ draftId }) => {
      const id = normalizeDraftId(draftId);
      if (!id) return;
      const status = Object.hasOwn(get().draftSetupStatusById, id)
        ? get().draftSetupStatusById[id]
        : undefined;
      set((state) => {
        const setupByDraftId = { ...state.setupByDraftId };
        delete setupByDraftId[id];
        return {
          setupByDraftId,
          draftSetupStatusById: { ...state.draftSetupStatusById, [id]: { sourceServerId: null } },
        };
      });
      // The destination may finish after a reload without ever reopening /new.
      try {
        const finishTitle = get().finishDraftTitle;
        await Promise.all([
          finishTitle(id),
          ...(typeof status === "object" && status.sourceServerId === null
            ? []
            : [storage.removeItem(forkDraftStorageKey(id))]),
        ]);
      } catch {
        // Cleanup failure must not turn a successful creation into a failed submit.
      }
    },
    consumePending: (input) => {
      const pending = get().pendingByDraftId[input.draftId];
      if (!matchesPendingSubmission(pending, input)) {
        return null;
      }
      set((state) => {
        if (!matchesPendingSubmission(state.pendingByDraftId[input.draftId], input)) {
          return state;
        }
        // Expo miscompiles computed member-key rest omissions; test the emitted code.
        const pendingByDraftId = { ...state.pendingByDraftId };
        delete pendingByDraftId[input.draftId];
        return { pendingByDraftId };
      });
      return pending;
    },
  }));
}

export const useWorkspaceDraftSubmissionStore = createWorkspaceDraftSubmissionStore();
