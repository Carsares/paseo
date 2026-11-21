import { create } from "zustand";
import { buildDraftStoreKey } from "@/stores/draft-keys";

const useHandoffInputLocks = create<ReadonlySet<string>>(() => new Set());
const pendingSubmissions = new Set<string>();
const pendingAttachments = new Map<string, number>();

export function beginComposerWork(
  serverId: string,
  agentId: string,
  kind: "submit" | "attachment",
): (() => void) | null {
  const draftKey = buildDraftStoreKey({ serverId, agentId });
  if (useHandoffInputLocks.getState().has(draftKey)) return null;
  if (kind === "submit") {
    if (pendingSubmissions.has(draftKey)) return null;
    pendingSubmissions.add(draftKey);
    return () => {
      pendingSubmissions.delete(draftKey);
    };
  }
  pendingAttachments.set(draftKey, (pendingAttachments.get(draftKey) ?? 0) + 1);
  return () => {
    const pending = pendingAttachments.get(draftKey) ?? 0;
    if (pending <= 1) pendingAttachments.delete(draftKey);
    else pendingAttachments.set(draftKey, pending - 1);
  };
}

export function useHandoffInputLocked(serverId: string, agentId: string): boolean {
  return useHandoffInputLocks((locks) => locks.has(buildDraftStoreKey({ serverId, agentId })));
}

export function isHandoffInputLocked(serverId: string, agentId: string): boolean {
  return useHandoffInputLocks.getState().has(buildDraftStoreKey({ serverId, agentId }));
}

export function assertComposerInputUnlocked(serverId: string, agentId: string): void {
  if (isHandoffInputLocked(serverId, agentId)) {
    throw new Error("The composer is locked. Try again after the handoff.");
  }
}

export function lockHandoffInput(draftKey: string): (() => void) | null {
  const locks = useHandoffInputLocks.getState();
  if (locks.has(draftKey) || pendingSubmissions.has(draftKey) || pendingAttachments.has(draftKey))
    return null;
  useHandoffInputLocks.setState(new Set([...locks, draftKey]), true);
  return () => {
    const current = new Set(useHandoffInputLocks.getState());
    current.delete(draftKey);
    useHandoffInputLocks.setState(current, true);
  };
}
