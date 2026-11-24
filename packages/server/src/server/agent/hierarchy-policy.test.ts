import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  EXPLICIT_PARENT_REPORTING,
  LEAD_COMMIT_POLICY_LABEL,
  LEAD_PLAYBOOK_LABEL,
  MAIN_PRIOR_MODE_ID_LABEL,
  PARENT_AGENT_ID_LABEL,
  PARENT_REPORTING_LABEL,
  PARENT_SERVER_ID_LABEL,
  WORKSPACE_MAIN_ROLE,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { openDurableItemStore } from "../durable-items/requests.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import { createPersistedWorkspaceRecord } from "../workspace-registry.js";
import { AgentManager } from "./agent-manager.js";
import { createAgentMessageDelivery, parseAgentMessages } from "./agent-messages/index.js";
import { toAgentPayload } from "./agent-projections.js";
import type { AgentPromptInput, AgentSessionConfig } from "./agent-sdk-types.js";
import { AgentStorage, type StoredAgentRecord } from "./agent-storage.js";
import { createAgentCommand, registerParentFinishSubscription } from "./create-agent/create.js";
import {
  createFinishSubscriptions,
  createJsonFinishSubscriptionStore,
  ParentReportRecipientUnavailableError,
  type FinishSubscription,
} from "./finish-subscriptions/index.js";
import { createPaseoToolCatalog } from "./tools/paseo-tools.js";
import { isPaseoToolEnabled } from "./paseo-tool-policy.js";
import { resolveRuntimeMcpToolPolicy } from "./runtime-mcp-config.js";
import {
  applyHierarchyPaseoToolPolicy,
  assertTopicMainArchiveAllowed,
  buildHierarchyAppendSystemPrompt,
  computeAgentDepth,
  computeMaxSubtreeDepth,
  hasReservedHierarchyLabels,
  isMainControlWritePermissionBlocked,
  REMOTE_HIERARCHY_DEPTH_LABEL,
  resolveInheritedHierarchyMode,
  stripMainControlPromptHeader,
  TopicMainArchiveError,
  validateCanSpawnChild,
  validateSetAgentParent,
  validateSingleHopOrchestration,
  type HierarchyAgent,
  type TopicWorkspaceSnapshot,
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
const mainControlTools = [
  "list_profiles",
  "create_agent",
  "send_agent_prompt",
  "update_agent",
  "get_agent_status",
  "list_agents",
  "summarize_workspace_agents",
  "archive_agent",
  "reset_agent_session",
  "upsert_workspace_task",
  "list_workspace_tasks",
  "request_human_decision",
];

it("protects the current topic main without changing legacy or cross-workspace archive rules", () => {
  const workspace: TopicWorkspaceSnapshot = {
    workspaceId: "topic",
    topic: { summary: null, hideFromModel: true, mainAgentId: main.id },
  };
  const topicMain = { ...main, workspaceId: "topic" };
  expect(() => assertTopicMainArchiveAllowed(topicMain, workspace)).toThrow(TopicMainArchiveError);
  expect(() =>
    assertTopicMainArchiveAllowed({ ...lead, workspaceId: "topic" }, workspace),
  ).not.toThrow();
  expect(() =>
    assertTopicMainArchiveAllowed({ ...topicMain, workspaceId: "legacy" }, workspace),
  ).not.toThrow();
  expect(() =>
    assertTopicMainArchiveAllowed(
      { ...topicMain, workspaceId: "legacy" },
      { workspaceId: "legacy" },
    ),
  ).not.toThrow();
});

function testWorkspaceRegistry(cwd: string) {
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace",
    projectId: "project",
    cwd,
    kind: "directory",
    displayName: "Hierarchy test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  return {
    get: async (id: string) => (id === workspace.workspaceId ? workspace : null),
    listActive: async () => [workspace],
    update: async () => null,
  };
}

it("strips resident specialist instructions from replay with or without the Main Control header", () => {
  const specialistPrefix =
    "[Workspace Resident Specialists]\nRole: Build\n[/Workspace Resident Specialists]\n\n";
  const mainPrefix =
    "[Workspace Main Control Instructions]\nDelegate.\n[/Workspace Main Control Instructions: main]\n\n";
  const prompt = "Run the checks.";
  expect(stripMainControlPromptHeader(specialistPrefix + prompt, main.id)).toBe(prompt);
  expect(stripMainControlPromptHeader(mainPrefix + specialistPrefix + prompt, main.id)).toBe(
    prompt,
  );
  expect(stripMainControlPromptHeader(prompt + "\n" + specialistPrefix, main.id)).toBe(
    prompt + "\n" + specialistPrefix,
  );
});

it("strips leading task ledger snapshots from replay alongside other injected headers", () => {
  const ledger =
    "[Workspace Task Ledger]\nT1 in_progress Fix tests\n[/Workspace Task Ledger: main]\n\n";
  const specialists =
    "[Workspace Resident Specialists]\nRole: Build\n[/Workspace Resident Specialists]\n\n";
  const mainInstructions =
    "[Workspace Main Control Instructions]\nDelegate.\n[/Workspace Main Control Instructions: main]\n\n";
  const prompt = "Run the checks.";
  const userText = ledger.replace(": main]", "]") + prompt;
  expect(stripMainControlPromptHeader(userText, main.id)).toBe(userText);
  expect(stripMainControlPromptHeader(ledger + prompt, "another-agent")).toBe(ledger + prompt);
  expect(stripMainControlPromptHeader(ledger + prompt, main.id)).toBe(prompt);
  expect(
    stripMainControlPromptHeader(mainInstructions + specialists + ledger + prompt, main.id),
  ).toBe(prompt);
  expect(stripMainControlPromptHeader(prompt + "\n" + ledger, main.id)).toBe(
    prompt + "\n" + ledger,
  );
  expect(stripMainControlPromptHeader("[Workspace Task Ledger]\nIncomplete", main.id)).toBe(
    "[Workspace Task Ledger]\nIncomplete",
  );
});

