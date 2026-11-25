import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export type TeamDirectoryTab = "messages" | "agents";
export type TeamDirectoryAgentGroupMode = "activity" | "attribute";

const TEAM_DIRECTORY_VIEW_STORAGE_KEY = "team-directory-view";
const TEAM_DIRECTORY_VIEW_STORE_VERSION = 1;

const TeamDirectoryViewPersistedSchema = z.strictObject({
  activeTab: z.enum(["messages", "agents"]).optional(),
  agentGroupMode: z.enum(["activity", "attribute"]).optional(),
});

type TeamDirectoryViewPersistedState = z.infer<typeof TeamDirectoryViewPersistedSchema>;

export interface TeamDirectoryViewState {
  activeTab: TeamDirectoryTab;
  agentGroupMode: TeamDirectoryAgentGroupMode;
  setActiveTab: (tab: TeamDirectoryTab) => void;
  setAgentGroupMode: (mode: TeamDirectoryAgentGroupMode) => void;
}

export function createTeamDirectoryViewStore(backingStorage: StateStorage = AsyncStorage) {
  return create<TeamDirectoryViewState>()(
    persist(
      (set) => ({
        activeTab: "agents",
        agentGroupMode: "activity",
        setActiveTab: (activeTab) => set({ activeTab }),
        setAgentGroupMode: (agentGroupMode) => set({ agentGroupMode }),
      }),
      {
        name: TEAM_DIRECTORY_VIEW_STORAGE_KEY,
        version: TEAM_DIRECTORY_VIEW_STORE_VERSION,
        storage: createValidatedPersistStorage<TeamDirectoryViewPersistedState>(
          backingStorage,
          TeamDirectoryViewPersistedSchema,
        ),
        partialize: (state) => ({
          activeTab: state.activeTab,
          agentGroupMode: state.agentGroupMode,
        }),
      },
    ),
  );
}

export const useTeamDirectoryViewStore = createTeamDirectoryViewStore();
