import type { DiffLine } from "@/utils/tool-call-parsers";
import type { PullRequestContextAttachment } from "@/attachments/types";
import { reviewVersionKey, type ReviewLine, type ReviewStop, type ReviewVersion } from "./port";

interface ReviewDiff {
  lines: DiffLine[];
  line?: ReviewLine;
}

function matchesLine(target: ReviewLine, position: ReviewLine): boolean {
  return (
    (target.oldLine !== undefined || target.newLine !== undefined) &&
    (target.oldLine === undefined || (target.oldLine > 0 && target.oldLine === position.oldLine)) &&
    (target.newLine === undefined || (target.newLine > 0 && target.newLine === position.newLine))
  );
}

export function reviewStopDiff(stop: ReviewStop): ReviewDiff {
  const { hunk } = stop;
  if (!hunk) return { lines: [] };

  const patchLines = hunk.patch.replaceAll("\r\n", "\n").split("\n");
  if (patchLines.at(-1) === "") patchLines.pop();
  const header = patchLines[0]?.startsWith("@@ ") ? patchLines.shift() : undefined;
  const lines: DiffLine[] = header ? [{ type: "header", content: header }] : [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let anchor: ReviewLine | undefined;

  // The provider gives one hunk and its starts. File headers are not valid inside the hunk.
  for (const content of patchLines) {
    let position: ReviewLine;
    switch (content[0]) {
      case "+":
        lines.push({ type: "add", content });
        position = { newLine: newLine++ };
        break;
      case "-":
        lines.push({ type: "remove", content });
        position = { oldLine: oldLine++ };
        break;
      case " ":
        lines.push({ type: "context", content });
        position = { oldLine: oldLine++, newLine: newLine++ };
        break;
      case "\\":
        if (content !== "\\ No newline at end of file") return { lines: [] };
        lines.push({ type: "header", content });
        continue;
      default:
        return { lines: [] };
    }
    const target = stop.line;
    if (target && matchesLine(target, position)) anchor = target;
  }

  if (oldLine - hunk.oldStart !== hunk.oldCount || newLine - hunk.newStart !== hunk.newCount) {
    return { lines: [] };
  }
  return { lines, line: anchor };
}

export function reviewLineLabel(line: ReviewLine | undefined): string {
  return [
    line?.oldLine === undefined ? "" : `−${line.oldLine}`,
    line?.newLine === undefined ? "" : `+${line.newLine}`,
  ]
    .filter(Boolean)
    .join(" / ");
}

export function reviewStopAttachment(input: {
  scope: string;
  version: ReviewVersion;
  stop: ReviewStop;
  body: string;
  url: string;
}): PullRequestContextAttachment {
  const { scope, version, stop, body, url } = input;
  const path =
    stop.oldPath && stop.oldPath !== stop.path ? `${stop.oldPath} → ${stop.path}` : stop.path;
  const diff = reviewStopDiff(stop);
  const label = reviewLineLabel(diff.line);
  return {
    kind: "forge.change_request_review",
    id: JSON.stringify(["guided-review", scope, reviewVersionKey(version), stop.id]),
    title: stop.path,
    subtitle: label || undefined,
    url,
    text: [
      `Review stop: ${path}`,
      `Change request: ${url}`,
      `Base: ${stop.diffBaseSha ?? version.baseSha}`,
      ...(stop.diffBaseSha && stop.diffBaseSha !== version.baseSha
        ? [`Target: ${version.baseSha}`]
        : []),
      `Head: ${version.headSha}`,
      ...(version.startSha ? [`Start: ${version.startSha}`] : []),
      ...(label ? [`Lines: ${label}`] : []),
      "",
      diff.lines.length > 0 ? (stop.hunk?.patch ?? "") : "No patch available for this stop.",
      ...(body.trim() ? ["", "Review draft:", body] : []),
    ].join("\n"),
  };
}
