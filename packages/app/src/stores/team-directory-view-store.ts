import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export type TeamDirectoryTab = "messages" | "todos" | "agents";
export type TeamDirectoryAgentGroupMode = "activity" | "attribute";

export const TEAM_DIRECTORY_DEFAULT_WIDTH = 256;
export const TEAM_DIRECTORY_MIN_WIDTH = 200;
export const TEAM_DIRECTORY_MAX_WIDTH = 400;

const TEAM_DIRECTORY_VIEW_STORAGE_KEY = "team-directory-view";
const TEAM_DIRECTORY_VIEW_STORE_VERSION = 1;

const DockWidthSchema = z.number().min(TEAM_DIRECTORY_MIN_WIDTH).max(TEAM_DIRECTORY_MAX_WIDTH);
const TeamDirectoryViewPersistedSchema = z.strictObject({
  activeTab: z.enum(["messages", "todos", "agents"]).optional(),
  agentGroupMode: z.enum(["activity", "attribute"]).optional(),
  dockWidth: DockWidthSchema.optional(),
});

type TeamDirectoryViewPersistedState = z.infer<typeof TeamDirectoryViewPersistedSchema>;

export interface TeamDirectoryViewState {
  activeTab: TeamDirectoryTab;
  agentGroupMode: TeamDirectoryAgentGroupMode;
  dockWidth: number;
  setActiveTab: (tab: TeamDirectoryTab) => void;
  setAgentGroupMode: (mode: TeamDirectoryAgentGroupMode) => void;
  setDockWidth: (width: number) => void;
}

export function createTeamDirectoryViewStore(backingStorage: StateStorage = AsyncStorage) {
  return create<TeamDirectoryViewState>()(
    persist(
      (set) => ({
        activeTab: "agents",
        agentGroupMode: "activity",
        dockWidth: TEAM_DIRECTORY_DEFAULT_WIDTH,
        setActiveTab: (activeTab) => set({ activeTab }),
        setAgentGroupMode: (agentGroupMode) => set({ agentGroupMode }),
        setDockWidth: (dockWidth) => {
          if (DockWidthSchema.safeParse(dockWidth).success) set({ dockWidth });
        },
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
          dockWidth: state.dockWidth,
        }),
      },
    ),
  );
}

export const useTeamDirectoryViewStore = createTeamDirectoryViewStore();
