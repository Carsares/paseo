import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CheckoutGitWorkingTree, ParsedDiffFile } from "@getpaseo/protocol/messages";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import { ToastApiProvider } from "@/contexts/toast-context";
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import { i18n } from "@/i18n/i18next";
import { StagingPanel } from "@/panels/changes/staging-panel";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

vi.mock("lucide-react-native", async (importOriginal) => {
  const icons = await importOriginal<typeof import("lucide-react-native")>();
  const icon = icons.FileText;
  return {
    ...icons,
    AlignJustify: icon,
    CopyPlus: icon,
    Diff: icon,
    FilePlus: icon,
    FileWarning: icon,
    FolderMinus: icon,
    ListChevronsDownUp: icon,
    ListChevronsUpDown: icon,
    Minus: icon,
    Pilcrow: icon,
    Send: icon,
    SquareDot: icon,
    SquareMinus: icon,
    SquarePlus: icon,
    WrapText: icon,
  };
});

void i18n;

const repoRoot = "/worktree";
const path = "example.txt";
const tree: CheckoutGitWorkingTree = {
  repoRoot,
  headSha: "abc",
  currentBranch: "topic",
  operationState: "idle",
  staged: [{ path, status: "modified" }],
  unstaged: [{ path, status: "modified" }],
  untracked: [],
  conflicts: [],
  activeAgents: [],
};

const file: ParsedDiffFile = {
  path,
  isDeleted: false,
  isNew: false,
  additions: 1,
  deletions: 1,
  hunks: [
    {
      oldStart: 1,
      oldCount: 3,
      newStart: 1,
      newCount: 3,
      lines: [
        { type: "header", content: "@@ -1,3 +1,3 @@" },
        { type: "context", content: "before" },
        { type: "remove", content: "old" },
        { type: "add", content: "new" },
        { type: "context", content: "after" },
      ],
    },
  ],
};

const insets = { top: 0, bottom: 0, left: 0, right: 0 };
const toast = { show: () => () => {}, error: () => {}, copied: () => {} };
const openComparison = () => {};

async function mount(methods: Partial<DaemonClient>) {
  vi.stubGlobal("React", React);
  const client = methods as DaemonClient;
  const host = vi.spyOn(getHostRuntimeStore(), "getSnapshot").mockReturnValue({
    serverId: "test",
    client,
    connectionStatus: "online",
    activeConnectionId: null,
    activeConnection: null,
    lastError: null,
    lastOnlineAt: null,
    agentDirectoryStatus: "ready",
    agentDirectoryError: null,
    hasEverLoadedAgentDirectory: true,
    probeByConnectionId: new Map(),
    clientGeneration: 0,
    connectionEpoch: 0,
  });

  const container = document.createElement("div");
  Object.assign(container.style, { width: "400px", height: "700px", display: "flex" });
  document.body.appendChild(container);
  const root = createRoot(container);
  const query = new QueryClient();
  onTestFinished(async () => {
    await act(async () => root.unmount());
    container.remove();
    query.clear();
    host.mockRestore();
    vi.unstubAllGlobals();
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={query}>
        <ToastApiProvider api={toast}>
          <SafeAreaInsetsContext.Provider value={insets}>
            <DiffDocumentWorkspaceCacheProvider>
              <StagingPanel
                serverId="test"
                workspaceId="worktree"
                cwd={repoRoot}
                active
                onOpenComparison={openComparison}
              />
            </DiffDocumentWorkspaceCacheProvider>
          </SafeAreaInsetsContext.Provider>
        </ToastApiProvider>
      </QueryClientProvider>,
    ),
  );
  return query;
}

function workingTreeResponse(workingTree = tree) {
  return { requestId: crypto.randomUUID(), cwd: repoRoot, error: null, workingTree };
}

