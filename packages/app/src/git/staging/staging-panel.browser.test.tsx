import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CheckoutGitWorkingTree, ParsedDiffFile } from "@getpaseo/protocol/messages";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ToastApiProvider } from "@/contexts/toast-context";
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import {
  CHANGES_PREFERENCES_QUERY_KEY,
  DEFAULT_CHANGES_PREFERENCES,
  type ChangesPreferences,
} from "@/hooks/use-changes-preferences/storage";
import { i18n } from "@/i18n/i18next";
import { StagingPanel } from "@/panels/changes/staging-panel";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

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

async function mount(
  methods: Partial<DaemonClient>,
  p2 = false,
  options: { graph?: boolean; layout?: ChangesPreferences["layout"] } = {},
) {
  vi.stubGlobal("React", React);
  const client = methods as DaemonClient;
  const initialSessions = useSessionStore.getState().sessions;
  if (p2) {
    useSessionStore.getState().initializeSession("test", client);
    useSessionStore.getState().updateSessionServerInfo("test", {
      serverId: "test",
      hostname: null,
      version: null,
      features: { checkoutGitP2V1: true, checkoutGitGraphV1: options.graph },
    });
  }

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
  if (options.layout) {
    query.setQueryData(CHANGES_PREFERENCES_QUERY_KEY, {
      ...DEFAULT_CHANGES_PREFERENCES,
      layout: options.layout,
    });
  }
  onTestFinished(async () => {
    await act(async () => root.unmount());
    container.remove();
    query.clear();
    host.mockRestore();
    vi.unstubAllGlobals();
    useSessionStore.setState({ sessions: initialSessions });
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

function readyDiff(files: ParsedDiffFile[]): DaemonClient["observeDiff"] {
  const frame = {
    subscriptionId: "diff",
    revision: 1,
    phase: "ready" as const,
    resolved: { baseSha: "index", headSha: "", mergeBaseSha: "" },
    diffTooLarge: false,
    files,
  };
  return () => ({
    subscriptionId: frame.subscriptionId,
    ready: Promise.resolve(frame),
    release: async () => {},
    subscribe: ({ snapshot }) => {
      snapshot(frame);
      return () => {};
    },
  });
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

  it("extends across a split replacement pair while preserving unmatched lines", async () => {
    await page.viewport(1440, 900);
    const replacement: ParsedDiffFile = {
      ...file,
      additions: 3,
      deletions: 2,
      hunks: [
        {
          oldStart: 1,
          oldCount: 2,
          newStart: 1,
          newCount: 3,
          lines: [
            { type: "header", content: "@@ -1,2 +1,3 @@" },
            { type: "remove", content: "A" },
            { type: "remove", content: "B" },
            { type: "add", content: "a" },
            { type: "add", content: "b" },
            { type: "add", content: "c" },
            { type: "header", content: "\\ No newline at end of file" },
          ],
        },
      ],
    };
    const checkoutGitStageApply = vi.fn<DaemonClient["checkoutGitStageApply"]>(async () => ({
      requestId: "line",
      cwd: repoRoot,
      repoRoot,
      success: true,
      error: null,
    }));
    await mount(
      {
        checkoutGitWorkingTreeGet: async () => workingTreeResponse(),
        observeDiff: readyDiff([replacement]),
        checkoutGitStageApply,
      },
      true,
      { layout: "split" },
    );
    await page.getByRole("button", { name: path, exact: true }).last().click();
    const old = page.getByTestId("git-diff-pick-0-1");
    const added = page.getByTestId("git-diff-pick-0-3");
    await old.click();
    await added.click({ modifiers: ["Shift"] });
    await expect.element(added).toHaveAttribute("aria-pressed", "true");
    await expect
      .element(page.getByTestId("git-diff-pick-0-2"))
      .toHaveAttribute("aria-pressed", "false");
    await expect.element(page.getByTestId("git-diff-pick-0-6")).not.toBeInTheDocument();
    await expect
      .element(page.getByText("Use the file controls for this change", { exact: true }))
      .toBeVisible();

    await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
    await expect.element(added).toHaveAttribute("aria-pressed", "false");
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await expect.element(added).toHaveAttribute("aria-pressed", "true");
    await expect
      .element(page.getByTestId("git-diff-pick-0-2"))
      .toHaveAttribute("aria-pressed", "false");
    await page.getByTestId("git-diff-apply-lines").click();
    await expect.poll(() => checkoutGitStageApply.mock.calls.length).toBe(1);
    // Replacing only line 1 makes the staged file "a\nB\n".
    expect(checkoutGitStageApply).toHaveBeenCalledWith({
      cwd: repoRoot,
      targetRepoRoot: repoRoot,
      expectedHeadSha: "abc",
      scope: "lines",
      paths: [path],
      patch: [
        'diff --git "a/example.txt" "b/example.txt"',
        '--- "a/example.txt"',
        '+++ "b/example.txt"',
        "@@ -1,1 +1,1 @@",
        "-A",
        "+a",
        "",
      ].join("\n"),
    });
  });

  it("only shows blame attribution for matching text at the mapped worktree line", async () => {
    const worktreeFile: ParsedDiffFile = {
      ...file,
      additions: 1,
      deletions: 0,
      hunks: [
        {
          oldStart: 0,
          oldCount: 0,
          newStart: 1,
          newCount: 1,
          lines: [{ type: "add", content: "prefix" }],
        },
      ],
    };
    const checkoutGitBlameGet = vi.fn<DaemonClient["checkoutGitBlameGet"]>(async () => ({
      requestId: "blame",
      cwd: repoRoot,
      repoRoot,
      path,
      error: null,
      lines: [
        {
          lineNumber: 2,
          sha: "cafefeed",
          authorName: "Correct Author",
          authorDate: null,
          summary: "Matches",
          lineText: "before",
        },
        {
          lineNumber: 3,
          sha: "badcafe0",
          authorName: "Wrong Author",
          authorDate: null,
          summary: "Text changed",
          lineText: "different new",
        },
        {
          lineNumber: 4,
          sha: "badcafe1",
          authorName: "Unverified Author",
          authorDate: null,
          summary: "Missing text",
        },
      ],
    }));
    await mount(
      {
        checkoutGitWorkingTreeGet: async () => workingTreeResponse(),
        observeDiff: (compare) =>
          readyDiff(compare.head.kind === "index" ? [file] : [worktreeFile])(compare),
        checkoutGitBlameGet,
      },
      true,
    );
    await page.getByRole("button", { name: path, exact: true }).first().click();
    await page.getByTestId("git-diff-toggle-blame").click();
    await expect
      .element(page.getByText("cafefeed · Correct Author", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText(/Wrong Author|Unverified Author/)).not.toBeInTheDocument();
    expect(checkoutGitBlameGet).toHaveBeenCalledExactlyOnceWith({
      cwd: repoRoot,
      targetRepoRoot: repoRoot,
      path,
      startLine: 2,
      endLine: 4,
    });
  });

  it("reviews the prepared force-push target without Graph and requires a new snapshot after staleness", async () => {
    const oldTarget = {
      branch: "topic",
      remote: "mirror",
      remoteRef: "refs/heads/review/topic",
      remoteSha: "1".repeat(40),
      token: "first-snapshot-token",
    };
    const newTarget = {
      ...oldTarget,
      remote: "origin",
      remoteSha: "2".repeat(40),
      token: "second-snapshot-token",
    };
    const prepared = { requestId: "prepare", cwd: repoRoot, repoRoot, error: null };
    const checkoutGitPushPrepare = vi
      .fn<DaemonClient["checkoutGitPushPrepare"]>()
      .mockResolvedValueOnce({ ...prepared, target: oldTarget })
      .mockResolvedValueOnce({ ...prepared, target: newTarget });
    const checkoutGitPushForce = vi.fn<DaemonClient["checkoutGitPushForce"]>(async () => ({
      requestId: "push",
      cwd: repoRoot,
      repoRoot,
      success: false,
      error: "remote moved",
      errorCode: "STALE_REMOTE_BASELINE",
    }));
    const checkoutGitRefsList = vi.fn<DaemonClient["checkoutGitRefsList"]>();
    await mount(
      {
        checkoutGitWorkingTreeGet: async () => workingTreeResponse(),
        checkoutGitPushPrepare,
        checkoutGitRefsList,
        checkoutGitPushForce,
      },
      true,
    );
    await expect.element(page.getByText("Local tags", { exact: true })).not.toBeInTheDocument();
    await page.getByTestId("git-force-push").click();
    const submit = page.getByTestId("git-force-confirm-submit");
    const input = page.getByTestId("git-force-confirm-input");
    await expect
      .element(page.getByTestId("git-force-target"))
      .toHaveTextContent("mirror · refs/heads/review/topic");
    await expect.element(page.getByTestId("git-force-sha")).toHaveTextContent(oldTarget.remoteSha);
    await input.fill("force-push Topic");
    await expect.element(submit).toBeDisabled();
    expect(checkoutGitPushForce).not.toHaveBeenCalled();
    await input.fill("force-push topic");
    await submit.click();
    await expect
      .element(page.getByRole("alert").filter({ hasText: /The remote branch changed/ }))
      .toBeVisible();
    await expect.element(submit).toBeDisabled();
    const request = { cwd: repoRoot, targetRepoRoot: repoRoot, expectedHeadSha: "abc" };
    expect(checkoutGitPushForce).toHaveBeenCalledExactlyOnceWith({
      ...request,
      confirmation: "force-push topic",
      expectedPushToken: oldTarget.token,
    });
    await page
      .getByTestId("git-force-confirm-dialog")
      .getByRole("button", { name: "Cancel" })
      .click();
    await page.getByTestId("git-force-push").click();
    await expect
      .element(page.getByTestId("git-force-target"))
      .toHaveTextContent("origin · refs/heads/review/topic");
    await expect.element(page.getByTestId("git-force-sha")).toHaveTextContent(newTarget.remoteSha);
    await expect.element(submit).toBeDisabled();
    expect(checkoutGitPushPrepare.mock.calls).toEqual([[request], [request]]);
    expect(checkoutGitRefsList).not.toHaveBeenCalled();
  });

  it("requires the exact force-delete phrase for the branch and SHA shown", async () => {
    const checkoutGitBranchMutate = vi.fn<DaemonClient["checkoutGitBranchMutate"]>(async () => ({
      requestId: "delete",
      cwd: repoRoot,
      repoRoot,
      success: true,
      error: null,
    }));
    const refSha = "3".repeat(40);
    const checkoutGitRefsList: DaemonClient["checkoutGitRefsList"] = async () => ({
      requestId: "refs",
      cwd: repoRoot,
      error: null,
      refs: [
        {
          repoRoot,
          localBranches: [
            { name: "topic", sha: "abc" },
            { name: "release/old", sha: refSha },
          ],
          remotes: [],
          tags: [],
          backups: [],
        },
      ],
    });
    await mount(
      {
        checkoutGitWorkingTreeGet: async () => workingTreeResponse(),
        checkoutGitRefsList,
        checkoutGitBranchMutate,
      },
      true,
      { graph: true },
    );
    await page.getByText("Local tags", { exact: true }).click();
    await page.getByTestId("git-force-delete-branch").click();
    await page.getByRole("button", { name: "release/old", exact: true }).click();
    await page.getByTestId("git-force-delete").click();
    await expect
      .element(page.getByTestId("git-force-target"))
      .toHaveTextContent("refs/heads/release/old");
    await expect.element(page.getByTestId("git-force-sha")).toHaveTextContent(refSha);
    const input = page.getByTestId("git-force-confirm-input");
    const submit = page.getByTestId("git-force-confirm-submit");
    await input.fill("force-delete release/old ");
    await expect.element(submit).toBeDisabled();
    expect(checkoutGitBranchMutate).not.toHaveBeenCalled();
    await input.fill("force-delete release/old");
    await submit.click();
    await expect.poll(() => checkoutGitBranchMutate.mock.calls.length).toBe(1);
    expect(checkoutGitBranchMutate).toHaveBeenCalledWith({
      cwd: repoRoot,
      targetRepoRoot: repoRoot,
      action: "delete",
      name: "refs/heads/release/old",
      expectedHeadSha: "abc",
      expectedRefSha: refSha,
      force: true,
    });
  });

  it("rejects a moved tag and only pushes the reviewed tag object to the chosen remote", async () => {
    const checkoutGitTagMutate = vi.fn<DaemonClient["checkoutGitTagMutate"]>(async () => ({
      requestId: "tag",
      cwd: repoRoot,
      repoRoot,
      success: true,
      error: null,
    }));
    const firstObjectSha = "4".repeat(40);
    const movedObjectSha = "5".repeat(40);
    function refsFor(objectSha: string) {
      return {
        repoRoot,
        localBranches: [{ name: "topic", sha: "abc" }],
        remotes: [
          { name: "origin", branches: [] },
          { name: "mirror", branches: [] },
        ],
        tags: [{ name: "v1", sha: "6".repeat(40), objectSha }],
        backups: [],
      };
    }
    const checkoutGitRefsList: DaemonClient["checkoutGitRefsList"] = async () => ({
      requestId: "refs",
      cwd: repoRoot,
      error: null,
      refs: [refsFor(firstObjectSha)],
    });
    const query = await mount(
      {
        checkoutGitWorkingTreeGet: async () => workingTreeResponse(),
        checkoutGitRefsList,
        checkoutGitTagMutate,
      },
      true,
      { graph: true },
    );
    await page.getByText("Local tags", { exact: true }).click();
    const push = page.getByRole("button", { name: "Push tag", exact: true });
    await push.click({ timeout: 3000 });
    await expect.element(page.getByText(firstObjectSha, { exact: true })).toBeVisible();
    await act(async () => {
      query.setQueryData(["git-p2-refs", "test", repoRoot, repoRoot], refsFor(movedObjectSha));
    });
    await page
      .getByTestId("git-push-tag-dialog")
      .getByRole("button", { name: "mirror", exact: true })
      .click({ timeout: 3000 });
    await page.getByTestId("git-push-tag-submit").click({ timeout: 3000 });
    await expect
      .element(
        page
          .getByRole("alert")
          .filter({ hasText: /The repository changed/ })
          .last(),
      )
      .toBeVisible();
    expect(checkoutGitTagMutate).not.toHaveBeenCalled();

    await page
      .getByTestId("git-push-tag-dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click({ timeout: 3000 });
    await push.click({ timeout: 3000 });
    await expect.element(page.getByText(movedObjectSha, { exact: true })).toBeVisible();
    await page
      .getByTestId("git-push-tag-dialog")
      .getByRole("button", { name: "mirror", exact: true })
      .click({ timeout: 3000 });
    await page.getByTestId("git-push-tag-submit").click({ timeout: 3000 });
    await expect.poll(() => checkoutGitTagMutate.mock.calls.length).toBe(1);
    expect(checkoutGitTagMutate).toHaveBeenCalledWith({
      cwd: repoRoot,
      targetRepoRoot: repoRoot,
      action: "push",
      tagName: "v1",
      remote: "mirror",
      expectedHeadSha: "abc",
      expectedTagSha: movedObjectSha,
    });
  });

  it("opens a four-column conflict from Changes and saves against the inspected fingerprint", async () => {
    await page.viewport(1440, 900);
    const workingTree: CheckoutGitWorkingTree = {
      ...tree,
      operationState: "merge",
      conflicts: [{ path, status: "UU" }],
    };
    const checkoutGitWorkingTreeGet = vi.fn(async () => workingTreeResponse(workingTree));
    const checkoutGitConflictInspect = vi.fn<DaemonClient["checkoutGitConflictInspect"]>(
      async () => ({
        requestId: "inspect",
        cwd: repoRoot,
        repoRoot,
        error: null,
        conflicts: [
          {
            path,
            status: "UU",
            conflictFingerprint: "original-fingerprint",
            base: null,
            ours: null,
            theirs: null,
            hunks: [],
            contents: {
              base: "Base text\n",
              ours: "Ours text\n",
              theirs: "Theirs text\n",
              result: "Draft text\n",
            },
          },
        ],
      }),
    );
    const checkoutGitConflictResolve = vi.fn<DaemonClient["checkoutGitConflictResolve"]>(
      async () => ({
        requestId: "save",
        cwd: repoRoot,
        repoRoot,
        success: true,
        error: null,
      }),
    );
    await mount(
      { checkoutGitWorkingTreeGet, checkoutGitConflictInspect, checkoutGitConflictResolve },
      true,
    );
    await page.getByTestId(`git-open-merge:${path}`).click();
    await expect.element(page.getByTestId("git-merge-scroll")).toBeVisible();
    await expect
      .element(page.getByTestId("git-merge-base-row").first())
      .toHaveTextContent("Base text");
    await expect
      .element(page.getByTestId("git-merge-theirs-row").first())
      .toHaveTextContent("Theirs text");
    await page.getByRole("button", { name: "Edit result", exact: true }).click();
    await page.getByRole("textbox", { name: "Result", exact: true }).fill("Merged text\n");
    await page.getByTestId("git-merge-save").click();
    await expect.element(page.getByTestId("git-merge-editor")).not.toBeInTheDocument();
    expect(checkoutGitConflictInspect).toHaveBeenCalledExactlyOnceWith({
      cwd: repoRoot,
      targetRepoRoot: repoRoot,
      path,
      includeContents: true,
    });
    expect(checkoutGitConflictResolve).toHaveBeenCalledExactlyOnceWith({
      cwd: repoRoot,
      targetRepoRoot: repoRoot,
      path,
      strategy: "mark_resolved",
      expectedConflictFingerprint: "original-fingerprint",
      resultText: "Merged text\n",
    });
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
        snapshotRequestId: initial.requestId,
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
