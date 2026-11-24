import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { runGitCommandBytes } from "../../utils/run-git-command.js";
import type { CheckoutGitConflictFile, SessionInboundMessage } from "../messages.js";
import { git, GitWorkbenchError, readChanges, validateGitPaths } from "./git-workbench-state.js";
import type { GitWorktree } from "./repo-write-mutex.js";

type ResolveRequest = Extract<
  SessionInboundMessage,
  { type: "checkout.git.conflict.resolve.request" }
>;
type Stage = NonNullable<CheckoutGitConflictFile["base"]>;
type ConflictHunk = CheckoutGitConflictFile["hunks"][number];
type FileState =
  | { type: "missing" }
  | { type: "link"; bytes: Buffer }
  | { type: "file"; bytes: Buffer; mode: number };
interface TextHunk extends ConflictHunk {
  ours: string;
  theirs: string;
  start: number;
  end: number;
}
interface Snapshot {
  conflict: CheckoutGitConflictFile;
  state: FileState;
  text: string | null;
  hunks: TextHunk[];
  markerSize: number;
}

const MAX_FILE_BYTES = 512 * 1024;
const MAX_INSPECT_PATHS = 128;
const MAX_INSPECT_BYTES = 2 * 1024 * 1024;

function missing(error: NodeJS.ErrnoException): null {
  if (error.code === "ENOENT") return null;
  throw error;
}

function validatePath(path: string): void {
  validateGitPaths([path]);
  if (process.platform === "win32" && (path.includes(":") || /[ .](?:[/\\]|$)/.test(path))) {
    throw new Error("Invalid Windows repository path");
  }
  if (path.includes("\uFFFD")) throw new Error("Unsupported Git path encoding");
}

async function safePath(repo: GitWorktree, path: string): Promise<string> {
  const components = process.platform === "win32" ? path.split(/[/\\]/) : path.split("/");
  let parent = repo.root;
  for (const component of components.slice(0, -1)) {
    parent = join(parent, component);
    const info = await lstat(parent).catch(missing);
    if (info && !info.isDirectory())
      throw new Error("The conflict path crosses a non-directory or symbolic link");
  }
  return join(repo.root, components.join(sep));
}

async function readFileState(path: string): Promise<FileState> {
  const info = await lstat(path).catch(missing);
  if (!info) return { type: "missing" };
  if (info.isSymbolicLink())
    return { type: "link", bytes: await readlink(path, { encoding: "buffer" }) };
  if (!info.isFile() || info.size > MAX_FILE_BYTES)
    throw new Error("Conflict file is not a supported regular file or exceeds 512 KiB");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || info.dev !== opened.dev || info.ino !== opened.ino)
      throw staleSnapshot();
    const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_FILE_BYTES) throw new Error("Conflict file exceeds 512 KiB");
    return { type: "file", bytes: buffer.subarray(0, size), mode: opened.mode };
  } finally {
    await handle.close();
  }
}

function decodeText(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  return !text.includes("\0") && Buffer.from(text).equals(bytes) ? text : null;
}

async function markerSize(repo: GitWorktree, path: string): Promise<number> {
  const { stdout } = await git(repo, ["check-attr", "-z", "conflict-marker-size", "--", path]);
  const size = Number(stdout.split("\0")[2]);
  if (Number.isInteger(size) && size > 0 && size <= 1024) return size;
  return 7;
}

function marker(line: string, symbol: string, length: number): boolean {
  const prefix = symbol.repeat(length);
  return line.startsWith(prefix) && [" ", "\r", "\n", undefined].includes(line[length]);
}

function parseHunks(text: string, size: number): TextHunk[] {
  const hunks: TextHunk[] = [];
  const lines = text.match(/[^\n]*\n|[^\n]+/g) ?? [];
  let offset = 0;
  let start = -1;
  let side: "ours" | "base" | "theirs" = "ours";
  let base: string | null = null;
  let ours = "";
  let theirs = "";
  for (const line of lines) {
    if (marker(line, "<", size)) {
      start = offset;
      side = "ours";
      base = null;
      ours = "";
      theirs = "";
    } else if (start !== -1) {
      if (side === "ours" && marker(line, "|", size)) {
        side = "base";
        base = "";
      } else if (side !== "theirs" && marker(line, "=", size)) {
        side = "theirs";
      } else if (side === "theirs" && marker(line, ">", size)) {
        hunks.push({ index: hunks.length, start, end: offset + line.length, base, ours, theirs });
        start = -1;
      } else if (side === "ours") {
        ours += line;
      } else if (side === "base") {
        base += line;
      } else {
        theirs += line;
      }
    }
    offset += line.length;
  }
  return hunks;
}

function hasMarker(text: string, size: number): boolean {
  return text
    .split("\n")
    .some((line) => marker(line, "<", size) || marker(line, ">", size) || marker(line, "|", size));
}

function staleSnapshot(): GitWorkbenchError {
  return new GitWorkbenchError(
    "The conflict changed. Inspect it again before resolving it.",
    "STALE_CONFLICT_SNAPSHOT",
  );
}

async function readStages(
  repo: GitWorktree,
  path: string,
): Promise<[Stage | null, Stage | null, Stage | null]> {
  const { stdout } = await git(repo, [
    "--literal-pathspecs",
    "ls-files",
    "--unmerged",
    "-z",
    "--",
    path,
  ]);
  const stages: [Stage | null, Stage | null, Stage | null] = [null, null, null];
  for (const record of stdout.split("\0").filter(Boolean)) {
    const match = /^(\d+) ([0-9a-f]{40}|[0-9a-f]{64}) ([123])\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Unexpected Git conflict stage");
    if (match[4] === path) stages[Number(match[3]) - 1] = { mode: match[1]!, sha: match[2]! };
  }
  if (stages.every((stage) => stage === null)) throw staleSnapshot();
  return stages;
}

