import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { runGitCommandBytes } from "../../utils/run-git-command.js";
import { safeRepoPath } from "./conflict-inspect.js";
import { git, GitWorkbenchError, readHead, readHeadBranchRef } from "./git-workbench-state.js";
import type { GitWorktree } from "./repo-write-mutex.js";

type Request<T extends string> = Extract<
  SessionInboundMessage,
  { type: `checkout.git.${T}.request` }
>;
type BlamePayload = Extract<
  SessionOutboundMessage,
  { type: "checkout.git.blame.get.response" }
>["payload"];
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_ENV = {
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};
const HOOKS_DISABLED = "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null");
const MAX_BLAME_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BLAME_LINES = 2_000;
const MAX_BLAME_OUTPUT_BYTES = 2 * 1024 * 1024;

async function readBlameFile(repo: GitWorktree, path: string): Promise<Buffer> {
  const absolutePath = await safeRepoPath(repo, path);
  const handle = await open(
    absolutePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BLAME_FILE_BYTES) {
      throw new Error("Blame is available for regular text files up to 16 MiB");
    }
    const bytes = Buffer.allocUnsafe(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const latest = await handle.stat();
    if (size !== info.size || latest.mtimeMs !== info.mtimeMs || latest.ctimeMs !== info.ctimeMs) {
      throw new Error("The file changed while reading blame. Try again.");
    }
    const content = bytes.subarray(0, size);
    if (content.includes(0) || !Buffer.from(content.toString("utf8")).equals(content)) {
      throw new Error("Blame is available for UTF-8 text files");
    }
    return content;
  } finally {
    await handle.close();
  }
}

function parseBlame(stdout: Buffer): BlamePayload["lines"] {
  const lines: BlamePayload["lines"] = [];
  let line: BlamePayload["lines"][number] | undefined;
  for (const entry of stdout.toString("utf8").split("\n").slice(0, -1)) {
    if (entry.startsWith("\t")) {
      if (line) lines.push({ ...line, lineText: entry.slice(1) });
      line = undefined;
      continue;
    }
    const header = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/.exec(entry);
    if (header) {
      const sha = header[1]!;
      line = {
        sha: /^0+$/.test(sha) ? null : sha,
        lineNumber: Number(header[2]),
        authorName: "",
        authorDate: null,
        summary: "",
      };
    } else if (line && entry.startsWith("author ")) {
      line.authorName = entry.slice(7);
    } else if (line?.sha && entry.startsWith("author-time ")) {
      const date = new Date(Number(entry.slice(12)) * 1_000);
      if (Number.isFinite(date.getTime())) line.authorDate = date.toISOString();
    } else if (line && entry.startsWith("summary ")) {
      line.summary = entry.slice(8);
    }
  }
  return lines;
}

export async function getBlame(
  repo: GitWorktree,
  input: Request<"blame.get">,
): Promise<Pick<BlamePayload, "lines" | "truncated">> {
  const start = input.startLine ?? 1;
  const requestedEnd = input.endLine;
  if (
    !Number.isSafeInteger(start) ||
    (requestedEnd !== undefined && (!Number.isSafeInteger(requestedEnd) || requestedEnd < start))
  ) {
    throw new Error("Select a valid blame line range");
  }
  const content = await readBlameFile(repo, input.path);
  let lineCount = Number(content.length > 0 && content.at(-1) !== 10);
  for (const byte of content) {
    if (byte === 10) lineCount++;
  }
  const end = Math.min(lineCount, requestedEnd ?? lineCount, start + MAX_BLAME_LINES - 1);
  if (end < start) return { lines: [] };
  const result = await runGitCommandBytes(
    [
      "-c",
      "blame.blankBoundary=false",
      "blame",
      "--line-porcelain",
      "--contents",
      "-",
      "-L",
      start + "," + end,
      "--",
      input.path,
    ],
    { cwd: repo.root, input: content, maxOutputBytes: MAX_BLAME_OUTPUT_BYTES, envOverlay: GIT_ENV },
  );
  const lines = parseBlame(result.stdout);
  return {
    lines,
    ...(result.truncated || end < Math.min(lineCount, requestedEnd ?? lineCount)
      ? { truncated: true }
      : {}),
  };
}

