import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import nodePath from "node:path";
import { z } from "zod";
import {
  checkpointGit,
  decodeGit,
  lstatIfExists,
  nulList,
  refuse,
  type WorktreeIdentity,
} from "./worktree.js";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TREE_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 50_000;

export const oidSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const relativeFileSchema = z.string().refine(isSafeRelativeFile, "Unsafe checkpoint path");
const indexEntrySchema = z.object({
  path: relativeFileSchema,
  oid: oidSchema,
  mode: z.enum(["100644", "100755"]),
});
const fileEntrySchema = z.object({
  path: relativeFileSchema,
  oid: oidSchema,
  mode: z.number().int().min(0).max(0o777),
});
export const snapshotSchema = z.object({
  head: oidSchema,
  branch: z.string().nullable(),
  format: z.enum(["sha1", "sha256"]),
  committed: z.array(indexEntrySchema),
  index: z.array(indexEntrySchema),
  files: z.array(fileEntrySchema),
});

export type FileSnapshot = z.infer<typeof snapshotSchema>;
export type FileEntry = z.infer<typeof fileEntrySchema>;
export type IndexEntry = z.infer<typeof indexEntrySchema>;

export function isSafeRelativeFile(file: string): boolean {
  return file
    .split("/")
    .every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        !/[\\:*?"<>|]/u.test(part) &&
        !Array.from(part).some((character) => character.charCodeAt(0) < 32) &&
        !/[. ]$/u.test(part) &&
        part.toLowerCase().replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu, "") !==
          ".git" &&
        !/^git~\d+$/iu.test(part) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
    );
}

export function requireSafePaths(paths: Iterable<string>): void {
  const aliases = new Map<string, string>();
  for (const file of paths) {
    if (!isSafeRelativeFile(file)) refuse("Unsafe path in checkpoint tree");
    let prefix = "";
    for (const part of file.split("/")) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const key = prefix.normalize("NFC").toLowerCase();
      const previous = aliases.get(key);
      if (previous !== undefined && previous !== prefix)
        refuse("Ambiguous paths in checkpoint tree");
      aliases.set(key, prefix);
    }
  }
}

export function gitBlobId(data: Buffer, format: FileSnapshot["format"]): string {
  return createHash(format).update(`blob ${data.length}\0`).update(data).digest("hex");
}

function sortByPath<T extends { path: string }>(entries: T[]): T[] {
  return entries.sort((a, b) => {
    if (a.path === b.path) return 0;
    return a.path < b.path ? -1 : 1;
  });
}

async function gitText(args: string[], root: string): Promise<string> {
  return decodeGit(await checkpointGit(args, root)).trimEnd();
}

export async function readHead(
  root: string,
): Promise<Pick<FileSnapshot, "head" | "branch" | "format">> {
  const output = await gitText(
    ["rev-parse", "--show-object-format", "HEAD^{commit}", "--symbolic-full-name", "HEAD"],
    root,
  );
  const [format, head, ref, ...rest] = output.split("\n");
  if (
    rest.length ||
    (format !== "sha1" && format !== "sha256") ||
    !oidSchema.safeParse(head).success ||
    (ref !== "HEAD" && !ref?.startsWith("refs/heads/"))
  ) {
    refuse("Unsupported Git HEAD or object format");
  }
  return { head, branch: ref === "HEAD" ? null : ref, format };
}

export interface RestoreIndexLockIdentity {
  dev: bigint;
  ino: bigint;
}

async function requireSafeIndexFiles(
  worktree: WorktreeIdentity,
  ownedLock?: RestoreIndexLockIdentity,
): Promise<void> {
  for (const name of [
    "index",
    "index.lock",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-apply",
    "rebase-merge",
    "sequencer",
    "BISECT_START",
  ]) {
    const info = await lstatIfExists(nodePath.join(worktree.admin, name));
    if (name === "index.lock" && ownedLock) {
      if (!info?.isFile() || info.dev !== ownedLock.dev || info.ino !== ownedLock.ino) {
        refuse("The Git index lock changed during file restore");
      }
      continue;
    }
    if (info && (name !== "index" || !info.isFile() || info.nlink !== 1n)) {
      refuse("Git index or in-progress operation cannot be checkpointed");
    }
  }
}

export async function requireSupportedIndex(
  worktree: WorktreeIdentity,
  ownedLock?: RestoreIndexLockIdentity,
): Promise<void> {
  await requireSafeIndexFiles(worktree, ownedLock);
  const config = nulList(await checkpointGit(["config", "--null", "--list"], worktree.root));
  for (const entry of config) {
    const newline = entry.indexOf("\n");
    const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
    const value =
      newline < 0
        ? ""
        : entry
            .slice(newline + 1)
            .trim()
            .toLowerCase();
    const enabled = !["false", "no", "off", "0"].includes(value);
    if (
      (key === "core.sparsecheckout" ||
        key === "index.sparse" ||
        key === "core.splitindex" ||
        key === "core.autocrlf") &&
      enabled
    ) {
      refuse("Sparse, split, or line-ending converting Git checkouts are unsupported");
    }
    if (key === "extensions.partialclone" || key === "core.worktree") {
      refuse("Git checkout configuration is unsupported");
    }
  }
}