describe("Git staging Explorer", () => {
  it("shows mixed file selection and refreshes a stale hunk without retrying the write", async () => {
    const checkoutGitWorkingTreeGet = vi.fn(async () => workingTreeResponse());
    const checkoutGitStageApply = vi.fn<DaemonClient["checkoutGitStageApply"]>(async () => ({
      requestId: "stage",
      cwd: repoRoot,
      repoRoot,
      success: false,
      error: "HEAD changed",
      errorCode: "STALE_HEAD_CONFLICT",
      actualHeadSha: "def",
    }));
    const checkoutGitDiscardApply = vi.fn<DaemonClient["checkoutGitDiscardApply"]>();
    const diff = {
      subscriptionId: "diff",
      revision: 1,
      phase: "ready" as const,
      resolved: { baseSha: "index", headSha: "", mergeBaseSha: "" },
      diffTooLarge: false,
      files: [file],
    };
    const observeDiff = vi.fn<DaemonClient["observeDiff"]>(() => ({
      subscriptionId: "diff",
      ready: Promise.resolve(diff),
      release: async () => {},
      subscribe: ({ snapshot }) => {
        snapshot(diff);
        return () => {};
      },
    }));
    await mount({
      checkoutGitWorkingTreeGet,
      checkoutGitStageApply,
      checkoutGitDiscardApply,
      observeDiff,
    });
    await expect
      .element(page.getByRole("checkbox", { name: "Stage example.txt", exact: true }))
      .toHaveAttribute("aria-checked", "mixed");
    await expect
      .element(page.getByRole("button", { name: "Commit staged", exact: true }))
      .toBeDisabled();
    await page.getByRole("button", { name: path, exact: true }).last().click();
    await expect
      .element(page.getByRole("button", { name: "Stage hunk", exact: true }))
      .toBeVisible();
    expect(observeDiff).toHaveBeenCalledWith({
      cwd: repoRoot,
      base: { kind: "index" },
      head: { kind: "worktree" },
    });
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await page.getByRole("button", { name: "Discard hunk", exact: true }).click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(checkoutGitDiscardApply).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Stage hunk", exact: true }).click();
    await expect.element(page.getByText(/HEAD changed/)).toBeVisible();
    expect(checkoutGitStageApply).toHaveBeenCalledExactlyOnceWith({
      cwd: repoRoot,
      targetRepoRoot: repoRoot,
      expectedHeadSha: "abc",
      scope: "hunk",
      paths: [path],
      patch: expect.stringContaining("-old\n+new\n"),
    });
    expect(checkoutGitWorkingTreeGet).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "handles refresh during commit confirmation (visible staged list changed: %s)",
    async (changed) => {
      const initial = workingTreeResponse();
      const staged = [{ path: "added-while-confirming.txt", status: "added" as const }];
      const refreshed = workingTreeResponse(changed ? { ...tree, staged } : tree);
      const checkoutGitWorkingTreeGet = vi
        .fn<DaemonClient["checkoutGitWorkingTreeGet"]>(async () => workingTreeResponse(tree))
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(refreshed);
      const checkoutGitCommitCreate = vi.fn<DaemonClient["checkoutGitCommitCreate"]>(
        async ({ requestId }) => ({
          requestId: requestId!,
          cwd: repoRoot,
          repoRoot,
          success: false,
          error: "The staged contents changed",
          errorCode: "STALE_HEAD_CONFLICT",
        }),
      );
      const confirmation = Promise.withResolvers<boolean>();
      const ask = vi.fn(() => confirmation.promise);
      vi.stubGlobal("paseoDesktop", { dialog: { ask } });
      const query = await mount({ checkoutGitWorkingTreeGet, checkoutGitCommitCreate });
      const message = page.getByRole("textbox", { name: "Commit message", exact: true });
      await message.fill("Keep this draft");
      await page.getByRole("button", { name: "Commit and push…", exact: true }).click();
      await expect.poll(() => ask.mock.calls.length).toBe(1);
      expect(ask).toHaveBeenCalledWith("Commit the staged changes and push the commit?", {
        title: "Confirm Git action",
        okLabel: "Confirm",
        cancelLabel: "Cancel",
        kind: "info",
      });
      expect(checkoutGitCommitCreate).not.toHaveBeenCalled();

      await query.refetchQueries({ type: "active" });
      expect(checkoutGitWorkingTreeGet).toHaveBeenCalledTimes(2);
      if (changed) {
        await expect
          .element(page.getByRole("button", { name: staged[0]!.path, exact: true }))
          .toBeVisible();
      }
      confirmation.resolve(true);

      await expect
        .element(page.getByText(/Review the refreshed changes before trying again/))
        .toBeVisible();
      await expect.element(message).toHaveValue("Keep this draft");
      if (changed) {
        expect(checkoutGitCommitCreate).not.toHaveBeenCalled();
        expect(checkoutGitWorkingTreeGet).toHaveBeenCalledTimes(2);
        return;
      }
      await expect.element(page.getByText(/The staged contents changed/)).toBeVisible();
      expect(checkoutGitCommitCreate).toHaveBeenCalledExactlyOnceWith({
        cwd: repoRoot,
        targetRepoRoot: repoRoot,
        expectedHeadSha: tree.headSha,
        requestId: expect.stringMatching(
          new RegExp("^paseo-git-commit:" + initial.requestId + ":[a-f0-9-]{36}$"),
        ),
        message: "Keep this draft",
        amend: false,
        pushAfter: true,
      });
      expect(checkoutGitWorkingTreeGet).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["unchanged", "staged contents changed", "HEAD moved externally", "draft edited"])(
    "applies a generated draft only when it is still current (%s)",
    async (scenario) => {
      const response =
        Promise.withResolvers<
          Awaited<ReturnType<DaemonClient["checkoutGitCommitGenerateMessage"]>>
        >();
      const checkoutGitCommitGenerateMessage = vi.fn(() => response.promise);
      let headSha = tree.headSha;
      const checkoutGitWorkingTreeGet = vi.fn(async () =>
        workingTreeResponse({ ...tree, headSha }),
      );
      const release = vi.fn(async () => {});
      let index = "staged-tree-before";
      const observeDiff = vi.fn<DaemonClient["observeDiff"]>(() => {
        const diff = {
          subscriptionId: crypto.randomUUID(),
          revision: 1,
          phase: "ready" as const,
          resolved: { baseSha: tree.headSha!, headSha: index, mergeBaseSha: "" },
          diffTooLarge: false,
          files: [file],
        };
        return {
          subscriptionId: diff.subscriptionId,
          ready: Promise.resolve(diff),
          release,
          subscribe: ({ snapshot }) => {
            snapshot(diff);
            return () => {};
          },
        };
      });
      await mount({ checkoutGitWorkingTreeGet, checkoutGitCommitGenerateMessage, observeDiff });
      const message = page.getByRole("textbox", { name: "Commit message", exact: true });
      const generate = page.getByRole("button", { name: "Generate from staged changes" });
      await message.fill("Initial draft");
      await generate.click();
      await expect.poll(() => checkoutGitCommitGenerateMessage.mock.calls.length).toBe(1);
      expect(checkoutGitCommitGenerateMessage).toHaveBeenCalledWith({
        cwd: repoRoot,
        targetRepoRoot: repoRoot,
        source: "staged",
      });
      expect(observeDiff).toHaveBeenCalledWith({
        cwd: repoRoot,
        base: { kind: "rev", rev: tree.headSha },
        head: { kind: "index" },
        highlight: false,
      });

      if (scenario === "staged contents changed") index = "staged-tree-after";
      if (scenario === "HEAD moved externally") headSha = "def";
      if (scenario === "draft edited") {
        await message.fill("Edited while generating");
        await message.fill("Initial draft");
      }
      expect(checkoutGitWorkingTreeGet).toHaveBeenCalledTimes(1);
      response.resolve({
        requestId: crypto.randomUUID(),
        cwd: repoRoot,
        repoRoot,
        error: null,
        message: "Generated draft",
      });
      await expect.element(generate).toBeEnabled();
      await expect
        .element(message)
        .toHaveValue(scenario === "unchanged" ? "Generated draft" : "Initial draft");
      expect(release).toHaveBeenCalledTimes(scenario === "draft edited" ? 1 : 2);
      if (scenario === "staged contents changed" || scenario === "HEAD moved externally") {
        await expect
          .element(page.getByText(/Review the refreshed changes before trying again/))
          .toBeVisible();
      }
      if (scenario === "HEAD moved externally") {
        expect(checkoutGitWorkingTreeGet).toHaveBeenCalledTimes(3);
        expect(observeDiff).toHaveBeenCalledTimes(2);
      }
    },
  );

  it("shows that a commit was kept locally when the host skips the push", async () => {
    const reason = "The local commit differs from the reviewed staged changes";
    const checkoutGitWorkingTreeGet = vi.fn(async () => workingTreeResponse());
    const checkoutGitCommitCreate = vi.fn<DaemonClient["checkoutGitCommitCreate"]>(
      async ({ requestId }) => ({
        requestId: requestId!,
        cwd: repoRoot,
        repoRoot,
        success: true,
        newHeadSha: "def",
        error: null,
        pushError: reason,
      }),
    );
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    await mount({ checkoutGitWorkingTreeGet, checkoutGitCommitCreate });
    const message = page.getByRole("textbox", { name: "Commit message", exact: true });
    await message.fill("Commit draft");
    await page.getByRole("button", { name: "Commit and push…", exact: true }).click();
    await expect
      .element(page.getByText("Commit created. Push failed: " + reason, { exact: true }))
      .toBeVisible();
    await expect.element(message).toHaveValue("");
    expect(checkoutGitCommitCreate).toHaveBeenCalledOnce();
  });

  it("applies by SHA and keeps the stash visible after refreshing", async () => {
    const entry = {
      stashRef: "stash@{0}",
      sha: "selected-stash-sha",
      message: "Saved changes",
      branch: "topic",
      createdAt: "2026-11-24T00:00:00.000Z",
    };
    const checkoutGitWorkingTreeGet = vi.fn(async () =>
      workingTreeResponse({
        ...tree,
        activeAgents: [
          {
            agentId: "working-agent",
            workspaceId: "worktree",
            title: "Working agent",
            status: "running",
            backgroundRunningCount: 0,
          },
        ],
      }),
    );
    const checkoutGitStashList = vi.fn(async () => ({
      requestId: crypto.randomUUID(),
      cwd: repoRoot,
      repoRoot,
      error: null,
      entries: [entry],
    }));
    checkoutGitStashList.mockResolvedValueOnce({
      requestId: crypto.randomUUID(),
      cwd: repoRoot,
      repoRoot,
      error: null,
      entries: [{ ...entry, stashRef: "stash@{1}" }],
    });
    const checkoutGitStashApply = vi.fn<DaemonClient["checkoutGitStashApply"]>(async () => ({
      requestId: crypto.randomUUID(),
      cwd: repoRoot,
      repoRoot,
      success: true,
      error: null,
    }));
    const confirmation = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirmation);
    await mount({ checkoutGitWorkingTreeGet, checkoutGitStashList, checkoutGitStashApply });
    await page.getByRole("button", { name: "Stash", exact: true }).click();
    await expect
      .element(
        page.getByText(
          "Applying keeps the stash to avoid deleting the wrong entry if the list changes.",
        ),
      )
      .toBeVisible();
    await expect.element(page.getByText(/stash@\{1\}/)).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Pop", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Drop", exact: true }))
      .not.toBeInTheDocument();
    const apply = page.getByRole("button", { name: "Apply", exact: true });
    await apply.click();
    expect(confirmation).toHaveBeenCalledWith(expect.stringContaining("Working agent"));
    expect(checkoutGitStashApply).not.toHaveBeenCalled();

    await apply.click();
    await expect.element(page.getByText("Git operation completed", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Saved changes", { exact: true })).toBeVisible();
    await expect.element(page.getByText(/stash@\{0\}/)).toBeVisible();
    expect(checkoutGitStashApply).toHaveBeenCalledExactlyOnceWith({
      cwd: repoRoot,
      targetRepoRoot: repoRoot,
      expectedHeadSha: tree.headSha,
      stashRef: entry.sha,
      pop: false,
      forceWithRunningAgents: true,
    });
    expect(checkoutGitWorkingTreeGet).toHaveBeenCalledTimes(2);
    expect(checkoutGitStashList).toHaveBeenCalledTimes(2);
  });
});
