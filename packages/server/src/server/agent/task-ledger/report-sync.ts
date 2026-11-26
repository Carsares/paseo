import { hasResidentInboxBypass, isMainControlAgentLabels } from "@getpaseo/protocol/agent-labels";
import type { WorkspaceTask, WorkspaceTaskTurnOutcomePatch } from "./index.js";
import { isActiveWorkspaceTask, mergeTouchedFiles } from "./touched-files.js";

interface ReportParent {
  workspaceId?: string | null;
  labels: Record<string, string>;
  archivedAt?: string | null;
}

interface MainControlWakeupCheck {
  workspaceId: string;
  parentAgent: ReportParent | null | undefined;
  /** Established by the caller from the workspace registry. */
  topicMainMatches: boolean;
  explicit: boolean;
  status: string | undefined;
  escalateToParent?: boolean;
  childAgentId: string;
  childServerId: string;
  localServerId: string;
  childLabels?: Record<string, string>;
  task: Readonly<WorkspaceTask> | null | undefined;
  tasks: readonly Readonly<WorkspaceTask>[];
  rootMessageId?: string;
  shouldHoldInbox: boolean;
  hasBufferedTaskReports: boolean;
  summary: string;
  touchedFiles?: readonly string[];
  sourceKind: string;
}

export function shouldBypassMainControlWakeup(check: MainControlWakeupCheck): boolean {
  if (!isEligibleBypassCandidate(check)) return false;
  const { task } = check;
  if (!task) {
    return (
      check.status === "completed" &&
      Boolean(check.rootMessageId?.trim()) &&
      !hasUnscopedReportFileConflict(check)
    );
  }
  return canBypassTaskReport(task, check);
}

function isEligibleBypassCandidate(check: MainControlWakeupCheck): boolean {
  if (!isExplicitTopicMainReport(check)) return false;
  if (check.sourceKind === "peer-workspace-message") return false;
  if (check.status !== "completed" && check.status !== "blocked") return false;
  if (check.shouldHoldInbox || check.hasBufferedTaskReports) return false;
  return (
    check.escalateToParent !== true &&
    !hasResidentInboxBypass(check.childLabels) &&
    !/@主控|@main\b/iu.test(check.summary)
  );
}

function canBypassTaskReport(
  task: Readonly<WorkspaceTask>,
  check: MainControlWakeupCheck,
): boolean {
  if (!isActiveWorkspaceTask(task) || task.leadAgentId !== check.childAgentId) return false;
  if ((task.leadServerId ?? check.localServerId) !== check.childServerId) return false;
  if (hasReportFileConflict(task, check)) return false;
  if (check.status === "blocked") return true;
  if (task.status === "awaiting_decision" || task.blockingQuestion?.trim()) return false;
  return task.closure?.verification?.state !== "failed";
}

function isExplicitTopicMainReport({
  workspaceId,
  parentAgent,
  topicMainMatches,
  explicit,
}: MainControlWakeupCheck): boolean {
  return (
    parentAgent?.workspaceId === workspaceId &&
    !parentAgent.archivedAt &&
    topicMainMatches &&
    isMainControlAgentLabels(parentAgent.labels) &&
    explicit
  );
}

function hasReportFileConflict(task: Readonly<WorkspaceTask>, check: MainControlWakeupCheck) {
  const paths = new Set(mergeTouchedFiles(task.touchedFiles ?? [], check.touchedFiles ?? []));
  return check.tasks.some(
    (peer) =>
      peer.taskId !== task.taskId &&
      isActiveWorkspaceTask(peer) &&
      peer.touchedFiles?.some((path) => paths.has(path)),
  );
}

function hasUnscopedReportFileConflict(check: MainControlWakeupCheck) {
  const paths = new Set(mergeTouchedFiles([], check.touchedFiles ?? []));
  if (paths.size === 0) return false;
  return check.tasks.some(
    (peer) => isActiveWorkspaceTask(peer) && peer.touchedFiles?.some((path) => paths.has(path)),
  );
}

export function taskReportOutcomePatch({
  status,
  summary,
  bypassMainControl,
  touchedFiles,
}: {
  status: string | undefined;
  summary: string;
  bypassMainControl: boolean;
  touchedFiles: readonly string[];
}): WorkspaceTaskTurnOutcomePatch {
  const patch: WorkspaceTaskTurnOutcomePatch = { touchedFiles: [...touchedFiles] };
  if (status === "blocked") {
    patch.status = "awaiting_decision";
    patch.blockingQuestion = [...summary].slice(0, 600).join("");
  } else if (status === "completed" && bypassMainControl) {
    patch.status = "completed";
    patch.handoffSummary = [...summary].slice(0, 600).join("");
    patch.latestReplyPreview = [...summary].slice(0, 240).join("");
    patch.blockingQuestion = null;
  }
  return patch;
}