async function snapshot(
  repo: GitWorktree,
  path: string,
  status: CheckoutGitConflictFile["status"],
): Promise<Snapshot> {
  validatePath(path);
  const absolute = await safePath(repo, path);
  const [stages, state, size] = await Promise.all([
    readStages(repo, path),
    readFileState(absolute),
    markerSize(repo, path),
  ]);
  const [baseStage, oursStage, theirsStage] = stages;
  const text = state.type === "file" ? decodeText(state.bytes) : null;
  const hunks = text === null ? [] : parseHunks(text, size);
  const fingerprint = createHash("sha256").update(
    JSON.stringify([
      repo.root,
      path,
      status,
      stages,
      size,
      state.type,
      state.type === "file" ? state.mode : null,
    ]),
  );
  if (state.type !== "missing") fingerprint.update(state.bytes);
  return {
    conflict: {
      path,
      status,
      base: baseStage,
      ours: oursStage,
      theirs: theirsStage,
      conflictFingerprint: fingerprint.digest("hex"),
      hunks: hunks.map(({ index, base, ours, theirs }) => ({ index, base, ours, theirs })),
    },
    state,
    text,
    hunks,
    markerSize: size,
  };
}

export async function inspectConflicts(
  repo: GitWorktree,
  path?: string,
): Promise<CheckoutGitConflictFile[]> {
  if (path !== undefined) validatePath(path);
  const { conflicts } = await readChanges(repo);
  const filtered =
    path === undefined ? conflicts : conflicts.filter((entry) => entry.path === path);
  if (filtered.length > MAX_INSPECT_PATHS) throw new Error("Select a single conflict to inspect");
  const result: CheckoutGitConflictFile[] = [];
  let bytes = 0;
  for (const entry of filtered) {
    const { conflict } = await snapshot(repo, entry.path, entry.status);
    bytes += Buffer.byteLength(JSON.stringify(conflict));
    if (bytes > MAX_INSPECT_BYTES) throw new Error("Select a single conflict to inspect");
    result.push(conflict);
  }
  return result;
}

async function readStageBlob(repo: GitWorktree, stage: Stage, path: string): Promise<Buffer> {
  if (stage.mode !== "100644" && stage.mode !== "100755")
    throw new Error("Choose a text hunk or resolve this non-regular file manually");
  const result = await runGitCommandBytes(["cat-file", "--filters", "--path=" + path, stage.sha], {
    cwd: repo.root,
    maxOutputBytes: MAX_FILE_BYTES,
    envOverlay: { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
  });
  if (result.truncated) throw new Error("Conflict stage exceeds 512 KiB");
  return result.stdout;
}

async function replaceFile(path: string, bytes: Buffer, mode: number): Promise<void> {
  const temp = join(dirname(path), ".paseo-conflict-" + randomUUID());
  try {
    await writeFile(temp, bytes, { mode: mode & 0o777, flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

// Call under the shared worktree and repository write lock.
export async function resolveConflict(repo: GitWorktree, input: ResolveRequest): Promise<void> {
  validatePath(input.path);
  const absolute = await safePath(repo, input.path);
  const entry = (await readChanges(repo)).conflicts.find(({ path }) => path === input.path);
  if (!entry) throw staleSnapshot();
  const original = await snapshot(repo, input.path, entry.status);
  if (original.conflict.conflictFingerprint !== input.expectedConflictFingerprint)
    throw staleSnapshot();
  let replacement: { bytes: Buffer; mode: number } | null | undefined;
  let stage = true;

  if (input.strategy === "mark_resolved") {
    if (input.hunkIndex !== undefined) throw new Error("Mark resolved applies to the entire file");
    if (original.text !== null && hasMarker(original.text, original.markerSize))
      throw new Error("Remove all conflict markers before staging the file");
  } else if (input.hunkIndex !== undefined) {
    const hunk = original.hunks[input.hunkIndex];
    if (!hunk || original.text === null || original.state.type !== "file")
      throw new Error("Select a valid text conflict hunk");
    const content = input.strategy === "both" ? hunk.ours + hunk.theirs : hunk[input.strategy];
    const resolved = original.text.slice(0, hunk.start) + content + original.text.slice(hunk.end);
    replacement = { bytes: Buffer.from(resolved), mode: original.state.mode };
    stage = !hasMarker(resolved, original.markerSize);
  } else {
    if (input.strategy === "both")
      throw new Error("Select a text conflict hunk to keep both sides");
    if (original.state.type === "link") throw new Error("Resolve this symbolic link manually");
    const side = original.conflict[input.strategy];
    replacement = side
      ? { bytes: await readStageBlob(repo, side, input.path), mode: parseInt(side.mode, 8) }
      : null;
  }

  // Reading the blob can take time. Compare again before writing user files.
  const latest = await snapshot(repo, input.path, entry.status);
  if (latest.conflict.conflictFingerprint !== input.expectedConflictFingerprint)
    throw staleSnapshot();
  if (replacement) await replaceFile(absolute, replacement.bytes, replacement.mode);
  else if (replacement === null && original.state.type === "file") await rm(absolute);
  if (stage) await git(repo, ["--literal-pathspecs", "add", "-A", "--", input.path]);
}
