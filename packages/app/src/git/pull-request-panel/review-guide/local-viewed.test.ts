import { describe, expect, it } from "vitest";
import { createLocalReviewViewed } from "./local-viewed";
import type { ReviewIdentity } from "./port";

const review: ReviewIdentity = {
  forge: "github",
  host: "github.com",
  projectPath: "abc/repo",
  number: 27,
};
const anotherRepo = { ...review, projectPath: "abc/other" };
const anotherHost = { ...review, host: "github.acme.test" };
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

    await first.load(review, "head1", signal);
    await first.set(review, "head1", path, true);
    await first.load(anotherRepo, "head1", signal);
    await first.set(anotherRepo, "head1", path, true);
    expect(await first.load(anotherHost, "head1", signal)).toEqual({ entries: [] });

    const reopened = createLocalReviewViewed(storage);
    expect(await reopened.load(review, "head1", signal)).toEqual({
      entries: [{ path, state: "viewed" }],
    });
    expect(await reopened.load(review, "head2", signal)).toEqual({ entries: [] });
    await expect(reopened.set(review, "head1", path, true)).rejects.toMatchObject({
      code: "stale",
    });
    expect(await reopened.load(anotherRepo, "head1", signal)).toEqual({
      entries: [{ path, state: "viewed" }],
    });
    expect(await reopened.load(review, "head1", signal)).toEqual({ entries: [] });
  });
});
