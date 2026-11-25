import type { AgentAddress } from "@getpaseo/protocol/addresses";
import {
  getAgentProfileIdFromLabels,
  getParentAddressFromLabels,
  getResidentRoleFromLabels,
  getResidentRoleSlugFromLabels,
  isMainControlAgent,
  isResidentAgent,
  isSideChatAgent,
} from "@getpaseo/protocol/agent-labels";
import type { AgentProfile, ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { Agent } from "@/stores/session-store";
import { deriveSidebarStateBucket, type SidebarStateBucket } from "@/utils/sidebar-agent-state";

export type TeamDirectoryAgent = Pick<
  Agent,
  | "id"
  | "workspaceId"
  | "labels"
  | "title"
  | "turn"
  | "status"
  | "backgroundWork"
  | "createdAt"
  | "archivedAt"
  | "background"
  | "pendingPermissions"
  | "requiresAttention"
  | "attentionReason"
  | "lastUserMessageAt"
> &
  Partial<Pick<Agent, "lastActivityAt" | "updatedAt">>;

export interface TeamDirectoryMemberNode extends AgentAddress {
  depth: 0 | 1 | 2;
  title: string;
  parentAgentId: string | null;
  parentTitle: string | null;
  bucket: SidebarStateBucket;
  sortPriority: 0 | 1 | 2 | 3;
  isArchived: boolean;
  isRunning: boolean;
  isSilentSeat: boolean;
  isMain: boolean;
  isStandalone: boolean;
  isResident: boolean;
  isSideChat: boolean;
  residentRole: string | null;
  residentSlug: string | null;
  profileId: string | null;
  lastActivityAt: Date;
  createdAt: Date;
}

export interface TeamDirectoryResidentGroup {
  parent: AgentAddress | null;
  parentTitle: string | null;
  nodes: TeamDirectoryMemberNode[];
}

export interface TeamDirectoryPresetResident {
  profileId: string;
  name: string;
  roleSlug: string | null;
  provider: string;
}

export interface TeamDirectoryTaskBranch {
  node: TeamDirectoryMemberNode;
  children: TeamDirectoryMemberNode[];
  effectivePriority: 0 | 1 | 2 | 3;
}

export interface TeamDirectoryNativeSubrunNode {
  id: string;
  parentAgentId: string;
  title: string;
  subtitle: string | null;
  bucket: SidebarStateBucket;
  sortPriority: 0 | 1 | 2 | 3;
  createdAt: Date;
}

export interface TeamDirectorySummary {
  hasMain: boolean;
  isMainSilent: boolean;
  runningCount: number;
  activeCount: number;
  needsInputCount: number;
  firstNeedsInputAgentId: string | null;
}

export interface TeamDirectoryData {
  mainSeat: TeamDirectoryMemberNode | null;
  standaloneRoots: TeamDirectoryMemberNode[];
  residentGroups: TeamDirectoryResidentGroup[];
  residentSubtasks: TeamDirectoryMemberNode[];
  flattenResidentGroups: boolean;
  presetResidents: TeamDirectoryPresetResident[];
  taskTree: TeamDirectoryTaskBranch[];
  sideChats: TeamDirectoryMemberNode[];
  nativeSubruns: TeamDirectoryNativeSubrunNode[];
  cleanableTaskMembers: AgentAddress[];
  historyMembers: TeamDirectoryMemberNode[];
  summary: TeamDirectorySummary;
}

export interface TeamDirectoryActivityGroups {
  activeMembers: TeamDirectoryMemberNode[];
  activeSubruns: TeamDirectoryNativeSubrunNode[];
  pinnedInactiveMembers: TeamDirectoryMemberNode[];
  collapsibleInactiveMembers: TeamDirectoryMemberNode[];
  inactiveSubruns: TeamDirectoryNativeSubrunNode[];
  totalInactiveCount: number;
}

export interface TeamDirectoryAttributeSectionSplit {
  expandedMembers: TeamDirectoryMemberNode[];
  foldedInactiveMembers: TeamDirectoryMemberNode[];
}

export interface TeamDirectoryAttributeGroups {
  mainSeat: TeamDirectoryMemberNode | null;
  standaloneRoots: TeamDirectoryMemberNode[];
  sideChats: TeamDirectoryMemberNode[];
  levelOne: TeamDirectoryAttributeSectionSplit;
  levelTwo: TeamDirectoryAttributeSectionSplit;
  levelTwoSubruns: TeamDirectoryNativeSubrunNode[];
}

export function isMemberActivelyWorking(
  node: Pick<TeamDirectoryMemberNode, "isRunning" | "bucket" | "isArchived">,
): boolean {
  if (node.isArchived) return false;
  return node.isRunning || node.bucket === "needs_input";
}

export function shouldKeepMemberExpanded(
  node: Pick<
    TeamDirectoryMemberNode,
    "serverId" | "agentId" | "isRunning" | "bucket" | "isArchived"
  >,
  focusedAddress: AgentAddress | null,
): boolean {
  if (isMemberActivelyWorking(node)) return true;
  if (!node.isArchived && (node.bucket === "failed" || node.bucket === "attention")) return true;
  if (
    focusedAddress &&
    node.serverId === focusedAddress.serverId &&
    node.agentId === focusedAddress.agentId
  ) {
    return true;
  }
  return false;
}

export function teamDirectoryNodeKey({ serverId, agentId }: AgentAddress): string {
  return `${serverId}:${agentId}`;
}

interface LocatedDirectoryAgent extends AgentAddress {
  agent: TeamDirectoryAgent;
}

function getLastActivity(agent: TeamDirectoryAgent): Date {
  return agent.lastActivityAt ?? agent.updatedAt ?? agent.archivedAt ?? agent.createdAt;
}

function isAgentActiveOrRunning(agent: TeamDirectoryAgent): boolean {
  return (
    agent.turn.phase === "open" ||
    agent.status === "running" ||
    agent.status === "initializing" ||
    (agent.backgroundWork?.runningCount ?? agent.backgroundWork?.count ?? 0) > 0
  );
}

/**
 * Derive bucket for status dot (`getStatusDotColor`) and priority rank for team directory ordering:
 * 0 = needs_input / blocked / failed
 * 1 = running
 * 2 = unread conclusion (attention)
 * 3 = idle / closed
 */
export function resolveMemberBucketAndPriority(agent: TeamDirectoryAgent): {
  bucket: SidebarStateBucket;
  sortPriority: 0 | 1 | 2 | 3;
  isRunning: boolean;
} {
  if (agent.archivedAt) {
    return { bucket: "done", sortPriority: 3, isRunning: false };
  }
  const running = isAgentActiveOrRunning(agent);
  const bucket = deriveSidebarStateBucket({
    status: running && agent.status !== "error" ? "running" : agent.status,
    pendingPermissionCount: agent.pendingPermissions?.length ?? 0,
    requiresAttention: agent.requiresAttention,
    attentionReason: agent.attentionReason,
    backgroundWork: agent.backgroundWork,
  });

  if (bucket === "needs_input" || bucket === "failed" || agent.status === "error") {
    return {
      bucket: bucket === "needs_input" ? "needs_input" : "failed",
      sortPriority: 0,
      isRunning: running,
    };
  }
  if (bucket === "running" || running) {
    return { bucket: "running", sortPriority: 1, isRunning: true };
  }
  if (bucket === "attention") {
    return { bucket: "attention", sortPriority: 2, isRunning: false };
  }
  return { bucket: "done", sortPriority: 3, isRunning: false };
}

function compareMembers(left: TeamDirectoryMemberNode, right: TeamDirectoryMemberNode): number {
  if (left.sortPriority !== right.sortPriority) {
    return left.sortPriority - right.sortPriority;
  }
  const activityDelta = right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
  if (activityDelta !== 0) return activityDelta;
  const createdDelta = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdDelta !== 0) return createdDelta;
  return left.agentId.localeCompare(right.agentId);
}