export class StaleRemoteBaseline extends Error {
  constructor() {
    super(
      "The reviewed push target is stale. Fetch if needed and reopen force push to review the current target.",
    );
  }
}

async function verifyHead(
  repo: GitWorktree,
  expected: string | null,
  branch?: string,
): Promise<string | null> {
  const actualHeadSha = await readHead(repo);
  if (
    actualHeadSha !== expected ||
    (branch !== undefined && branch !== (await readHeadBranchRef(repo)))
  ) {
    throw new GitWorkbenchError(
      "The branch or HEAD changed. Refresh and try again.",
      "STALE_HEAD_CONFLICT",
      { actualHeadSha },
    );
  }
  return actualHeadSha;
}

async function readDirectRef(repo: GitWorktree, ref: string): Promise<string | null> {
  const { exitCode } = await git(repo, ["symbolic-ref", "--quiet", ref], {
    acceptExitCodes: [0, 1],
    envOverlay: GIT_ENV,
  });
  if (exitCode === 0) throw new Error("Expected a direct Git reference");
  const result = await git(repo, ["show-ref", "--verify", "--hash", "--", ref], {
    acceptExitCodes: [0, 128],
    envOverlay: GIT_ENV,
  });
  const sha = result.stdout.trim();
  return result.exitCode === 0 && OID.test(sha) ? sha : null;
}

interface PushRemote {
  name: string;
  env: NodeJS.ProcessEnv;
  originalConfigCount: number;
}

async function resolvePushUrl(repo: GitWorktree, name: string | undefined): Promise<string> {
  if (
    !name ||
    name.length > 1024 ||
    name.startsWith("-") ||
    /[\r\n]/.test(name) ||
    name.includes("\0")
  ) {
    throw new Error("Select a configured Git remote");
  }
  const { stdout } = await git(repo, ["remote"], { envOverlay: GIT_ENV });
  if (!stdout.split("\n").includes(name)) throw new Error("Select a configured Git remote");
  const urls = await git(repo, ["remote", "get-url", "--push", "--all", "--", name], {
    envOverlay: GIT_ENV,
    maxOutputBytes: 64 * 1024,
  }).catch(() => {
    throw new Error("Could not resolve the configured push destination");
  });
  const url = urls.stdout.replace(/\n$/, "");
  if (!url || /[\r\n]/.test(url) || url.includes("\0"))
    throw new Error("Select a remote with exactly one push URL");

  return url;
}

function pinPushUrl(url: string): PushRemote {
  // Resolve the configured push URL once and pin it for both commands. The random
  // alias keeps credentials out of command arguments and avoids applying URL rewrites twice.
  const alias = "paseo-push-" + randomUUID();
  const aliasUrl = alias + ":";
  const config = [
    ["remote." + alias + ".url", aliasUrl],
    ["remote." + alias + ".pushurl", aliasUrl],
    ["url." + url + ".insteadOf", aliasUrl],
  ];
  const first = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(first) || first < 0 || first > 100_000) {
    throw new Error("Invalid Git configuration environment");
  }
  const env: NodeJS.ProcessEnv = { ...GIT_ENV, GIT_CONFIG_COUNT: String(first + config.length) };
  for (const [offset, [key, value]] of config.entries()) {
    env["GIT_CONFIG_KEY_" + (first + offset)] = key;
    env["GIT_CONFIG_VALUE_" + (first + offset)] = value;
  }
  return { name: alias, env, originalConfigCount: first };
}

