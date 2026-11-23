import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { PARENT_AGENT_ID_LABEL, parentAddressLabels } from "@getpaseo/protocol/agent-labels";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

const creationDenied =
  "Agent sessions cannot create a project or workspace. Subagents must reuse the current workspace.";

test.each(["agent", "workspace"] as const)(
  "%s creation recognizes an unopened persisted caller after restart",
  async (kind) => {
    const root = await mkdtemp(path.join(tmpdir(), "persisted-caller-"));
    const cwd = path.join(root, "project");
    await mkdir(cwd);
    let ctx: DaemonTestContext | undefined;
    try {
      ctx = await createDaemonTestContext({
        paseoHomeRoot: root,
        staticDir: cwd,
        cleanup: false,
        mcpEnabled: false,
      });
      const parent = await ctx.client.createAgent({ provider: "claude", cwd, background: true });
      await ctx.client.sendMessage(parent.id, "Reply DONE.");
      expect((await ctx.client.waitForFinish(parent.id, 5_000)).status).toBe("idle");
      await ctx.cleanup();
      ctx = undefined;
      ctx = await createDaemonTestContext({
        paseoHomeRoot: root,
        staticDir: cwd,
        cleanup: false,
        mcpEnabled: false,
      });
      expect(ctx.daemon.daemon.agentManager.getAgent(parent.id)).toBeNull();
      expect(
        (await ctx.client.fetchAgents({ filter: { includeBackground: true } })).entries,
      ).toContainEqual(
        expect.objectContaining({ agent: expect.objectContaining({ id: parent.id }) }),
      );

      if (kind === "agent") {
        const other = await ctx.client.createWorkspace({
          source: { kind: "directory", path: cwd },
        });
        expect(other.workspace?.id).toBeTruthy();
        expect(other.workspace?.id).not.toBe(parent.workspaceId);
        const input = {
          provider: "claude" as const,
          cwd: path.join(root, "not-the-parent-directory"),
          callerAgentId: parent.id,
          idempotencyKey: "persisted-parent-child",
        };
        await expect(
          ctx.client.createAgent({
            ...input,
            workspaceId: other.workspace?.id,
            initialPromptOrigin: "user",
          }),
        ).rejects.toThrow(creationDenied);
        await expect(
          ctx.client.createAgent({
            ...input,
            worktree: { mode: "branch-off", newBranch: "child" },
          }),
        ).rejects.toThrow(creationDenied);
        const child = await ctx.client.createAgent(input);
        expect(child.workspaceId).toBe(parent.workspaceId);
        expect(child.cwd).toBe(parent.cwd);
        expect(child.labels[PARENT_AGENT_ID_LABEL]).toBe(parent.id);
        await ctx.cleanup();
        ctx = undefined;
        ctx = await createDaemonTestContext({
          paseoHomeRoot: root,
          staticDir: cwd,
          cleanup: false,
          mcpEnabled: false,
        });
        expect(ctx.daemon.daemon.agentManager.getAgent(child.id)).toBeNull();
        expect(await ctx.client.createAgent(input)).toMatchObject({
          id: child.id,
          workspaceId: parent.workspaceId,
          cwd: parent.cwd,
        });
        expect(ctx.daemon.daemon.agentManager.getAgent(child.id)).toBeNull();
      } else {
        const result = await ctx.client.createWorkspace({
          source: { kind: "directory", path: cwd },
          callerAgentId: parent.id,
        });
        expect(result.error).toBe(creationDenied);
        expect(result.workspace).toBeNull();
      }
      expect(ctx.daemon.daemon.agentManager.getAgent(parent.id)).toBeNull();
    } finally {
      await ctx?.cleanup();
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  60_000,
);

test("human workspace creation adds a Main Session and keeps the first prompt user-originated", async () => {
  const ctx = await createDaemonTestContext({ mcpEnabled: false });
  try {
    const config = { provider: "claude", cwd: ctx.daemon.staticDir } as const;
    const source = { kind: "directory", path: config.cwd } as const;
    const agent = { config, initialPrompt: "Reply DONE." };
    const idempotencyKey = "human-workspace-with-main";
    const blocked = await ctx.client.createWorkspace({
      source,
      idempotencyKey,
      agent: { ...agent, initialPromptOrigin: "agent" },
    });
    expect(blocked).toMatchObject({ workspace: null, error: creationDenied });

    const input = { source, idempotencyKey, mainAgent: { config }, agent };
    const created = await ctx.client.createWorkspace(input);
    expect(created.error).toBeNull();
    const { workspace, mainAgent, agent: child } = created;
    if (!workspace || !mainAgent || !child) {
      throw new Error("Expected the workspace, Main Session, and initial agent");
    }
    expect(mainAgent).toMatchObject({ workspaceId: workspace.id, status: "closed" });
    expect(child).toMatchObject({
      workspaceId: workspace.id,
      labels: { [PARENT_AGENT_ID_LABEL]: mainAgent.id },
    });
    expect((await ctx.client.waitForFinish(child.id, 5_000)).status).toBe("idle");
    const summary = await ctx.client.summarizeWorkspaceAgents({ workspaceId: workspace.id });
    expect(summary.entries).toContainEqual(
      expect.objectContaining({ agentId: child.id, firstUserPrompt: agent.initialPrompt }),
    );

    expect(await ctx.client.createWorkspace(input)).toMatchObject({
      workspace: { id: workspace.id },
      mainAgent: { id: mainAgent.id },
      agent: { id: child.id },
      creation: { phase: "completed" },
    });
  } finally {
    await ctx.cleanup();
  }
}, 60_000);

test("a connected host accepts human creation and rejects creation carrying a foreign parent", async () => {
  const origin = await createDaemonTestContext({ mcpEnabled: false });
  const paseo = createPaseoApi(origin.client);
  let destination: DaemonTestContext | undefined;
  try {
    destination = await createDaemonTestContext({ mcpEnabled: false });
    await paseo.hosts.add({ connection: `127.0.0.1:${destination.daemon.port}` });
    await expect
      .poll(async () => (await paseo.hosts.list()).hosts[0]?.status, { timeout: 15_000 })
      .toBe("online");
    const originServerId = origin.client.getLastServerInfoMessage()?.serverId;
    const destinationServerId = destination.client.getLastServerInfoMessage()?.serverId;
    if (!originServerId || !destinationServerId) throw new Error("Expected both host IDs");
    const parent = await origin.client.createAgent({
      provider: "claude",
      cwd: origin.daemon.staticDir,
    });
    const remote = await paseo.hosts.client(destinationServerId);
    const cwd = destination.daemon.staticDir;
    const workspace = await remote.workspaces.create({ source: { kind: "directory", path: cwd } });
    await expect(
      destination.client.createAgent({
        provider: "claude",
        cwd,
        workspaceId: workspace.id,
        labels: parentAddressLabels({ agentId: parent.id, serverId: originServerId }),
      }),
    ).rejects.toThrow(creationDenied);
    const humanAgent = await remote.workspaces.ref(workspace.id).agents.create({
      config: { provider: "claude/claude-test" },
    });
    expect(destination.daemon.daemon.agentManager.listAgents().map(({ id }) => id)).toEqual([
      humanAgent.id,
    ]);
  } finally {
    await paseo.dispose();
    await origin.cleanup();
    await destination?.cleanup();
  }
}, 60_000);

test("creation still rejects a caller removed by workspace archive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "archived-caller-"));
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  const ctx = await createDaemonTestContext({
    paseoHomeRoot: root,
    staticDir: cwd,
    cleanup: false,
    mcpEnabled: false,
  });
  try {
    const parent = await ctx.client.createAgent({ provider: "claude", cwd });
    const archived = await ctx.client.archiveWorkspace(parent.workspaceId);
    expect(archived.error).toBeNull();
    expect(ctx.daemon.daemon.agentManager.getAgent(parent.id)).toBeNull();
    await expect(
      ctx.client.createAgent({ provider: "claude", cwd, callerAgentId: parent.id }),
    ).rejects.toThrow(`Caller agent ${parent.id} not found`);
  } finally {
    await ctx.cleanup();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60_000);