/**
 * Strict eligibility check for compact cleanup of idle completed subagents:
 * NEVER cleans residents, main control, side chats, standalone roots, running/open-turn agents,
 * background-work agents, pending-permission agents, or agents with unread conclusions.
 */
export function isDirectlyCleanableTaskMember(
  agent: TeamDirectoryAgent,
  serverId: string,
): boolean {
  if (agent.archivedAt || agent.background) return false;
  if (!getParentAddressFromLabels(agent.labels, serverId)) return false;
  if (isMainControlAgent(agent) || isResidentAgent(agent) || isSideChatAgent(agent)) return false;
  if (isAgentActiveOrRunning(agent)) return false;
  if ((agent.pendingPermissions?.length ?? 0) > 0) return false;
  if (agent.attentionReason === "permission") return false;
  if (agent.requiresAttention === true) return false;
  return agent.status === "idle" || agent.status === "error";
}

function resolveParentTitle(
  parentAddress: AgentAddress | null,
  entriesByKey: ReadonlyMap<string, LocatedDirectoryAgent> | undefined,
  fallbackTitle: string,
): string | null {
  if (!parentAddress) return null;
  const parentEntry = entriesByKey?.get(teamDirectoryNodeKey(parentAddress));
  if (parentEntry && isResidentAgent(parentEntry.agent)) {
    const role = getResidentRoleFromLabels(parentEntry.agent.labels)?.trim();
    if (role) return role;
  }
  return parentEntry?.agent.title?.trim() || fallbackTitle;
}

function toMemberNode(
  entry: LocatedDirectoryAgent,
  input: {
    depth: 0 | 1 | 2;
    isMain: boolean;
    fallbackTitle: string;
    entriesByKey?: ReadonlyMap<string, LocatedDirectoryAgent>;
  },
): TeamDirectoryMemberNode {
  const { agent, agentId, serverId } = entry;
  const { bucket, sortPriority, isRunning } = resolveMemberBucketAndPriority(agent);
  const resident = isResidentAgent(agent);
  const sideChat = isSideChatAgent(agent);
  const parentAddress = getParentAddressFromLabels(agent.labels, serverId);
  const parentTitle = resolveParentTitle(parentAddress, input.entriesByKey, input.fallbackTitle);
  const isStandalone = !parentAddress && !input.isMain && !resident && !sideChat;
  const isSilentSeat =
    !agent.archivedAt && agent.status === "closed" && agent.lastUserMessageAt === null;

  return {
    serverId,
    agentId,
    depth: input.depth,
    title: agent.title?.trim() || input.fallbackTitle,
    parentAgentId: parentAddress?.agentId ?? null,
    parentTitle,
    bucket,
    sortPriority,
    isArchived: Boolean(agent.archivedAt),
    isRunning,
    isSilentSeat,
    isMain: input.isMain,
    isStandalone,
    isResident: resident,
    isSideChat: sideChat,
    residentRole: resident ? getResidentRoleFromLabels(agent.labels) : null,
    residentSlug: resident ? getResidentRoleSlugFromLabels(agent.labels) : null,
    profileId: getAgentProfileIdFromLabels(agent.labels),
    lastActivityAt: getLastActivity(agent),
    createdAt: agent.createdAt,
  };
}

