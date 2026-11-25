import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export interface TeamMessageJumpIntent {
  requestId: number;
  serverId: string;
  agentId: string;
  itemId: string | null;
  messageId: string | null;
  epoch: string | null;
  seq: number | null;
}

export interface TeamMessageJumpStore {
  getIntent: () => TeamMessageJumpIntent | null;
  subscribe: (listener: () => void) => () => void;
  requestJump: (input: Omit<TeamMessageJumpIntent, "requestId">) => number;
  acknowledgeJump: (requestId: number) => void;
  discardJump: (requestId: number) => void;
  consumeNavigationFocus: (agentId: string) => boolean;
  clear: () => void;
}

export function createTeamMessageJumpStore(): TeamMessageJumpStore {
  let currentIntent: TeamMessageJumpIntent | null = null;
  let nextRequestId = 0;
  let navigationAgentId: string | null = null;
  const listeners = new Set<() => void>();

  function emit() {
    for (const listener of listeners) {
      listener();
    }
  }

  function finishJump(requestId: number) {
    if (currentIntent?.requestId !== requestId) return;
    currentIntent = null;
    emit();
  }

  return {
    getIntent: () => currentIntent,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    requestJump: (input) => {
      nextRequestId += 1;
      navigationAgentId = input.agentId;
      currentIntent = {
        ...input,
        requestId: nextRequestId,
      };
      emit();
      return nextRequestId;
    },
    acknowledgeJump: finishJump,
    discardJump: finishJump,
    consumeNavigationFocus: (agentId) => {
      if (navigationAgentId !== agentId) return false;
      navigationAgentId = null;
      return true;
    },
    clear: () => {
      navigationAgentId = null;
      if (currentIntent === null) return;
      currentIntent = null;
      emit();
    },
  };
}

const TeamMessageJumpContext = createContext<TeamMessageJumpStore | null>(null);

export function TeamMessageJumpProvider({
  store,
  children,
}: {
  store: TeamMessageJumpStore;
  children: ReactNode;
}) {
  return createElement(TeamMessageJumpContext.Provider, { value: store }, children);
}

export function useOptionalTeamMessageJumpStore(): TeamMessageJumpStore | null {
  return useContext(TeamMessageJumpContext);
}

const noopSubscribe = () => () => {};
const getNullSnapshot = () => null;

export function usePendingTeamMessageJump(
  serverId: string,
  agentId: string,
): TeamMessageJumpIntent | null {
  const store = useContext(TeamMessageJumpContext);
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener) : noopSubscribe()),
    [store],
  );
  const getSnapshot = useCallback(() => {
    if (!store) return null;
    const intent = store.getIntent();
    if (!intent) return null;
    return intent.serverId === serverId && intent.agentId === agentId ? intent : null;
  }, [agentId, serverId, store]);

  return useSyncExternalStore(subscribe, getSnapshot, getNullSnapshot);
}
