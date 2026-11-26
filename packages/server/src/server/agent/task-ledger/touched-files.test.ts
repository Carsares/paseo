import { describe, expect, it } from "vitest";
import { mapCodexToolCallFromThreadItem } from "../providers/codex/tool-call-mapper.js";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import {
  extractModifiedPathsFromTimelineItems,
  extractModifiedPathsFromToolCall,
} from "./touched-files.js";

type ToolCall = Extract<AgentTimelineItem, { type: "tool_call" }>;

function call(name: string, detail: ToolCall["detail"]): ToolCall {
  return { type: "tool_call", callId: name, name, detail, status: "completed", error: null };
}

function unknown(name: string, input: unknown): ToolCall {
  return call(name, { type: "unknown", input, output: null });
}

describe("task file writes", () => {
  it("accepts completed writes and rejects read, shell, running and failed events", () => {
    const editor = call("Edit", { type: "edit", filePath: "a.ts" });
    expect(
      extractModifiedPathsFromTimelineItems(
        [
          editor,
          { ...editor, status: "running" },
          {
            ...editor,
            status: "failed",
            error: { message: "failed" },
            detail: { type: "edit", filePath: "failed.ts" },
          },
          unknown("mcp__filesystem__read_file", { path: "read.ts" }),
          unknown("mcp__shell__bash", { path: "shell.ts" }),
          unknown("glob", { path: "glob.ts" }),
          unknown("mcp__files__touch_file", { path: "unlisted.ts" }),
          unknown("str_replace_editor", { command: "view", path: "view.ts" }),
          call("str_replace_editor", { type: "edit", filePath: "lossy-view.ts" }),
          unknown("str_replace_editor", { command: "create", path: "create.ts" }),
          unknown("mcp__filesystem__write_file", { file_path: "write.ts" }),
          unknown("multi_edit", { edits: [{ path: "first.ts" }, { filePath: "second.ts" }] }),
          unknown("rename_file", { source: "before.ts", destination: "after.ts" }),
        ],
        "/checkout",
      ),
    ).toEqual(["a.ts", "create.ts", "write.ts", "first.ts", "second.ts", "before.ts", "after.ts"]);
  });

  it("extracts Codex multi-file details and apply_patch headers without using changed text as paths", () => {
    const codex = mapCodexToolCallFromThreadItem({
      type: "fileChange",
      id: "patch",
      status: "completed",
      changes: [
        { path: "one.ts", kind: { type: "add" }, diff: "one" },
        { path: "two words.ts", kind: { type: "add" }, diff: "two" },
      ],
    });
    if (!codex) throw new Error("Expected a Codex file change");
    expect(extractModifiedPathsFromToolCall(codex, "/checkout")).toEqual([
      "one.ts",
      "two words.ts",
    ]);
    const patch = [
      "*** Begin Patch",
      "*** Update File: old.ts",
      "*** Move to: new.ts",
      "@@",
      "+*** Add File: pretend.ts",
      "*** Delete File: remove.ts",
      "*** End Patch",
    ].join("\n");
    expect(
      extractModifiedPathsFromToolCall(unknown("apply_patch", { patchText: patch }), "/checkout"),
    ).toEqual(["old.ts", "new.ts", "remove.ts"]);
  });

  it("normalizes workspace paths and Windows case, excluding external paths and .git", () => {
    const paths = [
      "C:\\WORK\\Repo\\src\\A.ts",
      "src\\a.ts",
      "../outside.ts",
      "D:\\Work\\Repo\\other.ts",
      ".GIT\\config",
      "nested/.git/HEAD",
      ".git./HEAD",
      "c:drive-relative.ts",
    ];
    expect(
      extractModifiedPathsFromToolCall(unknown("write_file", { paths }), "c:\\Work\\Repo"),
    ).toEqual(["src/a.ts"]);
    expect(
      extractModifiedPathsFromToolCall(
        unknown("write_file", { paths: ["a.ts", "../root.ts", "/checkout-sibling/other.ts"] }),
        "/checkout",
        "/checkout/src",
      ),
    ).toEqual(["src/a.ts", "root.ts"]);
  });

  it("keeps the most recent 64 distinct files", () => {
    const paths = Array.from({ length: 70 }, (_, i) => `dir/${i}.ts`);
    expect(extractModifiedPathsFromToolCall(unknown("write_file", { paths }), "/checkout")).toEqual(
      paths.slice(-64),
    );
  });
});
