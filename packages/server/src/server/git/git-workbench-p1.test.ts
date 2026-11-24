import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CHECKOUT_GIT_LOG_MAX_BYTES,
  WSOutboundMessageSchema,
  wrapSessionMessage,
} from "@getpaseo/protocol/messages";
import { handleGitWorkbenchRequest } from "./checkout-git-workbench.js";
import { GitCommitBaselines } from "./git-commit-baselines.js";
import {
  handleGitWorkbenchP1Request,
  type GitWorkbenchP1Host,
  type GitWorkbenchP1Request,
} from "./git-workbench-p1.js";
import { resolveP1Target } from "./repo-discovery.js";
import { collectExpiredBackupRefs } from "./repo-backup-refs.js";
import { repoWriteMutex } from "./repo-write-mutex.js";

let workspace: string;
let root: string;
let host: GitWorkbenchP1Host;

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=.git/test-disabled-hooks", "-c", "commit.gpgSign=false", ...args],
    {
      cwd,
      input,
      encoding: "utf8",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
}

async function init(path: string) {
  await mkdir(path, { recursive: true });
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["config", "user.email", "test@example.invalid"]);
  git(path, ["config", "user.name", "Graph Author"]);
  git(path, ["config", "commit.gpgSign", "false"]);
}

async function commit(path: string, content: string, message: string, file = "tracked.txt") {
  await writeFile(join(path, file), content);
  git(path, ["--literal-pathspecs", "add", "-f", "--", file]);
  git(path, ["commit", "-q", "-F", "-"], message);
  return git(path, ["rev-parse", "HEAD"]).trim();
}

type BareRequest<T = GitWorkbenchP1Request> = T extends GitWorkbenchP1Request
  ? Omit<T, "cwd" | "requestId">
  : never;
async function request(input: BareRequest, cwd = root) {
  const result = await handleGitWorkbenchP1Request(
    { ...input, cwd, requestId: randomUUID() },
    host,
  );
  expect(WSOutboundMessageSchema.safeParse(wrapSessionMessage(result)).success).toBe(true);
  return result;
}

function payload<T extends Awaited<ReturnType<typeof request>>["type"]>(
  response: Awaited<ReturnType<typeof request>>,
  type: T,
) {
  if (response.type !== type) throw new Error("Unexpected response " + response.type);
  return (response as Extract<typeof response, { type: T }>).payload;
}

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), "paseo-p1-test-")));
  root = join(workspace, "repo");
  host = {
    withDirectoryWrite: async (_cwd, run) => run(),
    listActiveAgents: async () => [],
    refresh: async () => {},
    reportBackgroundError: (error) => {
      throw error;
    },
  };
  await init(root);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function refreshWorkingTree() {
  const response = await handleGitWorkbenchRequest(
    { type: "checkout.git.working_tree.get.request", cwd: root, requestId: randomUUID() },
    { ...host, generateCommitMessage: async () => "" },
    new GitCommitBaselines(),
  );
  expect(WSOutboundMessageSchema.safeParse(wrapSessionMessage(response)).success).toBe(true);
  if (response.type !== "checkout.git.working_tree.get.response")
    throw new Error("Unexpected response " + response.type);
  expect(response.payload.error).toBeNull();
  return response.payload.workingTree;
}

