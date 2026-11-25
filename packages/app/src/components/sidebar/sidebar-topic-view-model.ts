import type { TFunction } from "i18next";
import type { WorkspaceSort } from "@/projects/workspace-structure";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { resolveActiveTopicCompletedAt } from "@/stores/sidebar-topic-completion-store";
import { isWorkspaceDeferred } from "@/workspace-deferral/model";

export type TopicStatusBucket = "pending_action" | "in_progress" | "completed";

export const TOPIC_STATUS_BUCKET_ORDER: readonly TopicStatusBucket[] = [
  "pending_action",
  "in_progress",
  "completed",
];

export type TopicPendingReason =
  | "approval"
  | "failed"
  | "unread_conclusion"
  | "awaiting_first_prompt";

export interface TopicWorkspaceFacts {
  isTopic: boolean;
  setupStatus: WorkspaceDescriptor["setupStatus"];
  createdAt: Date | null;
  lastUserMessageAt: Date | null;
  completedAt: Date | null;
  pendingDurableCount: number;
  hasSubagentPendingPermission: boolean;
  hasActiveWorkspaceAgent: boolean;
}

export interface TopicStatusClassification {
  bucket: TopicStatusBucket;
  pendingReason: TopicPendingReason | null;
  isActivelyWorking: boolean;
}

export interface TopicGroup {
  bucket: TopicStatusBucket;
  label: string;
  rows: SidebarWorkspaceEntry[];
}

const TOPIC_BUCKET_LABEL_KEYS: Record<TopicStatusBucket, string> = {
  pending_action: "topicWorkbench.sidebar.bucket.pending_action",
  in_progress: "topicWorkbench.sidebar.bucket.in_progress",
  completed: "topicWorkbench.sidebar.bucket.completed",
};

const PENDING_REASON_PRIORITY: Record<TopicPendingReason, number> = {
  approval: 0,
  failed: 1,
  unread_conclusion: 2,
  awaiting_first_prompt: 3,
};

export function getTopicStatusBucketLabel(bucket: TopicStatusBucket, t: TFunction): string {
  return t(TOPIC_BUCKET_LABEL_KEYS[bucket]);
}

function isAgentLiveWorking(
  agent: Pick<
    Agent,
    "archivedAt" | "background" | "status" | "turn" | "backgroundWork" | "pendingSubagentInbox"
  >,
): boolean {
  if (agent.archivedAt || agent.background) return false;
  if (agent.turn.phase === "open") return true;
  if (agent.status === "running" || agent.status === "initializing") return true;
  if ((agent.backgroundWork?.runningCount ?? agent.backgroundWork?.count ?? 0) > 0) return true;
  if ((agent.pendingSubagentInbox?.items.length ?? 0) > 0) return true;
  return false;
}

function hasAgentPendingPermission(
  agent: Pick<Agent, "archivedAt" | "background" | "pendingPermissions" | "attentionReason">,
): boolean {
  if (agent.archivedAt || agent.background) return false;
  return (agent.pendingPermissions?.length ?? 0) > 0 || agent.attentionReason === "permission";
}

export type TopicWorkspaceAgent = Pick<
  Agent,
  | "archivedAt"
  | "background"
  | "status"
  | "turn"
  | "backgroundWork"
  | "pendingSubagentInbox"
  | "pendingPermissions"
  | "requiresAttention"
  | "attentionReason"
  | "attentionTimestamp"
  | "updatedAt"
>;

function maxNullableMs(
  current: number | null,
  candidate: number | null | undefined,
): number | null {
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) return current;
  return current === null ? candidate : Math.max(current, candidate);
}

function resolveDescriptorWorkSignalMs(workspace: WorkspaceDescriptor | undefined): number | null {
  if (!workspace) return null;
  let maxMs = workspace.lastUserMessageAt?.getTime() ?? null;
  if (
    workspace.status === "running" ||
    workspace.status === "needs_input" ||
    workspace.status === "failed" ||
    workspace.status === "attention"
  ) {
    maxMs = maxNullableMs(maxMs, workspace.statusEnteredAt?.getTime());
  }
  return maxMs;
}

export function resolveWorkspaceLatestWorkSignalMs(input: {
  workspace: WorkspaceDescriptor | undefined;
  workspaceAgents: Iterable<TopicWorkspaceAgent>;
  latestPendingDurableCreatedAtMs?: number | null;
  lastWorkAtIso?: string;
}): number | null {
  let latestMs = maxNullableMs(
    resolveDescriptorWorkSignalMs(input.workspace),
    input.latestPendingDurableCreatedAtMs,
  );
  if (input.lastWorkAtIso) {
    latestMs = maxNullableMs(latestMs, Date.parse(input.lastWorkAtIso));
  }
  for (const agent of input.workspaceAgents) {
    if (hasAgentPendingPermission(agent) || isAgentLiveWorking(agent)) {
      const signalDate = agent.attentionTimestamp ?? agent.updatedAt;
      latestMs = maxNullableMs(latestMs, signalDate?.getTime());
    } else if (!agent.archivedAt && !agent.background && agent.requiresAttention === true) {
      latestMs = maxNullableMs(latestMs, agent.attentionTimestamp?.getTime());
    }
  }
  return latestMs;
}

