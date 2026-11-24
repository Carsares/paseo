import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CheckoutGitRebaseStepSchema } from "@getpaseo/protocol/messages";
import type {
  CheckoutGitActiveAgent,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../messages.js";
import {
  capturePauseFingerprint,
  readOptional,
  readPausedStep,
  REBASE_JOURNAL as META,
  REBASE_MARKER as MARKER,
  REBASE_STATE_DIR as STATE_DIR,
} from "./controlled-rebase-state.js";
import {
  assertGitWorktree,
  git,
  GitWorkbenchError,
  operationState,
  readChanges,
  readHead,
  readHeadBranchRef,
} from "./git-workbench-state.js";
import { collectExpiredBackupRefs, createBackupRef } from "./repo-backup-refs.js";
import type { GitWorktree } from "./repo-write-mutex.js";

type PlanRequest = Extract<
  SessionInboundMessage,
  { type: "checkout.git.rebase.build_plan.request" }
>;
type Plan = Pick<
  Extract<SessionOutboundMessage, { type: "checkout.git.rebase.build_plan.response" }>["payload"],
  "headSha" | "ontoSha" | "entries" | "isPushedRange" | "conflictPaths"
>;
type ExecuteRequest = Extract<
  SessionInboundMessage,
  { type: "checkout.git.rebase.execute.request" }
>;
type ActRequest = Extract<SessionInboundMessage, { type: "checkout.git.rebase.act.request" }>;
type Step = ExecuteRequest["steps"][number];
type Result = Pick<
  Extract<SessionOutboundMessage, { type: "checkout.git.rebase.act.response" }>["payload"],
  "rebaseId" | "backupRef" | "newHeadSha" | "operationState" | "error" | "errorCode" | "success"
>;
type ListAgents = (root: string) => Promise<CheckoutGitActiveAgent[]>;

const LIMIT = 500;
const OID = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const BACKUP = /^refs\/paseo\/backup\/rebase-\d{13}-[0-9a-f]{32}$/;
const SAFE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
  LC_ALL: "C",
};
const JournalSchema = z.object({
  id: z.uuid(),
  backupRef: z.string().regex(BACKUP),
  branch: z.string().startsWith("refs/heads/"),
  original: OID,
  onto: OID,
  phase: z.enum(["running", "paused", "completed"]),
  pausedHead: OID.optional(),
  pausedPaths: z.array(z.string()).optional(),
  pauseSnapshot: z.object({ step: z.string(), fingerprint: z.string().nullable() }).optional(),
  completedHead: OID.optional(),
  affectedPaths: z.array(z.string()),
  messages: z.record(z.string(), z.string()),
  todo: z.array(z.string()),
});
type Journal = z.infer<typeof JournalSchema>;

async function resolveOnto(repo: GitWorktree, ref: string): Promise<string> {
  if (ref.length > 1024 || ref.startsWith("-") || ref.includes("\0"))
    throw new Error("Invalid rebase target");
  await git(repo, ["check-ref-format", "--allow-onelevel", ref], { envOverlay: SAFE_ENV });
  const result = await git(repo, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"], {
    envOverlay: SAFE_ENV,
  });
  return OID.parse(result.stdout.trim());
}

async function readPlan(repo: GitWorktree, head: string, onto: string): Promise<Plan["entries"]> {
  await git(repo, ["merge-base", head, onto], { envOverlay: SAFE_ENV });
  const range = await git(
    repo,
    [
      "log",
      "--reverse",
      "--topo-order",
      `--max-count=${LIMIT + 1}`,
      "-z",
      "--format=%H%x00%P%x00%s",
      "--no-notes",
      "--no-show-signature",
      onto + ".." + head,
      "--",
    ],
    { envOverlay: SAFE_ENV },
  );
  const tokens = range.stdout.split("\0");
  tokens.pop();
  if (tokens.length % 3 !== 0 || tokens.length / 3 > LIMIT)
    throw new Error("Rebase range exceeds 500 commits");
  const entries: Plan["entries"] = [];
  for (let i = 0; i < tokens.length; i += 3) {
    if (tokens[i + 1]!.includes(" "))
      throw new Error("Controlled rebase requires a linear commit range");
    entries.push({ sha: OID.parse(tokens[i]), subject: tokens[i + 2]! });
  }
  return entries;
}

