import {
  RESIDENT_INBOX_BYPASS_LABEL,
  WORKSPACE_ROLE_LABEL,
  WORKSPACE_MAIN_ROLE,
} from "@getpaseo/protocol/agent-labels";
import { describe, expect, it } from "vitest";
import type { WorkspaceTask } from "./index.js";
import { shouldBypassMainControlWakeup, taskReportOutcomePatch } from "./report-sync.js";

const task: WorkspaceTask = {
  taskId: "task",
  title: "Task",
  status: "in_progress",
  tier: "T1",
  participants: [],
  leadAgentId: "lead",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const parentAgent = {
  workspaceId: "workspace",
  labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
};
const eligible = {
  workspaceId: "workspace",
  parentAgent,
  topicMainMatches: true,
  explicit: true,
  status: "completed",
  childAgentId: "lead",
  childServerId: "local",
  localServerId: "local",
  task,
  tasks: [task],
  shouldHoldInbox: false,
  hasBufferedTaskReports: false,
  summary: "Done",
  sourceKind: "agent-message",
};

describe("task report wakeup", () => {
  it("allows only an eligible single-track completion and stays side-effect-free", () => {
    const peer: WorkspaceTask = { ...task, taskId: "peer", touchedFiles: ["src/shared.ts"] };
    const check = {
      ...eligible,
      touchedFiles: ["src/shared.ts"],
      tasks: [task, { ...peer, status: "completed" as const }],
    };
    expect(shouldBypassMainControlWakeup(check)).toBe(true);
    expect(task.touchedFiles).toBeUndefined();
    expect(shouldBypassMainControlWakeup({ ...check, tasks: [task, peer] })).toBe(false);
  });

  it("allows all four single-topic bypass categories", () => {
    // 1. Lightweight untasked msg:<root> completion
    expect(
      shouldBypassMainControlWakeup({
        ...eligible,
        task: null,
        tasks: [],
        rootMessageId: "root-msg-1",
      }),
    ).toBe(true);
    // 3. Verifying task single-lead completion (when verification did not fail)
    expect(
      shouldBypassMainControlWakeup({
        ...eligible,
        task: { ...task, status: "verifying" },
      }),
    ).toBe(true);
    // 4. Routine single-lead blocked question without @主控 or escalateToParent
    expect(
      shouldBypassMainControlWakeup({
        ...eligible,
        status: "blocked",
        summary: "Should we enable feature X by default?",
      }),
    ).toBe(true);
  });

  const ineligible: Record<string, Partial<Parameters<typeof shouldBypassMainControlWakeup>[0]>> = {
    "parent in another workspace": { parentAgent: { ...parentAgent, workspaceId: "elsewhere" } },
    "archived parent": { parentAgent: { ...parentAgent, archivedAt: "archived" } },
    "regular workspace": { topicMainMatches: false },
    "parent without role": { parentAgent: { ...parentAgent, labels: {} } },
    "implicit report": { explicit: false },
    "error report": { status: "errored" },
    "permission-required report": { status: "permission-required" },
    "closed report": { status: "closed" },
    "missing task without rootMessageId": { task: null },
    "untasked blocked report": { task: null, rootMessageId: "root-msg-1", status: "blocked" },
    "untasked completion with active file conflict": {
      task: null,
      rootMessageId: "root-msg-1",
      touchedFiles: ["src/shared.ts"],
      tasks: [{ ...task, taskId: "peer", touchedFiles: ["src/shared.ts"] }],
    },
    "different lead": { childAgentId: "other" },
    "remote ID collision": { childServerId: "another-host" },
    "existing question": { task: { ...task, blockingQuestion: "Who accepts?" } },
    "awaiting decision": { task: { ...task, status: "awaiting_decision" } },
    "busy sibling": { shouldHoldInbox: true },
    "previous sibling report held for merge": { hasBufferedTaskReports: true },
    "urgent resident": { childLabels: { [RESIDENT_INBOX_BYPASS_LABEL]: "true" } },
    "manual escalation": { summary: "I need @主控 to review" },
    "English escalation": { summary: "Please check @MAIN." },
    "explicit escalateToParent flag on completion": { escalateToParent: true },
    "explicit escalateToParent flag on blocked report": {
      status: "blocked",
      escalateToParent: true,
    },
    "manual escalation on blocked report": {
      status: "blocked",
      summary: "Need @主控 to resolve conflict",
    },
    "blocked report with cross-task file conflict": {
      status: "blocked",
      touchedFiles: ["src/shared.ts"],
      tasks: [task, { ...task, taskId: "peer", touchedFiles: ["src/shared.ts"] }],
    },
    "failed verification": { task: { ...task, closure: { verification: { state: "failed" } } } },
    "verifying task with failed verification": {
      task: {
        ...task,
        status: "verifying",
        closure: { verification: { state: "failed" } },
      },
    },
    "peer workspace message": { sourceKind: "peer-workspace-message" },
  };
  it.each(Object.entries(ineligible))("keeps wakeup for %s", (_reason, patch) => {
    expect(shouldBypassMainControlWakeup({ ...eligible, ...patch })).toBe(false);
  });

  it("creates bounded report patches and only completes a silent report", () => {
    const outcome = { summary: "好".repeat(650), touchedFiles: ["src/a.ts"] };
    expect(
      taskReportOutcomePatch({ ...outcome, status: "blocked", bypassMainControl: false }),
    ).toEqual({
      status: "awaiting_decision",
      blockingQuestion: "好".repeat(600),
      touchedFiles: ["src/a.ts"],
    });
    expect(
      taskReportOutcomePatch({ ...outcome, status: "completed", bypassMainControl: true }),
    ).toEqual({
      status: "completed",
      handoffSummary: "好".repeat(600),
      latestReplyPreview: "好".repeat(240),
      blockingQuestion: null,
      touchedFiles: ["src/a.ts"],
    });
    expect(
      taskReportOutcomePatch({ ...outcome, status: "completed", bypassMainControl: false }),
    ).toEqual({ touchedFiles: ["src/a.ts"] });
  });
});
