import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPLICIT_PARENT_REPORTING,
  isExplicitParentReportingLabels,
  isResidentAgent,
  LEAD_COMMIT_POLICY_LABEL,
  LEAD_PLAYBOOK_LABEL,
  PARENT_AGENT_ID_LABEL,
  PARENT_REPORTING_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import { AgentManager, directHumanPromptRunOptions } from "../agent-manager.js";
import { sendPromptToAgent } from "../agent-prompt.js";
import { AgentStorage } from "../agent-storage.js";
import {
  createFinishSubscriptions,
  createJsonFinishSubscriptionStore,
} from "../finish-subscriptions/index.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";
import { PaseoToolInputError } from "./types.js";

const logger = createTestLogger();

function createWorkspaceRegistry(
  cwd: string,
): Pick<WorkspaceRegistry, "get" | "listActive" | "update"> {
  const makeRecord = (workspaceId: string) => ({
    workspaceId,
    projectId: "test-project",
    cwd,
    kind: "directory" as const,
    displayName: workspaceId,
    title: null,
    branch: null,
    worktreeRoot: null,
    baseBranch: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
    createdAt: "",
    updatedAt: "",
    archivedAt: null,
    metadata: {},
    background: false,
  });
  return {
    get: async (workspaceId) => makeRecord(workspaceId),
    listActive: async () => [makeRecord("ws-playbook")],
    update: async (workspaceId) => makeRecord(workspaceId),
  };
}

async function cleanupWorkdir(params: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workdir: string;
}) {
  params.agentManager.prepareForShutdown();
  await Promise.all(
    params.agentManager.listAgents().map((agent) => params.agentManager.closeAgent(agent.id)),
  );
  await params.agentManager.flushForShutdown();
  await params.agentStorage.flush();
  rmSync(params.workdir, { recursive: true, force: true });
}

