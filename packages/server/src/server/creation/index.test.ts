import pino from "pino";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { WORKSPACE_MAIN_ROLE, WORKSPACE_ROLE_LABEL } from "@getpaseo/protocol/agent-labels";
import type {
  AgentSnapshotPayload,
  CreationSnapshot,
  WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { CreationService, type CreationInput } from "./index.js";
import { writeFileAtomic } from "../atomic-file.js";

const silentLogger = pino({ level: "silent" });
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
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
const topic = { summary: "Direction", hideFromModel: false, revision: 0, mainAgentId: null };
const topicWorkspace = { ...workspace, topic, hasActiveMainAgent: false };
const topicMain = { ...agent, labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE } };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "creation-lifecycle-"));
  directories.push(directory);
  const service = new CreationService(directory, silentLogger);
  const provider = deferred();
  const ready = deferred();
  const calls: string[] = [];
  const input: CreationInput = {
    kind: "workspace",
    key: "submit-one",
    request: { source: "/project", prompt: "Start once" },
    workspaceId: workspace.id,
    agentId: agent.id,
    hasAgent: true,
    hasPrompt: true,
    exists: async () => false,
    provision: async () => {
      calls.push("workspace");
      return { workspace };
    },
    createAgent: async (_id, _workspace, onReady) => {
      await provider.promise;
      calls.push("agent");
      await onReady(agent);
      calls.push("prompt");
      return { agent, initialPromptStarted: true };
    },
  };
  const updates: CreationSnapshot[] = [];
  const observe = (snapshot: CreationSnapshot) => {
    updates.push(snapshot);
    if (snapshot.phase === "workspace_ready") ready.resolve();
  };
  return { directory, service, input, provider, ready, calls, updates, observe };
}

test("workspace readiness is observable before provider startup and duplicate requests join the same work", async () => {
  const f = await fixture();
  const first = f.service.create(f.input, f.observe);
  await f.ready.promise;
  expect(f.calls).toEqual(["workspace"]);
  expect(f.updates.map((s) => s.phase)).toEqual(["accepted", "workspace_ready"]);
  expect(f.updates[0]).toMatchObject({ workspaceId: workspace.id, agentId: agent.id });
  const duplicate = f.service.create(f.input);
  f.provider.resolve();
  expect(await first).toMatchObject({ phase: "completed", error: null, workspace, agent });
  expect(await duplicate).toEqual(await first);
  expect(f.calls).toEqual(["workspace", "agent", "prompt"]);
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(await first);
  expect(f.calls).toEqual(["workspace", "agent", "prompt"]);
});

test.each([
  { started: true, confirmation: true },
  { started: false, confirmation: undefined },
])(
  "a new connection reads the first prompt confirmation when started=$started",
  async ({ started, confirmation }) => {
    const f = await fixture();
    f.input.createAgent = async (_id, _workspace, onReady) => {
      await onReady(agent);
      return { agent, initialPromptStarted: started };
    };
    await f.service.create(f.input);
    const restored = new CreationService(f.directory, silentLogger);
    const { snapshot, unsubscribe } = await restored.subscribe("workspace", f.input.key, () => {});
    unsubscribe();
    expect(snapshot).toMatchObject({ phase: "completed", agent: expect.any(Object) });
    expect(snapshot?.initialPromptStarted).toBe(confirmation);
  },
);

test("a failed agent startup retries only that stage with the reserved IDs", async () => {
  const f = await fixture();
  let attempts = 0;
  f.input.createAgent = async (id, readyWorkspace, onReady) => {
    attempts++;
    expect(id).toBe(agent.id);
    expect(readyWorkspace).toEqual(workspace);
    if (attempts === 1) throw new Error("provider unavailable");
    await onReady(agent);
    return { agent, initialPromptStarted: true };
  };
  expect(await f.service.create(f.input)).toMatchObject({
    phase: "failed",
    failedStage: "agent",
    outcomeUnknown: false,
    workspace,
  });
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toMatchObject({
    phase: "completed",
    agent,
  });
  expect(f.calls).toEqual(["workspace"]);
  expect(attempts).toBe(2);
});

