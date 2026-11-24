import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { z } from "zod";
import { runGitCommandBytes } from "../../../utils/run-git-command.js";
import { isPaseoOwnedWorktreeCwd } from "../../../utils/worktree.js";
import { readPaseoWorktreeMetadata } from "../../../utils/worktree-metadata.js";

export interface CheckpointScope {
  workspaceId: string;
  agentId: string;
  cwd: string;
  /** Facts supplied by the daemon registry and agent hierarchy, never by an RPC request. */
  worktreeRoot: string;
  projectRoot: string;
  exclusive: boolean;
  isController: boolean;
}

export interface CheckpointWorktreeOptions {
  paseoHome: string;
  worktreesRoot?: string;
}

export const worktreeIdentitySchema = z.object({
  root: z.string(),
  admin: z.string(),
  common: z.string(),
  rootIdentity: z.string(),
  adminIdentity: z.string(),
});

export type WorktreeIdentity = z.infer<typeof worktreeIdentitySchema>;

export class CheckpointSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointSafetyError";
  }
}

export function refuse(message: string): never {
  throw new CheckpointSafetyError(message);
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function lstatIfExists(file: string) {
  try {
    return await lstat(file, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

export function requireAbsolutePath(file: string): void {
  if (
    !path.isAbsolute(file) ||
    file !== path.normalize(file) ||
    file.includes("\0") ||
    /[\r\n]/u.test(file)
  ) {
    refuse("Checkpoint path is not a normalized absolute path");
  }
}

/** Reject aliases, including symlinked parents, before trusting pathname comparisons. */
export async function requireRealPath(file: string): Promise<void> {
  requireAbsolutePath(file);
  if ((await realpath(file)) !== file)
    refuse("Checkpoint path must not use a symbolic link or alias");
}

const gitEnv = Object.fromEntries(
  Object.keys(process.env)
    .filter((key) => key.toUpperCase().startsWith("GIT_"))
    .map((key) => [key, undefined]),
);
Object.assign(gitEnv, {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_LAZY_FETCH: "1",
  LC_ALL: "C",
});

export async function checkpointGit(
  args: string[],
  cwd: string,
  input?: Buffer,
  indexFile?: string,
) {
  // Also cover env changes after the module was loaded. The ownership helper uses its own
  // runner, so eligibility checks for conflicting overrides before invoking it.
  const envOverlay = {
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => key.toUpperCase().startsWith("GIT_"))
        .map((key) => [key, undefined]),
    ),
    ...gitEnv,
    ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
  };
  const result = await runGitCommandBytes(args, { cwd, envOverlay, input });
  if (result.truncated) refuse("Git output exceeded the checkpoint limit");
  return result.stdout;
}

export function decodeGit(bytes: Buffer): string {
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded).equals(bytes)) refuse("Checkpoint paths must use UTF-8");
  return decoded;
}

export function nulList(bytes: Buffer): string[] {
  if (bytes.length === 0) return [];
  const fields = decodeGit(bytes).split("\0");
  if (fields.pop() !== "") refuse("Incomplete Git output");
  return fields;
}

async function gitLine(args: string[], root: string): Promise<string> {
  return decodeGit(await checkpointGit(args, root)).replace(/\r?\n$/u, "");
}

async function gitPath(args: string[], root: string): Promise<string> {
  return path.normalize(await gitLine(args, root));
}

async function readPointer(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const data = Buffer.alloc(8193);
    if (!(await handle.stat()).isFile()) refuse("Invalid linked worktree metadata");
    const { bytesRead } = await handle.read(data);
    if (bytesRead === data.length) refuse("Invalid linked worktree metadata");
    return decodeGit(data.subarray(0, bytesRead)).replace(/\r?\n$/u, "");
  } finally {
    await handle.close();
  }
}

