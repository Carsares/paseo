type Listener = () => void;

/**
 * How many extra render-limit steps the user opened for each of one agent's long
 * assistant messages. Lives with the timeline so a virtualized row remounting on
 * scroll paints at the step count the user chose.
 */
export function createAssistantMessageExpansion() {
  const stepsByItemId = new Map<string, number>();
  const listeners = new Map<string, Set<Listener>>();

  function notify(itemId: string) {
    for (const listener of listeners.get(itemId) ?? []) listener();
  }

  return {
    getSteps: (itemId: string) => stepsByItemId.get(itemId) ?? 0,
    subscribe(itemId: string, listener: Listener) {
      let itemListeners = listeners.get(itemId);
      if (!itemListeners) {
        itemListeners = new Set();
        listeners.set(itemId, itemListeners);
      }
      itemListeners.add(listener);
      return () => {
        itemListeners.delete(listener);
        if (itemListeners.size === 0) listeners.delete(itemId);
      };
    },
    showMore(itemId: string) {
      stepsByItemId.set(itemId, (stepsByItemId.get(itemId) ?? 0) + 1);
      notify(itemId);
    },
    showLess(itemId: string) {
      if (!stepsByItemId.has(itemId)) return;
      stepsByItemId.delete(itemId);
      notify(itemId);
    },
  };
}

export type AssistantMessageExpansion = ReturnType<typeof createAssistantMessageExpansion>;