function mapProviderSubrun(
  descriptor: ProviderSubagentDescriptorPayload,
  fallbackTitle: string,
): TeamDirectoryNativeSubrunNode {
  const title = descriptor.description?.trim() || descriptor.title?.trim() || fallbackTitle;
  const subtitle =
    descriptor.subtitle?.trim() ||
    (descriptor.description?.trim() && descriptor.title?.trim() ? descriptor.title.trim() : null);
  let bucket: SidebarStateBucket = "done";
  let sortPriority: 0 | 1 | 2 | 3 = 3;
  if (descriptor.status === "failed") {
    bucket = "failed";
    sortPriority = 0;
  } else if (descriptor.status === "running") {
    bucket = "running";
    sortPriority = 1;
  }
  return {
    id: descriptor.id,
    parentAgentId: descriptor.parentAgentId,
    title,
    subtitle,
    bucket,
    sortPriority,
    createdAt: new Date(descriptor.createdAt),
  };
}

interface DirectoryBuildContext {
  serverId: string;
  workspaceId: string;
  fallbackTitle: string;
  entriesByKey: Map<string, LocatedDirectoryAgent>;
  childrenByParentKey: Map<string, LocatedDirectoryAgent[]>;
  pendingArchiveIds?: ReadonlySet<string>;
  visitedLiveKeys: Set<string>;
  allLiveWorkspaceAgentIds: Set<string>;
  residentGroupsMap: Map<string | null, TeamDirectoryResidentGroup>;
  residentSubtasks: TeamDirectoryMemberNode[];
  standaloneRoots: TeamDirectoryMemberNode[];
  sideChats: TeamDirectoryMemberNode[];
}

function isVisibleLiveEntry(
  entry: LocatedDirectoryAgent,
  pendingArchiveIds?: ReadonlySet<string>,
): boolean {
  return !entry.agent.archivedAt && !pendingArchiveIds?.has(teamDirectoryNodeKey(entry));
}

function buildDirectoryIndex(
  agentMaps: Readonly<Record<string, ReadonlyMap<string, TeamDirectoryAgent>>>,
  pendingArchiveIds?: ReadonlySet<string>,
): {
  entriesByKey: Map<string, LocatedDirectoryAgent>;
  childrenByParentKey: Map<string, LocatedDirectoryAgent[]>;
} {
  const entriesByKey = new Map<string, LocatedDirectoryAgent>();
  for (const [entryServerId, map] of Object.entries(agentMaps)) {
    for (const agent of map.values()) {
      if (agent.background) continue;
      const entry: LocatedDirectoryAgent = { serverId: entryServerId, agentId: agent.id, agent };
      entriesByKey.set(teamDirectoryNodeKey(entry), entry);
    }
  }
  const childrenByParentKey = new Map<string, LocatedDirectoryAgent[]>();
  for (const entry of entriesByKey.values()) {
    if (!isVisibleLiveEntry(entry, pendingArchiveIds)) continue;
    const parent = getParentAddressFromLabels(entry.agent.labels, entry.serverId);
    if (!parent) continue;
    const parentKey = teamDirectoryNodeKey(parent);
    const list = childrenByParentKey.get(parentKey);
    if (list) list.push(entry);
    else childrenByParentKey.set(parentKey, [entry]);
  }
  return { entriesByKey, childrenByParentKey };
}

function resolveMainEntry(input: {
  localAgents: ReadonlyMap<string, TeamDirectoryAgent> | undefined;
  mainAgentId: string | null;
  serverId: string;
  workspaceId: string;
  pendingArchiveIds?: ReadonlySet<string>;
}): LocatedDirectoryAgent | null {
  const { localAgents, mainAgentId, serverId, workspaceId, pendingArchiveIds } = input;
  const mainAgent = mainAgentId ? localAgents?.get(mainAgentId) : undefined;
  if (
    !mainAgent ||
    mainAgent.workspaceId !== workspaceId ||
    mainAgent.archivedAt ||
    mainAgent.background
  ) {
    return null;
  }
  const entry: LocatedDirectoryAgent = { serverId, agentId: mainAgent.id, agent: mainAgent };
  return pendingArchiveIds?.has(teamDirectoryNodeKey(entry)) ? null : entry;
}

