import { WORKSPACE_MAIN_ROLE, WORKSPACE_ROLE_LABEL } from "@getpaseo/protocol/agent-labels";
import { describe, expect, test } from "vitest";
import {
  buildLeadPlaybookContract,
  buildMainControlPlaybookGuidance,
  LeadPlaybookValidationError,
  resolveLeadPlaybookInput,
} from "./orchestration-playbooks.js";

const mainLabels = { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE };

describe("resolveLeadPlaybookInput", () => {
  test("returns undefined when neither playbook nor commitPolicy is provided", () => {
    expect(resolveLeadPlaybookInput({ callerLabels: mainLabels })).toBeUndefined();
  });

  test("defaults commitPolicy to none for Main Control callers", () => {
    expect(
      resolveLeadPlaybookInput({
        playbook: "batch_implement",
        callerLabels: mainLabels,
      }),
    ).toEqual({
      playbook: "batch_implement",
      commitPolicy: "none",
    });
  });

  test("accepts scoped_only commitPolicy for batch_implement and cr_fix_loop", () => {
    for (const playbook of ["batch_implement", "cr_fix_loop"] as const) {
      expect(
        resolveLeadPlaybookInput({
          playbook,
          commitPolicy: "scoped_only",
          callerLabels: mainLabels,
          parentReporting: "explicit",
          notifyOnFinish: false,
        }),
      ).toEqual({
        playbook,
        commitPolicy: "scoped_only",
      });
    }
  });

  test("rejects commitPolicy without playbook, non-main callers, resident leads, auto reporting, notifyOnFinish, and readonly_cr commits", () => {
    expect(() =>
      resolveLeadPlaybookInput({
        commitPolicy: "none",
        callerLabels: mainLabels,
      }),
    ).toThrow(LeadPlaybookValidationError);

    expect(() =>
      resolveLeadPlaybookInput({
        playbook: "batch_implement",
        callerLabels: {},
      }),
    ).toThrow(/Main Control/);

    expect(() =>
      resolveLeadPlaybookInput({
        playbook: "batch_implement",
        callerLabels: mainLabels,
        resident: true,
      }),
    ).toThrow(/resident/);

    expect(() =>
      resolveLeadPlaybookInput({
        playbook: "cr_fix_loop",
        callerLabels: mainLabels,
        parentReporting: "auto",
      }),
    ).toThrow(/explicit/);

    expect(() =>
      resolveLeadPlaybookInput({
        playbook: "cr_fix_loop",
        callerLabels: mainLabels,
        notifyOnFinish: true,
      }),
    ).toThrow(/notifyOnFinish: false/);

    expect(() =>
      resolveLeadPlaybookInput({
        playbook: "readonly_cr",
        commitPolicy: "scoped_only",
        callerLabels: mainLabels,
      }),
    ).toThrow(/readonly_cr/);
  });
});

describe("orchestration playbook contracts", () => {
  test("renders concise Main Control guidance for progress summary and playbooks", () => {
    const guidance = buildMainControlPlaybookGuidance().join("\n");
    expect(guidance).toContain("call get_workspace_situation once");
    expect(guidance).toContain("call dispatch_topic_decision separately");
    expect(guidance).toContain("continue that lead via send_agent_prompt");
    expect(guidance).toContain('"batch_implement"');
    expect(guidance).toContain('"cr_fix_loop"');
    expect(guidance).toContain('"readonly_cr"');
    expect(guidance).toContain('commitPolicy: "none"');
  });

  test("switches commit instructions cleanly between none and scoped_only", () => {
    const uncommitted = buildLeadPlaybookContract({
      parentAgentId: "main-1",
      playbook: "batch_implement",
      commitPolicy: "none",
    }).join("\n");
    expect(uncommitted).toContain(
      "Level-1 Batch Implementation Lead under Main Control Agent main-1",
    );
    expect(uncommitted).toContain("do not run git commit or git push");
    expect(uncommitted).not.toContain("git commit --only");

    const scoped = buildLeadPlaybookContract({
      parentAgentId: "main-1",
      playbook: "batch_implement",
      commitPolicy: "scoped_only",
    }).join("\n");
    expect(scoped).toContain("git commit --only -- <owned files>");

    const readonly = buildLeadPlaybookContract({
      parentAgentId: "main-1",
      playbook: "readonly_cr",
      commitPolicy: "none",
    }).join("\n");
    expect(readonly).toContain("Never modify files, stage changes, commit, or push.");
  });
});
