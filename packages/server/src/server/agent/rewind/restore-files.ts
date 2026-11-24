import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  diffEntries,
  diffSnapshots,
  inspectPath,
  readHead,
  readIndex,
  readWorktreeFile,
  requireSafePaths,
  requireSupportedIndex,
  requireUnfilteredPaths,
  sameEntry,
  type EntryChange,
  type FileEntry,
  type FileSnapshot,
  type IndexEntry,
  type RestoreIndexLockIdentity,
} from "../checkpoints/snapshot.js";
import {
  checkpointGit,
  decodeGit,
  isMissing,
  lstatIfExists,
  refuse,
  type WorktreeIdentity,
} from "../checkpoints/worktree.js";

export function requireSameHead(before: FileSnapshot, after: FileSnapshot): void {
  if (
    before.head !== after.head ||
    before.branch !== after.branch ||
    before.format !== after.format
  ) {
    refuse("Git HEAD or branch changed since the checkpoint");
  }
}

export function planFileRestore(before: FileSnapshot, after: FileSnapshot) {
  requireSameHead(before, after);
  const changes = diffSnapshots(before, after);
  const files = [
    ...changes.files.filter((change) => change.kind === "deleted").toReversed(),
    ...changes.files.filter((change) => change.kind !== "deleted"),
  ];
  requireSafePaths([
    ...before.files.map((entry) => entry.path),
    ...after.files.map((entry) => entry.path),
    ...before.index.map((entry) => entry.path),
    ...after.index.map((entry) => entry.path),
  ]);
  return { files, index: changes.index };
}

export type FileRestorePlan = ReturnType<typeof planFileRestore>;

export async function verifyRestorePlan(input: {
  worktree: WorktreeIdentity;
  plan: FileRestorePlan;
  before: FileSnapshot;
  after: FileSnapshot;
}): Promise<void> {
  const { worktree, plan, before, after } = input;
  await requireUnfilteredPaths(worktree.root, [
    ...new Set([
      ...plan.files.map((change) => change.path),
      ...plan.index.map((change) => change.path),
    ]),
  ]);
  const deletions = new Set(
    plan.files.filter((change) => !change.after).map((change) => change.path),
  );
  for (const change of plan.files) {
    const actual = await readWorktreeFile({
      worktree,
      relative: change.path,
      format: before.format,
    });
    if (!sameEntry(actual?.entry, change.before ?? undefined)) {
      refuse("An ignored or changed file blocks the checkpoint restore");
    }
    if (change.after && (await inspectPath(worktree, change.path)) === "directory") {
      await listRemovableDirectories({ worktree, relative: change.path, deletions });
    }
  }
  const [root, admin] = await Promise.all([
    lstatIfExists(worktree.root),
    lstatIfExists(worktree.admin),
  ]);
  if (plan.files.some((change) => change.after) && (!root || !admin || root.dev !== admin.dev)) {
    refuse("Worktree and Git directory must share a filesystem for atomic file restore");
  }
  await requireIndexObjects(worktree.root, after.index, plan.index);
}

async function listRemovableDirectories(input: {
  worktree: WorktreeIdentity;
  relative: string;
  deletions: ReadonlySet<string>;
}): Promise<string[]> {
  const { worktree, relative, deletions } = input;
  if ((await inspectPath(worktree, relative)) !== "directory") return [];
  const dirs: string[] = [];
  for (const name of await readdir(path.join(worktree.root, relative))) {
    const child = `${relative}/${name}`;
    if (deletions.has(child) && (await inspectPath(worktree, child)) === "file") continue;
    if (
      [...deletions].some((file) => file.startsWith(`${child}/`)) &&
      (await inspectPath(worktree, child)) === "directory"
    ) {
      dirs.push(...(await listRemovableDirectories({ worktree, relative: child, deletions })));
    } else {
      refuse("An unrelated file or directory blocks the checkpoint restore");
    }
  }
  return [...dirs, relative];
}

async function verifyPathBeforeWrite(input: {
  worktree: WorktreeIdentity;
  change: EntryChange<FileEntry>;
  format: FileSnapshot["format"];
}): Promise<"before" | "after"> {
  const current = await readWorktreeFile({
    worktree: input.worktree,
    relative: input.change.path,
    format: input.format,
  });
  if (sameEntry(current?.entry, input.change.after ?? undefined)) return "after";
  if (sameEntry(current?.entry, input.change.before ?? undefined)) return "before";
  return refuse("A worktree file changed after the restore was prepared");
}

async function ensureParents(worktree: WorktreeIdentity, relative: string): Promise<void> {
  const pieces = relative.split("/").slice(0, -1);
  const prefix: string[] = [];
  for (const piece of pieces) {
    prefix.push(piece);
    const dir = prefix.join("/");
    const kind = await inspectPath(worktree, dir);
    if (kind === "file") refuse("A file blocks the checkpoint restore directory");
    if (kind === "absent") {
      await mkdir(path.join(worktree.root, dir));
      if ((await inspectPath(worktree, dir)) !== "directory") refuse("Restore directory changed");
    }
  }
}