function registerResidentNode(
  ctx: DirectoryBuildContext,
  entry: LocatedDirectoryAgent,
  depth: 0 | 1 | 2,
): void {
  const parent = getParentAddressFromLabels(entry.agent.labels, entry.serverId);
  const parentKey = parent ? teamDirectoryNodeKey(parent) : null;
  let group = ctx.residentGroupsMap.get(parentKey);
  if (!group) {
    const parentEntry = parentKey ? ctx.entriesByKey.get(parentKey) : undefined;
    group = {
      parent,
      parentTitle: parent ? parentEntry?.agent.title?.trim() || ctx.fallbackTitle : null,
      nodes: [],
    };
    ctx.residentGroupsMap.set(parentKey, group);
  }
  group.nodes.push(
    toMemberNode(entry, {
      depth,
      isMain: false,
      fallbackTitle: ctx.fallbackTitle,
      entriesByKey: ctx.entriesByKey,
    }),
  );
}

function collectResidentDescendants(
  ctx: DirectoryBuildContext,
  residentEntry: LocatedDirectoryAgent,
): void {
  const queue = [...(ctx.childrenByParentKey.get(teamDirectoryNodeKey(residentEntry)) ?? [])];
  while (queue.length > 0) {
    const childEntry = queue.shift()!;
    const childKey = teamDirectoryNodeKey(childEntry);
    if (ctx.visitedLiveKeys.has(childKey)) continue;
    ctx.visitedLiveKeys.add(childKey);
    if (childEntry.serverId === ctx.serverId) {
      ctx.allLiveWorkspaceAgentIds.add(childEntry.agentId);
    }
    if (isSideChatAgent(childEntry.agent)) {
      ctx.sideChats.push(
        toMemberNode(childEntry, {
          depth: 2,
          isMain: false,
          fallbackTitle: ctx.fallbackTitle,
          entriesByKey: ctx.entriesByKey,
        }),
      );
    } else if (isResidentAgent(childEntry.agent)) {
      registerResidentNode(ctx, childEntry, 2);
    } else {
      ctx.residentSubtasks.push(
        toMemberNode(childEntry, {
          depth: 2,
          isMain: false,
          fallbackTitle: ctx.fallbackTitle,
          entriesByKey: ctx.entriesByKey,
        }),
      );
    }
    const deeper = ctx.childrenByParentKey.get(childKey);
    if (deeper) queue.push(...deeper);
  }
}

function collectWorkspaceRoots(
  ctx: DirectoryBuildContext,
  mainEntry: LocatedDirectoryAgent | null,
): LocatedDirectoryAgent[] {
  const rootEntries: LocatedDirectoryAgent[] = mainEntry ? [mainEntry] : [];
  for (const entry of ctx.entriesByKey.values()) {
    if (entry.serverId !== ctx.serverId || entry.agent.workspaceId !== ctx.workspaceId) continue;
    if (!isVisibleLiveEntry(entry, ctx.pendingArchiveIds)) continue;
    const key = teamDirectoryNodeKey(entry);
    if (ctx.visitedLiveKeys.has(key)) continue;
    if (isSideChatAgent(entry.agent)) {
      ctx.visitedLiveKeys.add(key);
      ctx.allLiveWorkspaceAgentIds.add(entry.agentId);
      ctx.sideChats.push(
        toMemberNode(entry, {
          depth: 0,
          isMain: false,
          fallbackTitle: ctx.fallbackTitle,
          entriesByKey: ctx.entriesByKey,
        }),
      );
      continue;
    }
    if (!getParentAddressFromLabels(entry.agent.labels, entry.serverId)) {
      ctx.visitedLiveKeys.add(key);
      ctx.allLiveWorkspaceAgentIds.add(entry.agentId);
      if (isResidentAgent(entry.agent)) {
        registerResidentNode(ctx, entry, 0);
        collectResidentDescendants(ctx, entry);
      } else {
        ctx.standaloneRoots.push(
          toMemberNode(entry, {
            depth: 0,
            isMain: false,
            fallbackTitle: ctx.fallbackTitle,
            entriesByKey: ctx.entriesByKey,
          }),
        );
        rootEntries.push(entry);
      }
    }
  }
  return rootEntries;
}

function collectLevelOneTasks(
  ctx: DirectoryBuildContext,
  rootEntries: readonly LocatedDirectoryAgent[],
): LocatedDirectoryAgent[] {
  const levelOneTaskEntries: LocatedDirectoryAgent[] = [];
  for (const rootEntry of rootEntries) {
    for (const child of ctx.childrenByParentKey.get(teamDirectoryNodeKey(rootEntry)) ?? []) {
      const childKey = teamDirectoryNodeKey(child);
      if (ctx.visitedLiveKeys.has(childKey)) continue;
      ctx.visitedLiveKeys.add(childKey);
      if (child.serverId === ctx.serverId) ctx.allLiveWorkspaceAgentIds.add(child.agentId);
      if (isSideChatAgent(child.agent)) {
        ctx.sideChats.push(
          toMemberNode(child, {
            depth: 1,
            isMain: false,
            fallbackTitle: ctx.fallbackTitle,
            entriesByKey: ctx.entriesByKey,
          }),
        );
      } else if (isResidentAgent(child.agent)) {
        registerResidentNode(ctx, child, 1);
        collectResidentDescendants(ctx, child);
      } else {
        levelOneTaskEntries.push(child);
      }
    }
  }
  return levelOneTaskEntries;
}

