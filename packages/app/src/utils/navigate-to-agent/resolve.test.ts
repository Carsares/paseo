import { describe, expect, it, vi } from "vitest";
import {
  resolveNavigateToAgent,
  resolveOpenForkSourceAgent,
  type OpenForkSourceAgentDeps,
  type AgentNavTarget,
  type NavigateToAgentDeps,
  type NavigateToAgentInput,
} from "@/utils/navigate-to-agent/resolve";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "workspace-1";
const AGENT_ID = "agent-1";

interface RecordedHostNav {
  route: string;
}

interface RecordedTabNav extends NavigateToWorkspaceInput {}

function createFakeNavigators(target: AgentNavTarget): {
  deps: NavigateToAgentDeps;
  hostNavigations: RecordedHostNav[];
  tabNavigations: RecordedTabNav[];
} {
  const hostNavigations: RecordedHostNav[] = [];
  const tabNavigations: RecordedTabNav[] = [];
  return {
    hostNavigations,
    tabNavigations,
    deps: {
      readAgentNavTarget: () => target,
      navigateToHostAgent: (route) => {
        hostNavigations.push({ route });
      },
      navigateToWorkspace: (input) => {
        tabNavigations.push(input);
        return `/h/${input.serverId}/workspace/${input.workspaceId}`;
      },
    },
  };
}

describe("resolveNavigateToAgent", () => {
  it("carries a request for a tab to the workspace navigation", () => {
    const { deps, tabNavigations } = createFakeNavigators({ agentWorkspaceId: WORKSPACE_ID });

    resolveNavigateToAgent({ serverId: SERVER_ID, agentId: AGENT_ID, asTab: true }, deps);

    expect(tabNavigations[0]).toMatchObject({ asTab: true });
  });

  it("opens the workspace tab carried by the agent's workspaceId", () => {
    const { deps, hostNavigations, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: WORKSPACE_ID,
    });

    const route = resolveNavigateToAgent(
      { serverId: SERVER_ID, agentId: AGENT_ID, pin: true },
      deps,
    );

    expect(route).toBe("/h/server-1/workspace/workspace-1");
    expect(hostNavigations).toEqual([]);
    expect(tabNavigations).toEqual([
      {
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        target: { kind: "agent", agentId: AGENT_ID },
        pin: true,
      },
    ]);
  });

  it("uses the input workspaceId only when the store has no record", () => {
    const readTargets: { serverId: string; agentId: string }[] = [];
    const { deps, tabNavigations } = createFakeNavigators({ agentWorkspaceId: null });
    deps.readAgentNavTarget = (input) => {
      readTargets.push(input);
      return { agentWorkspaceId: null };
    };

    resolveNavigateToAgent(
      { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID },
      deps,
    );

    expect(readTargets).toEqual([{ serverId: SERVER_ID, agentId: AGENT_ID }]);
    expect(tabNavigations).toEqual([
      {
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        target: { kind: "agent", agentId: AGENT_ID },
        pin: undefined,
      },
    ]);
  });

  it("prefers the current agent workspace over a stale input workspace", () => {
    const { deps, tabNavigations } = createFakeNavigators({ agentWorkspaceId: "current" });
    resolveNavigateToAgent({ serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: "stale" }, deps);
    expect(tabNavigations[0]?.workspaceId).toBe("current");
  });

  it("falls back to the host agent route when the agent has no workspaceId", () => {
    const { deps, hostNavigations, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: null,
    });

    const route = resolveNavigateToAgent({ serverId: SERVER_ID, agentId: "missing-agent" }, deps);

    expect(route).toBe("/h/server-1/agent/missing-agent");
    expect(hostNavigations).toEqual([{ route: "/h/server-1/agent/missing-agent" }]);
    expect(tabNavigations).toEqual([]);
  });

  it("preserves the tab intent on the fallback host agent route", () => {
    const { deps, hostNavigations, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: null,
    });
    const route = resolveNavigateToAgent(
      { serverId: SERVER_ID, agentId: AGENT_ID, asTab: true },
      deps,
    );
    expect(route).toBe("/h/server-1/agent/agent-1?asTab=1");
    expect(hostNavigations).toEqual([{ route }]);
    expect(tabNavigations).toEqual([]);
  });
});