const PRE_PUSH_FORWARDER = `#!/bin/sh
remote="$PASEO_PRE_PUSH_REMOTE"
hook="$PASEO_PRE_PUSH_ORIGINAL"
input="$PASEO_PRE_PUSH_INPUT"
first="$PASEO_PRE_PUSH_CONFIG_COUNT"
while [ "$first" -lt "$GIT_CONFIG_COUNT" ]; do
  unset "GIT_CONFIG_KEY_$first" "GIT_CONFIG_VALUE_$first"
  first=$((first + 1))
done
export GIT_CONFIG_COUNT="$PASEO_PRE_PUSH_CONFIG_COUNT"
export GIT_CONFIG_PARAMETERS="$PASEO_PRE_PUSH_CONFIG_PARAMETERS"
unset PASEO_PRE_PUSH_REMOTE PASEO_PRE_PUSH_ORIGINAL PASEO_PRE_PUSH_INPUT PASEO_PRE_PUSH_HOOKS
unset PASEO_PRE_PUSH_CONFIG_COUNT PASEO_PRE_PUSH_CONFIG_PARAMETERS PASEO_PRE_PUSH_EMPTY
if [ -n "$input" ]; then
  umask 077
  cat > "$input" || exit 1
  exec git hook run --ignore-missing --to-stdin="$input" pre-push -- "$remote" "$2"
fi
exec "$hook" "$remote" "$2"
`;

async function hasExecutableHook(path: string) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw error;
  }
}

async function installPrePushForwarder(repo: GitWorktree) {
  const [{ stdout: hookPath }, { stdout: hookKeys }] = await Promise.all([
    git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push"], {
      envOverlay: GIT_ENV,
    }),
    git(
      repo,
      ["config", "--null", "--name-only", "--get-regexp", "^hook\\..*\\.event$", "^pre-push$"],
      { envOverlay: GIT_ENV, acceptExitCodes: [0, 1], maxOutputBytes: 64 * 1024 },
    ),
  ]);
  let originalHook = hookPath.replace(/\n$/, "");
  const configuredHooks = [...new Set(hookKeys.split("\0").filter(Boolean))];
  if (configuredHooks.length === 0 && !(await hasExecutableHook(originalHook))) {
    // Git for Windows can also find an executable with its platform suffix.
    if (process.platform !== "win32" || !(await hasExecutableHook(originalHook + ".exe"))) {
      return null;
    }
    originalHook += ".exe";
  }

  const directory = await mkdtemp(join(tmpdir(), "paseo-pre-push-"));
  try {
    const script = join(directory, "pre-push");
    await writeFile(script, PRE_PUSH_FORWARDER, { mode: 0o700 });
    // Git skips hooks it cannot execute, including on a noexec mount. Abort
    // before replacing the original hook configuration if Git would skip this one.
    await access(script, constants.X_OK);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, originalHook, configuredHooks };
}

async function pushSingleRef(
  repo: GitWorktree,
  remote: PushRemote,
  remoteName: string,
  source: string,
  ref: string,
  baseline?: string,
) {
  const forwarder = await installPrePushForwarder(repo).catch(() => {
    throw new Error("Could not prepare the repository's pre-push hook.");
  });
  const hookArgs: string[] = [];
  const envOverlay = { ...remote.env };
  if (forwarder) {
    // Git owns the connection and supplies the hook's URL and ref records. Only
    // the name is translated back to the configured remote. Hooks that invoke
    // Git (including Git LFS) see the original config, without the push alias.
    hookArgs.push("--config-env=core.hooksPath=PASEO_PRE_PUSH_HOOKS");
    for (const key of forwarder.configuredHooks) {
      // Configured hooks otherwise run ahead of the forwarder with the alias.
      // The forwarder restores config and lets Git run the full hook event.
      hookArgs.push("--config-env=" + key + "=PASEO_PRE_PUSH_EMPTY");
    }
    const directory =
      process.platform === "win32"
        ? forwarder.directory.replaceAll("\\", "/")
        : forwarder.directory;
    Object.assign(envOverlay, {
      PASEO_PRE_PUSH_REMOTE: remoteName,
      PASEO_PRE_PUSH_ORIGINAL: forwarder.originalHook,
      PASEO_PRE_PUSH_INPUT: forwarder.configuredHooks.length ? directory + "/refs" : "",
      PASEO_PRE_PUSH_HOOKS: directory,
      PASEO_PRE_PUSH_CONFIG_COUNT: String(remote.originalConfigCount),
      PASEO_PRE_PUSH_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS ?? "",
      PASEO_PRE_PUSH_EMPTY: "",
    });
  }
  const result = await git(
    repo,
    [
      ...hookArgs,
      "-c",
      "push.pushOption=",
      "-c",
      "push.negotiate=false",
      "push",
      "--porcelain",
      "--no-follow-tags",
      "--no-recurse-submodules",
      "--signed=false",
      ...(baseline === undefined ? [] : ["--force-with-lease=" + ref + ":" + baseline]),
      "--",
      remote.name,
      source + ":" + ref,
    ],
    { envOverlay, acceptExitCodes: [0, 1], timeout: 120_000, maxOutputBytes: 64 * 1024 },
  )
    .catch(() => {
      throw new Error("Git push could not be completed. Check the remote and credentials.");
    })
    .finally(async () => {
      if (forwarder) {
        // A temporary file cleanup failure must not turn a successful push into a retry.
        await rm(forwarder.directory, { recursive: true, force: true }).catch(() => {});
      }
    });
  if (result.exitCode === 0) return;
  if (
    baseline !== undefined &&
    result.stdout
      .split("\n")
      .some((line) => line.startsWith("!\t") && line.endsWith("(stale info)"))
  ) {
    throw new StaleRemoteBaseline();
  }
  throw new Error("Git rejected the push. Check the remote reference and repository permissions.");
}

