import { describe, expect, it } from "vitest";
import {
  getOpenAgentTabLabel,
  MAIN_PRIOR_MODE_ID_LABEL,
  PARENT_AGENT_ID_LABEL,
  PARENT_SERVER_ID_LABEL,
  WORKSPACE_MAIN_ROLE,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { REMOTE_HIERARCHY_DEPTH_LABEL } from "../hierarchy-policy.js";
import { resolveCreateAgentIntent } from "./intent.js";

describe("resolveCreateAgentIntent", () => {
  it("rejects a different explicit workspace for a caller", async () => {
    const resolvedWorkspaceIds: string[] = [];
    await expect(
      resolveCreateAgentIntent({
        explicitWorkspaceId: "workspace-isolated",
        caller: { id: "parent-agent", cwd: "/parent", workspaceId: "workspace-parent" },
        labels: { purpose: "review" },
        resolveWorkspace: async (workspaceId) => {
          resolvedWorkspaceIds.push(workspaceId);
          return { workspaceId, cwd: "/isolated" };
        },
        createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
      }),
    ).rejects.toThrow(
      "Agent sessions cannot create a project or workspace. Subagents must reuse the current workspace.",
    );
    expect(resolvedWorkspaceIds).toEqual([]);
  });

  it("keeps caller workspace and cwd when the same explicit workspace is supplied", async () => {
    const intent = await resolveCreateAgentIntent({
      explicitWorkspaceId: "workspace-parent",
      caller: { id: "parent-agent", cwd: "/parent", workspaceId: "workspace-parent" },
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/workspace" }),
      createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
    });

    expect(intent).toEqual({
      workspaceId: "workspace-parent",
      cwd: "/parent",
      parentAgentId: "parent-agent",
      labels: {
        [PARENT_AGENT_ID_LABEL]: "parent-agent",
      },
    });
  });

  it("defaults an agent caller to its workspace without creating one", async () => {
    let createCount = 0;
    const intent = await resolveCreateAgentIntent({
      caller: { id: "parent-agent", cwd: "/parent", workspaceId: "workspace-parent" },
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
      createWorkspace: async () => {
        createCount += 1;
        return { workspaceId: "workspace-created", cwd: "/created" };
      },
    });

    expect(intent.workspaceId).toBe("workspace-parent");
    expect(intent.cwd).toBe("/parent");
    expect(intent.parentAgentId).toBe("parent-agent");
    expect(createCount).toBe(0);
  });

  it("rejects a caller without a workspace with the shared creation error", async () => {
    await expect(
      resolveCreateAgentIntent({
        caller: { id: "parent-agent", cwd: "/parent" },
        resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
        createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
      }),
    ).rejects.toThrow(
      "Agent sessions cannot create a project or workspace. Subagents must reuse the current workspace.",
    );
  });

  it("creates a workspace for a human caller with no workspace context", async () => {
    const intent = await resolveCreateAgentIntent({
      caller: null,
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
      createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
    });

    expect(intent).toEqual({
      workspaceId: "workspace-created",
      cwd: "/created",
      parentAgentId: null,
      labels: {},
    });
  });

  it("rejects legacy detached creation when a caller exists", async () => {
    await expect(
      resolveCreateAgentIntent({
        caller: { id: "parent-agent", cwd: "/parent", workspaceId: "workspace-parent" },
        legacyDetached: true,
        resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
        createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
      }),
    ).rejects.toThrow(
      "Agent sessions cannot create a project or workspace. Subagents must reuse the current workspace.",
    );
  });

  it("strips reserved hierarchy labels and preserves valid remote parent labels with validated depth", async () => {
    const forgedLocal = await resolveCreateAgentIntent({
      caller: null,
      serverId: "local-host",
      labels: {
        [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE,
        [MAIN_PRIOR_MODE_ID_LABEL]: "full-access",
        [PARENT_AGENT_ID_LABEL]: "forged-parent",
        [PARENT_SERVER_ID_LABEL]: "local-host",
        [REMOTE_HIERARCHY_DEPTH_LABEL]: "1",
        [getOpenAgentTabLabel("client-1")]: "true",
      },
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
      createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
    });
    expect(forgedLocal.labels).toEqual({
      [getOpenAgentTabLabel("client-1")]: "true",
    });

    const remoteChild = await resolveCreateAgentIntent({
      caller: null,
      serverId: "local-host",
      labels: {
        [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE,
        [PARENT_AGENT_ID_LABEL]: "remote-parent",
        [PARENT_SERVER_ID_LABEL]: "remote-host",
        [REMOTE_HIERARCHY_DEPTH_LABEL]: "2",
      },
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
      createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
    });
    expect(remoteChild.labels).toEqual({
      [PARENT_AGENT_ID_LABEL]: "remote-parent",
      [PARENT_SERVER_ID_LABEL]: "remote-host",
      [REMOTE_HIERARCHY_DEPTH_LABEL]: "2",
    });

    await expect(
      resolveCreateAgentIntent({
        caller: null,
        serverId: "local-host",
        labels: {
          [PARENT_AGENT_ID_LABEL]: "remote-parent",
          [PARENT_SERVER_ID_LABEL]: "remote-host",
          [REMOTE_HIERARCHY_DEPTH_LABEL]: "3",
        },
        resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
        createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
      }),
    ).rejects.toThrow("Invalid remote subagent depth: 3");
  });
});
