import { expect, test } from "vitest";
import type {
  AgentSnapshotPayload,
  CreationSnapshot,
  WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { CreationClient, type CreationResult } from "./index.js";

const workspace: WorkspaceDescriptorPayload = {
  id: "wks_0123456789abcdef",
  projectId: "project",
  projectDisplayName: "Project",
  projectRootPath: "/project",
  workspaceDirectory: "/project/worktree",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "Worktree",
  status: "running",
  statusEnteredAt: null,
  activityAt: null,
  archivingAt: null,
  scripts: [],
};
const agent: AgentSnapshotPayload = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: workspace.id,
  provider: "codex",
  cwd: "/project/worktree",
  model: null,
  createdAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:00:00Z",
  lastUserMessageAt: null,
  status: "idle",
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: false,
    supportsMcpServers: false,
    supportsReasoningStream: false,
    supportsToolInvocations: true,
    supportsRewindConversation: false,
    supportsRewindFiles: false,
    supportsRewindBoth: false,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: "Start once",
  labels: {},
};

function fixture(modern: boolean) {
  const requests: Array<{ kind: string; input: Record<string, unknown> }> = [];
  const legacy: Array<{ kind: string; input: unknown }> = [];
  let resolve!: (result: CreationResult) => void;
  const result = new Promise<CreationResult>((done) => {
    resolve = done;
  });
  const client = new CreationClient({
    supports: (feature) => (feature === "creationLifecycle" ? modern : true),
    requestId: () => "generated-key",
    request: async (kind, input) => {
      requests.push({ kind, input });
      return result;
    },
    observe: () => () => {},
    legacyWorkspace: async (input) => {
      legacy.push({ kind: "workspace", input });
      return { requestId: "legacy-workspace", workspace, error: null, setupTerminalId: null };
    },
    legacyAgent: async (input) => {
      legacy.push({ kind: "agent", input });
      return agent;
    },
  });
  const input = {
    idempotencyKey: "intent-one",
    source: { kind: "directory" as const, path: "/project" },
    agent: {
      config: { provider: "codex", cwd: "/project" },
      initialPrompt: "Start once",
      clientMessageId: "message-one",
    },
  };
  return { client, requests, legacy, resolve, input };
}

test("duplicate client submissions join one complete intent and cumulative updates never regress", async () => {
  const f = fixture(true);
  const phases: string[] = [];
  const first = f.client.createWorkspace({
    ...f.input,
    onEvent: (snapshot) => phases.push(snapshot.phase),
  });
  const duplicate = f.client.createWorkspace(f.input);
  expect(duplicate).toBe(first);
  expect(f.requests).toEqual([{ kind: "workspace", input: { ...f.input, subscribe: true } }]);
  await expect(
    f.client.createWorkspace({
      ...f.input,
      agent: { ...f.input.agent, initialPrompt: "Different intent" },
    }),
  ).rejects.toThrow("workspace_request_key_conflict");
  const snapshot: CreationSnapshot = {
    kind: "workspace",
    idempotencyKey: "intent-one",
    revision: 2,
    phase: "workspace_ready",
    workspaceId: workspace.id,
    agentId: agent.id,
    workspace,
    error: null,
  };
  f.client.receive(snapshot);
  f.client.receive({ ...snapshot, revision: 1, phase: "accepted" });
  expect(phases).toEqual(["workspace_ready"]);
  const late: string[] = [];
  f.client.createWorkspace({ ...f.input, onEvent: (update) => late.push(update.phase) });
  expect(late).toEqual(["workspace_ready"]);
  f.resolve({
    workspace,
    agent,
    error: null,
    setupSkippedReason: "Untrusted source",
    requestId: "response-one",
  });
  expect(await first).toMatchObject({
    workspace,
    agent,
    setupSkippedReason: "Untrusted source",
    requestId: "response-one",
  });
  expect(await duplicate).toEqual(await first);
  expect(f.legacy).toEqual([]);
  f.client.close();
});

