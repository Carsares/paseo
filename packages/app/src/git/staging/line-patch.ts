import { CHECKOUT_GIT_MAX_PATCH_BYTES, type ParsedDiffFile } from "@getpaseo/protocol/messages";
import { quotePatchPath, type StagingLayer } from "./model";

type DiffLine = ParsedDiffFile["hunks"][number]["lines"][number];
type BodyKind = Exclude<DiffLine["type"], "header">;
interface PatchLine {
  type: BodyKind;
  content: string;
  selected: boolean;
  noNewline: boolean;
}

const eof = "\\ No newline at end of file";
const prefix = { context: " ", remove: "-", add: "+" } as const;

export function canSelectPatchLines(file: ParsedDiffFile) {
  return (
    !file.oldPath &&
    !file.isNew &&
    !file.isDeleted &&
    (!file.status || file.status === "ok") &&
    file.path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function patchLines(lines: DiffLine[], selected: ReadonlySet<number>): PatchLine[] {
  const body: PatchLine[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.type !== "header") {
      body.push({
        type: line.type,
        content: line.content,
        selected: selected.has(index) && line.type !== "context",
        noNewline: "noNewline" in line && line.noNewline === true,
      });
    } else if (line.content === eof) {
      const previous = body.at(-1);
      if (previous) previous.noNewline = true;
    }
  }
  return body;
}

function projectLines(lines: PatchLine[], layer: StagingLayer): PatchLine[] {
  const fixedSide = layer === "staged" ? "add" : "remove";
  const output: PatchLine[] = [];
  let removes: PatchLine[] = [];
  let adds: PatchLine[] = [];
  function include(line: PatchLine) {
    if (line.selected || line.type === "context") output.push(line);
    else if (line.type === fixedSide) output.push({ ...line, type: "context" });
  }
  function flush() {
    // Split diff pairs replacement lines by ordinal, including unequal groups.
    const fixed = layer === "staged" ? adds : removes;
    const incoming = layer === "staged" ? removes : adds;
    for (let i = 0; i < Math.max(fixed.length, incoming.length); i++) {
      if (fixed[i]) include(fixed[i]);
      if (incoming[i]) include(incoming[i]);
    }
    removes = [];
    adds = [];
  }
  for (const line of lines) {
    if (line.type === "remove") removes.push(line);
    else if (line.type === "add") adds.push(line);
    else {
      flush();
      include(line);
    }
  }
  flush();
  // Trailing context does not contribute to the requested change.
  while (output.at(-1)?.type === "context") output.pop();
  return output;
}

export function buildLinePatch(
  file: ParsedDiffFile,
  hunkIndex: number,
  selected: ReadonlySet<number>,
  layer: StagingLayer,
): string | null {
  const hunk = file.hunks[hunkIndex];
  if (!hunk || !selected.size || !canSelectPatchLines(file)) return null;
  const source = patchLines(hunk.lines, selected);
  if (
    source.filter((line) => line.selected).length !== selected.size ||
    source.filter((line) => line.type !== "add").length !== hunk.oldCount ||
    source.filter((line) => line.type !== "remove").length !== hunk.newCount
  )
    return null;
  const rows = projectLines(source, layer);
  const oldCount = rows.filter((line) => line.type !== "add").length;
  const newCount = rows.filter((line) => line.type !== "remove").length;
  // A zero-count hunk starts at the boundary before the first affected line.
  const boundary =
    layer === "staged"
      ? hunk.newStart - Number(hunk.newCount !== 0)
      : hunk.oldStart - Number(hunk.oldCount !== 0);
  const oldPath = quotePatchPath("a/" + file.path);
  const newPath = quotePatchPath("b/" + file.path);
  const oldStart = boundary + Number(oldCount !== 0);
  const newStart = boundary + Number(newCount !== 0);
  const body = rows.flatMap((line) => {
    const row = prefix[line.type] + line.content;
    return line.noNewline ? [row, eof] : [row];
  });
  const patch = [
    "diff --git " + oldPath + " " + newPath,
    "--- " + oldPath,
    "+++ " + newPath,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...body,
    "",
  ].join("\n");
  return new TextEncoder().encode(patch).length <= CHECKOUT_GIT_MAX_PATCH_BYTES ? patch : null;
}
