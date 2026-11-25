import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { createBrowserReviewViewed, createLocalReviewViewed } from "./local-viewed";
import { reviewIdentityKey, type ReviewIdentity } from "./port";

const review: ReviewIdentity = {
  forge: "github",
  host: "github.com",
  projectPath: "abc/repo",
  number: 27,
};
const anotherRepo = { ...review, projectPath: "abc/other" };
const anotherHost = { ...review, host: "github.acme.test" };
const anotherPr = { ...review, number: 28 };
const path = "src/changed.ts";

describe("device-local review progress", () => {
  it("persists the current head, clears the old head, and isolates repositories and hosts", async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => data.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        data.set(key, value);
      },
    };
    const signal = new AbortController().signal;
    const first = createLocalReviewViewed(storage);

    const confirm = async (identity: ReviewIdentity, sha: string) =>
      first.confirmHead(await first.begin(identity), sha, signal);
    const old = await confirm(review, "head1");
    await first.set(old.head, path, true);
    const repo = await confirm(anotherRepo, "head1");
    await first.set(repo.head, path, true);
    expect((await confirm(anotherHost, "head1")).viewed).toEqual({ entries: [] });
    expect((await confirm(anotherPr, "head1")).viewed).toEqual({ entries: [] });

    const reopened = createLocalReviewViewed(storage);
    expect(
      (await reopened.confirmHead(await reopened.begin(review), "head1", signal)).viewed,
    ).toEqual({
      entries: [{ path, state: "viewed" }],
    });
    const delayed = await reopened.begin(review);
    const current = await confirm(review, "head2");
    expect(current.viewed).toEqual({ entries: [] });
    const newPath = "src/new-head.ts";
    await first.set(current.head, newPath, true);
    await expect(reopened.confirmHead(delayed, "head1", signal)).rejects.toMatchObject({
      code: "stale",
    });
    await expect(reopened.set(old.head, path, true)).rejects.toMatchObject({
      code: "stale",
    });
    expect(await reopened.load(repo.head, signal)).toEqual({
      entries: [{ path, state: "viewed" }],
    });
    await expect(first.load(old.head, signal)).rejects.toMatchObject({ code: "stale" });
    await expect(first.set(old.head, path, true)).rejects.toMatchObject({ code: "stale" });
    expect(await reopened.load(current.head, signal)).toEqual({
      entries: [{ path: newPath, state: "viewed" }],
    });
    const returned = await confirm(review, "head1");
    expect(returned.viewed).toEqual({ entries: [] });
    await expect(first.set(old.head, "stale.ts", true)).rejects.toMatchObject({ code: "stale" });
    await first.set(returned.head, path, true);
    expect(await first.load(returned.head, signal)).toEqual({
      entries: [{ path, state: "viewed" }],
    });
  });
  it("coordinates tabs and migrates the previously viewed files", async () => {
    const legacyKey = `paseo:review-viewed:${reviewIdentityKey(review)}`;
    const legacyRecord = JSON.stringify({ headSha: "head1", paths: [path] });
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("window", {
      localStorage: { getItem: (key: string) => (key === legacyKey ? legacyRecord : null) },
    });
    try {
      const first = createBrowserReviewViewed();
      const second = createBrowserReviewViewed();
      const signal = new AbortController().signal;
      const old = await first.confirmHead(await first.begin(review), "head1", signal);
      expect(old.viewed.entries).toEqual([{ path, state: "viewed" }]);
      const delayed = await first.begin(review);
      const current = await second.confirmHead(await second.begin(review), "head2", signal);
      const sameHead = await first.confirmHead(await first.begin(review), "head2", signal);
      await Promise.all([
        first.set(sameHead.head, "first.ts", true),
        second.set(current.head, "second.ts", true),
      ]);
      await expect(first.confirmHead(delayed, "head1", signal)).rejects.toMatchObject({
        code: "stale",
      });
      const progress = await second.load(current.head, signal);
      expect(progress.entries.map((entry) => entry.path).sort()).toEqual(["first.ts", "second.ts"]);

      const returned = await first.confirmHead(await first.begin(review), "head1", signal);
      expect(returned.viewed.entries).toEqual([]);
      await expect(second.set(old.head, path, true)).rejects.toMatchObject({ code: "stale" });
      await first.set(returned.head, path, true);
      expect((await second.load(returned.head, signal)).entries).toEqual([
        { path, state: "viewed" },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