test("an uncertain prompt outcome never resends or removes its workspace and agent", async () => {
  const f = await fixture();
  let prompts = 0;
  f.input.createAgent = async (_id, _workspace, onReady) => {
    await onReady(agent);
    prompts++;
    throw new Error("connection lost after provider accepted prompt");
  };
  const result = await f.service.create(f.input);
  expect(result).toMatchObject({
    phase: "failed",
    failedStage: "prompt",
    outcomeUnknown: true,
    workspace,
    agent,
  });
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(result);
  expect(prompts).toBe(1);
});

test("a Main Session written before a failure is not created again on retry", async () => {
  const f = await fixture();
  f.input.hasAgent = false;
  f.input.hasPrompt = false;
  f.input.agentId = undefined;
  const storedIds = new Set<string>();
  let attempts = 0;
  f.input.exists = async (kind, id) => kind === "agent" && storedIds.has(id);
  f.input.createMainAgent = async (_workspace, id) => {
    attempts++;
    storedIds.add(id);
    throw new Error("Failed to project persisted Main Session");
  };
  f.input.readMainAgent = async (id, workspaceId) =>
    storedIds.has(id) ? { ...agent, id, workspaceId } : null;

  const result = await f.service.create(f.input);
  expect(result).toMatchObject({
    phase: "failed",
    failedStage: "agent",
    outcomeUnknown: true,
    workspace,
  });
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toMatchObject({
    phase: "completed",
    mainAgent: { id: [...storedIds][0], workspaceId: workspace.id },
  });
  expect(attempts).toBe(1);
  expect(f.calls).toEqual(["workspace"]);
});

test("restarts interrupted default Main creation with the same reserved ID", async () => {
  const f = await fixture();
  f.input.hasAgent = false;
  f.input.hasPrompt = false;
  f.input.agentId = undefined;
  const started = deferred();
  const release = deferred();
  let reservedId: string | undefined;
  f.input.createMainAgent = async (_workspace, id) => {
    reservedId = id;
    started.resolve();
    await release.promise;
    throw new Error("Interrupted before persistence");
  };
  const first = f.service.create(f.input);
  await started.promise;
  try {
    // Copy the on-disk receipt at the same point a restarted daemon would read it.
    const restartedDirectory = await mkdtemp(join(tmpdir(), "creation-main-recovery-"));
    directories.push(restartedDirectory);
    await cp(f.directory, restartedDirectory, { recursive: true });
    const restarted = new CreationService(restartedDirectory, silentLogger);
    expect(
      await restarted.create({
        ...f.input,
        readMainAgent: async (id) => {
          expect(id).toBe(reservedId);
          return null;
        },
        createMainAgent: async (createdWorkspace, id) => {
          expect(id).toBe(reservedId);
          return { ...agent, id, workspaceId: createdWorkspace.id };
        },
      }),
    ).toMatchObject({ phase: "completed", mainAgent: { id: reservedId } });
  } finally {
    release.resolve();
    await first;
  }
});

test("a topic without a preset completes with an unbound workspace and no agent", async () => {
  const f = await fixture();
  const result = await f.service.create({
    ...f.input,
    request: { topic },
    hasAgent: false,
    hasPrompt: false,
    provision: async () => ({ workspace: topicWorkspace }),
  });
  expect(result).toMatchObject({
    phase: "completed",
    agentId: null,
    workspace: topicWorkspace,
  });
  expect(result.agent).toBeUndefined();
  expect(result.mainAgent).toBeUndefined();
});

