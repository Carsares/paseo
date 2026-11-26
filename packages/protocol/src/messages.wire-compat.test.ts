import { describe, expect, test } from "vitest";
import { z } from "zod";
import { AgentMessageSchema } from "./agent-message.js";
import {
  AgentInboxFlushRequestSchema,
  AgentProfileSchema,
  MutableDaemonConfigSchema,
  MutableDaemonConfigPatchSchema,
  UsageReportEntrySchema,
  AgentForkSourceSchema,
  AgentCreateRequestSchema,
  CreateAgentRequestMessageSchema,
  DeleteAgentRequestMessageSchema,
  ArchiveAgentRequestMessageSchema,
  CreationSnapshotSchema,
  CreationSubscribeResponseSchema,
  AgentSnapshotPayloadSchema,
  AgentProviderSwitchRequestMessageSchema,
  AgentStreamEventPayloadSchema,
  AgentTimelineItemPayloadSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WSHelloMessageSchema,
  WorkspaceSetupSnapshotSchema,
  WorkspaceSetupProgressMessageSchema,
  AgentTimelineEntryPayloadSchema,
  CheckoutStatusResponseSchema,
  BranchSuggestionsRequestSchema,
  WorkspaceBaseBranchSetRequestSchema,
  WorkspaceBaseBranchSetResponseSchema,
  WorkspaceCreateRequestSchema,
  PendingSubagentInboxItemSchema,
  WorkspaceDurableItemSchema,
  WorkspaceTaskSummarySchema,
} from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