export function buildWorkspaceTopicFacts(input: {
  workspace: WorkspaceDescriptor | undefined;
  workspaceAgents: Iterable<TopicWorkspaceAgent>;
  completedAtIso: string | undefined;
  lastWorkAtIso?: string;
  pendingDurableCount: number;
  latestPendingDurableCreatedAtMs?: number | null;
  isDispatchInProgress?: boolean;
}): TopicWorkspaceFacts {
  const {
    workspace,
    workspaceAgents,
    completedAtIso,
    lastWorkAtIso,
    pendingDurableCount,
    latestPendingDurableCreatedAtMs = null,
    isDispatchInProgress = false,
  } = input;
  const agentList = Array.from(workspaceAgents);
  let hasSubagentPendingPermission = false;
  let hasActiveWorkspaceAgent = isDispatchInProgress;
  for (const agent of agentList) {
    if (hasAgentPendingPermission(agent)) hasSubagentPendingPermission = true;
    if (isAgentLiveWorking(agent)) hasActiveWorkspaceAgent = true;
  }
  const latestReactivationAtMs = resolveWorkspaceLatestWorkSignalMs({
    workspace,
    workspaceAgents: agentList,
    latestPendingDurableCreatedAtMs,
    lastWorkAtIso,
  });
  const lastUserMessageAt = workspace?.lastUserMessageAt ?? null;

  return {
    isTopic: Boolean(workspace?.topic),
    setupStatus: workspace?.setupStatus ?? null,
    createdAt: workspace?.createdAt ?? null,
    lastUserMessageAt,
    completedAt: resolveActiveTopicCompletedAt({
      completedAtIso,
      latestReactivationAtMs,
    }),
    pendingDurableCount,
    hasSubagentPendingPermission,
    hasActiveWorkspaceAgent,
  };
}

function isTopicActivelyWorking(
  entry: Pick<SidebarWorkspaceEntry, "statusBucket">,
  setupStatus: WorkspaceDescriptor["setupStatus"],
  facts: TopicWorkspaceFacts | undefined,
): boolean {
  return (
    entry.statusBucket === "running" ||
    setupStatus === "running" ||
    Boolean(facts?.hasActiveWorkspaceAgent)
  );
}

function isPendingApprovalTopic(
  entry: Pick<SidebarWorkspaceEntry, "statusBucket">,
  facts: TopicWorkspaceFacts | undefined,
): boolean {
  return (
    entry.statusBucket === "needs_input" ||
    Boolean(facts?.hasSubagentPendingPermission) ||
    (facts?.pendingDurableCount ?? 0) > 0
  );
}

function isFailedTopic(
  entry: Pick<SidebarWorkspaceEntry, "statusBucket">,
  setupStatus: WorkspaceDescriptor["setupStatus"],
): boolean {
  return entry.statusBucket === "failed" || setupStatus === "failed" || setupStatus === "blocked";
}

export function deriveTopicStatusClassification(
  entry: Pick<SidebarWorkspaceEntry, "statusBucket">,
  facts: TopicWorkspaceFacts | undefined,
): TopicStatusClassification {
  const setupStatus = facts?.setupStatus ?? null;
  const isActivelyWorking = isTopicActivelyWorking(entry, setupStatus, facts);

  if (isPendingApprovalTopic(entry, facts)) {
    return { bucket: "pending_action", pendingReason: "approval", isActivelyWorking };
  }
  if (isFailedTopic(entry, setupStatus)) {
    return { bucket: "pending_action", pendingReason: "failed", isActivelyWorking };
  }
  if (isActivelyWorking) {
    return { bucket: "in_progress", pendingReason: null, isActivelyWorking: true };
  }

  const completedAt = facts?.completedAt ?? null;
  if (completedAt !== null) {
    return { bucket: "completed", pendingReason: null, isActivelyWorking: false };
  }

  if (entry.statusBucket === "attention") {
    return {
      bucket: "pending_action",
      pendingReason: "unread_conclusion",
      isActivelyWorking: false,
    };
  }

  const lastUserMessageAt = facts?.lastUserMessageAt ?? null;
  if (lastUserMessageAt === null) {
    return {
      bucket: "pending_action",
      pendingReason: "awaiting_first_prompt",
      isActivelyWorking: false,
    };
  }
  return { bucket: "in_progress", pendingReason: null, isActivelyWorking: false };
}

