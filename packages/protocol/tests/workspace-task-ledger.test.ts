import { expect, test } from "vitest";
import {
  parseServerInfoStatusPayload,
  WSInboundMessageSchema,
  WSOutboundMessageSchema,
  type WorkspaceTaskSummary,
} from "../src/messages.js";

const workspaceId = "workspace-1";
const requestId = "request-1";
const at = "2026-11-24T00:00:00.000Z";
const task: WorkspaceTaskSummary = {
  taskId: "task-1",
  title: "Review startup changes",
  status: "in_progress",
  tier: "T2",
  participants: [{ agentId: "agent-1" }],
  createdAt: at,
  updatedAt: at,
};

function reply(tasks: unknown[], error: unknown) {
  return {
    type: "session",
    message: {
      type: "workspace.tasks.list.response",
      payload: { workspaceId, requestId, tasks, error },
    },
  };
}

test("registers a workspace task list request with top-level correlation fields", () => {
  const message = { type: "workspace.tasks.list.request", workspaceId, requestId };
  expect(WSInboundMessageSchema.parse({ type: "session", message })).toEqual({
    type: "session",
    message,
  });
  expect(
    WSInboundMessageSchema.safeParse({
      type: "session",
      message: { type: message.type, payload: { workspaceId, requestId } },
    }).success,
  ).toBe(false);
});

test("accepts tasks with or without optional ledger details", () => {
  const withDetails: WorkspaceTaskSummary = {
    ...task,
    taskId: "task-2",
    participants: [{ agentId: "agent-1", serverId: "server-1", boundBy: "main-1" }],
    handoffSummary: "Review the startup log",
    blockingQuestion: "Which build should be used?",
    verificationState: "not_run",
    recentAgentStates: [{ agentId: "agent-1", kind: "dispatched", at, lifecycle: "running" }],
  };
  const frame = reply([task, withDetails], null);
  expect(WSOutboundMessageSchema.parse(frame)).toEqual(frame);
});

test.each(["reported_blocked", "reported_completed"])(
  "accepts %s as the latest progress without lifecycle or recent agent states",
  (kind) => {
    const latestProgress = { agentId: "agent-1", kind, at };
    const frame = reply([{ ...task, latestProgress }], null);
    expect(WSOutboundMessageSchema.parse(frame)).toEqual(frame);
  },
);

test("accepts a string error and rejects missing or malformed reply fields", () => {
  const frame = reply([], "Workspace not found");
  expect(WSOutboundMessageSchema.parse(frame)).toEqual(frame);
  for (const invalid of [
    reply([], undefined),
    reply([], { code: "not_found" }),
    reply([{ ...task, participants: [{ serverId: "server-1" }] }], null),
    reply([{ ...task, recentAgentStates: [{ agentId: "agent-1", kind: "dispatched" }] }], null),
    reply([{ ...task, latestProgress: { agentId: "agent-1", kind: "reported_blocked" } }], null),
  ]) {
    expect(WSOutboundMessageSchema.safeParse(invalid).success).toBe(false);
  }
});

test("accepts server info both with and without task ledger support", () => {
  const payload = { status: "server_info", serverId: "server-1", hostname: null, version: null };
  expect(parseServerInfoStatusPayload(payload)).toEqual(payload);
  const withFeature = { ...payload, features: { workspaceTaskLedger: true } };
  expect(parseServerInfoStatusPayload(withFeature)).toEqual(withFeature);
});
