import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  getParentAgentIdFromLabels,
  isMainControlAgentLabels,
  isResidentAgentLabels,
  isSideChatAgentLabels,
} from "@getpaseo/protocol/agent-labels";
import type { AgentSnapshotPayload, WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

export type TopicUpgradeClient = Pick<
  DaemonClient,
  "getLastServerInfoMessage" | "findWorkspace" | "fetchAgentHistory" | "updateWorkspaceTopic"
>;
export type WorkspaceTopic = NonNullable<WorkspaceDescriptorPayload["topic"]>;
type Candidate = Pick<AgentSnapshotPayload, "id" | "title" | "provider" | "createdAt">;
export type TopicUpgradePlan =
  | { kind: "disconnected" | "unsupported" | "forbidden" | "unavailable" }
  | { kind: "upgraded"; topic: WorkspaceTopic }
  | { kind: "choose"; candidates: Candidate[]; existingMainId: string | null };
export type TopicUpgradeResult =
  | { kind: "upgraded"; topic: WorkspaceTopic }
  | { kind: "review"; plan: TopicUpgradePlan };

type UpgradeWorkspace = Pick<
  WorkspaceDescriptorPayload,
  "id" | "archivingAt" | "background" | "internal" | "topic" | "workspaceDirectory"
>;

function isOrdinaryWorkspace(workspace: UpgradeWorkspace): boolean {
  return !workspace.archivingAt && !workspace.background && !workspace.internal;
}

export function canOfferTopicUpgrade({
  cachedWorkspace,
  hostWorkspace,
  isConnected,
  supportsTopic,
}: {
  cachedWorkspace: UpgradeWorkspace | null;
  hostWorkspace: UpgradeWorkspace | null | undefined;
  isConnected: boolean;
  supportsTopic: boolean;
}): boolean {
  if (!cachedWorkspace || !isOrdinaryWorkspace(cachedWorkspace)) return false;
  if (hostWorkspace !== undefined) {
    return Boolean(hostWorkspace && isOrdinaryWorkspace(hostWorkspace) && !hostWorkspace.topic);
  }
  if (isConnected && supportsTopic) return false;

  // Pre-registry hosts can supply a client-generated ID made from the checkout path.
  // Only the authoritative workspace list can establish that such an ID is registered.
  const directory = normalizeWorkspacePath(cachedWorkspace.workspaceDirectory?.trim());
  return Boolean(directory && directory !== cachedWorkspace.id);
}

export async function loadTopicUpgradePlan(
  client: TopicUpgradeClient | null,
  workspaceId: string,
): Promise<TopicUpgradePlan> {
  const host = client?.getLastServerInfoMessage();
  if (!client || !host) return { kind: "disconnected" };
  // COMPAT(topicWorkbenchV1): added in v0.18.0, remove gate after 2027-06-01.
  if (!host.features?.topicWorkbenchV1) return { kind: "unsupported" };
  if (
    host.permissions &&
    (!host.permissions.includes("workspace.read") || !host.permissions.includes("workspace.manage"))
  ) {
    return { kind: "forbidden" };
  }
  const workspace = await client.findWorkspace(workspaceId);
  if (!workspace || !isOrdinaryWorkspace(workspace)) return { kind: "unavailable" };
  if (workspace.topic) return { kind: "upgraded", topic: workspace.topic };
  return loadUpgradeCandidates(client, workspaceId, host.features.backgroundWorkspaces === true);
}

async function loadUpgradeCandidates(
  client: TopicUpgradeClient,
  workspaceId: string,
  includeBackground: boolean,
): Promise<Extract<TopicUpgradePlan, { kind: "choose" }>> {
  // The workspace history query includes existing sessions with unavailable providers and
  // subjects that have no local tab. A closed session can still be a root.
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let existingMainId: string | null = null;
  let cursor: string | undefined;
  do {
    const { entries, pageInfo } = await client.fetchAgentHistory({
      filter: {
        workspaceIds: [workspaceId],
        ...(includeBackground ? { includeBackground: true } : {}),
      },
      page: { limit: 200, cursor },
    });
    for (const { agent } of entries) {
      if (
        seen.has(agent.id) ||
        agent.workspaceId !== workspaceId ||
        agent.archivedAt ||
        agent.internal ||
        getParentAgentIdFromLabels(agent.labels) ||
        isSideChatAgentLabels(agent.labels) ||
        isResidentAgentLabels(agent.labels)
      ) {
        continue;
      }
      seen.add(agent.id);
      const { id, title, provider, createdAt } = agent;
      candidates.push({ id, title, provider, createdAt });
      if (isMainControlAgentLabels(agent.labels)) existingMainId = id;
    }
    cursor = pageInfo.nextCursor ?? undefined;
  } while (cursor);

  return { kind: "choose", candidates, existingMainId };
}

export function canConfirmTopicUpgrade(
  plan: TopicUpgradePlan | null,
  selectedId: string | null,
): boolean {
  if (plan?.kind !== "choose") return false;
  if (plan.candidates.length === 0) return selectedId === null;
  if (plan.existingMainId !== null) return selectedId === plan.existingMainId;
  return plan.candidates.some((candidate) => candidate.id === selectedId);
}

export async function confirmTopicUpgrade({
  client,
  workspaceId,
  selectedId,
}: {
  client: TopicUpgradeClient;
  workspaceId: string;
  selectedId: string | null;
}): Promise<TopicUpgradeResult> {
  // Read again after a failure or a long-lived dialog so an outdated choice never
  // binds a replacement or silently upgrades a workspace whose first root just appeared.
  const current = await loadTopicUpgradePlan(client, workspaceId);
  if (current.kind === "upgraded") {
    return current.topic.mainAgentId === selectedId ? current : { kind: "review", plan: current };
  }
  if (!canConfirmTopicUpgrade(current, selectedId)) return { kind: "review", plan: current };

  const result = await client.updateWorkspaceTopic({
    workspaceId,
    upgradeToTopic: true,
    ...(selectedId === null ? {} : { mainAgentId: selectedId }),
  });
  if (result.error || !result.topic) {
    throw new Error(result.error ?? "The host did not confirm the upgrade.");
  }
  return { kind: "upgraded", topic: result.topic };
}