test.each([true, false])(
  "concurrent topic recovery settles a silent Main exactly once (stored=%s)",
  async (stored) => {
    const f = await fixture();
    const restartedDirectory = await mkdtemp(join(tmpdir(), "creation-topic-main-"));
    directories.push(restartedDirectory);
    let reservedId: string | undefined;
    const input: CreationInput = {
      ...f.input,
      request: { topic, preset: "codex" },
      hasAgent: false,
      hasPrompt: false,
      provision: async () => ({ workspace: topicWorkspace }),
      createMainAgent: async (_workspace, id) => {
        reservedId = id;
        await cp(f.directory, restartedDirectory, { recursive: true });
        return { ...topicMain, id, status: "closed" };
      },
    };
    const created = await f.service.create(input);
    const readyWorkspace = {
      ...topicWorkspace,
      hasActiveMainAgent: true,
      topic: { ...topic, mainAgentId: reservedId },
    };
    expect(created).toMatchObject({ phase: "completed", workspace: readyWorkspace });
    const restarted = new CreationService(restartedDirectory, silentLogger);
    let reads = 0;
    let creates = 0;
    const readMainAgent = async (id: string, workspaceId: string) => {
      reads++;
      expect(id).toBe(reservedId);
      expect(workspaceId).toBe(workspace.id);
      return stored ? { ...topicMain, id, status: "closed" as const } : null;
    };
    const subscribe = () =>
      restarted.subscribe("workspace", input.key, () => {}, { readMainAgent });
    const [one, two] = await Promise.all([subscribe(), subscribe()]);
    one.unsubscribe();
    two.unsubscribe();
    expect(one.snapshot).toEqual(two.snapshot);
    expect(one.snapshot).toMatchObject(
      stored
        ? { phase: "completed", workspace: readyWorkspace }
        : {
            phase: "failed",
            failedStage: "agent",
            outcomeUnknown: false,
            workspace: topicWorkspace,
          },
    );

    const retryInput = {
      ...input,
      readMainAgent,
      createMainAgent: async (_workspace: WorkspaceDescriptorPayload, id: string) => {
        creates++;
        expect(id).toBe(reservedId);
        return { ...topicMain, id, status: "closed" as const };
      },
    };
    const [retry, duplicate] = await Promise.all([
      restarted.create(retryInput),
      restarted.create(retryInput),
    ]);
    expect(retry).toEqual(duplicate);
    expect(retry).toMatchObject({
      phase: "completed",
      workspace: readyWorkspace,
      mainAgent: { id: reservedId, status: "closed" },
    });
    expect(reads).toBe(1);
    expect(creates).toBe(stored ? 0 : 1);
    expect(f.calls).toEqual([]);
  },
);

test.each(["accepted", "unknown", "absent"] as const)(
  "topic first-prompt recovery uses the saved message receipt (%s) without resending",
  async (outcome) => {
    const f = await fixture();
    const restartedDirectory = await mkdtemp(join(tmpdir(), "creation-topic-first-prompt-"));
    directories.push(restartedDirectory);
    const promptMessageId = "first-topic-message";
    const promptReceiptFingerprint = "start-once";
    let creates = 0;
    const input: CreationInput = {
      ...f.input,
      request: { topic, prompt: "Start once", clientMessageId: promptMessageId },
      promptMessageId,
      promptReceiptFingerprint,
      provision: async () => ({ workspace: topicWorkspace }),
      createAgent: async (_id, _workspace, onReady) => {
        creates++;
        await onReady(topicMain);
        await cp(f.directory, restartedDirectory, { recursive: true });
        return { agent: topicMain, initialPromptStarted: false };
      },
      readPromptOutcome: async (agentId, messageId, expectedFingerprint) => {
        expect(agentId).toBe(topicMain.id);
        expect(messageId).toBe(promptMessageId);
        expect(expectedFingerprint).toBe(promptReceiptFingerprint);
        return outcome;
      },
    };
    const result = await f.service.create(input);
    expect(result).toMatchObject(
      outcome === "accepted"
        ? { phase: "completed", initialPromptStarted: true }
        : { phase: "failed", failedStage: "prompt", outcomeUnknown: outcome === "unknown" },
    );
    expect(await new CreationService(f.directory, silentLogger).create(input)).toEqual(result);
    const restarted = new CreationService(restartedDirectory, silentLogger);
    const { snapshot, unsubscribe } = await restarted.subscribe("workspace", input.key, () => {}, {
      readPromptOutcome: input.readPromptOutcome,
    });
    unsubscribe();
    expect(snapshot).toMatchObject({
      agent: topicMain,
      workspace: {
        hasActiveMainAgent: true,
        topic: { ...topic, mainAgentId: topicMain.id },
      },
      ...(outcome === "accepted"
        ? { phase: "completed", initialPromptStarted: true }
        : { phase: "failed", failedStage: "prompt", outcomeUnknown: true }),
    });
    expect(await restarted.create(input)).toEqual(snapshot);
    expect(creates).toBe(1);
  },
);