export async function readIndex(root: string, indexFile?: string): Promise<IndexEntry[]> {
  const raw = decodeGit(
    await checkpointGit(["ls-files", "-v", "--stage", "--debug", "-z"], root, undefined, indexFile),
  );
  const entries: IndexEntry[] = [];
  const record =
    // oxlint-disable-next-line eslint/no-control-regex -- Git separates pathnames with a NUL.
    /([A-Z]) (100644|100755) ([0-9a-f]+) 0\t([^\0]+)\0  ctime: [^\n]*\n  mtime: [^\n]*\n  dev: [^\n]*\n  uid: [^\n]*\n  size: [^\n]*\tflags: ([0-9a-f]+)\n/guy;
  while (record.lastIndex < raw.length) {
    const match = record.exec(raw);
    if (!match || match[1] !== "H" || Number.parseInt(match[5], 16) !== 0) {
      refuse(
        "Unsupported Git index entry (conflict, sparse, submodule, symlink, or special flags)",
      );
    }
    entries.push(indexEntrySchema.parse({ mode: match[2], oid: match[3], path: match[4] }));
  }
  return sortByPath(entries);
}

async function readCommitted(root: string, head: string): Promise<IndexEntry[]> {
  return sortByPath(
    nulList(await checkpointGit(["ls-tree", "-rz", head], root)).map((record) => {
      const match = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/u.exec(record);
      if (!match) refuse("Git tree contains an unsupported symlink or submodule");
      return indexEntrySchema.parse({ path: match[3], mode: match[1], oid: match[2] });
    }),
  );
}

export async function requireUnfilteredPaths(root: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const input = Buffer.from(paths.join("\0") + "\0");
  const attributes = ["filter", "working-tree-encoding", "text", "eol", "ident", "crlf"];
  for (const source of [[], ["--cached"]]) {
    const results = nulList(
      await checkpointGit(["check-attr", ...source, "-z", "--stdin", ...attributes], root, input),
    );
    if (results.length !== paths.length * attributes.length * 3)
      refuse("Incomplete Git attributes");
    for (let index = 2; index < results.length; index += 3) {
      if (results[index] !== "unspecified" && results[index] !== "unset")
        refuse("Git content filters are unsupported");
    }
  }
}

async function isNestedRepository(candidate: string): Promise<boolean> {
  if (await lstatIfExists(nodePath.join(candidate, ".git"))) return true;
  const head = await lstatIfExists(nodePath.join(candidate, "HEAD"));
  if (!head) return false;
  return Boolean(
    (await lstatIfExists(nodePath.join(candidate, "objects"))) &&
    (await lstatIfExists(nodePath.join(candidate, "refs"))),
  );
}

export type PathKind = "absent" | "directory" | "file";

/** Checks every ancestor, including for paths absent at the requested end of a restore. */
export async function inspectPath(worktree: WorktreeIdentity, relative: string): Promise<PathKind> {
  if (!isSafeRelativeFile(relative)) refuse("Unsafe path in checkpoint tree");
  const rootInfo = await lstatIfExists(worktree.root);
  if (!rootInfo?.isDirectory() || `${rootInfo.dev}:${rootInfo.ino}` !== worktree.rootIdentity) {
    refuse("Checkpoint worktree was replaced");
  }
  const parts = relative.split("/");
  let candidate = worktree.root;
  for (const [index, part] of parts.entries()) {
    candidate = nodePath.join(candidate, part);
    const info = await lstatIfExists(candidate);
    if (!info) return "absent";
    if (info.isSymbolicLink()) refuse("Checkpoint paths cannot contain symbolic links");
    if (info.dev !== rootInfo.dev || (await realpath(candidate)) !== candidate) {
      refuse("Checkpoint path aliases or crosses a filesystem boundary");
    }
    if (info.isDirectory()) {
      if (await isNestedRepository(candidate)) refuse("Nested repositories are unsupported");
      if (index === parts.length - 1) return "directory";
      continue;
    }
    if (!info.isFile() || info.nlink !== 1n || (info.mode & 0o7000n) !== 0n) {
      refuse("Checkpoint paths must contain ordinary files");
    }
    return index === parts.length - 1 ? "file" : "absent";
  }
  return "absent";
}

export async function readWorktreeFile(input: {
  worktree: WorktreeIdentity;
  relative: string;
  format: FileSnapshot["format"];
}): Promise<{ entry: FileEntry; bytes: Buffer } | null> {
  const { worktree, relative, format } = input;
  if ((await inspectPath(worktree, relative)) !== "file") return null;
  const absolute = nodePath.join(worktree.root, relative);
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (before.mode & 0o7000n) !== 0n ||
      before.size > BigInt(MAX_FILE_BYTES)
    )
      refuse("Unsupported or oversized checkpoint file");
    const bytes = Buffer.alloc(Number(before.size));
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
      if (!bytesRead) refuse("Worktree file changed during checkpoint capture");
      read += bytesRead;
    }
    await inspectPath(worktree, relative);
    const [after, current] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(absolute, { bigint: true }),
    ]);
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      !current.isFile()
    ) {
      refuse("Worktree file changed during checkpoint capture");
    }
    return {
      entry: { path: relative, oid: gitBlobId(bytes, format), mode: Number(before.mode & 0o777n) },
      bytes,
    };
  } finally {
    await handle.close();
  }
}

