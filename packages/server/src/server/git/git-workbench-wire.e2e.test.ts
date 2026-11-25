import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

it("serializes Git writes and rejects a commit after another client changes the staged set", async () => {
  const temp = await mkdtemp(join(tmpdir(), "paseo-git-wire-"));
  try {
    const repoRoot = await realpath(temp);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.name", "Paseo Test");
    git("config", "user.email", "paseo-test@example.invalid");
    git("config", "core.hooksPath", ".git/test-disabled-hooks");
    git("config", "commit.gpgSign", "false");
    const paths = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];
    await Promise.all(paths.map((path) => writeFile(join(repoRoot, path), `${path}\n`)));

    const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
    try {
      const url = `ws://127.0.0.1:${daemon.port}/ws`;
      const clients = [new DaemonClient({ url }), new DaemonClient({ url })];
      const client = clients[0]!;
      try {
        await Promise.all(clients.map((peer) => peer.connect()));
        expect(client.getLastServerInfoMessage()?.features?.checkoutGitStagingV1).toBe(true);

        const created = await client.createWorkspace({
          source: { kind: "directory", path: repoRoot },
        });
        expect(created.error).toBeNull();
        const target = { cwd: repoRoot, targetRepoRoot: repoRoot };
        const before = await client.checkoutGitWorkingTreeGet(target);
        expect(before.error).toBeNull();
        expect(before.workingTree).toMatchObject({ headSha: null, staged: [], untracked: paths });

        const staged = await Promise.all(
          paths.map((path, index) =>
            clients[index % clients.length]!.checkoutGitStageApply({
              ...target,
              scope: "paths",
              paths: [path],
              expectedHeadSha: null,
            }),
          ),
        );
        expect(staged.map(({ success, error }) => [success, error])).toEqual(
          paths.map(() => [true, null]),
        );
        expect(git("ls-files", "-z").split("\0").filter(Boolean)).toEqual(paths);

        const unstaged = await client.checkoutGitUnstageApply({
          ...target,
          scope: "paths",
          paths: [paths[0]!],
          expectedHeadSha: null,
        });
        expect(unstaged.success).toBe(true);
        const after = await client.checkoutGitWorkingTreeGet(target);
        expect(after.error).toBeNull();
        expect(after.workingTree).toMatchObject({
          headSha: null,
          staged: paths.slice(1).map((path) => ({ path, status: "added" })),
          untracked: paths.slice(0, 1),
        });

        const changed = await clients[1]!.checkoutGitStageApply({
          ...target,
          scope: "paths",
          paths: [paths[0]!],
          expectedHeadSha: null,
        });
        expect(changed.success).toBe(true);

        const stale = await client.checkoutGitCommitCreate({
          ...target,
          expectedHeadSha: null,
          message: "Commit the four reviewed files",
          snapshotRequestId: after.requestId,
        });
        expect(stale).toMatchObject({ success: false, errorCode: "STALE_HEAD_CONFLICT" });
        const latest = await client.checkoutGitWorkingTreeGet(target);
        expect(latest.workingTree).toMatchObject({
          headSha: null,
          staged: paths.map((path) => ({ path, status: "added" })),
          untracked: [],
        });
        await expect(
          client.checkoutGitCommitCreate({
            ...target,
            expectedHeadSha: null,
            message: "Missing snapshot",
          }),
        ).rejects.toThrow("requires the request ID of the reviewed working tree snapshot");
        const commit = await client.checkoutGitCommitCreate({
          ...target,
          expectedHeadSha: null,
          message: "Commit the reviewed files",
          snapshotRequestId: latest.requestId,
          requestId: "commit-five",
        });
        expect(commit).toMatchObject({
          success: true,
          error: null,
          requestId: `paseo-git-commit:${latest.requestId}:commit-five`,
        });
        expect(
          git("show", "--format=%s", "--name-only", "HEAD").split("\n").filter(Boolean),
        ).toEqual(["Commit the reviewed files", ...paths]);
        const headSha = git("rev-parse", "HEAD").trim();
        await writeFile(join(repoRoot, "a.txt"), "another version\n");
        expect(
          (
            await client.checkoutGitStageApply({
              ...target,
              scope: "paths",
              paths: ["a.txt"],
              expectedHeadSha: headSha,
            })
          ).success,
        ).toBe(true);
        const next = await client.checkoutGitWorkingTreeGet(target);
        const legacyId = `paseo-git-commit:${next.requestId}:${randomUUID()}`;
        await expect(
          client.checkoutGitCommitCreate({
            ...target,
            expectedHeadSha: headSha,
            message: "Legacy request ID",
            requestId: legacyId,
          }),
        ).resolves.toMatchObject({ success: true, error: null, requestId: legacyId });
      } finally {
        await Promise.allSettled(clients.map((peer) => peer.close()));
      }
    } finally {
      await daemon.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

it("exposes Git P1 and recovers a paused rebase after an isolated daemon restart", async () => {
  const temp = await mkdtemp(join(tmpdir(), "paseo-git-p1-wire-"));
  try {
    const repoDir = join(temp, "repo");
    await mkdir(repoDir);
    const repoRoot = await realpath(repoDir);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "core.hooksPath=.git/test-disabled-hooks", ...args], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.name", "Paseo Test");
    git("config", "user.email", "paseo-test@example.invalid");
    const path = "conflict.txt";
    const seedCommit = async (contents: string, subject: string, parent?: string) => {
      await writeFile(join(repoRoot, path), contents);
      git("add", "--", path);
      const tree = git("write-tree");
      return git("commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", subject);
    };
    const base = await seedCommit("base\n", "Base");
    const onto = await seedCommit("upstream\n", "Upstream", base);
    const originalHead = await seedCommit("topic\n", "Topic", base);
    git("update-ref", "refs/heads/main", originalHead);
    git("update-ref", "refs/heads/onto", onto);

    const homeRoot = join(temp, "home");
    const staticDir = join(temp, "static");
    await mkdir(staticDir);
    const daemonOptions = { mcpEnabled: false, cleanup: false, paseoHomeRoot: homeRoot, staticDir };
    const target = { cwd: repoRoot, targetRepoRoot: repoRoot };
    const graphTarget = { cwd: repoRoot, repoRoots: [repoRoot] };

    const firstDaemon = await createTestPaseoDaemon(daemonOptions);
    const client = new DaemonClient({ url: `ws://127.0.0.1:${firstDaemon.port}/ws` });
    const paused = await (async () => {
      try {
        await client.connect();
        expect(client.getLastServerInfoMessage()?.features).toMatchObject({
          checkoutGitGraphV1: true,
          checkoutGitMultiRepoV1: true,
          checkoutGitRebaseV1: true,
        });
        const workspace = await client.createWorkspace({
          source: { kind: "directory", path: repoRoot },
        });
        expect(workspace.error).toBeNull();
        expect(await client.checkoutGitReposDiscover({ cwd: repoRoot })).toMatchObject({
          error: null,
          repos: [{ repoRoot, headSha: originalHead }],
        });
        expect(
          await client.checkoutGitBranchMutate({
            ...target,
            action: "create",
            name: "review/base",
            startPoint: base,
            expectedHeadSha: originalHead,
          }),
        ).toMatchObject({ success: true, error: null, newHeadSha: originalHead });
        expect(git("rev-parse", "--verify", "refs/heads/review/base")).toBe(base);
        expect(
          await client.checkoutGitBranchMutate({
            ...target,
            action: "create",
            name: "review/unmerged",
            startPoint: onto,
            expectedHeadSha: originalHead,
          }),
        ).toMatchObject({ success: true, error: null, newHeadSha: originalHead });
        const deleted = await client.checkoutGitBranchMutate({
          ...target,
          action: "delete",
          name: "review/unmerged",
          expectedHeadSha: originalHead,
          force: true,
        });
        expect(deleted).toMatchObject({
          success: true,
          error: null,
          newHeadSha: originalHead,
          backupRef: expect.stringMatching(/^refs\/paseo\/backup\/branch-del-/),
        });
        expect(git("for-each-ref", "--format=%(refname)", "refs/heads/review/unmerged")).toBe("");
        expect(git("rev-parse", "--verify", deleted.backupRef!)).toBe(onto);
        const page = await client.checkoutGitLogQuery(graphTarget);
        expect(page.error).toBeNull();
        expect(page.commits).toContainEqual(expect.objectContaining({ sha: originalHead }));
        expect(
          await client.checkoutGitCommitGetDetail({ ...target, sha: originalHead }),
        ).toMatchObject({
          error: null,
          detail: { subject: "Topic" },
        });
        const plan = await client.checkoutGitRebaseBuildPlan({
          ...target,
          ontoRef: "onto",
          dryRun: true,
        });
        expect(plan).toMatchObject({
          error: null,
          headSha: originalHead,
          ontoSha: onto,
          conflictPaths: [path],
        });
        return await client.checkoutGitRebaseExecute({
          ...target,
          ontoRef: onto,
          expectedHeadSha: originalHead,
          steps: [{ type: "pick", sha: originalHead }],
        });
      } finally {
        await Promise.allSettled([client.close()]);
        await firstDaemon.close();
      }
    })();
    expect(paused).toMatchObject({
      operationState: "rebase_paused",
      errorCode: "REBASE_CONFLICT_PAUSED",
      rebaseId: expect.any(String),
      backupRef: expect.stringMatching(/^refs\/paseo\/backup\/rebase-/),
    });

    const restarted = await createTestPaseoDaemon(daemonOptions);
    const reconnect = new DaemonClient({ url: `ws://127.0.0.1:${restarted.port}/ws` });
    try {
      await reconnect.connect();
      expect(await reconnect.checkoutGitWorkingTreeGet(target)).toMatchObject({
        error: null,
        workingTree: { operationState: "rebase_paused", rebaseId: paused.rebaseId },
      });
      expect(
        await reconnect.checkoutGitRefsList({ ...graphTarget, includeBackups: true }),
      ).toMatchObject({
        error: null,
        refs: [
          {
            localBranches: expect.arrayContaining([{ name: "review/base", sha: base }]),
            backups: expect.arrayContaining([{ name: paused.backupRef, sha: originalHead }]),
          },
        ],
      });
      const conflicts = await reconnect.checkoutGitConflictInspect({ ...target, path });
      expect(conflicts).toMatchObject({
        error: null,
        conflicts: [{ path, hunks: [{ base: "base\n", ours: "upstream\n", theirs: "topic\n" }] }],
      });
      expect(
        await reconnect.checkoutGitConflictResolve({
          ...target,
          path,
          strategy: "ours",
          expectedConflictFingerprint: "stale-snapshot",
        }),
      ).toMatchObject({ success: false, errorCode: "STALE_CONFLICT_SNAPSHOT" });
      expect(
        await reconnect.checkoutGitConflictResolve({
          ...target,
          path,
          strategy: "theirs",
          expectedConflictFingerprint: conflicts.conflicts[0]!.conflictFingerprint,
        }),
      ).toMatchObject({ success: true, error: null });
      const completed = await reconnect.checkoutGitRebaseAct({
        ...target,
        action: "continue",
        expectedRebaseId: paused.rebaseId!,
      });
      expect(completed).toMatchObject({
        success: true,
        rebaseId: paused.rebaseId,
        operationState: "idle",
        newHeadSha: expect.any(String),
      });
      expect(await reconnect.checkoutGitWorkingTreeGet(target)).toMatchObject({
        error: null,
        workingTree: {
          operationState: "idle",
          currentBranch: "main",
          headSha: completed.newHeadSha,
          rebaseId: paused.rebaseId,
        },
      });
      expect(
        await reconnect.checkoutGitRebaseAct({
          ...target,
          action: "undo",
          expectedRebaseId: paused.rebaseId!,
          backupRef: paused.backupRef,
        }),
      ).toMatchObject({ success: true, newHeadSha: originalHead, operationState: "idle" });
      expect(git("rev-parse", "HEAD")).toBe(originalHead);
      expect(git("status", "--porcelain")).toBe("");
    } finally {
      await Promise.allSettled([reconnect.close()]);
      await restarted.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

it("exposes blame and tag operations through the P2 SDK", async () => {
  const temp = await mkdtemp(join(tmpdir(), "paseo-p2-wire-"));
  try {
    const root = await realpath(temp);
    const remote = join(root, "remote.git");
    const repo = join(root, "worktree");
    await mkdir(repo);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "core.hooksPath=.git/test-disabled-hooks", ...args], {
        cwd,
        encoding: "utf8",
      });
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "config", "user.name", "Wire Author");
    git(repo, "config", "user.email", "wire-author@example.invalid");
    git(root, "init", "--bare", "--quiet", remote);
    git(repo, "remote", "add", "chosen", remote);
    const path = "story.txt";
    await writeFile(join(repo, path), "original\nsecond\n");
    git(repo, "add", "--", path);
    git(repo, "commit", "--quiet", "-m", "Write the story");
    const sha = git(repo, "rev-parse", "HEAD").trim();
    await writeFile(join(repo, path), "original\nrecent edit\n");
    const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
    const client = new DaemonClient({ url: "ws://127.0.0.1:" + daemon.port + "/ws" });
    try {
      await client.connect();
      expect(client.getLastServerInfoMessage()?.features?.checkoutGitP2V1).toBe(true);
      const target = { cwd: repo, targetRepoRoot: repo };
      expect(await client.checkoutGitBlameGet({ ...target, path })).toMatchObject({
        error: null,
        lines: [
          {
            lineNumber: 1,
            sha,
            authorName: "Wire Author",
            authorDate: expect.any(String),
            summary: "Write the story",
            lineText: "original",
          },
          { lineNumber: 2, sha: null, authorDate: null, lineText: "recent edit" },
        ],
      });
      const tag = { ...target, tagName: "reviewed", expectedHeadSha: sha };
      expect(await client.checkoutGitTagMutate({ ...tag, action: "create" })).toMatchObject({
        success: true,
      });
      expect(await client.checkoutGitRefsList({ cwd: repo, repoRoots: [repo] })).toMatchObject({
        error: null,
        refs: [
          {
            tags: [{ name: "reviewed", sha, objectSha: sha }],
            remotes: [{ name: "chosen", branches: [] }],
          },
        ],
      });
      git(repo, "tag", "-a", "-f", "-m", "Reviewed object", "reviewed", sha);
      const tagObject = git(repo, "rev-parse", "refs/tags/reviewed").trim();
      expect(tagObject).not.toBe(sha);
      expect(await client.checkoutGitRefsList({ cwd: repo, repoRoots: [repo] })).toMatchObject({
        refs: [{ tags: [{ name: "reviewed", sha, objectSha: tagObject }] }],
      });
      expect(
        await client.checkoutGitTagMutate({ ...tag, action: "delete", expectedTagSha: sha }),
      ).toMatchObject({ success: false });
      expect(
        await client.checkoutGitTagMutate({
          ...tag,
          action: "push",
          remote: "chosen",
          expectedTagSha: sha,
        }),
      ).toMatchObject({ success: false });
      expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe("");
      expect(
        await client.checkoutGitTagMutate({
          ...tag,
          action: "push",
          remote: "chosen",
          expectedTagSha: tagObject,
        }),
      ).toMatchObject({ success: true });
      expect(
        await client.checkoutGitTagMutate({ ...tag, action: "delete", expectedTagSha: tagObject }),
      ).toMatchObject({ success: true });
      expect(git(repo, "tag", "--list")).toBe("");
      expect(git(remote, "for-each-ref", "--format=%(refname) %(objectname)").trim()).toBe(
        "refs/tags/reviewed " + tagObject,
      );
    } finally {
      await client.close();
      await daemon.close();
    }
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
}, 30_000);
