import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import {
  normalizeWorkspaceOpaqueId,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";

/**
 * Why a conversation is asking the user to look at it. Phase 1 only surfaces `finished`; the
 * other kinds exist so permission and error rows can join the same section without reshaping it.
 */
export type SidebarAttentionKind = "permission" | "error" | "finished";

/** Also a `SidebarGroupItem`, so the list can go straight into `useLimitedSidebarGroup`. */
export interface SidebarAttentionItem {
  kind: SidebarAttentionKind;
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  agentId: string;
  title: string;
  workspaceName: string;
  projectName: string | null;
  timestampMs: number;
}

type AttentionAgent = Pick<
  Agent,
  | "id"
  | "status"
  | "title"
  | "workspaceId"
  | "parentAgentId"
  | "archivedAt"
  | "background"
  | "backgroundWork"
  | "pendingSubagentInbox"
  | "requiresAttention"
  | "attentionReason"
  | "attentionTimestamp"
  | "updatedAt"
> & {
  labels?: Agent["labels"];
};

export interface SidebarAttentionSession {
  agents: ReadonlyMap<string, AttentionAgent>;
  workspaces: Map<string, WorkspaceDescriptor>;
}

interface ScopedChildEntry {
  serverId: string;
  agent: AttentionAgent;
}

function addressKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

function resolveParentAddress(
  agent: AttentionAgent,
  serverId: string,
): { serverId: string; agentId: string } | null {
  const fromLabels = getParentAddressFromLabels(agent.labels, serverId);
  if (fromLabels) return fromLabels;
  if (agent.parentAgentId) return { serverId, agentId: agent.parentAgentId };
  return null;
}

function isActiveStatus(status: Agent["status"]): boolean {
  return status === "running" || status === "initializing";
}

function hasActiveBackgroundWork(agent: AttentionAgent): boolean {
  const work = agent.backgroundWork;
  if (!work) return false;
  return (work.runningCount ?? work.count) > 0;
}

function hasPendingInbox(agent: AttentionAgent): boolean {
  return (agent.pendingSubagentInbox?.count ?? 0) > 0;
}

/**
 * Children indexed by `<parentServerId>:<parentAgentId>` across every host, built once when a
 * candidate needs the tree so remote subagents whose normalized `parentAgentId` is null still
 * block their parent's conclusion while running.
 */
function indexChildrenAcrossHosts(
  sessions: Readonly<Record<string, SidebarAttentionSession | undefined>>,
): ReadonlyMap<string, ScopedChildEntry[]> {
  const children = new Map<string, ScopedChildEntry[]>();
  for (const [childServerId, session] of Object.entries(sessions)) {
    if (!session) continue;
    for (const agent of session.agents.values()) {
      if (agent.archivedAt) continue;
      const parent = resolveParentAddress(agent, childServerId);
      if (!parent) continue;
      const key = addressKey(parent.serverId, parent.agentId);
      const siblings = children.get(key);
      const entry: ScopedChildEntry = { serverId: childServerId, agent };
      if (siblings) {
        siblings.push(entry);
      } else {
        children.set(key, [entry]);
      }
    }
  }
  return children;
}

/**
 * Whether the conversation is still mid-dispatch: a descendant (same workspace on the same host,
 * or any active remote child on another host) is working, or it is waiting on work or reports it
 * has not folded into its own answer yet. Its "finished" is a hand-off pause, not a conclusion
 * the user can read.
 */
function isDispatchInProgress(input: {
  rootServerId: string;
  root: AttentionAgent;
  childrenByParent: ReadonlyMap<string, ScopedChildEntry[]>;
}): boolean {
  const { rootServerId, root, childrenByParent } = input;
  if (hasActiveBackgroundWork(root) || hasPendingInbox(root)) return true;

  const rootKey = addressKey(rootServerId, root.id);
  const visited = new Set<string>([rootKey]);
  const pending: ScopedChildEntry[] = [{ serverId: rootServerId, agent: root }];
  while (pending.length > 0) {
    const current = pending.pop() as ScopedChildEntry;
    const currentWorkspaceId = normalizeWorkspaceOpaqueId(current.agent.workspaceId);
    for (const child of childrenByParent.get(addressKey(current.serverId, current.agent.id)) ??
      []) {
      const childKey = addressKey(child.serverId, child.agent.id);
      if (visited.has(childKey)) continue;
      visited.add(childKey);
      // A local subagent moved to another workspace is that workspace's root, not part of this tree.
      if (
        child.serverId === current.serverId &&
        normalizeWorkspaceOpaqueId(child.agent.workspaceId) !== currentWorkspaceId
      ) {
        continue;
      }
      if (
        isActiveStatus(child.agent.status) ||
        hasActiveBackgroundWork(child.agent) ||
        hasPendingInbox(child.agent)
      ) {
        return true;
      }
      pending.push(child);
    }
  }
  return false;
}

function trimmed(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function compareAttentionItems(left: SidebarAttentionItem, right: SidebarAttentionItem): number {
  if (left.timestampMs !== right.timestampMs) return right.timestampMs - left.timestampMs;
  const leftKey = `${left.serverId}:${left.agentId}`;
  const rightKey = `${right.serverId}:${right.agentId}`;
  if (leftKey === rightKey) return 0;
  return leftKey < rightKey ? -1 : 1;
}

function isRootCandidateInSession(
  agent: AttentionAgent,
  serverId: string,
  session: SidebarAttentionSession,
): boolean {
  const parentAddress = resolveParentAddress(agent, serverId);
  if (!parentAddress) return true;
  if (parentAddress.serverId !== serverId) return false;
  const parent = session.agents.get(parentAddress.agentId);
  return isWorkspaceRootAgent(
    { parentAgentId: parentAddress.agentId, workspaceId: agent.workspaceId },
    parent,
  );
}

/**
 * Finished workspace-root conversations, across every host, that the user has not looked at.
 * Newest first.
 */
export function selectSidebarUnreadConclusions(
  sessions: Readonly<Record<string, SidebarAttentionSession | undefined>>,
): SidebarAttentionItem[] {
  const items: SidebarAttentionItem[] = [];
  let childrenByParent: ReadonlyMap<string, ScopedChildEntry[]> | null = null;

  for (const [serverId, session] of Object.entries(sessions)) {
    if (!session) continue;

    for (const agent of session.agents.values()) {
      if (agent.archivedAt || agent.background) continue;
      if (agent.requiresAttention !== true || agent.attentionReason !== "finished") continue;
      if (!isRootCandidateInSession(agent, serverId, session)) continue;

      const workspaceKey = resolveWorkspaceMapKeyByIdentity({
        workspaces: session.workspaces,
        workspaceId: agent.workspaceId,
      });
      const workspace = workspaceKey === null ? undefined : session.workspaces.get(workspaceKey);
      if (!workspace || workspace.archivingAt || workspace.background) continue;

      childrenByParent ??= indexChildrenAcrossHosts(sessions);
      if (isDispatchInProgress({ rootServerId: serverId, root: agent, childrenByParent })) continue;

      const workspaceName = trimmed(workspace.title) || trimmed(workspace.name);
      items.push({
        kind: "finished",
        serverId,
        workspaceId: workspace.id,
        workspaceKey: `${serverId}:${workspace.id}`,
        agentId: agent.id,
        title: trimmed(agent.title) || workspaceName,
        workspaceName,
        projectName:
          trimmed(workspace.projectCustomName) || trimmed(workspace.projectDisplayName) || null,
        timestampMs: (agent.attentionTimestamp ?? agent.updatedAt).getTime(),
      });
    }
  }

  return items.sort(compareAttentionItems);
}

export function areSidebarAttentionItemsEqual(
  left: readonly SidebarAttentionItem[],
  right: readonly SidebarAttentionItem[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return (
      item.kind === other.kind &&
      item.serverId === other.serverId &&
      item.workspaceId === other.workspaceId &&
      item.agentId === other.agentId &&
      item.title === other.title &&
      item.workspaceName === other.workspaceName &&
      item.projectName === other.projectName &&
      item.timestampMs === other.timestampMs
    );
  });
}
