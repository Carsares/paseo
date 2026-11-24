import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdtemp, readdir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  absent,
  readOptional,
  REBASE_JOURNAL,
  REBASE_MARKER,
  REBASE_STATE_DIR,
} from "./controlled-rebase-state.js";
import { git } from "./git-workbench-state.js";
import type { GitWorktree } from "./repo-write-mutex.js";

const PREFIX = "refs/paseo/backup/";
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_BACKUPS = 20;
const CREATED_REF = /^refs\/paseo\/backup\/[a-z-]+-(\d{13})-[\da-f]{32}$/;
const REBASE_REF = /^refs\/paseo\/backup\/rebase-\d{13}-[\da-f]{32}$/;

export function newBackupRef(operation: string, id = randomUUID()): string {
  return `${PREFIX}${operation}-${Date.now()}-${id.replaceAll("-", "")}`;
}

export async function createBackupRef(
  repo: GitWorktree,
  operation: string,
  sha: string,
  id?: ReturnType<typeof randomUUID>,
) {
  const ref = newBackupRef(operation, id);
  await git(repo, ["update-ref", "--no-deref", ref, sha, ""]);
  return ref;
}

async function readInUseRebaseBackup(gitDir: string): Promise<string | null> {
  const stateDir = join(gitDir, REBASE_STATE_DIR);
  if (!(await lstat(stateDir).catch(absent))?.isDirectory()) return null;
  const marker = await readOptional(join(stateDir, REBASE_MARKER));
  const contents = await readOptional(join(gitDir, REBASE_JOURNAL));
  if (contents === null && marker === null) return null;
  const journal: unknown = contents === null ? null : JSON.parse(contents);
  if (
    !journal ||
    typeof journal !== "object" ||
    !("id" in journal) ||
    typeof journal.id !== "string" ||
    !("backupRef" in journal) ||
    typeof journal.backupRef !== "string" ||
    !REBASE_REF.test(journal.backupRef)
  )
    throw new Error("Cannot verify the backup for an active controlled rebase");
  if (marker !== null && marker !== journal.id) {
    throw new Error("Cannot identify the active controlled rebase backup");
  }
  return marker !== null || ("phase" in journal && journal.phase === "running")
    ? journal.backupRef
    : null;
}

async function inUseRebaseBackups(repo: GitWorktree): Promise<Set<string>> {
  const worktrees = join(repo.commonDir, "worktrees");
  const entries = await readdir(worktrees, { withFileTypes: true }).catch(absent);
  const gitDirs = new Set([repo.commonDir, repo.gitDir]);
  for (const entry of entries ?? []) {
    if (entry.isDirectory()) gitDirs.add(join(worktrees, entry.name));
  }
  const protectedRefs = new Set<string>();
  for (const gitDir of gitDirs) {
    const backup = await readInUseRebaseBackup(gitDir);
    if (backup) protectedRefs.add(backup);
  }
  return protectedRefs;
}

// Call under RepoWriteMutex. Its common-directory lock also covers linked worktrees.
export async function collectExpiredBackupRefs(repo: GitWorktree, now = Date.now()): Promise<void> {
  const { stdout } = await git(repo, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(symref)",
    PREFIX,
  ]);
  const entries = stdout
    .trimEnd()
    .split("\n")
    .flatMap((line) => {
      const [ref, sha, target] = line.split("\0");
      const time = ref && CREATED_REF.exec(ref)?.[1];
      return ref && sha && time && target === "" ? [{ ref, sha, timestamp: Number(time) }] : [];
    });
  entries.sort((a, b) => b.timestamp - a.timestamp || b.ref.localeCompare(a.ref));
  const protectedRefs = await inUseRebaseBackups(repo);
  let kept = 0;
  for (const entry of entries) {
    if (protectedRefs.has(entry.ref)) continue;
    if (kept >= MAX_BACKUPS || now - entry.timestamp >= RETENTION_MS) {
      // A ref can become symbolic after enumeration. Never follow it to a branch.
      await git(repo, ["update-ref", "--no-deref", "-d", entry.ref, entry.sha]);
    } else {
      kept++;
    }
  }
}

// The backup tip contains the selected paths as they appeared on disk; its
// parent is the staged snapshot. The parent's parent, if any, is the old HEAD.
export async function backupDiscardPaths(
  repo: GitWorktree,
  head: string | null,
  paths: string[],
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-git-backup-"));
  const index = join(directory, "index");
  const envOverlay = {
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: "Paseo",
    GIT_AUTHOR_EMAIL: "backup@paseo.invalid",
    GIT_COMMITTER_NAME: "Paseo",
    GIT_COMMITTER_EMAIL: "backup@paseo.invalid",
  };
  try {
    await copyFile(join(repo.gitDir, "index"), index).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    const stagedTree = (await git(repo, ["write-tree"], { envOverlay })).stdout.trim();
    const stagedCommit = (
      await git(
        repo,
        ["commit-tree", stagedTree, ...(head ? ["-p", head] : []), "-m", "Paseo staged backup"],
        { envOverlay },
      )
    ).stdout.trim();
    for (const path of paths) {
      await snapshotWorkingPath(repo, path, envOverlay);
    }
    const workingTree = (await git(repo, ["write-tree"], { envOverlay })).stdout.trim();
    const workingCommit = (
      await git(
        repo,
        ["commit-tree", workingTree, "-p", stagedCommit, "-m", "Paseo backup before discard"],
        { envOverlay },
      )
    ).stdout.trim();
    return await createBackupRef(repo, "discard", workingCommit);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Bypass clean filters so the backup blob retains the bytes that will be lost.
async function snapshotWorkingPath(
  repo: GitWorktree,
  path: string,
  envOverlay: Record<string, string>,
) {
  const absolute = join(repo.root, path);
  const info = await lstat(absolute).catch((error: unknown) => {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  });
  if (!info) {
    await git(repo, ["update-index", "--force-remove", "--", path], { envOverlay });
    return;
  }
  const parent = dirname(absolute);
  if ((await realpath(parent)) !== parent || (!info.isFile() && !info.isSymbolicLink())) {
    throw new Error(`Cannot back up non-file path: ${path}`);
  }
  const blob = info.isSymbolicLink()
    ? await git(repo, ["hash-object", "-w", "--stdin"], {
        input: await readlink(absolute, { encoding: "buffer" }),
      })
    : await git(repo, ["hash-object", "-w", "--no-filters", "--", absolute]);
  const regularMode = info.mode & 0o100 ? "100755" : "100644";
  const mode = info.isSymbolicLink() ? "120000" : regularMode;
  await git(repo, ["update-index", "--add", "--cacheinfo", mode, blob.stdout.trim(), path], {
    envOverlay,
  });
}