it("discovers at most 16 roots, never following directory links or probing beyond depth two", async () => {
  const parent = join(workspace, "group");
  await mkdir(parent);
  const shallow = join(parent, "repo-a");
  const deep = join(parent, "deep", "too-deep");
  await init(shallow);
  await init(deep);
  await Promise.all(
    ["node_modules", "dist", "vendor"].map((dir) => init(join(workspace, dir, "hidden"))),
  );
  await init(join(root, ".git", "hidden"));
  if (process.platform !== "win32") await symlink(root, join(parent, "linked"));
  let result = payload(
    await request({ type: "checkout.git.repos.discover.request", maxDepth: 3 }, workspace),
    "checkout.git.repos.discover.response",
  );
  expect(result.repos.map(({ repoRoot }) => repoRoot)).toEqual([root, shallow]);
  const fromRoot = payload(
    await request({ type: "checkout.git.repos.discover.request" }, root),
    "checkout.git.repos.discover.response",
  );
  expect(fromRoot.repos).toEqual([result.repos[0]]);
  if (process.platform !== "win32") {
    await expect(resolveP1Target(workspace, join(parent, "linked"))).rejects.toThrow(
      /symbolic link/i,
    );
  }
  await Promise.all(
    Array.from({ length: 16 }, (_, i) => init(join(workspace, "many", String(i).padStart(2, "0")))),
  );
  result = payload(
    await request({ type: "checkout.git.repos.discover.request" }, workspace),
    "checkout.git.repos.discover.response",
  );
  expect(result.repos).toHaveLength(16);
  expect(result.repos.slice(0, 3).map(({ repoRoot }) => repoRoot)).toEqual([
    root,
    shallow,
    join(workspace, "many", "00"),
  ]);
});

it("includes linked worktrees only when requested, and rejects targets outside the checkout", async () => {
  await commit(root, "base\n", "Base");
  const linked = join(workspace, "linked");
  git(root, ["worktree", "add", "-qb", "linked-branch", linked]);
  await mkdir(join(workspace, "vendor"));
  git(root, ["worktree", "add", "-qb", "excluded-branch", join(workspace, "vendor", "linked")]);
  const input = { type: "checkout.git.repos.discover.request" } as const;
  const normal = payload(await request(input, workspace), "checkout.git.repos.discover.response");
  const included = payload(
    await request({ ...input, includeWorktrees: true }, workspace),
    "checkout.git.repos.discover.response",
  );
  expect(normal.repos.map(({ repoRoot }) => repoRoot)).toEqual([root]);
  const expectedIds = await Promise.all(
    [linked, root].map(async (repoRoot) => ({
      repoRoot,
      repoId: createHash("sha256")
        .update(await realpath(repoRoot))
        .digest("hex")
        .slice(0, 12),
    })),
  );
  expect(included.repos.map(({ repoRoot, repoId }) => ({ repoRoot, repoId }))).toEqual(expectedIds);
  expect(normal.repos[0]?.repoId).toBe(expectedIds[1]?.repoId);
  const direct = payload(await request(input, linked), "checkout.git.repos.discover.response");
  expect(direct.repos).toEqual([included.repos[0]]);
  await expect(resolveP1Target(root, linked)).rejects.toThrow(/outside the workspace/);
});

