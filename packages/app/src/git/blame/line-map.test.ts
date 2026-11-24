import { describe, expect, it } from "vitest";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { worktreeLineForIndexLine } from "./line-map";

describe("staged file blame coordinates", () => {
  it("maps index lines through worktree insertions and omits worktree replacements", () => {
    const file: ParsedDiffFile = {
      path: "a",
      isNew: false,
      isDeleted: false,
      additions: 3,
      deletions: 1,
      hunks: [
        {
          oldStart: 1,
          oldCount: 0,
          newStart: 2,
          newCount: 2,
          lines: [
            { type: "add", content: "one" },
            { type: "add", content: "two" },
          ],
        },
        {
          oldStart: 10,
          oldCount: 2,
          newStart: 12,
          newCount: 2,
          lines: [
            { type: "context", content: "before" },
            { type: "remove", content: "other" },
            { type: "add", content: "different" },
          ],
        },
      ],
    };
    expect([1, 2, 10, 11, 12].map((line) => worktreeLineForIndexLine(file, line))).toEqual([
      1,
      4,
      12,
      null,
      14,
    ]);
  });
});