export function buildTopicGroups(input: {
  workspaces: readonly SidebarWorkspaceEntry[];
  factsByWorkspaceKey: ReadonlyMap<string, TopicWorkspaceFacts>;
  projectNamesByViewKey: ReadonlyMap<string, string>;
  workspaceSort: WorkspaceSort;
  t: TFunction;
}): TopicGroup[] {
  const { workspaces, factsByWorkspaceKey, projectNamesByViewKey, workspaceSort, t } = input;
  const bucketRows = new Map<
    TopicStatusBucket,
    Array<{ entry: SidebarWorkspaceEntry; classification: TopicStatusClassification }>
  >();

  for (const ws of workspaces) {
    if (isWorkspaceDeferred(ws)) continue;
    const facts = factsByWorkspaceKey.get(ws.workspaceKey);
    const classification = deriveTopicStatusClassification(ws, facts);
    let rows = bucketRows.get(classification.bucket);
    if (!rows) {
      rows = [];
      bucketRows.set(classification.bucket, rows);
    }
    rows.push({ entry: ws, classification });
  }

  const groups: TopicGroup[] = [];
  for (const bucket of TOPIC_STATUS_BUCKET_ORDER) {
    const items = bucketRows.get(bucket);
    if (!items || items.length === 0) continue;

    items.sort((left, right) =>
      compareTopicGroupRows({
        bucket,
        left,
        right,
        factsByWorkspaceKey,
        projectNamesByViewKey,
        workspaceSort,
      }),
    );

    groups.push({
      bucket,
      label: getTopicStatusBucketLabel(bucket, t),
      rows: items.map((item) => item.entry),
    });
  }

  return groups;
}

function compareNullableDatesDesc(
  left: Date | null | undefined,
  right: Date | null | undefined,
): number {
  const leftMs = left?.getTime() ?? null;
  const rightMs = right?.getTime() ?? null;
  if (leftMs !== null && rightMs !== null) {
    return rightMs - leftMs;
  }
  if (leftMs !== null) return -1;
  if (rightMs !== null) return 1;
  return 0;
}

function firstValidDate(candidates: readonly (Date | null | undefined)[]): Date | null {
  for (const candidate of candidates) {
    if (candidate != null) return candidate;
  }
  return null;
}

function resolveRowSortDate(
  bucket: TopicStatusBucket,
  entry: SidebarWorkspaceEntry,
  facts: TopicWorkspaceFacts | undefined,
  workspaceSort: WorkspaceSort,
): Date | null {
  if (bucket === "completed") {
    return firstValidDate([
      facts?.completedAt,
      entry.statusEnteredAt,
      facts?.lastUserMessageAt,
      facts?.createdAt,
    ]);
  }
  if (bucket === "in_progress" && workspaceSort === "created") {
    return firstValidDate([facts?.createdAt, entry.statusEnteredAt, facts?.lastUserMessageAt]);
  }
  if (bucket === "in_progress") {
    return firstValidDate([facts?.lastUserMessageAt, entry.statusEnteredAt, facts?.createdAt]);
  }
  return firstValidDate([entry.statusEnteredAt, facts?.lastUserMessageAt, facts?.createdAt]);
}

function compareTopicGroupRows(input: {
  bucket: TopicStatusBucket;
  left: { entry: SidebarWorkspaceEntry; classification: TopicStatusClassification };
  right: { entry: SidebarWorkspaceEntry; classification: TopicStatusClassification };
  factsByWorkspaceKey: ReadonlyMap<string, TopicWorkspaceFacts>;
  projectNamesByViewKey: ReadonlyMap<string, string>;
  workspaceSort: WorkspaceSort;
}): number {
  const { bucket, left, right, factsByWorkspaceKey, projectNamesByViewKey, workspaceSort } = input;

  if (bucket === "pending_action") {
    const leftReason = left.classification.pendingReason ?? "awaiting_first_prompt";
    const rightReason = right.classification.pendingReason ?? "awaiting_first_prompt";
    const reasonDiff = PENDING_REASON_PRIORITY[leftReason] - PENDING_REASON_PRIORITY[rightReason];
    if (reasonDiff !== 0) return reasonDiff;
  }

  if (bucket === "in_progress") {
    if (left.classification.isActivelyWorking !== right.classification.isActivelyWorking) {
      return left.classification.isActivelyWorking ? -1 : 1;
    }
  }

  const leftFacts = factsByWorkspaceKey.get(left.entry.workspaceKey);
  const rightFacts = factsByWorkspaceKey.get(right.entry.workspaceKey);
  const dateDiff = compareNullableDatesDesc(
    resolveRowSortDate(bucket, left.entry, leftFacts, workspaceSort),
    resolveRowSortDate(bucket, right.entry, rightFacts, workspaceSort),
  );
  if (dateDiff !== 0) return dateDiff;

  const leftProject = projectNamesByViewKey.get(left.entry.projectViewKey) ?? "";
  const rightProject = projectNamesByViewKey.get(right.entry.projectViewKey) ?? "";
  const projectDiff = leftProject.localeCompare(rightProject);
  if (projectDiff !== 0) return projectDiff;

  const nameDiff = left.entry.name.localeCompare(right.entry.name);
  if (nameDiff !== 0) return nameDiff;

  return left.entry.workspaceKey.localeCompare(right.entry.workspaceKey);
}
