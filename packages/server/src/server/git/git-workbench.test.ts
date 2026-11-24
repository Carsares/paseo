import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getGitCommandMetrics,
  startGitCommandMetrics,
  stopGitCommandMetrics,
} from "../../utils/run-git-command.js";
import {
  handleGitWorkbenchRequest,
  type GitWorkbenchHost,
  type GitWorkbenchRequest,
} from "./checkout-git-workbench.js";
import { GitCommitBaselines } from "./git-commit-baselines.js";
import { listActiveAgentsForRepo } from "./active-agent-guard.js";
import { collectExpiredBackupRefs } from "./repo-backup-refs.js";
import { repoWriteMutex, RepoWriteMutex, resolveGitTarget } from "./repo-write-mutex.js";

let root: string;
let host: GitWorkbenchHost;
let commitBaselines: GitCommitBaselines;
let head: string;
function git(...args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function writeWorkingFile(path: string, data: string) {
  await writeFile(join(root, path), data);
}

async function installGitHook(name: string, script: string[]) {
  const hooks = join(root, "test-hooks");
  await mkdir(hooks, { recursive: true });
  git("config", "core.hooksPath", hooks);
  await writeFile(join(hooks, name), ["#!/bin/sh", "set -eu", ...script, ""].join("\n"), {
    mode: 0o755,
  });
}

function createBareOrigin() {
  const remote = join(root, "origin.git");
  git("init", "-q", "--bare", "-b", "main", remote);
  git("remote", "add", "origin", remote);
  return remote;
}

const baseLines = Array.from({ length: 40 }, (_unused, i) => `line ${i + 1}`);
const original = baseLines.join("\n") + "\n";
const partial = original.replace("line 3\n", "first edit\n");
const both = partial.replace("line 30\n", "second edit\n");

async function request<T extends GitWorkbenchRequest["type"]>(
  options: Omit<
    Extract<GitWorkbenchRequest, { type: T }>,
    "requestId" | "cwd" | "targetRepoRoot"
  > & { type: T },
  requestId = randomUUID(),
) {
  return (
    await handleGitWorkbenchRequest(
      {
        cwd: root,
        targetRepoRoot: root,
        requestId,
        ...options,
      } as GitWorkbenchRequest,
      host,
      commitBaselines,
    )
  ).payload;
}

async function reviewedCommitId() {
  const status = await request({ type: "checkout.git.working_tree.get.request" });
  expect(status.error).toBeNull();
  return `paseo-git-commit:${status.requestId}:${randomUUID()}`;
}

function firstHunk(patch: string) {
  const lines = patch.split("\n");
  const second = lines.findIndex(
    (line, index) =>
      line.startsWith("@@ -") && lines.slice(0, index).some((prior) => prior.startsWith("@@ -")),
  );
  return second === -1 ? patch : lines.slice(0, second).join("\n") + "\n";
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "paseo-git-workbench-")));
  commitBaselines = new GitCommitBaselines();
  host = {
    listActiveAgents: async () => [],
    withDirectoryWrite: async (_cwd, write) => write(),
    refresh: async () => {},
    generateCommitMessage: async () => "Test",
    reportBackgroundError: () => {},
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "paseo-test@example.invalid");
  git("config", "user.name", "Paseo Test");
  git("config", "core.hooksPath", join(root, "missing-hooks"));
  await writeWorkingFile("example.txt", original);
  git("add", "example.txt");
  git("commit", "-qm", "Initial");
  head = git("rev-parse", "HEAD").trim();
});

afterEach(async () => {
  const repo = await resolveGitTarget(root);
  await repoWriteMutex.run(repo, "test-cleanup", async () => {});
  await rm(root, { recursive: true, force: true });
});