async function withPrivateDir<T>(
  prefix: string,
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function previewConflicts(repo: GitWorktree, onto: string, head: string): Promise<string[]> {
  return withPrivateDir("paseo-rebase-preview-", async (directory) => {
    const gitDir = join(directory, "repository.git");
    const isolated = { root: directory, gitDir, commonDir: gitDir };
    const config = join(directory, "empty-config");
    await writeFile(config, "", { mode: 0o600 });
    // The shared process runner applies an overlay to the daemon's environment.
    const env = Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => !["PATH", "SYSTEMROOT", "WINDIR"].includes(key.toUpperCase()))
        .map((key) => [key, undefined]),
    );
    const envOverlay = {
      ...env,
      ...SAFE_ENV,
      HOME: directory,
      XDG_CONFIG_HOME: directory,
      TMPDIR: directory,
      TMP: directory,
      TEMP: directory,
      GIT_DIR: gitDir,
      GIT_ALLOW_PROTOCOL: "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: config,
      GIT_CONFIG_GLOBAL: config,
      GIT_ATTR_NOSYSTEM: "1",
    };
    const original = join(repo.commonDir, "objects");
    if (/[\r\n]/.test(original)) throw new Error("Unsupported Git objects path");
    await git(
      isolated,
      [
        "init",
        "--quiet",
        "--bare",
        "--template=",
        head.length === 64 ? "--object-format=sha256" : "--object-format=sha1",
        gitDir,
      ],
      { envOverlay },
    );
    // A bare repository with no templates, hooks, or inherited Git config.
    // Git reads the original object store as an alternate and writes locally.
    await writeFile(join(gitDir, "objects", "info", "alternates"), original + "\n", {
      mode: 0o600,
    });
    const shallow = await readOptional(join(repo.commonDir, "shallow"));
    if (shallow !== null) await writeFile(join(gitDir, "shallow"), shallow, { mode: 0o600 });
    const result = await git(
      isolated,
      ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", onto, head],
      {
        envOverlay,
        acceptExitCodes: [0, 1],
      },
    );
    return result.exitCode === 1
      ? [...new Set(result.stdout.split("\0").slice(1).filter(Boolean))]
      : [];
  });
}

export async function buildRebasePlan(repo: GitWorktree, input: PlanRequest): Promise<Plan> {
  const headSha = await readHead(repo);
  if (!headSha) throw new Error("The checkout has no commits");
  const ontoSha = await resolveOnto(repo, input.ontoRef);
  const entries = await readPlan(repo, headSha, ontoSha);
  // A remote-tracking ref can point anywhere inside the range, including an ancestor of HEAD.
  const first = entries[0];
  const pushed =
    first &&
    (await git(
      repo,
      [
        "for-each-ref",
        "--count=1",
        `--contains=${first.sha}`,
        "--format=%(refname)",
        "refs/remotes/",
      ],
      { envOverlay: SAFE_ENV },
    ));
  return {
    headSha,
    ontoSha,
    entries,
    isPushedRange: Boolean(pushed && pushed.stdout.trim()),
    ...(input.dryRun ? { conflictPaths: await previewConflicts(repo, ontoSha, headSha) } : {}),
  };
}

function validateSteps(entries: Plan["entries"], input: Step[]): Step[] {
  if (entries.length === 0 || input.length !== entries.length) {
    throw new Error("Rebase steps must include every commit in the current plan exactly once");
  }
  const expected = new Set(entries.map(({ sha }) => sha));
  const steps = z.array(CheckoutGitRebaseStepSchema).max(LIMIT).parse(input);
  let retained = false;
  let messageBytes = 0;
  for (const step of steps) {
    if (!expected.delete(step.sha))
      throw new Error("Unknown or duplicate commit in the rebase plan");
    if ((step.type === "squash" || step.type === "fixup") && !retained) {
      throw new Error("Squash and fixup require an earlier retained commit");
    }
    if (step.type !== "drop") retained = true;
    if (step.type === "reword") {
      messageBytes += Buffer.byteLength(step.message);
      if (!step.message.trim() || step.message.includes("\0") || messageBytes > 512 * 1024) {
        throw new Error("Invalid rebase commit message");
      }
    }
  }
  return steps;
}

