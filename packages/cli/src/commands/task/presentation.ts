import { stripVTControlCharacters } from "node:util";
import type { WorkspaceTaskSummary } from "@getpaseo/protocol/messages";
import { renderTable, type OutputSchema } from "../../output/index.js";

function terminalLine(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
}

function preview(text: string, limit: number): string {
  const line = terminalLine(text);
  const chars = Array.from(line);
  return chars.length > limit ? chars.slice(0, limit - 1).join("") + "…" : line;
}

function progressLabel(progress: NonNullable<WorkspaceTaskSummary["latestProgress"]>): string {
  const kind = progress.kind.replaceAll("_", " ");
  return progress.lifecycle === undefined ? kind : `${kind} (${progress.lifecycle})`;
}

function taskProgress(task: WorkspaceTaskSummary): string {
  if (task.latestProgress) return preview(progressLabel(task.latestProgress), 56);
  const question = task.blockingQuestion?.trim();
  if (question) return preview(`Blocked: ${question}`, 56);
  const handoff = task.handoffSummary?.trim();
  if (handoff) return preview(handoff, 56);

  if (task.verificationState) return `Verification: ${task.verificationState.replaceAll("_", " ")}`;
  return "—";
}

export const taskListSchema: OutputSchema<WorkspaceTaskSummary> = {
  idField: "taskId",
  columns: [
    { header: "STATUS", field: (task) => task.status.replaceAll("_", " ") },
    { header: "TASK", field: (task) => preview(task.title, 36) },
    { header: "TASK ID", field: (task) => terminalLine(task.taskId) },
    { header: "TIER", field: "tier" },
    { header: "AGENTS", field: (task) => task.participants.length, align: "right" },
    { header: "PROGRESS", field: taskProgress },
  ],
  renderHuman: (result, options) => {
    if (result.type === "list" && result.data.length === 0) return "No workspace tasks.";
    return renderTable(result, options);
  },
};

function detailText(text: string): string {
  return stripVTControlCharacters(text)
    .split(/\r?\n/u)
    .map((line) => line.replace(/\p{Cc}/gu, " "))
    .join("\n  ");
}

function renderTaskDetail(task: WorkspaceTaskSummary, workspaceId: string): string {
  const lines = [
    `Workspace: ${terminalLine(workspaceId)}`,
    `Task ID: ${terminalLine(task.taskId)}`,
    `Title: ${detailText(task.title)}`,
    `Status: ${task.status.replaceAll("_", " ")}`,
    `Tier: ${task.tier}`,
    `Created: ${task.createdAt}`,
    `Updated: ${task.updatedAt}`,
  ];
  if (task.participants.length === 0) {
    lines.push("Participants: none");
  } else {
    lines.push("Participants:");
    for (const { agentId, serverId, boundBy } of task.participants) {
      const identity = serverId === undefined ? agentId : `${agentId} (server: ${serverId})`;
      const binding = boundBy === undefined ? "" : ` (bound by: ${boundBy})`;
      lines.push(`  ${terminalLine(identity + binding)}`);
    }
  }
  if (task.handoffSummary !== undefined) {
    lines.push(`Handoff: ${detailText(task.handoffSummary)}`);
  }
  if (task.blockingQuestion !== undefined) {
    lines.push(`Blocking question: ${detailText(task.blockingQuestion)}`);
  }
  if (task.verificationState !== undefined) {
    lines.push(`Verification: ${task.verificationState.replaceAll("_", " ")}`);
  }
  if (task.latestProgress) {
    const progress = terminalLine(progressLabel(task.latestProgress));
    lines.push(`Latest progress: ${progress} at ${task.latestProgress.at}`);
  }
  if (task.recentAgentStates?.length) {
    lines.push("Recent agent states:");
    for (const { at, agentId, kind, lifecycle } of task.recentAgentStates) {
      const state = lifecycle === undefined ? kind : `${kind} (${lifecycle})`;
      lines.push(`  ${at} ${terminalLine(agentId)}: ${terminalLine(state)}`);
    }
  }
  return lines.join("\n");
}

export function taskDetailSchema(workspaceId: string): OutputSchema<WorkspaceTaskSummary> {
  return {
    idField: "taskId",
    columns: [],
    renderHuman: (result) =>
      result.type === "single" ? renderTaskDetail(result.data, workspaceId) : "",
  };
}
