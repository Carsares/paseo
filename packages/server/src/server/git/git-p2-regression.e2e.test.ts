import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffCompare, DiffState } from "@getpaseo/client";
import { expect, it } from "vitest";

import { buildLinePatch } from "../../../../app/src/git/staging/line-patch.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function configureTestRepo(cwd: string) {
  git(cwd, "config", "user.name", "Paseo Git P2 Test");
  git(cwd, "config", "user.email", "git-p2-test@example.invalid");
  git(cwd, "config", "core.hooksPath", ".git/test-disabled-hooks");
  git(cwd, "config", "commit.gpgSign", "false");
  git(cwd, "config", "core.autocrlf", "false");
}

async function withTestRepo(
  exercise: (repoRoot: string, temporaryRoot: string) => Promise<void>,
): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "paseo-git-p2-"));
  try {
    const repoRoot = join(await realpath(temporaryRoot), "repo");
    await mkdir(repoRoot);
    git(repoRoot, "init", "--quiet", "--initial-branch=review");
    configureTestRepo(repoRoot);
    await exercise(repoRoot, await realpath(temporaryRoot));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function withClient(
  repoRoot: string,
  exercise: (client: DaemonClient) => Promise<void>,
): Promise<void> {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false, relayEnabled: false });
  try {
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    try {
      await client.connect();
      expect(
        (await client.createWorkspace({ source: { kind: "directory", path: repoRoot } })).error,
      ).toBeNull();
      await exercise(client);
      expect(client.getLastServerInfoMessage()?.features?.checkoutGitP2V1).toBe(true);
    } finally {
      await client.close();
    }
  } finally {
    await daemon.close();
  }
}

const filePath = "items.txt";
const patchHeader = [
  `diff --git a/${filePath} b/${filePath}`,
  `--- a/${filePath}`,
  `+++ b/${filePath}`,
];
const fixtureLines = [
  "prefix A",
  "prefix B",
  "before the edit",
  "item A",
  "item B",
  "item C",
  "item D",
  "item E",
  "item F",
  "after the edit",
  "suffix A",
  "suffix B",
];

function fileText(edits: readonly string[]): string {
  return (
    fixtureLines.map((line) => (edits.includes(line) ? `${line} updated` : line)).join("\n") + "\n"
  );
}

it("stages two nonadjacent lines in one six-line hunk and unstages one without moving any edit", async () => {
  await withTestRepo(async (repoRoot) => {
    const path = join(repoRoot, filePath);
    await writeFile(path, fileText([]));
    git(repoRoot, "add", "--", filePath);
    git(repoRoot, "commit", "--quiet", "-m", "Seed file");
    const head = git(repoRoot, "rev-parse", "HEAD").trim();
    const editedText = fileText(["item A", "item B", "item C", "item D", "item E", "item F"]);
    await writeFile(path, editedText);
    const sourceDiff = git(
      repoRoot,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "-U1",
      "--",
      filePath,
    );
    expect(sourceDiff.match(/^@@ .* @@/gm)).toEqual(["@@ -3,8 +3,8 @@"]);

    const selection = {
      cwd: repoRoot,
      targetRepoRoot: repoRoot,
      scope: "lines",
      expectedHeadSha: head,
    } as const;
    const selectedPatch = [
      ...patchHeader,
      "@@ -3,8 +3,8 @@",
      " before the edit",
      " item A",
      "-item B",
      "+item B updated",
      " item C",
      " item D",
      "-item E",
      "+item E updated",
      " item F",
      " after the edit",
      "",
    ].join("\n");
    const oneLinePatch = selectedPatch.replace("-item E\n+item E updated\n", " item E updated\n");

    await withClient(repoRoot, async (client) => {
      const invalidPatches = [
        selectedPatch.replace("@@ -3,8 +3,8 @@", "@@ -4,8 +4,8 @@"),
        selectedPatch.replace("+item E updated", "+item E never entered in the worktree"),
      ];
      for (const patch of invalidPatches) {
        expect(await client.checkoutGitStageApply({ ...selection, patch })).toMatchObject({
          success: false,
          errorCode: "PATCH_APPLY_REJECTED",
        });
        expect(git(repoRoot, "show", `:${filePath}`)).toEqual(fileText([]));
        expect(await readFile(path, "utf8")).toEqual(editedText);
      }

      expect(
        await client.checkoutGitStageApply({ ...selection, patch: selectedPatch }),
      ).toMatchObject({
        success: true,
        error: null,
      });
      expect(git(repoRoot, "show", `:${filePath}`)).toEqual(fileText(["item B", "item E"]));
      expect(await readFile(path, "utf8")).toEqual(editedText);

      expect(
        await client.checkoutGitUnstageApply({ ...selection, patch: oneLinePatch }),
      ).toMatchObject({
        success: true,
        error: null,
      });
      expect(git(repoRoot, "show", `:${filePath}`)).toEqual(fileText(["item E"]));
      expect(await readFile(path, "utf8")).toEqual(editedText);
      expect(git(repoRoot, "rev-parse", "HEAD").trim()).toBe(head);
    });
  });
}, 30_000);

