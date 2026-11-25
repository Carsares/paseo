import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const SIDEBAR_TOPIC_COMPLETION_STORAGE_KEY = "sidebar-topic-completion";
const SIDEBAR_TOPIC_COMPLETION_STORE_VERSION = 1;
const MAX_STORED_COMPLETIONS = 500;

const SidebarTopicCompletionPersistedSchema = z.strictObject({
  completedAtByWorkspaceKey: z.record(z.string(), z.string()).optional(),
  lastWorkAtByWorkspaceKey: z.record(z.string(), z.string()).optional(),
});

type SidebarTopicCompletionPersistedState = z.infer<typeof SidebarTopicCompletionPersistedSchema>;

export interface SidebarTopicCompletionState {
  completedAtByWorkspaceKey: Record<string, string>;
  lastWorkAtByWorkspaceKey: Record<string, string>;
  markTopicCompleted: (workspaceKey: string, completedAtIso?: string) => void;
  reopenTopic: (workspaceKey: string, expectedCompletedAtIso?: string) => void;
  recordTopicWorkSignals: (signalsByWorkspaceKey: Readonly<Record<string, number>>) => void;
}

/**
 * Resolves the active completion timestamp for a topic workspace.
 * Only work/approval signals occurring strictly after `completedAtIso` reactivate the topic.
 */
export function resolveActiveTopicCompletedAt(input: {
  completedAtIso: string | undefined;
  latestReactivationAtMs?: number | null | undefined;
}): Date | null {
  if (!input.completedAtIso) return null;
  const completedMs = Date.parse(input.completedAtIso);
  if (!Number.isFinite(completedMs)) return null;
  if (
    typeof input.latestReactivationAtMs === "number" &&
    input.latestReactivationAtMs > completedMs
  ) {
    return null;
  }
  return new Date(completedMs);
}

function boundCompletionMap(entries: Record<string, string>): Record<string, string> {
  const pairs = Object.entries(entries);
  if (pairs.length <= MAX_STORED_COMPLETIONS) return entries;
  pairs.sort((left, right) => right[1].localeCompare(left[1]));
  return Object.fromEntries(pairs.slice(0, MAX_STORED_COMPLETIONS));
}

function applyWorkSignalsToCompletionState(
  state: Pick<
    SidebarTopicCompletionState,
    "completedAtByWorkspaceKey" | "lastWorkAtByWorkspaceKey"
  >,
  signalsByWorkspaceKey: Readonly<Record<string, number>>,
): {
  completedAtByWorkspaceKey: Record<string, string>;
  lastWorkAtByWorkspaceKey: Record<string, string>;
} | null {
  let nextWork: Record<string, string> | null = null;
  let nextCompleted: Record<string, string> | null = null;

  for (const [workspaceKey, signalMs] of Object.entries(signalsByWorkspaceKey)) {
    if (!Number.isFinite(signalMs)) continue;
    const prevWorkIso = state.lastWorkAtByWorkspaceKey[workspaceKey];
    const prevWorkMs = prevWorkIso ? Date.parse(prevWorkIso) : -Infinity;
    if (!Number.isFinite(prevWorkMs) || signalMs > prevWorkMs) {
      nextWork ??= { ...state.lastWorkAtByWorkspaceKey };
      nextWork[workspaceKey] = new Date(signalMs).toISOString();
    }
    const completedIso = (nextCompleted ?? state.completedAtByWorkspaceKey)[workspaceKey];
    if (completedIso) {
      const completedMs = Date.parse(completedIso);
      if (!Number.isFinite(completedMs) || signalMs > completedMs) {
        nextCompleted ??= { ...state.completedAtByWorkspaceKey };
        delete nextCompleted[workspaceKey];
      }
    }
  }

  if (!nextWork && !nextCompleted) return null;
  return {
    completedAtByWorkspaceKey: nextCompleted ?? state.completedAtByWorkspaceKey,
    lastWorkAtByWorkspaceKey: nextWork
      ? boundCompletionMap(nextWork)
      : state.lastWorkAtByWorkspaceKey,
  };
}

export function createSidebarTopicCompletionStore(backingStorage: StateStorage = AsyncStorage) {
  return create<SidebarTopicCompletionState>()(
    persist(
      (set) => ({
        completedAtByWorkspaceKey: {},
        lastWorkAtByWorkspaceKey: {},
        markTopicCompleted: (workspaceKey, completedAtIso) =>
          set((state) => {
            const iso = completedAtIso ?? new Date().toISOString();
            if (state.completedAtByWorkspaceKey[workspaceKey] === iso) return state;
            return {
              completedAtByWorkspaceKey: boundCompletionMap({
                ...state.completedAtByWorkspaceKey,
                [workspaceKey]: iso,
              }),
            };
          }),
        reopenTopic: (workspaceKey, expectedCompletedAtIso) =>
          set((state) => {
            const current = state.completedAtByWorkspaceKey[workspaceKey];
            if (current === undefined) return state;
            if (expectedCompletedAtIso !== undefined && current !== expectedCompletedAtIso) {
              return state;
            }
            const next = { ...state.completedAtByWorkspaceKey };
            delete next[workspaceKey];
            return { completedAtByWorkspaceKey: next };
          }),
        recordTopicWorkSignals: (signalsByWorkspaceKey) =>
          set((state) => applyWorkSignalsToCompletionState(state, signalsByWorkspaceKey) ?? state),
      }),
      {
        name: SIDEBAR_TOPIC_COMPLETION_STORAGE_KEY,
        version: SIDEBAR_TOPIC_COMPLETION_STORE_VERSION,
        storage: createValidatedPersistStorage<SidebarTopicCompletionPersistedState>(
          backingStorage,
          SidebarTopicCompletionPersistedSchema,
        ),
        partialize: (state) => ({
          completedAtByWorkspaceKey: state.completedAtByWorkspaceKey,
          lastWorkAtByWorkspaceKey: state.lastWorkAtByWorkspaceKey,
        }),
      },
    ),
  );
}

export const useSidebarTopicCompletionStore = createSidebarTopicCompletionStore();