it("merges stable pages across repositories, detects stale and tampered cursors, and reads graph details", async () => {
  const other = join(workspace, "other");
  await init(other);
  const first = await commit(root, "one\n", "A literal [subject]\n\nCommit body\n");
  const second = await commit(root, "one\ntwo\n", "A second");
  const third = await commit(other, "other\n", "A third");
  git(root, ["tag", "v1", first]);
  git(root, ["tag", "-a", "v2", "-m", "Release two", second]);
  git(root, ["update-ref", "refs/remotes/origin/main", first]);
  git(root, ["update-ref", "refs/paseo/backup/example", second]);
  const query = {
    type: "checkout.git.log.query.request",
    repoRoots: [root, other],
    pageSize: 1,
  } as const;
  const all = [];
  let cursor: string | undefined;
  do {
    const result = await request(
      { ...query, repoRoots: query.repoRoots.toReversed(), cursor },
      workspace,
    );
    const page = payload(result, "checkout.git.log.query.response");
    expect(page.error).toBeNull();
    expect(page.approxBytes).toBe(Buffer.byteLength(JSON.stringify(wrapSessionMessage(result))));
    all.push(...page.commits.map(({ sha }) => sha));
    cursor = page.nextCursor ?? undefined;
  } while (cursor && all.length <= 3);
  expect(new Set(all)).toEqual(new Set([first, second, third]));
  expect(all).toHaveLength(3);
  expect(all.indexOf(second)).toBeLessThan(all.indexOf(first));

  const filtered = payload(
    await request({
      ...query,
      repoRoots: [root],
      authorFilter: "Graph Author",
      textQuery: "[subject]",
      branchFilter: "refs/heads/main",
    }),
    "checkout.git.log.query.response",
  );
  expect(filtered.commits.map(({ sha }) => sha)).toEqual([first]);
  const refs = payload(
    await request({
      type: "checkout.git.refs.list.request",
      repoRoots: [root],
      includeBackups: true,
    }),
    "checkout.git.refs.list.response",
  ).refs[0];
  expect(refs).toMatchObject({
    localBranches: [{ name: "main", sha: second }],
    remotes: [{ name: "origin", branches: [{ name: "main", sha: first }] }],
    tags: [
      { name: "v1", sha: first },
      { name: "v2", sha: second },
    ],
    backups: [{ name: "refs/paseo/backup/example", sha: second }],
  });
  const detail = payload(
    await request({
      type: "checkout.git.commit.get_detail.request",
      sha: first,
      targetRepoRoot: root,
    }),
    "checkout.git.commit.get_detail.response",
  );
  expect(detail.detail).toMatchObject({
    body: "Commit body\n",
    parents: [],
    files: [{ path: "tracked.txt", status: "added", additions: 1, deletions: 0 }],
  });

  const baseQuery = { ...query, repoRoots: [root, other] };
  const start = payload(
    await request(baseQuery, workspace),
    "checkout.git.log.query.response",
  ).nextCursor!;
  const tampered = payload(
    await request(
      { ...baseQuery, cursor: (start[0] === "X" ? "Y" : "X") + start.slice(1) },
      workspace,
    ),
    "checkout.git.log.query.response",
  );
  expect(tampered.error).toMatch(/cursor expired/);
  const backupHistory = payload(
    await request({
      ...query,
      repoRoots: [root],
      branchFilter: "refs/paseo/backup/example",
    }),
    "checkout.git.log.query.response",
  );
  expect(backupHistory.commits[0]?.sha).toBe(second);
  await commit(other, "another\n", "New tip");
  const stale = payload(
    await request({ ...baseQuery, cursor: start }, workspace),
    "checkout.git.log.query.response",
  );
  expect(stale.error).toMatch(/cursor expired/);
});

it("keeps a qualified branch separate from a branch with that text as its short name", async () => {
  const { base, original, onto } = await createConflictingHistory();
  git(root, ["update-ref", "refs/heads/refs/heads/main", onto]);
  git(root, ["update-ref", "refs/heads/refs/example", onto]);
  const log = async (branchFilter: string) => {
    const result = payload(
      await request({ type: "checkout.git.log.query.request", repoRoots: [root], branchFilter }),
      "checkout.git.log.query.response",
    );
    expect(result.error).toBeNull();
    return result.commits.map(({ sha }) => sha);
  };
  expect(await log("refs/heads/main")).toEqual([original, base]);
  expect(await log("refs/heads/refs/heads/main")).toEqual([onto, base]);
  expect(await log("refs/example")).toEqual([onto, base]);
  expect(await log("main")).toEqual([original, base]);
});

it("returns only the first 500 changed files with accurate counts", async () => {
  const files = Array.from(
    { length: 501 },
    (_, index) => "file-" + String(index).padStart(3, "0") + ".txt",
  );
  await Promise.all(files.map((file) => writeFile(join(root, file), "line\n")));
  git(root, ["add", "--all"]);
  git(root, ["commit", "-qm", "Many changes"]);
  const sha = git(root, ["rev-parse", "HEAD"]).trim();
  const response = payload(
    await request({ type: "checkout.git.commit.get_detail.request", sha }),
    "checkout.git.commit.get_detail.response",
  );
  expect(response.detail?.filesTruncated).toBe(true);
  expect(response.detail?.files.map(({ path }) => path)).toEqual(files.slice(0, 500));
  expect(response.detail?.files[0]).toMatchObject({ additions: 1, deletions: 0 });
});

