/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { getOrCreateClientId } from "@/utils/client-id";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { shallow } from "zustand/shallow";
import { getAgentTabsNeedingOpenLabel, selectOpenTabAgents } from "./open-tab-labels";
import { useOpenAgentTabLabels } from "./use-open-agent-tab-labels";

vi.mock("@/utils/client-id", () => ({ getOrCreateClientId: vi.fn() }));

const label = "paseo.open-agent-tab.client-1";

function tab(agentId: string, createdAt: number): WorkspaceTab {
  return { tabId: `agent_${agentId}`, target: { kind: "agent", agentId }, createdAt };
}

function agent(input: {
  id: string;
  parentAgentId?: string | null;
  open?: boolean;
  workspaceId?: string;
}): Agent {
  return {
    id: input.id,
    parentAgentId: input.parentAgentId ?? null,
    labels: input.open ? { [label]: "true" } : {},
    workspaceId: input.workspaceId,
  } as Agent;
}

describe("getAgentTabsNeedingOpenLabel", () => {
  it("marks every present parented tab, regardless of tab order or focus", () => {
    const agents = new Map([
      ["background-child", agent({ id: "background-child", parentAgentId: "parent" })],
      ["focused-child", agent({ id: "focused-child", parentAgentId: "parent" })],
      ["root", agent({ id: "root" })],
    ]);

    expect(
      getAgentTabsNeedingOpenLabel({
        tabs: [tab("background-child", 1), tab("root", 2), tab("focused-child", 3)],
        getAgent: (agentId) => agents.get(agentId),
        label,
        pendingAgentIds: new Set(),
      }),
    ).toEqual(["background-child", "focused-child"]);
  });

  it("skips tabs already marked or currently being marked", () => {
    const agents = new Map([
      ["marked", agent({ id: "marked", parentAgentId: "parent", open: true })],
      ["pending", agent({ id: "pending", parentAgentId: "parent" })],
    ]);

    expect(
      getAgentTabsNeedingOpenLabel({
        tabs: [tab("marked", 1), tab("pending", 2)],
        getAgent: (agentId) => agents.get(agentId),
        label,
        pendingAgentIds: new Set(["pending"]),
      }),
    ).toEqual([]);
  });

  it("marks parented tabs only in the supplied workspace", () => {
    const local = agent({ id: "local", parentAgentId: "parent", workspaceId: " source " });
    const moved = agent({ id: "moved", parentAgentId: "parent", workspaceId: "destination" });
    const agents = new Map([local, moved].map((entry) => [entry.id, entry]));
    expect(
      getAgentTabsNeedingOpenLabel({
        tabs: [tab("local", 1), tab("moved", 2)],
        getAgent: (agentId) => agents.get(agentId),
        label,
        pendingAgentIds: new Set(),
        workspaceId: "source",
      }),
    ).toEqual(["local"]);
  });
});

describe("useOpenAgentTabLabels", () => {
  const serverId = "open-label-server";
  afterEach(() => {
    cleanup();
    useSessionStore.getState().clearSession(serverId);
  });

  it("rechecks workspace and parentage after resolving the client id", async () => {
    const clientId = Promise.withResolvers<string>();
    vi.mocked(getOrCreateClientId).mockReturnValue(clientId.promise);
    const update = Promise.withResolvers<void>();
    const updateAgent = vi.fn<DaemonClient["updateAgent"]>().mockReturnValue(update.promise);
    const client = { updateAgent } as unknown as DaemonClient;
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client);
    const localChild = (id: string) =>
      agent({ id, parentAgentId: "parent", workspaceId: "source" });
    const local = localChild("local");
    const moved = localChild("moved");
    const detached = localChild("detached");
    const setAgents = (agents: Agent[]) => {
      store.setAgentDetails(serverId, new Map(agents.map((entry) => [entry.id, entry])));
    };
    setAgents([local, moved, detached]);
    const tabs = [tab("local", 1), tab("moved", 2), tab("detached", 3)];
    renderHook(() =>
      useOpenAgentTabLabels({ client, serverId, workspaceId: "source", tabs, enabled: true }),
    );

    await act(async () => {
      setAgents([
        local,
        { ...moved, workspaceId: "destination" },
        { ...detached, parentAgentId: null },
      ]);
      clientId.resolve("client-1");
    });
    update.resolve();
    expect(updateAgent.mock.calls).toEqual([
      ["local", { labels: { [label]: "true" }, expectedWorkspaceId: "source" }],
    ]);
  });
});

describe("selectOpenTabAgents", () => {
  function stateWith(agents: Agent[]) {
    return {
      sessions: {
        srv: { agents: new Map(agents.map((entry) => [entry.id, entry])), agentDetails: new Map() },
      },
    };
  }

  it("stays equal when only an agent without an open tab changes", () => {
    const open = agent({ id: "open" });
    const before = selectOpenTabAgents(stateWith([open, agent({ id: "elsewhere" })]), {
      serverId: "srv",
      agentIds: ["open"],
    });
    const after = selectOpenTabAgents(stateWith([open, agent({ id: "elsewhere" })]), {
      serverId: "srv",
      agentIds: ["open"],
    });

    expect(shallow(before, after)).toBe(true);
  });

  it("changes when an agent with an open tab changes", () => {
    const elsewhere = agent({ id: "elsewhere" });
    const before = selectOpenTabAgents(stateWith([agent({ id: "open" }), elsewhere]), {
      serverId: "srv",
      agentIds: ["open"],
    });
    const after = selectOpenTabAgents(stateWith([agent({ id: "open" }), elsewhere]), {
      serverId: "srv",
      agentIds: ["open"],
    });

    expect(shallow(before, after)).toBe(false);
  });

  it("falls back to agent details and returns null for unknown agents", () => {
    const detail = agent({ id: "detail" });
    const state = {
      sessions: {
        srv: { agents: new Map<string, Agent>(), agentDetails: new Map([["detail", detail]]) },
      },
    };

    expect(
      selectOpenTabAgents(state, { serverId: "srv", agentIds: ["detail", "missing"] }),
    ).toEqual([detail, null]);
  });
});
