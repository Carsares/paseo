import { parentAddressLabels, RESIDENT_AGENT_LABEL } from "@getpaseo/protocol/agent-labels";
import { expect, it } from "vitest";
import { residentActionsForAgent, supportsResidentAction } from "./resident-actions";

it("offers binding only to a subagent of a local parent in its workspace", () => {
  const root = { id: "root", workspaceId: "workspace", labels: {} };
  const child = {
    ...root,
    id: "child",
    labels: parentAddressLabels({ serverId: "host", agentId: "root" }),
  };
  const leaf = {
    ...root,
    id: "leaf",
    labels: parentAddressLabels({ serverId: "host", agentId: "child" }),
  };
  const remote = {
    ...root,
    id: "remote",
    labels: parentAddressLabels({ serverId: "remote", agentId: "root" }),
  };
  const moved = { ...child, id: "moved", workspaceId: "elsewhere" };
  const agents = new Map([root, child, leaf, remote, moved].map((agent) => [agent.id, agent]));
  const forAgent = (agentId: string) =>
    residentActionsForAgent({ serverId: "host", agentId, agents, permissions: undefined });
  expect(forAgent("root")).toEqual(["create"]);
  expect(forAgent("child")).toEqual(["create", "bind"]);
  expect(forAgent("leaf")).toEqual(["bind"]);
  expect(forAgent("remote")).toEqual([]);
  expect(forAgent("moved")).not.toContain("bind");
});

it("matches the host's separate permission and capability requirements for residency and reset", () => {
  const agents = new Map([
    [
      "child",
      { id: "child", workspaceId: "workspace", labels: { [RESIDENT_AGENT_LABEL]: "true" } },
    ],
  ]);
  const forPermissions = (
    permissions: Parameters<typeof residentActionsForAgent>[0]["permissions"],
  ) => residentActionsForAgent({ serverId: "host", agentId: "child", agents, permissions });
  expect(forPermissions(["workspace.read"])).toEqual([]);
  expect(forPermissions(["workspace.write"])).toEqual(["unbind"]);
  expect(forPermissions(["workspace.write", "hub.execute"])).toEqual(["unbind", "reset"]);
  expect(supportsResidentAction({ agentResidentSpecialists: true }, "reset")).toBe(false);
  expect(supportsResidentAction({ agentSessionReset: true }, "unbind")).toBe(false);
});
