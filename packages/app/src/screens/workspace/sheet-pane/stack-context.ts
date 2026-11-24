import { createContext, useContext, useSyncExternalStore } from "react";
import type { WorkspaceSheetStack } from "./stack";

const WorkspaceSheetStackContext = createContext<WorkspaceSheetStack | null>(null);
export const WorkspaceSheetStackBridge = WorkspaceSheetStackContext.Provider;

export function useWorkspaceSheetPages() {
  return useContext(WorkspaceSheetStackContext);
}

const subscribeToNoStack = () => () => {};

export function useIsWorkspaceSheetPageOnTop(key: string | undefined) {
  const stack = useWorkspaceSheetPages();
  const getSnapshot = () => {
    const top = stack?.getSnapshot().at(-1);
    return top?.kind === "page" && top.page.key === key;
  };
  return useSyncExternalStore(
    key && stack ? stack.subscribe : subscribeToNoStack,
    getSnapshot,
    getSnapshot,
  );
}
