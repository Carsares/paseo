import { expect, test } from "vitest";
import {
  AgentListItemPayloadSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WorkspaceDescriptorPayloadSchema,
} from "./messages.js";

const now = "2026-11-24T12:00:00.000Z";

test("workspace deferral and agent limit RPCs preserve exact destinations and correlated results", () => {
  const workspace = {
    type: "workspace.deferral.set.request",
    workspaceId: "workspace-1",
    action: "snooze",
    snoozedUntil: now,
    requestId: "one",
  };
  const recovery = {
    type: "agent.limit.recovery.request",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    turnId: "turn-1",
    action: "continue",
    requestId: "two",
  };

  expect(SessionInboundMessageSchema.parse(workspace)).toEqual(workspace);
  expect(SessionInboundMessageSchema.parse(recovery)).toEqual(recovery);
  expect(SessionInboundMessageSchema.safeParse({ ...recovery, turnId: "" }).success).toBe(false);
  expect(
    SessionInboundMessageSchema.safeParse({ ...workspace, snoozedUntil: "tomorrow" }).success,
  ).toBe(false);
  for (const type of ["workspace.deferral.set.response", "agent.limit.recovery.response"]) {
    const response = { type, payload: { requestId: "one", success: true, error: null } };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  }
});

test("new projections keep fields optional and strip private provider evidence", () => {
  const listItem = {
    id: "agent-1",
    shortId: "agent-1",
    title: null,
    provider: "codex",
    model: null,
    status: "error",
    cwd: "/repo",
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: null,
  };
  expect(AgentListItemPayloadSchema.parse(listItem)).not.toHaveProperty("conversationLimit");
  expect(
    AgentListItemPayloadSchema.parse({
      ...listItem,
      conversationLimit: {
        turnId: "turn-1",
        limitId: "quota",
        resetsAt: now,
        accountScope: "internal",
      },
      rateLimitContinuation: { turnId: "turn-1", runAt: now, status: "unknown" },
    }),
  ).toMatchObject({
    conversationLimit: { turnId: "turn-1", limitId: "quota", resetsAt: now },
    rateLimitContinuation: { turnId: "turn-1", runAt: now, status: "unknown" },
  });
  expect(
    AgentListItemPayloadSchema.parse({
      ...listItem,
      conversationLimit: {
        turnId: "turn-1",
        limitId: "quota",
        resetsAt: now,
        accountScope: "internal",
      },
    }).conversationLimit,
  ).toEqual({ turnId: "turn-1", limitId: "quota", resetsAt: now });
  expect(
    ServerInfoStatusPayloadSchema.parse({ status: "server_info", serverId: "host" }).features,
  ).toBeUndefined();
  expect(
    ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "host",
      features: { workspaceDeferral: true },
    }).features?.workspaceDeferral,
  ).toBe(true);
  const workspace = {
    id: "workspace-1",
    projectId: "project",
    projectDisplayName: "Project",
    projectRootPath: "/repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "Workspace",
    status: "done",
    activityAt: null,
  };
  expect(WorkspaceDescriptorPayloadSchema.parse(workspace)).not.toHaveProperty("snoozedUntil");
  expect(WorkspaceDescriptorPayloadSchema.parse({ ...workspace, parkedAt: now }).parkedAt).toBe(
    now,
  );
});