test("topic bindings extend legacy reports, inbox items, flush requests and task summaries", () => {
  const binding = { taskId: "task-1", rootMessageId: "prompt-1" };
  const report = { event: "finished", sender: { id: "child" }, text: "Report" };
  const inboxItem = { agentId: "child", event: "finished", reportStatus: "completed" };
  const flush = { type: "agent.inbox.flush.request", agentId: "parent", requestId: "flush-1" };
  const timestamp = "2026-11-26T00:00:00.000Z";
  const task = {
    taskId: binding.taskId,
    title: "Inspect startup",
    status: "in_progress",
    tier: "T1",
    participants: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const taskDetails = {
    rootMessageId: binding.rootMessageId,
    leadAgentId: "child",
    leadServerId: "host-1",
    conclusionMessageId: "reply-1",
    latestReplyPreview: "",
  };
  const taskWithDetails = { ...task, ...taskDetails };

  expect(AgentMessageSchema.parse(report)).toEqual(report);
  expect(AgentMessageSchema.parse({ ...report, ...binding })).toEqual({ ...report, ...binding });
  expect(
    AgentMessageSchema.omit({ taskId: true, rootMessageId: true }).parse({ ...report, ...binding }),
  ).toEqual(report);
  expect(PendingSubagentInboxItemSchema.parse(inboxItem)).toEqual(inboxItem);
  expect(PendingSubagentInboxItemSchema.parse({ ...inboxItem, ...binding })).toEqual({
    ...inboxItem,
    ...binding,
  });
  expect(
    PendingSubagentInboxItemSchema.omit({ taskId: true, rootMessageId: true }).parse({
      ...inboxItem,
      ...binding,
    }),
  ).toEqual(inboxItem);
  expect(SessionInboundMessageSchema.parse(flush)).toEqual(flush);
  expect(SessionInboundMessageSchema.parse({ ...flush, taskId: binding.taskId })).toEqual({
    ...flush,
    taskId: binding.taskId,
  });
  expect(
    AgentInboxFlushRequestSchema.omit({ taskId: true }).parse({ ...flush, taskId: binding.taskId }),
  ).toEqual(flush);
  expect(SessionInboundMessageSchema.safeParse({ ...flush, taskId: "" }).success).toBe(false);
  expect(WorkspaceTaskSummarySchema.parse(task)).toEqual(task);
  expect(WorkspaceTaskSummarySchema.parse(taskWithDetails)).toEqual(taskWithDetails);
  expect(
    WorkspaceTaskSummarySchema.omit({
      rootMessageId: true,
      leadAgentId: true,
      leadServerId: true,
      conclusionMessageId: true,
      latestReplyPreview: true,
    }).parse(taskWithDetails),
  ).toEqual(task);

  const durableItem = {
    workspaceId: "ws-1",
    requestId: "durable-1",
    sourceAgentId: "agent-1",
    sourceTurnId: "turn-1",
    kind: "authorization" as const,
    title: "Approve change",
    evidence: [],
    revision: 0,
    createdAt: timestamp,
    status: "pending" as const,
  };
  expect(WorkspaceDurableItemSchema.parse(durableItem)).toEqual(durableItem);
  expect(WorkspaceDurableItemSchema.safeParse({ ...durableItem, kind: "todo" }).success).toBe(
    false,
  );
});

test("topic feature flags survive status validation and stay optional for older hosts", () => {
  const oldFeatures = { agentCreateAsMain: true };
  const legacyInfo = { status: "server_info", serverId: "host", features: oldFeatures };
  const features = {
    ...oldFeatures,
    workspaceTopicThreads: true,
    workspaceTopicReadState: false,
    workspaceTodos: true,
  };
  const info = { ...legacyInfo, features };
  expect(ServerInfoStatusPayloadSchema.parse(legacyInfo).features).toEqual(oldFeatures);
  expect(ServerInfoStatusPayloadSchema.parse(info).features).toEqual(features);
  expect(z.object({ agentCreateAsMain: z.boolean() }).parse(features)).toEqual(oldFeatures);
  const envelope = { type: "session", message: { type: "status", payload: info } };
  expect(validateWSOutboundMessage(envelope)).toEqual({ success: true, data: envelope });
  expect(
    ServerInfoStatusPayloadSchema.safeParse({ ...info, features: { workspaceTodos: "true" } })
      .success,
  ).toBe(false);
});

test("idle archive extends the current archive request and host feature shapes", () => {
  const legacyRequest = {
    type: "archive_agent_request",
    agentId: "agent-1",
    expectedWorkspaceId: "workspace-1",
    requestId: "archive-1",
  };
  const request = { ...legacyRequest, onlyIfIdle: true };
  expect(SessionInboundMessageSchema.parse(legacyRequest)).toEqual(legacyRequest);
  expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  expect(ArchiveAgentRequestMessageSchema.omit({ onlyIfIdle: true }).parse(request)).toEqual(
    legacyRequest,
  );
  expect(
    SessionInboundMessageSchema.safeParse({ ...legacyRequest, onlyIfIdle: false }).success,
  ).toBe(false);

  const payload = {
    status: "server_info",
    serverId: "server-1",
    features: { agentIdleArchiveV1: true },
  };
  const envelope = { type: "session", message: { type: "status", payload } };
  expect(validateWSOutboundMessage(envelope)).toMatchObject({ success: true, data: envelope });
});

test("blank provider switches extend the existing request and host feature shapes", () => {
  const legacyRequest = {
    type: "agent.provider.switch.request",
    agentId: "agent-1",
    provider: "claude",
    requestId: "switch-1",
  };
  const blankRequest = { ...legacyRequest, context: "blank" };
  const silentRequest = { ...blankRequest, onlyIfSilent: true };
  expect(SessionInboundMessageSchema.parse(legacyRequest)).toEqual(legacyRequest);
  expect(SessionInboundMessageSchema.parse(blankRequest)).toEqual(blankRequest);
  expect(SessionInboundMessageSchema.parse(silentRequest)).toEqual(silentRequest);
  expect(
    AgentProviderSwitchRequestMessageSchema.omit({ context: true, onlyIfSilent: true }).parse(
      silentRequest,
    ),
  ).toEqual(legacyRequest);
  expect(
    SessionInboundMessageSchema.safeParse({ ...silentRequest, onlyIfSilent: false }).success,
  ).toBe(false);
  expect(
    SessionInboundMessageSchema.safeParse({ ...legacyRequest, context: "handoff" }).success,
  ).toBe(false);

  const legacyFeatures = { agentSeamlessContextSwitch: true };
  const legacyInfo = { status: "server_info", serverId: "server-1", features: legacyFeatures };
  const features = { ...legacyFeatures, agentProviderSwitchBlankContext: true };
  expect(ServerInfoStatusPayloadSchema.parse(legacyInfo).features).toEqual(legacyFeatures);
  expect(z.object({ agentSeamlessContextSwitch: z.boolean().optional() }).parse(features)).toEqual(
    legacyFeatures,
  );
  const envelope = {
    type: "session",
    message: { type: "status", payload: { ...legacyInfo, features } },
  };
  expect(validateWSOutboundMessage(envelope)).toMatchObject({ success: true, data: envelope });
});

test("workbench features and topic creation extend legacy wire shapes", () => {
  const info = { status: "server_info", serverId: "server-1" };
  const oldFeatures = { agentCreateAsMain: true };
  const features = {
    ...oldFeatures,
    topicWorkbenchV1: true,
    workspaceDurableItemsV1: true,
    checkoutGitStagingV1: false,
    checkoutGitGraphV1: true,
    checkoutGitRebaseV1: true,
    checkoutGitMultiRepoV1: true,
  };
  expect(ServerInfoStatusPayloadSchema.parse({ ...info, features: oldFeatures }).features).toEqual(
    oldFeatures,
  );
  expect(z.object({ agentCreateAsMain: z.boolean().optional() }).parse(features)).toEqual(
    oldFeatures,
  );
  const envelope = { type: "session", message: { type: "status", payload: { ...info, features } } };
  expect(validateWSOutboundMessage(envelope)).toMatchObject({ success: true, data: envelope });

  const legacyRequest = {
    type: "workspace.create.request",
    requestId: "create-1",
    source: { kind: "directory", path: "/repo" },
    title: "Topic",
    mainAgent: { config: { provider: "codex", cwd: "/repo" } },
  };
  const request = { ...legacyRequest, topic: { summary: "Inspect startup", hideFromModel: true } };
  expect(SessionInboundMessageSchema.parse(legacyRequest)).toMatchObject(legacyRequest);
  expect(SessionInboundMessageSchema.parse(request)).toMatchObject(request);
  const oldSchema = WorkspaceCreateRequestSchema.omit({ topic: true });
  expect(oldSchema.parse(request)).toEqual(oldSchema.parse(legacyRequest));
});

test("deciding an item requires a target ID distinct from the RPC correlation field", () => {
  const request = {
    type: "workspace.durable_item.decide.request",
    requestId: "call-1",
    workspaceId: "workspace-1",
    expectedRevision: 3,
    decision: "approve",
  };
  expect(SessionInboundMessageSchema.safeParse(request).success).toBe(false);
  const decision = { ...request, durableItemRequestId: "item-1" };
  expect(SessionInboundMessageSchema.parse(decision)).toEqual(decision);
});

test("new Git RPCs reject unsupported operations and preserve the legacy commit request", () => {
  const legacy = { type: "checkout_commit_request", cwd: "/repo", requestId: "legacy-commit" };
  expect(SessionInboundMessageSchema.parse(legacy)).toMatchObject(legacy);
  const rebase = {
    type: "checkout.git.rebase.execute.request",
    cwd: "/repo",
    targetRepoRoot: "/repo",
    requestId: "rebase-1",
    expectedHeadSha: "a".repeat(40),
    ontoRef: "main",
  };
  const sha = "b".repeat(40);
  expect(
    SessionInboundMessageSchema.safeParse({ ...rebase, steps: [{ type: "exec", sha }] }).success,
  ).toBe(false);
  expect(
    SessionInboundMessageSchema.safeParse({ ...rebase, steps: [{ type: "reword", sha }] }).success,
  ).toBe(false);
  expect(SessionInboundMessageSchema.parse({ ...rebase, steps: [{ type: "pick", sha }] })).toEqual({
    ...rebase,
    steps: [{ type: "pick", sha }],
  });
});

test.each([
  {
    request: {
      type: "checkout.git.conflict.resolve.request",
      path: "boot.ts",
      strategy: "ours",
      hunkIndex: 0,
    },
    key: "expectedConflictFingerprint",
    value: "snapshot:v1/a+=",
  },
  {
    request: {
      type: "checkout.git.rebase.act.request",
      action: "continue",
    },
    key: "expectedRebaseId",
    value: "rebase:v1/b+=",
  },
])(
  "$request.type requires a nonempty snapshot or instance identifier",
  ({ request, key, value }) => {
    const base = { ...request, cwd: "/repo", targetRepoRoot: "/repo", requestId: "write-1" };
    expect(SessionInboundMessageSchema.safeParse(base).success).toBe(false);
    expect(SessionInboundMessageSchema.safeParse({ ...base, [key]: "" }).success).toBe(false);
    const guarded = { ...base, [key]: value };
    expect(SessionInboundMessageSchema.parse(guarded)).toEqual(guarded);
  },
);

test("rebase undo retains the reserved backup reference constraint", () => {
  const undo = {
    type: "checkout.git.rebase.act.request",
    action: "undo",
    cwd: "/repo",
    targetRepoRoot: "/repo",
    requestId: "undo-1",
    expectedRebaseId: "rebase-1",
  };
  expect(
    SessionInboundMessageSchema.safeParse({ ...undo, backupRef: "refs/heads/main" }).success,
  ).toBe(false);
  const valid = { ...undo, backupRef: "refs/paseo/backup/rebase-1" };
  expect(SessionInboundMessageSchema.parse(valid)).toEqual(valid);
});

test("workspace creation keeps accepting legacy sources and preserves a capability-gated pin", () => {
  const request = { type: "workspace.create.request", requestId: "create-1" };
  for (const source of [
    { kind: "directory", path: "/repo" },
    { kind: "worktree", cwd: "/repo" },
    { kind: "worktree", cwd: "/repo", githubPrNumber: 5 },
    {
      kind: "worktree",
      projectId: "repo",
      action: "branch-off",
      refName: "refs/heads/main",
      startPoint: "a".repeat(40),
    },
  ]) {
    expect(SessionInboundMessageSchema.parse({ ...request, source })).toEqual({
      ...request,
      source,
    });
  }
  expect(
    SessionInboundMessageSchema.safeParse({
      ...request,
      source: { kind: "directory", path: "/repo", startPoint: "a".repeat(40) },
    }).success,
  ).toBe(false);
});

test("the fixed worktree start point RPC preserves its correlated reply", () => {
  const request = {
    type: "workspace.worktree.resolve_start_point.request",
    requestId: "resolve-1",
    projectId: "repo",
    refName: "refs/remotes/upstream/main",
  };
  expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  const response = {
    type: "session",
    message: {
      type: "workspace.worktree.resolve_start_point.response",
      payload: {
        requestId: request.requestId,
        commitSha: "a".repeat(40),
        refName: request.refName,
        error: null,
      },
    },
  };
  expect(validateWSOutboundMessage(response)).toMatchObject({ success: true, data: response });
});

test("creation receipt readers accept old receipts and preserve optional prompt confirmation", () => {
  const oldReceipt = {
    kind: "workspace",
    idempotencyKey: "create-1",
    revision: 4,
    phase: "completed",
    workspaceId: "workspace",
    agentId: "agent",
    error: null,
  };
  const confirmedReceipt = { ...oldReceipt, initialPromptStarted: true };
  const legacyReader = CreationSnapshotSchema.omit({ initialPromptStarted: true });
  expect(legacyReader.parse(confirmedReceipt)).toEqual(oldReceipt);
  expect(CreationSnapshotSchema.parse(oldReceipt)).toEqual(oldReceipt);
  const response = {
    type: "creation.subscribe.response",
    payload: { requestId: "read-1", snapshot: confirmedReceipt, error: null },
  };
  expect(CreationSubscribeResponseSchema.parse(response)).toEqual(response);
  const envelope = { type: "session", message: response };
  expect(validateWSOutboundMessage(envelope)).toMatchObject({ success: true, data: envelope });
});

test("fork sources require a source agent and validate optional boundaries", () => {
  expect(AgentForkSourceSchema.parse({ sourceAgentId: "source-agent" })).toEqual({
    sourceAgentId: "source-agent",
  });
  for (const invalid of [
    { sourceAgentId: "" },
    { sourceAgentId: "source-agent", boundaryMessageId: "" },
    { sourceAgentId: "source-agent", boundaryCursor: { epoch: "epoch-1", seq: -1 } },
  ]) {
    expect(AgentForkSourceSchema.safeParse(invalid).success).toBe(false);
  }
});

test("side chat creation and cleanup extend legacy wire messages with optional fields", () => {
  for (const schema of [CreateAgentRequestMessageSchema, AgentCreateRequestSchema]) {
    const type = schema.shape.type.value;
    const original = { type, requestId: "side-1", config: { provider: "codex", cwd: "/repo" } };
    const sideChat = {
      ...original,
      sideChatFromAgentId: "source",
      forkFrom: { sourceAgentId: "source", boundaryCursor: { epoch: "", seq: 0 } },
    };
    expect(schema.parse(original)).not.toHaveProperty("sideChatFromAgentId");
    expect(schema.parse(sideChat)).toMatchObject(sideChat);
    expect(schema.omit({ sideChatFromAgentId: true }).parse(sideChat)).toEqual(
      schema.parse({ ...original, forkFrom: sideChat.forkFrom }),
    );
    expect(schema.safeParse({ ...sideChat, sideChatFromAgentId: "" }).success).toBe(false);
  }

  const deletion = { type: "delete_agent_request", requestId: "delete-1", agentId: "side-1" };
  const conditional = { ...deletion, onlyIfEmptySideChat: true };
  expect(DeleteAgentRequestMessageSchema.parse(deletion)).toEqual(deletion);
  expect(DeleteAgentRequestMessageSchema.parse(conditional)).toEqual(conditional);
  expect(
    DeleteAgentRequestMessageSchema.omit({ onlyIfEmptySideChat: true }).parse(conditional),
  ).toEqual(deletion);
});

test("agentSideChat is optional in the server handshake and survives wire validation", () => {
  const legacyFeatures = z.object({ agentSeamlessContextSwitch: z.boolean().optional() });
  const info = { status: "server_info", serverId: "server-1" };
  const features = { agentSeamlessContextSwitch: true, agentSideChat: true };
  expect(ServerInfoStatusPayloadSchema.parse(info).features).toBeUndefined();
  expect(legacyFeatures.parse(features)).toEqual({ agentSeamlessContextSwitch: true });
  const envelope = { type: "session", message: { type: "status", payload: { ...info, features } } };
  expect(validateWSOutboundMessage(envelope)).toMatchObject({ success: true, data: envelope });
});

test("agent and workspace creation accept and preserve optional fork sources", () => {
  const requestId = "creation-1";
  const config = { provider: "codex", cwd: "/repo" };
  const forkFrom = {
    sourceAgentId: "source-agent",
    boundaryCursor: { epoch: "epoch-1", seq: 4 },
    boundaryMessageId: "message-1",
  };
  for (const fields of [{ config }, { config, forkFrom }]) {
    const requests = [
      { type: "create_agent_request", requestId, ...fields },
      { type: "agent.create.request", requestId, ...fields },
      {
        type: "workspace.create.request",
        requestId,
        source: { kind: "directory", path: "/repo" },
        agent: fields,
      },
    ];
    for (const request of requests) {
      const parsed = SessionInboundMessageSchema.parse(request);
      expect(parsed).toMatchObject(request);
      if (!("forkFrom" in fields)) {
        expect(
          parsed.type === "workspace.create.request" ? parsed.agent : parsed,
        ).not.toHaveProperty("forkFrom");
      }
    }
  }
});

test("only modern creation requests preserve an explicit main workspace role", () => {
  const requestId = "creation-main-1";
  const config = { provider: "codex", cwd: "/repo" };
  const agent = { type: "agent.create.request", requestId, config };
  const workspace = {
    type: "workspace.create.request",
    requestId,
    source: { kind: "directory", path: "/repo" },
  };

  for (const workspaceRole of [undefined, "main", "member", false, null]) {
    const fields = workspaceRole === undefined ? { config } : { config, workspaceRole };
    for (const request of [
      { ...agent, ...fields },
      { ...workspace, agent: fields },
    ]) {
      if (workspaceRole === undefined || workspaceRole === "main") {
        expect(SessionInboundMessageSchema.parse(request)).toMatchObject(request);
      } else {
        expect(SessionInboundMessageSchema.safeParse(request).success).toBe(false);
      }
    }
  }
  expect(
    SessionInboundMessageSchema.parse({
      ...agent,
      type: "create_agent_request",
      workspaceRole: "main",
    }),
  ).not.toHaveProperty("workspaceRole");
});

test("modern creation responses preserve the structured workspace main conflict code", () => {
  const response = {
    type: "agent.create.response",
    payload: {
      requestId: "creation-main-2",
      agent: null,
      error: "This workspace already has an active Main Session.",
      errorCode: "workspace_main_exists",
    },
  } as const;

  expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  expect(validateWSOutboundMessage({ type: "session", message: response })).toMatchObject({
    success: true,
  });
});

test("provider switch is a registered request and response with optional settings and notice", () => {
  const request = {
    type: "agent.provider.switch.request",
    requestId: "switch-1",
    agentId: "agent-1",
    provider: "claude",
  };
  const settings = { model: null, modeId: "plan", thinkingOptionId: null, options: { speed: 1 } };
  expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  expect(SessionInboundMessageSchema.parse({ ...request, ...settings })).toEqual({
    ...request,
    ...settings,
  });
  expect(SessionInboundMessageSchema.safeParse({ ...request, agentId: "" }).success).toBe(false);

  const response = {
    type: "agent.provider.switch.response",
    payload: {
      requestId: request.requestId,
      agentId: request.agentId,
      accepted: false,
      agent: null,
      error: "Provider unavailable",
    },
  };
  expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);

  const frame = { type: "session", message: response };
  expect(validateWSOutboundMessage(frame)).toEqual({ success: true, data: frame });
  expect(
    validateWSOutboundMessage({
      ...frame,
      message: { ...response, payload: { ...response.payload, notice: { type: "warning" } } },
    }),
  ).toMatchObject({
    success: false,
    error: {
      issues: [expect.objectContaining({ path: ["message", "payload", "notice", "message"] })],
    },
  });
});