it("preserves options in place and sends Main Control instructions on the first turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "main-control-first-turn-"));
  const provider = "antigravity";
  const providerPrompts: AgentPromptInput[] = [];
  const storage = new AgentStorage(join(cwd, "agents"), createTestLogger());
  const manager = new AgentManager({
    clients: {
      [provider]: createTestAgentClient(provider, {
        onStartTurn: (prompt) => providerPrompts.push(prompt),
      }),
    },
    registry: storage,
    logger: createTestLogger(),
  });
  try {
    const silentMain = await manager.createSilentWorkspaceMainAgent({
      workspaceId: "silent-workspace",
      config: { provider, cwd },
    });
    expect(silentMain.labels[WORKSPACE_ROLE_LABEL]).toBe(WORKSPACE_MAIN_ROLE);

    const providerOptions = { auto_accept: true };
    const agent = await manager.createAgent(
      { provider, cwd, modeId: "default", providerOptions },
      undefined,
      { workspaceId: "workspace" },
    );
    const initialSession = manager.getAgent(agent.id)?.session;
    const run = async (prompt: string) => {
      for await (const _event of manager.streamAgent(agent.id, prompt, {
        clientMessageId: prompt,
      })) {
        // Drain the turn before admitting another one.
      }
    };

    const promoted = await manager.setAgentMainControl(agent.id, true);
    expect(promoted.live).toBe(true);
    expect(manager.getAgent(agent.id)?.session).toBe(initialSession);
    expect(promoted.record.labels).toEqual(main.labels);
    expect(promoted.record.config).toMatchObject({ modeId: "default", providerOptions });
    expect(manager.getAgent(agent.id)?.effectiveOptions).toEqual(providerOptions);
    expect(isPaseoToolEnabled(manager.getPaseoToolPolicy(agent.id), "archive_workspace")).toBe(
      false,
    );

    const quoted =
      "[Workspace Main Control Instructions]\nRole: Workspace Main Control Coordinator.\nDirect Level-1 children: []\n\nQuoted text";
    await run(quoted);
    await run("Second");
    expect(providerPrompts[0]).toEqual(
      expect.stringMatching(/^\[Workspace Main Control Instructions\]/),
    );
    expect(providerPrompts[0]).toEqual(expect.stringContaining("summarize_workspace_agents"));
    expect(providerPrompts[1]).toBe("Second");
    expect(
      manager
        .getTimeline(agent.id)
        .flatMap((item) => (item.type === "user_message" ? [item.text] : [])),
    ).toEqual([quoted, "Second"]);

    // Write permission requests are still auto-denied under soft Main Control.
    const surfacedPermissions: string[] = [];
    const unsubscribe = manager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.event.type === "permission_requested") {
          surfacedPermissions.push(event.event.request.name);
        }
      },
      { agentId: agent.id, replayState: false },
    );
    try {
      await run("edit test.txt");
    } finally {
      unsubscribe();
    }
    expect(surfacedPermissions).toEqual([]);

    await manager.setAgentMainControl(agent.id, false);
    expect(manager.getPaseoToolPolicy(agent.id)).toBeUndefined();
    await manager.setAgentMainControl(agent.id, true);
    await run("Third");
    expect(providerPrompts[3]).toEqual(
      expect.stringMatching(/^\[Workspace Main Control Instructions\]/),
    );

    const directMain = await manager.createAgent({ provider, cwd }, undefined, {
      workspaceId: "direct-workspace",
      labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
    });
    expect(directMain.labels[WORKSPACE_ROLE_LABEL]).toBe(WORKSPACE_MAIN_ROLE);
  } finally {
    await Promise.all(manager.listAgents().map(({ id }) => manager.closeAgent(id)));
    await rm(cwd, { recursive: true, force: true });
  }
});

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
    const base = { disabledTools: ["custom_tool", "archive_agent"] };
    const mainPolicy = applyHierarchyPaseoToolPolicy(base, main.labels, 0);
    expect(mainPolicy?.disabledTools).toEqual(base.disabledTools);
    expect(mainPolicy?.allowedTools).toEqual(mainControlTools);
    expect(isPaseoToolEnabled(mainPolicy, "create_agent")).toBe(true);
    expect(isPaseoToolEnabled(mainPolicy, "request_human_decision")).toBe(true);
    expect(
      isPaseoToolEnabled(
        applyHierarchyPaseoToolPolicy(
          { disabledTools: ["request_human_decision"] },
          main.labels,
          0,
        ),
        "request_human_decision",
      ),
    ).toBe(false);
    expect(isPaseoToolEnabled(mainPolicy, "archive_agent")).toBe(false);
    expect(applyHierarchyPaseoToolPolicy(base, lead.labels, 1)).toBe(base);
    expect(applyHierarchyPaseoToolPolicy(undefined, root.labels, 0)).toBeUndefined();
    expect(applyHierarchyPaseoToolPolicy({ enabled: false }, worker.labels, 2)).toEqual({
      enabled: false,
      disabledTools: [
        "create_agent",
        "archive_workspace",
        "create_schedule",
        "update_schedule",
        "resume_schedule",
        "run_schedule_once",
        "send_agent_prompt",
        "update_agent",
        "cancel_agent",
        "archive_agent",
        "kill_agent",
        "reset_agent_session",
      ],
    });
  });

  it("keeps the Main Control prompt stable and lists direct children only for leads", () => {
    const explicitLead = {
      ...lead,
      labels: { ...lead.labels, [PARENT_REPORTING_LABEL]: EXPLICIT_PARENT_REPORTING },
    };
    const graph = hierarchy(worker, root, sibling, explicitLead, main, {
      ...child("archived", main),
      archivedAt: "2026-01-01",
    });
    const prompt = buildHierarchyAppendSystemPrompt({ agent: main, ...graph });
    expect(prompt).toContain("Workspace Main Control Coordinator");
    expect(prompt).toContain("Call list_profiles to select the preset");
    expect(prompt).toContain('parentReporting: "explicit" and notifyOnFinish: false');
    expect(prompt).toContain("combine list_workspace_tasks and summarize_workspace_agents");
    expect(prompt).toContain('"batch_implement"');
    expect(prompt).toContain('commitPolicy: "none"');
    expect(prompt).toContain("End your turn to wait for the lead to call report_to_parent");
    expect(prompt).toContain("stay read-only regardless of provider mode");
    expect(prompt).toContain(
      "Call request_human_decision only if the tool is available and the user needs to make a decision or accept a deliverable.",
    );
    expect(prompt).not.toMatch(/git (status|diff)|Direct Level-1 children/);
    expect(buildHierarchyAppendSystemPrompt({ agent: main, ...hierarchy(main) })).toBe(prompt);
    const leadPrompt = buildHierarchyAppendSystemPrompt({ agent: explicitLead, ...graph });
    expect(leadPrompt).toContain(
      "Level-1 Module Lead (Flexible Mode) under Main Control Agent main",
    );
    expect(leadPrompt).toContain(
      "For small-to-medium single-module tasks, complete the investigation, changes, and targeted verification yourself without spawning unnecessary Level-2 Sub-Agents.",
    );
    expect(leadPrompt).toContain(
      "Use create_agent to spawn Level-2 Sub-Agents only for cross-module parallel implementation or when the task explicitly requires role-isolated independent review or blind verification.",
    );
    expect(leadPrompt).not.toContain("Delegate substantive implementation");
    expect(leadPrompt).toContain('Direct Level-2 children: [{"id":"worker"');
    expect(leadPrompt).toContain("Call report_to_parent once all verification is complete");
    const playbookLead = {
      ...explicitLead,
      labels: {
        ...explicitLead.labels,
        [LEAD_PLAYBOOK_LABEL]: "batch_implement",
        [LEAD_COMMIT_POLICY_LABEL]: "scoped_only",
      },
    };
    const playbookLeadPrompt = buildHierarchyAppendSystemPrompt({
      agent: playbookLead,
      ...hierarchy(worker, playbookLead, main),
    });
    expect(playbookLeadPrompt).toContain(
      "Level-1 Batch Implementation Lead under Main Control Agent main",
    );
    expect(playbookLeadPrompt).toContain("git commit --only -- <owned files>");
    expect(playbookLeadPrompt).not.toContain("Flexible Mode");
    expect(playbookLeadPrompt).toContain('Direct Level-2 children: [{"id":"worker"');
    expect(playbookLeadPrompt).toContain("Call report_to_parent once all verification is complete");
    expect(hasReservedHierarchyLabels({ [LEAD_PLAYBOOK_LABEL]: "batch_implement" })).toBe(true);
    expect(hasReservedHierarchyLabels({ [LEAD_COMMIT_POLICY_LABEL]: "none" })).toBe(true);
    const autoLeadPrompt = buildHierarchyAppendSystemPrompt({ agent: lead, ...graph });
    expect(autoLeadPrompt).toContain("For small-to-medium single-module tasks");
    expect(autoLeadPrompt).not.toContain("Call report_to_parent");
    const explicitWorker = {
      ...worker,
      labels: { ...worker.labels, [PARENT_REPORTING_LABEL]: EXPLICIT_PARENT_REPORTING },
    };
    expect(buildHierarchyAppendSystemPrompt({ agent: explicitWorker, ...graph })).toBe(
      "Call report_to_parent once all verification is complete, with a concise outcome and changed files. If you need a decision from your parent to proceed, use report_to_parent with status blocked and the question.",
    );
    expect(buildHierarchyAppendSystemPrompt({ agent: worker, ...graph })).toBe("");
    expect(buildHierarchyAppendSystemPrompt({ agent: root, ...graph })).toBe("");
  });
});

it("launches explicit reporting instructions for a level-two or remote child", async () => {
  await withAgents(async ({ manager, cwd, launchedConfigs }) => {
    const config = { provider: "codex", cwd };
    const workspaceId = "workspace";
    const parent = await manager.createAgent(config, undefined, { workspaceId });
    await manager.setAgentMainControl(parent.id, true);
    const leadAgent = await manager.createAgent(config, undefined, {
      workspaceId,
      labels: { [PARENT_AGENT_ID_LABEL]: parent.id },
    });
    const launchedLeadPrompt = launchedConfigs.get("codex")?.at(-1)?.daemonAppendSystemPrompt;
    expect(launchedLeadPrompt).toContain("Level-1 Module Lead");
    expect(launchedLeadPrompt).toContain("only for cross-module parallel implementation");
    expect(launchedLeadPrompt).not.toContain("Delegate substantive implementation");
    expect(launchedLeadPrompt).not.toContain("Call report_to_parent");
    for (const labels of [
      { [PARENT_AGENT_ID_LABEL]: leadAgent.id },
      {
        [PARENT_AGENT_ID_LABEL]: parent.id,
        [PARENT_SERVER_ID_LABEL]: "remote-host",
        [REMOTE_HIERARCHY_DEPTH_LABEL]: "1",
      },
    ]) {
      await manager.createAgent(config, undefined, {
        workspaceId,
        labels: { ...labels, [PARENT_REPORTING_LABEL]: EXPLICIT_PARENT_REPORTING },
      });
      const prompt = launchedConfigs.get("codex")?.at(-1)?.daemonAppendSystemPrompt;
      expect(prompt).toContain("Call report_to_parent");
      expect(prompt).not.toContain("Level-1 Module Lead");
    }
  });
});