describe("Git P0 operations", () => {
  it("stages, unstages and discards one of two hunks in the same file", async () => {
    await writeWorkingFile("example.txt", both);
    const workingPatch = firstHunk(git("diff", "--", "example.txt"));
    expect(
      await request({
        type: "checkout.git.stage.apply.request",
        scope: "hunk",
        patch: workingPatch,
      }),
    ).toMatchObject({ success: true, error: null });
    expect(git("show", ":example.txt")).toBe(partial);
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(both);

    const stagedPatch = git("diff", "--cached", "--", "example.txt");
    expect(
      await request({
        type: "checkout.git.unstage.apply.request",
        scope: "hunk",
        patch: stagedPatch,
      }),
    ).toMatchObject({ success: true, error: null });
    expect(git("show", ":example.txt")).toBe(original);
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(both);

    const discarded = await request({
      type: "checkout.git.discard.apply.request",
      expectedHeadSha: head,
      scope: "hunk",
      patch: workingPatch,
    });
    expect(discarded).toMatchObject({
      success: true,
      backupRef: expect.stringMatching(/^refs\/paseo\/backup\/discard-/),
    });
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(
      original.replace("line 30\n", "second edit\n"),
    );
    expect(git("show", `${"backupRef" in discarded ? discarded.backupRef : ""}:example.txt`)).toBe(
      both,
    );
  });

  it("rejects a stale patch without changing the index or worktree", async () => {
    await writeWorkingFile("example.txt", partial);
    const patch = git("diff", "--", "example.txt");
    await writeWorkingFile("example.txt", original.replace("line 3\n", "another edit\n"));
    const baseline = await readFile(join(root, "example.txt"), "utf8");
    expect(
      await request({
        type: "checkout.git.discard.apply.request",
        expectedHeadSha: head,
        scope: "hunk",
        patch,
      }),
    ).toMatchObject({ success: false, errorCode: "PATCH_APPLY_REJECTED" });
    expect(git("show", ":example.txt")).toBe(original);
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(baseline);
    expect(git("for-each-ref", "refs/paseo/backup")).toBe("");
  });

  it("preserves staged content and backs up unstaged and untracked files before path discard", async () => {
    await writeWorkingFile("example.txt", partial);
    git("add", "example.txt");
    await writeWorkingFile("example.txt", both);
    await writeWorkingFile("new.txt", "untracked\r\n");
    await writeWorkingFile(".gitattributes", "new.txt text eol=lf\n");
    const result = await request({
      type: "checkout.git.discard.apply.request",
      scope: "paths",
      expectedHeadSha: head,
      paths: ["example.txt", "new.txt"],
    });
    expect(result).toMatchObject({ success: true, backupRef: expect.any(String) });
    const backup = "backupRef" in result ? result.backupRef : "";
    expect(git("show", `${backup}:new.txt`)).toBe("untracked\r\n");
    expect(git("show", `${backup}:example.txt`)).toBe(both);
    expect(git("show", `${backup}^:example.txt`)).toBe(partial);
    expect(git("show", ":example.txt")).toBe(partial);
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(partial);
    await expect(readFile(join(root, "new.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("commits only staged content, keeps the commit when push fails and backs up amend", async () => {
    await writeWorkingFile("example.txt", partial);
    git("add", "example.txt");
    await writeWorkingFile("example.txt", both);
    await writeWorkingFile("local.txt", "untracked");
    const commit = await request(
      {
        type: "checkout.git.commit.create.request",
        message: "One hunk",
        expectedHeadSha: head,
        pushAfter: true,
      },
      await reviewedCommitId(),
    );
    expect(commit).toMatchObject({
      success: true,
      newHeadSha: expect.any(String),
      pushError: expect.any(String),
    });
    expect(git("show", "HEAD:example.txt")).toBe(partial);
    expect(git("status", "--porcelain")).toBe(" M example.txt\n?? local.txt\n");
    expect(
      await request(
        {
          type: "checkout.git.commit.create.request",
          message: "Empty stage",
          expectedHeadSha: "newHeadSha" in commit ? commit.newHeadSha! : null,
        },
        await reviewedCommitId(),
      ),
    ).toMatchObject({ success: false, error: "Stage changes before committing" });
    expect(
      await request({
        type: "checkout.git.commit.create.request",
        message: "Amended",
        amend: true,
        expectedHeadSha: head,
      }),
    ).toMatchObject({ success: false, errorCode: "STALE_HEAD_CONFLICT" });

    const beforeAmend = git("rev-parse", "HEAD").trim();
    const amend = await request(
      {
        type: "checkout.git.commit.create.request",
        message: "Amended",
        amend: true,
        expectedHeadSha: beforeAmend,
      },
      await reviewedCommitId(),
    );
    expect(amend).toMatchObject({
      success: true,
      backupRef: expect.stringMatching(/^refs\/paseo\/backup\/amend-/),
    });
    expect(git("rev-parse", String("backupRef" in amend && amend.backupRef)).trim()).toBe(
      beforeAmend,
    );
    expect(git("show", "HEAD:example.txt")).toBe(partial);
  });

  it("rejects changed staged content at the same HEAD and preserves those changes", async () => {
    await writeWorkingFile("example.txt", partial);
    git("add", "--", "example.txt");
    const index = join(root, ".git", "index");
    const objects = join(root, ".git", "objects");
    const beforeIndex = await readFile(index);
    const beforeObjects = (await readdir(objects, { recursive: true })).sort();
    const reviewed = await reviewedCommitId();
    expect(await readFile(index)).toEqual(beforeIndex);
    expect((await readdir(objects, { recursive: true })).sort()).toEqual(beforeObjects);
    await writeWorkingFile("example.txt", both);
    git("add", "--", "example.txt");
    const commit = {
      type: "checkout.git.commit.create.request" as const,
      message: "Reviewed change",
      expectedHeadSha: head,
    };
    expect(await request(commit, reviewed)).toMatchObject({
      success: false,
      errorCode: "STALE_HEAD_CONFLICT",
      actualHeadSha: head,
    });
    expect(await request(commit)).toMatchObject({
      success: false,
      errorCode: "STALE_HEAD_CONFLICT",
    });
    expect(git("rev-parse", "HEAD").trim()).toBe(head);
    expect(git("show", ":example.txt")).toBe(both);
  });

  it.each(["another branch", "detached HEAD"])(
    "rejects a reviewed commit after switching to %s at the same HEAD",
    async (target) => {
      git("branch", "other");
      await writeWorkingFile("example.txt", partial);
      git("add", "--", "example.txt");
      const status = await request({ type: "checkout.git.working_tree.get.request" });
      expect(status).toMatchObject({ error: null, workingTree: { currentBranch: "main" } });
      const reviewed = `paseo-git-commit:${status.requestId}:${randomUUID()}`;
      if (target === "another branch") git("switch", "other");
      else git("switch", "--detach", head);

      expect(await request({ type: "checkout.git.working_tree.get.request" })).toMatchObject({
        error: null,
        workingTree: { headSha: head, currentBranch: target === "another branch" ? "other" : null },
      });
      expect(
        await request({ type: "checkout.git.working_tree.get.request" }, status.requestId),
      ).toMatchObject({ errorCode: "STALE_HEAD_CONFLICT" });
      expect(
        await request(
          {
            type: "checkout.git.commit.create.request",
            message: "Reviewed on main",
            expectedHeadSha: head,
            pushAfter: true,
          },
          reviewed,
        ),
      ).toMatchObject({ success: false, errorCode: "STALE_HEAD_CONFLICT", actualHeadSha: head });
      expect(
        git("rev-parse", "HEAD", "refs/heads/main", "refs/heads/other").trim().split("\n"),
      ).toEqual([head, head, head]);
      expect(git("show", ":example.txt")).toBe(partial);
    },
  );

  it.skipIf(process.platform === "win32")(
    "runs commit hooks with the reviewed copy while the live Git index is locked",
    async () => {
      await writeWorkingFile("example.txt", partial);
      git("add", "--", "example.txt");
      await writeWorkingFile("example.txt", both);
      await writeWorkingFile("external.txt", "unreviewed");
      const requestId = await reviewedCommitId();
      const hooks = join(root, "test-hooks");
      await mkdir(hooks);
      git("config", "core.hooksPath", hooks);
      await writeFile(
        join(hooks, "pre-commit"),
        [
          "#!/bin/sh",
          'test -n "$GIT_INDEX_FILE" || exit 1',
          "if (unset GIT_INDEX_FILE; git add -- external.txt) 2>external-git-error; then exit 2; fi",
          "grep -q index.lock external-git-error || exit 3",
          "git diff --cached --name-only >hook-staged-files",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const result = await request(
        {
          type: "checkout.git.commit.create.request",
          message: "Reviewed change",
          expectedHeadSha: head,
        },
        requestId,
      );
      expect(result).toMatchObject({ success: true, error: null });
      expect(await readFile(join(root, "hook-staged-files"), "utf8")).toBe("example.txt\n");
      expect(git("show", "HEAD:example.txt")).toBe(partial);
      expect(git("show", ":example.txt")).toBe(partial);
      expect(git("ls-files", "external.txt")).toBe("");
      expect(await readFile(join(root, "example.txt"), "utf8")).toBe(both);
    },
  );

  it.skipIf(process.platform === "win32")(
    "retains the local commit but does not push when a hook stages extra files",
    async () => {
      const remote = createBareOrigin();
      git("push", "-u", "origin", "main");
      await writeWorkingFile("example.txt", partial);
      await writeWorkingFile("included.txt", "reviewed");
      await writeWorkingFile("extra.txt", "added by hook");
      git("add", "--", "example.txt", "included.txt");
      const requestId = await reviewedCommitId();
      await installGitHook("pre-commit", ["git add -- extra.txt"]);

      const result = await request(
        {
          type: "checkout.git.commit.create.request",
          message: "Reviewed changes, amended by hook",
          expectedHeadSha: head,
          pushAfter: true,
        },
        requestId,
      );

      expect(result).toMatchObject({
        success: true,
        error: null,
        newHeadSha: git("rev-parse", "HEAD").trim(),
        pushError: expect.stringContaining("differs from the reviewed staged changes"),
      });
      expect(git("show", "HEAD:example.txt")).toBe(partial);
      expect(git("show", "HEAD:included.txt")).toBe("reviewed");
      expect(git("show", "HEAD:extra.txt")).toBe("added by hook");
      expect(git("--git-dir", remote, "rev-parse", "refs/heads/main").trim()).toBe(head);
    },
  );

  it.skipIf(process.platform === "win32")(
    "returns the commit it created and does not push if HEAD moves to a commit with the same tree",
    async () => {
      const remote = createBareOrigin();
      git("push", "-u", "origin", "main");
      await writeWorkingFile("example.txt", partial);
      git("add", "--", "example.txt");
      const requestId = await reviewedCommitId();
      await installGitHook("post-commit", [
        "created=$(git rev-parse HEAD)",
        'external=$(git commit-tree "HEAD^{tree}" -p "$created" -m "External same tree")',
        'git update-ref HEAD "$external" "$created"',
      ]);

      const result = await request(
        {
          type: "checkout.git.commit.create.request",
          message: "Reviewed changes",
          expectedHeadSha: head,
          pushAfter: true,
        },
        requestId,
      );

      expect(result).toMatchObject({
        success: true,
        newHeadSha: git("rev-parse", "HEAD^").trim(),
        pushError: expect.stringContaining("current branch or HEAD changed"),
      });
      expect(git("show", "-s", "--format=%s", "HEAD").trim()).toBe("External same tree");
      expect(git("--git-dir", remote, "rev-parse", "refs/heads/main").trim()).toBe(head);
    },
  );

  it.each(["first push", "mapped origin", "upstream", "configured remote"])(
    "pushes the reviewed SHA to the target for %s and keeps branch tracking",
    async (mode) => {
      const origin = createBareOrigin();
      let remote = origin;
      let remoteName = "origin";
      let dest = "main";
      if (mode === "mapped origin") {
        dest = "mapped";
        git("config", "remote.origin.push", "refs/heads/main:refs/heads/mapped");
      } else if (mode === "upstream") {
        dest = "upstream";
        git("config", "branch.main.remote", "origin");
        git("config", "branch.main.merge", "refs/heads/upstream");
      } else if (mode === "configured remote") {
        remoteName = "configured";
        remote = join(root, "configured.git");
        dest = "target";
        git("init", "-q", "--bare", remote);
        git("remote", "add", remoteName, remote);
        git("config", "branch.main.pushRemote", remoteName);
        git("config", "remote.configured.push", "HEAD:refs/heads/target");
      }
      await writeWorkingFile("example.txt", partial);
      git("add", "--", "example.txt");

      const result = await request(
        {
          type: "checkout.git.commit.create.request",
          message: "Reviewed push",
          expectedHeadSha: head,
          pushAfter: true,
        },
        await reviewedCommitId(),
      );

      const sha = git("rev-parse", "HEAD").trim();
      expect(result).toMatchObject({
        success: true,
        error: null,
        newHeadSha: sha,
        pushError: null,
      });
      expect(git("--git-dir", remote, "rev-parse", `refs/heads/${dest}`).trim()).toBe(sha);
      expect(git("rev-parse", "--abbrev-ref", "@{upstream}").trim()).toBe(`${remoteName}/${dest}`);
      expect(git("rev-parse", "@{upstream}").trim()).toBe(sha);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not attribute a concurrent stash entry to this request",
    async () => {
      await writeWorkingFile("example.txt", partial);
      const external = git("stash", "create", "External").trim();
      await installGitHook("reference-transaction", [
        '[ "$1" = committed ] || exit 0',
        "while read -r old new ref; do",
        '  if [ "$ref" = refs/stash ]; then',
        `    git -c core.hooksPath=missing-hooks stash store -m Concurrent ${external}`,
        "  fi",
        "done",
      ]);
      await writeWorkingFile("example.txt", both);

      const saved = await request({
        type: "checkout.git.stash.create.request",
        message: "Requested",
        expectedHeadSha: head,
      });

      expect(saved).toMatchObject({ success: true, error: null, entry: null });
      expect(await request({ type: "checkout.git.stash.list.request" })).toMatchObject({
        entries: [{ sha: external, message: "Concurrent" }, { message: "Requested" }],
      });
      expect(git("show", "stash@{1}:example.txt")).toBe(both);
      expect(await readFile(join(root, "example.txt"), "utf8")).toBe(original);
    },
  );

  it("keeps the stash on conflict and refuses unsafe removal", async () => {
    await writeWorkingFile("example.txt", partial);
    git("add", "example.txt");
    await writeWorkingFile("example.txt", both);
    await writeWorkingFile("untracked.txt", "kept");
    const saved = await request({
      type: "checkout.git.stash.create.request",
      message: "Saved",
      includeUntracked: true,
      expectedHeadSha: head,
    });
    expect(saved).toMatchObject({ success: true, error: null, entry: null });
    const listed = await request({ type: "checkout.git.stash.list.request" });
    expect(listed).toMatchObject({
      entries: [{ message: "Saved", branch: "main", sha: expect.any(String) }],
    });
    const stashRef = "entries" in listed ? listed.entries[0]!.sha : "";
    expect(await request({ type: "checkout.git.stash.show.request", stashRef })).toMatchObject({
      entry: { sha: stashRef },
      files: [
        { path: "example.txt", status: "modified" },
        { path: "untracked.txt", status: "added" },
      ],
    });
    await writeWorkingFile("example.txt", original.replace("line 3\n", "conflict\n"));
    git("add", "example.txt");
    expect(
      await request({
        type: "checkout.git.stash.apply.request",
        stashRef,
        pop: true,
        expectedHeadSha: head,
      }),
    ).toMatchObject({ success: false });
    expect(git("rev-parse", "refs/stash").trim()).toBe(stashRef);
    expect(git("show", `${stashRef}^2:example.txt`)).toBe(partial);
    expect(git("show", `${stashRef}^3:untracked.txt`)).toBe("kept");
    const dropped = await request({
      type: "checkout.git.stash.drop.request",
      stashRef,
      expectedHeadSha: head,
    });
    expect(dropped).toMatchObject({
      success: false,
      error: expect.stringContaining("Stash retained"),
    });
    expect(git("stash", "list", "--format=%H").trim()).toBe(stashRef);
  });

  it("uses the selected stash SHA when its position has moved", async () => {
    await writeWorkingFile("example.txt", partial);
    git("stash", "push", "-m", "Selected");
    const selectedSha = git("rev-parse", "refs/stash").trim();
    await writeWorkingFile("example.txt", both);
    git("stash", "push", "-m", "Newer");
    const newerSha = git("rev-parse", "refs/stash").trim();

    expect(
      await request({ type: "checkout.git.stash.show.request", stashRef: selectedSha }),
    ).toMatchObject({ error: null, entry: { sha: selectedSha, stashRef: "stash@{1}" } });
    expect(
      await request({ type: "checkout.git.stash.apply.request", stashRef: selectedSha, pop: true }),
    ).toMatchObject({ success: true, error: expect.stringContaining("applied and retained") });
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(partial);
    expect(
      await request({ type: "checkout.git.stash.drop.request", stashRef: selectedSha }),
    ).toMatchObject({ success: false, error: expect.stringContaining("Stash retained") });
    expect(git("stash", "list", "--format=%H").trim().split("\n")).toEqual([newerSha, selectedSha]);
    git("stash", "drop", "stash@{1}");

    for (const stashRef of [selectedSha, "stash@{0}"]) {
      expect(await request({ type: "checkout.git.stash.show.request", stashRef })).toMatchObject({
        error: expect.any(String),
        entry: null,
      });
      expect(
        await request({ type: "checkout.git.stash.apply.request", stashRef, pop: true }),
      ).toMatchObject({ success: false });
      expect(await request({ type: "checkout.git.stash.drop.request", stashRef })).toMatchObject({
        success: false,
      });
    }
    expect(git("stash", "list", "--format=%H").trim()).toBe(newerSha);
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(partial);
  });

  it("preserves the worktree and stash list when one SHA identifies two entries", async () => {
    await writeWorkingFile("example.txt", partial);
    git("stash", "push", "-m", "First");
    const sha = git("rev-parse", "refs/stash").trim();
    await writeWorkingFile("example.txt", both);
    git("stash", "push", "-m", "Intervening");
    const otherSha = git("rev-parse", "refs/stash").trim();
    git("stash", "store", "-m", "Duplicate", sha);
    const before = git("stash", "list", "--format=%H %gs");
    expect(before.trim().split("\n")).toEqual([
      `${sha} Duplicate`,
      `${otherSha} On main: Intervening`,
      `${sha} On main: First`,
    ]);
    const ambiguous = expect.stringContaining("more than one entry");

    expect(await request({ type: "checkout.git.stash.show.request", stashRef: sha })).toMatchObject(
      { error: ambiguous, entry: null },
    );
    expect(
      await request({ type: "checkout.git.stash.apply.request", stashRef: sha, pop: true }),
    ).toMatchObject({ success: false, error: ambiguous });
    expect(await request({ type: "checkout.git.stash.drop.request", stashRef: sha })).toMatchObject(
      { success: false, error: ambiguous },
    );
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(original);
    expect(git("stash", "list", "--format=%H %gs")).toBe(before);
    expect(git("for-each-ref", "refs/paseo/backup")).toBe("");
  });

  it("reads already-loaded agents across the worktree and ignores quiet and archived sessions", async () => {
    const nested = join(root, "nested-work");
    await mkdir(nested);
    git("-C", nested, "init", "-q");
    const config = { title: "Agent" };
    const seen: string[] = [];
    const agents = await listActiveAgentsForRepo({
      root,
      manager: {
        listAgents: () => [
          { id: "resident", cwd: root, lifecycle: "closed", config },
          { id: "coordinator", cwd: root, lifecycle: "idle", config },
          { id: "grandchild", cwd: root, lifecycle: "running", workspaceId: "work", config },
          { id: "background", cwd: root, lifecycle: "idle", config },
          { id: "archived", cwd: root, lifecycle: "running", config },
          { id: "other-repo", cwd: nested, lifecycle: "initializing", config },
        ],
        getAgentBackgroundWorkSummary: (id) => {
          seen.push(id);
          return id === "background" ? { runningCount: 2 } : null;
        },
      },
      storage: {
        get: async (id) => (id === "archived" ? { archivedAt: "2026-01-01" } : null),
      },
    });
    expect(agents).toEqual([
      {
        agentId: "grandchild",
        status: "running",
        workspaceId: "work",
        title: "Agent",
        backgroundRunningCount: 0,
      },
      {
        agentId: "background",
        status: "idle",
        workspaceId: null,
        title: "Agent",
        backgroundRunningCount: 2,
      },
    ]);
    expect(seen).not.toContain("resident");
  });

  it("blocks destructive operations with active agents and requires refreshed HEAD even after confirmation", async () => {
    await writeWorkingFile("example.txt", partial);
    const actor = {
      agentId: "child",
      workspaceId: "work",
      title: "Child",
      status: "idle" as const,
      backgroundRunningCount: 1,
    };
    host.listActiveAgents = async () => [actor];
    const options = {
      type: "checkout.git.discard.apply.request" as const,
      scope: "paths" as const,
      paths: ["example.txt"],
    };
    expect(await request({ ...options, expectedHeadSha: head })).toMatchObject({
      success: false,
      errorCode: "ACTIVE_AGENT_GUARD",
      activeAgents: [actor],
    });
    expect(
      await request({ ...options, expectedHeadSha: null, forceWithRunningAgents: true }),
    ).toMatchObject({
      success: false,
      errorCode: "STALE_HEAD_CONFLICT",
      actualHeadSha: head,
    });
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(partial);
    expect(
      await request({ ...options, expectedHeadSha: head, forceWithRunningAgents: true }),
    ).toMatchObject({ success: true });
  });

  it("waits for a shared lock before submitting Git processes and removes timed-out waiters", async () => {
    const repo = await resolveGitTarget(root);
    const sibling = await realpath(await mkdtemp(join(dirname(root), "paseo-git-linked-")));
    try {
      git("worktree", "add", "-qb", "linked", sibling);
      const linked = await resolveGitTarget(sibling);
      expect(linked.commonDir).toBe(repo.commonDir);
      const lock = new RepoWriteMutex(25);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const owner = lock.run(repo, "first-write", async () => {
        entered();
        await gate;
      });
      await started;
      try {
        await expect(
          lock.run(linked, "timed-out", async () => {
            throw new Error("ran after timeout");
          }),
        ).rejects.toMatchObject({ lockOperation: "first-write" });
      } finally {
        release();
        await owner;
      }
      await expect(lock.run(linked, "next-write", async () => "ran")).resolves.toBe("ran");

      let releaseShared!: () => void;
      const hold = new Promise<void>((resolve) => {
        releaseShared = resolve;
      });
      let enteredShared!: () => void;
      const held = new Promise<void>((resolve) => {
        enteredShared = resolve;
      });
      const shared = repoWriteMutex.run(repo, "legacy-writer", async () => {
        enteredShared();
        await hold;
      });
      await held;
      await writeWorkingFile("second.txt", "untracked");
      startGitCommandMetrics();
      let waiting!: () => void;
      const reachedWriter = new Promise<void>((resolve) => {
        waiting = resolve;
      });
      host.withDirectoryWrite = async (_cwd, write) => {
        waiting();
        return write();
      };
      const result = request({ type: "checkout.git.stage.apply.request", scope: "all" });
      try {
        await reachedWriter;
        expect(getGitCommandMetrics().submitted).toBe(0);
      } finally {
        releaseShared();
        await shared;
        await result;
        const metrics = stopGitCommandMetrics();
        expect(metrics.submissions.map(({ priority }) => priority)).not.toContain("normal");
      }
      expect(await result).toMatchObject({ success: true });
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it("expires only Paseo backups outside the newest 20 or older than 14 days", async () => {
    const now = Date.now();
    const prefix = "refs/paseo/backup/";
    const sample = Array.from(
      { length: 22 },
      (_, index) => `${prefix}amend-${now - index}-${"a".repeat(32)}`,
    );
    const expired = `${prefix}stash-drop-${now - 15 * 86400000}-${"b".repeat(32)}`;
    for (const ref of [...sample, expired, prefix + "manual"]) git("update-ref", ref, head);
    const repo = await resolveGitTarget(root);
    await repoWriteMutex.run(repo, "backup-retention-test", () =>
      collectExpiredBackupRefs(repo, now),
    );
    expect(git("for-each-ref", "--format=%(refname)", prefix).trim().split("\n")).toEqual(
      [...sample.slice(0, 20), prefix + "manual"].sort(),
    );
  });

  it("keeps a symbolic backup and its target branch during retention", async () => {
    const now = Date.now();
    const age = now - 15 * 86400000;
    const target = "refs/heads/keep";
    const symbolic = `refs/paseo/backup/branch-del-${age}-${"a".repeat(32)}`;
    const expired = `refs/paseo/backup/branch-del-${age}-${"b".repeat(32)}`;
    git("update-ref", target, head);
    git("symbolic-ref", symbolic, target);
    git("update-ref", expired, head);

    const repo = await resolveGitTarget(root);
    await repoWriteMutex.run(repo, "backup-retention-test", () =>
      collectExpiredBackupRefs(repo, now),
    );

    expect(git("show-ref", "--verify", "--hash", target).trim()).toBe(head);
    expect(git("symbolic-ref", symbolic).trim()).toBe(target);
    expect(git("for-each-ref", "--format=%(refname)", expired)).toBe("");
  });
});

it("stages and unstages an EOF change with no final newline", async () => {
  const path = "example.txt";
  const newText = original.trimEnd() + " edited";
  await writeWorkingFile(path, newText);
  const patch = git("diff", "--", path);
  expect(patch).toContain("\\ No newline at end of file\n");
  const stage = await request({
    type: "checkout.git.stage.apply.request",
    scope: "lines",
    patch,
    expectedHeadSha: head,
  });
  expect(stage).toMatchObject({ success: true });
  expect(git("show", ":" + path)).toBe(newText);
  expect(
    await request({
      type: "checkout.git.unstage.apply.request",
      scope: "lines",
      patch,
      expectedHeadSha: head,
    }),
  ).toMatchObject({ success: true });
  expect(git("show", ":" + path)).toBe(original);
  expect(await readFile(join(root, path), "utf8")).toBe(newText);
});