async function readRemoteSha(repo: GitWorktree, remote: PushRemote, ref: string) {
  const result = await git(repo, ["ls-remote", "--refs", "--exit-code", "--", remote.name, ref], {
    envOverlay: remote.env,
    acceptExitCodes: [0, 2],
    maxOutputBytes: 64 * 1024,
  }).catch(() => {
    throw new Error("Could not read the push destination. Check the remote and credentials.");
  });
  if (result.exitCode !== 0) return null;
  const matches = result.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([, actualRef]) => actualRef === ref);
  const sha = matches[0]?.[0];
  return matches.length === 1 && sha && OID.test(sha) ? sha : null;
}

async function getBranchUpstream(repo: GitWorktree, branch: string) {
  const { stdout } = await git(
    repo,
    [
      "for-each-ref",
      "--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)",
      "--",
      branch,
    ],
    { envOverlay: GIT_ENV },
  );
  const [, tracking, remote, ref] =
    stdout
      .split("\n")
      .map((line) => line.split("\0"))
      .find(([name]) => name === branch) ?? [];
  // Fetch mappings can point outside refs/remotes, so Git supplies the exact local ref.
  if (
    !tracking?.startsWith("refs/") ||
    !remote ||
    remote === "." ||
    !ref?.startsWith("refs/heads/")
  ) {
    throw new Error("Configure an upstream remote branch before force pushing");
  }
  return { tracking, remote, ref };
}

const PUSH_TOKEN_KEY = randomBytes(32);
const PUSH_TOKEN_TTL_MS = 5 * 60_000;

async function readPushSnapshot(repo: GitWorktree, expectedHeadSha: string | null) {
  const branch = await readHeadBranchRef(repo);
  if (!branch?.startsWith("refs/heads/"))
    throw new Error("Check out a local branch before force pushing");
  const head = await verifyHead(repo, expectedHeadSha, branch);
  if (!head) throw new Error("The current branch has no commit to push");
  const upstream = await getBranchUpstream(repo, branch);
  const remoteSha = await readDirectRef(repo, upstream.tracking);
  if (!remoteSha) throw new StaleRemoteBaseline();
  const url = await resolvePushUrl(repo, upstream.remote);
  return { head, branch, ...upstream, remoteSha, url };
}

function pushSnapshotMac(
  repo: GitWorktree,
  snapshot: Awaited<ReturnType<typeof readPushSnapshot>>,
  expires: number,
) {
  return createHmac("sha256", PUSH_TOKEN_KEY)
    .update(
      JSON.stringify([
        expires,
        repo.root,
        repo.gitDir,
        repo.commonDir,
        snapshot.head,
        snapshot.branch,
        snapshot.tracking,
        snapshot.remote,
        snapshot.ref,
        snapshot.remoteSha,
        snapshot.url,
      ]),
    )
    .digest();
}

