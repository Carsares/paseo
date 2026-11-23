import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCreateCommandWithDeps } from "./create.js";
import { buildCreateWorktreeRequest, type WorktreeCreateOptions } from "./create-input.js";

const REPO = "/tmp/repo";
const originalAgentId = process.env.PASEO_AGENT_ID;

beforeEach(() => {
  delete process.env.PASEO_AGENT_ID;
});

afterEach(() => {
  if (originalAgentId === undefined) delete process.env.PASEO_AGENT_ID;
  else process.env.PASEO_AGENT_ID = originalAgentId;
});

function build(options: WorktreeCreateOptions): unknown {
  try {
    return buildCreateWorktreeRequest(options, REPO);
  } catch (err) {
    return err;
  }
}

describe("buildCreateWorktreeRequest", () => {
  it("requires --mode", () => {
    expect(build({})).toMatchObject({ code: "MISSING_MODE" });
  });

  it("rejects unknown modes", () => {
    expect(build({ mode: "fork" })).toMatchObject({ code: "INVALID_MODE" });
  });

  it("branch-off requires --new-branch", () => {
    expect(build({ mode: "branch-off" })).toMatchObject({ code: "MISSING_NEW_BRANCH" });
  });

  it("branch-off builds a daemon request with a new branch", () => {
    expect(build({ mode: "branch-off", newBranch: "feature-x" })).toEqual({
      cwd: REPO,
      worktreeSlug: "feature-x",
      action: "branch-off",
    });
  });

  it("branch-off includes the base ref when provided", () => {
    expect(build({ mode: "branch-off", newBranch: "feature-x", base: "main" })).toEqual({
      cwd: REPO,
      worktreeSlug: "feature-x",
      action: "branch-off",
      refName: "main",
    });
  });

  it("checkout-branch requires --branch", () => {
    expect(build({ mode: "checkout-branch" })).toMatchObject({ code: "MISSING_BRANCH" });
  });

  it("checkout-branch builds a checkout request for the branch", () => {
    expect(build({ mode: "checkout-branch", branch: "feat/x" })).toEqual({
      cwd: REPO,
      action: "checkout",
      refName: "feat/x",
    });
  });

  it("checkout-pr requires --pr-number", () => {
    expect(build({ mode: "checkout-pr" })).toMatchObject({ code: "MISSING_PR_NUMBER" });
  });

  it("checkout-pr rejects non-positive integers", () => {
    expect(build({ mode: "checkout-pr", prNumber: "0" })).toMatchObject({
      code: "INVALID_PR_NUMBER",
    });
  });

  it("checkout-pr rejects non-integer values", () => {
    expect(build({ mode: "checkout-pr", prNumber: "abc" })).toMatchObject({
      code: "INVALID_PR_NUMBER",
    });
  });

  it("checkout-pr builds a checkout request for the pull request", () => {
    expect(build({ mode: "checkout-pr", prNumber: "42" })).toEqual({
      cwd: REPO,
      action: "checkout",
      githubPrNumber: 42,
    });
  });
});

it("uses the explicit worktree creation RPC and returns the created worktree details", async () => {
  const result = await runCreateCommandWithDeps(
    {
      daemonTarget: { kind: "endpoint", host: "example.test:12345" },
      mode: "branch-off",
      newBranch: "topic",
      base: "main",
      cwd: REPO,
    },
    {
      connectToDaemon: async () => ({
        fetchAgent: async () => null,
        createPaseoWorktree: async (input) => {
          expect(input).toEqual({
            cwd: REPO,
            worktreeSlug: "topic",
            action: "branch-off",
            refName: "main",
          });
          return {
            workspace: {
              id: "wks_topic",
              projectId: "project",
              projectDisplayName: "Repo",
              projectRootPath: REPO,
              workspaceDirectory: `${REPO}/topic`,
              projectKind: "git",
              workspaceKind: "worktree",
              name: "topic",
              status: "idle",
              statusEnteredAt: null,
              activityAt: null,
              archivingAt: null,
              scripts: [],
            },
            error: null,
            requestId: "worktree-create",
          };
        },
        close: async () => {},
      }),
    },
  );
  expect(result.data).toEqual({
    name: "topic",
    branchName: "topic",
    worktreePath: `${REPO}/topic`,
  });
});

it("rejects worktree creation from a managed agent before the mutation", async () => {
  const previousAgentId = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = "parent-agent";
  const createPaseoWorktree = async () => {
    throw new Error("worktree mutation should not run");
  };

  try {
    await expect(
      runCreateCommandWithDeps(
        {
          daemonTarget: { kind: "endpoint", host: "example.test:12345" },
          mode: "branch-off",
          newBranch: "topic",
          cwd: REPO,
        },
        {
          connectToDaemon: async () => ({
            fetchAgent: async () => ({
              agent: {
                id: "parent-agent",
                cwd: REPO,
                workspaceId: "workspace-parent",
                archivedAt: null,
              },
            }),
            createPaseoWorktree,
            close: async () => {},
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: "AGENT_WORKSPACE_CREATION_FORBIDDEN",
      message:
        "Agent sessions cannot create a project or workspace. Subagents must reuse the current workspace.",
    });
  } finally {
    if (previousAgentId === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = previousAgentId;
  }
});
