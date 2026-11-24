import { runGitCommandBytes } from "../../utils/run-git-command.js";
import { safeRepoPath } from "./conflict-inspect.js";
import { git, readHead } from "./git-workbench-state.js";
import type { GitWorktree } from "./repo-write-mutex.js";
import { withStagedCommitLock } from "./staged-snapshot.js";

type RowKind = " " | "+" | "-";
type Direction = "stage" | "unstage";
interface Row {
  kind: RowKind;
  text: string;
  newline: boolean;
}
interface Hunk {
  oldBoundary: number;
  newBoundary: number;
  oldCount: number;
  newCount: number;
  rows: Row[];
}

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PATCH_LINES = 100_000;
const REVERSED_KIND = { " ": " ", "+": "-", "-": "+" } as const;
const ENV = {
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};
const EOF = "\\ No newline at end of file";

function parseHunk(lines: string[]): Hunk {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[0]!);
  if (!match) throw new Error("Invalid unified patch header");
  const oldCount = Number(match[2] ?? 1);
  const newCount = Number(match[4] ?? 1);
  const oldBoundary = Number(match[1]) - Number(oldCount > 0);
  const newBoundary = Number(match[3]) - Number(newCount > 0);
  if (
    ![oldBoundary, newBoundary].every((boundary) => Number.isSafeInteger(boundary) && boundary >= 0)
  )
    throw new Error("Invalid patch line number");
  const rows: Row[] = [];
  let oldLines = 0;
  let newLines = 0;
  for (const line of lines.slice(1)) {
    const kind = line[0];
    if (kind === " " || kind === "+" || kind === "-") {
      rows.push({ kind, text: line.slice(1), newline: true });
      oldLines += Number(kind !== "+");
      newLines += Number(kind !== "-");
    } else if (line === EOF && rows.at(-1)?.newline) {
      rows.at(-1)!.newline = false;
    } else {
      throw new Error("Invalid unified patch line");
    }
  }
  if (oldLines !== oldCount || newLines !== newCount) throw new Error("Invalid patch line counts");
  return { oldBoundary, newBoundary, oldCount, newCount, rows };
}

function readHunks(patch: string): Hunk[] {
  if (!patch.endsWith("\n") || patch.includes("\0")) throw new Error("Expected a UTF-8 patch");
  const lines = patch.slice(0, -1).split("\n", MAX_PATCH_LINES + 1);
  if (lines.length > MAX_PATCH_LINES) throw new Error("The diff has too many lines");
  const starts = lines.flatMap((line, i) => (line.startsWith("@@ ") ? [i] : []));
  return starts.map((start, i) => parseHunk(lines.slice(start, starts[i + 1])));
}

function orient(hunk: Hunk, direction: Direction) {
  if (direction === "stage")
    return { boundary: hunk.oldBoundary, count: hunk.oldCount, rows: hunk.rows };
  const rows = hunk.rows.map(
    (row): Row => ({
      ...row,
      kind: REVERSED_KIND[row.kind],
    }),
  );
  return { boundary: hunk.newBoundary, count: hunk.newCount, rows };
}

function sameLine(a: Row, b: Row): boolean {
  return a.text === b.text && a.newline === b.newline;
}

interface ChangeBlock {
  start: number;
  end: number;
  incoming: Row[];
  consumed: number;
}

function indexHunk(hunk: ReturnType<typeof orient>) {
  const fixed: Row[] = [];
  const blocks = new Map<number, ChangeBlock>();
  let block: ChangeBlock | undefined;
  for (const row of hunk.rows) {
    if (row.kind === " ") {
      block = undefined;
      fixed.push(row);
    } else {
      if (!block) {
        block = { start: fixed.length, end: fixed.length, incoming: [], consumed: 0 };
        blocks.set(fixed.length, block);
      }
      if (row.kind === "+") {
        block.incoming.push(row);
      } else {
        fixed.push(row);
        block.end++;
        blocks.set(fixed.length, block);
      }
    }
  }
  return { fixed, blocks };
}

function selectIncoming(
  block: ChangeBlock | undefined,
  at: number,
  row: Row,
  direction: Direction,
) {
  if (!block) return false;
  const nativeBoundary = direction === "stage" ? block.end : block.start;
  // Git groups whole sides. The split display pairs them by ordinal, then
  // places any remaining incoming lines after the last fixed line.
  if (at !== nativeBoundary && at !== block.end) {
    const aligned = at - block.start - 1;
    const candidate = block.incoming[aligned];
    if (!candidate || aligned < block.consumed || !sameLine(row, candidate)) return false;
    block.consumed = aligned + 1;
    return true;
  }
  if (at !== nativeBoundary) {
    block.consumed = Math.max(block.consumed, at - block.start - 1);
  }
  while (block.consumed < block.incoming.length) {
    if (sameLine(row, block.incoming[block.consumed++]!)) return true;
  }
  return false;
}

function matchesHunk(patch: ReturnType<typeof orient>, original: Hunk, direction: Direction) {
  const current = orient(original, direction);
  let position = patch.boundary - current.boundary;
  if (position < 0 || position + patch.count > current.count) return false;
  const { fixed, blocks } = indexHunk(current);
  for (const row of patch.rows) {
    if (row.kind === "+") {
      if (!selectIncoming(blocks.get(position), position, row, direction)) return false;
      continue;
    }
    const existing = fixed[position++];
    if (!existing || !sameLine(row, existing) || (row.kind === "-" && existing.kind !== "-"))
      return false;
  }
  return true;
}