async function readJournal(repo: GitWorktree): Promise<Journal | null> {
  const content = await readOptional(join(repo.gitDir, META));
  return content === null ? null : JournalSchema.parse(JSON.parse(content));
}

async function writeJournal(repo: GitWorktree, journal: Journal): Promise<void> {
  const temp = join(repo.gitDir, META + "." + randomUUID());
  try {
    await writeFile(temp, JSON.stringify(journal), { mode: 0o600, flag: "wx", flush: true });
    await rename(temp, join(repo.gitDir, META));
  } finally {
    await rm(temp, { force: true });
  }
}

async function ownsRebase(repo: GitWorktree, journal: Journal): Promise<boolean> {
  const directory = join(repo.gitDir, STATE_DIR);
  const marker = await readOptional(join(directory, MARKER));
  if (marker !== journal.id) return false;
  const [original, onto, branch] = await Promise.all([
    readOptional(join(directory, "orig-head")),
    readOptional(join(directory, "onto")),
    readOptional(join(directory, "head-name")),
  ]);
  return (
    original?.trimEnd() === journal.original &&
    onto?.trimEnd() === journal.onto &&
    branch?.trimEnd() === journal.branch
  );
}

interface RebaseCheckoutSnapshot {
  operationState: Awaited<ReturnType<typeof operationState>>;
  headSha: string | null;
  branchRef: string | null;
}

export async function readControlledRebaseId(
  repo: GitWorktree,
  checkout: RebaseCheckoutSnapshot,
): Promise<string | null> {
  const paused =
    checkout.operationState === "rebase" || checkout.operationState === "rebase_paused";
  if (!paused && checkout.operationState !== "idle") return null;
  const journal = await readJournal(repo);
  if (!journal) return null;
  if (paused) return (await ownsRebase(repo, journal)) ? journal.id : null;
  // Let a client that resumed with a detached HEAD identify the checkout
  // resulting from this rebase. The SHA alone could match a different branch.
  return journal.phase === "completed" &&
    journal.branch === checkout.branchRef &&
    journal.completedHead === checkout.headSha
    ? journal.id
    : null;
}

async function enforceAgentGuard(
  repo: GitWorktree,
  listAgents: ListAgents,
  force?: boolean,
): Promise<void> {
  if (force) return;
  const activeAgents = await listAgents(repo.root);
  if (activeAgents.length > 0) {
    throw new GitWorkbenchError("There are active agents in this worktree", "ACTIVE_AGENT_GUARD", {
      activeAgents,
    });
  }
}

async function assertClean(repo: GitWorktree): Promise<void> {
  const changes = await readChanges(repo);
  if (
    changes.staged.length ||
    changes.unstaged.length ||
    changes.untracked.length ||
    changes.conflicts.length
  ) {
    throw new Error("The rebase requires a clean index and worktree, including untracked files");
  }
}

function pathsFrom(stdout: string): string[] {
  return stdout.split("\0").filter(Boolean);
}

async function diffPaths(repo: GitWorktree, from: string, to: string): Promise<string[]> {
  return pathsFrom(
    (
      await git(
        repo,
        ["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", from, to, "--"],
        { envOverlay: SAFE_ENV },
      )
    ).stdout,
  );
}