function buildTaskBranch(
  ctx: DirectoryBuildContext,
  l1Entry: LocatedDirectoryAgent,
): TeamDirectoryTaskBranch {
  const l1Node = toMemberNode(l1Entry, {
    depth: 1,
    isMain: false,
    fallbackTitle: ctx.fallbackTitle,
    entriesByKey: ctx.entriesByKey,
  });
  const l2Nodes: TeamDirectoryMemberNode[] = [];
  const queue = [...(ctx.childrenByParentKey.get(teamDirectoryNodeKey(l1Entry)) ?? [])];
  while (queue.length > 0) {
    const l2Entry = queue.shift()!;
    const l2Key = teamDirectoryNodeKey(l2Entry);
    if (ctx.visitedLiveKeys.has(l2Key)) continue;
    ctx.visitedLiveKeys.add(l2Key);
    if (l2Entry.serverId === ctx.serverId) ctx.allLiveWorkspaceAgentIds.add(l2Entry.agentId);
    if (isSideChatAgent(l2Entry.agent)) {
      ctx.sideChats.push(
        toMemberNode(l2Entry, {
          depth: 2,
          isMain: false,
          fallbackTitle: ctx.fallbackTitle,
          entriesByKey: ctx.entriesByKey,
        }),
      );
    } else if (isResidentAgent(l2Entry.agent)) {
      registerResidentNode(ctx, l2Entry, 2);
    } else {
      l2Nodes.push(
        toMemberNode(l2Entry, {
          depth: 2,
          isMain: false,
          fallbackTitle: ctx.fallbackTitle,
          entriesByKey: ctx.entriesByKey,
        }),
      );
    }
    const deeper = ctx.childrenByParentKey.get(l2Key);
    if (deeper) queue.push(...deeper);
  }
  l2Nodes.sort(compareMembers);
  const bestChildPriority = l2Nodes.reduce<0 | 1 | 2 | 3>(
    (best, child) => (child.sortPriority < best ? child.sortPriority : best),
    3,
  );
  const effectivePriority: 0 | 1 | 2 | 3 =
    bestChildPriority < l1Node.sortPriority ? bestChildPriority : l1Node.sortPriority;
  return { node: l1Node, children: l2Nodes, effectivePriority };
}

function appendOrphanedWorkspaceEntries(
  ctx: DirectoryBuildContext,
  taskTree: TeamDirectoryTaskBranch[],
): void {
  for (const entry of ctx.entriesByKey.values()) {
    if (entry.serverId !== ctx.serverId || entry.agent.workspaceId !== ctx.workspaceId) continue;
    if (!isVisibleLiveEntry(entry, ctx.pendingArchiveIds)) continue;
    const key = teamDirectoryNodeKey(entry);
    if (ctx.visitedLiveKeys.has(key)) continue;
    ctx.visitedLiveKeys.add(key);
    ctx.allLiveWorkspaceAgentIds.add(entry.agentId);
    if (isSideChatAgent(entry.agent)) {
      ctx.sideChats.push(
        toMemberNode(entry, {
          depth: 1,
          isMain: false,
          fallbackTitle: ctx.fallbackTitle,
          entriesByKey: ctx.entriesByKey,
        }),
      );
    } else if (isResidentAgent(entry.agent)) {
      registerResidentNode(ctx, entry, 1);
    } else {
      const node = toMemberNode(entry, {
        depth: 1,
        isMain: false,
        fallbackTitle: ctx.fallbackTitle,
        entriesByKey: ctx.entriesByKey,
      });
      taskTree.push({ node, children: [], effectivePriority: node.sortPriority });
    }
  }
}

function finalizeResidentGroups(
  residentGroupsMap: Map<string | null, TeamDirectoryResidentGroup>,
  mainKey: string | null,
  standaloneRoots: readonly TeamDirectoryMemberNode[],
): { residentGroups: TeamDirectoryResidentGroup[]; flattenResidentGroups: boolean } {
  const residentGroups: TeamDirectoryResidentGroup[] = [];
  if (mainKey && residentGroupsMap.has(mainKey)) {
    const mainGroup = residentGroupsMap.get(mainKey)!;
    residentGroupsMap.delete(mainKey);
    mainGroup.nodes.sort(compareMembers);
    residentGroups.push(mainGroup);
  }
  for (const group of residentGroupsMap.values()) {
    group.nodes.sort(compareMembers);
    residentGroups.push(group);
  }
  const singleGroup = residentGroups.length === 1 ? residentGroups[0] : null;
  const anchoredToMain =
    mainKey !== null &&
    singleGroup?.parent !== null &&
    singleGroup?.parent !== undefined &&
    teamDirectoryNodeKey(singleGroup.parent) === mainKey;
  return {
    residentGroups,
    flattenResidentGroups: Boolean(singleGroup && (standaloneRoots.length === 0 || anchoredToMain)),
  };
}

