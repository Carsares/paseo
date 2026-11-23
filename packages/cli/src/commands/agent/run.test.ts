import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { resolveCallerAgentId as resolveRunCallerAgentId } from "../../utils/caller-agent.js";
import {
  resolveExistingRunWorkspace,
  resolveRunWorkspace,
  runRunCommand,
  waitsForFinish,
  type AgentRunOptions,
} from "./run";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

// Answers fetchAgent the way a daemon does: an unknown id is an error.
function daemonWithAgents(...agentIds: string[]) {
  return {
    async fetchAgent({ agentId }: { agentId: string }) {
      if (!agentIds.includes(agentId)) {
        throw new Error(`Agent not found: ${agentId}`);
      }
      return {
        agent: {
          id: agentId,
          cwd: "/parent/workspace",
          workspaceId: "workspace-parent",
          archivedAt: null,
        },
      };
    },
  };
}

describe("run wait policy", () => {
  it("waits by default and stops waiting on --no-wait or a legacy alias", () => {
    expect(waitsForFinish({})).toBe(true);
    expect(waitsForFinish({ wait: false })).toBe(false);
    expect(waitsForFinish({ background: true })).toBe(false);
    expect(waitsForFinish({ detach: true })).toBe(false);
  });
});

describe("managed agent caller context", () => {
  it("uses a trimmed PASEO_AGENT_ID when the target daemon runs that agent", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents("parent-agent"), {
        PASEO_AGENT_ID: "  parent-agent  ",
      }),
    ).resolves.toBe("parent-agent");
  });

  it("rejects when PASEO_AGENT_ID belongs to another daemon", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents("other-agent"), {
        PASEO_AGENT_ID: "parent-agent",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CALLER_AGENT" });
  });

  it("rejects a daemon response whose agent ID does not match the environment", async () => {
    await expect(
      resolveRunCallerAgentId(
        {
          fetchAgent: async () => ({
            agent: {
              id: "other-agent",
              cwd: "/parent/workspace",
              workspaceId: "workspace-parent",
              archivedAt: null,
            },
          }),
        },
        { PASEO_AGENT_ID: "parent-agent" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_CALLER_AGENT" });
  });

  it("rejects an archived caller", async () => {
    await expect(
      resolveRunCallerAgentId(
        {
          fetchAgent: async () => ({
            agent: {
              id: "parent-agent",
              cwd: "/parent/workspace",
              workspaceId: "workspace-parent",
              archivedAt: "2026-11-23T00:00:00.000Z",
            },
          }),
        },
        { PASEO_AGENT_ID: "parent-agent" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_CALLER_AGENT" });
  });

  it("rejects a caller without a workspace", async () => {
    await expect(
      resolveRunCallerAgentId(
        {
          fetchAgent: async () => ({
            agent: { id: "parent-agent", cwd: "/parent/workspace" },
          }),
        },
        { PASEO_AGENT_ID: "parent-agent" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_CALLER_AGENT" });
  });

  it.each(["DAEMON_CONNECTION_LOST", "DAEMON_REQUEST_TIMEOUT"] as const)(
    "preserves %s instead of dropping the caller",
    async (code) => {
      const disconnectedDaemon = {
        async fetchAgent(): Promise<never> {
          throw new DaemonConnectionError("Caller lookup transport failed", code);
        },
      };

      await expect(
        resolveRunCallerAgentId(disconnectedDaemon, { PASEO_AGENT_ID: "parent-agent" }),
      ).rejects.toBeInstanceOf(DaemonConnectionError);
    },
  );

  it("rejects blank caller ids instead of treating them as human calls", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents(), { PASEO_AGENT_ID: "   " }),
    ).rejects.toMatchObject({ code: "INVALID_CALLER_AGENT" });
  });
});

describe("existing run workspace resolution", () => {
  it("queries the daemon for an exact workspace id and uses its directory", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-2", workspaceDirectory: "/workspace/two" }],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "workspace-2")).resolves.toEqual({
      id: "workspace-2",
      cwd: "/workspace/two",
    });
    expect(fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-2" },
      page: { limit: 200 },
    });
  });

  it("rejects a workspace id absent from daemon state", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "missing")).rejects.toMatchObject(
      {
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found: missing",
      },
    );
  });

  it("uses the caller snapshot when the ambient workspace ID is stale", async () => {
    const previousWorkspaceId = process.env.PASEO_WORKSPACE_ID;
    process.env.PASEO_WORKSPACE_ID = "stale-workspace";
    try {
      await expect(
        resolveRunWorkspace({} as never, { daemonTarget }, "/requested/by-caller", {
          id: "parent-agent",
          cwd: "/parent/workspace",
          workspaceId: "workspace-parent",
        }),
      ).resolves.toEqual({ id: "workspace-parent", cwd: "/parent/workspace" });
    } finally {
      if (previousWorkspaceId === undefined) delete process.env.PASEO_WORKSPACE_ID;
      else process.env.PASEO_WORKSPACE_ID = previousWorkspaceId;
    }
  });
});