test.each([
  ["original", { phase: "completed", initialPromptStarted: true, error: null }],
  ["different", { phase: "failed", initialPromptStarted: false, outcomeUnknown: false }],
] as const)(
  "topic first question recovery checks the receipt fingerprint (%s content)",
  async (sentFingerprint, expected) => {
    const f = await fixture();
    const promptMessageId = "first-topic-message";
    const promptReceiptFingerprint = "original";
    let savedFingerprint: string | undefined;
    let registrations = 0;
    const input: CreationInput = {
      ...f.input,
      request: { topic, clientMessageId: promptMessageId },
      promptMessageId,
      promptReceiptFingerprint,
      provision: async () => ({ workspace: topicWorkspace }),
      createAgent: async (_id, _workspace, onReady) => {
        registrations++;
        await onReady(topicMain);
        return { agent: topicMain, initialPromptStarted: false };
      },
      readPromptOutcome: async (id, messageId, expectedFingerprint) => {
        expect(id).toBe(topicMain.id);
        expect(messageId).toBe(promptMessageId);
        return savedFingerprint === expectedFingerprint ? "accepted" : "absent";
      },
    };
    const rejected = await f.service.create(input);
    expect(rejected).toMatchObject({
      phase: "failed",
      failedStage: "prompt",
      outcomeUnknown: false,
      initialPromptStarted: false,
      agent: topicMain,
      workspace: { topic: { mainAgentId: topicMain.id } },
    });
    const restarted = new CreationService(f.directory, silentLogger);
    expect(await restarted.create(input)).toEqual(rejected);
    savedFingerprint = sentFingerprint;
    const result = await restarted.create({ ...input, promptReceiptFingerprint: sentFingerprint });
    expect(result).toMatchObject({ ...expected, agent: topicMain });
    expect(registrations).toBe(1);
  },
);

test("a delayed topic binding reconciles its own first question without registering again", async () => {
  const f = await fixture();
  let accepted = false;
  let registrations = 0;
  const input: CreationInput = {
    ...f.input,
    kind: "agent",
    provision: undefined,
    promptMessageId: "delayed-first-question",
    promptReceiptFingerprint: "delayed-first-question-content",
    readAgent: async () => null,
    createAgent: async (_id, _workspace, onReady) => {
      registrations++;
      await onReady(topicMain);
      return { agent: topicMain, initialPromptStarted: false };
    },
    readPromptOutcome: async (id, messageId, fingerprint) => {
      expect([id, messageId, fingerprint]).toEqual([
        topicMain.id,
        input.promptMessageId,
        input.promptReceiptFingerprint,
      ]);
      return accepted ? "accepted" : "absent";
    },
  };
  const rejected = await f.service.create(input);
  expect(rejected).toMatchObject({
    kind: "agent",
    phase: "failed",
    failedStage: "prompt",
    outcomeUnknown: false,
    agent: topicMain,
  });
  const restarted = new CreationService(f.directory, silentLogger);
  expect(await restarted.create(input)).toEqual(rejected);
  accepted = true;
  const recovered = await restarted.subscribe("agent", input.key, () => {}, input);
  recovered.unsubscribe();
  expect(recovered.snapshot).toMatchObject({
    phase: "completed",
    initialPromptStarted: true,
    agent: topicMain,
    workspaceId: workspace.id,
  });
  expect(registrations).toBe(1);
});

