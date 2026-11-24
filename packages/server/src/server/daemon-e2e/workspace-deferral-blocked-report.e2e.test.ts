import { PARENT_AGENT_ID_LABEL, PARENT_REPORTING_LABEL } from "@getpaseo/protocol/agent-labels";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { createDaemonTestContext } from "../test-utils/index.js";

test("only a persisted blocked parent report restores its parked workspace", async () => {
  const ctx = await createDaemonTestContext({ mcpEnabled: true });
  try {
    expect(ctx.client.getLastServerInfoMessage()?.features?.workspaceDeferral).toBe(true);
    const manager = ctx.daemon.daemon.agentManager;
    const parent = await ctx.client.createAgent({ provider: "codex", cwd: ctx.daemon.staticDir });
    const workspaceId = (await ctx.daemon.daemon.agentStorage.get(parent.id))?.workspaceId;
    if (!workspaceId) throw new Error("The parent has no workspace");
    await manager.setAgentMainControl(parent.id, true);
    const child = () =>
      manager.createAgent({ provider: "codex", cwd: parent.cwd }, undefined, {
        workspaceId,
        labels: { [PARENT_AGENT_ID_LABEL]: parent.id, [PARENT_REPORTING_LABEL]: "explicit" },
      });
    const completedChild = await child();
    const blockedChild = await child();

    const readWorkspace = async () => {
      const result = await ctx.client.fetchWorkspaces();
      return result.entries.find((workspace) => workspace.id === workspaceId);
    };
    const report = async (agentId: string, status: "completed" | "blocked", summary: string) => {
      const tools = new Client({ name: "reporter", version: "1" });
      try {
        await tools.connect(
          new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${ctx.daemon.port}/mcp/agents?callerAgentId=${agentId}`),
          ),
        );
        const result = await tools.callTool({
          name: "report_to_parent",
          arguments: { status, summary },
        });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
      } finally {
        await tools.close();
      }
    };
    const delivered = () =>
      manager
        .getTimeline(parent.id)
        .flatMap((item) =>
          item.type === "tool_call" && item.agentMessage ? [item.agentMessage.reportStatus] : [],
        );

    await ctx.client.setWorkspaceDeferral({ workspaceId, action: "park" });
    expect((await readWorkspace())?.parkedAt).toBeTruthy();
    await report(completedChild.id, "completed", "The word blocked is ordinary report text.");
    await expect.poll(delivered, { timeout: 8_000 }).toContain("completed");
    expect((await readWorkspace())?.parkedAt).toBeTruthy();

    await report(blockedChild.id, "blocked", "A decision is required.");
    await expect.poll(delivered, { timeout: 8_000 }).toContain("blocked");
    const restored = await readWorkspace();
    expect(restored?.id).toBe(workspaceId);
    expect(restored).not.toHaveProperty("parkedAt");
  } finally {
    await ctx.cleanup();
  }
}, 30_000);