async function affectedPaths(
  repo: GitWorktree,
  head: string,
  onto: string,
  steps: Step[],
): Promise<string[]> {
  const basePaths = await diffPaths(repo, head, onto);
  const replayPaths = await git(
    repo,
    ["diff-tree", "--stdin", "--no-commit-id", "--no-renames", "--name-only", "--root", "-r", "-z"],
    { envOverlay: SAFE_ENV, input: steps.map(({ sha }) => sha).join("\n") + "\n" },
  );
  return [...new Set([...basePaths, ...pathsFrom(replayPaths.stdout)])];
}

async function assertTrackedPathsVisible(repo: GitWorktree, affected: string[]): Promise<void> {
  const paths = new Set(affected);
  const { stdout } = await git(repo, ["ls-files", "-v", "-z"], { envOverlay: SAFE_ENV });
  if (pathsFrom(stdout).some((entry) => /^[a-zS] /.test(entry) && paths.has(entry.slice(2)))) {
    throw new Error("An affected tracked file is hidden from Git status by its index flags");
  }
}

async function assertIgnoredPathsSafe(repo: GitWorktree, affected: string[]): Promise<void> {
  const { stdout } = await git(
    repo,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    { envOverlay: SAFE_ENV },
  );
  const ignored = new Set(pathsFrom(stdout).map((path) => path.replace(/\/$/, "")));
  const paths = new Set(affected);
  function overlaps(path: string, other: Set<string>): boolean {
    for (let i = path.length; i > 0; i = path.lastIndexOf("/", i - 1)) {
      if (other.has(path.slice(0, i))) return true;
    }
    return false;
  }
  if (
    affected.some((path) => overlaps(path, ignored)) ||
    [...ignored].some((path) => overlaps(path, paths))
  ) {
    throw new Error("An ignored file or directory would be affected by the rebase");
  }
}

const EDITOR = `
const fs = require("node:fs");
const path = require("node:path");
const target = process.argv[2];
const directory = __dirname;
if (process.env.PASEO_GIT_REBASE_EDITOR === "todo") {
  const todo = fs.readFileSync(path.join(directory, "todo"), "utf8");
  fs.writeFileSync(target, todo);
  fs.writeFileSync(path.join(path.dirname(target), "paseo-rebase-id"), process.env.PASEO_GIT_REBASE_ID, { flag: "wx", mode: 0o600 });
} else {
  const done = fs.readFileSync(path.join(process.env.PASEO_GIT_REBASE_STATE, "done"), "utf8").trimEnd().split("\\n").pop();
  const entry = /^reword ([0-9a-f]+)(?: |$)/.exec(done || "");
  if (entry) {
    const messages = JSON.parse(fs.readFileSync(path.join(directory, "messages.json"), "utf8"));
    if (!Object.hasOwn(messages, entry[1])) throw new Error("Unknown reword commit");
    fs.writeFileSync(target, messages[entry[1]], "utf8");
  } else if (/^squash /.test(done || "")) {
    const message = fs.readFileSync(target, "utf8");
    fs.writeFileSync(target, message.replace(/^#.*(?:\\r?\\n|$)/gm, "").trim() + "\\n", "utf8");
  }
}
`;

function shellArgument(argument: string): string {
  const path = process.platform === "win32" ? argument.replaceAll("\\", "/") : argument;
  return "'" + path.replaceAll("'", "'\\''") + "'";
}