describe("create_agent orchestration playbooks", () => {
  test("returns the main turn's topic and dispatch identity for create and send without a task", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "create-agent-topic-"));
    const agentStorage = new AgentStorage(join(workdir, "agents"), logger);
    const workspaceRegistry = createWorkspaceRegistry(workdir);
    const release = Promise.withResolvers<void>();
    const humanPrompt = "Delegate work about this topic";
    const clients = createTestAgentClients({
      async beforeTurnComplete(prompt) {
        const mainPrompt =
          typeof prompt === "string"
            ? prompt.includes(humanPrompt)
            : prompt.some((part) => part.type === "text" && part.text.includes(humanPrompt));
        if (!mainPrompt) return;
        await release.promise;
      },
    });
    const agentManager = new AgentManager({
      clients,
      registry: agentStorage,
      workspaceRegistry,
      logger,
    });
    try {
      const main = await agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
        workspaceId: "ws-playbook",
      });
      await agentManager.setAgentMainControl(main.id, true);
      const catalog = createPaseoToolCatalog({
        serverId: "self",
        callerAgentId: main.id,
        verifiedCallerAgentId: main.id,
        paseoHome: workdir,
        agentManager,
        agentStorage,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        workspaceRegistry,
        queueAgentPrompt: async () => "queued-dispatch",
        logger,
      });
      const mainTurn = await sendPromptToAgent({
        agentManager,
        agentStorage,
        logger,
        agentId: main.id,
        prompt: humanPrompt,
        messageId: "human-topic",
        runOptions: directHumanPromptRunOptions(),
      });
      if (mainTurn.disposition !== "turn_started") throw new Error("Expected the main turn");
      await mainTurn.started;
      expect(agentManager.isActiveTurnHumanInitiated(main.id)).toBe(true);
      const root = (await agentManager.getTimelineRows(main.id)).find(
        ({ item }) => item.type === "user_message",
      )?.item;
      if (root?.type !== "user_message") throw new Error("Expected the main turn's human prompt");
      const rootMessageId = root.messageId ?? root.clientMessageId;
      expect(rootMessageId).toEqual(expect.any(String));

      const created = await catalog.executeTool("create_agent", {
        provider: "codex/gpt-5.4",
        title: "Specialist",
        initialPrompt: "Work on the first step",
        notifyOnFinish: false,
      });
      expect(created.isError).toBeFalsy();
      const { agentId, topicDelegation } = created.structuredContent as {
        agentId: string;
        topicDelegation: { messageId: string };
      };
      expect(topicDelegation).toEqual({
        agentId,
        serverId: "self",
        rootMessageId,
        messageId: expect.any(String),
      });
      const childRows = await agentManager.getTimelineRows(agentId);
      expect(childRows.map(({ item }) => item)).toContainEqual(
        expect.objectContaining({ callId: `paseo-agent-message:${topicDelegation.messageId}` }),
      );

      const sent = await catalog.executeTool("send_agent_prompt", {
        agentId,
        prompt: "Work on the second step",
        notifyOnFinish: false,
      });
      expect(sent.structuredContent).toMatchObject({
        success: true,
        deliveryStatus: "queued",
        messageId: "queued-dispatch",
        topicDelegation: { agentId, serverId: "self", rootMessageId, messageId: "queued-dispatch" },
      });
    } finally {
      release.resolve();
      await cleanupWorkdir({ agentManager, agentStorage, workdir });
    }
  });

  test("stamps playbook labels, forces explicit reporting without finish notifications, and skips defaultResident", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "create-agent-playbook-"));
    const agentStorage = new AgentStorage(join(workdir, "agents"), logger);
    const workspaceRegistry = createWorkspaceRegistry(workdir);
    const launchedConfigs: Array<{ daemonAppendSystemPrompt?: string }> = [];
    const clients = createTestAgentClients();
    const origCreate = clients.codex!.createSession.bind(clients.codex);
    clients.codex!.createSession = async (config, context, options) => {
      launchedConfigs.push(config);
      return origCreate(config, context, options);
    };
    const agentManager = new AgentManager({
      clients,
      registry: agentStorage,
      workspaceRegistry,
      logger,
    });
    const finishSubscriptions = createFinishSubscriptions({
      store: createJsonFinishSubscriptionStore(workdir),
      serverId: "self",
      logger,
      messages: () => {
        throw new Error("Unexpected finish notification");
      },
      callerIsActive: async () => true,
      open: async (_record, signal) => ({
        next: () =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
        close: async () => {},
      }),
    });
    await finishSubscriptions.start();

    try {
      const main = await agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
        workspaceId: "ws-playbook",
      });
      await agentManager.setAgentMainControl(main.id, true);

      const catalog = createPaseoToolCatalog({
        serverId: "self",
        callerAgentId: main.id,
        verifiedCallerAgentId: main.id,
        paseoHome: workdir,
        agentManager,
        agentStorage,
        finishSubscriptions: () => finishSubscriptions,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        workspaceRegistry,
        daemonConfigStore: {
          get: () => ({
            agentProfiles: [
              {
                id: "profile-default-resident",
                name: "Lead Profile",
                provider: "codex",
                model: "gpt-5.4",
                defaultResident: true,
              },
            ],
          }),
        } as never,
        logger,
      });

      const batchCreated = await catalog.executeTool("create_agent", {
        profileId: "profile-default-resident",
        title: "Batch implementation lead",
        initialPrompt: "Implement approved multi-track batch",
        playbook: "batch_implement",
      });
      expect(batchCreated.isError).toBeFalsy();
      const batchId = (batchCreated.structuredContent as { agentId: string }).agentId;
      const storedBatch = await agentStorage.get(batchId);
      expect(storedBatch?.labels).toMatchObject({
        [PARENT_AGENT_ID_LABEL]: main.id,
        [PARENT_REPORTING_LABEL]: EXPLICIT_PARENT_REPORTING,
        [LEAD_PLAYBOOK_LABEL]: "batch_implement",
        [LEAD_COMMIT_POLICY_LABEL]: "none",
      });
      expect(isExplicitParentReportingLabels(storedBatch?.labels)).toBe(true);
      expect(isResidentAgent({ labels: storedBatch?.labels })).toBe(false);
      expect(finishSubscriptions.hasPendingForCaller(main.id)).toBe(false);
      const batchLaunchPrompt = launchedConfigs.at(-1)?.daemonAppendSystemPrompt;
      expect(batchLaunchPrompt).toContain(
        `Level-1 Batch Implementation Lead under Main Control Agent ${main.id}`,
      );
      expect(batchLaunchPrompt).toContain("do not run git commit or git push");
      expect(batchLaunchPrompt).not.toContain("Flexible Mode");

      const crCreated = await catalog.executeTool("create_agent", {
        provider: "codex/gpt-5.4",
        title: "CR loop lead",
        initialPrompt: "Run convergent review and fix loop",
        playbook: "cr_fix_loop",
        commitPolicy: "scoped_only",
      });
      expect(crCreated.isError).toBeFalsy();
      const crId = (crCreated.structuredContent as { agentId: string }).agentId;
      const storedCr = await agentStorage.get(crId);
      expect(storedCr?.labels).toMatchObject({
        [LEAD_PLAYBOOK_LABEL]: "cr_fix_loop",
        [LEAD_COMMIT_POLICY_LABEL]: "scoped_only",
      });

      const invalidReadonly = await catalog.executeTool("create_agent", {
        provider: "codex/gpt-5.4",
        title: "Invalid readonly commit lead",
        initialPrompt: "Run read-only review",
        playbook: "readonly_cr",
        commitPolicy: "scoped_only",
      });
      expect(invalidReadonly).toMatchObject({
        isError: true,
        structuredContent: {
          error: 'commitPolicy "scoped_only" cannot be used with playbook "readonly_cr".',
        },
      });

      await expect(
        catalog.executeTool("update_agent", {
          agentId: batchId,
          labels: { [LEAD_PLAYBOOK_LABEL]: "readonly_cr" },
        }),
      ).rejects.toThrow(PaseoToolInputError);
    } finally {
      await finishSubscriptions.close();
      await cleanupWorkdir({ agentManager, agentStorage, workdir });
    }
  });

  test("rejects playbook dispatch from non-Main-Control callers and strips forged playbook labels", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "create-agent-playbook-non-main-"));
    const agentStorage = new AgentStorage(join(workdir, "agents"), logger);
    const workspaceRegistry = createWorkspaceRegistry(workdir);
    const launchedConfigs: Array<{ daemonAppendSystemPrompt?: string }> = [];
    const clients = createTestAgentClients();
    const origCreate = clients.codex!.createSession.bind(clients.codex);
    clients.codex!.createSession = async (config, context, options) => {
      launchedConfigs.push(config);
      return origCreate(config, context, options);
    };
    const agentManager = new AgentManager({
      clients,
      registry: agentStorage,
      workspaceRegistry,
      logger,
    });
    const finishSubscriptions = createFinishSubscriptions({
      store: createJsonFinishSubscriptionStore(workdir),
      serverId: "self",
      logger,
      messages: () => ({ enqueue: () => ({ messageId: "m1" }) }) as never,
      callerIsActive: async () => true,
      open: async (_record, signal) => ({
        next: () =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
        close: async () => {},
      }),
    });
    await finishSubscriptions.start();

    try {
      const regularParent = await agentManager.createAgent(
        { provider: "codex", cwd: workdir },
        undefined,
        { workspaceId: "ws-playbook" },
      );

      const catalog = createPaseoToolCatalog({
        serverId: "self",
        callerAgentId: regularParent.id,
        verifiedCallerAgentId: regularParent.id,
        paseoHome: workdir,
        agentManager,
        agentStorage,
        finishSubscriptions: () => finishSubscriptions,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        workspaceRegistry,
        logger,
      });

      const unauthorized = await catalog.executeTool("create_agent", {
        provider: "codex/gpt-5.4",
        title: "Unauthorized playbook",
        initialPrompt: "Try playbook without Main Control",
        playbook: "batch_implement",
      });
      expect(unauthorized).toMatchObject({
        isError: true,
        structuredContent: {
          error: expect.stringMatching(/Main Control/),
        },
      });

      const forged = await catalog.executeTool("create_agent", {
        provider: "codex/gpt-5.4",
        title: "Forged labels child",
        initialPrompt: "Ordinary work",
        notifyOnFinish: false,
        labels: {
          [LEAD_PLAYBOOK_LABEL]: "batch_implement",
          [LEAD_COMMIT_POLICY_LABEL]: "scoped_only",
          team: "core",
        },
      });
      const forgedId = (forged.structuredContent as { agentId: string }).agentId;
      const storedForged = await agentStorage.get(forgedId);
      expect(storedForged?.labels).not.toHaveProperty(LEAD_PLAYBOOK_LABEL);
      expect(storedForged?.labels).not.toHaveProperty(LEAD_COMMIT_POLICY_LABEL);
      expect(storedForged?.labels?.team).toBe("core");
    } finally {
      await finishSubscriptions.close();
      await cleanupWorkdir({ agentManager, agentStorage, workdir });
    }
  });
});
