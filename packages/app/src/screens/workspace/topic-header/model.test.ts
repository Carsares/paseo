import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDurableItem } from "@getpaseo/protocol/messages";
import { describe, expect, it, vi } from "vitest";
import {
  deriveTopicHeaderModel,
  DURABLE_ITEMS_PAGE_SIZE,
  fetchAllPendingDurableItemCount,
} from "./model";

const baseInput = {
  topic: {
    summary: "Profile cold startup and trim boot.ts",
    hideFromModel: false,
    revision: 1,
    mainAgentId: "main-1",
  },
  workspaceDirectory: "/Users/dev/paseo",
  isGitCheckout: true,
  currentBranchName: "feat/cold-start",
  discoveredRepos: [],
  supportsGitGraph: true,
  setupStatus: null,
  showWorkspaceSetup: false,
  isCheckoutStatusLoading: false,
  teamSummary: {
    hasMain: true,
    isMainSilent: true,
    runningCount: 0,
    activeCount: 1,
    needsInputCount: 0,
    firstNeedsInputAgentId: null,
  },
  durableItems: { status: "ready", pendingCount: 0 },
} as const;

function makeDurableItem(index: number): WorkspaceDurableItem {
  return {
    workspaceId: "ws-1",
    requestId: `req-${index}`,
    sourceAgentId: "main-1",
    sourceTurnId: `turn-${index}`,
    kind: "decision",
    title: `Decision ${index}`,
    summary: `Summary ${index}`,
    evidence: [],
    status: "pending",
    revision: 1,
    createdAt: "2026-11-24T00:00:00.000Z",
  };
}

describe("deriveTopicHeaderModel", () => {
  it("reports quiet ready state and branch jump on a single-repo silent topic", () => {
    const model = deriveTopicHeaderModel(baseInput);
    expect(model).toEqual({
      directionSummary: "Profile cold startup and trim boot.ts",
      hideFromModel: false,
      git: { kind: "branch", branchName: "feat/cold-start", canOpenGraph: true },
      env: { kind: "ready", canOpenSetup: false },
      team: { kind: "quiet", runningCount: 0, activeCount: 1 },
      action: { pendingCount: 0, durableLoadState: "ready", firstAttentionAgentId: null },
    });
  });

  it("prioritizes amber rebase conflict status across multi-repo workspaces", () => {
    const model = deriveTopicHeaderModel({
      ...baseInput,
      discoveredRepos: [
        {
          repoId: "r1",
          displayName: "weplay-risk-agent",
          repoRoot: "/ws/weplay-risk-agent",
          headSha: "aaa",
          currentBranch: "main",
          operationState: "idle",
        },
        {
          repoId: "r2",
          displayName: "wespy-http-go",
          repoRoot: "/ws/wespy-http-go",
          headSha: "bbb",
          currentBranch: "feat/fix",
          operationState: "rebase_paused",
        },
      ],
      setupStatus: "running",
      showWorkspaceSetup: true,
      teamSummary: {
        hasMain: true,
        isMainSilent: false,
        runningCount: 2,
        activeCount: 4,
        needsInputCount: 1,
        firstNeedsInputAgentId: "child-1",
      },
      durableItems: { status: "ready", pendingCount: 51 },
    });

    expect(model.git).toEqual({
      kind: "rebase_conflict",
      conflictCount: 1,
      conflictRepoRoot: "/ws/wespy-http-go",
      branchLabel: "feat/fix",
      canOpenGraph: true,
    });
    expect(model.env).toEqual({ kind: "running", canOpenSetup: true });
    expect(model.team).toEqual({ kind: "running", runningCount: 2, activeCount: 4 });
    expect(model.action).toEqual({
      pendingCount: 52,
      durableLoadState: "ready",
      firstAttentionAgentId: "child-1",
    });
  });

  it("distinguishes durable-item load failure from zero pending items", () => {
    const failed = deriveTopicHeaderModel({
      ...baseInput,
      durableItems: { status: "error", pendingCount: 0 },
    });
    const zero = deriveTopicHeaderModel({
      ...baseInput,
      durableItems: { status: "ready", pendingCount: 0 },
    });

    expect(failed.action).toEqual({
      pendingCount: 0,
      durableLoadState: "error",
      firstAttentionAgentId: null,
    });
    expect(zero.action).toEqual({
      pendingCount: 0,
      durableLoadState: "ready",
      firstAttentionAgentId: null,
    });
  });

  it("aggregates multi-repo count when no conflict exists and handles unbound / hidden privacy", () => {
    const model = deriveTopicHeaderModel({
      ...baseInput,
      topic: { summary: "  ", hideFromModel: true, revision: 2, mainAgentId: null },
      discoveredRepos: [
        {
          repoId: "r1",
          displayName: "a",
          repoRoot: "/ws/a",
          headSha: "aaa",
          currentBranch: "main",
          operationState: "idle",
        },
        {
          repoId: "r2",
          displayName: "b",
          repoRoot: "/ws/b",
          headSha: "bbb",
          currentBranch: "dev",
          operationState: "idle",
        },
      ],
      setupStatus: "failed",
      showWorkspaceSetup: true,
      teamSummary: {
        hasMain: false,
        isMainSilent: false,
        runningCount: 0,
        activeCount: 0,
        needsInputCount: 0,
        firstNeedsInputAgentId: null,
      },
    });

    expect(model.directionSummary).toBeNull();
    expect(model.hideFromModel).toBe(true);
    expect(model.git).toMatchObject({ kind: "multi_repo", repoCount: 2, canOpenGraph: true });
    expect(model.env).toEqual({ kind: "failed", canOpenSetup: true });
    expect(model.team).toEqual({ kind: "unbound", runningCount: 0, activeCount: 0 });
  });

  it("falls back to directory basename on non-git workspaces", () => {
    const model = deriveTopicHeaderModel({
      ...baseInput,
      isGitCheckout: false,
      currentBranchName: null,
      discoveredRepos: [],
      workspaceDirectory: "/Users/dev/notes-folder/",
    });

    expect(model.git).toEqual({
      kind: "directory",
      directoryName: "notes-folder",
      canOpenGraph: false,
    });
  });
});

