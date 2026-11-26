import { expect, it } from "vitest";
import {
  createTeamDirectoryViewStore,
  TEAM_DIRECTORY_DEFAULT_WIDTH,
} from "./team-directory-view-store";

const key = "team-directory-view";

function createStorage(state: object) {
  const values = new Map([[key, JSON.stringify({ version: 1, state })]]);
  return {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => {
      values.set(name, value);
    },
    removeItem: (name: string) => {
      values.delete(name);
    },
  };
}

it("keeps existing directory view preferences and persists dock width with them", async () => {
  const storage = createStorage({ activeTab: "todos", agentGroupMode: "attribute" });
  const store = createTeamDirectoryViewStore(storage);
  await store.persist.rehydrate();
  expect(store.getState().dockWidth).toBe(TEAM_DIRECTORY_DEFAULT_WIDTH);
  store.getState().setDockWidth(340);

  expect(JSON.parse(storage.getItem(key)!)).toEqual({
    version: 1,
    state: { activeTab: "todos", agentGroupMode: "attribute", dockWidth: 340 },
  });
  const restored = createTeamDirectoryViewStore(storage);
  await restored.persist.rehydrate();
  expect(restored.getState().dockWidth).toBe(340);
});

it("rejects an invalid stored width and does not write an invalid resize", async () => {
  const storage = createStorage({ dockWidth: 401 });
  const store = createTeamDirectoryViewStore(storage);
  await store.persist.rehydrate();
  expect(store.getState().dockWidth).toBe(TEAM_DIRECTORY_DEFAULT_WIDTH);
  expect(storage.getItem(key)).toBeNull();

  store.getState().setDockWidth(300);
  store.getState().setDockWidth(199);
  expect(store.getState().dockWidth).toBe(300);
  expect(JSON.parse(storage.getItem(key)!).state.dockWidth).toBe(300);
});
