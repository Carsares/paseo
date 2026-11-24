import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export interface GitGraphConflictIntent {
  id: number;
  tabId: string;
  repoRoot: string;
  surface: "conflicts";
}

export interface GitGraphNavigationIntentStore {
  getIntent: () => GitGraphConflictIntent | null;
  subscribe: (listener: () => void) => () => void;
  submitConflictIntent: (input: { tabId: string; repoRoot: string }) => number;
  consumeIntent: (id: number) => void;
  clear: () => void;
}

export function createGitGraphNavigationIntentStore(): GitGraphNavigationIntentStore {
  let nextId = 0;
  let current: GitGraphConflictIntent | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getIntent: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    submitConflictIntent({ tabId, repoRoot }) {
      const id = ++nextId;
      current = { id, tabId, repoRoot, surface: "conflicts" };
      notify();
      return id;
    },
    consumeIntent(id) {
      if (current?.id !== id) return;
      current = null;
      notify();
    },
    clear() {
      if (current === null) return;
      current = null;
      notify();
    },
  };
}

const GitGraphNavigationIntentContext = createContext<GitGraphNavigationIntentStore | null>(null);

export function GitGraphNavigationIntentProvider({
  store,
  children,
}: {
  store: GitGraphNavigationIntentStore;
  children: ReactNode;
}) {
  return (
    <GitGraphNavigationIntentContext.Provider value={store}>
      {children}
    </GitGraphNavigationIntentContext.Provider>
  );
}

const NOOP_SUBSCRIBE = () => () => {};
const NOOP_GET = () => null;

export function useGitGraphConflictIntent(tabId: string): {
  intent: GitGraphConflictIntent | null;
  consumeIntent: (id: number) => void;
} {
  const store = useContext(GitGraphNavigationIntentContext);
  const rawIntent = useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getIntent : NOOP_GET,
    NOOP_GET,
  );
  const consumeIntent = useCallback(
    (id: number) => {
      store?.consumeIntent(id);
    },
    [store],
  );
  return {
    intent: rawIntent && rawIntent.tabId === tabId ? rawIntent : null,
    consumeIntent,
  };
}