test.each(["workspace", "mainAgent"] as const)(
  "topic recovery uses the persisted %s when its checkpoint write fails",
  async (checkpoint) => {
    const f = await fixture();
    let workspaces = 0;
    let mainAgents = 0;
    const service = new CreationService(
      f.directory,
      silentLogger,
      undefined,
      undefined,
      async (path, contents) => {
        const { snapshot } = JSON.parse(contents);
        if (
          snapshot.phase === "workspace_ready" &&
          (checkpoint === "workspace" || snapshot.mainAgent)
        ) {
          throw new Error("Checkpoint write failed");
        }
        await writeFileAtomic(path, contents);
      },
    );
    const input: CreationInput = {
      ...f.input,
      request: { topic },
      hasAgent: false,
      hasPrompt: false,
      createAgent: undefined,
      exists: async (kind) => (kind === "workspace" ? workspaces > 0 : mainAgents > 0),
      provision: async () => {
        workspaces++;
        return { workspace: topicWorkspace };
      },
      readTopicWorkspace: async (id) => {
        expect(id).toBe(topicWorkspace.id);
        return workspaces ? { workspace: topicWorkspace } : null;
      },
      createMainAgent: async (_workspace, id) => {
        mainAgents++;
        return { ...topicMain, id, status: "closed" };
      },
      readMainAgent: async (id) => (mainAgents ? { ...topicMain, id, status: "closed" } : null),
    };
    expect(await service.create(input)).toMatchObject({
      phase: "failed",
      failedStage: checkpoint === "workspace" ? "workspace" : "agent",
      outcomeUnknown: true,
    });
    const restarted = new CreationService(f.directory, silentLogger);
    const recovered = await restarted.subscribe("workspace", input.key, () => {}, input);
    recovered.unsubscribe();
    expect(recovered.snapshot?.phase).toBe(
      checkpoint === "workspace" ? "workspace_ready" : "completed",
    );
    const finished = await restarted.create(input);
    expect(finished).toMatchObject({ phase: "completed", mainAgent: { status: "closed" } });
    expect(finished.workspace?.topic?.mainAgentId).toBe(finished.mainAgent?.id);
    expect([workspaces, mainAgents]).toEqual([1, 1]);
  },
);

test("topic recovery finds a registered main after the agent-ready checkpoint write fails", async () => {
  const f = await fixture();
  let registered = false;
  let sent = 0;
  const service = new CreationService(
    f.directory,
    silentLogger,
    undefined,
    undefined,
    async (path, contents) => {
      if (JSON.parse(contents).snapshot.phase === "agent_ready") {
        throw new Error("Agent-ready write failed");
      }
      await writeFileAtomic(path, contents);
    },
  );
  const input: CreationInput = {
    ...f.input,
    request: { topic },
    promptMessageId: "first-topic-message",
    promptReceiptFingerprint: "original-question",
    provision: async () => ({ workspace: topicWorkspace }),
    exists: async (kind) => kind === "agent" && registered,
    readMainAgent: async (id, workspaceId) => {
      expect([id, workspaceId]).toEqual([topicMain.id, topicWorkspace.id]);
      return registered ? topicMain : null;
    },
    readPromptOutcome: async () => (sent ? "accepted" : "absent"),
    createAgent: async (_id, _workspace, onReady) => {
      expect(registered).toBe(false);
      registered = true;
      await onReady(topicMain);
      sent++;
      return { agent: topicMain, initialPromptStarted: true };
    },
  };
  expect(await service.create(input)).toMatchObject({
    phase: "failed",
    failedStage: "agent",
    outcomeUnknown: true,
  });
  const restarted = new CreationService(f.directory, silentLogger);
  const recovered = await restarted.subscribe("workspace", input.key, () => {}, input);
  recovered.unsubscribe();
  expect(recovered.snapshot).toMatchObject({
    phase: "failed",
    failedStage: "prompt",
    outcomeUnknown: false,
    agent: topicMain,
    workspace: { topic: { mainAgentId: topicMain.id } },
  });
  expect(await restarted.create(input)).toEqual(recovered.snapshot);
  expect(sent).toBe(0);
});

test("an accepted topic first question survives one failed completion write without sending again", async () => {
  const f = await fixture();
  let sent = 0;
  let failedWrites = 0;
  const service = new CreationService(
    f.directory,
    silentLogger,
    undefined,
    undefined,
    async (path, contents) => {
      if (failedWrites === 0 && JSON.parse(contents).snapshot.phase === "completed") {
        failedWrites++;
        throw new Error("Completion write failed");
      }
      await writeFileAtomic(path, contents);
    },
  );
  const input: CreationInput = {
    ...f.input,
    request: { topic, clientMessageId: "first-topic-message" },
    promptMessageId: "first-topic-message",
    provision: async () => ({ workspace: topicWorkspace }),
    createAgent: async (_id, _workspace, onReady) => {
      await onReady(topicMain);
      sent++;
      return { agent: topicMain, initialPromptStarted: true };
    },
  };
  const updates: CreationSnapshot[] = [];
  await expect(service.create(input, (snapshot) => updates.push(snapshot))).rejects.toThrow(
    "Completion write failed",
  );
  expect(updates.map(({ phase }) => phase)).toEqual([
    "accepted",
    "workspace_ready",
    "agent_ready",
    "prompt_started",
  ]);
  const restarted = new CreationService(f.directory, silentLogger);
  const recovered = await restarted.subscribe("workspace", input.key, () => {});
  recovered.unsubscribe();
  expect(recovered.snapshot).toMatchObject({
    phase: "completed",
    initialPromptStarted: true,
    agent: topicMain,
  });
  expect(await restarted.create(input)).toEqual(recovered.snapshot);
  expect(failedWrites).toBe(1);
  expect(sent).toBe(1);
});

