import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createDaemonTestContext } from "../test-utils/index.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const fakeGh = `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("gh version 2.99.0");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "token") {
  console.log("fake-viewer-credential");
  process.exit(0);
}
if (argv[0] !== "api") process.exit(1);
const base = ${JSON.stringify(baseSha)};
const head = ${JSON.stringify(headSha)};
const persisted = process.env.PASEO_TEST_REVIEW_STATE;
const state = JSON.parse(fs.readFileSync(persisted));
const has = (value) => argv.includes(value);
const save = () => fs.writeFileSync(persisted, JSON.stringify(state));
let response;
if (has("repos/test-org/review-check/pulls/9")) {
  response = {
    id: 159, number: 9, changed_files: 1,
    base: { sha: base, repo: { full_name: "test-org/review-check" } },
    head: { sha: head },
  };
} else if (has("repos/test-org/review-check/compare/" + base + "..." + head + "?per_page=1&page=1")) {
  response = { base_commit: { sha: base }, merge_base_commit: { sha: "d".repeat(40) }, files: [{
    filename: "src/change.ts",
    patch: "@@ -1 +1 @@\\n-const before = 1;\\n+const after = 2;",
    additions: 1, deletions: 1,
  }] };
} else if (has("repos/test-org/review-check/pulls/9/comments") && has("POST")) {
  if (!has("commit_id=" + head) || !has("line=1") || !has("path=src/change.ts") ||
      !has("side=RIGHT") || !has("body=Check the renamed constant.")) process.exit(2);
  state.postCount++;
  save();
  response = { id: 722 };
} else if (has("repos/test-org/review-check/pulls/comments/722") && state.postCount > 0) {
  response = { id: 722, path: "src/change.ts", original_commit_id: head, original_line: 1, side: "RIGHT", pull_request_url: "https://api.github.com/repos/test-org/review-check/pulls/9" };
} else if (has("graphql")) {
  const query = argv.find((value) => value.startsWith("query="));
  if (query?.includes("mutation {")) {
    const mutation = query.includes("unmarkFileAsViewed") ? "unmarkFileAsViewed" : "markFileAsViewed";
    if (!query.includes("src/change.ts") || !query.includes("pr-node") ||
        process.env.GH_TOKEN !== "fake-viewer-credential") process.exit(2);
    state.viewed = mutation === "markFileAsViewed";
    save();
    response = { data: { [mutation]: { clientMutationId: null } } };
  } else if (query?.includes("viewer { id }")) {
    response = { data: {
      viewer: { id: "viewer-node" },
      repository: { pullRequest: { id: "pr-node", baseRefOid: base, headRefOid: head,
        files: { totalCount: 1, nodes: [{ path: "src/change.ts", viewerViewedState: state.viewed ? "VIEWED" : "UNVIEWED" }],
          pageInfo: { hasNextPage: false, endCursor: null } }
      } }
    } };
  }
}
if (!response) process.exit(1);
console.log("HTTP/2 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n" + JSON.stringify(response));
`;

test("review requests use hosted line positions and confirm GitHub comment and viewed writes", async () => {
  const isolated = await mkdtemp(join(tmpdir(), "paseo-review-"));
  try {
    const cwd = join(isolated, "checkout");
    const bin = join(isolated, "bin");
    const state = join(isolated, "state.json");
    await mkdir(cwd);
    await mkdir(bin);
    await writeFile(join(bin, "gh"), fakeGh, { mode: 0o700 });
    await writeFile(state, JSON.stringify({ postCount: 0, viewed: false }));
    execFileSync("git", ["init", "-q", "--template="], { cwd });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/test-org/review-check.git"],
      {
        cwd,
      },
    );
    await writeFile(join(cwd, "local-only.ts"), "this file is not part of the hosted review");
    vi.stubEnv("PATH", [bin, process.env.PATH].join(process.platform === "win32" ? ";" : ":"));
    vi.stubEnv("PASEO_TEST_REVIEW_STATE", state);
    const ctx = await createDaemonTestContext({ mcpEnabled: false, agentClients: {} });
    try {
      expect(ctx.client.getLastServerInfoMessage()?.features?.forgeReviewGuide).toBe(true);
      const identity = {
        forge: "github",
        host: "github.com",
        projectPath: "test-org/review-check",
        number: 9,
      };
      const version = { baseSha, headSha };
      const target = { cwd, identity };
      const guide = await ctx.client.checkoutForgeGetReviewGuide({
        ...target,
        expectedVersion: version,
      });
      expect(guide.error).toBeNull();
      expect(guide.guide?.version).toEqual(version);
      expect(guide.guide?.diffBaseSha).toBe("d".repeat(40));
      expect(guide.guide?.stops).toMatchObject([{ path: "src/change.ts", line: { newLine: 1 } }]);
      const stop = guide.guide?.stops[0];
      if (!stop) throw new Error("No review stop");

      const draft = {
        ...target,
        version,
        stopId: stop.id,
        body: "Check the renamed constant.",
        operationId: "review-1",
      };
      const reader = new DaemonClient({
        url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
        sessionPermissions: ["daemon.read", "workspace.read"],
        reconnect: { enabled: false },
      });
      try {
        await reader.connect();
        expect(await reader.checkoutForgeGetReviewGuide(target)).toMatchObject({
          guide: { version },
          error: null,
        });
        await expect(reader.checkoutForgePublishReviewComment(draft)).rejects.toMatchObject({
          code: "access_denied",
        });
        await expect(
          reader.checkoutForgeSetReviewViewed({
            ...target,
            version,
            path: stop.path,
            viewed: true,
          }),
        ).rejects.toMatchObject({ code: "access_denied" });
        expect(JSON.parse(await readFile(state, "utf8"))).toEqual({ postCount: 0, viewed: false });
      } finally {
        await reader.close();
      }

      expect(
        await ctx.client.checkoutForgePublishReviewComment({
          ...draft,
          version: { ...version, headSha: "c".repeat(40) },
        }),
      ).toMatchObject({
        error: { code: "stale" },
      });
      expect(await ctx.client.checkoutForgePublishReviewComment(draft)).toMatchObject({
        comment: { id: "722" },
        error: null,
      });
      expect(await ctx.client.checkoutForgePublishReviewComment(draft)).toMatchObject({
        comment: { id: "722" },
        error: null,
      });

      const viewed = { ...target, version, path: stop.path, expectedViewerId: "viewer-node" };
      expect(await ctx.client.checkoutForgeGetReviewViewed({ ...target, version })).toMatchObject({
        viewed: { viewerId: "viewer-node", entries: [{ path: stop.path, state: "unviewed" }] },
        error: null,
      });
      expect(
        await ctx.client.checkoutForgeSetReviewViewed({ ...viewed, viewed: true }),
      ).toMatchObject({
        entry: { state: "viewed" },
        error: null,
      });
      expect(
        await ctx.client.checkoutForgeSetReviewViewed({ ...viewed, viewed: false }),
      ).toMatchObject({
        entry: { state: "unviewed" },
        error: null,
      });
      expect(JSON.parse(await readFile(state, "utf8"))).toEqual({ postCount: 1, viewed: false });
      expect(await readFile(join(cwd, "local-only.ts"), "utf8")).toBe(
        "this file is not part of the hosted review",
      );
    } finally {
      await ctx.cleanup();
    }
  } finally {
    vi.unstubAllEnvs();
    await rm(isolated, { force: true, recursive: true });
  }
}, 30_000);