async function runRebase(repo: GitWorktree, journal: Journal, args: string[], initialize = false) {
  return withPrivateDir("paseo-rebase-editor-", async (directory) => {
    const editor = join(directory, "editor.cjs");
    await writeFile(editor, EDITOR, { mode: 0o700 });
    await writeFile(join(directory, "messages.json"), JSON.stringify(journal.messages), {
      mode: 0o600,
    });
    if (initialize) {
      await writeFile(join(directory, "todo"), journal.todo.join("\n") + "\n", { mode: 0o600 });
    }
    // Git runs the editor through its shell. The daemon's Electron runtime flag
    // is stripped from ordinary Git subprocesses, so set it for this editor only.
    const command =
      "ELECTRON_RUN_AS_NODE=1 " + shellArgument(process.execPath) + " " + shellArgument(editor);
    return git(
      repo,
      [
        "-c",
        `core.hooksPath=${directory}`,
        "-c",
        "core.abbrev=no",
        "-c",
        "maintenance.auto=false",
        "-c",
        "rerere.enabled=false",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "commit.cleanup=verbatim",
        "-c",
        "commit.status=false",
        "-c",
        "commit.verbose=false",
        "-c",
        "core.commentChar=#",
        "-c",
        "merge.conflictStyle=diff3",
        "-c",
        "rebase.autoSquash=false",
        "-c",
        "rebase.autoStash=false",
        "-c",
        "rebase.updateRefs=false",
        "-c",
        "rebase.abbreviateCommands=false",
        "-c",
        "rebase.rescheduleFailedExec=false",
        "rebase",
        ...args,
      ],
      {
        envOverlay: {
          ...SAFE_ENV,
          GIT_SEQUENCE_EDITOR: `PASEO_GIT_REBASE_EDITOR=todo ${command}`,
          GIT_EDITOR: command,
          GIT_REFLOG_ACTION: "paseo-rebase-" + journal.id,
          PASEO_GIT_REBASE_EDITOR: "message",
          PASEO_GIT_REBASE_ID: journal.id,
          PASEO_GIT_REBASE_STATE: join(repo.gitDir, STATE_DIR),
        },
        acceptExitCodes: [0, 1, 128],
        timeout: 120_000,
      },
    );
  });
}

async function reportedResult(
  repo: GitWorktree,
  journal: Journal,
  exitCode: number | null,
  action?: ActRequest["action"],
): Promise<Result> {
  const state = await operationState(repo);
  const head = await readHead(repo);
  const result = {
    rebaseId: journal.id,
    backupRef: journal.backupRef,
    newHeadSha: head,
    operationState: state,
  };
  if (
    state === "idle" &&
    exitCode === 0 &&
    head &&
    (await readHeadBranchRef(repo)) === journal.branch
  ) {
    if (action === "abort") {
      if (head !== journal.original)
        throw new Error("Git aborted but did not restore the original HEAD");
      await rm(join(repo.gitDir, META), { force: true });
    } else {
      await writeJournal(repo, {
        ...journal,
        phase: "completed",
        todo: [],
        completedHead: head,
        pausedHead: undefined,
        pausedPaths: undefined,
        pauseSnapshot: undefined,
        messages: {},
      });
    }
    return { ...result, success: true, error: null };
  }
  if ((await ownsRebase(repo, journal)) && head) {
    const { conflicts, staged } = await readChanges(repo);
    const pausedPaths = new Set([
      ...conflicts.map(({ path }) => path),
      ...staged.flatMap(({ path, oldPath }) => (oldPath ? [oldPath, path] : [path])),
    ]);
    await recordPausedState(repo, journal, head, [...pausedPaths], action);
    if (conflicts.length > 0) {
      return {
        ...result,
        operationState: "rebase_paused",
        success: false,
        error: "Rebase paused with unresolved conflicts",
        errorCode: "REBASE_CONFLICT_PAUSED",
      };
    }
  }
  if (
    state === "idle" &&
    head === journal.original &&
    (await readHeadBranchRef(repo)) === journal.branch
  ) {
    await rm(join(repo.gitDir, META), { force: true });
  }
  return {
    ...result,
    success: false,
    error: "Git could not complete the rebase. Review the worktree and its backup.",
  };
}

async function recordPausedState(
  repo: GitWorktree,
  journal: Journal,
  head: string,
  pausedPaths: string[],
  action?: ActRequest["action"],
): Promise<void> {
  const step = await readPausedStep(repo, head);
  const previous = journal.pauseSnapshot;
  if (previous?.step === step) {
    await writeJournal(repo, { ...journal, phase: "paused" });
    return;
  }
  // A failed retry of a pause without a recorded baseline cannot establish
  // that the contents came from Git. They may include the user's resolution.
  const missingBaseline = action !== undefined && !previous;
  await writeJournal(repo, {
    ...journal,
    affectedPaths: [...new Set([...journal.affectedPaths, ...pausedPaths])],
    phase: "paused",
    pausedHead: head,
    pausedPaths,
    pauseSnapshot: {
      step,
      fingerprint: missingBaseline ? null : await capturePauseFingerprint(repo, pausedPaths),
    },
  });
}