const eofMarker = "\\ No newline at end of file";

async function readStreamedFile(client: DaemonClient, compare: DiffCompare) {
  const observation = client.observeDiff(compare);
  const states: DiffState[] = [];
  const unsubscribe = observation.subscribe({
    snapshot: (state) => states.push(state),
    update: () => {},
  });
  try {
    await expect
      .poll(() => states.some((state) => state.phase !== "loading"), {
        timeout: 10_000,
      })
      .toBe(true);
    const state = states.find((item) => item.phase !== "loading");
    if (state?.phase !== "ready") {
      throw new Error(`Expected a ready diff: ${state?.error.message ?? "no result"}`);
    }
    expect(state.diffTooLarge).toBe(false);
    expect(state.files.map((file) => file.path)).toEqual([filePath]);
    const file = state.files[0]!;
    expect(file.hunks).toHaveLength(1);
    return file;
  } finally {
    unsubscribe();
    await observation.release();
  }
}

async function selectedEofPatch(
  client: DaemonClient,
  compare: DiffCompare,
  layer: "staged" | "unstaged",
  markerSides: readonly string[],
): Promise<string> {
  const file = await readStreamedFile(client, compare);
  const { lines } = file.hunks[0]!;
  const markers = lines.flatMap((line, index) =>
    line.type === "header" && line.content === eofMarker ? [lines[index - 1]?.type] : [],
  );
  expect(markers).toEqual(markerSides);
  const changedRows = lines.flatMap((line, index) =>
    line.type === "remove" || line.type === "add" ? [index] : [],
  );
  expect(changedRows.map((index) => lines[index]!.type)).toEqual(["remove", "add"]);
  const patch = buildLinePatch(file, 0, new Set(changedRows), layer);
  if (patch === null) throw new Error(`The frontend could not build the ${layer} EOF patch`);
  return patch;
}

function selectRows(
  file: Awaited<ReturnType<typeof readStreamedFile>>,
  changes: readonly { type: "remove" | "add"; content: string }[],
) {
  const rows = file.hunks[0]!.lines;
  return new Set(
    changes.map(({ type, content }) => {
      const index = rows.findIndex((row) => row.type === type && row.content === content);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    }),
  );
}

