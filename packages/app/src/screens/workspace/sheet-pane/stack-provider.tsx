import { useLayoutEffect, useMemo, useRef } from "react";
import invariant from "tiny-invariant";
import { useWorkspaceLayoutStore, type SheetTab } from "@/stores/workspace-layout-store";
import { createWorkspaceSheetStack, type WorkspaceSheetPage } from "./stack";

import { WorkspaceSheetStackBridge, useWorkspaceSheetPages } from "./stack-context";

export { WorkspaceSheetStackBridge, useWorkspaceSheetPages } from "./stack-context";

const NO_SHEETS: readonly SheetTab[] = [];

export function WorkspaceSheetStackProvider({
  workspaceKey,
  children,
}: {
  workspaceKey: string | null;
  children: React.ReactNode;
}) {
  const stack = useMemo(() => (workspaceKey ? createWorkspaceSheetStack() : null), [workspaceKey]);
  useLayoutEffect(() => {
    if (!workspaceKey || !stack) return;
    let previous: readonly SheetTab[] | undefined;
    const sync = () => {
      const sheets =
        useWorkspaceLayoutStore.getState().sheetsByWorkspace[workspaceKey] ?? NO_SHEETS;
      if (sheets !== previous) {
        previous = sheets;
        stack.syncTabs(sheets);
      }
    };
    sync();
    return useWorkspaceLayoutStore.subscribe(sync);
  }, [stack, workspaceKey]);
  return <WorkspaceSheetStackBridge value={stack}>{children}</WorkspaceSheetStackBridge>;
}

/** Registers content whose lifetime is controlled by the panel that opened it. */
export function WorkspaceSheetSurface({ page }: { page: WorkspaceSheetPage }) {
  const stack = useWorkspaceSheetPages();
  invariant(stack, "WorkspaceSheetSurface requires a workspace sheet stack");
  const { key } = page;
  const initialPage = useRef(page);
  initialPage.current = page;
  useLayoutEffect(() => {
    stack.push(initialPage.current);
    return () => stack.remove(key);
  }, [key, stack]);
  useLayoutEffect(() => {
    stack.update(page);
  }, [page, stack]);
  return null;
}
