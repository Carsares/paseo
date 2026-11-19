import {
  MAIN_PRIOR_MODE_ID_LABEL,
  PARENT_AGENT_ID_LABEL,
  WORKSPACE_MAIN_ROLE,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import { AgentManager } from "./agent-manager.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { AgentStorage } from "./agent-storage.js";
import { createAgentCommand, registerParentFinishSubscription } from "./create-agent/create.js";
import {
  createFinishSubscriptions,
  type FinishSubscription,
} from "./finish-subscriptions/index.js";
import { createPaseoToolCatalog } from "./tools/paseo-tools.js";
import {
  applyHierarchyPaseoToolPolicy,
  applyMainControlReadOnlyConfig,
  buildHierarchyAppendSystemPrompt,
  computeAgentDepth,
  computeMaxSubtreeDepth,
  isMainControlWritePermissionBlocked,
  MAIN_CONTROL_WRITE_DENIAL,
  REMOTE_HIERARCHY_DEPTH_LABEL,
  validateCanSpawnChild,
  validateSetAgentParent,
  validateSingleHopOrchestration,
  type HierarchyAgent,
} from "./hierarchy-policy.js";

const main: HierarchyAgent = {
  id: "main",
  labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
};

function child(id: string, parent: HierarchyAgent): HierarchyAgent {
  return { id, title: id, lifecycle: "running", labels: { [PARENT_AGENT_ID_LABEL]: parent.id } };
}

const lead = child("lead", main);
const worker = child("worker", lead);
const sibling = child("other-lead", main);
const root: HierarchyAgent = { id: "ordinary-root" };

function hierarchy(...agents: HierarchyAgent[]) {
  return {
    readAgent: (id: string) => agents.find((agent) => agent.id === id),
    listActiveAgents: () => agents,
  };
}

describe("agent hierarchy depth", () => {
  it("counts parent links and ignores archived children in subtree height", () => {
    const archived = { ...child("archived", worker), archivedAt: "2026-01-01" };
    const { readAgent, listActiveAgents } = hierarchy(main, lead, worker, archived, root);
    expect(computeAgentDepth(main.id, readAgent)).toBe(0);
    expect(computeAgentDepth(worker.id, readAgent)).toBe(2);
    expect(computeMaxSubtreeDepth(main.id, listActiveAgents)).toBe(2);
    expect(computeMaxSubtreeDepth(lead.id, listActiveAgents)).toBe(1);
    expect(computeMaxSubtreeDepth(worker.id, listActiveAgents)).toBe(0);
    expect(computeMaxSubtreeDepth(root.id, listActiveAgents)).toBe(0);
    expect(() => validateCanSpawnChild(lead, readAgent)).not.toThrow();
    expect(() => validateCanSpawnChild(worker, readAgent)).toThrow(
      "Level-2 subagents cannot spawn",
    );
    expect(() => validateCanSpawnChild(archived, readAgent)).toThrow("Archived agents");
  });

  it("retains a remote Level-2 child's depth on a host that cannot read its parent", () => {
    const remoteWorker = {
      ...worker,
      labels: { ...worker.labels, [REMOTE_HIERARCHY_DEPTH_LABEL]: "2" },
    };
    const { readAgent } = hierarchy(remoteWorker);
    expect(computeAgentDepth(remoteWorker.id, readAgent)).toBe(2);
    expect(() => validateCanSpawnChild(remoteWorker, readAgent)).toThrow("Level-2 subagents");
  });

  it("checks the whole subtree's height before adoption", () => {
    const branch = child("branch", root);
    const graph = hierarchy(main, lead, worker, root, branch);
    expect(() =>
      validateSetAgentParent({ agent: root, parentAgent: main, ...graph }),
    ).not.toThrow();
    expect(() => validateSetAgentParent({ agent: root, parentAgent: lead, ...graph })).toThrow(
      "maximum hierarchy depth",
    );
  });

  it("rejects self-parenting, archived agents, cycles, and moving Main Control", () => {
    const archived = { id: "archived", archivedAt: "2026-01-01" };
    const graph = hierarchy(main, lead, worker, root, archived);
    expect(() => validateSetAgentParent({ agent: lead, parentAgent: lead, ...graph })).toThrow(
      "own parent",
    );
    expect(() => validateSetAgentParent({ agent: root, parentAgent: archived, ...graph })).toThrow(
      "archived",
    );
    expect(() => validateSetAgentParent({ agent: archived, parentAgent: root, ...graph })).toThrow(
      "archived",
    );
    expect(() => validateSetAgentParent({ agent: lead, parentAgent: worker, ...graph })).toThrow(
      "cycle",
    );
    expect(() => validateSetAgentParent({ agent: main, parentAgent: root, ...graph })).toThrow(
      "Disable Main Control",
    );
  });
});

describe("agent orchestration", () => {
  it("allows only direct children for Main Control and Level-1", () => {
    const { readAgent } = hierarchy(main, lead, worker, sibling, root);
    const check = (callerAgentId: string, targetAgentId: string) =>
      validateSingleHopOrchestration({ callerAgentId, targetAgentId, readAgent });
    expect(() => check(main.id, lead.id)).not.toThrow();
    expect(() => check(lead.id, worker.id)).not.toThrow();
    expect(() => check(main.id, worker.id)).toThrow("Coordinate through your direct child");
    expect(() => check(lead.id, sibling.id)).toThrow("Coordinate through your direct child");
    expect(() => check(lead.id, "missing")).toThrow("Coordinate through your direct child");
    expect(() => check(root.id, lead.id)).not.toThrow();
  });

  it("merges disabled tools with provider policy and keeps Main Control's delegation tools", () => {
    const base = { disabledTools: ["custom_tool", "create_terminal"] };
    const mainPolicy = applyHierarchyPaseoToolPolicy(base, main.labels, 0);
    expect(mainPolicy?.disabledTools).toEqual([
      "custom_tool",
      "create_terminal",
      "send_terminal_keys",
      "kill_terminal",
      "start_workspace_script",
      "stop_workspace_script",
    ]);
    expect(applyHierarchyPaseoToolPolicy(base, lead.labels, 1)).toBe(base);
    expect(applyHierarchyPaseoToolPolicy({ enabled: false }, worker.labels, 2)).toEqual({
      enabled: false,
      disabledTools: [
        "create_agent",
        "send_agent_prompt",
        "update_agent",
        "cancel_agent",
        "archive_agent",
        "kill_agent",
      ],
    });
  });

  it("supplies role instructions and a sorted snapshot of direct active children only", () => {
    const graph = hierarchy(worker, root, sibling, lead, main, {
      ...child("archived", main),
      archivedAt: "2026-01-01",
    });
    const prompt = buildHierarchyAppendSystemPrompt({ agent: main, ...graph });
    expect(prompt).toContain("Workspace Main Control Coordinator");
    expect(prompt).toContain(
      'Direct Level-1 children: [{"id":"lead","title":"lead","status":"running"},{"id":"other-lead","title":"other-lead","status":"running"}]',
    );
    const leadPrompt = buildHierarchyAppendSystemPrompt({ agent: lead, ...graph });
    expect(leadPrompt).toContain(
      "Level-1 Module Lead (Flexible Mode) under Main Control Agent main",
    );
    expect(leadPrompt).toContain('Direct Level-2 children: [{"id":"worker"');
    expect(buildHierarchyAppendSystemPrompt({ agent: worker, ...graph })).toBe("");
    expect(buildHierarchyAppendSystemPrompt({ agent: root, ...graph })).toBe("");
  });
});

describe("Main Control read-only configuration", () => {
  it("forces Codex sandbox and approval settings over previous overrides", () => {
    const config = {
      provider: "codex",
      cwd: "/repo",
      modeId: "full-access",
      providerOptions: { sandbox_mode: "danger-full-access", approval_policy: "on-request" },
    };
    expect(applyMainControlReadOnlyConfig(config, main.labels)).toEqual({
      ...config,
      modeId: "read-only",
      providerOptions: { sandbox_mode: "read-only", approval_policy: "never" },
    });
    expect(applyMainControlReadOnlyConfig(config, lead.labels)).toBe(config);
  });

  it("preserves existing Claude tool restrictions alongside file and shell restrictions", () => {
    const config = {
      provider: "claude",
      cwd: "/repo",
      providerOptions: { disallowedTools: ["WebFetch", "Edit"] },
    };
    expect(
      applyMainControlReadOnlyConfig(config, main.labels).providerOptions?.disallowedTools,
    ).toEqual(["WebFetch", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]);
  });

  it.each([
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "Write",
    "write_file",
    "write_to_file",
    "create_file",
    "delete_file",
    "replace_file_content",
    "multi_replace_file_content",
    "file-write",
    "mcp__filesystem__edit_file",
    "apply_patch",
    "CodexFileChange",
  ])("denies %s approval", (name) =>
    expect(isMainControlWritePermissionBlocked({ kind: "tool", name })).toBe(true),
  );

  it("uses structured edit details and allows read-only tools and questions", () => {
    expect(
      isMainControlWritePermissionBlocked({
        kind: "tool",
        name: "custom",
        detail: { type: "edit", filePath: "/repo/file" },
      }),
    ).toBe(true);
    expect(isMainControlWritePermissionBlocked({ kind: "tool", name: "Read" })).toBe(false);
    expect(isMainControlWritePermissionBlocked({ kind: "question", name: "AskUserQuestion" })).toBe(
      false,
    );
  });
});

async function withAgents(
  run: (context: {
    manager: AgentManager;
    storage: AgentStorage;
    cwd: string;
    launchedConfigs: Map<string, AgentSessionConfig[]>;
  }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-hierarchy-test-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(cwd, "agents"), logger);
  const launchedConfigs = new Map<string, AgentSessionConfig[]>();
  const recordLaunch = (provider: string, config: AgentSessionConfig) => {
    const list = launchedConfigs.get(provider) ?? [];
    list.push(config);
    launchedConfigs.set(provider, list);
  };
  const wrapClient = (provider: "codex" | "claude") => {
    const inner = createTestAgentClient(provider);
    const origCreate = inner.createSession.bind(inner);
    const origResume = inner.resumeSession.bind(inner);
    inner.createSession = async (config, context, options) => {
      recordLaunch(provider, config);
      return origCreate(config, context, options);
    };
    inner.resumeSession = async (handle, config, context) => {
      recordLaunch(provider, config);
      return origResume(handle, config, context);
    };
    return inner;
  };
  const manager = new AgentManager({
    clients: { codex: wrapClient("codex"), claude: wrapClient("claude") },
    registry: storage,
    logger,
  });
  try {
    await run({ manager, storage, cwd, launchedConfigs });
  } finally {
    manager.prepareForShutdown();
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    await manager.flushForShutdown();
    await storage.flush();
    await rm(cwd, { force: true, recursive: true });
  }
}

it("switches a live workspace's Main Control and restores the previous agent's mode", async () => {
  await withAgents(async ({ manager, storage, cwd }) => {
    const options = { workspaceId: "workspace" };
    const make = (title: string) =>
      manager.createAgent(
        { provider: "codex", cwd, title, modeId: "full-access" },
        undefined,
        options,
      );
    const first = await make("First");
    const second = await make("Second");

    await manager.setAgentMainControl(first.id, true);
    await manager.setAgentMainControl(first.id, true);
    expect(manager.getAgent(first.id)?.currentModeId).toBe("read-only");
    expect((await storage.get(first.id))?.labels[MAIN_PRIOR_MODE_ID_LABEL]).toBe("full-access");
    await expect(manager.setAgentMode(first.id, "full-access")).rejects.toThrow("read-only");
    expect(manager.getPaseoToolPolicy(first.id)?.disabledTools).toContain("send_terminal_keys");
    await manager.setAgentMainControl(second.id, true);
    expect(manager.getAgent(first.id)?.currentModeId).toBe("full-access");
    expect((await storage.get(first.id))?.labels).toEqual({});
    expect(manager.getPaseoToolPolicy(first.id)).toBeUndefined();
    expect(manager.getAgent(second.id)?.currentModeId).toBe("read-only");
    expect((await storage.get(second.id))?.labels[WORKSPACE_ROLE_LABEL]).toBe(WORKSPACE_MAIN_ROLE);
  });
});

it("applies the Level-2 restrictions after adoption and subscribes a UI child's first turn", async () => {
  await withAgents(async ({ manager, storage, cwd }) => {
    const config = { provider: "codex", cwd };
    const workspaceId = "workspace";
    const logger = createTestLogger();
    const rootAgent = await manager.createAgent(config, undefined, { workspaceId });
    const leadAgent = await manager.createAgent(config, undefined, { workspaceId });
    await manager.setAgentParent(leadAgent.id, rootAgent.id, "host");
    const accept = vi.fn();
    const register = vi.fn(async () => ({ accept, reject: async () => {} }));
    const dependencies = {
      agentManager: manager,
      agentStorage: storage,
      logger,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      finishSubscriptions: {
        register,
        hasPendingForCaller: () => false,
        start: async () => {},
        close: async () => {},
      },
    };
    const input = {
      kind: "session" as const,
      config,
      workspaceId,
      background: false,
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
      initialPrompt: "Check the change",
    };
    const { snapshot: workerAgent } = await createAgentCommand(dependencies, {
      ...input,
      callerAgentId: leadAgent.id,
    });
    expect((await storage.get(workerAgent.id))?.labels[PARENT_AGENT_ID_LABEL]).toBe(leadAgent.id);
    expect(manager.getPaseoToolPolicy(workerAgent.id)?.disabledTools).toContain("create_agent");
    expect(register).toHaveBeenCalledWith(
      {
        childAgentId: workerAgent.id,
        callerAgentId: leadAgent.id,
        requireParentOwnership: true,
      },
      true,
    );
    expect(accept).toHaveBeenCalledOnce();
    await expect(
      createAgentCommand(dependencies, { ...input, callerAgentId: workerAgent.id }),
    ).rejects.toThrow("Level-2 subagents cannot spawn");
  });
});

it("rejects non-root Main Control without demoting existing Main Control and toggles closed agents cleanly", async () => {
  await withAgents(async ({ manager, storage, cwd }) => {
    const options = { workspaceId: "workspace" };
    const mainAgent = await manager.createAgent(
      { provider: "codex", cwd, title: "Main", modeId: "full-access" },
      undefined,
      options,
    );
    const childAgent = await manager.createAgent(
      { provider: "codex", cwd, title: "Child", modeId: "full-access" },
      undefined,
      { workspaceId: "workspace", labels: { [PARENT_AGENT_ID_LABEL]: mainAgent.id } },
    );

    await manager.setAgentMainControl(mainAgent.id, true);
    await expect(manager.setAgentMainControl(childAgent.id, true)).rejects.toThrow(
      "Only a workspace root agent can be Main Control.",
    );
    expect((await storage.get(mainAgent.id))?.labels[WORKSPACE_ROLE_LABEL]).toBe(
      WORKSPACE_MAIN_ROLE,
    );

    await manager.closeAgent(mainAgent.id);
    expect(manager.getAgent(mainAgent.id)).toBeNull();
    const demoted = await manager.setAgentMainControl(mainAgent.id, false);
    expect(demoted.live).toBe(false);
    expect(demoted.record.lastModeId).toBe("full-access");
    expect(demoted.record.labels).toEqual({});
    expect(manager.getPaseoToolPolicy(mainAgent.id)).toBeUndefined();

    const reenabled = await manager.setAgentMainControl(mainAgent.id, true);
    expect(reenabled.live).toBe(false);
    expect(reenabled.record.lastModeId).toBe("read-only");
    expect(reenabled.record.labels[WORKSPACE_ROLE_LABEL]).toBe(WORKSPACE_MAIN_ROLE);
    expect(reenabled.record.labels[MAIN_PRIOR_MODE_ID_LABEL]).toBe("full-access");
  });
});

it("enforces Claude Main Control disallowedTools, auto-denies write permissions, and restores cleanly", async () => {
  await withAgents(async ({ manager, storage, cwd, launchedConfigs }) => {
    const claudeAgent = await manager.createAgent(
      {
        provider: "claude",
        cwd,
        title: "Claude Main",
        modeId: "default",
        providerOptions: { disallowedTools: ["WebFetch"] },
      },
      undefined,
      { workspaceId: "workspace" },
    );
    expect(launchedConfigs.get("claude")?.at(-1)?.daemonAppendSystemPrompt).toBeUndefined();

    await manager.setAgentMainControl(claudeAgent.id, true);
    const mainLaunch = launchedConfigs.get("claude")?.at(-1);
    expect(mainLaunch?.providerOptions?.disallowedTools).toEqual([
      "WebFetch",
      "Edit",
      "MultiEdit",
      "Write",
      "NotebookEdit",
      "Bash",
    ]);
    expect(mainLaunch?.daemonAppendSystemPrompt).toContain("Workspace Main Control Coordinator");
    expect(manager.getPaseoToolPolicy(claudeAgent.id)?.disabledTools).toEqual(
      expect.arrayContaining([
        "create_terminal",
        "send_terminal_keys",
        "kill_terminal",
        "start_workspace_script",
        "stop_workspace_script",
      ]),
    );
    await expect(manager.setAgentOptions(claudeAgent.id, { disallowedTools: [] })).rejects.toThrow(
      MAIN_CONTROL_WRITE_DENIAL,
    );

    // Trigger a write permission request in default mode; it must auto-deny without surfacing.
    const surfacedPermissions: string[] = [];
    const unsubscribe = manager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.event.type === "permission_requested") {
          surfacedPermissions.push(event.event.request.name);
        }
      },
      { agentId: claudeAgent.id, replayState: false },
    );
    try {
      for await (const _ of manager.streamAgent(claudeAgent.id, "edit test.txt")) {
        // drain
      }
    } finally {
      unsubscribe();
    }
    expect(surfacedPermissions).toEqual([]);
    expect(manager.getAgent(claudeAgent.id)?.pendingPermissions.size).toBe(0);

    await manager.setAgentMainControl(claudeAgent.id, false);
    const restoredLaunch = launchedConfigs.get("claude")?.at(-1);
    expect(restoredLaunch?.providerOptions?.disallowedTools).toEqual(["WebFetch"]);
    expect(restoredLaunch?.daemonAppendSystemPrompt).toBeUndefined();
    expect(manager.getAgent(claudeAgent.id)?.currentModeId).toBe("default");
    expect((await storage.get(claudeAgent.id))?.labels).toEqual({});
    expect(manager.getPaseoToolPolicy(claudeAgent.id)).toBeUndefined();
  });
});

