import { describe, expect, it } from "vitest";
import { selectWorkspaceAgentRecipients, type WorkspaceRecipientAgent } from "./recipients";
import type { WorkspaceTab } from "@/workspace-tabs/model";

function agent(
  id: string,
  overrides: Partial<WorkspaceRecipientAgent> = {},
): WorkspaceRecipientAgent {
  return {
    id,
    serverId: "host",
    workspaceId: "workspace",
    title: id,
    labels: {},
    status: "closed",
    turn: { phase: "idle", cancellationRequestId: null },
    ...overrides,
  };
}

function tab(agentId: string): WorkspaceTab {
  return { tabId: `real-${agentId}`, target: { kind: "agent", agentId }, createdAt: 1 };
}

describe("workspace agent recipients", () => {
  it("ranks the quiet main, residents and active first-level agents before open direct chats", () => {
    const main = agent("main", { labels: { "paseo.workspace-role": "main" } });
    const direct = agent("direct");
    const side = agent("side", { labels: { "paseo.side-chat": "true" } });
    const resident = agent("resident", { labels: { "paseo.resident": "true" } });
    const lead = agent("lead", { labels: { "paseo.parent-agent-id": "main" }, status: "running" });
    const recipients = selectWorkspaceAgentRecipients({
      serverId: "host",
      workspaceId: "workspace",
      scope: { kind: "legacy" },
      agents: [direct, side, resident, lead, main, main],
      tabs: [tab("side"), tab("direct"), tab("direct")],
    });
    expect(
      recipients.map((recipient) =>
        recipient.kind === "agent" ? recipient.agent.id : recipient.kind,
      ),
    ).toEqual(["main", "resident", "lead", "direct", "side"]);
    expect(recipients[0]).toMatchObject({ kind: "agent", tab: null });
    expect(recipients[3]).toMatchObject({ kind: "agent", tab: { tabId: "real-direct" } });
  });

  it("filters other workspaces, archived and background agents, unopened chats and inactive descendants", () => {
    const agents = [
      agent("foreign", { workspaceId: "other", labels: { "paseo.workspace-role": "main" } }),
      agent("other-host", { serverId: "other" }),
      agent("archived", { archivedAt: new Date() }),
      agent("background", { background: true }),
      agent("unopened"),
      agent("child", { labels: { "paseo.parent-agent-id": "missing" } }),
      agent("side", { labels: { "paseo.side-chat": "true" } }),
    ];
    expect(
      selectWorkspaceAgentRecipients({
        serverId: "host",
        workspaceId: "workspace",
        scope: { kind: "legacy" },
        agents,
        tabs: [tab("foreign"), tab("other-host"), tab("archived"), tab("background"), tab("child")],
      }),
    ).toEqual([]);
  });

  it("offers binding only for an explicitly unbound topic and ignores stale main labels", () => {
    const stale = agent("stale", { labels: { "paseo.workspace-role": "main" } });
    const input = {
      serverId: "host",
      workspaceId: "workspace",
      agents: [stale],
      tabs: [tab("stale")],
    };
    expect(
      selectWorkspaceAgentRecipients({ ...input, scope: { kind: "topic", mainAgentId: null } }),
    ).toEqual([{ kind: "bind_main" }, { kind: "agent", agent: stale, tab: tab("stale") }]);
    expect(selectWorkspaceAgentRecipients({ ...input, scope: { kind: "legacy" } })).toEqual([
      { kind: "agent", agent: stale, tab: tab("stale") },
    ]);
    expect(
      selectWorkspaceAgentRecipients({ ...input, agents: [], tabs: [], scope: { kind: "legacy" } }),
    ).toEqual([]);
  });

  it("does not offer binding when the authoritative main is absent from the directory", () => {
    const stale = agent("stale", { labels: { "paseo.workspace-role": "main" } });
    const lead = agent("lead", { labels: { "paseo.parent-agent-id": "main" }, status: "running" });
    expect(
      selectWorkspaceAgentRecipients({
        serverId: "host",
        workspaceId: "workspace",
        scope: { kind: "topic", mainAgentId: "main" },
        agents: [stale, lead],
        tabs: [],
      }),
    ).toEqual([{ kind: "agent", agent: lead, tab: null }]);
  });

  it("uses the bound main id over stale labels and still checks workspace eligibility", () => {
    const main = agent("main");
    const stale = agent("stale", { labels: { "paseo.workspace-role": "main" } });
    const foreign = agent("foreign", { workspaceId: "other" });
    const input = {
      serverId: "host",
      workspaceId: "workspace",
      agents: [stale, main, foreign],
      tabs: [tab("stale"), tab("foreign")],
    };
    expect(
      selectWorkspaceAgentRecipients({ ...input, scope: { kind: "topic", mainAgentId: "main" } }),
    ).toEqual([
      { kind: "agent", agent: main, tab: null },
      { kind: "agent", agent: stale, tab: tab("stale") },
    ]);
    expect(
      selectWorkspaceAgentRecipients({
        ...input,
        scope: { kind: "topic", mainAgentId: "foreign" },
      }),
    ).toEqual([{ kind: "agent", agent: stale, tab: tab("stale") }]);
  });

  it("counts only running background work when available, with count as the legacy fallback", () => {
    const main = agent("main", { labels: { "paseo.workspace-role": "main" } });
    const labels = { "paseo.parent-agent-id": "main" };
    const finished = agent("finished", { labels, backgroundWork: { count: 1, runningCount: 0 } });
    const running = agent("running", { labels, backgroundWork: { count: 1, runningCount: 1 } });
    const legacy = agent("legacy", { labels, backgroundWork: { count: 1 } });
    expect(
      selectWorkspaceAgentRecipients({
        serverId: "host",
        workspaceId: "workspace",
        scope: { kind: "legacy" },
        agents: [main, finished, running, legacy],
        tabs: [],
      }),
    ).toEqual([
      { kind: "agent", agent: main, tab: null },
      { kind: "agent", agent: running, tab: null },
      { kind: "agent", agent: legacy, tab: null },
    ]);
  });
});
