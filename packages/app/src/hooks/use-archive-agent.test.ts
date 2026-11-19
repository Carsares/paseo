import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDirectoryReplica } from "@/runtime/directory-sync/agent-replica";
import type { Agent } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { agentHistoryQueryKey, allAgentHistoryQueryKey } from "./agent-history-query-key";
import {
  applyArchivedAgentCloseResults,
  isAgentArchiving,
  removeAgentFromListPayload,
  selectPendingArchiveAgentIds,
  setAgentArchiving,
} from "./use-archive-agent";

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    archiveAgentSnapshot: (serverId: string, agentId: string, archivedAt: string) => {
      const replica = new AgentDirectoryReplica(
        serverId,
        () => {},
        () => {},
      );
      replica.archive(agentId, archivedAt);
    },
  }),
}));

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    serverId: "server-a",
    id: "agent-1",
    provider: "codex",
    status: "running",
    createdAt: new Date("2026-04-01T03:00:00.000Z"),
    updatedAt: new Date("2026-04-01T03:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-04-01T03:00:00.000Z"),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: "Agent 1",
    cwd: "/repo",
    model: null,
    parentAgentId: null,
    labels: {},
    archivedAt: null,
    ...overrides,
    turn: overrides.turn ?? { phase: "idle", cancellationRequestId: null },
  };
}

