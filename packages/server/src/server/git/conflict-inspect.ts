import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, rename, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { runGitCommandBytes } from "../../utils/run-git-command.js";
import {
  CHECKOUT_GIT_MAX_CONFLICT_TEXT_BYTES,
  type CheckoutGitConflictFile,
  type SessionInboundMessage,
} from "../messages.js";
import { git, GitWorkbenchError, readChanges, validateGitPaths } from "./git-workbench-state.js";
import type { GitWorktree } from "./repo-write-mutex.js";
import { withStagedCommitLock } from "./staged-snapshot.js";

type ResolveRequest = Extract<
  SessionInboundMessage,
  { type: "checkout.git.conflict.resolve.request" }
>;
type Stage = NonNullable<CheckoutGitConflictFile["base"]>;
type ConflictHunk = CheckoutGitConflictFile["hunks"][number];
type FileState =
  | { type: "missing" }
  | { type: "link"; bytes: Buffer }
  | { type: "file"; bytes: Buffer; mode: number; dev: number; ino: number };
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

const MAX_FILE_BYTES = CHECKOUT_GIT_MAX_CONFLICT_TEXT_BYTES;
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

export async function safeRepoPath(repo: GitWorktree, path: string): Promise<string> {
  validatePath(path);
  const components = process.platform === "win32" ? path.split(/[/\\]/) : path.split("/");
  let parent = repo.root;
  for (const component of components.slice(0, -1)) {
    parent = join(parent, component);
    const info = await lstat(parent).catch(missing);
    if (info && !info.isDirectory())
      throw new Error("The path crosses a non-directory or symbolic link");
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
    const latest = await lstat(path).catch(missing);
    if (
      !latest ||
      latest.dev !== opened.dev ||
      latest.ino !== opened.ino ||
      latest.size !== size ||
      latest.mtimeMs !== opened.mtimeMs ||
      latest.ctimeMs !== opened.ctimeMs
    )
      throw staleSnapshot();
    return {
      type: "file",
      bytes: buffer.subarray(0, size),
      mode: opened.mode,
      dev: opened.dev,
      ino: opened.ino,
    };
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
  const absolute = await safeRepoPath(repo, path);
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
  includeContents?: boolean,
): Promise<CheckoutGitConflictFile[]> {
  if (includeContents && path === undefined)
    throw new Error("Select a single conflict to read its contents");
  if (path !== undefined) validatePath(path);
  const { conflicts } = await readChanges(repo);
  const filtered =
    path === undefined ? conflicts : conflicts.filter((entry) => entry.path === path);
  if (filtered.length > MAX_INSPECT_PATHS) throw new Error("Select a single conflict to inspect");
  const result: CheckoutGitConflictFile[] = [];
  let bytes = 0;
  for (const entry of filtered) {
    const state = await snapshot(repo, entry.path, entry.status);
    const { conflict } = state;
    bytes += Buffer.byteLength(JSON.stringify(conflict));
    if (bytes > MAX_INSPECT_BYTES) throw new Error("Select a single conflict to inspect");
    if (includeContents) {
      const contents = await readConflictContents(repo, state);
      if (
        contents &&
        bytes + Buffer.byteLength(JSON.stringify(contents)) < MAX_INSPECT_BYTES - 1024
      )
        conflict.contents = contents;
    }
    result.push(conflict);
  }
  return result;
}

async function readConflictContents(
  repo: GitWorktree,
  state: Snapshot,
): Promise<CheckoutGitConflictFile["contents"]> {
  if (state.state.type !== "missing" && state.text === null) return;
  const read = async (stage: Stage | null) => {
    if (!stage) return null;
    if (stage.mode !== "100644" && stage.mode !== "100755") return undefined;
    const result = await runGitCommandBytes(["cat-file", "blob", stage.sha], {
      cwd: repo.root,
      maxOutputBytes: MAX_FILE_BYTES,
      envOverlay: { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
    }).catch(() => undefined);
    if (!result || result.truncated) return undefined;
    return decodeText(result.stdout) ?? undefined;
  };
  const { base, ours, theirs } = state.conflict;
  const [baseText, oursText, theirsText] = await Promise.all([
    read(base),
    read(ours),
    read(theirs),
  ]);
  if (baseText === undefined || oursText === undefined || theirsText === undefined) return;
  return { base: baseText, ours: oursText, theirs: theirsText, result: state.text };
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

async function replaceFile(
  path: string,
  bytes: Buffer,
  mode: number,
  verify?: () => Promise<void>,
) {
  const temp = join(dirname(path), ".paseo-conflict-" + randomUUID());
  const handle = await open(temp, "wx", mode & 0o777);
  try {
    const identity = await (async () => {
      await handle.writeFile(bytes);
      const { dev, ino, mode: writtenMode } = await handle.stat();
      return { dev, ino, mode: writtenMode };
    })().finally(() => handle.close());
    await verify?.();
    await rename(temp, path);
    return identity;
  } finally {
    await rm(temp, { force: true });
  }
}

// Call under the shared worktree and repository write lock.
export async function resolveConflict(repo: GitWorktree, input: ResolveRequest): Promise<void> {
  const absolute = await safeRepoPath(repo, input.path);
  const entry = (await readChanges(repo)).conflicts.find(({ path }) => path === input.path);
  if (!entry) throw staleSnapshot();
  const original = await snapshot(repo, input.path, entry.status);
  if (original.conflict.conflictFingerprint !== input.expectedConflictFingerprint)
    throw staleSnapshot();
  if (input.resultText !== undefined) {
    return saveEditedConflict(repo, input, original, absolute);
  }
  return resolveExistingConflict(repo, input, original, absolute);
}

async function resolveExistingConflict(
  repo: GitWorktree,
  input: ResolveRequest,
  original: Snapshot,
  absolute: string,
) {
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
  await verifyConflictSnapshot(repo, input, original.conflict.status);
  if (replacement) await replaceFile(absolute, replacement.bytes, replacement.mode);
  else if (replacement === null && original.state.type === "file") await rm(absolute);
  if (stage) await git(repo, ["--literal-pathspecs", "add", "-A", "--", input.path]);
}

async function verifyConflictSnapshot(
  repo: GitWorktree,
  input: ResolveRequest,
  status: CheckoutGitConflictFile["status"],
) {
  const latest = await snapshot(repo, input.path, status);
  if (latest.conflict.conflictFingerprint !== input.expectedConflictFingerprint)
    throw staleSnapshot();
}

async function saveEditedConflict(
  repo: GitWorktree,
  input: ResolveRequest,
  original: Snapshot,
  absolute: string,
) {
  const replacement = await editedResult(repo, original, input);
  let written: Awaited<ReturnType<typeof replaceFile>> | undefined;
  let staged: { sha: string; mode: string } | undefined;
  const verifyWrittenFile = async () => {
    const path = await safeRepoPath(repo, input.path);
    const actual = await readFileState(path);
    if (
      !written ||
      actual.type !== "file" ||
      actual.dev !== written.dev ||
      actual.ino !== written.ino ||
      actual.mode !== written.mode ||
      !actual.bytes.equals(replacement.bytes)
    )
      throw staleSnapshot();
  };
  const { indexError } = await withStagedCommitLock(
    repo,
    async ({ envOverlay }) => {
      await verifyConflictSnapshot(repo, input, original.conflict.status);
      const { stdout } = await git(repo, ["hash-object", "-w", "--path=" + input.path, "--stdin"], {
        input: replacement.bytes,
        envOverlay,
      });
      const sha = stdout.trim();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha))
        throw new Error("Git did not return a conflict result object");
      const mode = replacement.mode & 0o100 ? "100755" : "100644";
      staged = { sha, mode };
      await git(repo, ["update-index", "--cacheinfo", mode, sha, input.path], { envOverlay });
      written = await replaceFile(absolute, replacement.bytes, replacement.mode, () =>
        verifyConflictSnapshot(repo, input, original.conflict.status),
      );
      if ((written.mode & 0o100 ? "100755" : "100644") !== mode) throw staleSnapshot();
    },
    {
      beforeInstall: async () => {
        const { base, ours, theirs } = original.conflict;
        const current = await readStages(repo, input.path);
        if (JSON.stringify(current) !== JSON.stringify([base, ours, theirs])) throw staleSnapshot();
        await verifyWrittenFile();
      },
      afterInstall: async () => {
        const { stdout } = await git(repo, [
          "--literal-pathspecs",
          "ls-files",
          "--stage",
          "-z",
          "--",
          input.path,
        ]);
        if (!staged || stdout !== staged.mode + " " + staged.sha + " 0\t" + input.path + "\0")
          throw staleSnapshot();
        await verifyWrittenFile();
      },
    },
  );
  if (indexError)
    throw new Error("The result was written, but Git's staged file changes could not be installed");
}

async function editedResult(repo: GitWorktree, original: Snapshot, input: ResolveRequest) {
  if (
    input.strategy !== "mark_resolved" ||
    input.hunkIndex !== undefined ||
    input.resultText === undefined
  )
    throw new Error("An edited result resolves the entire file");
  const text = input.resultText;
  const bytes = Buffer.from(text);
  if (bytes.length > MAX_FILE_BYTES || decodeText(bytes) !== text)
    throw new Error("Use a UTF-8 conflict result no larger than 512 KiB");
  if (hasMarker(text, original.markerSize))
    throw new Error("Remove all conflict markers before staging the file");
  if (!(await readConflictContents(repo, original)))
    throw new Error("The conflict does not have editable text contents");
  const mode =
    original.state.type === "file"
      ? original.state.mode
      : parseInt(
          original.conflict.ours?.mode ??
            original.conflict.theirs?.mode ??
            original.conflict.base?.mode ??
            "100644",
          8,
        );
  return { bytes, mode };
}
