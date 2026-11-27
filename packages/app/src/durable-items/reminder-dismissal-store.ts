import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const PersistedDismissalsSchema = z.strictObject({
  revisions: z.record(z.string(), z.number().int().nonnegative()),
});

type PersistedDismissals = z.infer<typeof PersistedDismissalsSchema>;

interface ReminderDismissalsState {
  // null until local storage is read, so dismissed cards do not flash on startup.
  revisions: PersistedDismissals["revisions"] | null;
  dismiss: (key: string, revision: number) => void;
}

export function createReminderDismissalStore(backingStorage: StateStorage = AsyncStorage) {
  const storage = createValidatedPersistStorage(backingStorage, PersistedDismissalsSchema);
  return create<ReminderDismissalsState>()(
    persist(
      (set, get) => ({
        revisions: null,
        dismiss: (key, revision) => {
          const { revisions } = get();
          if (!revisions || (revisions[key] ?? -1) >= revision) return;
          set({ revisions: { ...revisions, [key]: revision } });
        },
      }),
      {
        name: "durable-item-reminder-dismissals",
        version: 1,
        storage: {
          ...storage,
          getItem: async (name) => {
            try {
              return await storage.getItem(name);
            } catch {
              return null;
            }
          },
          setItem: async (name, value) => {
            try {
              await storage.setItem(name, value);
            } catch {
              // Keep the reminder hidden for this session if device storage is unavailable.
            }
          },
        },
        partialize: ({ revisions }) => ({ revisions: revisions ?? {} }),
        merge: (persisted, current) => ({
          ...current,
          revisions: {
            ...(persisted as PersistedDismissals | undefined)?.revisions,
            ...current.revisions,
          },
        }),
      },
    ),
  );
}

export const useReminderDismissalStore = createReminderDismissalStore();