it("preserves positions when partly staging and unstaging unequal replacement groups", async () => {
  await withTestRepo(async (repoRoot) => {
    const path = join(repoRoot, filePath);
    const original = "A\nB\nC\n";
    const edited = "a\nb\n";
    await writeFile(path, original);
    git(repoRoot, "add", "--", filePath);
    git(repoRoot, "commit", "--quiet", "-m", "Seed uneven replacement");
    const head = git(repoRoot, "rev-parse", "HEAD").trim();
    await writeFile(path, edited);
    const selection = {
      cwd: repoRoot,
      targetRepoRoot: repoRoot,
      scope: "lines" as const,
      paths: [filePath],
      expectedHeadSha: head,
    };

    await withClient(repoRoot, async (client) => {
      const unstaged = await readStreamedFile(client, {
        cwd: repoRoot,
        base: { kind: "index" },
        head: { kind: "worktree" },
      });
      const stageRows = selectRows(unstaged, [
        { type: "remove", content: "A" },
        { type: "add", content: "a" },
      ]);
      const stagePatch = buildLinePatch(unstaged, 0, stageRows, "unstaged")!;
      expect(stagePatch).toContain("-A\n+a\n");
      expect(
        await client.checkoutGitStageApply({
          ...selection,
          patch: stagePatch.replace("+a\n", "+b\n"),
        }),
      ).toMatchObject({ success: false, errorCode: "PATCH_APPLY_REJECTED" });
      expect(git(repoRoot, "show", `:${filePath}`)).toBe(original);
      expect(await client.checkoutGitStageApply({ ...selection, patch: stagePatch })).toMatchObject(
        { success: true, error: null },
      );
      expect(git(repoRoot, "show", `:${filePath}`)).toBe("a\nB\nC\n");

      git(repoRoot, "add", "--", filePath);
      const staged = await readStreamedFile(client, {
        cwd: repoRoot,
        base: { kind: "rev", rev: head },
        head: { kind: "index" },
      });
      const tail = selectRows(staged, [{ type: "remove", content: "C" }]);
      const unstagePatch = buildLinePatch(staged, 0, tail, "staged")!;
      expect(unstagePatch).toContain("-C\n");
      expect(
        await client.checkoutGitUnstageApply({
          ...selection,
          patch: unstagePatch,
        }),
      ).toMatchObject({ success: true, error: null });
      expect(git(repoRoot, "show", `:${filePath}`)).toBe("a\nb\nC\n");
      expect(await readFile(path, "utf8")).toBe(edited);
    });
  });
}, 30_000);

it.each([
  {
    name: "edits the last line without a newline on either side",
    before: "context\ncafé before",
    after: "context\ncafé after",
    markerSides: ["remove", "add"],
  },
  {
    name: "only adds the last newline",
    before: "context\nlast line",
    after: "context\nlast line\n",
    markerSides: ["remove"],
  },
  {
    name: "only removes the last newline",
    before: "context\nlast line\n",
    after: "context\nlast line",
    markerSides: ["add"],
  },
])(
  "stages and unstages through the streamed diff when the edit $name",
  async ({ before, after, markerSides }) => {
    await withTestRepo(async (repoRoot) => {
      const path = join(repoRoot, filePath);
      const original = Buffer.from(before);
      const edited = Buffer.from(after);
      await writeFile(path, original);
      git(repoRoot, "add", "--", filePath);
      git(repoRoot, "commit", "--quiet", "-m", "Seed EOF fixture");
      const head = git(repoRoot, "rev-parse", "HEAD").trim();
      await writeFile(path, edited);
      const stagedBytes = () => execFileSync("git", ["show", `:${filePath}`], { cwd: repoRoot });
      const selection = {
        cwd: repoRoot,
        targetRepoRoot: repoRoot,
        scope: "lines" as const,
        paths: [filePath],
        expectedHeadSha: head,
      };

      await withClient(repoRoot, async (client) => {
        expect(client.getLastServerInfoMessage()?.features?.diffSubscription).toBe(true);
        const stagePatch = await selectedEofPatch(
          client,
          { cwd: repoRoot, base: { kind: "index" }, head: { kind: "worktree" } },
          "unstaged",
          markerSides,
        );
        expect(
          await client.checkoutGitStageApply({ ...selection, patch: stagePatch }),
        ).toMatchObject({ success: true, error: null });
        expect(stagedBytes()).toEqual(edited);
        expect(await readFile(path)).toEqual(edited);

        const unstagePatch = await selectedEofPatch(
          client,
          { cwd: repoRoot, base: { kind: "rev", rev: head }, head: { kind: "index" } },
          "staged",
          markerSides,
        );
        expect(
          await client.checkoutGitUnstageApply({ ...selection, patch: unstagePatch }),
        ).toMatchObject({ success: true, error: null });
        expect(stagedBytes()).toEqual(original);
        expect(await readFile(path)).toEqual(edited);
      });
    });
  },
  30_000,
);