test("server info preserves the optional seamless context switch capability", () => {
  const info = { status: "server_info", serverId: "server-1" };
  for (const features of [
    {},
    { agentSeamlessContextSwitch: true },
    { agentSeamlessContextSwitch: false },
  ]) {
    expect(ServerInfoStatusPayloadSchema.parse({ ...info, features }).features).toEqual(features);
  }
});

test("server info keeps agentCreateAsMain independent and optional", () => {
  const info = { status: "server_info", serverId: "server-1" };
  expect(ServerInfoStatusPayloadSchema.parse(info).features).toBeUndefined();
  expect(
    ServerInfoStatusPayloadSchema.parse({ ...info, features: { agentCreateAsMain: true } })
      .features,
  ).toEqual({ agentCreateAsMain: true });
  expect(
    ServerInfoStatusPayloadSchema.parse({ ...info, features: { agentCreateAsMain: false } })
      .features,
  ).toEqual({ agentCreateAsMain: false });
});

test("checkpoint rewind negotiates independently of legacy rewind and preserves retry data", () => {
  const info = { status: "server_info", serverId: "server-1" };
  expect(
    ServerInfoStatusPayloadSchema.parse({ ...info, features: { rewind: true } }).features,
  ).toEqual({ rewind: true });
  expect(
    ServerInfoStatusPayloadSchema.parse({
      ...info,
      features: { rewind: true, rewindCheckpoints: true },
    }).features,
  ).toEqual({ rewind: true, rewindCheckpoints: true });
  const legacy = {
    type: "agent.rewind.request",
    agentId: "agent-1",
    messageId: "message-1",
    requestId: "old",
    mode: "conversation",
  };
  expect(SessionInboundMessageSchema.parse(legacy)).toEqual(legacy);
  const response = {
    type: "session",
    message: {
      type: "agent.rewind.checkpoint.restore.response",
      payload: {
        requestId: "restore-1",
        agentId: "agent-1",
        ok: false,
        error: "Worktree changed",
        operation: {
          operationId: "operation-1",
          target: { checkpointId: "checkpoint-1", messageId: "message-1" },
          backupCheckpointId: "backup-1",
          conversationRewound: true,
          status: "files_pending",
        },
      },
    },
  };
  expect(validateWSOutboundMessage(response)).toMatchObject({ success: true, data: response });
});

