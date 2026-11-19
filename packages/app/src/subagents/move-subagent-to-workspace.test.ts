import { describe, expect, it, vi } from "vitest";
import {
  canMoveSubagentToWorkspace,
  requestMoveSubagentToWorkspace,
  type MoveSubagentToWorkspaceDeps,
} from "./move-subagent-to-workspace";

describe("canMoveSubagentToWorkspace", () => {
  const agent = { parentAgentId: "parent", workspaceId: "workspace-1", archivedAt: null };
  const input = { featureEnabled: true, agent, parentAgent: { workspaceId: "workspace-1" } };

  it("allows a Paseo subagent in its parent's workspace", () => {
    expect(canMoveSubagentToWorkspace(input)).toBe(true);
  });

  it.each([
    ["the feature is disabled", { featureEnabled: false }],
    ["the agent is unavailable", { agent: null }],
    ["the agent has no parent", { agent: { ...agent, parentAgentId: null } }],
    ["the agent is archived", { agent: { ...agent, archivedAt: new Date(0) } }],
    ["the agent already roots a different workspace", { agent: { ...agent, workspaceId: "ws-2" } }],
  ])("blocks moving when %s", (_reason, overrides) => {
    expect(canMoveSubagentToWorkspace({ ...input, ...overrides })).toBe(false);
  });
});

const input = { serverId: "server-1", subagentId: "child-agent" };

function createDeps() {
  return {
    createIdempotencyKey: vi.fn(() => "move-key"),
    moveAgentToWorkspace: vi
      .fn<MoveSubagentToWorkspaceDeps["moveAgentToWorkspace"]>()
      .mockResolvedValue({ workspaceId: "new-workspace" }),
    openMovedWorkspace: vi.fn(),
    reportError: vi.fn(),
  };
}

describe("requestMoveSubagentToWorkspace", () => {
  it("moves immediately without confirmation and opens the returned workspace", async () => {
    const deps = createDeps();

    await requestMoveSubagentToWorkspace(input, deps);

    expect(deps.createIdempotencyKey).toHaveBeenCalledExactlyOnceWith();
    expect(deps.moveAgentToWorkspace).toHaveBeenCalledExactlyOnceWith({
      serverId: input.serverId,
      agentId: input.subagentId,
      idempotencyKey: "move-key",
    });
    expect(deps.openMovedWorkspace).toHaveBeenCalledExactlyOnceWith({
      serverId: input.serverId,
      workspaceId: "new-workspace",
      agentId: input.subagentId,
    });
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it("reports move failures, skips navigation, and allows retrying", async () => {
    const deps = createDeps();
    const error = new Error("Host disconnected");
    deps.moveAgentToWorkspace.mockRejectedValueOnce(error);

    await requestMoveSubagentToWorkspace(input, deps);

    expect(deps.reportError).toHaveBeenCalledExactlyOnceWith(error);
    expect(deps.openMovedWorkspace).not.toHaveBeenCalled();

    await requestMoveSubagentToWorkspace(input, deps);
    expect(deps.moveAgentToWorkspace).toHaveBeenCalledTimes(2);
    expect(deps.openMovedWorkspace).toHaveBeenCalledTimes(1);
  });

  it("keeps the move pending and reports failures while opening the workspace", async () => {
    const deps = createDeps();
    const navigation = Promise.withResolvers<void>();
    const navigationStarted = Promise.withResolvers<void>();
    deps.openMovedWorkspace.mockImplementationOnce(() => {
      navigationStarted.resolve();
      return navigation.promise;
    });

    const moving = requestMoveSubagentToWorkspace(input, deps);
    await navigationStarted.promise;
    await requestMoveSubagentToWorkspace(input, deps);
    expect(deps.moveAgentToWorkspace).toHaveBeenCalledTimes(1);

    const error = new Error("Could not open workspace");
    navigation.reject(error);
    await moving;
    expect(deps.reportError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("suppresses concurrent duplicates while the move is in flight", async () => {
    const deps = createDeps();
    const move = Promise.withResolvers<{ workspaceId: string }>();
    deps.moveAgentToWorkspace.mockReturnValueOnce(move.promise);

    const moving = requestMoveSubagentToWorkspace(input, deps);
    const duplicateDuringMove = requestMoveSubagentToWorkspace(input, deps);
    expect(deps.moveAgentToWorkspace).toHaveBeenCalledTimes(1);
    expect(deps.openMovedWorkspace).not.toHaveBeenCalled();
    await duplicateDuringMove;

    move.resolve({ workspaceId: "new-workspace" });
    await moving;
    expect(deps.openMovedWorkspace).toHaveBeenCalledTimes(1);
  });
});
