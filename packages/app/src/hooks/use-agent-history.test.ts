/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DaemonClient,
  FetchAgentHistoryEntry,
  FetchAgentHistoryOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentHistoryClient, AgentHistoryHost } from "./use-agent-history";
import { agentHistoryQueryKey, allAgentHistoryQueryKey } from "./agent-history-query-key";
import { markAgentArchivedInHistoryCache, useArchiveAgent } from "./use-archive-agent";

interface HistoryFeatureState {
  sessions: Record<
    string,
    {
      agents?: Map<string, never>;
      client?: Pick<DaemonClient, "archiveAgent">;
      serverInfo: {
        features: {
          agentHistorySearch: boolean;
          agentHistoryArchiveScope: boolean;
          agentHistoryQueryControls: boolean;
        };
      };
    }
  >;
}

const onlineStatuses = new Map([
  ["server-a", "online"],
  ["server-b", "online"],
]);
let runtimeHosts: AgentHistoryHost[] = [];
let registeredHosts: Array<{ serverId: string; label: string }> = [];
let featureState: HistoryFeatureState = { sessions: {} };
const runtime = {
  getClient: (id: string) => runtimeHosts.find(({ serverId }) => serverId === id)?.client,
  archiveAgentSnapshot: vi.fn(),
  restoreAgentSnapshot: vi.fn(),
};
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => runtime,
  useHosts: () => registeredHosts,
  useHostRuntimeConnectionStatuses: () => onlineStatuses,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: Object.assign(
    (select: (state: HistoryFeatureState) => unknown) => select(featureState),
    { getState: () => featureState },
  ),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const {
  fetchAgentHistoryBatch,
  fetchAgentHistoryPage,
  collectAgentHistoryHostErrors,
  useAgentHistory,
} = await import("./use-agent-history");

type FetchAgentHistory = DaemonClient["fetchAgentHistory"];
type FetchAgentHistoryResult = Awaited<ReturnType<FetchAgentHistory>>;

interface FakeAgentHistoryClient extends AgentHistoryClient {
  calls: FetchAgentHistoryOptions[];
}

function createClient(pages: FetchAgentHistoryResult[]): FakeAgentHistoryClient {
  const calls: FetchAgentHistoryOptions[] = [];
  let index = 0;
  return {
    calls,
    fetchAgentHistory: async (options) => {
      calls.push(options ?? {});
      const page = pages[index] ?? pages[pages.length - 1];
      index += 1;
      if (!page) {
        throw new Error("No more history pages configured");
      }
      return page;
    },
  };
}

function createFailingClient(): FakeAgentHistoryClient {
  const calls: FetchAgentHistoryOptions[] = [];
  return {
    calls,
    fetchAgentHistory: async (options) => {
      calls.push(options ?? {});
      throw new Error("Host history failed");
    },
  };
}

function historyPayload(input: {
  entries: FetchAgentHistoryEntry[];
  ancestors?: FetchAgentHistoryResult["ancestors"];
  hasMore?: boolean;
  nextCursor?: string | null;
  searchTruncated?: boolean;
}): FetchAgentHistoryResult {
  return {
    requestId: "req_history",
    entries: input.entries,
    ...(input.ancestors ? { ancestors: input.ancestors } : {}),
    pageInfo: {
      nextCursor: input.nextCursor ?? null,
      prevCursor: null,
      hasMore: input.hasMore ?? false,
    },
    ...(input.searchTruncated === undefined ? {} : { searchTruncated: input.searchTruncated }),
  };
}

