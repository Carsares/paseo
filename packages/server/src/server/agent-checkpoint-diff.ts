import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import type { CheckpointStore } from "./agent/checkpoints/store.js";
import {
  diffEntries,
  readIndexBlob,
  type FileSnapshot,
  type EntryChange,
  type FileEntry,
  type IndexEntry,
} from "./agent/checkpoints/snapshot.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { parseDiff } from "./utils/diff-highlighter.js";

const MAX_PATCH_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_FILES = 256;

export async function readCheckpointDiff(input: {
  store: CheckpointStore;
  cwd: string;
  before: FileSnapshot;
  after: FileSnapshot;
}): Promise<{ files: ParsedDiffFile[]; stagedFiles: ParsedDiffFile[]; diffTooLarge: boolean }> {
  const { store, cwd, before, after } = input;
  const worktreeChanges = diffEntries(before.files, after.files);
  const stagingChanges = diffEntries(before.index, after.index);
  if (!worktreeChanges.length && !stagingChanges.length) {
    return { files: [], stagedFiles: [], diffTooLarge: false };
  }
  const scratchDirectory = await mkdtemp(join(tmpdir(), "paseo-checkpoint-diff-"));
  try {
    const readStaged = async (oid: string, format: FileSnapshot["format"]) =>
      (await store.findBlob(oid, format)) ?? readIndexBlob(cwd, oid, format);
    const options = {
      scratchDirectory,
      formats: [before.format, after.format] as const,
      remainingBytes: MAX_RESPONSE_BYTES,
    };
    const worktree = await renderChanges(worktreeChanges, options, (oid, format) =>
      store.getBlob(oid, format),
    );
    const staged = await renderChanges(stagingChanges, options, readStaged);
    return {
      files: worktree.files,
      stagedFiles: staged.files,
      diffTooLarge: worktree.diffTooLarge || staged.diffTooLarge,
    };
  } finally {
    await rm(scratchDirectory, { force: true, recursive: true });
  }
}

async function renderChanges(
  changes: EntryChange<FileEntry | IndexEntry>[],
  options: {
    scratchDirectory: string;
    formats: readonly FileSnapshot["format"][];
    remainingBytes: number;
  },
  readBlob: (oid: string, format: FileSnapshot["format"]) => Promise<Buffer>,
) {
  const files: ParsedDiffFile[] = [];
  let diffTooLarge = changes.length > MAX_FILES;
  for (const change of changes.slice(0, MAX_FILES)) {
    const file = {
      path: change.path,
      isNew: change.kind === "added",
      isDeleted: change.kind === "deleted",
      hunks: [],
      additions: 0,
      deletions: 0,
    };
    const [oldBytes, newBytes] = await Promise.all([
      change.before ? readBlob(change.before.oid, options.formats[0]) : null,
      change.after ? readBlob(change.after.oid, options.formats[1]) : null,
    ]);
    if (oldBytes?.includes(0) || newBytes?.includes(0)) {
      files.push({ ...file, status: "binary" });
      continue;
    }
    const budget = Math.min(MAX_PATCH_BYTES, options.remainingBytes);
    if (budget <= 0 || (oldBytes?.length ?? 0) + (newBytes?.length ?? 0) > MAX_RESPONSE_BYTES) {
      files.push({ ...file, status: "too_large" });
      diffTooLarge = true;
      continue;
    }
    const patch = await diffBlobs({
      scratchDirectory: options.scratchDirectory,
      oldBytes,
      newBytes,
      budget,
    });
    if (patch.truncated) {
      files.push({ ...file, status: "too_large" });
      diffTooLarge = true;
    } else {
      options.remainingBytes -= Buffer.byteLength(patch.stdout);
      const parsed = parseDiff(patch.stdout)[0];
      files.push(parsed ? { ...parsed, path: change.path, oldPath: undefined } : file);
    }
  }
  return { files, diffTooLarge };
}

async function diffBlobs(input: {
  scratchDirectory: string;
  oldBytes: Buffer | null;
  newBytes: Buffer | null;
  budget: number;
}) {
  const { scratchDirectory, oldBytes, newBytes, budget } = input;
  await Promise.all([
    oldBytes && writeFile(join(scratchDirectory, "before"), oldBytes, { mode: 0o600 }),
    newBytes && writeFile(join(scratchDirectory, "after"), newBytes, { mode: 0o600 }),
  ]);
  return runGitCommand(
    [
      "--no-pager",
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--",
      oldBytes ? "before" : "/dev/null",
      newBytes ? "after" : "/dev/null",
    ],
    {
      cwd: scratchDirectory,
      maxOutputBytes: budget,
      acceptExitCodes: [0, 1],
      envOverlay: {
        ...Object.fromEntries(
          Object.keys(process.env)
            .filter((key) => key.toUpperCase().startsWith("GIT_"))
            .map((key) => [key, undefined]),
        ),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        LC_ALL: "C",
      },
    },
  );
}