describe("resolveOpenForkSourceAgent", () => {
  function createForkDeps(overrides: Partial<OpenForkSourceAgentDeps> = {}) {
    const navigations: NavigateToAgentInput[] = [];
    const fetches: string[] = [];
    const deps: OpenForkSourceAgentDeps = {
      readCachedAgent: () => ({ found: false }),
      navigate: (input) => {
        navigations.push(input);
      },
      ...overrides,
    };
    return { deps, navigations, fetches };
  }

  it("navigates synchronously to a cached agent without fetching", async () => {
    const fetches: string[] = [];
    const { deps, navigations } = createForkDeps({
      readCachedAgent: () => ({ found: true, workspaceId: "workspace-2" }),
      fetchRemoteAgent: async ({ agentId }) => {
        fetches.push(agentId);
        return { found: true };
      },
    });

    const pending = resolveOpenForkSourceAgent(
      { serverId: ` ${SERVER_ID} `, sourceAgentId: ` ${AGENT_ID} ` },
      deps,
    );

    expect(navigations).toEqual([
      {
        serverId: SERVER_ID,
        agentId: AGENT_ID,
        workspaceId: "workspace-2",
        pin: true,
        asTab: true,
      },
    ]);
    await expect(pending).resolves.toBe(true);
    expect(fetches).toEqual([]);
  });

  it("fetches an uncached agent and navigates with the fetched workspace", async () => {
    const { deps, navigations } = createForkDeps({
      fetchRemoteAgent: async () => ({ found: true, workspaceId: "workspace-3" }),
    });

    await expect(
      resolveOpenForkSourceAgent({ serverId: SERVER_ID, sourceAgentId: AGENT_ID }, deps),
    ).resolves.toBe(true);

    expect(navigations).toEqual([
      {
        serverId: SERVER_ID,
        agentId: AGENT_ID,
        workspaceId: "workspace-3",
        pin: true,
        asTab: true,
      },
    ]);
  });

  it("reports not found and stays on the current tab when the agent is missing", async () => {
    const onNotFound = vi.fn();
    const onError = vi.fn();
    const { deps, navigations } = createForkDeps({
      fetchRemoteAgent: async () => ({ found: false }),
    });

    await expect(
      resolveOpenForkSourceAgent(
        { serverId: SERVER_ID, sourceAgentId: AGENT_ID, onNotFound, onError },
        deps,
      ),
    ).resolves.toBe(false);

    expect(onNotFound).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(navigations).toEqual([]);
  });

  it("reports a connection error and stays on the current tab when the fetch throws", async () => {
    const onNotFound = vi.fn();
    const onError = vi.fn();
    const timeout = new Error("Connection timed out");
    const { deps, navigations } = createForkDeps({
      fetchRemoteAgent: async () => {
        throw timeout;
      },
    });

    await expect(
      resolveOpenForkSourceAgent(
        { serverId: SERVER_ID, sourceAgentId: AGENT_ID, onNotFound, onError },
        deps,
      ),
    ).resolves.toBe(false);

    expect(onError).toHaveBeenCalledExactlyOnceWith(timeout);
    expect(onNotFound).not.toHaveBeenCalled();
    expect(navigations).toEqual([]);
  });

  it("navigates by id when no remote lookup is available", async () => {
    const { deps, navigations } = createForkDeps();

    await expect(
      resolveOpenForkSourceAgent({ serverId: SERVER_ID, sourceAgentId: AGENT_ID }, deps),
    ).resolves.toBe(true);

    expect(navigations).toEqual([
      { serverId: SERVER_ID, agentId: AGENT_ID, pin: true, asTab: true },
    ]);
  });

  it("returns false when serverId or sourceAgentId is blank", async () => {
    const { deps, navigations } = createForkDeps();

    await expect(
      resolveOpenForkSourceAgent({ serverId: undefined, sourceAgentId: AGENT_ID }, deps),
    ).resolves.toBe(false);
    await expect(
      resolveOpenForkSourceAgent({ serverId: SERVER_ID, sourceAgentId: "  " }, deps),
    ).resolves.toBe(false);
    expect(navigations).toEqual([]);
  });
});