it("keeps each WebSocket page within two MiB without skipping rows at the limit", async () => {
  // Fast-import builds the entire isolated history in one process. The latest 300
  // subjects force the byte ceiling well before the row ceiling.
  let importData = "";
  for (let i = 1; i <= 5100; i++) {
    const subject = i > 4800 ? "长".repeat(4000) + i : "Commit " + i;
    importData +=
      [
        "commit refs/heads/main",
        "mark :" + i,
        "committer Graph Author <test@example.invalid> " + (1700000000 + i) + " +0000",
        "data " + Buffer.byteLength(subject),
        subject,
      ].join("\n") + "\n";
    if (i > 1) importData += "from :" + (i - 1) + "\n";
    importData += "\n";
  }
  git(root, ["fast-import", "--quiet"], importData);
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < 25; i++) {
    const result = await request({
      type: "checkout.git.log.query.request",
      repoRoots: [root],
      pageSize: 300,
      cursor,
    });
    const page = payload(result, "checkout.git.log.query.response");
    expect(page.error).toBeNull();
    expect(page.approxBytes).toBe(Buffer.byteLength(JSON.stringify(wrapSessionMessage(result))));
    expect(page.approxBytes).toBeLessThanOrEqual(CHECKOUT_GIT_LOG_MAX_BYTES);
    expect(page.commits.length).toBeGreaterThan(0);
    if (i === 0) expect(page.commits.length).toBeLessThan(300);
    for (const commitRow of page.commits) {
      expect(seen.has(commitRow.sha)).toBe(false);
      seen.add(commitRow.sha);
    }
    cursor = page.nextCursor ?? undefined;
    expect(page.hasMore).toBe(Boolean(cursor));
    if (!cursor) break;
  }
  expect(cursor).toBeUndefined();
  const expected = git(root, ["rev-list", "HEAD"]).trim().split("\n");
  expect(expected).toHaveLength(5100);
  expect([...seen]).toEqual(expected);
}, 15000);

async function plan(ontoRef: string, dryRun = true) {
  return payload(
    await request({ type: "checkout.git.rebase.build_plan.request", ontoRef, dryRun }),
    "checkout.git.rebase.build_plan.response",
  );
}

async function execute(
  input: Omit<
    BareRequest<Extract<GitWorkbenchP1Request, { type: "checkout.git.rebase.execute.request" }>>,
    "type"
  >,
) {
  return payload(
    await request({ ...input, type: "checkout.git.rebase.execute.request" }),
    "checkout.git.rebase.execute.response",
  );
}

async function act(
  input: Omit<
    BareRequest<Extract<GitWorkbenchP1Request, { type: "checkout.git.rebase.act.request" }>>,
    "type"
  >,
) {
  return payload(
    await request({ ...input, type: "checkout.git.rebase.act.request" }),
    "checkout.git.rebase.act.response",
  );
}

