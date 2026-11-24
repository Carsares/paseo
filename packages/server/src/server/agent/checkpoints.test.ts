import { execFileSync, spawnSync } from "node:child_process";
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { writePaseoWorktreeMetadata } from "../../utils/worktree-metadata.js";
import { CheckpointService, type CheckpointScope } from "./checkpoints/checkpoint-service.js";
import { gitBlobId, isSafeRelativeFile } from "./checkpoints/snapshot.js";
import { CheckpointStore, stableKey } from "./checkpoints/store.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

describe("private file checkpoints in a real linked worktree", () => {
  let tmp: string;
  let project: string;
  let worktree: string;
  let paseoHome: string;
  let scope: CheckpointScope;
  let service: CheckpointService;
  const turn = { timelineId: "timeline-a", turnId: "turn-a" };
  const message = {
    id: "message-a",
    text: "Change one file",
    clientMessageId: "client-a",
    authorId: "user-a",
  };
  const baseline = { timelineId: turn.timelineId, boundary: "baseline" } as const;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(await realpath(tmpdir()), "paseo-checkpoints-"));
    project = path.join(tmp, "project");
    paseoHome = path.join(tmp, "paseo");
    worktree = path.join(tmp, "managed");
    await Promise.all([mkdir(project), mkdir(paseoHome)]);
    git(project, "init", "-b", "main");
    git(project, "config", "user.email", "checkpoint-test@example.invalid");
    git(project, "config", "user.name", "Checkpoint Test");
    git(project, "config", "commit.gpgsign", "false");
    git(project, "config", "core.autocrlf", "false");
    await Promise.all([
      writeFile(path.join(project, "tracked.txt"), "committed\n"),
      writeFile(path.join(project, "removed.txt"), "keep\n"),
      writeFile(path.join(project, ".gitignore"), "ignored.txt\n"),
    ]);
    git(project, "add", ".");
    git(project, "commit", "-m", "initial");
    git(project, "worktree", "add", "-b", "managed", worktree);
    await writePaseoWorktreeMetadata(worktree, { baseRefName: "main" });
    service = new CheckpointService({ paseoHome });
    scope = {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      cwd: worktree,
      worktreeRoot: worktree,
      projectRoot: project,
      exclusive: true,
      isController: false,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  async function accept() {
    return service.acceptTurn({ scope, ...turn, message });
  }

  async function settle(outcome: "succeeded" | "failed" | "cancelled") {
    return service.settleTurn({ scope, ...turn, outcome, providerMessageId: "provider-a" });
  }

  test("freezes the first boundary, deduplicates turn events, and keeps failure and cancellation writes", async () => {
    const accepted = await accept();
    await writeFile(path.join(worktree, "tracked.txt"), "failed write\n");
    expect(await accept()).toEqual(accepted);
    const failed = await settle("failed");
    expect(failed?.settled?.outcome).toBe("failed");
    expect(failed?.settled?.after).toBeTruthy();
    expect(failed?.message).toEqual({ ...message, providerMessageId: "provider-a" });
    expect(await settle("succeeded")).toEqual(failed);

    const cancelledTurn = { ...turn, turnId: "turn-b" };
    await service.acceptTurn({
      scope,
      ...cancelledTurn,
      message: { id: "message-b", text: "Try again" },
    });
    await writeFile(path.join(worktree, "second.txt"), "cancelled write\n");
    const cancelled = await service.settleTurn({ scope, ...cancelledTurn, outcome: "cancelled" });
    expect(cancelled?.settled?.after).toBeTruthy();
    expect(await service.getCheckpointChanges({ scope, target: baseline })).toMatchObject({
      staged: [],
      unstaged: [],
    });
    expect(
      await service.getCheckpointChanges({
        scope,
        target: { ...cancelledTurn, boundary: "after" },
        from: baseline,
      }),
    ).toMatchObject({
      sinceReference: {
        files: [
          { path: "second.txt", kind: "added" },
          { path: "tracked.txt", kind: "modified" },
        ],
      },
    });
    const forkId = "fork";
    await service.forkTimeline({
      scope,
      timelineId: forkId,
      from: { ...cancelledTurn, boundary: "before" },
    });
    expect(
      (await service.getTimeline({ scope, timelineId: forkId }))?.turns.map((row) => row.turnId),
    ).toEqual(["turn-a"]);
    await service.forkTimeline({
      scope,
      timelineId: "nested-fork",
      from: { timelineId: forkId, turnId: turn.turnId, boundary: "after" },
    });
    expect(
      (await service.getTimeline({ scope, timelineId: "nested-fork" }))?.turns.map(
        (row) => row.turnId,
      ),
    ).toEqual(["turn-a"]);
  });

  test("restores staged and working bytes separately and retains a backup without writing Git objects", async () => {
    const staged = path.join(worktree, "tracked.txt");
    await writeFile(staged, "staged\n");
    git(worktree, "add", "tracked.txt");
    await writeFile(staged, "unstaged\n");
    await writeFile(path.join(worktree, "original.txt"), "original untracked\n");
    await accept();
    await writeFile(staged, "current\n");
    await unlink(path.join(worktree, "removed.txt"));
    await unlink(path.join(worktree, "original.txt"));
    await writeFile(path.join(worktree, "new.txt"), "new staged\n");
    await writeFile(path.join(worktree, "ignored.txt"), "ignored\n");
    git(worktree, "add", "-A");
    await settle("succeeded");
    expect(await service.getCheckpointChanges({ scope, target: baseline })).toMatchObject({
      staged: [{ path: "tracked.txt", kind: "modified" }],
      unstaged: [
        { path: "original.txt", kind: "added" },
        { path: "tracked.txt", kind: "modified" },
      ],
    });

    const head = git(worktree, "rev-parse", "HEAD");
    const branches = git(worktree, "for-each-ref", "refs/heads");
    const objects = git(worktree, "cat-file", "--batch-all-objects", "--batch-check");
    expect(objects).not.toContain(gitBlobId(Buffer.from("original untracked\n"), "sha1"));
    const preview = await service.preflightRestore({ scope, target: baseline });
    expect(preview.changes.files.map((row) => [row.path, row.kind])).toEqual([
      ["new.txt", "deleted"],
      ["original.txt", "added"],
      ["removed.txt", "added"],
      ["tracked.txt", "modified"],
    ]);
    const input = {
      scope,
      target: baseline,
      operationId: "restore-1",
      expectedCurrent: preview.expectedCurrent,
    };
    const result = await service.executeRestore(input);
    expect(result).toMatchObject({
      status: "applied",
      nextFile: 4,
      totalFiles: 4,
      indexApplied: true,
    });
    expect(await service.executeRestore(input)).toEqual(result);
    expect(git(worktree, "show", ":tracked.txt")).toBe("staged");
    expect(await readFile(staged, "utf8")).toBe("unstaged\n");
    expect(await readFile(path.join(worktree, "ignored.txt"), "utf8")).toBe("ignored\n");
    expect(await readFile(path.join(worktree, "removed.txt"), "utf8")).toBe("keep\n");
    await expect(readFile(path.join(worktree, "new.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(git(worktree, "rev-parse", "HEAD")).toBe(head);
    expect(git(worktree, "for-each-ref", "refs/heads")).toBe(branches);
    expect(git(worktree, "cat-file", "--batch-all-objects", "--batch-check")).toBe(objects);
    expect(
      await service.getCheckpointChanges({ scope, target: { backupOf: result.operationId } }),
    ).toMatchObject({
      staged: [
        { path: "new.txt", kind: "added" },
        { path: "removed.txt", kind: "deleted" },
        { path: "tracked.txt", kind: "modified" },
      ],
    });
  });

  test("rejects stale previews and external commits", async () => {
    await accept();
    await writeFile(path.join(worktree, "tracked.txt"), "turn output\n");
    await settle("succeeded");
    const preview = await service.preflightRestore({ scope, target: baseline });
    await writeFile(path.join(worktree, "tracked.txt"), "external write\n");
    await expect(
      service.executeRestore({
        scope,
        target: baseline,
        operationId: "stale",
        expectedCurrent: preview.expectedCurrent,
      }),
    ).rejects.toThrow("preflight is stale");
    git(worktree, "add", "tracked.txt");
    git(worktree, "commit", "-m", "external");
    await expect(service.preflightRestore({ scope, target: baseline })).rejects.toThrow(
      "Git HEAD or branch changed",
    );
    expect(await service.listRestoreOperations(scope)).toEqual([]);
  });

  test("rejects shared, controller, remapped and unmarked checkout identities", async () => {
    expect(await service.eligibility(scope)).toMatchObject({ allowed: true });
    for (const invalid of [
      { ...scope, exclusive: false },
      { ...scope, isController: true },
      { ...scope, cwd: project, worktreeRoot: project },
      { ...scope, cwd: worktree + "/../managed" },
    ]) {
      expect(await service.eligibility(invalid)).toMatchObject({ allowed: false });
    }

    const alias = path.join(tmp, "alias");
    await symlink(worktree, alias);
    expect(await service.eligibility({ ...scope, cwd: alias, worktreeRoot: alias })).toMatchObject({
      allowed: false,
    });
    const fake = path.join(paseoHome, "worktrees", "looks-owned", "managed");
    await mkdir(path.dirname(fake), { recursive: true });
    git(project, "worktree", "add", "--detach", fake);
    expect(await service.eligibility({ ...scope, cwd: fake, worktreeRoot: fake })).toMatchObject({
      allowed: false,
    });
    await writePaseoWorktreeMetadata(fake, { baseRefName: "main" });
    const counterfeit = path.join(tmp, "other-parent", "managed");
    await mkdir(counterfeit, { recursive: true });
    await writeFile(path.join(counterfeit, ".git"), await readFile(path.join(fake, ".git")));
    expect(
      await service.eligibility({ ...scope, cwd: counterfeit, worktreeRoot: counterfeit }),
    ).toMatchObject({ allowed: false });
  });

  test("refuses unsafe files and records when a settled boundary could not be captured", async () => {
    expect(
      ["../tracked", ".git/index", "folder/../tracked", "folder\\escape", "drive:/file"].map(
        isSafeRelativeFile,
      ),
    ).toEqual([false, false, false, false, false]);
    await accept();
    const outside = path.join(tmp, "outside.txt");
    await writeFile(outside, "stay outside\n");
    await unlink(path.join(worktree, "tracked.txt"));
    await symlink(outside, path.join(worktree, "tracked.txt"));
    expect((await settle("cancelled"))?.settled).toMatchObject({
      outcome: "cancelled",
      after: null,
      captureError: expect.stringContaining("symbolic links"),
    });
    await expect(service.preflightRestore({ scope, target: baseline })).rejects.toThrow(
      "symbolic links",
    );
    expect(await readFile(outside, "utf8")).toBe("stay outside\n");
  });

  test("rejects nested repositories, filters and sparse checkouts", async () => {
    const nested = path.join(worktree, "nested");
    await mkdir(nested);
    git(nested, "init");
    await writeFile(path.join(nested, "untracked.txt"), "inside nested git");
    await expect(accept()).rejects.toThrow();
    await rm(nested, { recursive: true });
    await writeFile(path.join(worktree, ".gitattributes"), "tracked.txt filter=example\n");
    await expect(accept()).rejects.toThrow("Git content filters");
    await unlink(path.join(worktree, ".gitattributes"));
    git(worktree, "config", "core.sparseCheckout", "true");
    await expect(accept()).rejects.toThrow("Sparse");
  });

  test("rejects submodule entries before capturing any boundary", async () => {
    const head = git(worktree, "rev-parse", "HEAD");
    git(worktree, "update-index", "--add", "--cacheinfo", `160000,${head},submodule`);
    await expect(accept()).rejects.toThrow("submodule");
    expect(await service.getTimeline({ scope, timelineId: turn.timelineId })).toBeNull();
  });

  test("recovers an interrupted turn and restores across file and directory replacements", async () => {
    await writeFile(path.join(worktree, "shape"), "original file");
    await accept();
    await unlink(path.join(worktree, "shape"));
    await mkdir(path.join(worktree, "shape", "deeper"), { recursive: true });
    await writeFile(path.join(worktree, "shape", "deeper", "file"), "replacement directory");

    const restarted = new CheckpointService({ paseoHome });
    expect(await restarted.listPendingTurns(scope)).toMatchObject([{ ...turn, settled: null }]);
    expect(
      (await restarted.settleTurn({ scope, ...turn, outcome: "interrupted" }))?.settled,
    ).toMatchObject({ outcome: "interrupted", after: expect.any(String) });
    expect(await restarted.listPendingTurns(scope)).toEqual([]);
    const preview = await restarted.preflightRestore({ scope, target: baseline });
    const result = await restarted.executeRestore({
      scope,
      target: baseline,
      operationId: "replace-directory",
      expectedCurrent: preview.expectedCurrent,
    });
    expect(result).toMatchObject({ status: "applied" });
    expect(await readFile(path.join(worktree, "shape"), "utf8")).toBe("original file");
  });

  test("holds Git staging locked during file restore and refuses an unrelated worktree write", async () => {
    await accept();
    await writeFile(path.join(worktree, "tracked.txt"), "new staged content\n");
    git(worktree, "add", "tracked.txt");
    await settle("succeeded");
    const preview = await service.preflightRestore({ scope, target: baseline });
    const originalSave = CheckpointStore.prototype.save;
    let triedGit = false;
    vi.spyOn(CheckpointStore.prototype, "save").mockImplementation(
      async function (this: CheckpointStore, state) {
        if (!triedGit && state.operations[0]?.nextFile === 1) {
          triedGit = true;
          const external = spawnSync("git", ["add", "tracked.txt"], {
            cwd: worktree,
            encoding: "utf8",
          });
          expect(external.status).not.toBe(0);
          expect(external.stderr).toMatch(/index\.lock/u);
          await writeFile(path.join(worktree, "removed.txt"), "external content\n");
        }
        return originalSave.call(this, state);
      },
    );
    const result = await service.executeRestore({
      scope,
      target: baseline,
      operationId: "with-concurrent-writer",
      expectedCurrent: preview.expectedCurrent,
    });
    expect(triedGit).toBe(true);
    expect(result).toMatchObject({
      status: "retryable",
      lastError: "Worktree changed before staging could be restored",
    });
    expect(git(worktree, "show", ":tracked.txt")).toBe("new staged content");
    expect(await readFile(path.join(worktree, "removed.txt"), "utf8")).toBe("external content\n");
  });

  test("retries from the journal after losing the process between a write and its progress record", async () => {
    await accept();
    for (const name of ["a.txt", "z.txt"])
      await writeFile(path.join(worktree, name), "temporary edit");
    await settle("succeeded");
    const preview = await service.preflightRestore({ scope, target: baseline });
    const originalSave = CheckpointStore.prototype.save;
    vi.spyOn(CheckpointStore.prototype, "save").mockImplementation(
      function (this: CheckpointStore, state) {
        if (state.operations[0]?.nextFile === 1) throw new Error("process stopped");
        return originalSave.call(this, state);
      },
    );
    await expect(
      service.executeRestore({
        scope,
        target: baseline,
        operationId: "restore-after-crash",
        expectedCurrent: preview.expectedCurrent,
      }),
    ).rejects.toThrow("process stopped");
    vi.restoreAllMocks();
    await expect(readFile(path.join(worktree, "z.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(worktree, "a.txt"), "utf8")).toBe("temporary edit");

    const restarted = new CheckpointService({ paseoHome });
    const operationId = "restore-after-crash";
    expect(await restarted.getRestoreOperation({ scope, operationId })).toMatchObject({
      status: "applying",
      nextFile: 0,
    });
    const admin = git(worktree, "rev-parse", "--absolute-git-dir");
    const lock = path.join(admin, "index.lock");
    await writeFile(lock, "another Git writer");
    expect(await restarted.retryRestore({ scope, operationId })).toMatchObject({
      status: "retryable",
    });
    expect(await readFile(lock, "utf8")).toBe("another Git writer");
    await unlink(lock);

    const owner = path.join(admin, `paseo-index-lock-${stableKey(operationId)}`);
    await writeFile(owner, "", { mode: 0o600 });
    await link(owner, lock);
    expect(await restarted.retryRestore({ scope, operationId })).toMatchObject({
      status: "applied",
      nextFile: 2,
    });
    await expect(readFile(path.join(worktree, "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(lock)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(owner)).rejects.toMatchObject({ code: "ENOENT" });
    const statePath = path.join(
      paseoHome,
      "file-checkpoints",
      stableKey(scope.workspaceId),
      "state.json",
    );
    expect(await readFile(statePath, "utf8")).toContain("restore-after-crash");
  });
});