function selectPresetResidents(
  residentProfiles: readonly AgentProfile[],
  residentGroups: readonly TeamDirectoryResidentGroup[],
): TeamDirectoryPresetResident[] {
  const registeredProfileIds = new Set<string>();
  const registeredRoleSlugs = new Set<string>();
  for (const group of residentGroups) {
    for (const node of group.nodes) {
      if (node.profileId) registeredProfileIds.add(node.profileId);
      if (node.residentSlug) registeredRoleSlugs.add(node.residentSlug);
    }
  }
  const presetResidents: TeamDirectoryPresetResident[] = [];
  for (const profile of residentProfiles) {
    if (!profile.defaultResident || registeredProfileIds.has(profile.id)) continue;
    if (profile.roleSlug && registeredRoleSlugs.has(profile.roleSlug)) continue;
    presetResidents.push({
      profileId: profile.id,
      name: profile.name,
      roleSlug: profile.roleSlug ?? null,
      provider: profile.provider,
    });
  }
  return presetResidents;
}

function isCleanableLeafOrSubtask(
  node: TeamDirectoryMemberNode,
  entriesByKey: ReadonlyMap<string, LocatedDirectoryAgent>,
  childrenByParentKey: ReadonlyMap<string, LocatedDirectoryAgent[]>,
): boolean {
  const key = teamDirectoryNodeKey(node);
  const entry = entriesByKey.get(key);
  if (!entry || !isDirectlyCleanableTaskMember(entry.agent, entry.serverId)) return false;
  const rawChildren = childrenByParentKey.get(key) ?? [];
  return rawChildren.every((child) => isDirectlyCleanableTaskMember(child.agent, child.serverId));
}

function collectCleanableTaskMembers(
  taskTree: readonly TeamDirectoryTaskBranch[],
  residentSubtasks: readonly TeamDirectoryMemberNode[],
  entriesByKey: ReadonlyMap<string, LocatedDirectoryAgent>,
  childrenByParentKey: ReadonlyMap<string, LocatedDirectoryAgent[]>,
): AgentAddress[] {
  const cleanable: AgentAddress[] = [];
  for (const branch of taskTree) {
    let allChildrenCleanable = true;
    for (const childNode of branch.children) {
      if (isCleanableLeafOrSubtask(childNode, entriesByKey, childrenByParentKey)) {
        cleanable.push({ serverId: childNode.serverId, agentId: childNode.agentId });
      } else {
        allChildrenCleanable = false;
      }
    }
    const rawChildren = childrenByParentKey.get(teamDirectoryNodeKey(branch.node)) ?? [];
    const hasProtectedChild = rawChildren.some(
      (child) => isResidentAgent(child.agent) || isSideChatAgent(child.agent),
    );
    const branchEntry = entriesByKey.get(teamDirectoryNodeKey(branch.node));
    if (
      allChildrenCleanable &&
      !hasProtectedChild &&
      branchEntry &&
      isDirectlyCleanableTaskMember(branchEntry.agent, branchEntry.serverId)
    ) {
      cleanable.push({ serverId: branch.node.serverId, agentId: branch.node.agentId });
    }
  }
  for (const subtask of residentSubtasks) {
    if (isCleanableLeafOrSubtask(subtask, entriesByKey, childrenByParentKey)) {
      cleanable.push({ serverId: subtask.serverId, agentId: subtask.agentId });
    }
  }
  return cleanable;
}