it("runs a complete five-step noninteractive rebase, rejects stale or incomplete plans, and safely undoes it", async () => {
  const base = await commit(root, "base\n", "Base");
  git(root, ["branch", "onto", base]);
  const shas = [];
  for (let i = 1; i <= 5; i++) shas.push(await commit(root, "data\n", "Step " + i, "file-" + i));
  const original = shas[4]!;
  const planned = await plan("onto");
  expect(planned).toMatchObject({
    error: null,
    headSha: original,
    ontoSha: base,
    conflictPaths: [],
  });
  expect(planned.entries.map(({ sha }) => sha)).toEqual(shas);
  const message = "Rewritten 'subject'\n\nLine with $(literal), `backticks` and \"quotes\".\n";
  const steps = [
    { type: "reword", sha: shas[0]!, message },
    { type: "pick", sha: shas[1]! },
    { type: "squash", sha: shas[2]! },
    { type: "fixup", sha: shas[3]! },
    { type: "drop", sha: shas[4]! },
  ] as const;
  const options = { ontoRef: base, steps: [...steps], expectedHeadSha: original };
  expect((await execute({ ...options, expectedHeadSha: base })).errorCode).toBe(
    "STALE_HEAD_CONFLICT",
  );
  expect((await execute({ ...options, steps: steps.slice(0, 4) })).error).toMatch(/every commit/);
  expect(
    (await execute({ ...options, steps: [...steps.slice(0, 4), { type: "drop", sha: base }] }))
      .error,
  ).toMatch(/unknown/i);
  expect((await execute({ ...options, ontoRef: "--invalid-target" })).error).toMatch(
    /invalid rebase target/i,
  );
  host.listActiveAgents = async () => [
    {
      agentId: "descendant",
      workspaceId: null,
      status: "idle",
      title: null,
      backgroundRunningCount: 1,
    },
  ];
  expect((await execute(options)).errorCode).toBe("ACTIVE_AGENT_GUARD");
  host.listActiveAgents = async () => [];
  expect(git(root, ["for-each-ref", "refs/paseo/backup/"])).toBe("");
  expect(git(root, ["status", "--porcelain"])).toBe("");
  const completed = await execute(options);
  expect(completed).toMatchObject({ success: true, operationState: "idle", error: null });
  expect(git(root, ["log", "--format=%B", base + "..HEAD"])).toContain(message.trimEnd());
  expect(git(root, ["rev-list", "--count", base + "..HEAD"]).trim()).toBe("2");
  expect(git(root, ["rev-parse", completed.backupRef!]).trim()).toBe(original);

  const undo = {
    action: "undo",
    expectedRebaseId: completed.rebaseId!,
    backupRef: completed.backupRef,
  } as const;
  await writeFile(join(root, "unrelated"), "preserve\n");
  expect((await act(undo)).error).toMatch(/clean index and worktree/);
  expect(await readFile(join(root, "unrelated"), "utf8")).toBe("preserve\n");
  await rm(join(root, "unrelated"));
  expect((await act(undo)).newHeadSha).toBe(original);
  expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(original);
  expect(git(root, ["status", "--porcelain"])).toBe("");
}, 15000);

async function createConflictingHistory(withOrdinaryChange = false) {
  const base = await commit(root, "base\n", "Base", "[literal].txt");
  git(root, ["checkout", "-qb", "onto"]);
  const onto = await commit(root, "upstream\n", "Upstream", "[literal].txt");
  git(root, ["checkout", "-q", "main"]);
  if (withOrdinaryChange) {
    await writeFile(join(root, "ordinary.txt"), "Automatically staged by Git\n");
    git(root, ["add", "--", "ordinary.txt"]);
  }
  const original = await commit(root, "topic\n", "Topic", "[literal].txt");
  return { original, onto, base };
}

async function pauseConflict(withOrdinaryChange = false) {
  const history = await createConflictingHistory(withOrdinaryChange);
  const { onto, original } = history;
  const preview = await plan(onto);
  expect(preview).toMatchObject({ error: null, conflictPaths: ["[literal].txt"] });
  const paused = await execute({
    ontoRef: onto,
    expectedHeadSha: original,
    steps: [{ type: "reword", sha: original, message: "Reword after conflict\n" }],
  });
  expect(paused).toMatchObject({
    errorCode: "REBASE_CONFLICT_PAUSED",
    operationState: "rebase_paused",
  });
  expect((await refreshWorkingTree())?.rebaseId).toBe(paused.rebaseId);
  return { ...history, paused };
}