it("enforces single-hop MCP orchestration, self mode changes, and refreshes policies on detach", async () => {
  await withAgents(async ({ manager, storage, cwd, launchedConfigs }) => {
    const logger = createTestLogger();
    const workspaceId = "workspace";
    const ordinaryRoot = await manager.createAgent(
      { provider: "codex", cwd, title: "Ordinary" },
      undefined,
      { workspaceId: "ordinary-ws" },
    );
    await manager.createAgent({ provider: "codex", cwd, title: "Ordinary Child" }, undefined, {
      workspaceId: "ordinary-ws",
      labels: { [PARENT_AGENT_ID_LABEL]: ordinaryRoot.id },
    });
    expect(
      launchedConfigs.get("codex")?.every((cfg) => cfg.daemonAppendSystemPrompt === undefined),
    ).toBe(true);

    const mainAgent = await manager.createAgent(
      { provider: "claude", cwd, title: "Main", modeId: "default" },
      undefined,
      { workspaceId },
    );
    await manager.setAgentMainControl(mainAgent.id, true);
    const leadA = await manager.createAgent(
      { provider: "codex", cwd, title: "Lead A" },
      undefined,
      {
        workspaceId,
        labels: { [PARENT_AGENT_ID_LABEL]: mainAgent.id },
      },
    );
    const leadB = await manager.createAgent(
      { provider: "codex", cwd, title: "Lead B" },
      undefined,
      {
        workspaceId,
        labels: { [PARENT_AGENT_ID_LABEL]: mainAgent.id },
      },
    );
    const workerA = await manager.createAgent(
      { provider: "codex", cwd, title: "Worker A" },
      undefined,
      { workspaceId, labels: { [PARENT_AGENT_ID_LABEL]: leadA.id } },
    );
    const leadLaunch = launchedConfigs.get("codex")?.find((cfg) => cfg.title === "Lead A");
    expect(leadLaunch?.daemonAppendSystemPrompt).toContain(
      `Level-1 Module Lead (Flexible Mode) under Main Control Agent ${mainAgent.id}`,
    );

    const makeCatalog = (callerAgentId: string) =>
      createPaseoToolCatalog({
        agentManager: manager,
        agentStorage: storage,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        callerAgentId,
        logger,
      });

    const mainCatalog = makeCatalog(mainAgent.id);
    await expect(
      mainCatalog.executeTool("send_agent_prompt", { agentId: workerA.id, prompt: "ping" }),
    ).rejects.toThrow("Coordinate through your direct child");
    await expect(
      mainCatalog.executeTool("update_agent", { agentId: workerA.id, name: "Nope" }),
    ).rejects.toThrow("Coordinate through your direct child");
    await expect(mainCatalog.executeTool("cancel_agent", { agentId: workerA.id })).rejects.toThrow(
      "Coordinate through your direct child",
    );
    await expect(
      mainCatalog.executeTool("respond_to_permission", {
        agentId: workerA.id,
        requestId: "req-1",
        response: { behavior: "deny" },
      }),
    ).rejects.toThrow("Coordinate through your direct child");
    await expect(
      mainCatalog.executeTool("set_agent_mode", { agentId: mainAgent.id, modeId: "default" }),
    ).resolves.toMatchObject({ structuredContent: { success: true, newMode: "default" } });

    const leadCatalog = makeCatalog(leadA.id);
    await expect(
      leadCatalog.executeTool("send_agent_prompt", { agentId: leadB.id, prompt: "ping" }),
    ).rejects.toThrow("Coordinate through your direct child");
    await expect(
      leadCatalog.executeTool("respond_to_permission", {
        agentId: leadB.id,
        requestId: "req-1",
        response: { behavior: "deny" },
      }),
    ).rejects.toThrow("Coordinate through your direct child");
    await expect(
      leadCatalog.executeTool("set_agent_mode", { agentId: leadA.id, modeId: "auto" }),
    ).resolves.toMatchObject({ structuredContent: { success: true, newMode: "auto" } });

    const workerCatalog = makeCatalog(workerA.id);
    await expect(
      workerCatalog.executeTool("create_agent", {
        provider: "codex/gpt-5.4",
        title: "Deep",
        initialPrompt: "hi",
      }),
    ).rejects.toThrow("Level-2 subagents cannot spawn");
    await expect(
      workerCatalog.executeTool("respond_to_permission", {
        agentId: leadA.id,
        requestId: "req-1",
        response: { behavior: "deny" },
      }),
    ).rejects.toThrow("Level-2 subagents cannot respond to permission requests");

    expect(manager.getPaseoToolPolicy(workerA.id)?.disabledTools).toContain("create_agent");
    await manager.detachAgent(workerA.id);
    expect(manager.getPaseoToolPolicy(workerA.id)).toBeUndefined();
  });
});

