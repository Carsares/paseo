import { expect, it } from "vitest";
import { repoColor, stripeSegments } from "./stripe-segments";

it("merges only adjacent rows from the same repository, including across pages", () => {
  const firstPage = [{ repoRoot: "/a" }, { repoRoot: "/b" }];
  const nextPage = [{ repoRoot: "/b" }, { repoRoot: "/a" }];
  expect(stripeSegments([...firstPage, ...nextPage])).toEqual([
    { repoRoot: "/a", start: 0, end: 1, color: repoColor("/a") },
    { repoRoot: "/b", start: 1, end: 3, color: repoColor("/b") },
    { repoRoot: "/a", start: 3, end: 4, color: repoColor("/a") },
  ]);
  expect(stripeSegments([])).toEqual([]);
});
