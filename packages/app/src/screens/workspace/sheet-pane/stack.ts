import type { ReactNode } from "react";
import type { SheetHeader } from "@/components/adaptive-modal-sheet";
import type { ContextBridge } from "@/components/ui/isolated-bottom-sheet-modal";
import type { SheetTab } from "@/stores/workspace-layout-store";

export interface WorkspaceSheetPage {
  key: string;
  title: string;
  header?: SheetHeader;
  render: (close: () => void) => ReactNode;
  onClose?: () => void;
  canClose?: () => boolean;
  bridge?: ContextBridge;
  testID?: string;
  scrollable?: boolean;
  footer?: ReactNode;
}

export type WorkspaceSheetEntry =
  | { kind: "tab"; key: string; sheet: SheetTab }
  | { kind: "page"; key: string; page: WorkspaceSheetPage };

export function createWorkspaceSheetStack() {
  let entries: readonly WorkspaceSheetEntry[] = [];
  const listeners = new Set<() => void>();

  function publish(next: readonly WorkspaceSheetEntry[]) {
    if (next.length === entries.length && next.every((entry, index) => entry === entries[index])) {
      return;
    }
    entries = next;
    for (const listener of listeners) listener();
  }

  const pageKey = (key: string) => `page:${key}`;

  return {
    getSnapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    syncTabs(sheets: readonly SheetTab[]) {
      const tabs = new Map(sheets.map((sheet) => [`tab:${sheet.tab.tabId}`, sheet]));
      const next = entries.flatMap<WorkspaceSheetEntry>((entry) => {
        if (entry.kind === "page") return [entry];
        const sheet = tabs.get(entry.key);
        if (!sheet) return [];
        tabs.delete(entry.key);
        return [sheet === entry.sheet ? entry : { ...entry, sheet }];
      });
      for (const [key, sheet] of tabs) next.push({ kind: "tab", key, sheet });
      publish(next);
    },
    push(page: WorkspaceSheetPage) {
      const key = pageKey(page.key);
      const existing = entries.findIndex((entry) => entry.key === key);
      if (existing >= 0) return false;
      publish([...entries, { kind: "page", key, page }]);
      return true;
    },
    update(page: WorkspaceSheetPage) {
      const key = pageKey(page.key);
      publish(
        entries.map((entry) =>
          entry.key === key && entry.kind === "page" && entry.page !== page
            ? { ...entry, page }
            : entry,
        ),
      );
    },
    remove(key: string) {
      publish(entries.filter((entry) => entry.key !== pageKey(key)));
    },
    closeTopPage(expected: WorkspaceSheetEntry) {
      const top = entries.at(-1);
      if (
        !top ||
        top.kind !== "page" ||
        top.key !== expected.key ||
        top.page.canClose?.() === false
      )
        return;
      publish(entries.slice(0, -1));
      top.page.onClose?.();
    },
  };
}

export type WorkspaceSheetStack = ReturnType<typeof createWorkspaceSheetStack>;
