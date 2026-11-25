import { describe, expect, it, vi } from "vitest";
import type { CreationSnapshot } from "@getpaseo/protocol/messages";
import { slugify } from "@getpaseo/protocol/branch-slug";
import { WORKSPACE_MAIN_ROLE, WORKSPACE_ROLE_LABEL } from "@getpaseo/protocol/agent-labels";
import {
  prepareWorkspaceMainBatch,
  resolveBatchModelConfig,
  runWorkspaceMainBatch,
  workspaceBatchBlock,
  workspaceMainBatchAgentTarget,
} from "./main-batch";
import {
  readTopicFields,
  runTopicCreation,
  topicRequest,
  type TopicCreationClient,
} from "./topic-creation";
import { watchTopicCreation } from "@/composer/draft/topic-receipts";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  readMainDraft,
  subscribeToMainDraftBatch,
  writeMainDraft,
  type MainDraftBatch,
} from "./main-draft";

const target = {
  serverId: "host",
  projectId: "repo",
  sourceDirectory: "/repo",
  directory: "/repo",
  isolation: "worktree" as const,
};
const models = ["codex", "claude", "pi", "muse"].map((provider) => ({
  provider,
  providerLabel: provider,
  modelId: "default",
  modelLabel: "Default",
}));
const message = {
  initialPrompt: "Review this change",
  images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
  attachments: [{ type: "text" as const, mimeType: "text/plain" as const, text: "Same context" }],
};
const startPoint = { commitSha: "a".repeat(40), refName: "refs/heads/main" };
const placement = {
  source: {
    kind: "worktree" as const,
    action: "branch-off" as const,
    cwd: "/repo",
    projectId: "repo",
    branchName: "feature/Fix checkout",
    worktreeSlug: "a-very-long-worktree-name-that-the-daemon-must-not-truncate",
  },
};

async function plan(resolveStartPoint = vi.fn().mockResolvedValue(startPoint)) {
  return prepareWorkspaceMainBatch({
    placement,
    models,
    message,
    resolveConfig: (model) => ({ provider: model.provider, cwd: "/repo", model: model.modelId }),
    resolveStartPoint,
    invalidSourceMessage: "Unsupported worktree source",
    invalidSelectionMessage: "Select two to four distinct models",
  });
}

type BatchClient = Parameters<typeof runWorkspaceMainBatch>[0]["client"];
type WorkspaceRequest = Parameters<BatchClient["createWorkspace"]>[0];
type WorkspaceResponse = Awaited<ReturnType<BatchClient["createWorkspace"]>>;

function emptyTimeline(agentId: string): Awaited<ReturnType<BatchClient["fetchAgentTimeline"]>> {
  return {
    requestId: "timeline",
    agentId,
    agent: null,
    direction: "tail",
    projection: "canonical",
    epoch: "epoch",
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
    startCursor: null,
    endCursor: null,
    hasOlder: false,
    hasNewer: false,
    entries: [],
    error: null,
  };
}

function workspace(id: string): NonNullable<WorkspaceResponse["workspace"]> {
  return {
    id,
    workspaceDirectory: `/worktrees/${id}`,
  } as NonNullable<WorkspaceResponse["workspace"]>;
}

function agent(id: string, workspaceId: string): NonNullable<WorkspaceResponse["agent"]> {
  return {
    id,
    workspaceId,
    provider: "codex",
    cwd: `/worktrees/${workspaceId}`,
    model: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
      supportsRewindConversation: false,
      supportsRewindFiles: false,
      supportsRewindBoth: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
  };
}

function successful(request: WorkspaceRequest): WorkspaceResponse {
  return {
    workspace: workspace(request.workspaceId!),
    agent: agent(request.agent!.agentId!, request.workspaceId!),
    setupTerminalId: null,
    requestId: "response",
    error: null,
    creation: receiptFor(request, { phase: "prompt_started" }),
  };
}

function receiptFor(
  request: WorkspaceRequest,
  fields: Partial<CreationSnapshot>,
): CreationSnapshot {
  return {
    kind: "workspace",
    idempotencyKey: request.idempotencyKey!,
    revision: 2,
    phase: "accepted",
    workspaceId: request.workspaceId!,
    agentId: request.agent!.agentId!,
    error: null,
    ...fields,
  };
}

function findBatchItem(batch: MainDraftBatch, workspaceId?: string) {
  return batch.items.find((item) => item.workspaceId === workspaceId);
}