it("cleans up rejected finish subscriptions so idle cleanup is never blocked", async () => {
  await withAgents(async ({ manager, storage, cwd }) => {
    const logger = createTestLogger();
    const workspaceId = "workspace";
    const parentAgent = await manager.createAgent({ provider: "codex", cwd }, undefined, {
      workspaceId,
    });
    const childAgent = await manager.createAgent({ provider: "codex", cwd }, undefined, {
      workspaceId,
      labels: { [PARENT_AGENT_ID_LABEL]: parentAgent.id },
    });

    const records = new Map<string, FinishSubscription>();
    const finishSubscriptions = createFinishSubscriptions({
      store: {
        list: async () => [...records.values()],
        put: async (record) => {
          records.set(record.id, record);
        },
        remove: async (id) => {
          records.delete(id);
        },
      },
      messages: () => {
        throw new Error("unexpected message delivery");
      },
      callerIsActive: async () => true,
      open: async () => ({
        next: async () => new Promise(() => {}),
        close: async () => {},
      }),
      serverId: "server-1",
      logger,
    });
    await finishSubscriptions.start();

    try {
      const registration = await registerParentFinishSubscription({
        agentId: childAgent.id,
        serverId: "server-1",
        agentManager: manager,
        agentStorage: storage,
        finishSubscriptions,
      });
      expect(registration).toBeDefined();
      expect(finishSubscriptions.hasPendingForCaller(parentAgent.id)).toBe(true);
      await registration!.reject();
      expect(finishSubscriptions.hasPendingForCaller(parentAgent.id)).toBe(false);
      expect(records.size).toBe(0);

      await manager.archiveAgent(parentAgent.id);
      const skippedForArchivedParent = await registerParentFinishSubscription({
        agentId: childAgent.id,
        serverId: "server-1",
        agentManager: manager,
        agentStorage: storage,
        finishSubscriptions,
      });
      expect(skippedForArchivedParent).toBeUndefined();
      expect(finishSubscriptions.hasPendingForCaller(parentAgent.id)).toBe(false);
    } finally {
      await finishSubscriptions.close();
    }
  });
});