describe("useArchiveAgent", () => {
  afterEach(() => useSessionStore.setState({ sessions: {} }));
  beforeEach(() => useSessionStore.setState({ sessions: {} }));

  it("tracks pending archive state in shared react-query cache", () => {
    const queryClient = new QueryClient();

    expect(
      isAgentArchiving({
        queryClient,
        serverId: "server-a",
        agentId: "agent-1",
      }),
    ).toBe(false);

    setAgentArchiving({
      queryClient,
      serverId: "server-a",
      agentId: "agent-1",
      isArchiving: true,
    });

    expect(
      isAgentArchiving({
        queryClient,
        serverId: "server-a",
        agentId: "agent-1",
      }),
    ).toBe(true);
    expect(
      isAgentArchiving({
        queryClient,
        serverId: "server-a",
        agentId: "agent-2",
      }),
    ).toBe(false);

    setAgentArchiving({
      queryClient,
      serverId: "server-a",
      agentId: "agent-1",
      isArchiving: false,
    });

    expect(
      isAgentArchiving({
        queryClient,
        serverId: "server-a",
        agentId: "agent-1",
      }),
    ).toBe(false);
  });

  it("selects pending archive ids for a single server", () => {
    const pendingIds = selectPendingArchiveAgentIds(
      {
        "server-a:agent-1": true,
        "server-a:agent-2": true,
        "server-b:agent-3": true,
      },
      "server-a",
    );

    expect(Array.from(pendingIds)).toEqual(["agent-1", "agent-2"]);
  });

  it("removes an archived agent from cached list payloads", () => {
    const payload = {
      entries: [{ agent: { id: "agent-1" } }, { agent: { id: "agent-2" } }],
      pageInfo: { hasMore: false },
    };

    const next = removeAgentFromListPayload(payload, "agent-1");

    expect(next.entries).toEqual([{ agent: { id: "agent-2" } }]);
    expect(next.pageInfo).toEqual({ hasMore: false });
  });

  it("applies archived agent close results to session state and cached lists", async () => {
    const queryClient = new QueryClient();
    useSessionStore.getState().initializeSession("server-a", {} as DaemonClient);
    useSessionStore.getState().setAgents("server-a", new Map([["agent-1", makeAgent()]]));
    queryClient.setQueryData(["sidebarAgentsList", "server-a"], {
      entries: [{ agent: { id: "agent-1" } }, { agent: { id: "agent-2" } }],
    });
    queryClient.setQueryData(["allAgents", "server-a"], {
      entries: [{ agent: { id: "agent-1" } }, { agent: { id: "agent-2" } }],
    });
    queryClient.setQueryData(agentHistoryQueryKey("server-a"), {
      pages: [
        {
          agents: [
            { id: "agent-1", archivedAt: null },
            { id: "agent-2", archivedAt: null },
          ],
        },
      ],
      pageParams: [null],
    });
    queryClient.setQueryData(allAgentHistoryQueryKey(["server-a", "server-b"]), {
      pages: [
        {
          agents: [
            { id: "agent-1", serverId: "server-a", archivedAt: null },
            { id: "agent-1", serverId: "server-b", archivedAt: null },
          ],
        },
      ],
      pageParams: [null],
    });

    applyArchivedAgentCloseResults({
      queryClient,
      serverId: "server-a",
      results: [{ agentId: "agent-1", archivedAt: "2026-04-01T04:00:00.000Z" }],
    });

    expect(
      useSessionStore
        .getState()
        .sessions["server-a"]?.agents.get("agent-1")
        ?.archivedAt?.toISOString(),
    ).toBe("2026-04-01T04:00:00.000Z");
    expect(queryClient.getQueryData(["sidebarAgentsList", "server-a"])).toEqual({
      entries: [{ agent: { id: "agent-2" } }],
    });
    expect(queryClient.getQueryData(["allAgents", "server-a"])).toEqual({
      entries: [{ agent: { id: "agent-2" } }],
    });
    expect(queryClient.getQueryData(agentHistoryQueryKey("server-a"))).toEqual({
      pages: [
        {
          agents: [
            { id: "agent-1", archivedAt: new Date("2026-04-01T04:00:00.000Z") },
            { id: "agent-2", archivedAt: null },
          ],
        },
      ],
      pageParams: [null],
    });
    expect(
      queryClient.getQueryState(allAgentHistoryQueryKey(["server-a", "server-b"]))?.isInvalidated,
    ).toBe(true);
    expect(queryClient.getQueryData(allAgentHistoryQueryKey(["server-a", "server-b"]))).toEqual({
      pages: [
        {
          agents: [
            {
              id: "agent-1",
              serverId: "server-a",
              archivedAt: new Date("2026-04-01T04:00:00.000Z"),
            },
            { id: "agent-1", serverId: "server-b", archivedAt: null },
          ],
        },
      ],
      pageParams: [null],
    });
  });

  it("can apply archived agent close results without invalidating cached lists", () => {
    const queryClient = new QueryClient();
    useSessionStore.getState().initializeSession("server-a", {} as DaemonClient);
    useSessionStore.getState().setAgents("server-a", new Map([["agent-1", makeAgent()]]));
    queryClient.setQueryData(["sidebarAgentsList", "server-a"], {
      entries: [{ agent: { id: "agent-1" } }, { agent: { id: "agent-2" } }],
    });
    queryClient.setQueryData(["allAgents", "server-a"], {
      entries: [{ agent: { id: "agent-1" } }, { agent: { id: "agent-2" } }],
    });
    queryClient.setQueryData(agentHistoryQueryKey("server-a"), {
      pages: [
        {
          agents: [{ id: "agent-1", archivedAt: null }],
        },
      ],
      pageParams: [null],
    });
    queryClient.setQueryData(allAgentHistoryQueryKey(["server-a"]), {
      pages: [{ agents: [{ id: "agent-1", serverId: "server-a", archivedAt: null }] }],
      pageParams: [null],
    });

    applyArchivedAgentCloseResults({
      queryClient,
      serverId: "server-a",
      results: [{ agentId: "agent-1", archivedAt: "2026-04-01T04:00:00.000Z" }],
      invalidateQueries: false,
    });

    expect(queryClient.getQueryState(["sidebarAgentsList", "server-a"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["allAgents", "server-a"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(agentHistoryQueryKey("server-a"))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(allAgentHistoryQueryKey(["server-a"]))?.isInvalidated).toBe(
      false,
    );
    expect(queryClient.getQueryData(agentHistoryQueryKey("server-a"))).toEqual({
      pages: [
        {
          agents: [{ id: "agent-1", archivedAt: new Date("2026-04-01T04:00:00.000Z") }],
        },
      ],
      pageParams: [null],
    });
    expect(queryClient.getQueryData(allAgentHistoryQueryKey(["server-a"]))).toEqual({
      pages: [
        {
          agents: [
            {
              id: "agent-1",
              serverId: "server-a",
              archivedAt: new Date("2026-04-01T04:00:00.000Z"),
            },
          ],
        },
      ],
      pageParams: [null],
    });
  });

  it("marks matching entries and ancestor context in scoped single-host history", () => {
    const queryClient = new QueryClient();
    const activeKey = [...agentHistoryQueryKey("server-a"), "title", { archiveScope: "active" }];
    const archivedKey = [...agentHistoryQueryKey("server-a"), "", { archiveScope: "archived" }];
    const otherHostKey = [...agentHistoryQueryKey("server-b"), "", { archiveScope: "active" }];
    const agent = { id: "agent-1", archivedAt: null };
    queryClient.setQueryData(activeKey, { pages: [{ agents: [agent] }], pageParams: [null] });
    queryClient.setQueryData(archivedKey, {
      pages: [{ agents: [], ancestors: [agent] }],
      pageParams: [null],
    });
    queryClient.setQueryData(otherHostKey, { pages: [{ agents: [agent] }], pageParams: [null] });

    const archivedAt = new Date("2026-04-01T04:00:00.000Z");
    applyArchivedAgentCloseResults({
      queryClient,
      serverId: "server-a",
      results: [{ agentId: agent.id, archivedAt: archivedAt.toISOString() }],
      invalidateQueries: false,
    });

    expect(queryClient.getQueryData(activeKey)).toEqual({
      pages: [{ agents: [{ ...agent, archivedAt }] }],
      pageParams: [null],
    });
    expect(queryClient.getQueryData(archivedKey)).toEqual({
      pages: [{ agents: [], ancestors: [{ ...agent, archivedAt }] }],
      pageParams: [null],
    });
    expect(queryClient.getQueryData(otherHostKey)).toEqual({
      pages: [{ agents: [agent] }],
      pageParams: [null],
    });
  });
});