async function verifyBranchAndHead(
  repo: GitWorktree,
  branch: string | null,
  head: string | null,
): Promise<void> {
  const actual = await readHead(repo);
  if (actual !== head || (await readHeadBranchRef(repo)) !== branch) {
    throw new GitWorkbenchError(
      "The branch or HEAD changed. Refresh and try again",
      "STALE_HEAD_CONFLICT",
      { actualHeadSha: actual },
    );
  }
}

// Call under the shared worktree and repository write lock.
export async function executeControlledRebase(
  repo: GitWorktree,
  input: ExecuteRequest,
  listAgents: ListAgents,
): Promise<Result> {
  await assertGitWorktree(repo);
  const head = await readHead(repo);
  if (!head || head !== input.expectedHeadSha) {
    throw new GitWorkbenchError("HEAD changed. Refresh and try again", "STALE_HEAD_CONFLICT", {
      actualHeadSha: head,
    });
  }
  const branch = await readHeadBranchRef(repo);
  if (!branch?.startsWith("refs/heads/"))
    throw new Error("Controlled rebase requires a checked-out branch");
  if ((await operationState(repo)) !== "idle")
    throw new Error("Finish the current Git operation first");
  const onto = await resolveOnto(repo, input.ontoRef);
  const steps = validateSteps(await readPlan(repo, head, onto), input.steps);
  await enforceAgentGuard(repo, listAgents, input.forceWithRunningAgents);
  await assertClean(repo);
  const affected = await affectedPaths(repo, head, onto, steps);
  await assertIgnoredPathsSafe(repo, affected);
  await assertTrackedPathsVisible(repo, affected);
  await verifyBranchAndHead(repo, branch, head);
  if ((await operationState(repo)) !== "idle")
    throw new Error("A Git operation started while preparing the rebase");
  await collectExpiredBackupRefs(repo);
  const id = randomUUID();
  // A reconnecting client can match the active instance to its listed backup.
  const backupRef = await createBackupRef(repo, "rebase", head, id);
  const journal: Journal = {
    id,
    backupRef,
    branch,
    original: head,
    onto,
    phase: "running",
    affectedPaths: affected,
    todo: steps.map((step) => step.type + " " + step.sha),
    messages: Object.fromEntries(
      steps.flatMap((step) => (step.type === "reword" ? [[step.sha, step.message]] : [])),
    ),
  };
  try {
    await writeJournal(repo, journal);
    const result = await runRebase(
      repo,
      journal,
      [
        "--interactive",
        "--no-autostash",
        "--no-update-refs",
        "--no-rebase-merges",
        "--no-fork-point",
        "--reapply-cherry-picks",
        "--keep-empty",
        "--empty=keep",
        "--no-gpg-sign",
        onto,
      ],
      true,
    );
    const recovered = await recoverFailedExecution(repo, journal, result.exitCode);
    return recovered ?? (await reportedResult(repo, journal, result.exitCode));
  } catch (error) {
    throw new GitWorkbenchError(error instanceof Error ? error.message : String(error), undefined, {
      backupRef,
      rebaseId: journal.id,
    });
  }
}

async function assertBackup(
  repo: GitWorktree,
  journal: Journal,
  requested?: string,
): Promise<void> {
  if (requested !== undefined && requested !== journal.backupRef)
    throw new Error("Backup does not belong to this rebase");
  const { stdout } = await git(repo, ["show-ref", "--verify", "--hash", journal.backupRef], {
    envOverlay: SAFE_ENV,
  });
  if (stdout.trim() !== journal.original) throw new Error("The original rebase backup has changed");
}

