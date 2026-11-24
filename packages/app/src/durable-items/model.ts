import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  WorkspaceDurableItem,
  WorkspaceDurableItemEvidence,
} from "@getpaseo/protocol/messages";

export type DurableItemDecision = Extract<WorkspaceDurableItem, { status: "decided" }>["decision"];

export interface DurableItemAddress {
  serverId: string;
  workspaceId: string;
  requestId: string;
}

export type DurableItemDecisionBlock = "offline" | "checking" | "evidenceMissing" | "evidenceStale";

export interface HostedDurableItem {
  serverId: string;
  item: WorkspaceDurableItem;
}

export function durableItemKey({ serverId, workspaceId, requestId }: DurableItemAddress): string {
  return JSON.stringify([serverId, workspaceId, requestId]);
}

function sameItem(left: WorkspaceDurableItem, right: WorkspaceDurableItem): boolean {
  return left.workspaceId === right.workspaceId && left.requestId === right.requestId;
}

export function applyDurableItemRevision(
  items: readonly WorkspaceDurableItem[],
  item: WorkspaceDurableItem,
  pendingOnly: boolean,
): WorkspaceDurableItem[] {
  const previous = items.find((entry) => sameItem(entry, item));
  const latest = previous && previous.revision > item.revision ? previous : item;
  const rest = items.filter((entry) => !sameItem(entry, item));
  if (pendingOnly && latest.status !== "pending") return rest;
  return [...rest, latest];
}

export async function listDurableItems(
  client: Pick<DaemonClient, "listWorkspaceDurableItems">,
  scope: { workspaceId: string } | { pendingOnly: true },
  signal: Pick<AbortSignal, "aborted">,
): Promise<WorkspaceDurableItem[]> {
  const filter = "workspaceId" in scope ? scope : { statusFilter: "pending" as const };
  const items = new Map<string, WorkspaceDurableItem>();
  const visited = new Set<string>();
  let cursor: string | undefined;
  do {
    checkPaginationAborted(signal);
    const page = await client.listWorkspaceDurableItems({ ...filter, limit: 100, cursor });
    checkPaginationAborted(signal);
    if (page.error) throw new Error(page.error);
    for (const item of page.items) {
      if ("workspaceId" in scope && item.workspaceId !== scope.workspaceId) continue;
      const key = JSON.stringify([item.workspaceId, item.requestId]);
      const previous = items.get(key);
      if (!previous || previous.revision <= item.revision) items.set(key, item);
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor !== undefined) {
      if (visited.has(cursor)) throw new Error("Repeated durable item cursor");
      visited.add(cursor);
    }
  } while (cursor !== undefined);

  return [...items.values()].filter(
    (item) => !("pendingOnly" in scope) || item.status === "pending",
  );
}

function checkPaginationAborted(signal: Pick<AbortSignal, "aborted">) {
  if (signal.aborted) {
    const error = new Error("Durable item pagination was cancelled");
    error.name = "AbortError";
    throw error;
  }
}

export function selectPendingDurableItems(
  hosts: readonly { serverId: string; items: readonly WorkspaceDurableItem[] }[],
): HostedDurableItem[] {
  const byAddress = new Map<string, HostedDurableItem>();
  for (const { serverId, items } of hosts) {
    for (const item of items) {
      const key = durableItemKey({ serverId, ...item });
      const previous = byAddress.get(key);
      if (!previous || previous.item.revision <= item.revision)
        byAddress.set(key, { serverId, item });
    }
  }
  return [...byAddress.values()]
    .filter(({ item }) => item.status === "pending")
    .sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt));
}

type DecisionResult =
  | { outcome: "saved" | "conflict"; item: WorkspaceDurableItem }
  | { outcome: "evidenceStale" | "unconfirmed"; item: null };

export async function submitDurableItemDecision(
  client: Pick<DaemonClient, "decideWorkspaceDurableItem">,
  item: WorkspaceDurableItem,
  decision: DurableItemDecision,
): Promise<DecisionResult> {
  const response = await client.decideWorkspaceDurableItem({
    workspaceId: item.workspaceId,
    durableItemRequestId: item.requestId,
    expectedRevision: item.revision,
    decision,
  });
  if (response.errorCode === "DURABLE_ITEM_STALE_EVIDENCE") {
    return { outcome: "evidenceStale", item: null };
  }
  if (response.item && sameItem(response.item, item) && response.item.revision > item.revision) {
    return { outcome: response.error ? "conflict" : "saved", item: response.item };
  }
  return { outcome: "unconfirmed", item: null };
}

function hasEvidenceFingerprint(evidence: WorkspaceDurableItemEvidence): boolean {
  if (!evidence.path.trim()) return false;
  return evidence.type === "file"
    ? Boolean(evidence.fingerprint.trim())
    : Boolean(evidence.repoRoot.trim() && evidence.blobOrIndexFingerprint.trim());
}

export function getDurableItemDecisionBlock(input: {
  item: WorkspaceDurableItem;
  online: boolean;
  confirmed: boolean;
  staleEvidenceRevision?: number;
  decision: DurableItemDecision;
}): DurableItemDecisionBlock | undefined {
  const { item } = input;
  if (!input.online) return "offline";
  if (!input.confirmed) return "checking";
  if (input.decision !== "approve") return;
  if (
    (item.kind === "acceptance" && item.evidence.length === 0) ||
    item.evidence.some((evidence) => !hasEvidenceFingerprint(evidence))
  )
    return "evidenceMissing";
  if (input.staleEvidenceRevision === item.revision) return "evidenceStale";
}