export async function preparePush(repo: GitWorktree, input: Request<"push.prepare">) {
  const snapshot = await readPushSnapshot(repo, input.expectedHeadSha);
  const expires = Date.now() + PUSH_TOKEN_TTL_MS;
  return {
    branch: snapshot.branch.slice("refs/heads/".length),
    remote: snapshot.remote,
    remoteRef: snapshot.ref,
    remoteSha: snapshot.remoteSha,
    token: String(expires) + "." + pushSnapshotMac(repo, snapshot, expires).toString("hex"),
  };
}

async function verifyPushSnapshot(repo: GitWorktree, input: Request<"push.force">) {
  const token = /^(\d{13})\.([0-9a-f]{64})$/.exec(input.expectedPushToken ?? "");
  if (!token) throw new StaleRemoteBaseline();
  const expires = Number(token[1]);
  if (expires <= Date.now()) throw new StaleRemoteBaseline();
  const snapshot = await readPushSnapshot(repo, input.expectedHeadSha).catch(() => {
    throw new StaleRemoteBaseline();
  });
  if (
    expires <= Date.now() ||
    input.confirmation !== "force-push " + snapshot.branch.slice("refs/heads/".length) ||
    !timingSafeEqual(pushSnapshotMac(repo, snapshot, expires), Buffer.from(token[2]!, "hex"))
  ) {
    throw new StaleRemoteBaseline();
  }
  return snapshot;
}

export async function pushForce(repo: GitWorktree, input: Request<"push.force">): Promise<string> {
  const reviewed = await verifyPushSnapshot(repo, input);
  const remote = pinPushUrl(reviewed.url);
  if ((await readRemoteSha(repo, remote, reviewed.ref)) !== reviewed.remoteSha)
    throw new StaleRemoteBaseline();
  await verifyPushSnapshot(repo, input);
  await pushSingleRef(
    repo,
    remote,
    reviewed.remote,
    reviewed.head,
    reviewed.ref,
    reviewed.remoteSha,
  );
  return reviewed.head;
}

export async function mutateTag(
  repo: GitWorktree,
  input: Request<"tag.mutate">,
): Promise<string | null> {
  const { tagName, action } = input;
  if (
    tagName.startsWith("-") ||
    tagName.length > 1024 ||
    tagName.startsWith("refs/") ||
    tagName.includes("\0")
  ) {
    throw new Error("Enter a valid local tag name");
  }
  const ref = "refs/tags/" + tagName;
  const format = await git(repo, ["check-ref-format", ref], {
    acceptExitCodes: [0, 1],
    envOverlay: GIT_ENV,
  });
  if (format.exitCode !== 0) throw new Error("Enter a valid local tag name");
  const head = await verifyHead(repo, input.expectedHeadSha);
  if (action === "create") {
    if (input.remote !== undefined) throw new Error("Creating a tag is a local operation");
    if (!head) throw new Error("HEAD has no commit to tag");
    await git(
      repo,
      ["-c", HOOKS_DISABLED, "update-ref", "--no-deref", ref, head, "0".repeat(head.length)],
      { envOverlay: GIT_ENV },
    );
    return head;
  }
  const sha = input.expectedTagSha;
  if (!sha || !OID.test(sha))
    throw new Error("Review the current tag before deleting or pushing it");
  await verifyTagRef(repo, ref, sha);
  if (action === "delete") {
    if (input.remote !== undefined) throw new Error("Deleting a tag is a local operation");
    await verifyHead(repo, head);
    await git(repo, ["-c", HOOKS_DISABLED, "update-ref", "--no-deref", "-d", ref, sha], {
      envOverlay: GIT_ENV,
    });
  } else {
    const remoteName = input.remote;
    if (!remoteName) throw new Error("Select a configured Git remote");
    const remote = pinPushUrl(await resolvePushUrl(repo, remoteName));
    await verifyHead(repo, head);
    await verifyTagRef(repo, ref, sha);
    await pushSingleRef(repo, remote, remoteName, sha, ref);
  }
  return head;
}

async function verifyTagRef(repo: GitWorktree, ref: string, expected: string) {
  if ((await readDirectRef(repo, ref)) !== expected)
    throw new Error("The selected tag object changed. Refresh and review it before retrying.");
}