it("isolates the preview from Git settings and leaves the source checkout untouched", async () => {
  const { original, onto } = await createConflictingHistory();
  const globalConfig = join(workspace, "test.gitconfig");
  await writeFile(globalConfig, "[merge]\n\tdefault = union\n");
  git(root, ["config", "merge.default", "union"]);
  const inventory = async () => ({
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    refs: git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    objects: git(root, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]),
    configuration: await readFile(join(root, ".git", "config")),
    index: await readFile(join(root, ".git", "index")),
    contents: await readFile(join(root, "[literal].txt")),
    status: git(root, ["--no-optional-locks", "status", "--porcelain"]),
  });
  const before = await inventory();
  vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", "merge.default");
  vi.stubEnv("GIT_CONFIG_VALUE_0", "union");
  try {
    expect(await plan(onto)).toMatchObject({
      error: null,
      headSha: original,
      conflictPaths: ["[literal].txt"],
    });
  } finally {
    vi.unstubAllEnvs();
  }
  expect(await inventory()).toEqual(before);
});

it("reloads a paused instance and only identifies completion on the same branch and HEAD", async () => {
  const { paused, original, onto } = await pauseConflict();
  expect(await refreshWorkingTree()).toMatchObject({
    operationState: "rebase_paused",
    rebaseId: paused.rebaseId,
    currentBranch: null,
  });
  expect(paused.backupRef).toMatch(
    new RegExp(`^refs/paseo/backup/rebase-\\d{13}-${paused.rebaseId!.replaceAll("-", "")}$`),
  );
  const path = "[literal].txt";
  const inspect = async () =>
    payload(
      await request({ type: "checkout.git.conflict.inspect.request", path }),
      "checkout.git.conflict.inspect.response",
    ).conflicts[0]!;
  const originalConflict = await inspect();
  expect(originalConflict.hunks).toEqual([
    { index: 0, base: "base\n", ours: "upstream\n", theirs: "topic\n" },
  ]);
  const resolve = {
    type: "checkout.git.conflict.resolve.request",
    path,
    strategy: "both",
    hunkIndex: 0,
    expectedConflictFingerprint: originalConflict.conflictFingerprint,
  } as const;
  await writeFile(join(root, path), (await readFile(join(root, path), "utf8")) + "keep\n");
  const stale = payload(await request(resolve), "checkout.git.conflict.resolve.response");
  expect(stale.errorCode).toBe("STALE_CONFLICT_SNAPSHOT");
  const invalidPath = payload(
    await request({ ...resolve, path: "../outside.txt" }),
    "checkout.git.conflict.resolve.response",
  );
  expect(invalidPath.success).toBe(false);
  const resolved = payload(
    await request({
      ...resolve,
      expectedConflictFingerprint: (await inspect()).conflictFingerprint,
    }),
    "checkout.git.conflict.resolve.response",
  );
  expect(resolved).toMatchObject({ success: true, error: null });
  expect(await readFile(join(root, path), "utf8")).toBe("upstream\ntopic\nkeep\n");
  expect((await act({ action: "continue", expectedRebaseId: randomUUID() })).errorCode).toBe(
    "STALE_REBASE_INSTANCE",
  );
  const completed = await act({ action: "continue", expectedRebaseId: paused.rebaseId! });
  expect(completed).toMatchObject({
    success: true,
    operationState: "idle",
    rebaseId: paused.rebaseId,
  });
  expect(git(root, ["log", "-1", "--format=%s"]).trim()).toBe("Reword after conflict");
  const completedHead = git(root, ["rev-parse", "HEAD"]).trim();
  expect(await refreshWorkingTree()).toMatchObject({
    operationState: "idle",
    currentBranch: "main",
    headSha: completedHead,
    rebaseId: paused.rebaseId,
  });
  git(root, ["switch", "-qc", "other"]);
  const otherBranch = await refreshWorkingTree();
  expect(otherBranch).toMatchObject({ currentBranch: "other", headSha: completedHead });
  expect(otherBranch).not.toHaveProperty("rebaseId");

  git(root, ["switch", "-q", "main"]);
  git(root, ["update-ref", "refs/heads/main", onto, completedHead]);
  const movedHead = await refreshWorkingTree();
  expect(movedHead).toMatchObject({ currentBranch: "main", headSha: onto });
  expect(movedHead).not.toHaveProperty("rebaseId");
  git(root, ["update-ref", "refs/heads/main", completedHead, onto]);
  expect(
    await act({ action: "undo", expectedRebaseId: paused.rebaseId!, backupRef: paused.backupRef }),
  ).toMatchObject({ success: true, newHeadSha: original });
  expect(await refreshWorkingTree()).not.toHaveProperty("rebaseId");
}, 15000);