async function harness(initial: MainDraftBatch) {
  const id = crypto.randomUUID();
  const createWorkspace = vi
    .fn<BatchClient["createWorkspace"]>()
    .mockImplementation(async (request) => successful(request));
  const createAgent = vi.fn<BatchClient["createAgent"]>();
  const findWorkspace = vi.fn<BatchClient["findWorkspace"]>().mockResolvedValue(null);
  const fetchAgent = vi.fn<BatchClient["fetchAgent"]>().mockResolvedValue(null);
  const getCreationSnapshot = vi.fn<BatchClient["getCreationSnapshot"]>().mockResolvedValue(null);
  const fetchAgentTimeline = vi.fn<BatchClient["fetchAgentTimeline"]>();
  const acceptSnapshots = vi.fn<Parameters<typeof runWorkspaceMainBatch>[0]["acceptSnapshots"]>();
  const assertSupported = vi.fn();
  const save = (batch: MainDraftBatch) => writeMainDraft(id, { target, batch });
  await save(initial);
  const read = async () => (await readMainDraft(id))!.batch!;
  const run = async (
    action: Parameters<typeof runWorkspaceMainBatch>[0]["action"] = { kind: "resume" },
  ) =>
    runWorkspaceMainBatch({
      batch: await read(),
      action,
      client: {
        createWorkspace,
        createAgent,
        findWorkspace,
        fetchAgent,
        getCreationSnapshot,
        fetchAgentTimeline,
        supportsTopicPromptRetry: () => true,
      },
      save,
      acceptSnapshots,
      assertSupported,
      failedMessage: "Create failed",
    });
  return {
    id,
    run,
    read,
    createWorkspace,
    createAgent,
    findWorkspace,
    fetchAgent,
    fetchAgentTimeline,
    getCreationSnapshot,
    acceptSnapshots,
    assertSupported,
  };
}