test.each(["silent", "prompt"] as const)(
  "topic recovery publishes completion only after validating the resources (%s)",
  async (mode) => {
    const f = await fixture();
    const restartedDirectory = await mkdtemp(join(tmpdir(), "creation-topic-validation-"));
    directories.push(restartedDirectory);
    const captureReceipt = () => cp(f.directory, restartedDirectory, { recursive: true });
    const input: CreationInput = {
      ...f.input,
      request: { topic },
      provision: async () => ({ workspace: topicWorkspace }),
      hasAgent: mode === "prompt",
      hasPrompt: mode === "prompt",
      promptMessageId: mode === "prompt" ? "first-topic-message" : undefined,
      promptReceiptFingerprint: mode === "prompt" ? "first-question" : undefined,
      readPromptOutcome: async () => "accepted",
      readMainAgent: async (id) => ({ ...topicMain, id, status: "closed" }),
      createMainAgent:
        mode === "silent"
          ? async (_workspace, id) => {
              await captureReceipt();
              return { ...topicMain, id, status: "closed" };
            }
          : undefined,
      createAgent: async (_id, _workspace, onReady) => {
        await onReady(topicMain);
        await captureReceipt();
        return { agent: topicMain, initialPromptStarted: true };
      },
    };
    await f.service.create(input);
    let resourcesAvailable = false;
    const restarted = new CreationService(restartedDirectory, silentLogger, async (snapshot) => {
      expect(snapshot.phase).toBe("completed");
      expect(snapshot.workspace?.topic?.mainAgentId).toBe(
        (snapshot.mainAgent ?? snapshot.agent)?.id,
      );
      if (!resourcesAvailable) throw new Error("Previously created resource no longer exists");
    });
    const phases: CreationSnapshot["phase"][] = [];
    const observe = ({ phase }: CreationSnapshot) => phases.push(phase);
    await expect(restarted.create(input, observe)).rejects.toThrow(
      "Previously created resource no longer exists",
    );
    const subscribe = () => restarted.subscribe("workspace", input.key, observe, input);
    await expect(subscribe()).rejects.toThrow("Previously created resource no longer exists");
    expect(phases).not.toContain("completed");
    resourcesAvailable = true;
    const recovered = await subscribe();
    recovered.unsubscribe();
    expect(recovered.snapshot?.phase).toBe("completed");
    expect(phases).toEqual(["completed"]);
  },
);

test("conflicting intents and resource IDs cannot start more work", async () => {
  const f = await fixture();
  const first = f.service.create(f.input, f.observe);
  await f.ready.promise;
  await expect(f.service.create({ ...f.input, request: { prompt: "changed" } })).rejects.toThrow(
    "workspace_request_key_conflict",
  );
  await expect(f.service.create({ ...f.input, key: "another-intent" })).rejects.toThrow(
    "workspace_id_conflict",
  );
  f.provider.resolve();
  expect(await first).toMatchObject({ phase: "completed", error: null });
  expect(f.calls).toEqual(["workspace", "agent", "prompt"]);
});

test("late subscribers recover readiness and removing an observer cannot stop creation", async () => {
  const f = await fixture();
  const first = f.service.create(f.input, f.observe);
  await f.ready.promise;
  const updates: CreationSnapshot[] = [];
  const subscription = await f.service.subscribe("workspace", f.input.key, (snapshot) =>
    updates.push(snapshot),
  );
  expect(subscription.snapshot).toMatchObject({ phase: "workspace_ready", workspace });
  subscription.unsubscribe();
  f.provider.resolve();
  await first;
  expect(updates).toEqual([]);
  const completed = await new CreationService(f.directory, silentLogger).subscribe(
    "workspace",
    f.input.key,
    () => {},
  );
  expect(completed.snapshot).toMatchObject({ phase: "completed", agent, workspace });
  completed.unsubscribe();
});