export async function applyFileChange(input: {
  worktree: WorktreeIdentity;
  change: EntryChange<FileEntry>;
  format: FileSnapshot["format"];
  deletions: ReadonlySet<string>;
  readBlob: (entry: FileEntry) => Promise<Buffer>;
  validate?: () => Promise<void>;
}): Promise<void> {
  const { worktree, change, deletions } = input;
  if ((await verifyPathBeforeWrite(input)) === "after") return;
  const destination = path.join(worktree.root, change.path);
  if (!change.after) {
    await input.validate?.();
    if ((await verifyPathBeforeWrite(input)) === "before") await unlink(destination);
    return;
  }
  const bytes = await input.readBlob(change.after);
  const admin = await lstatIfExists(worktree.admin);
  if (!admin?.isDirectory() || `${admin.dev}:${admin.ino}` !== worktree.adminIdentity) {
    refuse("Worktree Git directory changed before file restore");
  }
  const temporary = path.join(worktree.admin, `paseo-restore-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.chmod(change.after.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await input.validate?.();
    if ((await verifyPathBeforeWrite(input)) === "after") return;
    for (const dir of await listRemovableDirectories({
      worktree,
      relative: change.path,
      deletions,
    })) {
      await rmdir(path.join(worktree.root, dir));
    }
    await ensureParents(worktree, change.path);
    await input.validate?.();
    if ((await verifyPathBeforeWrite(input)) === "before") await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

async function requireIndexObjects(
  root: string,
  target: IndexEntry[],
  changes: EntryChange<IndexEntry>[],
) {
  if (!changes.length) return;
  // Reference existing staged blobs only. Worktree snapshot bytes never enter Git's object database.
  const ids = [...new Set(target.map((entry) => entry.oid))];
  if (!ids.length) return;
  const output = decodeGit(
    await checkpointGit(
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
      root,
      Buffer.from(ids.join("\n") + "\n"),
    ),
  );
  const lines = output.trimEnd().split("\n");
  if (lines.length !== ids.length || lines.some((line, index) => line !== `${ids[index]} blob`)) {
    refuse("A staged checkpoint blob is no longer available in Git");
  }
}

async function unlinkIfPresent(file: string): Promise<void> {
  await unlink(file).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
}

export async function withRestoreIndexLock<T>(
  worktree: WorktreeIdentity,
  operationId: string,
  run: (identity: RestoreIndexLockIdentity) => Promise<T>,
): Promise<T> {
  const operationKey = createHash("sha256").update(operationId).digest("hex");
  const owner = path.join(worktree.admin, `paseo-index-lock-${operationKey}`);
  const lock = path.join(worktree.admin, "index.lock");
  const admin = await lstatIfExists(worktree.admin);
  if (!admin?.isDirectory() || `${admin.dev}:${admin.ino}` !== worktree.adminIdentity) {
    refuse("Worktree Git directory changed before file restore");
  }
  const release = async (identity: RestoreIndexLockIdentity) => {
    const current = await lstatIfExists(lock);
    if (current?.isFile() && current.dev === identity.dev && current.ino === identity.ino) {
      await unlink(lock);
    }
    await unlinkIfPresent(owner);
  };

  // Retrying this operation can remove its own lock after a daemon crash. An
  // unrelated Git lock has a different inode and is never removed.
  const previousOwner = await lstatIfExists(owner);
  if (previousOwner) {
    if (!previousOwner.isFile() || previousOwner.size !== 0n || previousOwner.nlink > 2n) {
      refuse("Unexpected file in Git index lock ownership path");
    }
    await release(previousOwner);
  }
  const handle = await open(owner, "wx", 0o600);
  const identity = await handle.stat({ bigint: true });
  await handle.close();
  try {
    await link(owner, lock);
    return await run(identity);
  } finally {
    await release(identity);
  }
}

export async function verifyRestoreGitState(input: {
  worktree: WorktreeIdentity;
  expected: FileSnapshot;
  ownedLock: RestoreIndexLockIdentity;
}): Promise<void> {
  const { worktree, expected, ownedLock } = input;
  await requireSupportedIndex(worktree, ownedLock);
  const head = await readHead(worktree.root);
  if (
    head.head !== expected.head ||
    head.branch !== expected.branch ||
    head.format !== expected.format
  ) {
    refuse("Git HEAD changed during file restore");
  }
  if (diffEntries(await readIndex(worktree.root), expected.index).length) {
    refuse("Git index changed during file restore");
  }
}

export async function applyIndexChanges(input: {
  worktree: WorktreeIdentity;
  before: FileSnapshot;
  after: FileSnapshot;
  ownedLock: RestoreIndexLockIdentity;
  validate: () => Promise<void>;
}): Promise<void> {
  const { worktree, before, after, ownedLock, validate } = input;
  const changes = diffEntries(before.index, after.index);
  if (!changes.length) return;
  await requireIndexObjects(worktree.root, after.index, changes);
  const zeros = "0".repeat(after.head.length);
  const removals = changes
    .filter((change) => change.before && !change.after)
    .map((change) => `0 ${zeros}\t${change.path}\0`);
  const additions = changes.flatMap(({ after: entry }) =>
    entry ? [`${entry.mode} ${entry.oid}\t${entry.path}\0`] : [],
  );
  const index = path.join(worktree.admin, "index");
  const prepared = path.join(worktree.admin, `paseo-restore-index-${randomUUID()}`);
  try {
    if (await lstatIfExists(index)) await copyFile(index, prepared);
    await checkpointGit(
      ["update-index", "-z", "--index-info"],
      worktree.root,
      Buffer.from(removals.concat(additions).join("")),
      prepared,
    );
    if (diffEntries(await readIndex(worktree.root, prepared), after.index).length) {
      refuse("Prepared staging does not match the checkpoint");
    }
    await validate();
    await verifyRestoreGitState({ worktree, expected: before, ownedLock });
    await rename(prepared, index);
  } finally {
    await unlinkIfPresent(prepared);
  }
}
