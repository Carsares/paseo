import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WSOutboundMessageSchema, wrapSessionMessage } from "@getpaseo/protocol/messages";
import type { BranchMutationRequest } from "./branch-mutate.js";
import { handleGitWorkbenchP1Request, type GitWorkbenchP1Host } from "./git-workbench-p1.js";
import * as workbenchState from "./git-workbench-state.js";
import { resolveP1Target } from "./repo-discovery.js";
import { repoWriteMutex } from "./repo-write-mutex.js";

let workspace: string;
let root: string;
let initial: string;
let host: GitWorkbenchP1Host;
const refresh = vi.fn<GitWorkbenchP1Host["refresh"]>();

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=.git/test-disabled-hooks", "-c", "commit.gpgSign=false", ...args],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  ).trimEnd();
}

async function commit(content: string, cwd = root) {
  await writeFile(join(cwd, "file.txt"), content + "\n");
  git(cwd, "add", "--", "file.txt");
  git(cwd, "commit", "-qm", content);
  return git(cwd, "rev-parse", "HEAD");
}

async function request(
  input: Pick<BranchMutationRequest, "action" | "name"> & Partial<BranchMutationRequest>,
) {
  const response = await handleGitWorkbenchP1Request(
    {
      cwd: root,
      targetRepoRoot: root,
      requestId: randomUUID(),
      expectedHeadSha: initial,
      ...input,
      type: "checkout.git.branch.mutate.request",
    },
    host,
  );
  expect(WSOutboundMessageSchema.safeParse(wrapSessionMessage(response)).success).toBe(true);
  if (response.type !== "checkout.git.branch.mutate.response")
    throw new Error("Unexpected response");
  return response.payload;
}

function listRefs(prefix = "refs/heads") {
  return git(root, "for-each-ref", "--format=%(refname):%(objectname)", prefix)
    .split("\n")
    .filter(Boolean);
}

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), "paseo-branch-test-")));
  root = join(workspace, "repo");
  await mkdir(root);
  git(root, "init", "-qb", "main");
  git(root, "config", "user.name", "Branch Test");
  git(root, "config", "user.email", "branch-test@example.invalid");
  git(root, "config", "core.hooksPath", join(workspace, "disabled-hooks"));
  initial = await commit("initial");
  refresh.mockReset().mockResolvedValue(undefined);
  host = {
    listActiveAgents: async () => [],
    withDirectoryWrite: async (_root, run) => run(),
    refresh,
    reportBackgroundError: (error) => {
      throw error;
    },
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  const repo = await resolveP1Target(root);
  await repoWriteMutex.run(repo, "test-cleanup", async () => {});
  await rm(workspace, { recursive: true, force: true });
});