async function assertPausedWorktreeSafe(
  repo: GitWorktree,
  journal: Journal,
  action: ActRequest["action"],
  head: string,
): Promise<void> {
  const { staged, unstaged, untracked, conflicts } = await readChanges(repo);
  const matchesPause = journal.pauseSnapshot?.step === (await readPausedStep(repo, head));
  const paths = new Set(
    (matchesPause || (!journal.pauseSnapshot && journal.phase === "paused")
      ? journal.pausedPaths
      : undefined) ??
      (await readCurrentReplayPaths(
        repo,
        conflicts.map(({ path }) => path),
      )),
  );
  if (
    unstaged.length ||
    untracked.length ||
    staged.some(({ path, oldPath }) => !paths.has(path) || (oldPath && !paths.has(oldPath)))
  ) {
    throw new Error(
      "The worktree contains changes outside the controlled rebase. Preserve them before continuing.",
    );
  }
  if (action === "continue") {
    if (conflicts.length > 0) {
      throw new GitWorkbenchError(
        "Resolve the remaining conflicts before continuing",
        "REBASE_CONFLICT_PAUSED",
        {
          rebaseId: journal.id,
          backupRef: journal.backupRef,
          operationState: "rebase_paused",
        },
      );
    }
  } else {
    await assertPauseUnchanged(repo, journal, matchesPause);
  }
  await assertIgnoredPathsSafe(repo, journal.affectedPaths);
  await assertTrackedPathsVisible(repo, journal.affectedPaths);
}

async function assertPauseUnchanged(
  repo: GitWorktree,
  journal: Journal,
  matchesPause: boolean,
): Promise<void> {
  const original = journal.pauseSnapshot?.fingerprint;
  if (!matchesPause || !original || !journal.pausedPaths) {
    throw new Error(
      "Paseo cannot verify the original pause. Preserve your changes before discarding this rebase step.",
    );
  }
  if ((await capturePauseFingerprint(repo, journal.pausedPaths)) !== original) {
    throw new Error(
      "The index or files changed since the rebase paused. Preserve your changes before discarding this rebase step.",
    );
  }
}