test("checkpoint historical diffs accept old responses and preserve staging when present", () => {
  const ready = { kind: "ready", files: [], diffTooLarge: false, attribution: "unknown" };
  const stagedFiles = [
    {
      path: "staged.txt",
      isNew: true,
      isDeleted: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    },
  ];
  for (const result of [ready, { ...ready, stagedFiles }]) {
    const response = {
      type: "session",
      message: {
        type: "agent.rewind.checkpoint.diff.get.response",
        payload: { requestId: "diff", agentId: "agent", ok: true, error: null, result },
      },
    };
    expect(validateWSOutboundMessage(response)).toMatchObject({ success: true, data: response });
  }
});

test("checkpoint pending file recovery is optional and does not require an original message", () => {
  const request = {
    type: "agent.rewind.checkpoint.get.request",
    requestId: "lookup",
    agentId: "agent",
    messageId: "original-message",
  };
  const pendingRequest = { ...request, messageId: "", pendingFiles: true };
  expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  expect(SessionInboundMessageSchema.parse(pendingRequest)).toEqual(pendingRequest);
  const base = { requestId: "lookup", agentId: "agent", ok: true, error: null };
  for (const payload of [
    { ...base, target: { messageId: "original-message", checkpointId: "checkpoint" } },
    { ...base, pendingFiles: [{ operationId: "operation", conversationRewound: true }] },
    {
      ...base,
      pendingFiles: [{ operationId: "operation", conversationRewound: true }],
      unconfirmedFileRewinds: [{ operationId: "unconfirmed" }],
    },
  ]) {
    const message = { type: "agent.rewind.checkpoint.get.response", payload };
    const response = { type: "session", message };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
    expect(validateWSOutboundMessage(response)).toMatchObject({ success: true, data: response });
  }
  expect(
    ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server",
      features: { rewindCheckpoints: true, rewindPendingFiles: true },
    }).features,
  ).toEqual({ rewindCheckpoints: true, rewindPendingFiles: true });
});

test("resident specialist and reset capabilities are optional booleans", () => {
  const info = { status: "server_info", serverId: "server-1" };
  expect(ServerInfoStatusPayloadSchema.parse(info).features).toBeUndefined();
  const features = { agentResidentSpecialists: true, agentSessionReset: false };
  expect(ServerInfoStatusPayloadSchema.parse({ ...info, features }).features).toEqual(features);
  for (const key of Object.keys(features)) {
    expect(
      ServerInfoStatusPayloadSchema.safeParse({ ...info, features: { [key]: "true" } }).success,
    ).toBe(false);
  }
});

test("profiles preserve legacy IDs and accept optional role defaults", () => {
  const profile = { id: "p".repeat(129), provider: "codex", name: "Review" };
  const defaults = {
    roleSlug: "a".repeat(64),
    rolePrompt: "p".repeat(16384),
    defaultResident: true,
    residentUrgentReport: false,
    residentKeepAlive: true,
  };
  expect(AgentProfileSchema.parse(profile)).toEqual(profile);
  expect(
    MutableDaemonConfigPatchSchema.parse({ agentProfiles: [{ ...profile, ...defaults }] }),
  ).toEqual({ agentProfiles: [{ ...profile, ...defaults }] });
  for (const invalid of [
    { roleSlug: "-review" },
    { roleSlug: defaults.roleSlug + "a" },
    { rolePrompt: defaults.rolePrompt + "p" },
    { defaultResident: "true" },
  ]) {
    expect(AgentProfileSchema.safeParse({ ...profile, ...invalid }).success).toBe(false);
  }
});