test("omitted resource IDs are generated once and preserved on replay", async () => {
  const f = await fixture();
  f.input.workspaceId = undefined;
  f.input.agentId = undefined;
  f.input.provision = async (id) => ({ workspace: { ...workspace, id } });
  f.input.createAgent = async (id, createdWorkspace, onReady) => {
    const created = { ...agent, id, workspaceId: createdWorkspace!.id };
    await onReady(created);
    return { agent: created, initialPromptStarted: true };
  };
  const result = await f.service.create(f.input);
  expect(result.workspaceId).toMatch(/^wks_[a-f0-9]{16}$/);
  expect(result.agentId).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(result);
});

test("restart after a committed agent without a prompt completes without recreating the agent", async () => {
  const f = await fixture();
  const recoveredDirectory = await mkdtemp(join(tmpdir(), "creation-checkpoint-"));
  directories.push(recoveredDirectory);
  f.input.hasPrompt = false;
  let starts = 0;
  f.input.createAgent = async (_id, _workspace, onReady) => {
    starts++;
    await onReady(agent);
    // Capture the durable state at the exact milestone a process could stop after.
    await cp(f.directory, recoveredDirectory, { recursive: true });
    return { agent, initialPromptStarted: false };
  };
  await f.service.create(f.input);
  const recovered = await new CreationService(recoveredDirectory, silentLogger).create(f.input);
  expect(recovered).toMatchObject({ phase: "completed", workspace, agent });
  expect(starts).toBe(1);
});

test("partial provisioning without a registered workspace is not repeated", async () => {
  const f = await fixture();
  let provisions = 0;
  f.input.provision = async () => {
    provisions++;
    await writeFile(join(f.directory, "partial-checkout"), "disk was changed");
    throw new Error("Git failed after creating the checkout");
  };
  const result = await f.service.create(f.input);
  expect(result).toMatchObject({ phase: "failed", failedStage: "workspace", outcomeUnknown: true });
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(result);
  expect(provisions).toBe(1);
});

test.each(["pending", "completed"])(
  "imports a %s legacy agent receipt without creating another agent",
  async (state) => {
    const f = await fixture();
    const legacyDirectory = join(f.directory, "legacy");
    await mkdir(legacyDirectory);
    const request = { config: { cwd: "/project", provider: "codex" } };
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    await writeFile(
      join(legacyDirectory, `${hash(["create", "old-key"])}.json`),
      JSON.stringify({
        fingerprint: hash({ ...request, type: "create_agent_request" }),
        state,
        agentId: agent.id,
      }),
    );
    const input: CreationInput = {
      kind: "agent",
      key: "old-key",
      request,
      hasAgent: true,
      hasPrompt: false,
      exists: async () => true,
      readAgent: async () => agent,
      createAgent: async () => {
        throw new Error("Must not create again");
      },
    };
    const service = new CreationService(f.directory, silentLogger, undefined, legacyDirectory);
    await expect(
      service.create({ ...input, request: { config: { ...request.config, cwd: "/changed" } } }),
    ).rejects.toThrow("agent_request_key_conflict");
    expect(await service.create(input)).toMatchObject({ phase: "completed", agent });
    expect(await new CreationService(f.directory, silentLogger).create(input)).toMatchObject({
      phase: "completed",
      agent,
    });
  },
);

test("observer failures are logged without failing creation", async () => {
  const f = await fixture();
  const logs: unknown[] = [];
  const logger = pino(
    { level: "warn" },
    {
      write: (line) => {
        logs.push(JSON.parse(line));
      },
    },
  );
  const service = new CreationService(f.directory, logger);
  f.provider.resolve();
  const result = await service.create(f.input, () => {
    throw new Error("delivery failed");
  });
  expect(result.phase).toBe("completed");
  expect(f.calls).toEqual(["workspace", "agent", "prompt"]);
  expect(logs).toContainEqual(
    expect.objectContaining({
      level: 40,
      kind: "workspace",
      idempotencyKey: f.input.key,
      phase: "workspace_ready",
      err: expect.objectContaining({ message: "delivery failed" }),
    }),
  );
});