// The daemon can exit between Git pausing and the journal recording its paths.
async function readCurrentReplayPaths(repo: GitWorktree, unmerged: string[]): Promise<string[]> {
  const replayHead = await readOptional(join(repo.gitDir, "REBASE_HEAD"));
  if (!replayHead) return unmerged;
  const sha = OID.parse(replayHead.trim());
  const { stdout } = await git(
    repo,
    ["diff-tree", "--root", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", sha, "--"],
    { envOverlay: SAFE_ENV },
  );
  return [...unmerged, ...pathsFrom(stdout)];
}

async function verifyPausedTodo(repo: GitWorktree, journal: Journal): Promise<void> {
  const directory = join(repo.gitDir, STATE_DIR);
  const [done, pending] = await Promise.all([
    readOptional(join(directory, "done")),
    readOptional(join(directory, "git-rebase-todo")),
  ]);
  if (pending === null) throw new Error("The Git rebase plan is missing");
  const actual = ((done ?? "") + "\n" + pending)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (actual.length !== journal.todo.length || actual.some((line, i) => line !== journal.todo[i])) {
    throw new Error("The Git rebase plan changed after it started");
  }
}

async function verifyOriginalBranch(repo: GitWorktree, journal: Journal): Promise<void> {
  const original = await git(repo, ["show-ref", "--hash", "--verify", journal.branch], {
    envOverlay: SAFE_ENV,
  });
  if (original.stdout.trim() !== journal.original)
    throw new Error("The original branch moved during the rebase");
}

async function recoverFailedExecution(
  repo: GitWorktree,
  journal: Journal,
  exitCode: number | null,
): Promise<Result | null> {
  if (!exitCode || !(await ownsRebase(repo, journal))) return null;
  const { staged, unstaged, untracked, conflicts } = await readChanges(repo);
  // An error after checkout may have left useful resolutions or unrelated work.
  if (staged.length || unstaged.length || untracked.length || conflicts.length) return null;
  await assertBackup(repo, journal);
  await assertIgnoredPathsSafe(repo, journal.affectedPaths);
  await verifyOriginalBranch(repo, journal);
  await verifyBranchAndHead(repo, null, await readHead(repo));
  const result = await runRebase(repo, journal, ["--abort"]);
  if (result.exitCode !== 0) return null;
  return {
    ...(await reportedResult(repo, journal, result.exitCode, "abort")),
    success: false,
    error: "Git could not complete the rebase. The original checkout was restored.",
  };
}

async function undoCompletedRebase(
  repo: GitWorktree,
  journal: Journal,
  state: Awaited<ReturnType<typeof operationState>>,
): Promise<Result> {
  if (state !== "idle" || !journal.completedHead)
    throw new Error("Finish the current Git operation first");
  await assertClean(repo);
  const affected = await diffPaths(repo, journal.completedHead, journal.original);
  await assertIgnoredPathsSafe(repo, affected);
  await assertTrackedPathsVisible(repo, affected);
  await verifyBranchAndHead(repo, journal.branch, journal.completedHead);
  await git(repo, ["reset", "--keep", journal.original], { envOverlay: SAFE_ENV });
  await verifyBranchAndHead(repo, journal.branch, journal.original);
  await rm(join(repo.gitDir, META), { force: true });
  return {
    success: true,
    error: null,
    newHeadSha: journal.original,
    backupRef: journal.backupRef,
    rebaseId: journal.id,
    operationState: "idle",
  };
}

// Call under the shared worktree and repository write lock.
export async function actOnControlledRebase(
  repo: GitWorktree,
  input: ActRequest,
  listAgents: ListAgents,
): Promise<Result> {
  await assertGitWorktree(repo);
  const journal = await readJournal(repo);
  const state = await operationState(repo);
  const currentId =
    journal && (journal.phase === "completed" || (await ownsRebase(repo, journal)))
      ? journal.id
      : null;
  if (!journal || !currentId || input.expectedRebaseId !== currentId) {
    throw new GitWorkbenchError(
      "The requested rebase instance is no longer current",
      "STALE_REBASE_INSTANCE",
      { rebaseId: currentId },
    );
  }
  await enforceAgentGuard(repo, listAgents, input.forceWithRunningAgents);
  if (input.action === "undo" && !input.backupRef)
    throw new Error("Undo requires the backup reference from this rebase");
  if (input.action === "undo" || input.backupRef)
    await assertBackup(repo, journal, input.backupRef);
  if (input.action === "undo" && journal.phase === "completed") {
    return undoCompletedRebase(repo, journal, state);
  }
  if ((state !== "rebase" && state !== "rebase_paused") || !(await ownsRebase(repo, journal))) {
    throw new GitWorkbenchError("The rebase is no longer paused", "STALE_REBASE_INSTANCE", {
      rebaseId: currentId,
    });
  }
  return resumePausedRebase(repo, journal, input.action);
}

async function resumePausedRebase(
  repo: GitWorktree,
  journal: Journal,
  action: ActRequest["action"],
): Promise<Result> {
  const head = await readHead(repo);
  if (!head || (journal.phase === "paused" && journal.pausedHead && head !== journal.pausedHead)) {
    throw new GitWorkbenchError("HEAD changed during the rebase", "STALE_HEAD_CONFLICT", {
      actualHeadSha: head,
    });
  }
  await assertPausedWorktreeSafe(repo, journal, action, head);
  await verifyOriginalBranch(repo, journal);
  const gitAction = action === "undo" ? "abort" : action;
  if (gitAction !== "abort") await verifyPausedTodo(repo, journal);
  await verifyBranchAndHead(repo, null, head);
  const running: Journal = {
    ...journal,
    phase: "running",
  };
  await writeJournal(repo, running);
  try {
    const result = await runRebase(repo, running, ["--" + gitAction]);
    return await reportedResult(repo, running, result.exitCode, gitAction);
  } catch (error) {
    throw new GitWorkbenchError(error instanceof Error ? error.message : String(error), undefined, {
      backupRef: journal.backupRef,
      rebaseId: journal.id,
    });
  }
}
