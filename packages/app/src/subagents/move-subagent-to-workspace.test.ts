import { describe, expect, it, vi } from "vitest";
import {
  canMoveSubagentToWorkspace,
  requestMoveSubagentToWorkspace,
  resolveMoveSubagentToWorkspaceDialog,
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

describe("resolveMoveSubagentToWorkspaceDialog", () => {
  it("uses the trimmed title and describes what moving does", () => {
    expect(resolveMoveSubagentToWorkspaceDialog({ title: "  Review branch  " })).toEqual({
      title: "Move to new workspace?",
      message:
        "Review branch will detach from its parent and open as a separate workspace in this project.",
      confirmLabel: "Move",
      cancelLabel: "Cancel",
      destructive: false,
    });
  });

  it.each([null, undefined, "   ", " NeW AgEnT "])("uses the fallback for title %s", (title) => {
    expect(resolveMoveSubagentToWorkspaceDialog({ title }).message).toBe(
      "This subagent will detach from its parent and open as a separate workspace in this project.",
    );
  });
});

const input = { serverId: "server-1", subagentId: "child-agent" };

function createDeps() {
  return {
    getSubagent: vi.fn(() => ({ title: "Review branch" })),
    confirm: vi.fn<MoveSubagentToWorkspaceDeps["confirm"]>().mockResolvedValue(true),
    createIdempotencyKey: vi.fn(() => "move-key"),
    moveAgentToWorkspace: vi
      .fn<MoveSubagentToWorkspaceDeps["moveAgentToWorkspace"]>()
      .mockResolvedValue({ workspaceId: "new-workspace" }),
    openMovedWorkspace: vi.fn(),
    reportError: vi.fn(),
  };
}

describe("requestMoveSubagentToWorkspace", () => {
  it("waits for confirmation and opens the workspace returned by the move", async () => {
    const deps = createDeps();
    const confirmation = Promise.withResolvers<boolean>();
    deps.confirm.mockReturnValueOnce(confirmation.promise);

    const moving = requestMoveSubagentToWorkspace(input, deps);
    expect(deps.getSubagent).toHaveBeenCalledWith(input.subagentId);
    expect(deps.confirm).toHaveBeenCalledWith(
      resolveMoveSubagentToWorkspaceDialog({ title: "Review branch" }),
    );
    expect(deps.createIdempotencyKey).not.toHaveBeenCalled();
    expect(deps.moveAgentToWorkspace).not.toHaveBeenCalled();
    expect(deps.openMovedWorkspace).not.toHaveBeenCalled();

    confirmation.resolve(true);
    await moving;

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

  it("skips the move and navigation if the user cancels", async () => {
    const deps = createDeps();
    deps.confirm.mockResolvedValueOnce(false);

    await requestMoveSubagentToWorkspace(input, deps);

    expect(deps.createIdempotencyKey).not.toHaveBeenCalled();
    expect(deps.moveAgentToWorkspace).not.toHaveBeenCalled();
    expect(deps.openMovedWorkspace).not.toHaveBeenCalled();
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
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.moveAgentToWorkspace).toHaveBeenCalledTimes(1);

    const error = new Error("Could not open workspace");
    navigation.reject(error);
    await moving;
    expect(deps.reportError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("suppresses concurrent duplicates through both confirmation and the move", async () => {
    const deps = createDeps();
    const confirmation = Promise.withResolvers<boolean>();
    const move = Promise.withResolvers<{ workspaceId: string }>();
    deps.confirm.mockReturnValueOnce(confirmation.promise);
    deps.moveAgentToWorkspace.mockReturnValueOnce(move.promise);

    const moving = requestMoveSubagentToWorkspace(input, deps);
    const duplicateDuringConfirmation = requestMoveSubagentToWorkspace(input, deps);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    await duplicateDuringConfirmation;

    confirmation.resolve(true);
    await confirmation.promise;
    const duplicateDuringMove = requestMoveSubagentToWorkspace(input, deps);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.moveAgentToWorkspace).toHaveBeenCalledTimes(1);
    expect(deps.openMovedWorkspace).not.toHaveBeenCalled();
    await duplicateDuringMove;

    move.resolve({ workspaceId: "new-workspace" });
    await moving;
    expect(deps.openMovedWorkspace).toHaveBeenCalledTimes(1);
  });
});
