/** @vitest-environment jsdom */
import type { DaemonClient, FetchAgentHistoryEntry } from "@getpaseo/client/internal/daemon-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { invalidateAgentHistory } from "@/hooks/agent-history-query-key";
import { useWorkspaceArchivedAgents } from "./use-workspace-archived-agents";

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

function renderHistory() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const hook = renderHook(
    (workspaceAgentMembership) =>
      useWorkspaceArchivedAgents({
        mainAgentId: "main",
        serverId: "host",
        workspaceId: "workspace",
        workspaceAgentMembership,
      }),
    {
      initialProps: '[["main",false],["old",false]]',
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

it("fetches only this workspace's archives and deduplicates results across pages", async () => {
  runtime.fetchAgentHistory
    .mockResolvedValueOnce(
      page([entry("first"), entry("foreign", { workspaceId: "foreign" })], "next"),
    )
    .mockResolvedValueOnce(
      page([
        entry("first"),
        entry("second"),
        entry("hidden", { background: true }),
        entry("internal", { internal: true }),
      ]),
    );
  const { result } = renderHistory();

  await waitFor(() =>
    expect(result.current.data?.map(({ id }) => id)).toEqual(["first", "second"]),
  );
  const filter = { includeBackground: false, workspaceIds: ["workspace"] };
  expect(runtime.fetchAgentHistory.mock.calls).toEqual([
    [{ archiveScope: "archived", filter, page: { limit: 200 } }],
    [{ archiveScope: "archived", filter, page: { limit: 200, cursor: "next" } }],
  ]);
});

it("removes an unarchived session when the host history prefix is invalidated", async () => {
  runtime.fetchAgentHistory
    .mockResolvedValueOnce(page([entry("restored")]))
    .mockResolvedValueOnce(page([]));
  const { result, queryClient } = renderHistory();
  await waitFor(() => expect(result.current.data?.map(({ id }) => id)).toEqual(["restored"]));

  act(() => invalidateAgentHistory(queryClient, "host"));
  await waitFor(() => expect(result.current.data).toEqual([]));
});

it("refreshes history when one agent is archived and another opens in the same update", async () => {
  runtime.fetchAgentHistory
    .mockResolvedValueOnce(page([]))
    .mockResolvedValueOnce(page([entry("old")]));
  const { result, rerender } = renderHistory();
  await waitFor(() => expect(result.current.data).toEqual([]));

  rerender('[["main",false],["new",false],["old",true]]');
  await waitFor(() => expect(result.current.data?.map(({ id }) => id)).toEqual(["old"]));
});

it("does not fetch unscoped history on an older host", () => {
  runtime.supportsWorkspaceHistory = false;
  const { result } = renderHistory();
  expect(result.current.supportsWorkspaceHistory).toBe(false);
  expect(runtime.fetchAgentHistory).not.toHaveBeenCalled();
});
