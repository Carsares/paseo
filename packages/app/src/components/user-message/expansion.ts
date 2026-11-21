type Listener = () => void;

interface MessageExpansion {
  expanded: boolean;
  expandedQuotes: ReadonlySet<number>;
}

const COLLAPSED: MessageExpansion = { expanded: false, expandedQuotes: new Set() };

/**
 * Manual message and quote choices live with the timeline so remounting rows preserve them.
 * A toggle notifies only that message's subscribers.
 */
export function createUserMessageExpansion() {
  const messages = new Map<string, MessageExpansion>();
  const listeners = new Map<string, Set<Listener>>();
  const getSnapshot = (itemId: string) => messages.get(itemId) ?? COLLAPSED;
  function update(itemId: string, state: MessageExpansion) {
    if (state.expanded || state.expandedQuotes.size > 0) messages.set(itemId, state);
    else messages.delete(itemId);
    for (const listener of listeners.get(itemId) ?? []) listener();
  }
  return {
    getSnapshot,
    isExpanded: (itemId: string) => getSnapshot(itemId).expanded,
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
    toggle(itemId: string) {
      const state = getSnapshot(itemId);
      update(itemId, { ...state, expanded: !state.expanded });
    },
    toggleQuote(itemId: string, quoteIndex: number) {
      const state = getSnapshot(itemId);
      const expandedQuotes = new Set(state.expandedQuotes);
      if (!expandedQuotes.delete(quoteIndex)) expandedQuotes.add(quoteIndex);
      update(itemId, { ...state, expandedQuotes });
    },
  };
}

export type UserMessageExpansion = ReturnType<typeof createUserMessageExpansion>;