describe("fetchAllPendingDurableItemCount", () => {
  it("honors a native-style aborted signal before the first request and after a page resolves", async () => {
    const signal = { aborted: true };
    const list = vi.fn<DaemonClient["listWorkspaceDurableItems"]>(async () => {
      signal.aborted = true;
      return {
        requestId: "r1",
        error: null,
        items: [makeDurableItem(1)],
        nextCursor: "next",
      };
    });
    const client = { listWorkspaceDurableItems: list };
    await expect(fetchAllPendingDurableItemCount(client, "ws-1", signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(list).not.toHaveBeenCalled();

    signal.aborted = false;
    await expect(fetchAllPendingDurableItemCount(client, "ws-1", signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(list).toHaveBeenCalledOnce();
  });

  it("paginates across multiple pages to count all 51 pending items without truncating at 50", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => makeDurableItem(index + 1));
    const secondPage = [makeDurableItem(51)];
    const listWorkspaceDurableItems = vi
      .fn<DaemonClient["listWorkspaceDurableItems"]>()
      .mockResolvedValueOnce({
        requestId: "r1",
        error: null,
        items: firstPage,
        nextCursor: "cursor-page-2",
      })
      .mockResolvedValueOnce({
        requestId: "r2",
        error: null,
        items: secondPage,
        nextCursor: null,
      });

    const count = await fetchAllPendingDurableItemCount({ listWorkspaceDurableItems }, "ws-1");

    expect(count).toBe(51);
    expect(listWorkspaceDurableItems.mock.calls).toEqual([
      [{ workspaceId: "ws-1", statusFilter: "pending", limit: DURABLE_ITEMS_PAGE_SIZE }],
      [
        {
          workspaceId: "ws-1",
          statusFilter: "pending",
          limit: DURABLE_ITEMS_PAGE_SIZE,
          cursor: "cursor-page-2",
        },
      ],
    ]);
  });

  it("throws instead of returning zero when a durable-item page fails or returns an error payload", async () => {
    const payloadErrorClient = {
      listWorkspaceDurableItems: vi
        .fn<DaemonClient["listWorkspaceDurableItems"]>()
        .mockResolvedValueOnce({
          requestId: "r-err",
          error: "permission denied",
          items: [],
          nextCursor: null,
        }),
    };
    await expect(fetchAllPendingDurableItemCount(payloadErrorClient, "ws-1")).rejects.toThrow(
      "permission denied",
    );

    const networkErrorClient = {
      listWorkspaceDurableItems: vi
        .fn<DaemonClient["listWorkspaceDurableItems"]>()
        .mockResolvedValueOnce({
          requestId: "r1",
          error: null,
          items: [makeDurableItem(1)],
          nextCursor: "cursor-2",
        })
        .mockRejectedValueOnce(new Error("socket disconnected")),
    };
    await expect(fetchAllPendingDurableItemCount(networkErrorClient, "ws-1")).rejects.toThrow(
      "socket disconnected",
    );
  });
});
