import type { ParsedDiffFile } from "@getpaseo/protocol/messages";

/** Maps an index line to the same content in the worktree, if it survived. */
export function worktreeLineForIndexLine(file: ParsedDiffFile | undefined, line: number) {
  if (!file) return line;
  if (file.oldPath || file.isDeleted || (file.status && file.status !== "ok")) return null;
  let delta = 0;
  for (const hunk of file.hunks) {
    const boundary = hunk.oldStart - Number(hunk.oldCount !== 0);
    if (line <= boundary) break;
    if (line > boundary + hunk.oldCount) {
      delta += hunk.newCount - hunk.oldCount;
      continue;
    }
    let oldLine = boundary + 1;
    let newLine = hunk.newStart - Number(hunk.newCount !== 0) + 1;
    for (const row of hunk.lines) {
      if (row.type === "header") continue;
      if (row.type !== "add") {
        if (oldLine === line) return row.type === "remove" ? null : newLine;
        oldLine++;
      }
      if (row.type !== "remove") newLine++;
    }
    return null;
  }
  return line + delta;
}