test.each(["accepted", "workspace_ready"] as const)(
  "reconnect resumes only an idle %s checkpoint with the same request",
  async (phase) => {
    const request = {
      idempotencyKey: "resume-topic",
      workspaceId: workspace.id,
      source: { kind: "directory" as const, path: "/project" },
      title: "Topic",
      topic: { summary: null, hideFromModel: true },
      mainAgent: { config: { provider: "codex", cwd: "/project" } },
    };
    const created = {
      ...workspace,
      topic: { ...request.topic, mainAgentId: null, revision: 1 },
    };
    const halfway: CreationSnapshot = {
      kind: "workspace",
      idempotencyKey: request.idempotencyKey,
      workspaceId: workspace.id,
      ...(phase === "workspace_ready" ? { workspace: created } : {}),
      agentId: null,
      phase,
      revision: 2,
      error: null,
    };
    const requests: Record<string, unknown>[] = [];
    const resumed = Promise.withResolvers<CreationResult>();
    const client = new CreationClient({
      supports: () => true,
      requestId: () => "request",
      request: async (_kind, input) => {
        requests.push(input);
        if (requests.length === 1)
          throw Object.assign(new Error("Connection lost"), { code: "DAEMON_CONNECTION_LOST" });
        return resumed.promise;
      },
      observe: (_kind, _key, next) => {
        next({ ...halfway, idempotencyKey: "another-topic" });
        next(halfway);
        expect(requests).toHaveLength(1);
        next({ ...halfway, canResume: true });
        next({ ...halfway, canResume: true });
        return () => {};
      },
      legacyAgent: async () => {
        throw new Error("Unexpected legacy agent");
      },
      legacyWorkspace: async () => {
        throw new Error("Unexpected legacy workspace");
      },
    });
    const original = client.createWorkspace(request);
    client.reconnect();
    expect(requests).toEqual([
      { ...request, subscribe: true },
      { ...request, subscribe: true },
    ]);
    const completion: CreationSnapshot = {
      ...halfway,
      phase: "completed",
      revision: 4,
      mainAgent: agent,
      workspace: { ...created, topic: { ...created.topic, mainAgentId: agent.id } },
    };
    resumed.resolve({
      creation: completion,
      workspace: completion.workspace,
      mainAgent: agent,
      error: null,
    });
    await expect(original).resolves.toMatchObject({ creation: completion, mainAgent: agent });
  },
);

test("legacy adaptation keeps workspace, agent and initial prompt sequencing inside the client", async () => {
  const f = fixture(false);
  const phases: string[] = [];
  const result = await f.client.createWorkspace({
    ...f.input,
    onEvent: (snapshot) => phases.push(snapshot.phase),
  });
  expect(result).toMatchObject({ workspace, agent, error: null });
  expect(phases).toEqual(["workspace_ready"]);
  expect(f.legacy).toEqual([
    { kind: "workspace", input: { idempotencyKey: "intent-one", source: f.input.source } },
    {
      kind: "agent",
      input: {
        config: { provider: "codex", cwd: workspace.workspaceDirectory },
        workspaceId: workspace.id,
        initialPrompt: "Start once",
        clientMessageId: "message-one",
      },
    },
  ]);
  expect(f.requests).toEqual([]);
  f.client.close();
});

test("legacy daemons cannot silently replace caller-selected IDs", async () => {
  const f = fixture(false);
  await expect(f.client.createWorkspace({ ...f.input, workspaceId: workspace.id })).rejects.toThrow(
    "caller-selected",
  );
  await expect(
    f.client.createAgent({ agentId: agent.id, config: f.input.agent.config }),
  ).rejects.toThrow("caller-selected");
  expect(f.legacy).toEqual([]);
  f.client.close();
});

test("keyed creation with an empty prompt works on legacy daemons without sending an empty message", async () => {
  const f = fixture(false);
  await f.client.createAgent({
    idempotencyKey: "empty-agent",
    config: f.input.agent.config,
    initialPrompt: "",
  });
  expect(f.legacy).toEqual([
    {
      kind: "agent",
      input: { idempotencyKey: "empty-agent", config: f.input.agent.config, initialPrompt: "" },
    },
  ]);
  f.client.close();
});