it("creates, checks out, renames, and deletes local branches with appropriate refreshes", async () => {
  const next = await commit("next");
  git(root, "tag", "review", next);
  const reviewed = await request({
    action: "create",
    name: "refs/heads/review",
    startPoint: initial,
    expectedHeadSha: next,
  });
  expect(reviewed).toMatchObject({ success: true, newHeadSha: next, operationState: "idle" });
  expect(git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(listRefs()).toContain("refs/heads/review:" + initial);

  expect(
    await request({
      action: "create",
      name: "ambiguous",
      startPoint: "review",
      expectedHeadSha: next,
    }),
  ).toMatchObject({ success: false, error: expect.stringMatching(/ambiguous/) });
  expect(
    await request({
      action: "create",
      name: "from-tag",
      startPoint: "refs/tags/review",
      expectedHeadSha: next,
    }),
  ).toMatchObject({ success: true, newHeadSha: next });
  expect(listRefs()).toContain("refs/heads/from-tag:" + next);

  expect(
    await request({ action: "checkout", name: "review", expectedHeadSha: next }),
  ).toMatchObject({ success: true, newHeadSha: initial });
  expect(git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/review");
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("initial\n");

  git(root, "config", "branch.review.description", "Reviewed locally");
  expect(await request({ action: "rename", name: "review", newName: "team/review" })).toMatchObject(
    { success: true, newHeadSha: initial },
  );
  expect(git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/team/review");
  expect(git(root, "config", "branch.team/review.description")).toBe("Reviewed locally");
  expect(listRefs()).not.toContain("refs/heads/review:" + initial);

  expect(await request({ action: "checkout", name: "main" })).toMatchObject({
    success: true,
    newHeadSha: next,
  });
  const deleted = await request({ action: "delete", name: "team/review", expectedHeadSha: next });
  expect(deleted, deleted.error ?? undefined).toMatchObject({ success: true, newHeadSha: next });
  expect(listRefs()).toEqual(["refs/heads/from-tag:" + next, "refs/heads/main:" + next]);
  expect(git(root, "config", "--local", "--name-only", "--list")).not.toContain(
    "branch.team/review.description",
  );
  expect(listRefs("refs/paseo/backup/")).toEqual([]);
  expect(refresh.mock.calls.map(([, , reason]) => reason)).toEqual([
    "create-branch",
    "create-branch",
    "create-branch",
    "switch-branch",
    "rename-branch",
    "switch-branch",
    "commit-changes",
  ]);
});

async function createUnmerged() {
  git(root, "switch", "-qc", "topic");
  const tip = await commit("unmerged");
  git(root, "switch", "-q", "main");
  return tip;
}

it("refuses ordinary deletion of an unmerged branch and preserves its exact tip on force delete", async () => {
  const tip = await createUnmerged();
  const rejected = await request({ action: "delete", name: "topic" });
  expect(rejected).toMatchObject({ success: false, error: expect.stringMatching(/not merged/) });
  expect(listRefs()).toContain("refs/heads/topic:" + tip);
  expect(listRefs("refs/paseo/backup/")).toEqual([]);

  const result = await request({ action: "delete", name: "topic", force: true });
  expect(result).toMatchObject({
    success: true,
    newHeadSha: initial,
    backupRef: expect.stringMatching(/^refs\/paseo\/backup\/branch-del-/),
  });
  expect(listRefs()).toEqual(["refs/heads/main:" + initial]);
  expect(listRefs("refs/paseo/backup/")).toEqual([result.backupRef + ":" + tip]);
});

it("rejects the entire delete and backup when a concurrent Git write moves the target", async () => {
  const tip = await createUnmerged();
  const run = workbenchState.git;
  let moved = false;
  vi.spyOn(workbenchState, "git").mockImplementation(async (repo, args, options) => {
    if (!moved && args[0] === "update-ref" && args.includes("--stdin")) {
      moved = true;
      git(root, "update-ref", "refs/heads/topic", initial, tip);
    }
    return run(repo, args, options);
  });
  const result = await request({ action: "delete", name: "topic", force: true });
  expect(moved).toBe(true);
  expect(result).toMatchObject({
    success: false,
    errorCode: "STALE_HEAD_CONFLICT",
    actualHeadSha: initial,
  });
  expect(listRefs()).toContain("refs/heads/topic:" + initial);
  expect(listRefs("refs/paseo/backup/")).toEqual([]);
});

it("preserves a merged branch if the merge baseline moves before deletion", async () => {
  const tip = await commit("merged tip");
  git(root, "branch", "topic");
  const run = workbenchState.git;
  let moved = false;
  vi.spyOn(workbenchState, "git").mockImplementation(async (repo, args, options) => {
    if (!moved && args[0] === "update-ref" && args.includes("--stdin")) {
      git(root, "update-ref", "refs/heads/main", initial, tip);
      moved = true;
    }
    return run(repo, args, options);
  });

  expect(await request({ action: "delete", name: "topic", expectedHeadSha: tip })).toMatchObject({
    success: false,
    errorCode: "STALE_HEAD_CONFLICT",
    actualHeadSha: initial,
  });
  expect(moved).toBe(true);
  expect(git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(listRefs()).toEqual(["refs/heads/main:" + initial, "refs/heads/topic:" + tip]);
  expect(listRefs("refs/paseo/backup/")).toEqual([]);
});

it("can force delete with a backup when the checked-out branch is still unborn", async () => {
  git(root, "branch", "topic");
  git(root, "symbolic-ref", "HEAD", "refs/heads/unborn");

  const result = await request({
    action: "delete",
    name: "topic",
    expectedHeadSha: null,
    force: true,
  });

  expect(result).toMatchObject({ success: true, newHeadSha: null });
  expect(git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/unborn");
  expect(listRefs()).toEqual(["refs/heads/main:" + initial]);
  expect(listRefs("refs/paseo/backup/")).toEqual([result.backupRef + ":" + initial]);
});

it("rejects deletion while the worktree index is locked and leaves that lock alone", async () => {
  const tip = await createUnmerged();
  const lock = join(root, ".git", "index.lock");
  await writeFile(lock, "pending index write");

  expect(await request({ action: "delete", name: "topic", force: true })).toMatchObject({
    success: false,
    error: expect.stringMatching(/Git is writing the worktree index/),
  });
  expect(await readFile(lock, "utf8")).toBe("pending index write");
  expect(listRefs()).toContain("refs/heads/topic:" + tip);
  expect(listRefs("refs/paseo/backup/")).toEqual([]);
});

it.each(["attached", "detached"] as const)(
  "preserves the branch when a linked worktree switches to it at the same SHA from a %s HEAD",
  async (headMode) => {
    const tip = await createUnmerged();
    const linked = join(workspace, "linked");
    const start = headMode === "attached" ? ["-b", "sibling"] : ["--detach"];
    git(root, "worktree", "add", "-q", ...start, linked, tip);
    const run = workbenchState.git;
    let scans = 0;
    let switched = false;
    vi.spyOn(workbenchState, "git").mockImplementation(async (repo, args, options) => {
      const result = await run(repo, args, options);
      if (args[0] === "worktree" && args[1] === "list" && ++scans === 2) {
        // The final list has already read the old HEAD, but Git has not started
        // its delete transaction. Change only the branch name, not the SHA.
        expect(git(linked, "rev-parse", "HEAD")).toBe(tip);
        git(linked, "switch", "-q", "topic");
        expect(git(linked, "rev-parse", "HEAD")).toBe(tip);
        switched = true;
      }
      return result;
    });

    const result = await request({ action: "delete", name: "topic", force: true });
    expect(switched).toBe(true);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/cannot verify all worktree HEADs/),
    });
    expect(git(linked, "symbolic-ref", "HEAD")).toBe("refs/heads/topic");
    expect(listRefs()).toContain("refs/heads/topic:" + tip);
    expect(listRefs("refs/paseo/backup/")).toEqual([]);
  },
);

it("checks the selected worktree HEAD in the delete transaction, even at the same SHA", async () => {
  git(root, "branch", "topic");
  const run = workbenchState.git;
  let switched = false;
  vi.spyOn(workbenchState, "git").mockImplementation(async (repo, args, options) => {
    if (!switched && args[0] === "update-ref" && args.includes("--stdin")) {
      git(root, "switch", "-q", "topic");
      switched = true;
    }
    return run(repo, args, options);
  });

  expect(await request({ action: "delete", name: "topic" })).toMatchObject({
    success: false,
    errorCode: "STALE_HEAD_CONFLICT",
    actualHeadSha: initial,
  });
  expect(switched).toBe(true);
  expect(git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/topic");
  expect(listRefs()).toEqual(["refs/heads/main:" + initial, "refs/heads/topic:" + initial]);
});

it("refuses deletion when the selected worktree has a detached HEAD", async () => {
  git(root, "branch", "topic");
  git(root, "switch", "-q", "--detach");
  expect(await request({ action: "delete", name: "topic", force: true })).toMatchObject({
    success: false,
    error: expect.stringMatching(/detached HEAD/),
  });
  expect(listRefs()).toEqual(["refs/heads/main:" + initial, "refs/heads/topic:" + initial]);
  expect(git(root, "rev-parse", "HEAD")).toBe(initial);
});

it("refuses deletion from a linked checkout of a bare repository", async () => {
  const bare = join(workspace, "bare.git");
  const linked = join(workspace, "bare-linked");
  git(root, "clone", "-q", "--bare", "--", root, bare);
  git(bare, "worktree", "add", "-qb", "sibling", linked, "main");

  expect(
    await request({ action: "delete", name: "main", cwd: linked, targetRepoRoot: linked }),
  ).toMatchObject({ success: false, error: expect.stringMatching(/linked worktrees/) });
  expect(git(bare, "rev-parse", "refs/heads/main")).toBe(initial);
  expect(git(linked, "symbolic-ref", "HEAD")).toBe("refs/heads/sibling");
});

it("preserves branches in use by a rebase or bisect with a detached worktree", async () => {
  const linked = join(workspace, "linked");
  git(root, "worktree", "add", "-qb", "topic", linked);
  const middle = await commit("middle", linked);
  const tip = await commit("tip", linked);
  git(linked, "bisect", "start", tip, initial);
  expect(git(linked, "rev-parse", "HEAD")).toBe(middle);
  expect(await request({ action: "delete", name: "topic", force: true })).toMatchObject({
    success: false,
    error: expect.stringMatching(/in use by Git/),
  });
  git(linked, "bisect", "reset");

  const advanced = await commit("advance main");
  expect(() => git(linked, "rebase", "main")).toThrow();
  expect(git(linked, "rev-parse", "REBASE_HEAD")).toBe(middle);
  expect(
    await request({ action: "delete", name: "topic", expectedHeadSha: advanced, force: true }),
  ).toMatchObject({ success: false, error: expect.stringMatching(/in use by Git/) });
  expect(listRefs()).toContain("refs/heads/topic:" + tip);
  expect(listRefs("refs/paseo/backup/")).toEqual([]);
});

it("rejects renaming a branch to the same name after normalizing the full reference", async () => {
  const result = await request({
    action: "rename",
    name: "main",
    newName: "refs/heads/main",
  });
  expect(result).toMatchObject({
    success: false,
    error: expect.stringMatching(/different branch name/),
  });
  expect(git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(listRefs()).toEqual(["refs/heads/main:" + initial]);
});

it("blocks deletion of branches checked out in this or another worktree, including force", async () => {
  const linked = join(workspace, "linked");
  git(root, "worktree", "add", "-qb", "held", linked);
  for (const name of ["main", "held"]) {
    expect(await request({ action: "delete", name, force: true })).toMatchObject({
      success: false,
      error: expect.stringMatching(/checked out/),
    });
  }
  expect(await request({ action: "rename", name: "held", newName: "changed" })).toMatchObject({
    success: false,
    error: expect.stringMatching(/checked out/),
  });
  expect(await request({ action: "checkout", name: "held" })).toMatchObject({
    success: false,
    error: expect.stringMatching(/checked out/),
  });
  expect(git(linked, "symbolic-ref", "HEAD")).toBe("refs/heads/held");
  expect(listRefs()).toEqual(["refs/heads/held:" + initial, "refs/heads/main:" + initial]);
  expect(listRefs("refs/paseo/backup/")).toEqual([]);
});

it("preserves an ignored file when switching would overwrite it", async () => {
  await writeFile(join(root, ".gitignore"), "local.txt\n");
  git(root, "add", "--", ".gitignore");
  git(root, "commit", "-qm", "Ignore developer data");
  const head = git(root, "rev-parse", "HEAD");
  git(root, "switch", "-qc", "tracks-local-file");
  await writeFile(join(root, "local.txt"), "Committed content\n");
  git(root, "add", "--force", "--", "local.txt");
  git(root, "commit", "-qm", "Track the file");
  git(root, "switch", "-q", "main");
  await writeFile(join(root, "local.txt"), "Preserve developer data\n");
  expect(
    await request({
      action: "checkout",
      name: "tracks-local-file",
      expectedHeadSha: head,
      force: true,
    }),
  ).toMatchObject({ success: false });
  expect(git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await readFile(join(root, "local.txt"), "utf8")).toBe("Preserve developer data\n");
});

it("rejects unsafe names, stale HEAD, unauthorized roots, active agents, and Git operations", async () => {
  for (const name of ["-x", "foo..bar", "HEAD", "refs/tags/example", "foo.lock", "team//example"]) {
    expect(await request({ action: "create", name })).toMatchObject({ success: false });
  }
  expect(await request({ action: "create", name: "valid", startPoint: "main~1" })).toMatchObject({
    success: false,
  });
  expect(
    await request({ action: "create", name: "valid", expectedHeadSha: "0".repeat(40) }),
  ).toMatchObject({ success: false, errorCode: "STALE_HEAD_CONFLICT", actualHeadSha: initial });

  const linked = join(workspace, "outside");
  git(root, "worktree", "add", "-qb", "outside", linked);
  expect(await request({ action: "create", name: "valid", targetRepoRoot: linked })).toMatchObject({
    success: false,
    error: expect.stringMatching(/outside/),
  });
  host.listActiveAgents = async (repoRoot) => {
    expect(repoRoot).toBe(root);
    return [
      {
        agentId: "running",
        title: null,
        workspaceId: null,
        status: "idle",
        backgroundRunningCount: 1,
      },
    ];
  };
  expect(await request({ action: "create", name: "valid" })).toMatchObject({
    success: false,
    errorCode: "ACTIVE_AGENT_GUARD",
  });
  expect(
    await request({ action: "create", name: "valid", forceWithRunningAgents: true }),
  ).toMatchObject({ success: true });

  await writeFile(join(root, ".git", "MERGE_HEAD"), initial + "\n");
  expect(
    await request({
      action: "rename",
      name: "valid",
      newName: "renamed",
      forceWithRunningAgents: true,
    }),
  ).toMatchObject({
    success: false,
    operationState: "merge",
    error: expect.stringMatching(/current Git operation/),
  });
  expect(listRefs()).toContain("refs/heads/valid:" + initial);
});

it("waits on a sibling's repository lock before checking the expected HEAD", async () => {
  const linked = join(workspace, "linked");
  git(root, "worktree", "add", "-qb", "linked", linked);
  const sibling = await resolveP1Target(linked);
  const { promise: entered, resolve: markEntered } = Promise.withResolvers<void>();
  const { promise: release, resolve: unlock } = Promise.withResolvers<void>();
  const { promise: atDirectoryLock, resolve: enteredDirectoryLock } = Promise.withResolvers<void>();
  const siblingWork = repoWriteMutex.run(sibling, "test-sibling-write", async () => {
    markEntered();
    await release;
  });
  await entered;
  host.withDirectoryWrite = async (cwd, run) => {
    expect(cwd).toBe(root);
    enteredDirectoryLock();
    return run();
  };
  const pending = request({ action: "create", name: "parallel" });
  let next: string;
  try {
    await atDirectoryLock;
    expect(listRefs()).not.toContain("refs/heads/parallel:" + initial);
    next = await commit("new HEAD while waiting");
  } finally {
    unlock();
    await siblingWork;
  }
  expect(await pending).toMatchObject({
    success: false,
    errorCode: "STALE_HEAD_CONFLICT",
    actualHeadSha: next,
  });
  expect(listRefs()).toEqual(["refs/heads/linked:" + initial, "refs/heads/main:" + next]);
});