async function readCurrentDiff(
  repo: GitWorktree,
  head: string | null,
  direction: Direction,
  path: string,
) {
  if (direction === "unstage" && !head)
    throw new Error("There is no committed file to unstage against");
  const result = await runGitCommandBytes(
    [
      "--literal-pathspecs",
      "-c",
      "diff.suppressBlankEmpty=false",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      "--no-relative",
      "--output-indicator-old=-",
      "--output-indicator-new=+",
      "--output-indicator-context= ",
      ...(direction === "unstage" ? ["--cached", head!] : []),
      "--",
      path,
    ],
    { cwd: repo.root, maxOutputBytes: MAX_FILE_BYTES, envOverlay: ENV },
  );
  const diff = result.stdout.toString("utf8");
  if (result.truncated || !Buffer.from(diff).equals(result.stdout))
    throw new Error("The current diff is too large or uses an unsupported encoding");
  return diff;
}

function spliceLines(content: string, patch: ReturnType<typeof orient>) {
  let offset = 0;
  for (let line = 0; line < patch.boundary; line++) {
    if (offset >= content.length) throw new Error("The patch is outside the staged file");
    const newline = content.indexOf("\n", offset);
    offset = newline < 0 ? content.length : newline + 1;
  }
  const prefix = content.slice(0, offset);
  const result: string[] = [];
  for (const row of patch.rows) {
    const line = row.text + (row.newline ? "\n" : "");
    if (row.kind !== "+") {
      const newline = content.indexOf("\n", offset);
      const end = newline < 0 ? content.length : newline + 1;
      if (offset >= content.length || content.slice(offset, end) !== line)
        throw new Error("The patch moved or no longer matches the staged text");
      offset = end;
    }
    if (row.kind !== "-") result.push(line);
  }
  const suffix = content.slice(offset);
  if (
    (prefix && !prefix.endsWith("\n") && (result.length > 0 || suffix)) ||
    result.some((line, index) => !line.endsWith("\n") && (index + 1 < result.length || suffix))
  ) {
    throw new Error("A line without a newline must remain at the end of the file");
  }
  const updated = prefix + result.join("") + suffix;
  if (Buffer.byteLength(updated) > MAX_FILE_BYTES)
    throw new Error("The selected text is too large");
  return updated;
}

async function readIndexFile(repo: GitWorktree, path: string, env: NodeJS.ProcessEnv) {
  const { stdout } = await git(
    repo,
    ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", path],
    { envOverlay: env },
  );
  const [entry, end, extra] = stdout.split("\0");
  const index = /^(100644|100755) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t([\s\S]+)$/.exec(entry ?? "");
  if (!index || index[3] !== path || end !== "" || extra !== undefined)
    throw new Error("Select text in one tracked regular file");
  const result = await runGitCommandBytes(["cat-file", "blob", index[2]!], {
    cwd: repo.root,
    maxOutputBytes: MAX_FILE_BYTES,
    envOverlay: env,
  });
  const content = result.stdout.toString("utf8");
  if (result.truncated || content.includes("\0") || !Buffer.from(content).equals(result.stdout))
    throw new Error("Line staging supports UTF-8 staged files up to 16 MiB");
  return { mode: index[1]!, content };
}

export async function applyLinePatch(
  repo: GitWorktree,
  head: string | null,
  direction: Direction,
  path: string,
  patch: string,
) {
  await safeRepoPath(repo, path);
  const [selected, extra] = readHunks(patch);
  if (
    !selected ||
    extra ||
    selected.oldBoundary !== selected.newBoundary ||
    !selected.rows.some((row) => row.kind !== " ")
  )
    throw new Error("Select lines from one hunk at their staged position");
  const oriented = orient(selected, direction);
  // Keep external Git writers out while verifying and installing the staged result.
  // Splicing the exact staged lines avoids Git apply's approximate offset search.
  const { indexError } = await withStagedCommitLock(repo, async (snapshot) => {
    const diff = await readCurrentDiff(repo, head, direction, path);
    if (!readHunks(diff).some((hunk) => matchesHunk(oriented, hunk, direction)))
      throw new Error("The selected lines are no longer part of the current diff");
    const envOverlay = { ...ENV, ...snapshot.envOverlay };
    const { mode, content } = await readIndexFile(repo, path, envOverlay);
    const updated = spliceLines(content, oriented);
    const { stdout } = await git(repo, ["hash-object", "-w", "--stdin"], {
      input: updated,
      envOverlay,
    });
    const oid = stdout.trim();
    await git(repo, ["update-index", "--cacheinfo", mode, oid, path], { envOverlay });
    if (
      (await readHead(repo)) !== head ||
      (direction === "stage" && (await readCurrentDiff(repo, head, direction, path)) !== diff)
    )
      throw new Error("The selected lines changed while staging. Refresh and try again.");
  });
  if (indexError) throw new Error("Git's staged file changes could not be installed");
}
