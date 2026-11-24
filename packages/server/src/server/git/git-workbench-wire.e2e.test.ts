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
          requestId: `paseo-git-commit:${after.requestId}:${randomUUID()}`,
        });
        expect(stale).toMatchObject({ success: false, errorCode: "STALE_HEAD_CONFLICT" });
        const latest = await client.checkoutGitWorkingTreeGet(target);
        expect(latest.workingTree).toMatchObject({
          headSha: null,
          staged: paths.map((path) => ({ path, status: "added" })),
          untracked: [],
        });
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
