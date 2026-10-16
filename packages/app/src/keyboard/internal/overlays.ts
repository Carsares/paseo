import type { KeyboardShortcutInput } from "../keyboard-shortcuts";

export interface KeyboardInputEvent extends KeyboardShortcutInput {
  isComposing?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}
export interface OverlayEntry {
  passive?: boolean;
  getLayer(): number;
  getKeys(): readonly string[];
  onKeyDown(event: KeyboardInputEvent): boolean;
}
export function createOverlayRegistry() {
  const entries: OverlayEntry[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  function getTop(): OverlayEntry | undefined {
    const candidates = entries.some((entry) => !entry.passive)
      ? entries.filter((entry) => !entry.passive)
      : entries;
    return candidates.reduce<OverlayEntry | undefined>(
      (top, entry) => (!top || entry.getLayer() >= top.getLayer() ? entry : top),
      undefined,
    );
  }
  return {
    getTop,
    getKeys: () => getTop()?.getKeys() ?? [],
    hasActive: () => entries.some((entry) => !entry.passive),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register(entry: OverlayEntry) {
      entries.push(entry);
      notify();
      return () => {
        const index = entries.indexOf(entry);
        if (index < 0) return;
        entries.splice(index, 1);
        notify();
      };
    },
    dispatch(event: KeyboardInputEvent): boolean {
      if (event.isComposing || event.key === "Process") return false;
      if (!getTop()?.onKeyDown(event)) return false;
      event.stopPropagation();
      return true;
    },
  };
}
export const overlays = createOverlayRegistry();
