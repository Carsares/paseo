import { AgentForkSourceSchema, type AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { z } from "zod";
import type { ComposerAttachment } from "@/attachments/types";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
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

const StoredForkDraftSchema = z.object({
  sourceServerId: z.string().min(1),
  sourceDirectory: z.string().nullable(),
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

type DraftSetupStatus = "loading" | "unavailable" | { sourceServerId: string | null };

interface WorkspaceDraftSubmissionState {
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

export function createWorkspaceDraftSubmissionStore(
  storage: Pick<typeof AsyncStorage, "getItem" | "setItem" | "removeItem"> = AsyncStorage,
) {
  return create<WorkspaceDraftSubmissionState>((set, get) => ({
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
          status = { sourceServerId: stored.sourceServerId };
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
      if (typeof status === "object" && status.sourceServerId === null) {
        return;
      }
      // The destination draft may finish after a reload without opening /new again.
      try {
        await storage.removeItem(forkDraftStorageKey(id));
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