test.each([
  ["/repo/project", "/repo/project/../outside"],
  ["C:\\repo\\project", "C:\\repo\\project\\..\\outside"],
])("legacy creation rejects escaping %s before creating a workspace", async (source, cwd) => {
  const f = fixture(false);
  await expect(
    f.client.createWorkspace({
      ...f.input,
      source: { kind: "directory", path: source },
      agent: { ...f.input.agent, config: { provider: "codex", cwd } },
    }),
  ).rejects.toThrow("inside the workspace source");
  expect(f.legacy).toEqual([]);
  f.client.close();
});

test.each([
  { source: { kind: "directory" as const, path: "/project" }, cwd: "/project/src" },
  { source: { kind: "directory" as const, path: "C:\\project" }, cwd: "C:\\project\\src" },
  { source: { kind: "worktree" as const, projectId: "project" }, cwd: "/project/src" },
])("legacy creation preserves the agent subdirectory for $source", async ({ source, cwd }) => {
  const f = fixture(false);
  await f.client.createWorkspace({
    ...f.input,
    source,
    agent: { config: { provider: "codex", cwd } },
  });
  expect(f.legacy[1]).toMatchObject({
    kind: "agent",
    input: { workspaceId: workspace.id, config: { cwd: "/project/worktree/src" } },
  });
  f.client.close();
});

test.each(["refusal", "missing"] as const)(
  "reconnect observes an explicit prompt retry without resending it (%s)",
  async (state) => {
    const f = fixture(true);
    const request = { ...f.input, retryPromptRevision: 5 };
    const refusal: CreationSnapshot = {
      kind: "workspace",
      idempotencyKey: request.idempotencyKey,
      phase: "failed",
      failedStage: "prompt",
      outcomeUnknown: false,
      workspaceId: workspace.id,
      agentId: agent.id,
      revision: 5,
      error: "refused",
    };
    const calls: Record<string, unknown>[] = [];
    const client = new CreationClient({
      supports: () => true,
      requestId: () => "request",
      request: async (_kind, input) => {
        calls.push(input);
        throw Object.assign(new Error("Connection lost"), { code: "DAEMON_CONNECTION_LOST" });
      },
      observe: (_kind, _key, next) => {
        next(state === "missing" ? null : refusal);
        return () => {};
      },
      legacyAgent: async () => {
        throw new Error("Unexpected legacy agent");
      },
      legacyWorkspace: async () => {
        throw new Error("Unexpected legacy workspace");
      },
    });
    const original = client.createWorkspace(request);
    client.reconnect();
    if (state === "missing") await expect(original).rejects.toThrow("receipt is unavailable");
    else await expect(original).resolves.toMatchObject({ creation: refusal });
    expect(calls).toEqual([{ ...request, subscribe: true }]);
  },
);

test("reconnect on an older topic host reports an unresolved checkpoint without a replay", async () => {
  const f = fixture(true);
  const calls: Record<string, unknown>[] = [];
  const request = { ...f.input, topic: { summary: null, hideFromModel: false } };
  const client = new CreationClient({
    supports: (feature) => feature !== "topicPromptRetryV1",
    requestId: () => "request",
    request: async (_kind, input) => {
      calls.push(input);
      throw Object.assign(new Error("Connection lost"), { code: "DAEMON_CONNECTION_LOST" });
    },
    observe: (_kind, _key, next) => {
      next({
        kind: "workspace",
        idempotencyKey: request.idempotencyKey,
        phase: "workspace_ready",
        workspaceId: workspace.id,
        agentId: agent.id,
        revision: 2,
        error: null,
      });
      return () => {};
    },
    legacyAgent: async () => {
      throw new Error("Unexpected legacy agent");
    },
    legacyWorkspace: async () => {
      throw new Error("Unexpected legacy workspace");
    },
  });
  const original = client.createWorkspace(request);
  client.reconnect();
  await expect(original).rejects.toThrow("host has not confirmed creation");
  await expect(client.createWorkspace({ ...request, retryPromptRevision: 2 })).rejects.toThrow(
    "Update the host",
  );
  expect(calls).toEqual([{ ...request, subscribe: true }]);
});
