import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { WorkspaceDurableItemEvidence } from "@getpaseo/protocol/messages";
import { createRunGitCommand } from "../../utils/run-git-command.js";

export type DurableEvidenceTarget =
  | Pick<Extract<WorkspaceDurableItemEvidence, { type: "file" }>, "type" | "path">
  | Pick<Extract<WorkspaceDurableItemEvidence, { type: "git" }>, "type" | "path" | "repoRoot">;

export class DurableItemEvidenceError extends Error {
  readonly errorCode = "DURABLE_ITEM_STALE_EVIDENCE" as const;

  constructor() {
    super("The current evidence could not be verified against this acceptance item.");
    this.name = "DurableItemEvidenceError";
  }
}

const runGit = createRunGitCommand("durable-item-evidence");
const maxFileBytes = 16 * 1024 * 1024;

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileFingerprint(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > maxFileBytes) throw new DurableItemEvidenceError();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await lstat(path, { bigint: true });
    if (
      BigInt(bytesRead) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      (await realpath(path)) !== path
    ) {
      throw new DurableItemEvidenceError();
    }
    return sha256(bytes.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

async function gitRead(repoRoot: string, args: string[]): Promise<string> {
  const result = await runGit(["--literal-pathspecs", ...args], {
    cwd: repoRoot,
    envOverlay: {
      GIT_OPTIONAL_LOCKS: "0",
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_COMMON_DIR: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_NAMESPACE: undefined,
    },
    maxOutputBytes: 64 * 1024,
    timeout: 3000,
  });
  if (result.truncated) throw new DurableItemEvidenceError();
  return result.stdout;
}

async function gitBaseline(repoRoot: string, path: string) {
  const [head, index] = await Promise.all([
    gitRead(repoRoot, ["rev-parse", "--verify", "HEAD"]),
    gitRead(repoRoot, ["ls-files", "--stage", "-z", "--", path]),
  ]);
  return { headSha: head.trim(), index };
}

/** Resolve file paths in the workspace and Git paths in their declared repository. */
export async function captureDurableItemEvidence(
  workspaceCwd: string,
  target: DurableEvidenceTarget,
): Promise<WorkspaceDurableItemEvidence> {
  try {
    const workspaceRoot = await realpath(workspaceCwd);
    const repoRoot =
      target.type === "git" ? await realpath(resolve(workspaceCwd, target.repoRoot)) : undefined;
    const path = await realpath(resolve(repoRoot ?? workspaceCwd, target.path));
    if (!isWithin(workspaceRoot, path) || (repoRoot && !isWithin(repoRoot, path))) {
      throw new DurableItemEvidenceError();
    }
    const workspacePath = relative(workspaceRoot, path).split(sep).join("/");
    if (!repoRoot)
      return { type: "file", path: workspacePath, fingerprint: await fileFingerprint(path) };

    const reportedRoot = (await gitRead(repoRoot, ["rev-parse", "--show-toplevel"])).trimEnd();
    if (!reportedRoot || (await realpath(reportedRoot)) !== repoRoot) {
      throw new DurableItemEvidenceError();
    }
    const gitPath = relative(repoRoot, path).split(sep).join("/");
    const before = await gitBaseline(repoRoot, gitPath);
    const worktree = await fileFingerprint(path);
    const after = await gitBaseline(repoRoot, gitPath);
    if (before.headSha !== after.headSha || before.index !== after.index) {
      throw new DurableItemEvidenceError();
    }
    return {
      type: "git",
      path: gitPath,
      repoRoot,
      headSha: after.headSha,
      blobOrIndexFingerprint: sha256(JSON.stringify([after.index, worktree])),
    };
  } catch {
    throw new DurableItemEvidenceError();
  }
}