describe("Main Control mode inheritance and permission requests", () => {
  it("inherits the mode the caller chose, or the saved mode for a legacy read-only caller", () => {
    const legacyLabels = { ...main.labels, [MAIN_PRIOR_MODE_ID_LABEL]: "full-access" };
    expect(resolveInheritedHierarchyMode("read-only", legacyLabels)).toBe("full-access");
    expect(resolveInheritedHierarchyMode("workspace-write", legacyLabels)).toBe("workspace-write");
    expect(resolveInheritedHierarchyMode("read-only", main.labels)).toBe("read-only");
    expect(resolveInheritedHierarchyMode("read-only", lead.labels)).toBe("read-only");
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
    "TodoWrite",
  ])("denies %s approval", (name) =>
    expect(isMainControlWritePermissionBlocked({ kind: "tool", name })).toBe(true),
  );

  it("uses structured file details and allows shell commands and questions", () => {
    expect(
      isMainControlWritePermissionBlocked({
        kind: "tool",
        name: "custom",
        detail: { type: "edit", filePath: "/repo/file" },
      }),
    ).toBe(true);
    expect(
      isMainControlWritePermissionBlocked({
        kind: "tool",
        name: "custom",
        detail: { type: "write", filePath: "/repo/file" },
      }),
    ).toBe(true);
    expect(
      isMainControlWritePermissionBlocked({
        kind: "tool",
        name: "custom",
        detail: { type: "shell", command: "pwd" },
      }),
    ).toBe(false);
    for (const name of [
      "Bash",
      "shell",
      "exec",
      "run-command",
      "executeCommand",
      "run_terminal_cmd",
    ]) {
      expect(isMainControlWritePermissionBlocked({ kind: "tool", name })).toBe(false);
    }
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
    codex: ReturnType<typeof createTestAgentClient>;
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
  const codex = wrapClient("codex");
  const manager = new AgentManager({
    serverId: "local-host",
    clients: { codex, claude: wrapClient("claude") },
    registry: storage,
    logger,
  });
  try {
    await run({ manager, storage, cwd, launchedConfigs, codex });
  } finally {
    manager.prepareForShutdown();
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    await manager.flushForShutdown();
    await storage.flush();
    await rm(cwd, { force: true, recursive: true });
  }
}

it("preapproves just Main Control's enabled tools on the injected Paseo server", async () => {
  await withAgents(async ({ manager, storage, cwd, launchedConfigs }) => {
    manager.setMcpBaseUrl("http://localhost:1234/mcp/agents");
    const config = { provider: "codex", cwd };
    const mainAgent = await manager.createAgent(config, undefined, {
      workspaceId: "workspace",
      labels: main.labels,
    });
    const launches = launchedConfigs.get("codex")!;
    const expected = {
      preapproved: mainControlTools.map((tool) => ({ kind: "mcp", server: "paseo", tool })),
    };
    expect(resolveRuntimeMcpToolPolicy(launches.at(-1)!)).toEqual(expected);
    expect((await storage.get(mainAgent.id))?.config?.toolPolicy).toBeUndefined();

    await manager.reloadAgentSession(mainAgent.id);
    expect(resolveRuntimeMcpToolPolicy(launches.at(-1)!)).toEqual(expected);
    await manager.setAgentMainControl(mainAgent.id, false);
    expect(resolveRuntimeMcpToolPolicy(launches.at(-1)!)).toBeUndefined();

    expect(
      resolveRuntimeMcpToolPolicy({
        ...config,
        mcpServers: { paseo: { type: "http", url: "https://example.invalid/tools" } },
      }),
    ).toBeUndefined();
  });
});

it("switches live Main Control without overriding either agent's mode or Codex options", async () => {
  await withAgents(async ({ manager, storage, cwd, launchedConfigs }) => {
    const options = { workspaceId: "workspace" };
    const make = (title: string) =>
      manager.createAgent(
        {
          provider: "codex",
          cwd,
          title,
          modeId: "full-access",
          providerOptions: { sandbox_mode: "danger-full-access", approval_policy: "on-request" },
        },
        undefined,
        options,
      );
    const first = await make("First");
    const second = await make("Second");

    await manager.setAgentMainControl(first.id, true);
    await manager.setAgentMainControl(first.id, true);
    expect(manager.getAgent(first.id)?.currentModeId).toBe("full-access");
    expect((await storage.get(first.id))?.labels).toEqual(main.labels);
    expect(launchedConfigs.get("codex")?.at(-1)).toMatchObject({
      modeId: "full-access",
      providerOptions: { sandbox_mode: "danger-full-access", approval_policy: "on-request" },
      daemonAppendSystemPrompt: expect.stringContaining("Workspace Main Control Coordinator"),
    });
    await expect(manager.setAgentMode(first.id, "workspace-write")).resolves.toBeNull();
    await expect(
      manager.setAgentOptions(first.id, {
        sandbox_mode: "workspace-write",
        approval_policy: "never",
      }),
    ).resolves.toBeUndefined();
    expect(isPaseoToolEnabled(manager.getPaseoToolPolicy(first.id), "send_terminal_keys")).toBe(
      false,
    );
    await manager.setAgentMainControl(second.id, true);
    expect(manager.getAgent(first.id)?.currentModeId).toBe("workspace-write");
    expect(manager.getAgent(first.id)?.config.providerOptions).toEqual({
      sandbox_mode: "workspace-write",
      approval_policy: "never",
    });
    expect((await storage.get(first.id))?.labels).toEqual({});
    expect(manager.getPaseoToolPolicy(first.id)).toBeUndefined();
    expect(manager.getAgent(second.id)?.currentModeId).toBe("full-access");
    expect((await storage.get(second.id))?.labels[WORKSPACE_ROLE_LABEL]).toBe(WORKSPACE_MAIN_ROLE);
  });
});

function legacyReadOnlyMain(record: StoredAgentRecord): StoredAgentRecord {
  return {
    ...record,
    labels: { ...record.labels, [MAIN_PRIOR_MODE_ID_LABEL]: "full-access" },
    config: { ...record.config, modeId: "read-only" },
    lastModeId: "read-only",
  };
}

it.each([true, false])(
  "passes the saved mode to same-host child creation for legacy=$legacy",
  async (legacy) => {
    await withAgents(async ({ manager, storage, cwd }) => {
      const record = await manager.createSilentWorkspaceMainAgent({
        config: { provider: "codex", cwd, modeId: "read-only" },
        workspaceId: "workspace",
      });
      if (legacy) await storage.upsert(legacyReadOnlyMain(record));
      await manager.createAgentFromRecord(record.id);
      const { manager: providerSnapshotManager, resolveCreateConfig } =
        createProviderSnapshotManagerStub();
      resolveCreateConfig.mockImplementation(async ({ parent }) => ({
        modeId: parent?.currentModeId ?? undefined,
      }));
      const catalog = createPaseoToolCatalog({
        agentManager: manager,
        agentStorage: storage,
        providerSnapshotManager,
        callerAgentId: record.id,
        workspaceRegistry: testWorkspaceRegistry(cwd),
        logger: createTestLogger(),
      });
      const result = await catalog.executeTool("create_agent", {
        provider: "codex/gpt-5",
        title: "Inherited mode",
        initialPrompt: "Inspect the workspace",
        notifyOnFinish: false,
      });
      expect(result.isError).not.toBe(true);
      const childId = (result.structuredContent as { agentId: string }).agentId;
      expect((await storage.get(childId))?.config?.modeId).toBe(
        legacy ? "full-access" : "read-only",
      );
    });
  },
);

it.each([
  { live: false, selectMode: null, finalMode: "full-access" },
  { live: true, selectMode: null, finalMode: "full-access" },
  { live: true, selectMode: "workspace-write", finalMode: "workspace-write" },
  { live: true, selectMode: "read-only", finalMode: "read-only" },
])(
  "disables a legacy Main Control with live=$live and selection=$selectMode",
  async ({ live, selectMode, finalMode }) => {
    await withAgents(async ({ manager, storage, cwd, launchedConfigs }) => {
      const config = {
        provider: "codex",
        cwd,
        modeId: "full-access",
        providerOptions: { approval_policy: "on-request" },
      };
      const mainAgent = await manager.createSilentWorkspaceMainAgent({
        config,
        workspaceId: "workspace",
      });
      expect(mainAgent.labels).toEqual(main.labels);
      expect(mainAgent.config).toMatchObject({
        modeId: "full-access",
        providerOptions: config.providerOptions,
      });
      await storage.upsert(legacyReadOnlyMain(mainAgent));
      if (live) {
        await manager.createAgentFromRecord(mainAgent.id);
        expect(manager.getAgent(mainAgent.id)?.currentModeId).toBe("read-only");
        expect(launchedConfigs.get("codex")?.at(-1)?.providerOptions).toEqual(
          config.providerOptions,
        );
      }
      if (selectMode) {
        await manager.setAgentMode(mainAgent.id, selectMode);
        expect(manager.getAgent(mainAgent.id)?.labels).toEqual(main.labels);
        expect(await storage.get(mainAgent.id)).toMatchObject({
          labels: main.labels,
          lastModeId: selectMode,
        });
      }
      const result = await manager.setAgentMainControl(mainAgent.id, false);
      expect(result.record).toMatchObject({
        labels: {},
        lastModeId: finalMode,
        config: { modeId: finalMode, providerOptions: config.providerOptions },
      });
      if (live) {
        expect(await manager.getAgent(mainAgent.id)?.session?.getCurrentMode()).toBe(finalMode);
      }
    });
  },
);

it("keeps the old mode and marker when saving an explicit replacement mode fails", async () => {
  await withAgents(async ({ manager, storage, cwd }) => {
    const mainAgent = await manager.createSilentWorkspaceMainAgent({
      config: { provider: "codex", cwd, modeId: "read-only" },
      workspaceId: "workspace",
    });
    const legacy = legacyReadOnlyMain(mainAgent);
    await storage.upsert(legacy);
    await manager.createAgentFromRecord(mainAgent.id);

    vi.spyOn(storage, "applySnapshot").mockRejectedValueOnce(new Error("Save failed"));
    await expect(manager.setAgentMode(mainAgent.id, "workspace-write")).rejects.toThrow(
      "Save failed",
    );
    const live = manager.getAgent(mainAgent.id);
    expect(await live?.session?.getCurrentMode()).toBe("read-only");
    expect(live?.labels).toEqual(legacy.labels);
    expect(await storage.get(mainAgent.id)).toMatchObject({
      labels: legacy.labels,
      lastModeId: "read-only",
    });

    const demoted = await manager.setAgentMainControl(mainAgent.id, false);
    expect(demoted.record).toMatchObject({ labels: {}, lastModeId: "full-access" });
  });
});

it("serializes an explicit mode selection with a failed Main Control handoff", async () => {
  await withAgents(async ({ manager, storage, cwd }) => {
    const workspaceId = "workspace";
    const config = { provider: "codex", cwd, modeId: "read-only" };
    const mainAgent = await manager.createSilentWorkspaceMainAgent({ config, workspaceId });
    await storage.upsert(legacyReadOnlyMain(mainAgent));
    await manager.createAgentFromRecord(mainAgent.id);
    const next = await manager.createAgent(config, undefined, { workspaceId });
    await manager.closeAgent(next.id);

    vi.spyOn(storage, "upsert").mockRejectedValueOnce(new Error("Promotion failed"));
    const selection = manager.setAgentMode(mainAgent.id, "read-only");
    const promotion = manager.setAgentMainControl(next.id, true);
    await expect(promotion).rejects.toThrow("Promotion failed");
    await selection;

    const restored = await storage.get(mainAgent.id);
    expect(restored?.labels).toEqual(main.labels);
    expect(restored?.lastModeId).toBe("read-only");
    const demoted = await manager.setAgentMainControl(mainAgent.id, false);
    expect(demoted.record).toMatchObject({ labels: {}, lastModeId: "read-only" });
  });
});

it("transfers Main Control children and archives the source under the same operation", async () => {
  await withAgents(async ({ manager, storage, cwd }) => {
    const workspaceId = "workspace";
    const config = { provider: "codex", cwd };
    const source = await manager.createSilentWorkspaceMainAgent({ config, workspaceId });
    const replacement = await manager.createAgent(config, undefined, { workspaceId });
    const childAgent = await manager.createAgent(config, undefined, {
      workspaceId,
      labels: { [PARENT_AGENT_ID_LABEL]: source.id },
    });
    await manager.closeAgent(childAgent.id);
    await expect(
      manager.setAgentMainControl(replacement.id, true, {
        handoffFromAgentId: source.id,
        archiveSource: true,
        assertNoRemoteChildren: async () => {
          throw new Error("Connected host unavailable");
        },
      }),
    ).rejects.toThrow("Connected host unavailable");
    expect((await storage.get(childAgent.id))?.labels[PARENT_AGENT_ID_LABEL]).toBe(source.id);
    expect((await storage.get(source.id))?.labels[WORKSPACE_ROLE_LABEL]).toBe(WORKSPACE_MAIN_ROLE);

    await expect(
      manager.setAgentMainControl(replacement.id, true, {
        handoffFromAgentId: source.id,
        archiveSource: true,
      }),
    ).resolves.toMatchObject({ archivedSource: true });
    expect(await storage.get(childAgent.id)).toMatchObject({
      labels: { [PARENT_AGENT_ID_LABEL]: replacement.id },
    });
    expect((await storage.get(childAgent.id))?.archivedAt).toBeFalsy();
    expect((await storage.get(source.id))?.archivedAt).toBeTruthy();
    expect((await storage.get(replacement.id))?.labels[WORKSPACE_ROLE_LABEL]).toBe(
      WORKSPACE_MAIN_ROLE,
    );
  });
});

it.each(["before archive", "after archive", "during compensation"] as const)(
  "keeps Main Control handoff consistent when storage fails %s",
  async (failure) => {
    await withAgents(async ({ manager, storage, cwd }) => {
      const workspaceId = "workspace";
      const config = { provider: "codex", cwd, modeId: "full-access" };
      const source = await manager.createSilentWorkspaceMainAgent({ config, workspaceId });
      const target = await manager.createAgent(config, undefined, { workspaceId });
      const childAgent = await manager.createAgent(config, undefined, {
        workspaceId,
        labels: { [PARENT_AGENT_ID_LABEL]: source.id },
      });
      await manager.closeAgent(childAgent.id);
      let archiveAttempted = false;
      const upsert = storage.upsert.bind(storage);
      const write = vi.spyOn(storage, "upsert").mockImplementation(async (record) => {
        if (record.id === source.id && record.archivedAt) {
          archiveAttempted = true;
          if (failure === "after archive") await upsert(record);
          throw new Error("archive write interrupted");
        }
        if (record.id === childAgent.id && archiveAttempted && failure === "during compensation") {
          throw new Error("cannot restore child record");
        }
        await upsert(record);
      });
      try {
        await expect(
          manager.setAgentMainControl(target.id, true, {
            handoffFromAgentId: source.id,
            archiveSource: true,
          }),
        ).rejects.toThrow(
          {
            "before archive": "archive write interrupted",
            "after archive": "handoff committed, but archive cleanup failed",
            "during compensation": `Failed to restore parent of ${childAgent.id}: cannot restore child record`,
          }[failure],
        );
      } finally {
        write.mockRestore();
      }
      const committed = failure === "after archive";
      const storedSource = await storage.get(source.id);
      expect(Boolean(storedSource?.archivedAt)).toBe(committed);
      expect(storedSource?.labels[WORKSPACE_ROLE_LABEL]).toBe(
        committed ? undefined : WORKSPACE_MAIN_ROLE,
      );
      expect((await storage.get(target.id))?.labels[WORKSPACE_ROLE_LABEL]).toBe(
        committed ? WORKSPACE_MAIN_ROLE : undefined,
      );
      expect(manager.getAgent(target.id)?.currentModeId).toBe("full-access");
      expect((await storage.get(childAgent.id))?.labels[PARENT_AGENT_ID_LABEL]).toBe(
        failure === "before archive" ? source.id : target.id,
      );
    });
  },
);

it("retains an uncertain remote child reservation until the destination confirms it", async () => {
  await withAgents(async ({ manager, cwd }) => {
    const workspaceId = "workspace";
    const config = { provider: "codex", cwd };
    const source = await manager.createAgent(config, undefined, { workspaceId });
    const parent = await manager.createAgent(config, undefined, { workspaceId });
    const reservation = await manager.reserveRemoteChild(source.id, "remote-host");
    expect(reservation.depth).toBe(1);
    await expect(manager.setAgentParent(source.id, parent.id)).rejects.toThrow("in progress");
    reservation.finish("unknown");
    await expect(manager.setAgentParent(source.id, parent.id)).rejects.toThrow(
      "outcome is unknown",
    );
    const check = vi.fn(async () => true);
    await expect(
      manager.setAgentParent(
        source.id,
        parent.id,
        undefined,
        undefined,
        async () => {
          throw new Error("Remote child found");
        },
        check,
      ),
    ).rejects.toThrow("Remote child found");
    expect(check).toHaveBeenCalledWith("remote-host", reservation.id);
  });
});

it("checks remote children of every affected local descendant before detaching a branch", async () => {
  await withAgents(async ({ manager, storage, cwd }) => {
    const options = { workspaceId: "workspace" };
    const config = { provider: "codex", cwd };
    const rootAgent = await manager.createAgent(config, undefined, options);
    const branch = await manager.createAgent(config, undefined, {
      ...options,
      labels: { [PARENT_AGENT_ID_LABEL]: rootAgent.id },
    });
    const childAgent = await manager.createAgent(config, undefined, {
      ...options,
      labels: { [PARENT_AGENT_ID_LABEL]: branch.id },
    });
    const checkRemoteDepths = vi.fn(async (ids: ReadonlySet<string>) => {
      expect(ids).toEqual(new Set([branch.id, childAgent.id]));
      throw new Error("Cannot detach while a host cannot be checked");
    });
    await expect(manager.detachAgent(branch.id, checkRemoteDepths)).rejects.toThrow(
      "host cannot be checked",
    );
    expect(checkRemoteDepths).toHaveBeenCalledOnce();
    expect((await storage.get(branch.id))?.labels[PARENT_AGENT_ID_LABEL]).toBe(rootAgent.id);
    expect((await storage.get(childAgent.id))?.labels[PARENT_AGENT_ID_LABEL]).toBe(branch.id);

    const checkShallowerParent = vi.fn(async () => {
      throw new Error("Cannot check remote depth");
    });
    await expect(
      manager.setAgentParent(
        childAgent.id,
        rootAgent.id,
        undefined,
        undefined,
        checkShallowerParent,
      ),
    ).rejects.toThrow("Cannot check remote depth");
    expect(checkShallowerParent).toHaveBeenCalledWith(new Set([childAgent.id]));
    expect((await storage.get(childAgent.id))?.labels[PARENT_AGENT_ID_LABEL]).toBe(branch.id);
  });
});

it("closes an opening child when its parent is being archived", async () => {
  await withAgents(async ({ manager, storage, cwd, codex }) => {
    const workspaceId = "workspace";
    const config = { provider: "codex", cwd };
    const parent = await manager.createAgent(config, undefined, { workspaceId });
    let started!: () => void;
    let finish!: () => void;
    const opening = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finishOpening = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const create = codex.createSession.bind(codex);
    let closeChild: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(codex, "createSession").mockImplementationOnce(async (...args) => {
      const session = await create(...args);
      closeChild = vi.spyOn(session, "close");
      started();
      await finishOpening;
      return session;
    });
    const childId = randomUUID();
    const childAgent = manager.createAgent(config, childId, {
      workspaceId,
      labels: { [PARENT_AGENT_ID_LABEL]: parent.id },
    });
    await Promise.race([opening, childAgent]);
    const archive = manager.archiveAgent(parent.id);
    const rejected = expect(childAgent).rejects.toThrow("missing or archived");
    finish();
    await Promise.all([archive, rejected]);
    expect(closeChild).toHaveBeenCalledOnce();
    expect(await storage.get(childId)).toBeNull();
  });
});

it("resolves an inherited workspace after the parent's queued move", async () => {
  await withAgents(async ({ manager, storage, cwd }) => {
    const workspaceId = "origin";
    const config = { provider: "codex", cwd };
    const rootAgent = await manager.createAgent(config, undefined, { workspaceId });
    const parent = await manager.createAgent(config, undefined, {
      workspaceId,
      labels: { [PARENT_AGENT_ID_LABEL]: rootAgent.id },
    });
    const move = manager.moveSubagentToWorkspace(parent.id, {
      allocateWorkspace: async () => ({ workspaceId: "destination" }),
    });
    const labels = { [PARENT_AGENT_ID_LABEL]: parent.id };
    const inherited = manager.createAgent(config, undefined, {
      workspaceId,
      inheritParentWorkspace: true,
      labels,
    });
    const explicit = manager.createAgent(config, undefined, { workspaceId, labels });
    const [, inheritedAgent] = await Promise.all([
      move,
      inherited,
      expect(explicit).rejects.toThrow("Subagents must reuse the current workspace"),
    ]);
    expect((await storage.get(inheritedAgent.id))?.workspaceId).toBe("destination");
  });
});

it("restores an archived former Main as an ordinary session when a new Main exists", async () => {
  await withAgents(async ({ manager, storage, cwd }) => {
    const workspaceId = "workspace";
    const config = { provider: "codex", cwd, modeId: "full-access" };
    const former = await manager.createSilentWorkspaceMainAgent({ workspaceId, config });
    await storage.upsert(legacyReadOnlyMain(former));
    await manager.archiveSnapshot(former.id, new Date().toISOString());
    const current = await manager.createSilentWorkspaceMainAgent({ workspaceId, config });

    await expect(manager.unarchiveSnapshot(former.id)).resolves.toBe(true);
    const records = await storage.listByWorkspaces([workspaceId]);
    expect(
      records
        .filter(({ labels }) => labels[WORKSPACE_ROLE_LABEL] === WORKSPACE_MAIN_ROLE)
        .map(({ id }) => id),
    ).toEqual([current.id]);
    expect(await storage.get(former.id)).toMatchObject({
      archivedAt: null,
      labels: {},
      lastModeId: "full-access",
    });
    expect(manager.listAgents()).toEqual([]);
  });
});

it("keeps pending turns intact when either Main Control role is busy", async () => {
  await withAgents(async ({ manager, storage, cwd }) => {
    const options = { workspaceId: "workspace" };
    const config = { provider: "codex", cwd, modeId: "full-access" };
    const first = await manager.createAgent(config, undefined, options);
    const next = await manager.createAgent(config, undefined, options);
    await manager.setAgentMainControl(first.id, true);

    for (const busy of [next.id, first.id]) {
      const session = manager.getAgent(busy)?.session;
      const turn = manager.streamAgent(busy, "Continue the current task");
      try {
        await expect(manager.setAgentMainControl(next.id, true)).rejects.toThrow(
          "Wait for active work to finish",
        );
        if (busy === first.id) {
          await expect(manager.setAgentMainControl(first.id, false)).rejects.toThrow(
            "Wait for active work to finish",
          );
        }
        expect(manager.getAgent(busy)?.session).toBe(session);
        expect(manager.hasInFlightRun(busy)).toBe(true);
        expect((await storage.get(first.id))?.labels[WORKSPACE_ROLE_LABEL]).toBe(
          WORKSPACE_MAIN_ROLE,
        );
        expect((await storage.get(next.id))?.labels[WORKSPACE_ROLE_LABEL]).toBeUndefined();
      } finally {
        const events = await Array.fromAsync(turn);
        expect(events.some((event) => event.type === "turn_completed")).toBe(true);
      }
    }
  });
});

it("starts a new prompt on the replacement session when a Main Control switch is in progress", async () => {
  await withAgents(async ({ manager, cwd }) => {
    const agent = await manager.createAgent(
      { provider: "codex", cwd, modeId: "workspace-write" },
      undefined,
      {
        workspaceId: "workspace",
      },
    );
    const session = manager.getAgent(agent.id)?.session;
    if (!session) throw new Error("Expected a live session");
    const closing = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    const close = session.close.bind(session);
    vi.spyOn(session, "close").mockImplementationOnce(async () => {
      closing.resolve();
      await releaseClose.promise;
      await close();
    });
    const switchRole = manager.setAgentMainControl(agent.id, true);
    try {
      await Promise.race([closing.promise, switchRole]);
      const run = manager.runAgent(agent.id, "Run after the role changes");
      expect(manager.hasInFlightRun(agent.id)).toBe(false);
      releaseClose.resolve();
      await switchRole;
      await expect(run).resolves.toMatchObject({ canceled: false });
      expect(manager.getAgent(agent.id)?.session).not.toBe(session);
      expect(manager.getAgent(agent.id)?.currentModeId).toBe("workspace-write");
    } finally {
      releaseClose.resolve();
      await switchRole;
    }
  });
});

it("refreshes both sets of direct children before their next turns after switching Main Control", async () => {
  await withAgents(async ({ manager, cwd, launchedConfigs }) => {
    const workspaceId = "workspace";
    const make = (title: string, parentId?: string) =>
      manager.createAgent({ provider: "codex", cwd, title }, undefined, {
        workspaceId,
        labels: parentId ? { [PARENT_AGENT_ID_LABEL]: parentId } : {},
      });
    const first = await make("First");
    const next = await make("Next");
    const firstChild = await make("First child", first.id);
    const nextChild = await make("Next child", next.id);
    const getLaunches = (title: string) =>
      (launchedConfigs.get("codex") ?? []).filter((config) => config.title === title);

    await manager.setAgentMainControl(first.id, true);
    expect(getLaunches("First child")).toHaveLength(1);
    await manager.runAgent(firstChild.id, "Work as a lead");
    expect(getLaunches("First child").at(-1)?.daemonAppendSystemPrompt).toContain(
      "Level-1 Module Lead",
    );

    const existingTurn = manager.streamAgent(firstChild.id, "Finish the current task");
    try {
      await manager.setAgentMainControl(next.id, true);
      expect(getLaunches("First child")).toHaveLength(2);
      expect(getLaunches("Next child")).toHaveLength(1);
      expect(manager.hasInFlightRun(firstChild.id)).toBe(true);
    } finally {
      const events = await Array.fromAsync(existingTurn);
      expect(events.some((event) => event.type === "turn_completed")).toBe(true);
    }
    await manager.runAgent(firstChild.id, "Work without the lead role");
    await manager.runAgent(nextChild.id, "Work as a lead");
    expect(getLaunches("First child")).toHaveLength(3);
    expect(getLaunches("First child").at(-1)?.daemonAppendSystemPrompt ?? "").not.toContain(
      "Level-1 Module Lead",
    );
    expect(getLaunches("Next child").at(-1)?.daemonAppendSystemPrompt).toContain(
      "Level-1 Module Lead",
    );
  });
});

it("queues an explicit replacement while the Main Control runtime is reopening", async () => {
  await withAgents(async ({ manager, cwd, codex }) => {
    const agent = await manager.createAgent(
      { provider: "codex", cwd, modeId: "workspace-write" },
      undefined,
      {
        workspaceId: "workspace",
      },
    );
    const reopening = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const resume = codex.resumeSession.bind(codex);
    vi.spyOn(codex, "resumeSession").mockImplementationOnce(async (...args) => {
      reopening.resolve();
      await release.promise;
      return resume(...args);
    });

    const switchRole = manager.setAgentMainControl(agent.id, true);
    try {
      await Promise.race([reopening.promise, switchRole]);
      expect(manager.getAgent(agent.id)).toBeNull();
      const turn = await manager.replaceAgentRun(agent.id, "Work in Main Control");
      release.resolve();
      const events = await Array.fromAsync(turn);
      expect(events.some((event) => event.type === "turn_completed")).toBe(true);
      expect(manager.getAgent(agent.id)?.currentModeId).toBe("workspace-write");
    } finally {
      release.resolve();
      await switchRole;
    }
  });
});

it("waits for a parent's role change before starting an idle child's turn", async () => {
  await withAgents(async ({ manager, cwd, launchedConfigs }) => {
    const options = { workspaceId: "workspace" };
    const parent = await manager.createAgent({ provider: "codex", cwd }, undefined, options);
    const childAgent = await manager.createAgent(
      { provider: "codex", cwd, title: "Child" },
      undefined,
      {
        ...options,
        labels: { [PARENT_AGENT_ID_LABEL]: parent.id },
      },
    );
    const session = manager.getAgent(parent.id)?.session;
    if (!session) throw new Error("Expected a live parent");
    const closing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const close = session.close.bind(session);
    vi.spyOn(session, "close").mockImplementationOnce(async () => {
      closing.resolve();
      await release.promise;
      await close();
    });

    const switchRole = manager.setAgentMainControl(parent.id, true);
    try {
      await Promise.race([closing.promise, switchRole]);
      const run = manager.runAgent(childAgent.id, "Work as a lead");
      expect(manager.hasInFlightRun(childAgent.id)).toBe(false);
      release.resolve();
      await expect(run).resolves.toMatchObject({ canceled: false });
      expect(launchedConfigs.get("codex")?.at(-1)?.daemonAppendSystemPrompt).toContain(
        "Level-1 Module Lead",
      );
    } finally {
      release.resolve();
      await switchRole;
    }
  });
});

it("refreshes a child that resumed with the old role during a parent's role change", async () => {
  await withAgents(async ({ manager, cwd, codex, launchedConfigs }) => {
    const options = { workspaceId: "workspace" };
    const parent = await manager.createAgent({ provider: "codex", cwd }, undefined, options);
    const childAgent = await manager.createAgent(
      { provider: "codex", cwd, title: "Child" },
      undefined,
      { ...options, labels: { [PARENT_AGENT_ID_LABEL]: parent.id } },
    );
    if (!childAgent.persistence) throw new Error("Expected a persisted child");
    await manager.closeAgent(childAgent.id);

    const opening = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const resume = codex.resumeSession.bind(codex);
    vi.spyOn(codex, "resumeSession").mockImplementationOnce(async (...args) => {
      opening.resolve();
      await release.promise;
      return resume(...args);
    });

    const resumeChild = manager.resumeAgentFromPersistence(
      childAgent.persistence,
      { cwd, title: "Child" },
      childAgent.id,
    );
    try {
      await Promise.race([opening.promise, resumeChild]);
      await manager.setAgentMainControl(parent.id, true);
      release.resolve();
      await resumeChild;
      const childLaunch = () =>
        launchedConfigs.get("codex")?.findLast((config) => config.title === "Child");
      expect(childLaunch()?.daemonAppendSystemPrompt ?? "").not.toContain("Level-1 Module Lead");
      await expect(manager.runAgent(childAgent.id, "Work as a lead")).resolves.toMatchObject({
        canceled: false,
      });
      expect(childLaunch()?.daemonAppendSystemPrompt).toContain("Level-1 Module Lead");
    } finally {
      release.resolve();
      await resumeChild;
    }
  });
});

it("denies workspace archive and worktree creation for Main Control before looking up the workspace", async () => {
  await withAgents(async ({ manager, storage, cwd }) => {
    const make = () =>
      manager.createAgent({ provider: "codex", cwd }, undefined, {
        workspaceId: "workspace",
      });
    const mainAgent = await make();
    const ordinary = await make();
    const listActiveWorkspaces = vi.fn(async () => []);
    const catalog = (callerAgentId: string) =>
      createPaseoToolCatalog({
        agentManager: manager,
        agentStorage: storage,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        callerAgentId,
        listActiveWorkspaces,
        logger: createTestLogger(),
      });
    const openMainCatalog = catalog(mainAgent.id);
    await manager.setAgentMainControl(mainAgent.id, true);
    expect(isPaseoToolEnabled(manager.getPaseoToolPolicy(mainAgent.id), "archive_workspace")).toBe(
      false,
    );
    const request = { workspaceId: "missing" };
    await expect(openMainCatalog.executeTool("archive_workspace", request)).rejects.toThrow(
      "Paseo tool is disabled for your hierarchy role: archive_workspace",
    );
    for (const target of [{}, { serverId: "remote-host" }]) {
      await expect(
        openMainCatalog.executeTool("create_workspace", { isolation: "worktree", ...target }),
      ).rejects.toThrow("Agent sessions cannot create a project or workspace");
    }
    expect(listActiveWorkspaces).not.toHaveBeenCalled();
    await expect(catalog(ordinary.id).executeTool("archive_workspace", request)).rejects.toThrow(
      "Workspace not found",
    );
    expect(listActiveWorkspaces).toHaveBeenCalledOnce();
  });
});

it("refuses to restore a fourth-tier agent before restoring its native session", async () => {
  await withAgents(async ({ manager, storage, cwd, codex }) => {
    const restoreNative = vi.fn(async () => {});
    Object.assign(codex, { unarchiveNativeSession: restoreNative });
    const options = { workspaceId: "workspace" };
    const config = { provider: "codex", cwd };
    const create = (parentId?: string) =>
      manager.createAgent(config, undefined, {
        ...options,
        labels: parentId ? { [PARENT_AGENT_ID_LABEL]: parentId } : undefined,
      });
    const newParent = await create();
    const branch = await create();
    const localChild = await create(branch.id);
    const grandchild = await create(localChild.id);
    await manager.archiveAgent(grandchild.id);
    const archived = await storage.get(grandchild.id);
    expect(archived?.archivedAt).toBeTruthy();
    await manager.setAgentParent(branch.id, newParent.id);

    await expect(manager.unarchiveSnapshot(grandchild.id)).rejects.toThrow(
      "maximum hierarchy depth",
    );
    expect(restoreNative).not.toHaveBeenCalled();
    expect(await storage.get(grandchild.id)).toEqual(archived);
    expect(manager.getAgent(grandchild.id)).toBeNull();
  });
});

it("restores a remote child without counting an unrelated local parent with the same ID", async () => {
  await withAgents(async ({ manager, storage, cwd }) => {
    const config = { provider: "codex", cwd };
    const createLocal = (parentId?: string) =>
      manager.createAgent(config, undefined, {
        workspaceId: "workspace",
        labels: parentId ? { [PARENT_AGENT_ID_LABEL]: parentId } : undefined,
      });
    const localRoot = await createLocal();
    const localChild = await createLocal(localRoot.id);
    const sameIdAsRemoteParent = await createLocal(localChild.id);
    const remoteChild = await createLocal();
    await manager.archiveAgent(remoteChild.id);
    const archived = await storage.get(remoteChild.id);
    if (!archived) throw new Error("Missing archived agent");
    await storage.upsert({
      ...archived,
      labels: {
        [PARENT_AGENT_ID_LABEL]: sameIdAsRemoteParent.id,
        [PARENT_SERVER_ID_LABEL]: "remote-host",
        [REMOTE_HIERARCHY_DEPTH_LABEL]: "1",
      },
    });
    await expect(manager.unarchiveSnapshot(remoteChild.id)).resolves.toBe(true);
  });
});

it("refreshes the child's instructions before a user replaces its current turn", async () => {
  await withAgents(async ({ manager, cwd, launchedConfigs }) => {
    const workspaceId = "workspace";
    const parent = await manager.createAgent({ provider: "codex", cwd }, undefined, {
      workspaceId,
    });
    const childAgent = await manager.createAgent(
      { provider: "claude", cwd, modeId: "default" },
      undefined,
      { workspaceId, labels: { [PARENT_AGENT_ID_LABEL]: parent.id } },
    );
    const held = Promise.withResolvers<void>();
    const unsubscribe = manager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.event.type === "permission_requested") {
          held.resolve();
        }
      },
      { agentId: childAgent.id, replayState: false },
    );
    const running = manager.runAgent(childAgent.id, "edit test.txt");
    try {
      await Promise.race([
        held.promise,
        running.then(() => {
          throw new Error("Expected the original turn to be held");
        }),
      ]);
      await manager.setAgentMainControl(parent.id, true);
      expect(launchedConfigs.get("claude")).toHaveLength(1);
      expect(manager.hasInFlightRun(childAgent.id)).toBe(true);
      const replacement = await manager.replaceAgentRun(
        childAgent.id,
        "Continue with updated instructions",
      );
      const events = await Array.fromAsync(replacement);
      expect((await running).canceled).toBe(true);
      expect(events.some((event) => event.type === "turn_completed")).toBe(true);
      expect(launchedConfigs.get("claude")?.at(-1)?.daemonAppendSystemPrompt).toContain(
        "Level-1 Module Lead",
      );
    } finally {
      unsubscribe();
    }
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
        trackRemoteChild: async () => {},
        queueParentReport: async () => {
          throw new Error("Unexpected report");
        },
        pullReports: async () => ({ ownsBinding: false, reports: [] }),
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
        automaticParent: true,
        canRegister: expect.any(Function),
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
    expect(reenabled.record.lastModeId).toBe("full-access");
    expect(reenabled.record.labels).toEqual(main.labels);
  });
});