it("requires a new force push confirmation after the remote advances and the caller fetches", async () => {
  await withTestRepo(async (repoRoot, temporaryRoot) => {
    const bare = join(temporaryRoot, "remote.git");
    const peer = join(temporaryRoot, "peer");
    const branch = "review";
    const branchRef = `refs/heads/${branch}`;
    const trackingRef = "refs/remotes/origin/review";
    const remoteHead = () => git(bare, "rev-parse", "--verify", branchRef).trim();

    git(temporaryRoot, "init", "--bare", "--quiet", "--initial-branch=review", bare);
    await writeFile(join(repoRoot, "notes.txt"), "shared base\n");
    git(repoRoot, "add", "--", "notes.txt");
    git(repoRoot, "commit", "--quiet", "-m", "Shared base");
    const base = git(repoRoot, "rev-parse", "HEAD").trim();
    git(repoRoot, "remote", "add", "origin", bare);
    expect(git(repoRoot, "remote", "get-url", "origin").trim()).toBe(bare);
    expect(git(repoRoot, "remote", "get-url", "--push", "origin").trim()).toBe(bare);
    git(repoRoot, "push", "--quiet", "--set-upstream", "origin", branchRef);
    git(temporaryRoot, "clone", "--quiet", bare, peer);
    configureTestRepo(peer);
    expect(git(peer, "remote", "get-url", "--push", "origin").trim()).toBe(bare);

    await writeFile(join(repoRoot, "notes.txt"), "local edit\n");
    git(repoRoot, "commit", "--quiet", "-am", "Local edit");
    const localHead = git(repoRoot, "rev-parse", "HEAD").trim();

    await withClient(repoRoot, async (client) => {
      const prepareInput = {
        cwd: repoRoot,
        targetRepoRoot: repoRoot,
        expectedHeadSha: localHead,
      };
      async function prepareForReview(remoteSha: string) {
        const response = await client.checkoutGitPushPrepare(prepareInput);
        expect(response.error).toBeNull();
        if (!response.target) throw new Error("Force push preparation returned no target");
        const { token, ...target } = response.target;
        expect(target).toEqual({ branch, remote: "origin", remoteRef: branchRef, remoteSha });
        expect(token.length).toBeGreaterThan(0);
        return {
          ...prepareInput,
          confirmation: `force-push ${target.branch}`,
          expectedPushToken: token,
        };
      }

      expect(git(repoRoot, "rev-parse", "--symbolic-full-name", "@{upstream}").trim()).toBe(
        trackingRef,
      );
      expect(git(repoRoot, "rev-parse", "--verify", trackingRef).trim()).toBe(base);
      expect(remoteHead()).toBe(base);
      const originalConfirmation = await prepareForReview(base);

      await writeFile(join(peer, "notes.txt"), "remote edit\n");
      git(peer, "commit", "--quiet", "-am", "Remote edit");
      git(peer, "push", "--quiet", "origin", branchRef);
      const concurrentHead = git(peer, "rev-parse", "HEAD").trim();
      expect(remoteHead()).toBe(concurrentHead);
      expect(git(repoRoot, "rev-parse", "--verify", trackingRef).trim()).toBe(base);

      expect(await client.checkoutGitPushForce(originalConfirmation)).toMatchObject({
        success: false,
        errorCode: "STALE_REMOTE_BASELINE",
      });
      expect(remoteHead()).toBe(concurrentHead);

      git(repoRoot, "fetch", "--quiet", "origin");
      expect(git(repoRoot, "rev-parse", "--verify", trackingRef).trim()).toBe(concurrentHead);
      expect(
        git(repoRoot, "rev-list", "--left-right", "--count", `HEAD...${trackingRef}`).trim(),
      ).toBe("1\t1");
      expect(await client.checkoutGitPushForce(originalConfirmation)).toMatchObject({
        success: false,
        errorCode: "STALE_REMOTE_BASELINE",
      });
      expect(remoteHead()).toBe(concurrentHead);

      const freshConfirmation = await prepareForReview(concurrentHead);
      expect(freshConfirmation.expectedPushToken === originalConfirmation.expectedPushToken).toBe(
        false,
      );
      expect(
        await client.checkoutGitPushForce({
          ...prepareInput,
          confirmation: freshConfirmation.confirmation,
        }),
      ).toMatchObject({ success: false });
      expect(remoteHead()).toBe(concurrentHead);

      expect(await client.checkoutGitPushForce(freshConfirmation)).toMatchObject({
        success: true,
        error: null,
      });
      expect(remoteHead()).toBe(localHead);
    });
  });
}, 30_000);