function historyEntry(input: {
  id: string;
  cwd: string;
  updatedAt: string;
  title?: string | null;
  archivedAt?: string | null;
  searchScore?: number;
}): FetchAgentHistoryEntry {
  return {
    agent: {
      id: input.id,
      provider: "codex",
      status: "closed",
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
      lastUserMessageAt: null,
      lastError: undefined,
      runtimeInfo: {
        provider: "codex",
        sessionId: null,
      },
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
      title: input.title ?? null,
      cwd: input.cwd,
      model: null,
      thinkingOptionId: null,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: input.archivedAt ?? null,
      labels: {},
    },
    project: {
      projectKey: input.cwd,
      projectName: "workspace",
      checkout: {
        cwd: input.cwd,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
    ...(input.searchScore === undefined ? {} : { searchScore: input.searchScore }),
  };
}

describe("fetchAgentHistoryPage", () => {
  it("builds the all-host query key independent of host order", () => {
    expect(allAgentHistoryQueryKey(["server-b", "server-a"])).toEqual(
      allAgentHistoryQueryKey(["server-a", "server-b"]),
    );
  });

  it("requests the first page with the default limit and updated_at descending sort", async () => {
    const client = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "history-1",
            cwd: "/repo",
            updatedAt: "2026-04-02T10:00:00.000Z",
            title: "History one",
          }),
        ],
        hasMore: true,
        nextCursor: "cursor-2",
      }),
    ]);

    const page = await fetchAgentHistoryPage({ client, serverId: "server-1", cursor: null });

    expect(client.calls).toEqual([
      {
        sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: 200 },
      } satisfies FetchAgentHistoryOptions,
    ]);
    expect(page.ancestors).toEqual([]);
    expect(page.agents.map((agent) => agent.id)).toEqual(["history-1"]);
    expect(page.pageInfo).toEqual({
      nextCursor: "cursor-2",
      prevCursor: null,
      hasMore: true,
    });
  });

  it("passes the cursor when fetching subsequent pages", async () => {
    const client = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "history-2",
            cwd: "/repo",
            updatedAt: "2026-04-01T10:00:00.000Z",
            title: "History two",
          }),
        ],
      }),
    ]);

    await fetchAgentHistoryPage({ client, serverId: "server-1", cursor: "cursor-2" });

    expect(client.calls.at(-1)).toEqual({
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 200, cursor: "cursor-2" },
    } satisfies FetchAgentHistoryOptions);
  });

  it("maps daemon history entries into aggregated agents tagged with the requested server", async () => {
    const client = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "history-1",
            cwd: "/repo",
            updatedAt: "2026-04-02T10:00:00.000Z",
            title: "History one",
          }),
        ],
      }),
    ]);

    const page = await fetchAgentHistoryPage({ client, serverId: "server-1", cursor: null });

    expect(page.agents).toEqual([
      expect.objectContaining({
        id: "history-1",
        serverId: "server-1",
        serverLabel: "server-1",
        title: "History one",
        cwd: "/repo",
        provider: "codex",
        archivedAt: null,
      }),
    ]);
  });

  it("carries archived entries through with their archivedAt timestamp", async () => {
    const client = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "history-archived",
            cwd: "/repo",
            updatedAt: "2026-04-01T10:00:00.000Z",
            archivedAt: "2026-04-01T10:05:00.000Z",
          }),
        ],
      }),
    ]);

    const page = await fetchAgentHistoryPage({ client, serverId: "server-1", cursor: null });

    expect(page.agents[0]?.archivedAt).toEqual(new Date("2026-04-01T10:05:00.000Z"));
  });

  it("fetches and sorts history across hosts with host labels", async () => {
    const serverAClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "older-a",
            cwd: "/repo/a",
            updatedAt: "2026-04-01T10:00:00.000Z",
            title: "Older A",
          }),
        ],
      }),
    ]);
    const serverBClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "newer-b",
            cwd: "/repo/b",
            updatedAt: "2026-04-02T10:00:00.000Z",
            title: "Newer B",
          }),
        ],
      }),
    ]);

    const page = await fetchAgentHistoryBatch({
      hosts: [
        { serverId: "server-a", serverLabel: "MacBook", client: serverAClient },
        { serverId: "server-b", serverLabel: "Linux box", client: serverBClient },
      ] satisfies AgentHistoryHost[],
      cursorByServerId: null,
    });

    expect(page.agents.map((agent) => `${agent.serverLabel}:${agent.id}`)).toEqual([
      "Linux box:newer-b",
      "MacBook:older-a",
    ]);
  });

  it("sends the query to the daemon rather than filtering the page locally", async () => {
    const client = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "match",
            cwd: "/repo/a",
            updatedAt: "2026-04-01T10:00:00.000Z",
            title: "Add Stripe billing",
            searchScore: 1000,
          }),
        ],
      }),
    ]);

    const page = await fetchAgentHistoryPage({
      client,
      serverId: "server-1",
      cursor: null,
      search: "stripe",
    });

    expect(client.calls[0]?.search).toBe("stripe");
    expect(page.agents.map((agent) => agent.id)).toEqual(["match"]);
  });

  it("keeps sessions with the same id on different hosts and sorts by recency", async () => {
    const sharedId = "collision";
    const serverAClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: sharedId,
            cwd: "/repo/a",
            updatedAt: "2026-04-09T10:00:00.000Z",
            title: "Weak match on A",
            searchScore: 4000,
          }),
        ],
      }),
    ]);
    const serverBClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: sharedId,
            cwd: "/repo/b",
            updatedAt: "2026-04-01T10:00:00.000Z",
            title: "Strong match on B",
            searchScore: 1000,
          }),
        ],
      }),
    ]);

    const page = await fetchAgentHistoryBatch({
      hosts: [
        { serverId: "server-a", serverLabel: "MacBook", client: serverAClient },
        { serverId: "server-b", serverLabel: "Linux box", client: serverBClient },
      ] satisfies AgentHistoryHost[],
      cursorByServerId: null,
      search: "match",
    });

    expect(page.agents.map((agent) => agent.title)).toEqual([
      "Weak match on A",
      "Strong match on B",
    ]);
  });

  it("reports truncation when a host had more matches than its page could hold", async () => {
    const client = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "top",
            cwd: "/repo/a",
            updatedAt: "2026-04-01T10:00:00.000Z",
            title: "Top match",
            searchScore: 1000,
          }),
        ],
        searchTruncated: true,
      }),
    ]);

    const page = await fetchAgentHistoryBatch({
      hosts: [
        { serverId: "server-a", serverLabel: "MacBook", client },
      ] satisfies AgentHistoryHost[],
      cursorByServerId: null,
      search: "match",
    });

    expect(page.isSearchTruncated).toBe(true);
    // A ranked response promises no next page, so nothing can ask for one.
    expect(page.pageInfoByServerId["server-a"]).toEqual({
      nextCursor: null,
      prevCursor: null,
      hasMore: false,
    });
  });

  it("preserves every matching row when merging complete host pages", async () => {
    // Each host owns its cursor; merging must not discard rows already consumed.
    const buildHost = (serverId: string, count: number) =>
      createClient([
        historyPayload({
          entries: Array.from({ length: count }, (_, index) =>
            historyEntry({
              id: `${serverId}-${index}`,
              cwd: `/repo/${serverId}`,
              updatedAt: "2026-04-01T10:00:00.000Z",
              title: `Match ${index}`,
              searchScore: 1000 + index,
            }),
          ),
        }),
      ]);

    const page = await fetchAgentHistoryBatch({
      hosts: [
        { serverId: "server-a", serverLabel: "MacBook", client: buildHost("server-a", 150) },
        { serverId: "server-b", serverLabel: "Linux box", client: buildHost("server-b", 150) },
      ] satisfies AgentHistoryHost[],
      cursorByServerId: null,
      search: "match",
    });

    expect(page.isSearchTruncated).toBe(false);
    expect(page.agents).toHaveLength(300);
  });

  it("names the host that failed instead of quietly shortening the list", async () => {
    const workingClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "reachable",
            cwd: "/repo/a",
            updatedAt: "2026-04-01T10:00:00.000Z",
            title: "Reachable match",
            searchScore: 1000,
          }),
        ],
      }),
    ]);

    const page = await fetchAgentHistoryBatch({
      hosts: [
        { serverId: "server-a", serverLabel: "MacBook", client: workingClient },
        { serverId: "server-b", serverLabel: "Linux box", client: createFailingClient() },
      ] satisfies AgentHistoryHost[],
      cursorByServerId: null,
      search: "match",
    });

    expect(page.hostErrors).toEqual([{ serverId: "server-b", serverName: "Linux box" }]);
    expect(page.agents.map((agent) => agent.id)).toEqual(["reachable"]);
  });

  it("keeps naming a host that failed page one when another host loads page two", async () => {
    // A host that rejects the first page contributes no cursor, so it is never
    // asked again. Reading only the newest page would drop its error while its
    // history stays missing, so the projection has to see every page.
    const workingClient = createClient([
      historyPayload({
        entries: [
          historyEntry({ id: "page-1", cwd: "/repo/a", updatedAt: "2026-04-02T10:00:00.000Z" }),
        ],
        hasMore: true,
        nextCursor: "cursor-2",
      }),
      historyPayload({
        entries: [
          historyEntry({ id: "page-2", cwd: "/repo/a", updatedAt: "2026-04-01T10:00:00.000Z" }),
        ],
      }),
    ]);
    const hosts = [
      { serverId: "server-a", serverLabel: "MacBook", client: workingClient },
      { serverId: "server-b", serverLabel: "Linux box", client: createFailingClient() },
    ] satisfies AgentHistoryHost[];

    const firstPage = await fetchAgentHistoryBatch({ hosts, cursorByServerId: null });
    const secondPage = await fetchAgentHistoryBatch({
      hosts,
      cursorByServerId: { "server-a": "cursor-2" },
    });

    // Only the healthy host is re-fetched, so the second page carries no error
    // of its own. That is exactly why the screen cannot read the newest page.
    expect(secondPage.hostErrors).toEqual([]);
    expect(secondPage.agents.map((agent) => agent.id)).toEqual(["page-2"]);
    expect(
      collectAgentHistoryHostErrors({
        pages: [firstPage, secondPage],
        unreachableHosts: [],
      }),
    ).toEqual([{ serverId: "server-b", serverName: "Linux box" }]);
  });

  it("reports a host that is not connected alongside one whose request failed", () => {
    expect(
      collectAgentHistoryHostErrors({
        pages: [{ hostErrors: [{ serverId: "server-b", serverName: "Linux box" }] }],
        unreachableHosts: [{ serverId: "server-c", serverName: "Offline box" }],
      }),
    ).toEqual([
      { serverId: "server-c", serverName: "Offline box" },
      { serverId: "server-b", serverName: "Linux box" },
    ]);
  });

  it("names a host once when it is both unreachable and failed", () => {
    expect(
      collectAgentHistoryHostErrors({
        pages: [{ hostErrors: [{ serverId: "server-b", serverName: "Linux box" }] }],
        unreachableHosts: [{ serverId: "server-b", serverName: "Linux box" }],
      }),
    ).toEqual([{ serverId: "server-b", serverName: "Linux box" }]);
  });
  it("orders searched history chronologically regardless of match strength", async () => {
    const serverAClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "newer-weak-match",
            cwd: "/repo/a",
            updatedAt: "2026-04-09T10:00:00.000Z",
            title: "Unbilled usage report",
            searchScore: 4000,
          }),
        ],
      }),
    ]);
    const serverBClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "older-strong-match",
            cwd: "/repo/b",
            updatedAt: "2026-04-01T10:00:00.000Z",
            title: "Bill the customer",
            searchScore: 1000,
          }),
        ],
      }),
    ]);

    const page = await fetchAgentHistoryBatch({
      hosts: [
        { serverId: "server-a", serverLabel: "MacBook", client: serverAClient },
        { serverId: "server-b", serverLabel: "Linux box", client: serverBClient },
      ] satisfies AgentHistoryHost[],
      cursorByServerId: null,
      search: "bill",
    });

    expect(page.agents.map((agent) => agent.id)).toEqual([
      "newer-weak-match",
      "older-strong-match",
    ]);
  });

  it("fetches only hosts with a cursor when loading the next all-host page", async () => {
    const serverAClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "next-a",
            cwd: "/repo/a",
            updatedAt: "2026-04-01T10:00:00.000Z",
          }),
        ],
      }),
    ]);
    const serverBClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "next-b",
            cwd: "/repo/b",
            updatedAt: "2026-04-02T10:00:00.000Z",
          }),
        ],
      }),
    ]);

    const page = await fetchAgentHistoryBatch({
      hosts: [
        { serverId: "server-a", serverLabel: "MacBook", client: serverAClient },
        { serverId: "server-b", serverLabel: "Linux box", client: serverBClient },
      ] satisfies AgentHistoryHost[],
      cursorByServerId: { "server-b": "cursor-b" },
      search: "match",
    });

    expect(page.agents.map((agent) => agent.id)).toEqual(["next-b"]);
    expect(serverAClient.calls).toEqual([]);
    expect(serverBClient.calls).toEqual([
      {
        sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: 200, cursor: "cursor-b" },
        search: "match",
      } satisfies FetchAgentHistoryOptions,
    ]);
  });

  it("keeps fulfilled host history when another host fails", async () => {
    const failedClient = createFailingClient();
    const healthyClient = createClient([
      historyPayload({
        entries: [
          historyEntry({
            id: "healthy-history",
            cwd: "/repo/healthy",
            updatedAt: "2026-04-02T10:00:00.000Z",
          }),
        ],
        hasMore: true,
        nextCursor: "healthy-cursor",
      }),
    ]);

    const page = await fetchAgentHistoryBatch({
      hosts: [
        { serverId: "failed-host", serverLabel: "Failed", client: failedClient },
        { serverId: "healthy-host", serverLabel: "Healthy", client: healthyClient },
      ] satisfies AgentHistoryHost[],
      cursorByServerId: null,
    });

    expect(page.agents.map((agent) => `${agent.serverLabel}:${agent.id}`)).toEqual([
      "Healthy:healthy-history",
    ]);
    expect(page.pageInfoByServerId).toEqual({
      "healthy-host": {
        nextCursor: "healthy-cursor",
        prevCursor: null,
        hasMore: true,
      },
    });
  });

  it("throws when every requested host history fetch fails", async () => {
    await expect(
      fetchAgentHistoryBatch({
        hosts: [
          { serverId: "failed-a", serverLabel: "Failed A", client: createFailingClient() },
          { serverId: "failed-b", serverLabel: "Failed B", client: createFailingClient() },
        ] satisfies AgentHistoryHost[],
        cursorByServerId: null,
      }),
    ).rejects.toThrow("No connected hosts could load agent history");
  });
});

