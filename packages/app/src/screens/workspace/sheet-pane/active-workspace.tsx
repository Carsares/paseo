import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { WorkspaceSheetPage, WorkspaceSheetStack } from "./stack";

type WorkspaceSheetOpener = (page: WorkspaceSheetPage) => boolean;

function createActiveWorkspaceSheetScope() {
  let opener: WorkspaceSheetOpener | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: WorkspaceSheetOpener | null) => {
    opener = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => opener,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register(stack: WorkspaceSheetStack) {
      // An opener captured by a delayed click must never target a different workspace.
      const open: WorkspaceSheetOpener = (page) => opener === open && stack.push(page);
      publish(open);
      return () => {
        if (opener === open) publish(null);
      };
    },
  };
}

const ActiveWorkspaceSheetContext = createContext<ReturnType<
  typeof createActiveWorkspaceSheetScope
> | null>(null);

export function ActiveWorkspaceSheetProvider({ children }: { children: ReactNode }) {
  const [scope] = useState(createActiveWorkspaceSheetScope);
  return (
    <ActiveWorkspaceSheetContext.Provider value={scope}>
      {children}
    </ActiveWorkspaceSheetContext.Provider>
  );
}

const subscribeToNoScope = () => () => {};
const getNoOpener = () => null;

export function useActiveWorkspaceSheetOpener(): WorkspaceSheetOpener | null {
  const scope = useContext(ActiveWorkspaceSheetContext);
  const getSnapshot = scope?.getSnapshot ?? getNoOpener;
  return useSyncExternalStore(scope?.subscribe ?? subscribeToNoScope, getSnapshot, getSnapshot);
}

export function useRegisterActiveWorkspaceSheet(stack: WorkspaceSheetStack, active: boolean) {
  const scope = useContext(ActiveWorkspaceSheetContext);
  useLayoutEffect(() => {
    if (active) return scope?.register(stack);
  }, [active, scope, stack]);
}