it("preserves Claude options, surfaces shell requests, and auto-denies file writes", async () => {
  await withAgents(async ({ manager, storage, cwd, launchedConfigs }) => {
    const claudeAgent = await manager.createAgent(
      {
        provider: "claude",
        cwd,
        title: "Claude Main",
        modeId: "default",
        providerOptions: { disallowedTools: ["WebFetch", "Bash"] },
      },
      undefined,
      { workspaceId: "workspace" },
    );
    expect(launchedConfigs.get("claude")?.at(-1)?.daemonAppendSystemPrompt).toBeUndefined();

    await manager.setAgentMainControl(claudeAgent.id, true);
    const mainLaunch = launchedConfigs.get("claude")?.at(-1);
    expect(mainLaunch?.providerOptions?.disallowedTools).toEqual(["WebFetch", "Bash"]);
    expect(mainLaunch?.daemonAppendSystemPrompt).toContain("Workspace Main Control Coordinator");
    const mainPolicy = manager.getPaseoToolPolicy(claudeAgent.id);
    for (const tool of [
      "create_terminal",
      "send_terminal_keys",
      "kill_terminal",
      "start_workspace_script",
      "stop_workspace_script",
    ]) {
      expect(isPaseoToolEnabled(mainPolicy, tool)).toBe(false);
    }
    await expect(
      manager.setAgentOptions(claudeAgent.id, { disallowedTools: ["WebFetch"] }),
    ).resolves.toBeUndefined();

    const surfacedPermissions: string[] = [];
    const unsubscribe = manager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.event.type === "permission_requested") {
          surfacedPermissions.push(event.event.request.name);
        }
      },
      { agentId: claudeAgent.id, replayState: false },
    );
    const shellPermission = Promise.withResolvers<string>();
    const unsubscribeShell = manager.subscribe(
      (event) => {
        if (
          event.type === "agent_stream" &&
          event.event.type === "permission_requested" &&
          event.event.request.name === "Bash"
        ) {
          shellPermission.resolve(event.event.request.id);
        }
      },
      { agentId: claudeAgent.id, replayState: false },
    );
    try {
      const shell = manager.runAgent(claudeAgent.id, "echo hello");
      await manager.respondToPermission(claudeAgent.id, await shellPermission.promise, {
        behavior: "allow",
      });
      await expect(shell).resolves.toMatchObject({ canceled: false });
      await manager.runAgent(claudeAgent.id, "edit test.txt");
    } finally {
      unsubscribeShell();
      unsubscribe();
    }
    expect(surfacedPermissions).toEqual(["Bash"]);
    expect(manager.getAgent(claudeAgent.id)?.pendingPermissions.size).toBe(0);

    const catalog = createPaseoToolCatalog({
      agentManager: manager,
      agentStorage: storage,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      callerAgentId: claudeAgent.id,
      workspaceRegistry: testWorkspaceRegistry(cwd),
      logger: createTestLogger(),
    });
    const childResult = await catalog.executeTool("create_agent", {
      provider: "claude/sonnet",
      title: "Delegated workload",
      initialPrompt: "Read project files",
      notifyOnFinish: false,
    });
    expect(childResult.isError).not.toBe(true);
    const childId = (childResult.structuredContent as { agentId: string }).agentId;
    expect((await storage.get(childId))?.labels[PARENT_REPORTING_LABEL]).toBe(
      EXPLICIT_PARENT_REPORTING,
    );
    expect(launchedConfigs.get("claude")?.at(-1)?.providerOptions?.disallowedTools).toEqual([
      "WebFetch",
    ]);

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

    const workspaceRegistry = testWorkspaceRegistry(cwd);
    const serverId = "test-server";
    const durableItems = openDurableItemStore({
      paseoHome: cwd,
      serverId,
      workspaceRegistry,
      agentStorage: storage,
    });
    const makeCatalog = (callerAgentId: string, filterTools = false) =>
      createPaseoToolCatalog({
        agentManager: manager,
        agentStorage: storage,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        callerAgentId,
        workspaceRegistry,
        serverId,
        durableItems,
        paseoToolPolicy: filterTools ? manager.getPaseoToolPolicy(callerAgentId) : undefined,
        verifiedCallerAgentId: callerAgentId,
        paseoHome: cwd,
        logger,
      });

    const mainCatalog = makeCatalog(mainAgent.id);
    const humanCatalog = createPaseoToolCatalog({
      agentManager: manager,
      agentStorage: storage,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      logger,
    });
    const filteredMain = makeCatalog(mainAgent.id, true);
    const filteredWorker = makeCatalog(workerA.id, true);
    expect([...filteredMain.tools.keys()].sort()).toEqual([...mainControlTools].sort());
    const scheduleTools = [
      "create_schedule",
      "update_schedule",
      "resume_schedule",
      "run_schedule_once",
    ];
    for (const name of scheduleTools) {
      expect(humanCatalog.getTool(name)).toBeDefined();
      expect(filteredMain.getTool(name)).toBeUndefined();
      expect(filteredWorker.getTool(name)).toBeUndefined();
    }
    await expect(mainCatalog.executeTool("run_schedule_once", { id: "any" })).rejects.toThrow(
      "Paseo tool is disabled for your hierarchy role: run_schedule_once",
    );
    await expect(
      mainCatalog.executeTool("send_agent_prompt", { agentId: workerA.id, prompt: "ping" }),
    ).rejects.toThrow("Coordinate through your direct child");
    await expect(
      mainCatalog.executeTool("update_agent", { agentId: workerA.id, name: "Nope" }),
    ).rejects.toThrow("Coordinate through your direct child");
    await expect(mainCatalog.executeTool("cancel_agent", { agentId: workerA.id })).rejects.toThrow(
      "Paseo tool is disabled for your hierarchy role: cancel_agent",
    );
    await expect(
      mainCatalog.executeTool("respond_to_permission", {
        agentId: workerA.id,
        requestId: "req-1",
        response: { behavior: "deny" },
      }),
    ).rejects.toThrow("Paseo tool is disabled for your hierarchy role: respond_to_permission");
    await expect(
      makeCatalog(ordinaryRoot.id).executeTool("respond_to_permission", {
        agentId: workerA.id,
        requestId: "req-1",
        response: { behavior: "deny" },
      }),
    ).rejects.toThrow("You can only manage your direct subagents.");
    await expect(
      mainCatalog.executeTool("set_agent_mode", { agentId: mainAgent.id, modeId: "default" }),
    ).rejects.toThrow("Paseo tool is disabled for your hierarchy role: set_agent_mode");

    const leadCatalog = makeCatalog(leadA.id);
    await expect(
      mainCatalog.executeTool("update_agent", {
        agentId: leadA.id,
        labels: { [PARENT_REPORTING_LABEL]: EXPLICIT_PARENT_REPORTING },
      }),
    ).rejects.toThrow("Change agent hierarchy through the workspace controls.");
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
    await expect(workerCatalog.executeTool("run_schedule_once", { id: "any" })).rejects.toThrow(
      "Paseo tool is disabled for your hierarchy role: run_schedule_once",
    );
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

it.each(["reparent", "detach"] as const)(
  "rejects an ordinary parent's queued delegation after %s without blocking a legal message",
  async (change) => {
    await withAgents(async ({ manager, storage, cwd }) => {
      const config = { provider: "codex", cwd, modeId: "auto" };
      const parent = await manager.createAgent(config, undefined, { workspaceId: "workspace" });
      const next = await manager.createAgent(config, undefined, { workspaceId: "workspace" });
      const recipient = await manager.createAgent(config, undefined, {
        workspaceId: "workspace",
        labels: { [PARENT_AGENT_ID_LABEL]: parent.id },
      });
      const logger = createTestLogger();
      let flush: (() => void) | undefined;
      const dispatch = vi.fn(async (batch: { prompt: AgentPromptInput; sessionMode?: string }) => {
        if (batch.sessionMode) await manager.setAgentMode(recipient.id, batch.sessionMode);
        return "steered" as const;
      });
      const delivery = createAgentMessageDelivery({
        dispatch,
        schedule: (_delay, callback) => {
          flush = callback;
          return () => {
            flush = undefined;
          };
        },
        onError: () => {},
      });
      const records = new Map<string, FinishSubscription>();
      const finish = createFinishSubscriptions({
        store: {
          list: async () => [...records.values()],
          put: async (record) => {
            records.set(record.id, record);
          },
          remove: async (id) => {
            records.delete(id);
          },
        },
        callerIsActive: async () => true,
        open: async () => {
          throw new Error("Rejected delegation must not be observed");
        },
        messages: () => delivery,
        serverId: "server-1",
        logger,
      });
      await finish.start();
      const makeCatalog = (callerAgentId: string) =>
        createPaseoToolCatalog({
          agentManager: manager,
          agentStorage: storage,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
          serverId: "server-1",
          agentMessages: () => delivery,
          finishSubscriptions: () => finish,
          callerAgentId,
          logger,
        });
      try {
        await expect(
          makeCatalog(parent.id).executeTool("send_agent_prompt", {
            agentId: recipient.id,
            prompt: "Old delegation",
            sessionMode: "read-only",
          }),
        ).resolves.toMatchObject({ structuredContent: { deliveryStatus: "queued" } });
        expect(finish.hasPendingForCaller(parent.id)).toBe(true);
        if (change === "reparent") await manager.setAgentParent(recipient.id, next.id);
        else await manager.detachAgent(recipient.id);
        await expect(
          makeCatalog(next.id).executeTool("send_agent_prompt", {
            agentId: recipient.id,
            prompt: "Legal message",
            notifyOnFinish: false,
          }),
        ).resolves.toMatchObject({ structuredContent: { deliveryStatus: "queued" } });
        flush!();
        await expect(
          delivery.waitForDispatch(recipient.id, new AbortController().signal),
        ).rejects.toThrow("You can only manage your direct subagents.");
        flush!();
        await expect.poll(() => dispatch.mock.calls.length).toBe(1);
        expect(parseAgentMessages(String(dispatch.mock.calls[0]![0].prompt))).toMatchObject([
          { text: "Legal message" },
        ]);
        expect(manager.getAgent(recipient.id)?.currentModeId).toBe("auto");
        await expect.poll(() => records.size).toBe(0);
        expect(finish.hasPendingForCaller(parent.id)).toBe(false);
      } finally {
        await delivery.close();
        await finish.close();
      }
    });
  },
);

it("delivers explicit reports to direct parents and rejects a queued report after detach", async () => {
  await withAgents(async ({ manager, storage, cwd }) => {
    const config = { provider: "codex", cwd };
    const workspaceId = "workspace";
    const coordinator = await manager.createAgent(config, undefined, { workspaceId });
    await manager.setAgentMainControl(coordinator.id, true);
    const leadAgent = await manager.createAgent(config, undefined, {
      workspaceId,
      labels: { [PARENT_AGENT_ID_LABEL]: coordinator.id },
    });
    const workerAgent = await manager.createAgent(config, undefined, {
      workspaceId,
      labels: { [PARENT_AGENT_ID_LABEL]: leadAgent.id },
    });
    await manager.setTitle(leadAgent.id, "Lead specialist");
    const dispatch = vi.fn(
      async (_batch: { recipientId: string; prompt: AgentPromptInput }) => "steered" as const,
    );
    const scheduled: Array<() => void> = [];
    const onError = vi.fn();
    const delivery = createAgentMessageDelivery({
      dispatch,
      schedule: (_delay, callback) => {
        scheduled.push(callback);
        return () => {};
      },
      onError,
    });
    const reporting = createFinishSubscriptions({
      store: createJsonFinishSubscriptionStore(cwd),
      followups: {
        watches: createJsonFinishSubscriptionStore(cwd, "watches.json"),
        reports: createJsonFinishSubscriptionStore(cwd, "reports.json"),
        async dispatch(record, report) {
          const receipt = delivery.enqueue({
            recipientId: record.callerAgentId,
            messageId: report.id,
            prompt: report.prompt,
            source: {
              kind: "agent-message",
              agentId: record.childAgentId,
              ...(report.title ? { title: report.title } : {}),
            },
            unarchive: false,
            validateDispatch: async () => {
              if ((await storage.get(record.callerAgentId))?.archivedAt) {
                throw new ParentReportRecipientUnavailableError("Parent is unavailable");
              }
              if (
                manager.getAgent(record.childAgentId)?.labels?.[PARENT_AGENT_ID_LABEL] !==
                record.callerAgentId
              ) {
                throw new ParentReportRecipientUnavailableError(
                  "You can only manage your direct subagents.",
                );
              }
            },
          });
          await receipt.dispatched;
        },
      },
      messages: () => delivery,
      open: async () => {
        throw new Error("Explicit reports do not observe turns");
      },
      callerIsActive: async () => true,
      serverId: "server-1",
      logger: createTestLogger(),
    });
    await reporting.start();
    const makeCatalog = (callerAgentId?: string) =>
      createPaseoToolCatalog({
        agentManager: manager,
        agentStorage: storage,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        serverId: "server-1",
        agentMessages: () => delivery,
        finishSubscriptions: () => reporting,
        callerAgentId,
        paseoToolPolicy: callerAgentId ? manager.getPaseoToolPolicy(callerAgentId) : undefined,
        logger: createTestLogger(),
      });
    try {
      const workerTools = makeCatalog(workerAgent.id);
      const leadTools = makeCatalog(leadAgent.id);
      await expect(
        workerTools.executeTool("report_to_parent", {
          status: "blocked",
          summary: "  Which API?  ",
        }),
      ).resolves.toMatchObject({ structuredContent: { deliveryStatus: "queued" } });
      await expect(
        leadTools.executeTool("report_to_parent", { summary: "Verified all changes." }),
      ).resolves.toMatchObject({ structuredContent: { deliveryStatus: "queued" } });
      while (scheduled.length) scheduled.shift()!();
      for (const id of [leadAgent.id, coordinator.id]) {
        await delivery.waitForDispatch(id, new AbortController().signal);
      }
      const reports = new Map(
        dispatch.mock.calls.map(([batch]) => [
          batch.recipientId,
          parseAgentMessages(String(batch.prompt)),
        ]),
      );
      expect(reports.get(leadAgent.id)).toMatchObject([
        {
          source: { kind: "agent-message", agentId: workerAgent.id },
          text: "Report to parent (blocked):\n\nWhich API?",
        },
      ]);
      expect(reports.get(coordinator.id)).toMatchObject([
        {
          source: { kind: "agent-message", agentId: leadAgent.id, title: "Lead specialist" },
          text: "Report to parent (completed):\n\nVerified all changes.",
        },
      ]);
      expect(reports.get(leadAgent.id)?.[0]?.source?.title).toBeUndefined();
      expect(
        String(
          dispatch.mock.calls.find(([batch]) => batch.recipientId === leadAgent.id)?.[0].prompt,
        ),
      ).not.toContain("source-agent-title=");
      await storage.setTitle(workerAgent.id, "ABCDEF12-3456-7890-ABCD-EF1234567890");
      manager.getAgent(workerAgent.id)!.config.title = "Live worker title";
      await expect(
        workerTools.executeTool("report_to_parent", { summary: "Live title fallback" }),
      ).resolves.toMatchObject({ structuredContent: { deliveryStatus: "queued" } });
      while (scheduled.length) scheduled.shift()!();
      await delivery.waitForDispatch(leadAgent.id, new AbortController().signal);
      expect(String(dispatch.mock.calls.at(-1)![0].prompt)).toContain(
        'source-agent-title="Live worker title"',
      );
      await expect(
        workerTools.executeTool("report_to_parent", { summary: "Do not deliver after detach" }),
      ).resolves.toMatchObject({ structuredContent: { deliveryStatus: "queued" } });
      await manager.detachAgent(workerAgent.id);
      while (scheduled.length) scheduled.shift()!();
      await expect(
        delivery.waitForDispatch(leadAgent.id, new AbortController().signal),
      ).rejects.toThrow("You can only manage your direct subagents.");
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(onError).toHaveBeenCalled();
      expect(makeCatalog(coordinator.id).getTool("report_to_parent")).toBeUndefined();
      for (const caller of [undefined, workerAgent.id]) {
        await expect(
          makeCatalog(caller).executeTool("report_to_parent", { summary: "No parent" }),
        ).rejects.toThrow(/Only subagents/);
      }
      await expect(
        leadTools.executeTool("report_to_parent", { summary: "Do not revive my parent" }),
      ).resolves.toMatchObject({ structuredContent: { deliveryStatus: "queued" } });
      await manager.archiveAgent(coordinator.id);
      while (scheduled.length) scheduled.shift()!();
      await expect(
        delivery.waitForDispatch(coordinator.id, new AbortController().signal),
      ).rejects.toThrow("is unavailable");
      await expect(
        leadTools.executeTool("report_to_parent", { summary: "Parent already archived" }),
      ).rejects.toThrow("Only subagents with a direct parent can report.");
      expect(dispatch).toHaveBeenCalledTimes(3);
    } finally {
      await reporting.close();
      await delivery.close();
    }
  });
});

it("routes a report to its parent on another host even if the agent IDs match", async () => {
  await withAgents(async ({ manager, storage, cwd }) => {
    const callerAgent = await manager.createAgent({ provider: "codex", cwd }, undefined, {
      workspaceId: "workspace",
    });
    await manager.setLabels(callerAgent.id, {
      [PARENT_AGENT_ID_LABEL]: callerAgent.id,
      [PARENT_SERVER_ID_LABEL]: "remote-host",
      [REMOTE_HIERARCHY_DEPTH_LABEL]: "2",
    });
    const parent = toAgentPayload(callerAgent);
    const fetchAgent = vi.fn(async () => ({ agent: parent, project: null }));
    const remoteClient = Object.assign(
      new DaemonClient({ clientId: "parent-report-test", url: "ws://unused.invalid" }),
      {
        fetchAgent,
      },
    );
    const reports = createJsonFinishSubscriptionStore(cwd, "reports.json");
    const reporting = createFinishSubscriptions({
      store: createJsonFinishSubscriptionStore(cwd),
      followups: {
        watches: createJsonFinishSubscriptionStore(cwd, "watches.json"),
        reports,
        dispatch: async () => {
          throw new Error("The receiving host owns dispatch");
        },
      },
      messages: () => {
        throw new Error("The receiving host owns dispatch");
      },
      open: async () => {
        throw new Error("Explicit reports do not observe turns");
      },
      callerIsActive: async () => true,
      serverId: "local-host",
      logger: createTestLogger(),
    });
    await reporting.start();
    const catalog = createPaseoToolCatalog({
      agentManager: manager,
      agentStorage: storage,
      callerAgentId: callerAgent.id,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      serverId: "local-host",
      finishSubscriptions: () => reporting,
      hosts: () => ({
        directory: async () => ({
          self: { serverId: "local-host", label: "Local" },
          hosts: [
            {
              registrationId: "remote-registration",
              serverId: "remote-host",
              label: null,
              source: { id: "remote", key: "remote" },
              metadata: {},
              enabled: true,
              status: "online" as const,
              targetDescription: "Remote parent",
              lastOnlineAt: null,
              nextRetryAt: null,
              error: null,
            },
          ],
        }),
        use: async (destination, action) => {
          expect(destination).toBe("remote-host");
          return action(remoteClient);
        },
      }),
      logger: createTestLogger(),
    });
    try {
      await expect(
        catalog.executeTool("report_to_parent", { summary: "Remote work verified" }),
      ).resolves.toMatchObject({ structuredContent: { success: true, deliveryStatus: "queued" } });
      expect(await reports.list()).toMatchObject([
        {
          childAgentId: callerAgent.id,
          callerAgentId: callerAgent.id,
          callerServerId: "remote-host",
          report: {
            parentReportStatus: "completed",
            prompt: "Report to parent (completed):\n\nRemote work verified",
          },
        },
      ]);
      fetchAgent.mockResolvedValueOnce({
        agent: { ...parent, archivedAt: "2026-11-21T00:00:00.000Z" },
        project: null,
      });
      await expect(
        catalog.executeTool("report_to_parent", { summary: "Do not revive my remote parent" }),
      ).rejects.toThrow("is unavailable");
      expect(await reports.list()).toHaveLength(1);
    } finally {
      await reporting.close();
      await remoteClient.close();
    }
  });
});

it("cleans up rejected subscriptions and skips automatic reports for explicit SDK children", async () => {
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

      const { snapshot: explicitChild, initialPromptStarted } = await createAgentCommand(
        {
          agentManager: manager,
          agentStorage: storage,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
          finishSubscriptions,
          logger,
        },
        {
          kind: "session",
          config: { provider: "codex", cwd },
          workspaceId,
          callerAgentId: parentAgent.id,
          labels: { [PARENT_REPORTING_LABEL]: EXPLICIT_PARENT_REPORTING },
          initialPrompt: "Work until you have a result",
          provisionalTitle: null,
          firstAgentContext: { attachments: [] },
        },
      );
      expect(initialPromptStarted).toBe(true);
      expect(records.size).toBe(0);
      await expect(
        registerParentFinishSubscription({
          agentId: explicitChild.id,
          serverId: "server-1",
          agentManager: manager,
          agentStorage: storage,
          finishSubscriptions,
        }),
      ).resolves.toBeUndefined();
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

it.each([true, false])("reparents a running child with explicit reporting %s", async (explicit) => {
  await withAgents(async ({ manager, storage, cwd }) => {
    const config = { provider: "claude", cwd, modeId: "default" };
    const workspaceId = "workspace";
    const parent = await manager.createAgent(config, undefined, { workspaceId });
    const next = await manager.createAgent(config, undefined, { workspaceId });
    const childAgent = await manager.createAgent(config, undefined, {
      workspaceId,
      labels: {
        [PARENT_AGENT_ID_LABEL]: parent.id,
        [PARENT_REPORTING_LABEL]: explicit ? EXPLICIT_PARENT_REPORTING : "auto",
      },
    });
    const permission = Promise.withResolvers<void>();
    const unsubscribe = manager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.event.type === "permission_requested")
          permission.resolve();
      },
      { agentId: childAgent.id, replayState: false },
    );
    const running = manager.runAgent(childAgent.id, "edit test.txt");
    const accept = vi.fn();
    const register = vi.fn(async () => ({ accept, reject: async () => {} }));
    try {
      await Promise.race([
        permission.promise,
        running.then(() => {
          throw new Error("The child must still be running");
        }),
      ]);
      await manager.setAgentParent(childAgent.id, next.id, "local-host", register);
      expect((await storage.get(childAgent.id))?.labels[PARENT_AGENT_ID_LABEL]).toBe(next.id);
      expect(register).toHaveBeenCalledTimes(explicit ? 0 : 1);
      expect(accept).toHaveBeenCalledTimes(explicit ? 0 : 1);
    } finally {
      unsubscribe();
      await manager.cancelAgentRun(childAgent.id);
      await running;
    }
  });
});