function configureHosts(
  input: AgentHistoryHost[],
  scopeSupportedBy: string[],
  queryControlsSupportedBy: string[] = [],
) {
  runtimeHosts = input;
  registeredHosts = input.map(({ serverId, serverLabel }) => ({ serverId, label: serverLabel }));
  featureState = {
    sessions: Object.fromEntries(
      input.map(({ serverId }) => [
        serverId,
        {
          serverInfo: {
            features: {
              agentHistorySearch: true,
              agentHistoryArchiveScope: scopeSupportedBy.includes(serverId),
              agentHistoryQueryControls: queryControlsSupportedBy.includes(serverId),
            },
          },
        },
      ]),
    ),
  };
}

function getId(agent: { id: string }) {
  return agent.id;
}

function renderHistory(options: Parameters<typeof useAgentHistory>[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return {
    ...renderHook(useAgentHistory, { initialProps: options, wrapper: Wrapper }),
    queryClient,
  };
}

describe("useAgentHistory archive scope", () => {
  afterEach(() => {
    cleanup();
    configureHosts([], []);
  });

  it("omits blank search scopes and orders archived results across hosts and pages", async () => {
    const updatedAt = "2026-04-10T10:00:00.000Z";
    const entry = (id: string, day: string) =>
      historyEntry({ id, cwd: "/repo", updatedAt, archivedAt: `2026-04-${day}T10:00:00.000Z` });
    const primary = createClient([
      historyPayload({ entries: [] }),
      historyPayload({ entries: [entry("same", "03")], hasMore: true, nextCursor: "next" }),
      historyPayload({ entries: [entry("last", "04")] }),
    ]);
    const secondary = createClient([
      historyPayload({ entries: [] }),
      historyPayload({ entries: [entry("first", "01"), entry("same", "03")] }),
    ]);
    const ids = ["server-a", "server-b"];
    configureHosts(
      [
        { serverId: ids[1], serverLabel: "Second", client: secondary },
        { serverId: ids[0], serverLabel: "First", client: primary },
      ],
      ids,
      ids,
    );
    const options = {
      archiveScope: "archived",
      searchScope: "workspace",
      sort: { field: "archived_at", direction: "asc" },
    } as const;
    const { queryClient, rerender, result } = renderHistory({ ...options, search: "  " });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isQueryControlsSupported).toBe(true);
    expect(primary.calls[0]).not.toHaveProperty("searchScope");

    rerender({ ...options, search: "atlas" });
    const addresses = () => result.current.agents.map(({ serverId, id }) => `${serverId}:${id}`);
    await waitFor(() =>
      expect(addresses()).toEqual(["server-b:first", "server-a:same", "server-b:same"]),
    );
    expect(primary.calls[1]).toMatchObject({
      archiveScope: "archived",
      search: "atlas",
      searchScope: "workspace",
      sort: [{ key: "archived_at", direction: "asc" }],
    });
    expect(
      queryClient.getQueryState([
        "allAgentHistory",
        ...ids,
        "atlas",
        { archiveScope: "archived", searchScope: "workspace", sort: "archived_at:asc" },
      ])?.status,
    ).toBe("success");
    act(() => result.current.loadMore());
    await waitFor(() =>
      expect(addresses()).toEqual([
        "server-b:first",
        "server-a:same",
        "server-b:same",
        "server-a:last",
      ]),
    );
    expect(primary.calls[2]?.page).toMatchObject({ cursor: "next" });
    expect(secondary.calls).toHaveLength(2);

    rerender({ ...options, archiveScope: "active", search: "atlas" });
    await waitFor(() => expect(primary.calls).toHaveLength(4));
    expect(primary.calls[3]).toMatchObject({
      archiveScope: "active",
      searchScope: "workspace",
      sort: [{ key: "updated_at", direction: "asc" }],
    });
    expect(result.current.effectiveSort).toEqual({ field: "updated_at", direction: "asc" });
  });

  it("uses legacy search and falls back from archive to activity time on mixed hosts", async () => {
    const primary = createClient([historyPayload({ entries: [] })]);
    const legacy = createClient([historyPayload({ entries: [] })]);
    const ids = ["server-a", "server-b"];
    configureHosts(
      [
        { serverId: ids[0], serverLabel: "Current", client: primary },
        { serverId: ids[1], serverLabel: "Legacy", client: legacy },
      ],
      ids,
      [ids[0]],
    );
    const { result, rerender } = renderHistory({
      search: "atlas",
      searchScope: "agent",
      sort: { field: "archived_at", direction: "asc" },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isQueryControlsSupported).toBe(false);
    for (const client of [primary, legacy]) {
      expect(client.calls[0]).not.toHaveProperty("searchScope");
      expect(client.calls[0]?.sort).toEqual([{ key: "updated_at", direction: "asc" }]);
    }

    rerender({ sort: { field: "created_at", direction: "desc" } });
    await waitFor(() => expect(legacy.calls).toHaveLength(2));
    expect(legacy.calls[1]?.sort).toEqual([{ key: "created_at", direction: "desc" }]);
  });

  it("queries only hosts with project keys and treats no eligible hosts as empty", async () => {
    const primary = createClient([historyPayload({ entries: [] })]);
    const legacy = createFailingClient();
    configureHosts(
      [
        { serverId: "server-a", serverLabel: "First", client: primary },
        { serverId: "server-b", serverLabel: "Second", client: legacy },
      ],
      ["server-a"],
      ["server-a"],
    );
    featureState.sessions["server-b"].serverInfo.features.agentHistorySearch = false;
    const controls = { archiveScope: "archived", search: "atlas", searchScope: "agent" } as const;
    const { result, queryClient, rerender } = renderHistory({
      ...controls,
      projectKeysByServer: new Map([
        ["server-b", [" "]],
        ["server-a", ["z", "a", "z", ""]],
      ]),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current).toMatchObject({
      isSearchSupported: true,
      isArchiveScopeSupported: true,
      isQueryControlsSupported: true,
    });
    expect(primary.calls[0]).toMatchObject({
      filter: { projectKeys: ["a", "z"] },
      search: "atlas",
      archiveScope: "archived",
      searchScope: "agent",
    });
    expect(legacy.calls).toHaveLength(0);

    rerender({ ...controls, projectKeysByServer: new Map([["server-a", ["a", "z"]]]) });
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);

    rerender({ projectKeysByServer: new Map([["server-b", [" "]]]) });
    expect(result.current).toMatchObject({
      agents: [],
      hostErrors: [],
      isError: false,
      isInitialLoad: false,
      hasMore: false,
    });
    expect(primary.calls).toHaveLength(1);
    expect(legacy.calls).toHaveLength(0);
  });

  it("uses separate tab cursors and normalizes and deduplicates parents across pages and hosts", async () => {
    const date = "2026-04-02T10:00:00.000Z";
    const parent = historyEntry({ id: "parent", cwd: "/repo", updatedAt: date, title: "Parent" });
    const child = historyEntry({ id: "child", cwd: "/repo", updatedAt: date, archivedAt: date });
    const otherChild = historyEntry({
      id: "other",
      cwd: "/repo",
      updatedAt: date,
      archivedAt: date,
    });
    const primary = createClient([
      historyPayload({
        entries: [child],
        ancestors: [parent],
        hasMore: true,
        nextCursor: "archived-next",
      }),
      historyPayload({ entries: [otherChild], ancestors: [parent] }),
      historyPayload({ entries: [parent], hasMore: true, nextCursor: "active-next" }),
      historyPayload({ entries: [] }),
    ]);
    const secondary = createClient([
      historyPayload({ entries: [child], ancestors: [parent] }),
      historyPayload({ entries: [] }),
    ]);
    configureHosts(
      [
        { serverId: "server-a", serverLabel: "MacBook", client: primary },
        { serverId: "server-b", serverLabel: "Linux box", client: secondary },
      ],
      ["server-a", "server-b"],
    );

    const { result, rerender } = renderHistory({
      archiveScope: "archived",
      keepPreviousResults: true,
    });
    await waitFor(() => expect(result.current.agents).toHaveLength(2));
    expect(result.current.isArchiveScopeSupported).toBe(true);
    expect(result.current.hasMore).toBe(true);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.agents).toHaveLength(3));
    expect(result.current.ancestors).toMatchObject([
      {
        id: "parent",
        serverId: "server-a",
        serverLabel: "MacBook",
        title: "Parent",
        lastActivityAt: new Date(date),
        archivedAt: null,
      },
      { id: "parent", serverId: "server-b", serverLabel: "Linux box" },
    ]);

    rerender({ archiveScope: "active", keepPreviousResults: true });
    expect(result.current.agents).toEqual([]);
    expect(result.current.isPreviousResults).toBe(false);
    await waitFor(() => expect(result.current.agents.map(getId)).toEqual(["parent"]));
    expect(result.current.ancestors).toEqual([]);
    expect(result.current.hasMore).toBe(true);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.hasMore).toBe(false));
    expect(primary.calls).toMatchObject([
      { archiveScope: "archived", page: { limit: 200 } },
      { archiveScope: "archived", page: { cursor: "archived-next" } },
      { archiveScope: "active", page: { limit: 200 } },
      { archiveScope: "active", page: { cursor: "active-next" } },
    ]);
    expect(primary.calls[2]?.page).not.toHaveProperty("cursor");
    expect(secondary.calls.map(({ archiveScope }) => archiveScope)).toEqual(["archived", "active"]);

    rerender({ archiveScope: "archived" });
    expect(result.current.agents).toHaveLength(3);
    expect(result.current.hasMore).toBe(false);
    expect(primary.calls).toHaveLength(4);
  });

  it("omits the scope for a mixed fleet and for a caller that does not request one", async () => {
    const primary = createClient([historyPayload({ entries: [] })]);
    const legacy = createClient([historyPayload({ entries: [] })]);
    configureHosts(
      [
        { serverId: "server-a", serverLabel: "MacBook", client: primary },
        { serverId: "server-b", serverLabel: "Legacy host", client: legacy },
      ],
      ["server-a"],
    );

    const { result, rerender } = renderHistory({ archiveScope: "archived" });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isArchiveScopeSupported).toBe(false);
    expect(primary.calls[0]).not.toHaveProperty("archiveScope");
    expect(legacy.calls[0]).not.toHaveProperty("archiveScope");

    rerender({ serverId: "server-a" });
    await waitFor(() => expect(primary.calls).toHaveLength(2));
    expect(result.current.isArchiveScopeSupported).toBe(true);
    expect(primary.calls[1]).not.toHaveProperty("archiveScope");
  });

  it("keeps unscoped search on its existing cache keys and shows previous results while a new term loads", async () => {
    const updatedAt = "2026-04-02T10:00:00.000Z";
    const firstMatches = ["first-z", "first-a"];
    const client = createClient([
      historyPayload({
        entries: firstMatches.map((id) => historyEntry({ id, cwd: "/repo", updatedAt })),
      }),
      historyPayload({ entries: [historyEntry({ id: "second", cwd: "/repo", updatedAt })] }),
    ]);
    configureHosts([{ serverId: "server-a", serverLabel: "MacBook", client }], ["server-a"]);

    const options = { searchableHostsOnly: true, keepPreviousResults: true };
    const { result, rerender, queryClient } = renderHistory({ ...options, search: "first" });
    await waitFor(() => expect(result.current.agents.map(getId)).toEqual(firstMatches));

    rerender({ ...options, search: "second" });
    expect(result.current.agents.map(getId)).toEqual(firstMatches);
    expect(result.current.isPreviousResults).toBe(true);
    await waitFor(() => expect(result.current.agents.map(getId)).toEqual(["second"]));
    expect(result.current.isPreviousResults).toBe(false);
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .map(({ queryKey }) => queryKey),
    ).toEqual([
      ["allAgentHistory", "server-a", "first"],
      ["allAgentHistory", "server-a", "second"],
    ]);
    expect(client.calls.map(({ search }) => search)).toEqual(["first", "second"]);
    for (const call of client.calls) expect(call).not.toHaveProperty("archiveScope");
  });

  it("keeps an optimistically archived active parent only as context for its children", async () => {
    const date = "2026-04-02T10:00:00.000Z";
    const entries = ["parent", "child"].map((id) =>
      historyEntry({ id, cwd: "/repo", updatedAt: date }),
    );
    const client = createClient([historyPayload({ entries })]);
    configureHosts([{ serverId: "server-a", serverLabel: "MacBook", client }], ["server-a"]);
    const { result, queryClient } = renderHistory({ serverId: "server-a", archiveScope: "active" });
    await waitFor(() => expect(result.current.agents).toHaveLength(2));

    act(() => {
      markAgentArchivedInHistoryCache(queryClient, {
        serverId: "server-a",
        agentId: "parent",
        archivedAt: date,
      });
    });
    await waitFor(() => expect(result.current.agents.map(getId)).toEqual(["child"]));
    expect(result.current.ancestors).toMatchObject([{ id: "parent", archivedAt: new Date(date) }]);
  });

  it("leaves the moved placement in cache when a workspace-scoped archive is refused", async () => {
    const mutation = Promise.withResolvers<{ archivedAt: string }>();
    const client = createClient([]);
    configureHosts([{ serverId: "server-a", serverLabel: "MacBook", client }], ["server-a"]);
    const archiveAgent = vi.fn(() => mutation.promise);
    featureState.sessions["server-a"].client = { archiveAgent };

    const queryClient = new QueryClient();
    const listKey = ["allAgents", "server-a"];
    const entry = { agent: { id: "parent", workspaceId: "old-workspace" } };
    const moved = { agent: { ...entry.agent, workspaceId: "new-workspace" } };
    queryClient.setQueryData(listKey, { entries: [entry] });

    const archivedBefore = runtime.archiveAgentSnapshot.mock.calls.length;
    const restoredBefore = runtime.restoreAgentSnapshot.mock.calls.length;
    const { result } = renderHook(useArchiveAgent, {
      wrapper: ({ children }: PropsWithChildren) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    });
    let failed!: Promise<unknown>;
    const captureError = (error: unknown) => error;
    act(() => {
      failed = result.current
        .archiveAgent({
          serverId: "server-a",
          agentId: "parent",
          expectedWorkspaceId: "old-workspace",
        })
        .catch(captureError);
    });

    await waitFor(() =>
      expect(archiveAgent).toHaveBeenCalledExactlyOnceWith("parent", "old-workspace"),
    );
    expect(queryClient.getQueryData(listKey)).toEqual({ entries: [entry] });
    queryClient.setQueryData(listKey, { entries: [moved] });

    const staleClose = new Error("Agent parent is no longer in workspace old-workspace");
    await act(async () => {
      mutation.reject(staleClose);
      expect(await failed).toBe(staleClose);
    });
    expect(queryClient.getQueryData(listKey)).toEqual({ entries: [moved] });
    expect(runtime.archiveAgentSnapshot).toHaveBeenCalledTimes(archivedBefore);
    expect(runtime.restoreAgentSnapshot).toHaveBeenCalledTimes(restoredBefore);
  });

  it("rolls back the archived session without losing pages loaded while the mutation was pending", async () => {
    const mutation = Promise.withResolvers<{ archivedAt: string }>();
    const client = createClient([]);
    configureHosts([{ serverId: "server-a", serverLabel: "MacBook", client }], ["server-a"]);
    featureState.sessions["server-a"].client = { archiveAgent: () => mutation.promise };
    featureState.sessions["server-a"].agents = new Map<string, never>();
    const queryClient = new QueryClient();
    const single = [...agentHistoryQueryKey("server-a"), ""];
    const all = [...allAgentHistoryQueryKey(["server-a", "server-b"]), ""];
    const unloaded = [...all, { archiveScope: "archived" }];
    const target: { id: string; serverId: string; archivedAt: Date | null } = {
      id: "parent",
      serverId: "server-a",
      archivedAt: null,
    };
    const alreadyArchived: typeof target = {
      ...target,
      archivedAt: new Date("2026-04-02T10:00:00.000Z"),
    };
    const otherHost = { ...target, serverId: "server-b" };
    const firstPage = { agents: [target, otherHost], ancestors: [alreadyArchived] };
    const laterPage = { agents: [{ ...target, id: "new-page" }], ancestors: [target] };
    const initial = { pages: [firstPage], pageParams: [null] as Array<string | null> };
    const afterPagination = { pages: [firstPage, laterPage], pageParams: [null, "next"] };
    for (const key of [single, all]) queryClient.setQueryData(key, initial);
    queryClient.getQueryCache().build(queryClient, { queryKey: unloaded });
    const { result } = renderHook(useArchiveAgent, {
      wrapper: ({ children }: PropsWithChildren) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    });

    let failed!: Promise<unknown>;
    const captureError = (error: unknown) => error;
    act(() => {
      failed = result.current
        .archiveAgent({ serverId: target.serverId, agentId: target.id })
        .catch(captureError);
    });
    await waitFor(() => {
      for (const key of [single, all]) {
        expect(
          queryClient.getQueryData<typeof initial>(key)?.pages[0].agents[0].archivedAt,
        ).toBeInstanceOf(Date);
      }
    });
    for (const key of [single, all]) {
      queryClient.setQueryData<typeof initial>(
        key,
        (current) =>
          current && {
            pages: [...current.pages, laterPage],
            pageParams: [...current.pageParams, "next"],
          },
      );
    }
    queryClient.setQueryData(unloaded, { pages: [laterPage], pageParams: [null] });

    await act(async () => {
      mutation.reject(new Error("Archive failed"));
      expect(await failed).toEqual(new Error("Archive failed"));
    });
    for (const key of [single, all]) expect(queryClient.getQueryData(key)).toEqual(afterPagination);
    expect(queryClient.getQueryData(unloaded)).toEqual({ pages: [laterPage], pageParams: [null] });
  });
});