export async function readIndexBlob(
  root: string,
  oid: string,
  format: FileSnapshot["format"],
): Promise<Buffer> {
  const bytes = await checkpointGit(["cat-file", "blob", oidSchema.parse(oid)], root);
  if (bytes.length > MAX_FILE_BYTES || gitBlobId(bytes, format) !== oid) {
    refuse("Unsupported or oversized staged checkpoint file");
  }
  return bytes;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function sameEntry<T extends { mode: string | number; oid: string }>(
  left?: T,
  right?: T,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.mode === right.mode &&
      left.oid === right.oid)
  );
}

export async function captureWorktreeSnapshot(input: {
  worktree: WorktreeIdentity;
  ownedIndexLock?: RestoreIndexLockIdentity;
  saveBlob?: (oid: string, bytes: Buffer) => Promise<void>;
}): Promise<FileSnapshot> {
  const { worktree, saveBlob } = input;
  await requireSupportedIndex(worktree, input.ownedIndexLock);
  const root = worktree.root;
  const [head, index, untracked] = await Promise.all([
    readHead(root),
    readIndex(root),
    checkpointGit(["ls-files", "--other", "--exclude-standard", "-z"], root),
  ]);
  const committed = await readCommitted(root, head.head);
  const paths = new Set([...index.map((item) => item.path), ...nulList(untracked)]);
  const checkedPaths = new Set([...paths, ...committed.map((item) => item.path)]);
  if (checkedPaths.size > MAX_FILES) refuse("Worktree exceeded the checkpoint path limit");
  requireSafePaths(checkedPaths);
  await requireUnfilteredPaths(root, [...checkedPaths]);
  const files: FileEntry[] = [];
  let total = 0;
  for (const relative of paths) {
    const result = await readWorktreeFile({ worktree, relative, format: head.format });
    if (!result) continue;
    total += result.bytes.length;
    if (total > MAX_TREE_BYTES) refuse("Worktree exceeded the checkpoint byte limit");
    await saveBlob?.(result.entry.oid, result.bytes);
    files.push(result.entry);
  }
  if (saveBlob) {
    const saved = new Set(files.map(({ oid }) => oid));
    for (const { oid } of index) {
      if (saved.has(oid)) continue;
      const bytes = await readIndexBlob(root, oid, head.format);
      total += bytes.length;
      if (total > MAX_TREE_BYTES) refuse("Worktree exceeded the checkpoint byte limit");
      await saveBlob(oid, bytes);
      saved.add(oid);
    }
  }
  // Also check paths deleted from the index, where ignored replacements must never hide a link.
  for (const { path: relative } of committed) {
    if (!paths.has(relative)) await inspectPath(worktree, relative);
  }
  const [afterHead, afterIndex, afterUntracked] = await Promise.all([
    readHead(root),
    readIndex(root),
    checkpointGit(["ls-files", "--other", "--exclude-standard", "-z"], root),
  ]);
  if (
    !jsonEqual(head, afterHead) ||
    !jsonEqual(index, afterIndex) ||
    !untracked.equals(afterUntracked)
  ) {
    refuse("Git worktree changed during checkpoint capture");
  }
  return { ...head, committed, index, files: sortByPath(files) };
}

export interface EntryChange<T> {
  path: string;
  kind: "added" | "deleted" | "modified";
  before: T | null;
  after: T | null;
}

export function diffEntries<T extends { path: string; mode: string | number; oid: string }>(
  before: T[],
  after: T[],
): EntryChange<T>[] {
  const from = new Map(before.map((entry) => [entry.path, entry]));
  const to = new Map(after.map((entry) => [entry.path, entry]));
  return sortByPath(
    [...new Set([...from.keys(), ...to.keys()])].flatMap<EntryChange<T>>((path) => {
      const previous = from.get(path);
      const next = to.get(path);
      if (sameEntry(previous, next)) return [];
      if (previous === undefined)
        return [{ path, kind: "added", before: null, after: next ?? null }];
      const kind = next === undefined ? "deleted" : "modified";
      return [{ path, kind, before: previous ?? null, after: next ?? null }];
    }),
  );
}

export function diffSnapshots(before: FileSnapshot, after: FileSnapshot) {
  return {
    files: diffEntries(before.files, after.files),
    index: diffEntries(before.index, after.index),
  };
}

export function describeSnapshotChanges(snapshot: FileSnapshot) {
  const files: IndexEntry[] = snapshot.files.map(({ path, oid, mode }) => ({
    path,
    oid,
    mode: (mode & 0o100) !== 0 ? "100755" : "100644",
  }));
  return {
    staged: diffEntries(snapshot.committed, snapshot.index),
    unstaged: diffEntries(snapshot.index, files),
  };
}
