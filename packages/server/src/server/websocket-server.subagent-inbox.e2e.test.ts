import {
  getOpenAgentTabLabel,
  PARENT_AGENT_ID_LABEL,
  PARENT_REPORTING_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { createPaseoApi } from "@getpaseo/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import type { AgentManager } from "./agent/agent-manager.js";
import { DaemonClient, createTestPaseoDaemon } from "./test-utils/index.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

async function expectApprovalWithReport(
  manager: AgentManager,
  main: string,
  child: string,
  approver: string,
) {
  await expect.poll(() => manager.getPendingPermissions(approver)).toHaveLength(1);
  const approval = manager.getPendingPermissions(approver)[0]!;
  try {
    const delivered = async () =>
      (await manager.getTimelineRows(main)).flatMap(({ item, turnId }) =>
        item.type === "tool_call" && item.agentMessage
          ? [{ turnId, agentId: item.agentMessage.sender.id, event: item.agentMessage.event }]
          : [],
      );
    await expect.poll(delivered, { timeout: 6000 }).toEqual([
      { turnId: expect.any(String), agentId: child, event: "finished" },
      { turnId: expect.any(String), agentId: approver, event: "permission-required" },
    ]);
    expect(new Set((await delivered()).map(({ turnId }) => turnId)).size).toBe(1);
  } finally {
    await manager.respondToPermission(approver, approval.id, {
      behavior: "deny",
      interrupt: true,
    });
  }
}

test.each(["flush", "detach", "last child settles", "permission"])(
  "Main Control releases a child's result on %s",
  async (action) => {
    const release = Promise.withResolvers<void>();
    const siblingStarted = Promise.withResolvers<void>();
    const handle = await createTestPaseoDaemon({
      agentClients: createTestAgentClients({
        async beforeTurnComplete(prompt) {
          if (prompt === "Keep working") {
            siblingStarted.resolve();
            await release.promise;
          }
        },
      }),
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${handle.port}/ws` });
    try {
      await client.connect();
      expect(client.getLastServerInfoMessage()?.features?.subagentInbox).toBe(true);
      const manager = handle.daemon.agentManager;
      const main = await client.createAgent({ provider: "codex", cwd: handle.staticDir });
      await manager.setAgentMainControl(main.id, true);
      const workspaceId = (await handle.daemon.agentStorage.get(main.id))?.workspaceId;
      const createChild = (labels: Record<string, string> = {}) =>
        manager.createAgent({ provider: "codex", cwd: main.cwd }, undefined, {
          workspaceId,
          labels: {
            [PARENT_AGENT_ID_LABEL]: main.id,
            [PARENT_REPORTING_LABEL]: "auto",
            ...labels,
          },
        });
      const sibling = await createChild({ [PARENT_REPORTING_LABEL]: "explicit" });
      const idle = await createChild({ [getOpenAgentTabLabel("inbox-test")]: "true" });
      expect(manager.hasInFlightRun(idle.id)).toBe(false);
      const child = await createChild();
      const observation = client.observeAgents({ filter: { labels: main.labels } });
      const updates: Array<number> = [];
      observation.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type !== "agent_update" || message.payload.kind !== "upsert") return;
          if (message.payload.agent.id === main.id)
            updates.push(message.payload.agent.pendingSubagentInbox?.count ?? 0);
        },
      });
      await observation.ready;
      try {
        await client.sendMessage(sibling.id, "Keep working");
        await siblingStarted.promise;
        await client.sendMessage(child.id, "Finish now");
        await expect
          .poll(async () => (await client.fetchAgent(main.id))?.agent.pendingSubagentInbox)
          .toMatchObject({ count: 1, items: [{ agentId: child.id, event: "finished" }] });
        await expect.poll(() => updates).toContain(1);
        await expect(client.flushAgentInbox(child.id)).rejects.toThrow(
          "Main Control inbox is unavailable",
        );
        if (action === "flush") {
          await client.flushAgentInbox(main.id);
          await client.flushAgentInbox(main.id);
        } else if (action === "detach") {
          // The detached child keeps running and sends no notification.
          await client.detachAgent(sibling.id);
        } else if (action === "last child settles") {
          release.resolve();
          await expect.poll(() => manager.hasInFlightRun(sibling.id)).toBe(false);
        } else {
          const approver = await createChild();
          await client.sendMessage(approver.id, "Run echo hello");
          await expectApprovalWithReport(manager, main.id, child.id, approver.id);
        }
        await expect.poll(() => updates.at(-1)).toBe(0);
        await expect
          .poll(
            () =>
              manager
                .getTimeline(main.id)
                .filter(
                  (item) => item.type === "tool_call" && item.agentMessage?.sender.id === child.id,
                ),
            { timeout: 6000 },
          )
          .toHaveLength(1);
        expect(manager.hasInFlightRun(sibling.id)).toBe(action !== "last child settles");
      } finally {
        await observation.release();
      }
    } finally {
      release.resolve();
      await client.close();
      await handle.close();
    }
  },
  30_000,
);

test("a one-way child report replaces its held automatic finish and preserves the next turn", async () => {
  const release = Promise.withResolvers<void>();
  const siblingStarted = Promise.withResolvers<void>();
  const origin = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      async beforeTurnComplete(prompt) {
        if (prompt === "Hold sibling open") {
          siblingStarted.resolve();
          await release.promise;
        }
      },
    }),
  });
  const destination = await createTestPaseoDaemon({ agentClients: createTestAgentClients() });
  const parentClient = new DaemonClient({ url: `ws://127.0.0.1:${origin.port}/ws` });
  const childClient = new DaemonClient({ url: `ws://127.0.0.1:${destination.port}/ws` });
  const originApi = createPaseoApi(parentClient);
  const destinationApi = createPaseoApi(childClient);
  const parentTools = new Client({ name: "test-parent", version: "1" });
  const childTools = new Client({ name: "test-child", version: "1" });
  try {
    await Promise.all([parentClient.connect(), childClient.connect()]);
    const childHostId = destination.daemon.getServerId();
    await originApi.hosts.add({ connection: `127.0.0.1:${destination.port}` });
    await expect.poll(async () => (await originApi.hosts.list()).hosts[0]?.status).toBe("online");
    expect((await destinationApi.hosts.list()).hosts).toEqual([]);
    const workspace = await originApi.workspaces.create({
      source: { kind: "directory", path: origin.staticDir },
    });
    const remoteWorkspace = await destinationApi.workspaces.create({
      source: { kind: "directory", path: destination.staticDir },
    });
    const parent = await workspace.agents.create({ config: { provider: "codex/codex-test" } });
    const manager = origin.daemon.agentManager;
    await manager.setAgentMainControl(parent.id, true);
    const sibling = await manager.createAgent(
      { provider: "codex", cwd: origin.staticDir },
      undefined,
      {
        workspaceId: workspace.id,
        labels: { [PARENT_AGENT_ID_LABEL]: parent.id, [PARENT_REPORTING_LABEL]: "auto" },
      },
    );
    await parentClient.sendMessage(sibling.id, "Hold sibling open");
    await siblingStarted.promise;
    const transport = (port: number, agentId: string) =>
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/agents?callerAgentId=${agentId}`),
      );
    await parentTools.connect(transport(origin.port, parent.id));
    const creation = await parentTools.callTool({
      name: "create_agent",
      arguments: {
        serverId: childHostId,
        workspaceId: remoteWorkspace.id,
        provider: "codex/codex-test",
        title: "Remote child",
        parentReporting: "auto",
        initialPrompt: "Finish first turn",
      },
    });
    expect(creation.isError, JSON.stringify(creation)).not.toBe(true);
    const { agentId: childId } = creation.structuredContent as { agentId: string };
    const inbox = async () =>
      (await parentClient.fetchAgent(parent.id))?.agent.pendingSubagentInbox;
    await expect.poll(inbox, { timeout: 8000 }).toMatchObject({
      count: 1,
      items: [{ agentId: childId, serverId: childHostId, event: "finished" }],
    });
    await childTools.connect(transport(destination.port, childId));
    const report = await childTools.callTool({
      name: "report_to_parent",
      arguments: { status: "completed", summary: "Explicit result replaces the first finish" },
    });
    expect(report.isError, JSON.stringify(report)).not.toBe(true);
    await expect.poll(inbox, { timeout: 8000 }).toMatchObject({
      count: 1,
      items: [{ agentId: childId, serverId: childHostId, reportStatus: "completed" }],
    });
    await childClient.sendMessage(childId, "Finish next turn");
    await expect.poll(inbox, { timeout: 8000 }).toMatchObject({
      count: 2,
      items: [{ reportStatus: "completed" }, { event: "finished" }],
    });
    await childClient.archiveAgent(childId);
    await parentClient.flushAgentInbox(parent.id);
    await parentClient.flushAgentInbox(parent.id);
    const messages = () =>
      manager
        .getTimeline(parent.id)
        .flatMap((item) =>
          item.type === "tool_call" && item.agentMessage?.sender.id === childId
            ? [item.agentMessage]
            : [],
        );
    await expect.poll(messages, { timeout: 8000 }).toHaveLength(2);
    expect(messages()[0]).toMatchObject({ reportStatus: "completed" });
    expect(messages()[1]).toMatchObject({ event: "finished" });
  } finally {
    release.resolve();
    await Promise.allSettled([
      parentTools.close(),
      childTools.close(),
      originApi.dispose(),
      destinationApi.dispose(),
    ]);
    await Promise.allSettled([parentClient.close(), childClient.close()]);
    await Promise.allSettled([origin.close(), destination.close()]);
  }
}, 45_000);