// validateRunOptions runs before the CLI ever connects to a daemon, so these
// invalid combinations reject without one running.
describe("runRunCommand option validation", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;
  const originalAgentId = process.env.PASEO_AGENT_ID;

  beforeEach(() => {
    delete process.env.PASEO_WORKSPACE_ID;
    delete process.env.PASEO_AGENT_ID;
  });

  afterEach(() => {
    if (originalWorkspaceId === undefined) {
      delete process.env.PASEO_WORKSPACE_ID;
    } else {
      process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
    if (originalAgentId === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = originalAgentId;
  });

  async function expectInvalidOptions(
    options: Omit<AgentRunOptions, "daemonTarget">,
    messageMatch: RegExp,
  ) {
    await expect(
      runRunCommand("do something", { ...options, daemonTarget }, {} as never),
    ).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: expect.stringMatching(messageMatch),
    });
  }

  it("rejects --new-workspace combined with --workspace", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", workspace: "ws-1" },
      /--new-workspace and --workspace cannot be combined/,
    );
  });

  it("allows explicit worktree workspace creation through validation", async () => {
    // Explicit workspace creation with no --workspace
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand(
        "do something",
        { newWorkspace: "worktree", provider: undefined, daemonTarget },
        {} as never,
      ),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("rejects unknown new workspace kinds", async () => {
    await expectInvalidOptions({ newWorkspace: "container" }, /Unsupported new workspace kind/);
  });

  it("rejects an explicitly empty new workspace kind", async () => {
    await expectInvalidOptions({ newWorkspace: "" }, /Unsupported new workspace kind/);
  });

  it("rejects an explicitly empty legacy worktree value", async () => {
    await expectInvalidOptions({ worktree: "" }, /--worktree cannot be empty/);
  });

  it("rejects an explicitly empty workspace ID", async () => {
    await expectInvalidOptions({ workspace: "" }, /--workspace cannot be empty/);
  });

  it("rejects two workspace creation flags", async () => {
    await expectInvalidOptions(
      { newWorkspace: "local", worktree: "legacy-slug" },
      /--new-workspace and --worktree cannot be combined/,
    );
  });

  it.each([{ newWorkspace: "local" }, { newWorkspace: "" }, { worktree: "" }, { workspace: "" }])(
    "uses the canonical workspace error for managed workspace options %j",
    async (options) => {
      const previousAgentId = process.env.PASEO_AGENT_ID;
      process.env.PASEO_AGENT_ID = "parent-agent";
      try {
        await expect(
          runRunCommand("do something", { ...options, daemonTarget }, {} as never),
        ).rejects.toMatchObject({
          code: "AGENT_WORKSPACE_CREATION_FORBIDDEN",
          message:
            "Agent sessions cannot create a project or workspace. Subagents must reuse the current workspace.",
        });
      } finally {
        if (previousAgentId === undefined) delete process.env.PASEO_AGENT_ID;
        else process.env.PASEO_AGENT_ID = previousAgentId;
      }
    },
  );

  it("rejects an unknown worktree creation mode before connecting", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", worktreeMode: "container" },
      /Unsupported worktree mode/,
    );
  });
});
