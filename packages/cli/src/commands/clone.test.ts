import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCloneCommand } from "./clone.js";

const fetchAgent = vi.fn(
  async () => null as { agent: { id: string; cwd: string; workspaceId: string } } | null,
);
const cloneGithubProject = vi.fn();
const close = vi.fn(async () => undefined);

vi.mock("../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    fetchAgent,
    cloneGithubProject,
    getLastServerInfoMessage: () => ({ features: { projectGithubClone: true } }),
    close,
  })),
}));

const originalAgentId = process.env.PASEO_AGENT_ID;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PASEO_AGENT_ID;
});

afterEach(() => {
  if (originalAgentId === undefined) delete process.env.PASEO_AGENT_ID;
  else process.env.PASEO_AGENT_ID = originalAgentId;
});

describe("clone command", () => {
  it("rejects cloning from a managed agent before the mutation", async () => {
    process.env.PASEO_AGENT_ID = "parent-agent";
    fetchAgent.mockResolvedValue({
      agent: {
        id: "parent-agent",
        cwd: "/tmp/project",
        workspaceId: "workspace-parent",
      },
    });

    await expect(
      runCloneCommand(
        "https://github.com/example/project.git",
        {
          daemonTarget: { kind: "instance", home: "/tmp/paseo-home" },
          dir: "/tmp/project-clone",
        },
        {} as never,
      ),
    ).rejects.toMatchObject({
      code: "AGENT_WORKSPACE_CREATION_FORBIDDEN",
      message:
        "Agent sessions cannot create a project or workspace. Subagents must reuse the current workspace.",
    });
    expect(cloneGithubProject).not.toHaveBeenCalled();
  });
});