function selectHistoryMembers(input: {
  archivedAgents: readonly TeamDirectoryAgent[];
  serverId: string;
  workspaceId: string;
  visitedLiveKeys: ReadonlySet<string>;
  fallbackTitle: string;
}): TeamDirectoryMemberNode[] {
  const historyByKey = new Map<string, TeamDirectoryMemberNode>();
  for (const agent of input.archivedAgents) {
    if (!agent.archivedAt || agent.background || agent.workspaceId !== input.workspaceId) continue;
    const entry: LocatedDirectoryAgent = { serverId: input.serverId, agentId: agent.id, agent };
    const key = teamDirectoryNodeKey(entry);
    if (input.visitedLiveKeys.has(key) || historyByKey.has(key)) continue;
    historyByKey.set(
      key,
      toMemberNode(entry, { depth: 0, isMain: false, fallbackTitle: input.fallbackTitle }),
    );
  }
  return [...historyByKey.values()].sort(
    (left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime(),
  );
}

function computeDirectorySummary(input: {
  mainSeat: TeamDirectoryMemberNode | null;
  allLiveNodes: readonly TeamDirectoryMemberNode[];
  nativeSubruns: readonly TeamDirectoryNativeSubrunNode[];
  serverId: string;
}): TeamDirectorySummary {
  let runningCount = 0;
  let needsInputCount = 0;
  let firstNeedsInputAgentId: string | null = null;
  for (const node of input.allLiveNodes) {
    if (node.isRunning) runningCount += 1;
    if (node.bucket === "needs_input") {
      needsInputCount += 1;
      if (!firstNeedsInputAgentId && node.serverId === input.serverId) {
        firstNeedsInputAgentId = node.agentId;
      }
    }
  }
  for (const subrun of input.nativeSubruns) {
    if (subrun.bucket === "running") runningCount += 1;
  }
  return {
    hasMain: input.mainSeat !== null,
    isMainSilent: Boolean(input.mainSeat?.isSilentSeat),
    runningCount,
    activeCount: input.allLiveNodes.length,
    needsInputCount,
    firstNeedsInputAgentId,
  };
}

export function selectTeamDirectoryData(input: {
  serverId: string;
  workspaceId: string;
  mainAgentId: string | null;
  agentMaps: Readonly<Record<string, ReadonlyMap<string, TeamDirectoryAgent>>>;
  archivedAgents?: readonly TeamDirectoryAgent[];
  residentProfiles?: readonly AgentProfile[];
  providerSubagents?: readonly ProviderSubagentDescriptorPayload[];
  pendingArchiveIds?: ReadonlySet<string>;
  fallbackTitle: string;
}): TeamDirectoryData {
  const {
    serverId,
    workspaceId,
    mainAgentId,
    agentMaps,
    archivedAgents = [],
    residentProfiles = [],
    providerSubagents = [],
    pendingArchiveIds,
    fallbackTitle,
  } = input;

  const { entriesByKey, childrenByParentKey } = buildDirectoryIndex(agentMaps, pendingArchiveIds);
  const mainEntry = resolveMainEntry({
    localAgents: agentMaps[serverId],
    mainAgentId,
    serverId,
    workspaceId,
    pendingArchiveIds,
  });
  const mainSeat = mainEntry
    ? toMemberNode(mainEntry, { depth: 0, isMain: true, fallbackTitle })
    : null;

  const ctx: DirectoryBuildContext = {
    serverId,
    workspaceId,
    fallbackTitle,
    entriesByKey,
    childrenByParentKey,
    pendingArchiveIds,
    visitedLiveKeys: new Set<string>(),
    allLiveWorkspaceAgentIds: new Set<string>(),
    residentGroupsMap: new Map<string | null, TeamDirectoryResidentGroup>(),
    residentSubtasks: [],
    standaloneRoots: [],
    sideChats: [],
  };
  if (mainEntry) {
    ctx.visitedLiveKeys.add(teamDirectoryNodeKey(mainEntry));
    ctx.allLiveWorkspaceAgentIds.add(mainEntry.agentId);
  }

  const rootEntries = collectWorkspaceRoots(ctx, mainEntry);
  const levelOneTaskEntries = collectLevelOneTasks(ctx, rootEntries);
  const taskTree = levelOneTaskEntries.map((entry) => buildTaskBranch(ctx, entry));
  appendOrphanedWorkspaceEntries(ctx, taskTree);

  taskTree.sort((left, right) =>
    left.effectivePriority !== right.effectivePriority
      ? left.effectivePriority - right.effectivePriority
      : compareMembers(left.node, right.node),
  );
  ctx.residentSubtasks.sort(compareMembers);
  ctx.standaloneRoots.sort(compareMembers);
  ctx.sideChats.sort(compareMembers);

  const mainKey = mainEntry ? teamDirectoryNodeKey(mainEntry) : null;
  const { residentGroups, flattenResidentGroups } = finalizeResidentGroups(
    ctx.residentGroupsMap,
    mainKey,
    ctx.standaloneRoots,
  );
  const presetResidents = selectPresetResidents(residentProfiles, residentGroups);
  const cleanableTaskMembers = collectCleanableTaskMembers(
    taskTree,
    ctx.residentSubtasks,
    entriesByKey,
    childrenByParentKey,
  );
  const nativeSubruns = providerSubagents
    .filter((item) => ctx.allLiveWorkspaceAgentIds.has(item.parentAgentId))
    .map((item) => mapProviderSubrun(item, fallbackTitle))
    .sort((left, right) =>
      left.sortPriority !== right.sortPriority
        ? left.sortPriority - right.sortPriority
        : right.createdAt.getTime() - left.createdAt.getTime(),
    );
  const historyMembers = selectHistoryMembers({
    archivedAgents,
    serverId,
    workspaceId,
    visitedLiveKeys: ctx.visitedLiveKeys,
    fallbackTitle,
  });
  const allLiveNodes: TeamDirectoryMemberNode[] = [
    ...(mainSeat ? [mainSeat] : []),
    ...ctx.standaloneRoots,
    ...residentGroups.flatMap((group) => group.nodes),
    ...ctx.residentSubtasks,
    ...taskTree.flatMap((branch) => [branch.node, ...branch.children]),
    ...ctx.sideChats,
  ];

  return {
    mainSeat,
    standaloneRoots: ctx.standaloneRoots,
    residentGroups,
    residentSubtasks: ctx.residentSubtasks,
    flattenResidentGroups,
    presetResidents,
    taskTree,
    sideChats: ctx.sideChats,
    nativeSubruns,
    cleanableTaskMembers,
    historyMembers,
    summary: computeDirectorySummary({ mainSeat, allLiveNodes, nativeSubruns, serverId }),
  };
}

export function selectWorkspaceTeamSummary(input: {
  serverId: string;
  workspaceId: string;
  mainAgentId: string | null;
  agents: ReadonlyMap<string, TeamDirectoryAgent> | undefined;
}): TeamDirectorySummary {
  const { workspaceId, mainAgentId, agents } = input;
  if (!agents) {
    return {
      hasMain: false,
      isMainSilent: false,
      runningCount: 0,
      activeCount: 0,
      needsInputCount: 0,
      firstNeedsInputAgentId: null,
    };
  }
  const main = mainAgentId ? agents.get(mainAgentId) : undefined;
  const hasMain = Boolean(
    main && main.workspaceId === workspaceId && !main.archivedAt && !main.background,
  );
  const isMainSilent = Boolean(
    hasMain && main && main.status === "closed" && main.lastUserMessageAt === null,
  );
  let runningCount = 0;
  let activeCount = 0;
  let needsInputCount = 0;
  let firstNeedsInputAgentId: string | null = null;
  for (const agent of agents.values()) {
    if (agent.archivedAt || agent.background || agent.workspaceId !== workspaceId) continue;
    activeCount += 1;
    const { bucket, isRunning } = resolveMemberBucketAndPriority(agent);
    if (isRunning) runningCount += 1;
    if (bucket === "needs_input") {
      needsInputCount += 1;
      if (!firstNeedsInputAgentId) firstNeedsInputAgentId = agent.id;
    }
  }
  return {
    hasMain,
    isMainSilent,
    runningCount,
    activeCount,
    needsInputCount,
    firstNeedsInputAgentId,
  };
}

export function selectTeamActivityGroups(
  data: TeamDirectoryData,
  focusedAddress: AgentAddress | null,
  focusedProviderSubagentId: string | null = null,
): TeamDirectoryActivityGroups {
  const allLiveNodes: TeamDirectoryMemberNode[] = [
    ...(data.mainSeat ? [data.mainSeat] : []),
    ...data.standaloneRoots,
    ...data.residentGroups.flatMap((group) => group.nodes),
    ...data.residentSubtasks,
    ...data.taskTree.flatMap((branch) => [branch.node, ...branch.children]),
    ...data.sideChats,
  ];

  const activeMembers: TeamDirectoryMemberNode[] = [];
  const pinnedInactiveMembers: TeamDirectoryMemberNode[] = [];
  const collapsibleInactiveMembers: TeamDirectoryMemberNode[] = [];

  for (const node of allLiveNodes) {
    if (isMemberActivelyWorking(node)) {
      activeMembers.push(node);
    } else if (shouldKeepMemberExpanded(node, focusedAddress)) {
      pinnedInactiveMembers.push(node);
    } else {
      collapsibleInactiveMembers.push(node);
    }
  }

  activeMembers.sort((left, right) => {
    if (left.isMain !== right.isMain) return left.isMain ? -1 : 1;
    return compareMembers(left, right);
  });
  pinnedInactiveMembers.sort((left, right) => {
    if (left.isMain !== right.isMain) return left.isMain ? -1 : 1;
    return compareMembers(left, right);
  });
  collapsibleInactiveMembers.sort((left, right) => {
    if (left.isMain !== right.isMain) return left.isMain ? -1 : 1;
    if (left.isResident !== right.isResident) return left.isResident ? -1 : 1;
    return compareMembers(left, right);
  });

  const activeSubruns: TeamDirectoryNativeSubrunNode[] = [];
  const inactiveSubruns: TeamDirectoryNativeSubrunNode[] = [];
  for (const subrun of data.nativeSubruns) {
    if (subrun.bucket === "running" || subrun.id === focusedProviderSubagentId) {
      activeSubruns.push(subrun);
    } else {
      inactiveSubruns.push(subrun);
    }
  }

  return {
    activeMembers,
    activeSubruns,
    pinnedInactiveMembers,
    collapsibleInactiveMembers,
    inactiveSubruns,
    totalInactiveCount:
      pinnedInactiveMembers.length + collapsibleInactiveMembers.length + inactiveSubruns.length,
  };
}

function splitAttributeSection(
  nodes: readonly TeamDirectoryMemberNode[],
  focusedAddress: AgentAddress | null,
): TeamDirectoryAttributeSectionSplit {
  const expandedMembers: TeamDirectoryMemberNode[] = [];
  const foldedInactiveMembers: TeamDirectoryMemberNode[] = [];
  for (const node of nodes) {
    if (shouldKeepMemberExpanded(node, focusedAddress)) {
      expandedMembers.push(node);
    } else {
      foldedInactiveMembers.push(node);
    }
  }
  return { expandedMembers, foldedInactiveMembers };
}

export function selectTeamAttributeGroups(
  data: TeamDirectoryData,
  focusedAddress: AgentAddress | null,
): TeamDirectoryAttributeGroups {
  const residentNodes = data.residentGroups.flatMap((group) => group.nodes);
  const levelOneTaskNodes = data.taskTree.map((branch) => branch.node);
  const levelOneOrdered = [...residentNodes, ...levelOneTaskNodes];
  const levelTwoOrdered = [
    ...data.taskTree.flatMap((branch) => branch.children),
    ...data.residentSubtasks,
  ];
  levelTwoOrdered.sort(compareMembers);

  return {
    mainSeat: data.mainSeat,
    standaloneRoots: data.standaloneRoots,
    sideChats: data.sideChats,
    levelOne: splitAttributeSection(levelOneOrdered, focusedAddress),
    levelTwo: splitAttributeSection(levelTwoOrdered, focusedAddress),
    levelTwoSubruns: data.nativeSubruns,
  };
}