async function requireRegisteredWorktree(root: string) {
  const dotGit = path.join(root, ".git");
  if (!(await lstatIfExists(dotGit))?.isFile()) refuse("Checkout is not a linked worktree");
  const pointer = await readPointer(dotGit);
  if (!pointer.startsWith("gitdir: ")) refuse("Invalid linked worktree metadata");

  const [top, admin, common] = await Promise.all([
    gitPath(["rev-parse", "--show-toplevel"], root),
    gitPath(["rev-parse", "--absolute-git-dir"], root),
    gitPath(["rev-parse", "--path-format=absolute", "--git-common-dir"], root),
  ]);
  if (
    top !== root ||
    path.resolve(root, pointer.slice(8)) !== admin ||
    path.dirname(admin) !== path.join(common, "worktrees")
  ) {
    refuse("Git worktree identity does not match the requested directory");
  }
  await Promise.all([requireRealPath(admin), requireRealPath(common)]);
  const backlink = await readPointer(path.join(admin, "gitdir"));
  if (path.resolve(admin, backlink) !== dotGit) refuse("Git worktree backlink does not match");
  if (path.resolve(admin, await readPointer(path.join(admin, "commondir"))) !== common) {
    refuse("Git worktree common directory does not match");
  }
  const ownerDirectory = await lstatIfExists(path.join(admin, "paseo"));
  const marker = await lstatIfExists(path.join(admin, "paseo", "worktree.json"));
  if (
    !ownerDirectory?.isDirectory() ||
    !marker?.isFile() ||
    marker.nlink !== 1n ||
    !(await readPaseoWorktreeMetadata(root))
  ) {
    refuse("Linked worktree has no Paseo management metadata");
  }
  const registered = nulList(await checkpointGit(["worktree", "list", "--porcelain", "-z"], root))
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => path.normalize(entry.slice(9)));
  if (registered[0] === root || !registered.includes(root)) {
    refuse("Git does not register this directory as a linked worktree");
  }
  return { admin, common };
}

export async function requireCheckpointWorktree(input: {
  scope: CheckpointScope;
  options: CheckpointWorktreeOptions;
}): Promise<WorktreeIdentity> {
  const { scope, options } = input;
  const { cwd: root, projectRoot } = scope;
  if (
    !scope.exclusive ||
    scope.isController ||
    scope.worktreeRoot !== root ||
    !scope.workspaceId ||
    !scope.agentId
  ) {
    refuse("File checkpoints require an exclusive Paseo worktree and an eligible agent");
  }
  await Promise.all([requireRealPath(root), requireRealPath(projectRoot)]);
  if (isInside(projectRoot, root) || isInside(root, projectRoot)) {
    refuse("File checkpoints cannot use a shared project directory");
  }

  const { admin, common } = await requireRegisteredWorktree(root);
  const projectCommon = await gitPath(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    projectRoot,
  );
  if (projectCommon !== common) refuse("Linked worktree belongs to a different project repository");

  if (
    Object.keys(process.env).some((key) =>
      /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CONFIG.*)$/iu.test(key),
    )
  ) {
    refuse("Git environment overrides are not supported for checkpoints");
  }
  const ownership = await isPaseoOwnedWorktreeCwd(root, { ...options, knownGitCommonDir: common });
  if (!ownership.allowed || ownership.worktreePath !== root)
    refuse("Worktree is not owned by Paseo");

  const [rootInfo, adminInfo] = await Promise.all([lstatIfExists(root), lstatIfExists(admin)]);
  if (!rootInfo?.isDirectory() || !adminInfo?.isDirectory())
    refuse("Worktree moved during eligibility check");
  return {
    root,
    admin,
    common,
    rootIdentity: `${rootInfo.dev}:${rootInfo.ino}`,
    adminIdentity: `${adminInfo.dev}:${adminInfo.ino}`,
  };
}

export type CheckpointEligibility =
  | { allowed: true; worktree: WorktreeIdentity }
  | { allowed: false; reason: string };

export async function checkCheckpointEligibility(
  input: Parameters<typeof requireCheckpointWorktree>[0],
): Promise<CheckpointEligibility> {
  try {
    return { allowed: true, worktree: await requireCheckpointWorktree(input) };
  } catch (error) {
    return {
      allowed: false,
      reason:
        error instanceof CheckpointSafetyError
          ? error.message
          : "Worktree identity could not be verified",
    };
  }
}

export function sameWorktree(left: WorktreeIdentity, right: WorktreeIdentity): boolean {
  return (
    left.root === right.root &&
    left.common === right.common &&
    left.admin === right.admin &&
    left.rootIdentity === right.rootIdentity &&
    left.adminIdentity === right.adminIdentity
  );
}

const workspaceLocks = new Map<string, Promise<unknown>>();
const activeLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/** One daemon owns a Paseo home. Scope locks also serialize across service instances. */
export async function withCheckpointLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const active = activeLocks.getStore();
  if (active?.has(key)) refuse("Checkpoint operation is already running in this scope");
  const previous = workspaceLocks.get(key);
  const result = Promise.resolve(previous)
    .catch(() => {})
    .then(() => activeLocks.run(new Set([...(active ?? []), key]), operation));
  workspaceLocks.set(key, result);
  try {
    return await result;
  } finally {
    if (workspaceLocks.get(key) === result) workspaceLocks.delete(key);
  }
}
