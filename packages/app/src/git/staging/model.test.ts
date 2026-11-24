import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckoutGitWorkingTree, ParsedDiffFile } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { buildHunkPatch, fileSelection } from "./model";

const path = 'field "é".txt';

function file(): ParsedDiffFile {
  return {
    path,
    isNew: false,
    isDeleted: false,
    additions: 2,
    deletions: 2,
    hunks: [
      {
        oldStart: 1,
        oldCount: 4,
        newStart: 1,
        newCount: 4,
        lines: [
          { type: "header", content: "@@ -1,4 +1,4 @@" },
          { type: "context", content: "line 1" },
          { type: "remove", content: "line 2" },
          { type: "add", content: "edited 2" },
          { type: "context", content: "line 3" },
          { type: "context", content: "line 4" },
        ],
      },
      {
        oldStart: 18,
        oldCount: 3,
        newStart: 18,
        newCount: 3,
        lines: [
          { type: "header", content: "@@ -18,3 +18,3 @@" },
          { type: "context", content: "line 18" },
          { type: "remove", content: "line 19" },
          { type: "add", content: "edited 19" },
          { type: "context", content: "line 20" },
        ],
      },
    ],
  };
}

describe("staging model", () => {
  it("shows a partial selection when a file appears on both sides of the index", () => {
    const change = { path, status: "modified" as const };
    const tree: CheckoutGitWorkingTree = {
      repoRoot: "/repo",
      headSha: "head",
      currentBranch: "main",
      operationState: "idle",
      staged: [change, { ...change, path: "staged" }],
      unstaged: [change],
      untracked: ["untracked"],
      conflicts: [],
      activeAgents: [],
    };
    expect(fileSelection(tree, "staged", path)).toBe("mixed");
    expect(fileSelection(tree, "unstaged", path)).toBe("mixed");
    expect(fileSelection(tree, "staged", "staged")).toBe(true);
    expect(fileSelection(tree, "unstaged", "untracked")).toBe(false);
  });

  it("moves one hunk to and from the index and discards only that hunk", () => {
    const cwd = mkdtempSync(join(tmpdir(), "paseo-staging-model-"));
    const git = (args: string[], input?: string) =>
      execFileSync("git", args, { cwd, input, encoding: "utf8" });
    try {
      git(["init", "-q"]);
      const original = Array.from({ length: 20 }, (_, index) => "line " + (index + 1)).join("\n");
      const working = original
        .replace("line 2\n", "edited 2\n")
        .replace("line 19\n", "edited 19\n");
      writeFileSync(join(cwd, path), original);
      git(["add", "--", path]);
      git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "Initial",
      ]);
      writeFileSync(join(cwd, path), working);

      const first = buildHunkPatch(file(), 0)!;
      const second = buildHunkPatch(file(), 1)!;
      git(["apply", "--cached", "--unidiff-zero", "-"], first);
      expect(git(["show", ":" + path])).toBe(original.replace("line 2\n", "edited 2\n"));
      git(["apply", "--cached", "--reverse", "--unidiff-zero", "-"], first);
      expect(git(["show", ":" + path])).toBe(original);
      git(["apply", "--reverse", "--unidiff-zero", "-"], second);
      expect(git(["diff", "--", path])).toContain("+edited 2\n");
      expect(git(["diff", "--", path])).not.toContain("edited 19");
      expect(git(["show", ":" + path])).toBe(original);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous end-of-file edits, renamed files and oversized UTF-8 patches", () => {
    const changed = file();
    const last = changed.hunks[1]!;
    last.lines.pop();
    last.oldCount--;
    last.newCount--;
    expect(buildHunkPatch(changed, 1)).toBeNull();
    expect(buildHunkPatch({ ...file(), oldPath: "old.txt" }, 0)).toBeNull();
    const large = file();
    large.hunks[0]!.lines[2]!.content = "界".repeat(180_000);
    expect(buildHunkPatch(large, 0)).toBeNull();
  });
});
