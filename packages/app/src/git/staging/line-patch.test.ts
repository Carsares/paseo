import { describe, expect, it } from "vitest";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { buildLinePatch } from "./line-patch";

function file(hunk: ParsedDiffFile["hunks"][number]): ParsedDiffFile {
  return {
    path: "file.txt",
    isNew: false,
    isDeleted: false,
    additions: 3,
    deletions: 3,
    hunks: [hunk],
  };
}

const hunk: ParsedDiffFile["hunks"][number] = {
  oldStart: 9,
  oldCount: 5,
  newStart: 17,
  newCount: 5,
  lines: [
    { type: "header", content: "@@ -9,5 +17,5 @@" },
    { type: "context", content: "before" },
    { type: "remove", content: "a" },
    { type: "remove", content: "b" },
    { type: "remove", content: "c" },
    { type: "add", content: "A" },
    { type: "add", content: "B" },
    { type: "add", content: "C" },
    { type: "context", content: "after" },
  ],
};

describe("one hunk line patch", () => {
  it("stages disjoint changes against the original index start, preserving unselected old lines", () => {
    expect(
      buildLinePatch(file(hunk), 0, new Set([3, 7]), "unstaged")
        ?.split("\n")
        .slice(3),
    ).toEqual(["@@ -9,4 +9,4 @@", " before", " a", "-b", " c", "+C", ""]);
  });
  it("unstages those changes in reverse at the index's new start, preserving unselected new lines", () => {
    expect(
      buildLinePatch(file(hunk), 0, new Set([3, 7]), "staged")
        ?.split("\n")
        .slice(3),
    ).toEqual(["@@ -17,4 +17,4 @@", " before", " A", " B", "-b", "+C", ""]);
  });
  it("preserves a zero-length anchor and available EOF marker", () => {
    const input = file({
      oldStart: 8,
      oldCount: 0,
      newStart: 9,
      newCount: 1,
      lines: [
        { type: "add", content: "C" },
        { type: "header", content: "\\ No newline at end of file" },
      ],
    });
    expect(
      buildLinePatch(input, 0, new Set([0]), "unstaged")
        ?.split("\n")
        .slice(3),
    ).toEqual(["@@ -8,0 +9,1 @@", "+C", "\\ No newline at end of file", ""]);
  });
  it("rejects a selection that no longer identifies only changed rows", () => {
    expect(buildLinePatch(file(hunk), 0, new Set([1, 7]), "unstaged")).toBeNull();
    expect(buildLinePatch(file(hunk), 0, new Set([7, 99]), "staged")).toBeNull();
  });
});
