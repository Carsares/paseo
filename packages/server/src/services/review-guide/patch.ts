import { createHash } from "node:crypto";
import type {
  ReviewCoverage,
  ReviewHunk,
  ReviewIdentity,
  ReviewLine,
  ReviewStop,
  ReviewVersion,
} from "./types.js";

export interface ReviewFile {
  path: string;
  oldPath?: string;
  patch?: string | null;
  generated?: boolean;
  pureRename?: boolean;
  additions?: number;
  deletions?: number;
}

export interface ReviewFiles {
  files: ReviewFile[];
  diffBaseSha?: string;
  totalFiles?: number;
  hasMore: boolean;
  reason?: string;
}

export const REVIEW_FILE_LIMIT = 400;
const MAX_FILE_PATCH_BYTES = 64 * 1024;
const MAX_GUIDE_PATCH_BYTES = 512 * 1024;
const MAX_GUIDE_HUNKS = 1_000;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

interface ParsedHunk {
  hunk: ReviewHunk;
  line: ReviewLine;
  changes: number;
}

function parseHeader(line: string) {
  const match = HUNK_HEADER.exec(line);
  if (!match) return null;
  const oldStart = Number(match[1]);
  const oldCount = Number(match[2] ?? 1);
  const newStart = Number(match[3]);
  const newCount = Number(match[4] ?? 1);
  if (
    ![oldStart, oldCount, newStart, newCount].every((n) => n <= 2_147_483_647) ||
    (oldCount > 0 && oldStart === 0) ||
    (newCount > 0 && newStart === 0)
  )
    return null;
  return { oldStart, oldCount, newStart, newCount };
}

function parseHunk(lines: string[], start: number, end: number) {
  const header = parseHeader(lines[start]);
  if (!header) return null;
  let oldLine = header.oldStart;
  let newLine = header.newStart;
  let additions = 0;
  let deletions = 0;
  let firstAdded: ReviewLine | undefined;
  let firstRemoved: ReviewLine | undefined;
  let allowNoNewlineMarker = false;
  for (let index = start + 1; index < end; index++) {
    const row = lines[index];
    if (row === "\\ No newline at end of file" && allowNoNewlineMarker) {
      allowNoNewlineMarker = false;
      continue;
    }
    allowNoNewlineMarker = true;
    switch (row[0]) {
      case "+":
        firstAdded ??= { newLine };
        newLine++;
        additions++;
        break;
      case "-":
        firstRemoved ??= { oldLine };
        oldLine++;
        deletions++;
        break;
      case " ":
        oldLine++;
        newLine++;
        break;
      default:
        return null;
    }
  }
  const line = firstAdded ?? firstRemoved;
  if (
    !line ||
    oldLine !== header.oldStart + header.oldCount ||
    newLine !== header.newStart + header.newCount
  )
    return null;
  return {
    entry: {
      hunk: { ...header, patch: lines.slice(start, end).join("\n") },
      line,
      changes: additions + deletions,
    },
    additions,
    deletions,
    oldLine,
    newLine,
  };
}

function parsePatch(file: ReviewFile): ParsedHunk[] | null {
  if (!file.patch || Buffer.byteLength(file.patch) > MAX_FILE_PATCH_BYTES) return null;
  const lines = file.patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  // GitLab can include unified file headers. Each API record already identifies its file.
  let cursor = lines[0]?.startsWith("--- ") && lines[1]?.startsWith("+++ ") ? 2 : 0;
  const hunks: ParsedHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let previousOldEnd = 0;
  let previousNewEnd = 0;
  while (cursor < lines.length) {
    const start = cursor++;
    while (cursor < lines.length && !lines[cursor].startsWith("@@")) cursor++;
    const parsed = parseHunk(lines, start, cursor);
    if (
      !parsed ||
      parsed.entry.hunk.oldStart < previousOldEnd ||
      parsed.entry.hunk.newStart < previousNewEnd
    )
      return null;
    hunks.push(parsed.entry);
    additions += parsed.additions;
    deletions += parsed.deletions;
    previousOldEnd = parsed.oldLine;
    previousNewEnd = parsed.newLine;
  }
  if (
    !hunks.length ||
    (file.additions !== undefined && additions !== file.additions) ||
    (file.deletions !== undefined && deletions !== file.deletions)
  )
    return null;
  return hunks;
}

