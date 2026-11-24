/** @vitest-environment jsdom */
import type { DaemonClient, FetchAgentHistoryEntry } from "@getpaseo/client/internal/daemon-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { invalidateAgentHistory } from "@/hooks/agent-history-query-key";
import {
  useWorkspaceArchivedAgents,
  WORKSPACE_HISTORY_PAGE_SIZE,
} from "./use-workspace-archived-agents";

const runtime = vi.hoisted(() => ({
  fetchAgentHistory: vi.fn<DaemonClient["fetchAgentHistory"]>(),
  supportsWorkspaceHistory: true,
}));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) =>
    feature === "agentHistoryArchiveScope" || runtime.supportsWorkspaceHistory,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime,
  useHostRuntimeIsConnected: () => true,
}));

const timestamp = "2026-11-20T02:00:00.000Z";
function entry(
  id: string,
  overrides: Partial<FetchAgentHistoryEntry["agent"]> = {},
): FetchAgentHistoryEntry {
  return {
    agent: {
      id,
      workspaceId: "workspace",
      provider: "codex",
      model: null,
      title: null,
      status: "closed",
      cwd: "/repo",
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: timestamp,
      lastUserMessageAt: null,
      labels: {},
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      availableModes: [],
      pendingPermissions: [],
      currentModeId: null,
      persistence: null,
      ...overrides,
    },
    project: {
      projectKey: "/repo",
      projectName: "workspace",
      checkout: {
        cwd: "/repo",
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  };
}

function page(entries: FetchAgentHistoryEntry[], nextCursor: string | null = null) {
  return {
    entries,
    requestId: "history",
    pageInfo: { hasMore: nextCursor !== null, nextCursor, prevCursor: null },
  };
}

interface HookProps {
  serverId?: string;
  workspaceId?: string;
  enabled?: boolean;
  workspaceAgentMembership?: string;
}

function renderHistory(initialProps: HookProps = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const hook = renderHook(
    ({
      serverId = "host",
      workspaceId = "workspace",
      enabled = false,
      workspaceAgentMembership = '[["main",false],["old",false]]',
    }: HookProps) =>
      useWorkspaceArchivedAgents({
        serverId,
        workspaceId,
        enabled,
        workspaceAgentMembership,
      }),
    {
      initialProps,
      wrapper: ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    },
  );
  return { ...hook, queryClient };
}

afterEach(() => {
  cleanup();
  runtime.fetchAgentHistory.mockReset();
  runtime.supportsWorkspaceHistory = true;
});

it("does not fetch on mount until history is explicitly opened, then fetches strictly one page per request", async () => {
  runtime.fetchAgentHistory
    .mockResolvedValueOnce(
      page([entry("first"), entry("foreign", { workspaceId: "foreign" })], "cursor-2"),
    )
    .mockResolvedValueOnce(
      page([
        entry("first"),
        entry("second"),
        entry("hidden", { background: true }),
        entry("internal", { internal: true }),
      ]),
    );
  const { result, rerender } = renderHistory({ enabled: false });

  expect(runtime.fetchAgentHistory).not.toHaveBeenCalled();
  expect(result.current.data).toEqual([]);
  expect(result.current.hasLoadedOnce).toBe(false);

  // User clicks "View history members" -> fetches ONLY page 1.
  rerender({ enabled: true });
  await waitFor(() => expect(result.current.data.map(({ id }) => id)).toEqual(["first"]));
  expect(result.current.hasMore).toBe(true);
  const filter = { includeBackground: false, workspaceIds: ["workspace"] };
  expect(runtime.fetchAgentHistory.mock.calls).toEqual([
    [{ archiveScope: "archived", filter, page: { limit: WORKSPACE_HISTORY_PAGE_SIZE } }],
  ]);

  // User clicks "Load more" -> fetches ONLY page 2 and deduplicates.
  act(() => {
    result.current.loadMore();
  });
  await waitFor(() => expect(result.current.data.map(({ id }) => id)).toEqual(["first", "second"]));
  expect(result.current.hasMore).toBe(false);
  expect(runtime.fetchAgentHistory.mock.calls).toEqual([
    [{ archiveScope: "archived", filter, page: { limit: WORKSPACE_HISTORY_PAGE_SIZE } }],
    [
      {
        archiveScope: "archived",
        filter,
        page: { limit: WORKSPACE_HISTORY_PAGE_SIZE, cursor: "cursor-2" },
      },
    ],
  ]);
});

it("deduplicates concurrent loadMore clicks so only one page request is sent", async () => {
  const secondPage = Promise.withResolvers<ReturnType<typeof page>>();
  runtime.fetchAgentHistory
    .mockResolvedValueOnce(page([entry("first")], "cursor-2"))
    .mockReturnValueOnce(secondPage.promise);

  const { result } = renderHistory({ enabled: true });
  await waitFor(() => expect(result.current.hasMore).toBe(true));

  act(() => {
    result.current.loadMore();
    result.current.loadMore();
    result.current.loadMore();
  });
  expect(runtime.fetchAgentHistory).toHaveBeenCalledTimes(2);

  secondPage.resolve(page([entry("second")]));
  await waitFor(() => expect(result.current.data.map(({ id }) => id)).toEqual(["first", "second"]));
  expect(runtime.fetchAgentHistory).toHaveBeenCalledTimes(2);
});

it("prevents cross-workspace data bleed when switching workspaces while a page request is in flight", async () => {
  const wsARequest = Promise.withResolvers<ReturnType<typeof page>>();
  runtime.fetchAgentHistory
    .mockReturnValueOnce(wsARequest.promise)
    .mockResolvedValueOnce(page([entry("b-1", { workspaceId: "ws-b" })]));

  const { result, rerender } = renderHistory({ workspaceId: "ws-a", enabled: true });
  expect(runtime.fetchAgentHistory).toHaveBeenCalledTimes(1);

  // Switch to ws-b before ws-a settles.
  rerender({ workspaceId: "ws-b", enabled: true, workspaceAgentMembership: '[["main-b",false]]' });
  await waitFor(() => expect(result.current.data.map(({ id }) => id)).toEqual(["b-1"]));

  // Late response from ws-a must not leak into ws-b.
  wsARequest.resolve(page([entry("a-1", { workspaceId: "ws-a" })]));
  await Promise.resolve();
  expect(result.current.data.map(({ id }) => id)).toEqual(["b-1"]);
});

it("removes an unarchived session when the host history prefix is invalidated", async () => {
  runtime.fetchAgentHistory
    .mockResolvedValueOnce(page([entry("restored")]))
    .mockResolvedValueOnce(page([]));
  const { result, queryClient } = renderHistory({ enabled: true });
  await waitFor(() => expect(result.current.data.map(({ id }) => id)).toEqual(["restored"]));

  act(() => invalidateAgentHistory(queryClient, "host"));
  await waitFor(() => expect(result.current.data).toEqual([]));
});

it("refreshes history when membership changes while open, and stays quiet when closed", async () => {
  runtime.fetchAgentHistory
    .mockResolvedValueOnce(page([]))
    .mockResolvedValueOnce(page([entry("old")]));
  const { result, rerender } = renderHistory({ enabled: false });

  // Changing membership while history is closed must not trigger any fetch.
  rerender({ enabled: false, workspaceAgentMembership: '[["main",false],["old",true]]' });
  expect(runtime.fetchAgentHistory).not.toHaveBeenCalled();

  rerender({ enabled: true, workspaceAgentMembership: '[["main",false],["old",true]]' });
  await waitFor(() => expect(result.current.data).toEqual([]));

  rerender({
    enabled: true,
    workspaceAgentMembership: '[["main",false],["new",false],["old",true]]',
  });
  await waitFor(() => expect(result.current.data.map(({ id }) => id)).toEqual(["old"]));
});

it("does not fetch unscoped history on an older host", () => {
  runtime.supportsWorkspaceHistory = false;
  const { result } = renderHistory({ enabled: true });
  expect(result.current.supportsWorkspaceHistory).toBe(false);
  expect(runtime.fetchAgentHistory).not.toHaveBeenCalled();
});
