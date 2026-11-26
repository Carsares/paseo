import {
  isMainControlAgentLabels,
  LEAD_COMMIT_POLICIES,
  LEAD_PLAYBOOKS,
  type LeadCommitPolicy,
  type LeadPlaybook,
} from "@getpaseo/protocol/agent-labels";
import { z } from "zod";

export const LeadPlaybookSchema = z.enum(LEAD_PLAYBOOKS);
export const LeadCommitPolicySchema = z.enum(LEAD_COMMIT_POLICIES);

export interface LeadPlaybookValidationInput {
  playbook?: LeadPlaybook;
  commitPolicy?: LeadCommitPolicy;
  callerLabels?: Record<string, unknown> | null;
  resident?: boolean;
  parentReporting?: "auto" | "explicit";
  notifyOnFinish?: boolean;
}

export interface ResolvedLeadPlaybookOptions {
  playbook: LeadPlaybook;
  commitPolicy: LeadCommitPolicy;
}

export class LeadPlaybookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeadPlaybookValidationError";
  }
}

export function resolveLeadPlaybookInput(
  input: LeadPlaybookValidationInput,
): ResolvedLeadPlaybookOptions | undefined {
  if (input.playbook === undefined && input.commitPolicy === undefined) {
    return undefined;
  }
  if (input.playbook === undefined) {
    throw new LeadPlaybookValidationError("commitPolicy requires playbook.");
  }
  if (!isMainControlAgentLabels(input.callerLabels)) {
    throw new LeadPlaybookValidationError(
      "Orchestration playbooks can only be dispatched by a Workspace Main Control agent.",
    );
  }
  if (input.resident) {
    throw new LeadPlaybookValidationError(
      "Orchestration playbook leads cannot be resident specialists.",
    );
  }
  if (input.parentReporting === "auto") {
    throw new LeadPlaybookValidationError(
      'Orchestration playbook leads require parentReporting: "explicit".',
    );
  }
  if (input.notifyOnFinish === true) {
    throw new LeadPlaybookValidationError(
      "Orchestration playbook leads require notifyOnFinish: false.",
    );
  }
  if (input.playbook === "readonly_cr" && input.commitPolicy === "scoped_only") {
    throw new LeadPlaybookValidationError(
      'commitPolicy "scoped_only" cannot be used with playbook "readonly_cr".',
    );
  }
  return {
    playbook: input.playbook,
    commitPolicy: input.commitPolicy ?? "none",
  };
}

export function buildMainControlPlaybookGuidance(): string[] {
  return [
    "When asked about workspace progress, completed work, conflicts, or decisions, call get_workspace_situation once. Request recent completed tasks when relevant. Group priorities by dependency and summarize the evidence directly; do not spawn an agent or reconstruct progress from old chats.",
    "When the user gives explicit decisions or acceptance feedback in this Main Control conversation, call dispatch_topic_decision separately for each matching topic. Relay only the user's stated decision. Leave system authorization items to the user.",
    'For approved multi-module implementation when a non-resident direct Level-1 planning lead already owns the task, continue that lead via send_agent_prompt to decompose Level-2 implementation and independent blind-review tracks; when no suitable Level-1 lead exists yet (or for layered code review), call create_agent with playbook: "batch_implement", "cr_fix_loop", or "readonly_cr". Keep commitPolicy: "none" unless the user explicitly authorized local commits in the current request ("scoped_only").',
  ];
}

const REVIEW_ROUND_LIMIT =
  "Cap the review or review-and-fix stage at two rounds total. Never start a third round. After round two, stop immediately and report any unresolved issues to Main Control.";

export function buildLeadPlaybookContract(params: {
  parentAgentId: string;
  playbook: LeadPlaybook;
  commitPolicy: LeadCommitPolicy;
}): string[] {
  const { parentAgentId, playbook, commitPolicy } = params;
  switch (playbook) {
    case "batch_implement":
      return [
        `Role: Level-1 Batch Implementation Lead under Main Control Agent ${parentAgentId}.`,
        "Decompose the approved scope into mutually exclusive file tracks: dispatch at most 2-3 Level-2 implementation tracks plus 1 cross-track independent blind-review track, folding small adjacent edits into an existing matching track.",
        'Reuse a warm idle same-workspace specialist or child with matching scope and clean context when appropriate; otherwise call create_agent with notifyOnFinish: true (omit parentReporting: "explicit" on Level-2). Follow any model and thinking-tier guidance from your parent prompt.',
        "Enforce strict role isolation: an implementer must never review its own changes. After dispatching each Level-2 wave, end your turn immediately and wait passively for completion notifications without polling.",
        REVIEW_ROUND_LIMIT,
        commitPolicy === "scoped_only"
          ? "After cross-track blind review and targeted verification pass, commit only this batch's owned files with git commit --only -- <owned files> without touching unrelated workspace edits, and archive temporary Level-2 subagents that have no open client tabs."
          : "After cross-track blind review and targeted verification pass, leave verified edits uncommitted in the working tree (do not run git commit or git push), and archive temporary Level-2 subagents that have no open client tabs.",
      ];
    case "cr_fix_loop":
      return [
        `Role: Level-1 Convergent Code-Review & Fix Lead under Main Control Agent ${parentAgentId}.`,
        "Coordinate iterative, role-isolated code review and repair across the requested scope (or full branch diff against the base branch when unspecified) within this single Level-1 lead session.",
        REVIEW_ROUND_LIMIT,
        "Partition review slices proportionally to diff size (1-3 slices by default, at most 5 for very large diffs) and pin shared baseline invariants at the top of Level-2 prompts. If a second round is needed, reuse read-only slice reviewers and same-scope fix or verification agents and skip unchanged, uncoupled slices. Spawn a fresh independent arbiter each round to falsify findings against source code, and never let a fixer act as reviewer or arbiter.",
        'Dispatch Level-2 subagents with notifyOnFinish: true (omit parentReporting: "explicit"), cap concurrent repair at 2-3 fix tracks plus 1 cross-track verification track, and end your turn immediately after each dispatch to wait passively for notifications without polling.',
        commitPolicy === "scoped_only"
          ? "Within the round limit, fix deterministic blocking defects autonomously and defer contract dilemmas while those blockers remain. Commit each verified repair round with git commit --only -- <repaired files> and archive finished temporary Level-2 subagents without open client tabs."
          : "Within the round limit, fix deterministic blocking defects autonomously and defer contract dilemmas while those blockers remain. Keep verified repairs uncommitted in the working tree (do not run git commit or git push) and archive finished temporary Level-2 subagents without open client tabs.",
      ];
    case "readonly_cr":
      return [
        `Role: Level-1 Read-Only Code-Review Lead under Main Control Agent ${parentAgentId}.`,
        "Execute a single-round layered, strictly read-only code review over the requested scope (or full branch diff against the base branch when unspecified). Never modify files, stage changes, commit, or push.",
        'Define must-preserve behavior and blocking-defect criteria first, partition the diff proportionally (1-3 slices by default, at most 5 for very large diffs), dispatch parallel read-only Level-2 slice reviewers via create_agent with notifyOnFinish: true (omit parentReporting: "explicit"), and end your turn immediately to wait passively for notifications without polling.',
        "Spawn a fresh independent read-only arbiter to verify candidate findings directly against source code and filter out false positives, archive temporary Level-2 subagents without open client tabs, then report confirmed blocking defects, impact, file/symbol evidence, and minimal repair recommendations.",
      ];
  }
}