describe("multi-model workspace creation", () => {
  it("creates one silent topic per selected model from the same fixed start point", async () => {
    const batch = await plan();
    const topic = { summary: "Inspect cold start", hideFromModel: true };
    const h = await harness({
      message: { initialPrompt: "  ", attachments: [] },
      items: batch.items
        .slice(0, 2)
        .map((item) =>
          Object.assign({}, item, { placement: { ...item.placement, title: "Cold start", topic } }),
        ),
    });
    h.createWorkspace.mockImplementation(async (request) => {
      const workspaceId = request.workspaceId!;
      const mainAgent = agent(`quiet-${workspaceId}`, workspaceId);
      const snapshot = {
        ...workspace(workspaceId),
        topic: { ...topic, revision: 1, mainAgentId: mainAgent.id },
      };
      return {
        workspace: snapshot,
        mainAgent,
        error: null,
        requestId: workspaceId,
        setupTerminalId: null,
        creation: {
          kind: "workspace",
          idempotencyKey: request.idempotencyKey!,
          workspaceId,
          agentId: null,
          phase: "completed",
          revision: 3,
          error: null,
        },
      };
    });
    await h.run();
    const requests = h.createWorkspace.mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(2);
    expect(
      new Set(requests.map(({ source }) => source.kind === "worktree" && source.worktreeSlug)).size,
    ).toBe(2);
    for (const [index, request] of requests.entries()) {
      expect(request).toMatchObject({
        title: "Cold start",
        topic,
        mainAgent: { config: { provider: models[index]!.provider } },
        source: { startPoint: startPoint.commitSha },
      });
      expect(request.agent).toBeUndefined();
      expect(request.firstAgentContext).toBeUndefined();
    }
    const items = (await h.read()).items;
    expect(items.map(({ stage }) => stage)).toEqual(["succeeded", "succeeded"]);
    for (const item of items) {
      expect(workspaceMainBatchAgentTarget(target.serverId, item)).toMatchObject({
        workspaceId: item.workspaceId,
        target: { kind: "agent", agentId: `quiet-${item.workspaceId}` },
      });
    }
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it("sends a blank-text question with attachments in each model's original create request", async () => {
    const batch = await plan();
    const topic = { summary: null, hideFromModel: false };
    const images = [{ data: "YWJj", mimeType: "image/png" }];
    const h = await harness({
      message: { initialPrompt: "", images, attachments: message.attachments },
      items: batch.items.slice(0, 2).map((item) =>
        Object.assign({}, item, {
          placement: { ...item.placement, title: "Attachments", topic },
        }),
      ),
    });
    h.createWorkspace.mockImplementation(async (request) => {
      const response = successful(request);
      return {
        ...response,
        workspace: {
          ...workspace(request.workspaceId!),
          topic: { ...topic, revision: 1, mainAgentId: request.agent!.agentId! },
        },
      };
    });
    await h.run();
    expect(h.createWorkspace).toHaveBeenCalledTimes(2);
    for (const [index, [request]] of h.createWorkspace.mock.calls.entries()) {
      const item = batch.items[index]!;
      expect(request.mainAgent).toBeUndefined();
      expect(request.agent).toMatchObject({
        workspaceRole: "main",
        agentId: item.agentId,
        clientMessageId: item.clientMessageId,
        initialPrompt: "",
        images,
        attachments: message.attachments,
      });
    }
    expect((await h.read()).items.map(({ stage }) => stage)).toEqual(["succeeded", "succeeded"]);
  });

  it.each(["missing", "workspace_ready", "read-failed", "occupied", "unknown"] as const)(
    "keeps observation read-only and only retries the original request when recovery is safe (%s)",
    async (state) => {
      const topic = { summary: null, hideFromModel: false };
      const request = topicRequest(
        { ...placement, title: "Recovery", topic },
        { workspaceId: "wks_1234567890abcdef", idempotencyKey: "frozen-topic" },
        { config: { provider: "codex", cwd: "/repo" } },
      );
      const unbound = {
        ...workspace(request.workspaceId),
        hasActiveMainAgent: false,
        topic: { ...topic, revision: 1, mainAgentId: null },
      };
      const receipt = {
        kind: "workspace",
        idempotencyKey: request.idempotencyKey,
        revision: 2,
        workspaceId: request.workspaceId,
        agentId: null,
        workspace: unbound,
        phase: "workspace_ready",
        error: null,
      } as const;
      const main = agent("existing-main", request.workspaceId);
      const completed = { ...unbound, topic: { ...unbound.topic, mainAgentId: main.id } };
      const client: TopicCreationClient = {
        getCreationSnapshot: vi.fn<TopicCreationClient["getCreationSnapshot"]>(async () => {
          if (state === "read-failed") throw new Error("Receipt read failed");
          if (state === "missing") return null;
          if (state === "unknown")
            return { ...receipt, phase: "failed", failedStage: "agent", outcomeUnknown: true };
          return receipt;
        }),
        findWorkspace: vi.fn(async () => {
          if (state === "missing" || state === "read-failed") return null;
          if (state === "occupied") return { ...completed, hasActiveMainAgent: true };
          return unbound;
        }),
        fetchAgent: vi.fn(async () => null),
        fetchAgentTimeline: vi.fn(),
        createWorkspace: vi.fn<TopicCreationClient["createWorkspace"]>(async () => ({
          requestId: "reply",
          setupTerminalId: null,
          workspace: completed,
          mainAgent: main,
          error: null,
          creation: { ...receipt, phase: "completed" },
        })),
      };
      const retryable = state === "missing" || state === "workspace_ready";
      expect((await runTopicCreation(client, request, "check")).stage).toBe(
        retryable ? "retryable" : "unconfirmed",
      );
      expect(client.createWorkspace).not.toHaveBeenCalled();
      expect((await runTopicCreation(client, request, "retry")).stage).toBe(
        retryable ? "succeeded" : "unconfirmed",
      );
      if (retryable) expect(client.createWorkspace).toHaveBeenCalledExactlyOnceWith(request);
      else expect(client.createWorkspace).not.toHaveBeenCalled();
    },
  );

  it("checks delivery against the original topic and message attempt without replaying the prompt", async () => {
    const fields = readTopicFields("\n  Cold start\n  Inspect traces.  ", "", true);
    expect(fields).toEqual({
      title: "Cold start",
      topic: { summary: "\n  Cold start\n  Inspect traces.  ", hideFromModel: true },
    });
    const { source } = placement;
    expect(readTopicFields("  \n ", "Direction alone", false)).toBeNull();
    expect(readTopicFields("X".repeat(100), " Explicit direction ", false)).toEqual({
      title: "X".repeat(80),
      topic: { summary: " Explicit direction ", hideFromModel: false },
    });
    const identity = { workspaceId: "wks_1234567890abcdef", idempotencyKey: "topic-draft" };
    const base = { ...fields!, source };
    expect(topicRequest(base, identity, null)).toEqual({ ...base, ...identity });
    const request = topicRequest(base, identity, {
      config: { provider: "codex", cwd: "/repo" },
      prompt: {
        agentId: "expected-agent",
        clientMessageId: "initial-message",
        initialPrompt: "Where should we start?",
      },
    });
    expect(request.mainAgent).toBeUndefined();
    expect(request.agent).toMatchObject({
      workspaceRole: "main",
      clientMessageId: "initial-message",
    });
    const created = {
      ...workspace(request.workspaceId),
      topic: { ...fields!.topic, revision: 1, mainAgentId: "expected-agent" },
    };
    const main = agent("expected-agent", request.workspaceId);
    const receipt = receiptFor(request, {
      phase: "failed",
      failedStage: "prompt",
      outcomeUnknown: true,
      workspace: created,
      agent: main,
    });
    const client = {
      createWorkspace: vi
        .fn<BatchClient["createWorkspace"]>()
        .mockRejectedValue(new Error("Connection lost")),
      getCreationSnapshot: vi.fn<BatchClient["getCreationSnapshot"]>().mockResolvedValue(receipt),
      findWorkspace: vi.fn<BatchClient["findWorkspace"]>().mockResolvedValue(created),
      fetchAgent: vi.fn().mockResolvedValue(null),
      fetchAgentTimeline: vi.fn<BatchClient["fetchAgentTimeline"]>(),
    };
    expect((await runTopicCreation(client, request, "submit")).stage).toBe("unconfirmed");
    expect((await runTopicCreation(client, request, "retry")).stage).toBe("unconfirmed");
    const expected = {
      stage: "succeeded",
      workspace: created,
      agent: main,
    };
    const listened = Promise.withResolvers<Awaited<ReturnType<typeof runTopicCreation>>>();
    const checkedOnce = Promise.withResolvers<void>();
    let onMessage: Parameters<DaemonClient["subscribeRawMessages"]>[0] = () => undefined;
    const unsubscribe = vi.fn();
    const watchClient = {
      subscribeRawMessages: vi.fn<DaemonClient["subscribeRawMessages"]>((handler) => {
        onMessage = handler;
        return unsubscribe;
      }),
    };
    const stop = watchTopicCreation(watchClient, receipt, async (update) => {
      const outcome = await runTopicCreation(client, request, "check", update);
      checkedOnce.resolve();
      if (outcome.stage !== "succeeded") return false;
      listened.resolve(outcome);
      return true;
    });
    try {
      await checkedOnce.promise;
      onMessage({
        type: "workspace.create.update",
        payload: { ...receipt, idempotencyKey: "different-key", revision: receipt.revision + 1 },
      });
      // The timeline can show a refused attempt. Only a later acceptance receipt settles it.
      client.fetchAgentTimeline.mockResolvedValue({
        agentId: main.id,
        error: null,
        entries: [
          {
            item: { type: "user_message", clientMessageId: request.agent?.clientMessageId },
          },
        ],
      } as Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>);
      onMessage({
        type: "workspace.create.update",
        payload: {
          ...receipt,
          revision: receipt.revision + 1,
          phase: "completed",
          initialPromptStarted: true,
          outcomeUnknown: undefined,
          failedStage: undefined,
          error: null,
        },
      });
      expect(await listened.promise).toEqual(expected);
      await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    } finally {
      stop();
    }
    expect(client.getCreationSnapshot).toHaveBeenLastCalledWith(
      "workspace",
      identity.idempotencyKey,
    );
    expect(client.createWorkspace).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("persists four independent requests with identical serialized input and resolves one base", async () => {
    const resolveStartPoint = vi.fn().mockResolvedValue(startPoint);
    const h = await harness(await plan(resolveStartPoint));
    const observeBatch = vi.fn();
    const unsubscribe = subscribeToMainDraftBatch(h.id, observeBatch);
    expect(resolveStartPoint).toHaveBeenCalledExactlyOnceWith({
      cwd: "/repo",
      projectId: "repo",
      refName: undefined,
    });
    h.createWorkspace.mockImplementation(async (request) => {
      const saved = findBatchItem(await h.read(), request.workspaceId);
      expect(saved).toMatchObject({
        stage: "sending",
        agentId: request.idempotencyKey,
        placement: { source: request.source },
      });
      return successful(request);
    });
    await h.run();
    const requests = h.createWorkspace.mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(4);
    expect(new Set(requests.map((request) => request.workspaceId)).size).toBe(4);
    expect(new Set(requests.map((request) => request.idempotencyKey)).size).toBe(4);
    expect(new Set(requests.map((request) => request.agent?.clientMessageId)).size).toBe(4);
    const items = (await h.read()).items;
    expect(observeBatch).toHaveBeenLastCalledWith({ target, batch: { message, items } });
    unsubscribe();
    expect(new Set(items.map((item) => item.placement.source.branchName)).size).toBe(4);
    expect(new Set(items.map((item) => item.placement.source.worktreeSlug)).size).toBe(4);
    expect(items.map((item) => slugify(item.placement.source.worktreeSlug))).toEqual(
      items.map((item) => item.placement.source.worktreeSlug),
    );
    for (const [index, request] of requests.entries()) {
      expect(request.source).toMatchObject({
        action: "branch-off",
        refName: startPoint.refName,
        startPoint: startPoint.commitSha,
        branchName: expect.stringMatching(/^feature\/fix-checkout-[a-f0-9]{16}$/),
      });
      expect(request.agent).toMatchObject({
        ...message,
        config: { provider: models[index]!.provider },
        workspaceRole: "main",
      });
      expect(request.agent).not.toHaveProperty("callerAgentId");
      expect(workspaceMainBatchAgentTarget(target.serverId, items[index]!)).toEqual({
        serverId: "host",
        workspaceId: request.workspaceId,
        target: { kind: "agent", agentId: request.agent!.agentId },
      });
    }
    expect(h.acceptSnapshots).toHaveBeenCalledTimes(4);
    await h.run();
    expect(h.createWorkspace).toHaveBeenCalledTimes(4);
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it("recovers confirmed sends and retries only the missing agent inside its original worktree", async () => {
    const h = await harness(await plan());
    const receipts = new Map<string, CreationSnapshot>();
    const workspaces = new Map<string, NonNullable<WorkspaceResponse["workspace"]>>();
    const agents = new Map<string, NonNullable<WorkspaceResponse["agent"]>>();
    h.getCreationSnapshot.mockImplementation(async (_kind, key) => receipts.get(key) ?? null);
    h.findWorkspace.mockImplementation(async (id) => workspaces.get(id) ?? null);
    h.fetchAgent.mockImplementation(async (id) => {
      const found = agents.get(id);
      return found ? { agent: found, project: null } : null;
    });
    h.createWorkspace
      .mockImplementationOnce(async (request) => {
        const result = successful(request);
        workspaces.set(request.workspaceId!, result.workspace!);
        receipts.set(
          request.idempotencyKey!,
          receiptFor(request, {
            phase: "failed",
            failedStage: "agent",
            outcomeUnknown: false,
            workspace: result.workspace!,
          }),
        );
        throw new Error("Failed before the first message");
      })
      .mockImplementationOnce(async (request) => {
        const result = successful(request);
        workspaces.set(request.workspaceId!, result.workspace!);
        agents.set(request.agent!.agentId!, result.agent!);
        throw new Error("Connection lost");
      })
      .mockImplementationOnce(async () => {
        throw new Error("No receipt");
      });
    await h.run();
    const [failed, lost, unknown, completed] = (await h.read()).items;
    expect([failed!.stage, lost!.stage, unknown!.stage, completed!.stage]).toEqual([
      "retryable",
      "unconfirmed",
      "unconfirmed",
      "succeeded",
    ]);
    const lostRequest = h.createWorkspace.mock.calls[1]![0];
    expect(lost).toMatchObject({ agentReady: true });
    receipts.set(lost!.agentId, receiptFor(lostRequest, { phase: "prompt_started" }));
    await h.run();
    expect((await h.read()).items.map(({ stage }) => stage)).toEqual([
      "retryable",
      "succeeded",
      "unconfirmed",
      "succeeded",
    ]);
    expect(h.getCreationSnapshot).toHaveBeenCalledWith("workspace", lost!.agentId);
    expect(workspaceMainBatchAgentTarget(target.serverId, unknown!)).toBeNull();
    h.createAgent.mockImplementation(async (request) => {
      const result = agent(request.agentId!, request.workspaceId!);
      request.onEvent?.({
        kind: "agent",
        idempotencyKey: request.idempotencyKey!,
        agentId: result.id,
        workspaceId: result.workspaceId!,
        phase: "prompt_started",
        revision: 2,
        error: null,
      });
      return result;
    });
    await h.run({ kind: "retry", workspaceId: failed!.workspaceId });
    expect(h.createAgent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...message,
        idempotencyKey: failed!.recoveryAgentId,
        agentId: failed!.recoveryAgentId,
        workspaceId: failed!.workspaceId,
        clientMessageId: failed!.clientMessageId,
        config: expect.objectContaining({ cwd: `/worktrees/${failed!.workspaceId}` }),
      }),
    );
    expect(
      workspaceMainBatchAgentTarget(target.serverId, (await h.read()).items[0]!),
    ).toMatchObject({
      workspaceId: failed!.workspaceId,
      target: { agentId: failed!.recoveryAgentId },
    });
    await h.run({ kind: "retry", workspaceId: unknown!.workspaceId });
    expect(h.createWorkspace).toHaveBeenCalledTimes(4);
    expect(h.createAgent).toHaveBeenCalledTimes(1);
  });

  it("replays a confirmed pre-provision rejection with the same workspace request", async () => {
    const h = await harness(await plan());
    h.createWorkspace.mockImplementationOnce(async (request) => {
      h.getCreationSnapshot.mockResolvedValue(
        receiptFor(request, {
          phase: "failed",
          outcomeUnknown: false,
          failedStage: "workspace",
        }),
      );
      throw new Error("Directory not found");
    });
    await h.run();
    const first = (await h.read()).items[0]!;
    expect(first.stage).toBe("retryable");
    await h.run({ kind: "retry", workspaceId: first.workspaceId });
    const withoutObserver = ({ onEvent: _, ...request }: WorkspaceRequest) => request;
    expect(withoutObserver(h.createWorkspace.mock.calls.at(-1)![0])).toEqual(
      withoutObserver(h.createWorkspace.mock.calls[0]![0]),
    );
  });

  it("keeps an agent accessible when creation completed without proof of the first send", async () => {
    const h = await harness(await plan());
    h.createWorkspace.mockImplementationOnce(async (request) => ({
      ...successful(request),
      creation: receiptFor(request, { phase: "completed" }),
    }));
    await h.run();
    const item = (await h.read()).items[0]!;
    expect(item).toMatchObject({ stage: "unconfirmed", agentReady: true });
    expect(workspaceMainBatchAgentTarget(target.serverId, item)).toMatchObject({
      workspaceId: item.workspaceId,
      target: { agentId: item.agentId },
    });
    await h.run({ kind: "retry", workspaceId: item.workspaceId });
    expect(h.createWorkspace).toHaveBeenCalledTimes(4);
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it("checks the original key after a lost response and accepts a durable send marker", async () => {
    const h = await harness(await plan());
    const batch = await h.read();
    h.createWorkspace.mockRejectedValueOnce(new Error("Connection lost"));
    await h.run();
    const firstRequest = h.createWorkspace.mock.calls[0]![0];
    const result = successful(firstRequest);
    h.findWorkspace.mockResolvedValue(result.workspace);
    h.fetchAgent.mockResolvedValue({ agent: result.agent!, project: null });
    h.getCreationSnapshot.mockResolvedValue(
      receiptFor(firstRequest, { phase: "completed", initialPromptStarted: true }),
    );
    await h.run({ kind: "check", workspaceId: batch.items[0]!.workspaceId });
    expect((await h.read()).items[0]!.stage).toBe("succeeded");
    expect(h.getCreationSnapshot).toHaveBeenLastCalledWith(
      "workspace",
      firstRequest.idempotencyKey,
    );
    expect(h.createWorkspace).toHaveBeenCalledTimes(4);
  });

  it.each(["rejected", "receipt-unavailable", "rebound", "old-host"] as const)(
    "offers single topic retry only for a known rejection with the same Main Session (%s)",
    async (state) => {
      const topic = { summary: null, hideFromModel: false };
      const request = topicRequest(
        { ...placement, title: "Topic", topic },
        { workspaceId: "wks_1234567890abcdef", idempotencyKey: "original-topic" },
        {
          config: { provider: "codex", cwd: "/repo" },
          prompt: {
            ...message,
            agentId: "main",
            clientMessageId: "original-first-question",
          },
        },
      );
      const result = successful(request);
      const current = {
        ...result.workspace!,
        topic: { ...topic, revision: 1, mainAgentId: state === "rebound" ? "replacement" : "main" },
        hasActiveMainAgent: true,
      };
      const receipt = receiptFor(request, {
        phase: "failed",
        failedStage: "prompt",
        outcomeUnknown: false,
        workspace: current,
        agent: result.agent,
      });
      const client = {
        createWorkspace: vi
          .fn<BatchClient["createWorkspace"]>()
          .mockResolvedValue({ ...result, workspace: current }),
        getCreationSnapshot: vi.fn<BatchClient["getCreationSnapshot"]>().mockResolvedValue(receipt),
        findWorkspace: vi.fn<BatchClient["findWorkspace"]>().mockResolvedValue(current),
        fetchAgent: vi.fn<BatchClient["fetchAgent"]>(),
        supportsTopicPromptRetry: () => state !== "old-host",
        fetchAgentTimeline: vi.fn<BatchClient["fetchAgentTimeline"]>().mockResolvedValue({
          ...emptyTimeline("main"),
          entries: [{ item: { type: "user_message", clientMessageId: "original-first-question" } }],
        } as Awaited<ReturnType<BatchClient["fetchAgentTimeline"]>>),
      };
      if (state === "receipt-unavailable") {
        client.getCreationSnapshot.mockRejectedValue(new Error("Receipt unavailable"));
      }
      const retryable = state === "rejected";
      const checked = await runTopicCreation(client, request, "check", receipt);
      if (state === "old-host") expect(checked).toMatchObject({ updateHost: true });
      expect(checked.stage).toBe(retryable ? "retryable" : "unconfirmed");
      expect(client.createWorkspace).not.toHaveBeenCalled();
      expect((await runTopicCreation(client, request, "retry", receipt)).stage).toBe(
        retryable ? "succeeded" : "unconfirmed",
      );
      if (retryable)
        expect(client.createWorkspace).toHaveBeenCalledExactlyOnceWith({
          ...request,
          retryPromptRevision: receipt.revision,
        });
      else expect(client.createWorkspace).not.toHaveBeenCalled();
    },
  );

  it("retries a rejected topic batch question with its frozen request and existing Main Session", async () => {
    const batch = await plan();
    const topic = { summary: null, hideFromModel: false };
    batch.items = batch.items.map((item) => ({
      ...item,
      placement: { ...item.placement, title: "Batch topic", topic },
    }));
    const h = await harness(batch);
    h.createWorkspace.mockImplementationOnce(async (request) => {
      const result = successful(request);
      const created = {
        ...result.workspace!,
        topic: { ...topic, ...request.topic, revision: 1, mainAgentId: result.agent!.id },
        hasActiveMainAgent: true,
      };
      const receipt = receiptFor(request, {
        workspace: created,
        agent: result.agent,
        phase: "failed",
        failedStage: "prompt",
        outcomeUnknown: false,
        error: "First question was rejected",
      });
      h.getCreationSnapshot.mockResolvedValue(receipt);
      h.findWorkspace.mockResolvedValue(created);
      h.fetchAgentTimeline.mockResolvedValue(emptyTimeline(result.agent!.id));
      return { ...result, workspace: created, creation: receipt, error: receipt.error };
    });
    await h.run();
    const original = h.createWorkspace.mock.calls[0]![0];
    const itemId = original.workspaceId!;
    expect(findBatchItem(await h.read(), itemId)?.stage).toBe("retryable");
    await h.run({ kind: "check", workspaceId: itemId });
    expect(h.createWorkspace).toHaveBeenCalledTimes(4);
    h.createWorkspace.mockImplementationOnce(async (request) => {
      const result = successful(request);
      return {
        ...result,
        workspace: {
          ...result.workspace!,
          topic: { ...topic, ...request.topic, revision: 1, mainAgentId: result.agent!.id },
        },
      };
    });
    await h.run({ kind: "retry", workspaceId: itemId });
    expect(h.createWorkspace).toHaveBeenCalledTimes(5);
    expect(h.createWorkspace.mock.calls[4]![0]).toEqual({ ...original, retryPromptRevision: 2 });
    expect(findBatchItem(await h.read(), itemId)?.stage).toBe("succeeded");
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it("ignores a confirmation for another workspace without retrying the first prompt", async () => {
    const h = await harness(await plan());
    h.createWorkspace.mockRejectedValueOnce(new Error("Connection lost"));
    await h.run();
    const request = h.createWorkspace.mock.calls[0]![0];
    const result = successful(request);
    h.findWorkspace.mockResolvedValue(result.workspace);
    h.fetchAgent.mockResolvedValue({ agent: result.agent!, project: null });
    h.getCreationSnapshot.mockResolvedValue(
      receiptFor(request, {
        phase: "completed",
        initialPromptStarted: true,
        workspaceId: "wks_0000000000000000",
      }),
    );
    await h.run({ kind: "retry", workspaceId: request.workspaceId! });
    const item = (await h.read()).items[0]!;
    expect(item.stage).toBe("unconfirmed");
    expect(workspaceMainBatchAgentTarget(target.serverId, item)).toBeNull();
    expect(h.createWorkspace).toHaveBeenCalledTimes(4);
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it("keeps the batch when another view writes its stale single-model selection", async () => {
    const batch = await plan();
    const h = await harness(batch);
    const observeBatch = vi.fn();
    const unsubscribe = subscribeToMainDraftBatch(h.id, observeBatch);
    try {
      await writeMainDraft(h.id, { target, models: [models[0]!] });
      await writeMainDraft(h.id, null);
      expect(await h.read()).toEqual(batch);
      expect(observeBatch).toHaveBeenLastCalledWith({ target, batch });
      await h.run();
      await writeMainDraft(h.id, null, { finishBatch: true });
      expect(await readMainDraft(h.id)).toBeNull();
      expect(observeBatch).toHaveBeenLastCalledWith(null);
    } finally {
      unsubscribe();
    }
  });

  it("uses the resolved full branch name even when the user picks a short name", async () => {
    const batch = await prepareWorkspaceMainBatch({
      placement: { source: { ...placement.source, refName: "main" } },
      models: models.slice(0, 2),
      message,
      resolveConfig: (model) => ({ provider: model.provider, cwd: "/repo", model: model.modelId }),
      resolveStartPoint: async () => ({ ...startPoint, refName: "refs/remotes/origin/main" }),
      invalidSourceMessage: "Unsupported worktree source",
      invalidSelectionMessage: "Select two to four distinct models",
    });
    expect(batch.items.map((item) => item.placement.source.refName)).toEqual([
      "refs/remotes/origin/main",
      "refs/remotes/origin/main",
    ]);
  });

  it("rejects an unsupported host before issuing any write", async () => {
    const h = await harness(await plan());
    h.assertSupported.mockImplementation(() => {
      throw new Error("Update host");
    });
    await expect(h.run()).rejects.toThrow("Update host");
    expect((await h.read()).items.map(({ stage }) => stage)).toEqual(Array(4).fill("queued"));
    expect(h.createWorkspace).not.toHaveBeenCalled();
    expect(h.createAgent).not.toHaveBeenCalled();
  });
});

it("uses another provider's own mode and effort without carrying over provider options", () => {
  expect(
    resolveBatchModelConfig({
      cwd: "/repo",
      model: models[1]!,
      current: {
        cwd: "/previous",
        provider: "codex",
        modeId: "codex-mode",
        model: "default",
        thinkingOptionId: "codex-effort",
        providerOptions: { sandbox: true },
      },
      availableModels: [
        {
          provider: "claude",
          id: "default",
          label: "Claude default",
          thinkingOptions: [{ id: "claude-effort", label: "Effort", isDefault: true }],
        },
      ],
      modes: [
        { id: "ask", label: "Ask" },
        { id: "claude-mode", label: "Claude mode" },
      ],
      defaultModeId: "claude-mode",
    }),
  ).toEqual({
    cwd: "/repo",
    provider: "claude",
    model: "default",
    modeId: "claude-mode",
    thinkingOptionId: "claude-effort",
  });
});

it.each([
  [{ isolation: "local" as const }, "worktreeRequired"],
  [{ isolation: "existing" as const }, "worktreeRequired"],
  [{ isBranchOff: false }, "branchOffRequired"],
  [{ supported: false }, "unsupported"],
  [{ canCoordinateWindows: false }, "browserUnsupported"],
  [{ connected: false }, "disconnected"],
  [{ hasContent: false }, "empty"],
])("reports why multiple models cannot be selected (%j)", (overrides, result) => {
  expect(
    workspaceBatchBlock({
      isolation: "worktree",
      isBranchOff: true,
      connected: true,
      supported: true,
      hasContent: true,
      canCoordinateWindows: true,
      ...overrides,
    }),
  ).toBe(result);
});