test("resident specialist and session reset RPCs are registered in both directions", () => {
  const requestId = "r-1";
  const agentId = "child-1";
  const requests = [
    {
      type: "agent.resident.set.request",
      requestId,
      agentId,
      resident: true,
      role: "Review code",
      roleSlug: "review",
      profileId: "profile-1",
      urgentReport: false,
    },
    { type: "agent.resident.set.request", requestId, agentId, resident: false },
    {
      type: "agent.resident.create.request",
      requestId,
      parentAgentId: "parent-1",
      profileId: "p".repeat(128),
      role: "r".repeat(500),
      roleSlug: "a".repeat(64),
      keepAlive: true,
    },
    { type: "agent.session.reset.request", requestId, agentId },
    {
      type: "agent.session.reset.request",
      requestId,
      agentId,
      interrupt: false,
      clearVisibleTimeline: true,
    },
  ];
  for (const request of requests) {
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  }
  for (const invalid of [
    { ...requests[0], role: " " },
    { ...requests[0], role: "r".repeat(501) },
    { ...requests[2], profileId: "p".repeat(129) },
    { ...requests[2], profileId: undefined },
    { ...requests[2], roleSlug: "Not-a-slug" },
    { ...requests[4], clearVisibleTimeline: "true" },
  ]) {
    expect(SessionInboundMessageSchema.safeParse(invalid).success).toBe(false);
  }

  const success = { requestId, agentId, accepted: true, error: null };
  const error = { requestId, accepted: false, error: "Cannot complete request" };
  const messages = [
    { type: "agent.resident.set.response", payload: success },
    { type: "agent.resident.create.response", payload: { ...success, created: true } },
    { type: "agent.resident.create.response", payload: { ...success, created: false } },
    {
      type: "agent.resident.create.response",
      payload: { ...error, agentId: null, created: false },
    },
    { type: "agent.session.reset.response", payload: { ...error, agentId } },
  ];
  for (const message of messages) {
    const frame = { type: "session", message };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
    expect(validateWSOutboundMessage(frame)).toEqual({ success: true, data: frame });
  }
  for (const payload of [
    { ...success, agentId: null, created: false },
    { ...success, created: true, error: "Failed" },
    { ...error, agentId: null, created: true },
  ]) {
    const message = { type: "agent.resident.create.response", payload };
    expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(false);
    expect(validateWSOutboundMessage({ type: "session", message }).success).toBe(false);
  }
});

test("base selection RPCs are correlated while older checkout and branch messages remain valid", () => {
  const payload = {
    cwd: "/repo",
    requestId: "status",
    error: null,
    isGit: true,
    isPaseoOwnedWorktree: false,
    repoRoot: "/repo",
    currentBranch: "feature",
    isDirty: false,
    baseRef: "release",
    aheadBehind: null,
    aheadOfOrigin: null,
    behindOfOrigin: null,
    hasRemote: false,
    remoteUrl: null,
  };
  expect(
    CheckoutStatusResponseSchema.safeParse({ type: "checkout_status_response", payload }).success,
  ).toBe(true);
  expect(
    CheckoutStatusResponseSchema.parse({
      type: "checkout_status_response",
      payload: { ...payload, baseRefExact: "refs/remotes/upstream/release" },
    }).payload.baseRefExact,
  ).toBe("refs/remotes/upstream/release");
  expect(
    BranchSuggestionsRequestSchema.safeParse({
      type: "branch_suggestions_request",
      cwd: "/repo",
      requestId: "branches",
    }).success,
  ).toBe(true);
  const request = {
    type: "workspace.base_branch.set.request",
    workspaceId: "workspace",
    baseRef: "refs/heads/release",
    requestId: "base",
  };
  expect(WorkspaceBaseBranchSetRequestSchema.parse(request)).toEqual(request);
  const response = {
    type: "workspace.base_branch.set.response",
    payload: {
      workspaceId: "workspace",
      baseRef: "refs/heads/release",
      requestId: "base",
      accepted: true,
      error: null,
    },
  };
  expect(WorkspaceBaseBranchSetResponseSchema.parse(response)).toEqual(response);
});

test("checkout status stays valid without pull and push remotes and retains them when sent", () => {
  const olderDaemonPayload = {
    cwd: "/repo",
    requestId: "status",
    error: null,
    isGit: true,
    isPaseoOwnedWorktree: false,
    repoRoot: "/repo",
    currentBranch: "main",
    isDirty: false,
    baseRef: "main",
    aheadBehind: null,
    aheadOfOrigin: 1,
    behindOfOrigin: 2,
    hasRemote: false,
    remoteUrl: null,
    upstreamRef: "refs/remotes/doras-mono/main",
    upstreamState: "tracked",
    firstPushRemote: null,
  };
  const parse = (payload: Record<string, unknown>) =>
    CheckoutStatusResponseSchema.parse({ type: "checkout_status_response", payload }).payload;

  const older = parse(olderDaemonPayload);
  expect(older.pullRemote).toBeUndefined();
  expect(older.pushRemote).toBeUndefined();
  expect(
    parse({ ...olderDaemonPayload, pullRemote: "doras-mono", pushRemote: "doras-mono" }),
  ).toMatchObject({ pullRemote: "doras-mono", pushRemote: "doras-mono" });
  expect(parse({ ...olderDaemonPayload, pullRemote: "upstream", pushRemote: null })).toMatchObject({
    pullRemote: "upstream",
    pushRemote: null,
  });
});

test("terminal listings accept older rows and retain new per-terminal directories", () => {
  const response = {
    type: "list_terminals_response",
    payload: {
      requestId: "terminal-list",
      cwd: "/workspace",
      terminals: [{ id: "terminal", name: "Shell", workspaceId: "workspace" }],
    },
  };
  expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  const withDirectory = {
    ...response,
    payload: {
      ...response.payload,
      terminals: [{ ...response.payload.terminals[0], cwd: "/workspace/subdirectory" }],
    },
  };
  expect(SessionOutboundMessageSchema.parse(withDirectory)).toEqual(withDirectory);
});

const LegacySubAgentToolCallSchema = z.object({
  type: z.literal("tool_call"),
  callId: z.string(),
  name: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  error: z.unknown().nullable(),
  detail: z.object({
    type: z.literal("sub_agent"),
    subAgentType: z.string().optional(),
    description: z.string().optional(),
    log: z.string(),
    // Copied from v0.1.65-beta.3: actions was required even though the UI ignored it.
    actions: z.array(
      z.object({
        index: z.number().int().positive(),
        toolName: z.string(),
        summary: z.string().optional(),
      }),
    ),
  }),
});

