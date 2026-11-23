import type { TFunction } from "i18next";
import { useCallback, useEffect } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { workspaceMainBlockMessage, type WorkspaceMainBlock } from "./workspace-main-intent";

type Storage = Pick<typeof AsyncStorage, "getItem" | "setItem" | "removeItem">;

export function createWorkspaceMainPreferences(storage: Storage) {
  const useChoices = create<{ choices: Record<string, boolean | undefined> }>(() => ({
    choices: {},
  }));
  const pending = new Map<string, Promise<void>>();
  const update = (key: string, checked: boolean) =>
    useChoices.setState(({ choices }) => ({ choices: { ...choices, [key]: checked } }));
  const storageKey = (key: string) => `paseo:workspace-main-draft:${key}`;
  const order = (key: string, action: () => Promise<void>) => {
    const operation = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
    pending.set(key, operation);
    void operation
      .finally(() => {
        if (pending.get(key) === operation) pending.delete(key);
      })
      .catch(() => undefined);
    return operation;
  };
  const get = (key: string) => useChoices.getState().choices[key];
  return {
    useChoices,
    get,
    load: (key: string) => {
      if (get(key) !== undefined) return Promise.resolve();
      const inFlight = pending.get(key);
      if (inFlight) return inFlight;
      return order(key, async () => {
        const raw = await storage.getItem(storageKey(key));
        if (get(key) === undefined) update(key, raw === "main");
      });
    },
    set: (key: string, checked: boolean) => {
      update(key, checked);
      return order(key, () =>
        checked ? storage.setItem(storageKey(key), "main") : storage.removeItem(storageKey(key)),
      );
    },
  };
}

const preferences = createWorkspaceMainPreferences(AsyncStorage);

export interface WorkspaceMainControlValue {
  checked: boolean;
  disabled: boolean;
  hint?: string;
  onChange: (checked: boolean) => void;
}

export function useWorkspaceMainPreference(
  key: string | null,
  block: WorkspaceMainBlock | null,
  t: TFunction,
) {
  const choice = preferences.useChoices((state) => (key ? state.choices[key] : undefined));
  const ready = key === null || choice !== undefined;
  useEffect(() => {
    if (key) void preferences.load(key).catch(console.warn);
  }, [key]);
  const onChange = useCallback(
    (checked: boolean) => {
      if (key && (!checked || (ready && !block))) {
        void preferences.set(key, checked).catch(console.warn);
      }
    },
    [block, key, ready],
  );
  const blockedHint = block ? workspaceMainBlockMessage(t, block) : undefined;
  const control: WorkspaceMainControlValue | undefined = key
    ? {
        checked: choice === true,
        disabled: !ready || (choice !== true && block !== null),
        hint: ready ? blockedHint : t("common.loading"),
        onChange,
      }
    : undefined;
  const readForSubmit = useCallback(async () => {
    if (!key) return false;
    const frozen = preferences.get(key);
    if (frozen !== undefined) return frozen;
    try {
      await preferences.load(key);
    } catch {
      throw new Error(t("agentControls.workspaceMain.unknown"));
    }
    return preferences.get(key) === true;
  }, [key, t]);
  const clear = useCallback(() => {
    if (key && preferences.get(key) === true) {
      void preferences.set(key, false).catch(console.warn);
    }
  }, [key]);
  return { control, checked: choice === true, readForSubmit, clear };
}