it("rejects an unrelated backup and protects a paused worktree until undo can restore the original checkout", async () => {
  const { original, paused, onto } = await pauseConflict();
  const undo = {
    action: "undo",
    expectedRebaseId: paused.rebaseId!,
    backupRef: paused.backupRef,
  } as const;
  expect((await act({ ...undo, backupRef: "refs/paseo/backup/other" })).error).toMatch(
    /does not belong/,
  );
  expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(onto);
  await writeFile(join(root, "preserve.txt"), "untracked work\n");
  expect((await act(undo)).error).toMatch(/changes outside/);
  expect(await readFile(join(root, "preserve.txt"), "utf8")).toBe("untracked work\n");
  await rm(join(root, "preserve.txt"));
  expect((await act(undo)).newHeadSha).toBe(original);
  expect(await readFile(join(root, "[literal].txt"), "utf8")).toBe("topic\n");
  expect(git(root, ["status", "--porcelain"])).toBe("");
}, 15000);

it("rejects changes to the pending plan and keeps a clean path to skipping the conflicting commit", async () => {
  const { paused, onto } = await pauseConflict(true);
  const todo = join(root, ".git", "rebase-merge", "git-rebase-todo");
  const originalTodo = await readFile(todo, "utf8");
  const attempt = { action: "skip", expectedRebaseId: paused.rebaseId! } as const;
  await writeFile(todo, originalTodo + "pick " + onto + "\n");
  expect((await act(attempt)).error).toMatch(/plan changed/);
  expect((await refreshWorkingTree())?.rebaseId).toBe(paused.rebaseId);
  await writeFile(todo, originalTodo);
  expect(await act(attempt)).toMatchObject({
    success: true,
    operationState: "idle",
    newHeadSha: onto,
  });
  expect(await readFile(join(root, "[literal].txt"), "utf8")).toBe("upstream\n");
});

it("protects ignored files and tracked edits hidden from Git status", async () => {
  await commit(root, "base\n", "Base");
  await commit(root, "ignored.txt\n", "Ignore", ".gitignore");
  git(root, ["checkout", "-qb", "onto"]);
  const ontoRef = await commit(root, "upstream\n", "Upstream", "ignored.txt");
  git(root, ["checkout", "-q", "main"]);
  const expectedHeadSha = await commit(root, "topic\n", "Topic");
  const input = {
    ontoRef,
    expectedHeadSha,
    steps: [{ type: "pick" as const, sha: expectedHeadSha }],
  };
  await writeFile(join(root, "ignored.txt"), "preserve ignored\n");
  expect((await execute(input)).error).toMatch(/ignored file/);
  expect(await readFile(join(root, "ignored.txt"), "utf8")).toBe("preserve ignored\n");
  await rm(join(root, "ignored.txt"));
  git(root, ["update-index", "--assume-unchanged", "tracked.txt"]);
  await writeFile(join(root, "tracked.txt"), "preserve tracked\n");
  expect(git(root, ["status", "--porcelain"])).toBe("");
  expect((await execute(input)).error).toMatch(/hidden from Git status/);
  expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("preserve tracked\n");
  expect(git(root, ["for-each-ref", "refs/paseo/backup/"])).toBe("");
});

