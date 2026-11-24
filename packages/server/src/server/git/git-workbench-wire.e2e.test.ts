import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