function classify(file: ReviewFile, changes: number): Pick<ReviewStop, "priority" | "reason"> {
  const paths = [file.path, file.oldPath ?? file.path];
  if (file.pureRename) return { priority: "mechanical", reason: "rename" };
  if (
    /(?:^|\/)(?:[^/]+\.lock(?:\.json)?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|go\.sum)$/i.test(
      file.path,
    )
  ) {
    return { priority: "mechanical", reason: "lockfile" };
  }
  if (file.generated) return { priority: "mechanical", reason: "generated" };
  if (
    paths.some((path) =>
      /(?:^|\/)(?:auth(?:entication|orization)?|permissions?|security|crypto|migrations?|secrets?)(?:[/._-]|$)|(?:^|\/)(?:\.github\/workflows|\.gitlab-ci\.yml)(?:\/|$)/i.test(
        path,
      ),
    )
  ) {
    return { priority: "attention", reason: "sensitive" };
  }
  if (changes >= 40) return { priority: "attention", reason: "substantial" };
  if (file.oldPath && file.oldPath !== file.path) return { priority: "normal", reason: "rename" };
  return { priority: "normal", reason: "source" };
}

function classifyWithoutPatch(file: ReviewFile): Pick<ReviewStop, "priority" | "reason"> {
  const kind = classify(file, (file.additions ?? 0) + (file.deletions ?? 0));
  return kind.reason === "source" ? { priority: "normal", reason: "unavailable" } : kind;
}

const priorityOrder = { attention: 0, normal: 1, mechanical: 2 };
const reasonOrder = {
  sensitive: 0,
  substantial: 1,
  source: 2,
  rename: 3,
  unavailable: 4,
  lockfile: 5,
  generated: 6,
};

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function buildReviewStops(
  identity: ReviewIdentity,
  version: ReviewVersion,
  source: ReviewFiles,
): { stops: ReviewStop[]; coverage: ReviewCoverage } {
  const stops: ReviewStop[] = [];
  let filesLoaded = 0;
  let missingPatches = 0;
  let patchBytes = 0;
  let hunkCount = 0;
  let guideLimit = false;

  function addStop(
    file: ReviewFile,
    classified: Pick<ReviewStop, "priority" | "reason">,
    parsed?: ParsedHunk,
  ) {
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          identity.forge,
          identity.host,
          identity.projectPath,
          identity.number,
          version.baseSha,
          version.headSha,
          version.startSha,
          file.path,
          file.oldPath,
          parsed?.hunk.patch,
          parsed?.line,
        ]),
      )
      .digest("hex");
    stops.push({
      id,
      path: file.path,
      ...(file.oldPath && file.oldPath !== file.path ? { oldPath: file.oldPath } : {}),
      ...classified,
      ...(parsed ? { hunk: parsed.hunk, line: parsed.line } : {}),
    });
  }

  // Plan by file strength before consuming the patch budget, then order the
  // actual stops globally across every page.
  const files = [...source.files].sort((left, right) => {
    const a = classify(left, (left.additions ?? 0) + (left.deletions ?? 0));
    const b = classify(right, (right.additions ?? 0) + (right.deletions ?? 0));
    return (
      priorityOrder[a.priority] - priorityOrder[b.priority] ||
      reasonOrder[a.reason] - reasonOrder[b.reason] ||
      compareText(left.path, right.path)
    );
  });
  for (const file of files) {
    if (filesLoaded >= REVIEW_FILE_LIMIT) {
      guideLimit = true;
      break;
    }
    filesLoaded++;
    const hunks = parsePatch(file);
    const bytes = hunks?.reduce((sum, entry) => sum + Buffer.byteLength(entry.hunk.patch), 0) ?? 0;
    const fits =
      hunks &&
      bytes + patchBytes <= MAX_GUIDE_PATCH_BYTES &&
      hunks.length + hunkCount <= MAX_GUIDE_HUNKS;
    if (!fits) {
      guideLimit ||= hunks !== null;
      missingPatches++;
      addStop(file, classifyWithoutPatch(file));
      continue;
    }
    patchBytes += bytes;
    hunkCount += hunks.length;
    for (const parsed of hunks) addStop(file, classify(file, parsed.changes), parsed);
  }

  stops.sort(
    (left, right) =>
      priorityOrder[left.priority] - priorityOrder[right.priority] ||
      reasonOrder[left.reason] - reasonOrder[right.reason] ||
      compareText(left.path, right.path) ||
      (left.hunk?.newStart ?? 0) - (right.hunk?.newStart ?? 0) ||
      (left.hunk?.oldStart ?? 0) - (right.hunk?.oldStart ?? 0) ||
      compareText(left.id, right.id),
  );
  let reason = source.reason;
  if (!reason && guideLimit) reason = "guide_limit";
  if (!reason && missingPatches) reason = "missing_patches";
  return {
    stops,
    coverage: {
      filesLoaded,
      totalFiles: source.totalFiles,
      hasMore:
        source.hasMore ||
        files.length > REVIEW_FILE_LIMIT ||
        filesLoaded < (source.totalFiles ?? 0),
      missingPatches,
      ...(reason ? { reason } : {}),
    },
  };
}
