import { describe, expect, it } from "vitest";
import {
  type AgentHistorySearchCandidate,
  matchesAgentHistoryQuery,
} from "./agent-history-search.js";

function candidate(input: {
  title?: string | null;
  workspaceName?: string | null;
  branch?: string | null;
  projectName?: string;
  cwd?: string;
  worktreeRoot?: string | null;
  updatedAt?: string;
}): AgentHistorySearchCandidate & { agent: { id: string; updatedAt: string } } {
  const branch = input.branch ?? null;
  return {
    agent: {
      id: input.title ?? "agent",
      title: input.title ?? null,
      updatedAt: input.updatedAt ?? "2026-08-07T00:00:00.000Z",
    },
    project: {
      projectKey: "key",
      projectName: input.projectName ?? "getpaseo/paseo",
      workspaceName: input.workspaceName ?? null,
      checkout: {
        cwd: input.cwd ?? "/tmp/repo",
        isGit: branch !== null,
        currentBranch: branch,
        remoteUrl: null,
        worktreeRoot: input.worktreeRoot === undefined ? "/tmp/repo" : input.worktreeRoot,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
    // Only the fields read by the search are needed here.
  } as unknown as AgentHistorySearchCandidate & { agent: { id: string; updatedAt: string } };
}

describe("matchesAgentHistoryQuery", () => {
  it("rejects scattered letters across words while keeping within-word subsequences", () => {
    expect(
      matchesAgentHistoryQuery(
        "terminal",
        candidate({
          title: "Let me diagnose this problem in a diagnose this problem and",
        }),
      ),
    ).toBe(false);
    expect(matchesAgentHistoryQuery("trmnl", candidate({ title: "Fix terminal resizing" }))).toBe(
      true,
    );
  });

  it("matches the workspace name", () => {
    expect(
      matchesAgentHistoryQuery("stripe", candidate({ workspaceName: "Add Stripe billing" })),
    ).toBe(true);
  });

  it("matches the agent title", () => {
    expect(
      matchesAgentHistoryQuery("entitlements", candidate({ title: "Reshape entitlements" })),
    ).toBe(true);
  });

  it("matches the branch name", () => {
    expect(matchesAgentHistoryQuery("billing", candidate({ branch: "add-stripe-billing" }))).toBe(
      true,
    );
  });

  it("matches the project name", () => {
    expect(matchesAgentHistoryQuery("paseo", candidate({ projectName: "getpaseo/paseo" }))).toBe(
      true,
    );
  });

  it("matches across names, branch, and checkout basename in all scope", () => {
    const entry = candidate({
      title: "entitlements",
      workspaceName: "billing",
      branch: "release",
      projectName: "paseo",
      worktreeRoot: "/tmp/worktrees/stripe/",
    });
    expect(
      matchesAgentHistoryQuery("entitlements billing release paseo stripe", entry, "all"),
    ).toBe(true);
  });

  it("matches workspace name, branch, and worktree basename in workspace scope", () => {
    const entry = candidate({
      title: "entitlements",
      workspaceName: "billing",
      branch: "release",
      projectName: "paseo",
      cwd: "/tmp/nested",
      worktreeRoot: "C:\\worktrees\\stripe\\",
    });
    expect(matchesAgentHistoryQuery("billing release stripe", entry, "workspace")).toBe(true);
    for (const query of ["entitlements", "paseo", "nested", "worktrees"]) {
      expect(matchesAgentHistoryQuery(query, entry, "workspace")).toBe(false);
    }
    const directory = candidate({ cwd: "/tmp/checkout/", worktreeRoot: null });
    expect(matchesAgentHistoryQuery("checkout", directory, "workspace")).toBe(true);
  });

  it("matches only the title in agent scope", () => {
    const entry = candidate({
      title: "entitlements",
      workspaceName: "billing",
      branch: "release",
      projectName: "paseo",
      worktreeRoot: "/tmp/worktrees/stripe",
    });
    expect(matchesAgentHistoryQuery("entitlements", entry, "agent")).toBe(true);
    for (const query of ["billing", "release", "paseo", "stripe"]) {
      expect(matchesAgentHistoryQuery(query, entry, "agent")).toBe(false);
    }
  });

  it("requires every token to match somewhere", () => {
    const entry = candidate({ workspaceName: "Add Stripe billing", branch: "main" });
    expect(matchesAgentHistoryQuery("stripe main", entry)).toBe(true);
    expect(matchesAgentHistoryQuery("stripe rosetta", entry)).toBe(false);
  });

  it("tolerates a typo", () => {
    expect(
      matchesAgentHistoryQuery("bulling", candidate({ workspaceName: "Add Stripe billing" })),
    ).toBe(true);
  });

  it("tolerates a transposed branch name", () => {
    expect(matchesAgentHistoryQuery("mian", candidate({ branch: "main" }))).toBe(true);
    expect(matchesAgentHistoryQuery("rain", candidate({ branch: "main" }))).toBe(false);
  });

  it("keeps candidates for a blank query", () => {
    expect(matchesAgentHistoryQuery("   ", candidate({ title: "anything" }))).toBe(true);
  });
});