const LegacyAgentCapabilityFlagsSchema = z.object({
  supportsStreaming: z.boolean(),
  supportsSessionPersistence: z.boolean(),
  supportsDynamicModes: z.boolean(),
  supportsMcpServers: z.boolean(),
  supportsReasoningStream: z.boolean(),
  supportsToolInvocations: z.boolean(),
});

const LegacyAgentSnapshotPayloadSchema = AgentSnapshotPayloadSchema.extend({
  capabilities: LegacyAgentCapabilityFlagsSchema,
});

describe("wire schema compatibility", () => {
  test("hello parses with and without the project update capability", () => {
    const legacy = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "legacy-client",
      clientType: "mobile",
      protocolVersion: 1,
    });
    const capable = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "capable-client",
      clientType: "mobile",
      protocolVersion: 1,
      capabilities: { project_updates: true },
    });

    expect([legacy, capable]).toEqual([
      {
        type: "hello",
        clientId: "legacy-client",
        clientType: "mobile",
        protocolVersion: 1,
      },
      {
        type: "hello",
        clientId: "capable-client",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: { project_updates: true },
      },
    ]);
  });

  test("timeline replacement invalidation is opt-in and carries no timeline rows", () => {
    expect(
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "capable-client",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: { timeline_replacement_invalidation: true },
      }).capabilities,
    ).toEqual({ timeline_replacement_invalidation: true });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.timeline.replacement",
        payload: { agentId: "agent-1", epoch: "epoch-2" },
      }),
    ).toEqual({
      type: "agent.timeline.replacement",
      payload: { agentId: "agent-1", epoch: "epoch-2" },
    });
  });

  test("server info strips unknown legacy features while accepting former turn identity", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "legacy-server",
      features: {
        workspaceGithubClone: true,
        agentTurnIdentity: true,
      },
    });

    expect(parsed).toEqual({
      status: "server_info",
      serverId: "legacy-server",
      hostname: null,
      version: null,
      features: { agentTurnIdentity: true },
    });
  });

  test("server info accepts optional machineKind and older clients drop it cleanly", () => {
    const legacyServerInfo = z.object({
      status: z.literal("server_info"),
      serverId: z.string().trim().min(1),
      hostname: z.string().nullable().optional(),
      version: z.string().nullable().optional(),
    });
    const withKind = {
      status: "server_info",
      serverId: "macbook-server",
      hostname: "mbp.local",
      version: "0.9.5",
      machineKind: "laptop",
    };

    expect(ServerInfoStatusPayloadSchema.parse(withKind).machineKind).toBe("laptop");
    expect(
      ServerInfoStatusPayloadSchema.parse({ ...withKind, machineKind: null }).machineKind,
    ).toBeNull();
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "older-server",
      }).machineKind,
    ).toBeUndefined();
    expect(legacyServerInfo.parse(withKind)).not.toHaveProperty("machineKind");
  });

  test("assistant timeline message ids are optional on the wire", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "assistant_message",
        text: "old daemon shape",
      }),
    ).toEqual({
      type: "assistant_message",
      text: "old daemon shape",
    });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "assistant_message",
        text: "new daemon shape",
        messageId: "msg-1",
      }),
    ).toEqual({
      type: "assistant_message",
      text: "new daemon shape",
      messageId: "msg-1",
    });
  });

  test("task progress fields are optional on the wire", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "todo",
        items: [{ text: "Legacy task", completed: false }],
      }),
    ).toEqual({ type: "todo", items: [{ text: "Legacy task", completed: false }] });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "todo",
        items: [
          {
            id: "task-1",
            text: "Current task",
            activeForm: "Working on current task",
            status: "in_progress",
            completed: false,
          },
        ],
      }),
    ).toEqual({
      type: "todo",
      items: [
        {
          id: "task-1",
          text: "Current task",
          activeForm: "Working on current task",
          status: "in_progress",
          completed: false,
        },
      ],
    });
  });

  test("a sub-agent launch marker still parses against the v0.1.65-beta.3 schema", () => {
    const card = {
      type: "tool_call",
      callId: "call-sub-agent-1",
      name: "Task",
      status: "completed",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "Explore",
        description: "Inspect repository structure",
        childSessionId: "child-session-1",
        log: "",
        actions: [],
      },
    } as const;

    const parsed = LegacySubAgentToolCallSchema.parse(JSON.parse(JSON.stringify(card)));
    expect(parsed.detail).toMatchObject({ log: "", actions: [] });
    const { log: _log, ...withoutLog } = card.detail;
    expect(LegacySubAgentToolCallSchema.safeParse({ ...card, detail: withoutLog }).success).toBe(
      false,
    );
    expect(AgentTimelineItemPayloadSchema.parse({ ...card, detail: withoutLog })).toMatchObject({
      detail: { type: "sub_agent", description: "Inspect repository structure" },
    });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        ...card,
        detail: { ...card.detail, log: "[Read] README.md" },
      }),
    ).toMatchObject({ detail: { log: "[Read] README.md" } });
  });

  test("old clients parse agent snapshots with rewind capabilities", () => {
    const parsed = LegacyAgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
        supportsRewindConversation: true,
        supportsRewindFiles: true,
        supportsRewindBoth: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    });

    expect(parsed.capabilities).toEqual({
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    });
  });

  test("new clients parse agent snapshots without rewind capabilities", () => {
    const parsed = AgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    });

    expect(parsed.capabilities.supportsRewindConversation).toBe(false);
    expect(parsed.capabilities.supportsRewindFiles).toBe(false);
    expect(parsed.capabilities.supportsRewindBoth).toBe(false);
  });

  test("notification timeline items parse their level and message", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "notification",
        level: "warning",
        message: "Command blocked by user",
      }),
    ).toEqual({
      type: "notification",
      level: "warning",
      message: "Command blocked by user",
    });
  });
});

test("0.8 timeline and setup capabilities remain optional in the hello", () => {
  const hello = { type: "hello", clientId: "compat", clientType: "mobile", protocolVersion: 1 };
  expect(WSHelloMessageSchema.safeParse(hello).success).toBe(true);
  expect(
    WSHelloMessageSchema.parse({
      ...hello,
      capabilities: { plugin_timeline_items: true, workspace_setup_blocked: true },
    }).capabilities,
  ).toEqual({ plugin_timeline_items: true, workspace_setup_blocked: true });
});

test("plugin rows and identity merges require a capable receiver", () => {
  const item = {
    type: "plugin",
    id: "task",
    pluginId: "tasks",
    kind: "tasks",
    version: 1,
    data: { text: "Working" },
  };
  expect(AgentTimelineItemPayloadSchema.parse(item)).toEqual(item);
  const legacyItems = z.object({
    type: z.enum([
      "user_message",
      "assistant_message",
      "reasoning",
      "tool_call",
      "todo",
      "error",
      "notification",
      "compaction",
    ]),
  });
  expect(legacyItems.safeParse(item).success).toBe(false);
  const entry = {
    provider: "codex",
    item,
    timestamp: "2026-09-07T00:00:00.000Z",
    seqStart: 1,
    seqEnd: 2,
    sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
    collapsed: ["identity"],
  };
  expect(AgentTimelineEntryPayloadSchema.parse(entry)).toEqual(entry);
  const legacyCollapsed = z.array(z.enum(["assistant_merge", "reasoning_merge", "tool_lifecycle"]));
  expect(legacyCollapsed.safeParse(entry.collapsed).success).toBe(false);
});