it("preserves same-path worktree edits and staged resolutions on destructive actions", async () => {
  const { paused, onto } = await pauseConflict(true);
  const path = "[literal].txt";
  const ordinaryPath = "ordinary.txt";
  const markerText = await readFile(join(root, path), "utf8");
  const stagedBefore = git(root, ["ls-files", "--stage", "-z"]);
  const discarding = async () => {
    for (const action of ["skip", "abort", "undo"] as const) {
      const result = await act({
        action,
        expectedRebaseId: paused.rebaseId!,
        backupRef: paused.backupRef,
      });
      expect(result).toMatchObject({
        success: false,
        error: expect.stringMatching(/changed since the rebase paused/),
      });
    }
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(onto);
  };

  await writeFile(join(root, path), markerText + "User draft\n");
  await discarding();
  expect(await readFile(join(root, path), "utf8")).toBe(markerText + "User draft\n");
  expect(git(root, ["ls-files", "--stage", "-z"])).toBe(stagedBefore);
  await writeFile(join(root, path), markerText);

  await writeFile(join(root, ordinaryPath), "User edited the ordinarily staged change\n");
  git(root, ["add", "--", ordinaryPath]);
  await discarding();
  expect(git(root, ["show", ":" + ordinaryPath])).toBe(
    "User edited the ordinarily staged change\n",
  );
  await writeFile(join(root, ordinaryPath), "Automatically staged by Git\n");
  git(root, ["add", "--", ordinaryPath]);

  await writeFile(join(root, path), "Resolved by the user\n");
  git(root, ["--literal-pathspecs", "add", "--", path]);
  await discarding();
  expect(git(root, ["show", ":" + path])).toBe("Resolved by the user\n");
  expect(await act({ action: "continue", expectedRebaseId: paused.rebaseId! })).toMatchObject({
    success: true,
  });
  expect(git(root, ["show", "HEAD:" + path])).toBe("Resolved by the user\n");
}, 15000);

it("keeps active rebase backups across linked worktrees past the normal capacity and age", async () => {
  const { paused, onto, original } = await pauseConflict();
  const linked = join(workspace, "linked");
  git(root, ["worktree", "add", "-qb", "linked-branch", linked, original]);
  const other = payload(
    await request(
      {
        type: "checkout.git.rebase.execute.request",
        ontoRef: onto,
        expectedHeadSha: original,
        steps: [{ type: "pick", sha: original }],
      },
      linked,
    ),
    "checkout.git.rebase.execute.response",
  );
  expect(other.errorCode).toBe("REBASE_CONFLICT_PAUSED");

  const prefix = "refs/paseo/backup/";
  const now = Date.now() + 60_000;
  const overAge = now + 15 * 24 * 3600_000;
  const ordinary = Array.from(
    { length: 22 },
    (_, i) => prefix + "amend-" + (now - i) + "-" + "0".repeat(32),
  );
  for (const ref of ordinary) git(root, ["update-ref", ref, original]);
  const backups = () =>
    git(root, ["for-each-ref", "--format=%(refname)", prefix]).trim().split("\n").filter(Boolean);
  const retained = [paused.backupRef!, other.backupRef!].sort();
  const primaryRepo = await resolveP1Target(root);
  const linkedRepo = await resolveP1Target(linked);
  expect(linkedRepo.commonDir).toBe(primaryRepo.commonDir);

  await repoWriteMutex.run(primaryRepo, "retention-test", () =>
    collectExpiredBackupRefs(primaryRepo, now),
  );
  expect(backups()).toEqual([...retained, ...ordinary.slice(0, 20)].sort());
  await repoWriteMutex.run(linkedRepo, "retention-test", () =>
    collectExpiredBackupRefs(linkedRepo, overAge),
  );
  expect(backups()).toEqual(retained);

  const abort = async (cwd: string, id: string) =>
    payload(
      await request(
        {
          type: "checkout.git.rebase.act.request",
          action: "abort",
          expectedRebaseId: id,
        },
        cwd,
      ),
      "checkout.git.rebase.act.response",
    );
  expect(await abort(root, paused.rebaseId!)).toMatchObject({
    success: true,
    newHeadSha: original,
  });
  expect(await abort(linked, other.rebaseId!)).toMatchObject({
    success: true,
    newHeadSha: original,
  });
  await repoWriteMutex.run(primaryRepo, "retention-test", () =>
    collectExpiredBackupRefs(primaryRepo, overAge),
  );
  expect(backups()).toEqual([]);
}, 15000);
