import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";
import { createAssistantMessageExpansion, type AssistantMessageExpansion } from "./expansion";

export const AssistantMessageExpansionContext = createContext<AssistantMessageExpansion | null>(
  null,
);

/** One store per viewed agent; switching agents starts with every message at the base cap. */
export function useAgentAssistantMessageExpansion(agentId: string): AssistantMessageExpansion {
  const [owner, setOwner] = useState(() => ({
    agentId,
    expansion: createAssistantMessageExpansion(),
  }));
  if (owner.agentId === agentId) return owner.expansion;
  const next = { agentId, expansion: createAssistantMessageExpansion() };
  setOwner(next);
  return next.expansion;
}

/** Subscribes one assistant message to its own expanded step count. */
export function useAssistantMessageExpansion(itemId: string) {
  const expansion = useContext(AssistantMessageExpansionContext);
  if (!expansion) {
    throw new Error("AssistantMessage requires an AssistantMessageExpansionContext");
  }
  const subscribe = useCallback(
    (listener: () => void) => expansion.subscribe(itemId, listener),
    [expansion, itemId],
  );
  const getSnapshot = useCallback(() => expansion.getSteps(itemId), [expansion, itemId]);
  const expandedSteps = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const showMore = useCallback(() => expansion.showMore(itemId), [expansion, itemId]);
  const showLess = useCallback(() => expansion.showLess(itemId), [expansion, itemId]);
  return { expandedSteps, showMore, showLess };
}