test("blocked setup preserves the legacy failed shape and optional provenance", () => {
  const snapshot = {
    status: "blocked",
    error: null,
    detail: {
      type: "worktree_setup",
      worktreePath: "/workspace",
      branchName: "fork",
      log: "",
      commands: [],
    },
    blockedSource: {
      kind: "change_request",
      forge: "github",
      number: 42,
      headRepository: "contributor/project",
    },
  };
  expect(WorkspaceSetupSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  const legacyStatus = z.enum(["running", "completed", "failed"]);
  const legacySnapshot = WorkspaceSetupSnapshotSchema.omit({ blockedSource: true }).extend({
    status: legacyStatus,
  });
  expect(legacySnapshot.safeParse(snapshot).success).toBe(false);
  const failed = { ...snapshot, status: "failed", error: "Update Paseo to review and run setup." };
  expect(legacySnapshot.safeParse(failed).success).toBe(true);
  const progress = {
    type: "workspace_setup_progress",
    payload: { ...failed, workspaceId: "workspace" },
  };
  expect(WorkspaceSetupProgressMessageSchema.parse(progress)).toEqual(progress);
  expect(WorkspaceSetupSnapshotSchema.parse(legacySnapshot.parse(failed))).toEqual(
    legacySnapshot.parse(failed),
  );
});

test("usage login errors are additive and older reports still parse", () => {
  const entry = {
    id: "codex:account",
    account: {},
    fetchedAt: "2026-10-05T00:00:00.000Z",
    sourceId: "codex",
    sourceLabel: "Codex",
    report: { status: "error", error: "Usage API returned 500" },
  };
  const legacy = z.object({
    type: z.literal("usage.list_reports.update"),
    payload: z.object({
      requestId: z.string(),
      report: z.object({
        id: z.string(),
        account: z.object({ label: z.string().optional() }),
        fetchedAt: z.string(),
        sourceId: z.string(),
        sourceLabel: z.string(),
        icon: z.string().optional(),
        report: z.discriminatedUnion("status", [
          z.object({ status: z.literal("available"), windows: z.array(z.unknown()) }),
          z.object({ status: z.literal("unavailable"), problem: z.unknown() }),
          z.object({ status: z.literal("error"), error: z.string() }),
        ]),
      }),
    }),
  });
  const oldMessage = {
    type: "usage.list_reports.update",
    payload: { requestId: "usage", report: entry },
  };
  const newMessage = {
    ...oldMessage,
    payload: {
      ...oldMessage.payload,
      report: {
        ...entry,
        loginErrors: [{ harness: "Codex", report: entry.report }],
      },
    },
  };
  expect(SessionOutboundMessageSchema.parse(oldMessage)).toEqual(oldMessage);
  expect(SessionOutboundMessageSchema.parse(newMessage)).toEqual(newMessage);
  expect(legacy.parse(newMessage)).toEqual(oldMessage);
});

test("usage entries accept older failures and additive successful snapshots", () => {
  const oldEntry = {
    id: "source:account",
    sourceId: "source",
    sourceLabel: "Source",
    account: {},
    fetchedAt: "2026-10-17T10:06:00Z",
    report: { status: "error", error: "Rate limited" },
  };
  expect(UsageReportEntrySchema.parse(oldEntry)).toEqual(oldEntry);
  const retained = {
    ...oldEntry,
    lastSuccessful: {
      fetchedAt: "2026-10-17T10:00:00Z",
      report: { status: "available", windows: [{ id: "weekly", label: "Weekly", usedPct: 42 }] },
    },
  };
  expect(UsageReportEntrySchema.parse(retained)).toEqual(retained);
  const available = {
    ...oldEntry,
    report: retained.lastSuccessful.report,
    successfulAt: "2026-10-17T10:00:15Z",
  };
  expect(UsageReportEntrySchema.parse(available)).toEqual(available);
  const hintedOff = { ...available, defaultEnabled: false };
  expect(UsageReportEntrySchema.parse(hintedOff)).toEqual(hintedOff);
  expect(UsageReportEntrySchema.omit({ defaultEnabled: true }).parse(hintedOff)).toEqual(available);
  expect(
    UsageReportEntrySchema.omit({ lastSuccessful: true, successfulAt: true }).parse(available),
  ).toEqual({ ...oldEntry, report: available.report });
  // An older client's entry shape strips the additive snapshot and still sees the failure.
  expect(UsageReportEntrySchema.omit({ lastSuccessful: true }).parse(retained)).toEqual(oldEntry);
  expect(
    UsageReportEntrySchema.safeParse({
      ...oldEntry,
      lastSuccessful: { fetchedAt: oldEntry.fetchedAt, report: oldEntry.report },
    }).success,
  ).toBe(false);
});

// Frozen setup detail shape from v0.8.0: log is required, command output is optional.
const ReleasedSetupDetailSchema = z.object({
  type: z.literal("worktree_setup"),
  worktreePath: z.string(),
  branchName: z.string(),
  log: z.string(),
  commands: z.array(
    z.object({
      index: z.number().int().positive(),
      command: z.string(),
      cwd: z.string(),
      log: z.string().optional().default(""),
      status: z.enum(["running", "completed", "failed"]),
      exitCode: z.number().nullable(),
      durationMs: z.number().nonnegative().optional(),
    }),
  ),
  truncated: z.boolean().optional(),
});

test("released setup clients parse empty combined logs and retain command output", () => {
  const detail = {
    type: "worktree_setup",
    worktreePath: "/workspace",
    branchName: "feature",
    log: "",
    commands: [
      {
        index: 1,
        command: "echo ready",
        cwd: "/workspace",
        log: "ready\n",
        status: "completed",
        exitCode: 0,
      },
    ],
  };
  const parsed = ReleasedSetupDetailSchema.parse(JSON.parse(JSON.stringify(detail)));
  expect(parsed).toEqual(detail);
  expect(parsed.commands[0]?.log).toBe("ready\n");
  const { log: _log, ...withoutLegacyField } = detail;
  expect(ReleasedSetupDetailSchema.safeParse(withoutLegacyField).success).toBe(false);
  expect(
    WorkspaceSetupSnapshotSchema.parse({
      status: "completed",
      detail: { ...detail, log: "old daemon combined output" },
      error: null,
    }).detail.log,
  ).toBe("old daemon combined output");
});

test("local STT language survives wire reads and patches", () => {
  const patch = {
    features: {
      dictation: { stt: { provider: "local", language: "fr" } },
      voiceMode: { stt: { provider: "local", language: null } },
    },
  };
  expect(MutableDaemonConfigPatchSchema.parse(patch)).toEqual(patch);
});

test("speech config reads remain compatible with clients before features and future providers", () => {
  const oldSchema = MutableDaemonConfigSchema.omit({ features: true, envOverrides: true });
  const oldRead = oldSchema.parse({
    providers: {},
    relay: { enabled: false },
    mcp: { enabled: true, injectIntoAgents: true },
  });
  const read = {
    ...oldRead,
    features: {
      dictation: { enabled: true, stt: { provider: "local", language: "fr" } },
      voiceMode: {
        enabled: false,
        stt: { provider: "future", model: "future-model", region: "eu" },
        tts: { provider: "openai", hasApiKey: false },
      },
    },
    envOverrides: { "features.voiceMode.stt.provider": "PASEO_VOICE_STT_PROVIDER" },
  };
  expect(oldSchema.parse(read)).toEqual(read);
  expect(MutableDaemonConfigSchema.parse(oldRead)).toEqual(oldRead);
  expect(MutableDaemonConfigSchema.parse(read).features?.dictation.stt).toEqual(
    read.features.dictation.stt,
  );
  expect(MutableDaemonConfigSchema.parse(read).features?.voiceMode.stt).toEqual(
    read.features.voiceMode.stt,
  );
  const oldPatchSchema = MutableDaemonConfigPatchSchema.omit({ features: true });
  const oldPatch = oldPatchSchema.parse({ relay: { enabled: true } });
  expect(MutableDaemonConfigPatchSchema.parse(oldPatch)).toEqual(oldPatch);
  expect(
    MutableDaemonConfigPatchSchema.parse({
      features: { voiceMode: { stt: { provider: "future", region: "eu" } } },
    }).features?.voiceMode?.stt,
  ).toEqual({ provider: "future", region: "eu" });
});

test("topic first question retries and idle creation receipts extend both wire directions", () => {
  const agent = {
    type: "agent.create.request",
    requestId: "agent-action",
    labels: {},
    config: { provider: "codex", cwd: "/tmp/topic" },
    workspaceRole: "main",
    idempotencyKey: "initial",
  };
  const workspace = {
    type: "workspace.create.request",
    requestId: "workspace-action",
    source: { kind: "directory", path: "/tmp/topic" },
    title: "Topic",
    topic: { summary: null, hideFromModel: false },
    idempotencyKey: "initial",
  };
  for (const request of [agent, workspace]) {
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    expect(SessionInboundMessageSchema.parse({ ...request, retryPromptRevision: 4 })).toEqual({
      ...request,
      retryPromptRevision: 4,
    });
    expect(
      SessionInboundMessageSchema.safeParse({ ...request, retryPromptRevision: -1 }).success,
    ).toBe(false);
  }
  expect(
    AgentCreateRequestSchema.omit({ retryPromptRevision: true }).parse({
      ...agent,
      retryPromptRevision: 4,
    }),
  ).toEqual(agent);
  expect(
    WorkspaceCreateRequestSchema.omit({ retryPromptRevision: true }).parse({
      ...workspace,
      retryPromptRevision: 4,
    }),
  ).toEqual(workspace);
  const receipt = {
    kind: "workspace",
    phase: "accepted",
    idempotencyKey: "initial",
    revision: 0,
    error: null,
    workspaceId: "wks_1234567890abcdef",
    agentId: null,
  };
  const idle = { ...receipt, canResume: true };
  expect(CreationSnapshotSchema.parse(receipt)).toEqual(receipt);
  expect(CreationSnapshotSchema.parse(idle)).toEqual(idle);
  expect(CreationSnapshotSchema.omit({ canResume: true }).parse(idle)).toEqual(receipt);
  const priorHost = {
    status: "server_info",
    serverId: "old",
    features: { topicWorkbenchV1: true },
  };
  expect(
    ServerInfoStatusPayloadSchema.parse(priorHost).features?.topicPromptRetryV1,
  ).toBeUndefined();
  expect(
    ServerInfoStatusPayloadSchema.parse({
      ...priorHost,
      features: { ...priorHost.features, topicPromptRetryV1: true },
    }).features?.topicPromptRetryV1,
  ).toBe(true);
});

describe("provider metrics", () => {
  const metrics = [
    { label: "Model", value: "gpt-5.5" },
    { label: "Cache", value: "82%", tone: "ok" },
  ];
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/project",
    model: null,
    thinkingOptionId: null,
    effectiveThinkingOptionId: null,
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    labels: {},
  };
  const turnCompleted = { type: "turn_completed", provider: "codex", turnId: "turn-1" };
  const entry = {
    provider: "codex",
    item: { type: "assistant_message", text: "Done" },
    timestamp: "2026-11-22T00:00:00.000Z",
    seqStart: 1,
    seqEnd: 1,
    sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    collapsed: [],
  };

  test("new apps read session, turn and timeline metrics from a new daemon", () => {
    expect(
      AgentSnapshotPayloadSchema.parse({ ...snapshot, sessionMetrics: metrics }).sessionMetrics,
    ).toEqual(metrics);
    expect(AgentStreamEventPayloadSchema.parse({ ...turnCompleted, metrics })).toEqual({
      ...turnCompleted,
      metrics,
    });
    expect(AgentTimelineEntryPayloadSchema.parse({ ...entry, turnMetrics: metrics })).toEqual({
      ...entry,
      turnMetrics: metrics,
    });
  });

  test("new apps accept payloads from daemons that send no metrics", () => {
    expect(AgentSnapshotPayloadSchema.parse(snapshot).sessionMetrics).toBeUndefined();
    expect(AgentStreamEventPayloadSchema.parse(turnCompleted)).toEqual(turnCompleted);
    expect(AgentTimelineEntryPayloadSchema.parse(entry)).toEqual(entry);
  });

  test("apps released before metrics drop the fields they do not know", () => {
    const legacySnapshot = AgentSnapshotPayloadSchema.omit({ sessionMetrics: true });
    const legacyTurnCompleted = z.object({
      type: z.literal("turn_completed"),
      provider: z.string(),
      turnId: z.string().optional(),
    });
    const legacyEntry = AgentTimelineEntryPayloadSchema.omit({ turnMetrics: true });

    expect(legacySnapshot.parse({ ...snapshot, sessionMetrics: metrics })).not.toHaveProperty(
      "sessionMetrics",
    );
    expect(legacyTurnCompleted.parse({ ...turnCompleted, metrics })).toEqual(turnCompleted);
    expect(legacyEntry.parse({ ...entry, turnMetrics: metrics })).toEqual(entry);
  });

  test("metric tone is a closed set, so a new tone needs a capability gate", () => {
    expect(
      AgentTimelineEntryPayloadSchema.safeParse({
        ...entry,
        turnMetrics: [{ label: "Cache", value: "82%", tone: "sparkly" }],
      }).success,
    ).toBe(false);
  });
});
