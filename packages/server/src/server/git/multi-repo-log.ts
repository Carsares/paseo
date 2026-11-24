import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CHECKOUT_GIT_LOG_MAX_BYTES } from "@getpaseo/protocol/messages";
import type {
  CheckoutGitCommitDetail,
  CheckoutGitLogCommit,
  CheckoutGitRepoRefs,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../messages.js";
import { git, parseNameStatus, readHead } from "./git-workbench-state.js";
import { limitGitGraphRepo, resolveGraphRepos } from "./repo-discovery.js";
import type { GitWorktree } from "./repo-write-mutex.js";

type LogRequest = Extract<SessionInboundMessage, { type: "checkout.git.log.query.request" }>;
type LogResponse = Extract<SessionOutboundMessage, { type: "checkout.git.log.query.response" }>;
const cursorKey = randomBytes(32);
const HEX_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PREFIXES = ["refs/heads/", "refs/remotes/", "refs/tags/"] as const;
const BACKUP_PREFIX = "refs/paseo/backup/";
const GRAPH_ENV = { GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" };
const LOG_FORMAT = "%H%x00%P%x00%s%x00%an%x00%aI%x00%cI";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const MAX_LOG_BATCH = 64;

interface Ref {
  name: string;
  sha: string;
  commit: string | null;
}

async function readRefs(repo: GitWorktree, includeBackups = false): Promise<Ref[]> {
  const { stdout } = await git(
    repo,
    [
      "for-each-ref",
      "--sort=refname",
      "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)",
      ...PREFIXES,
      ...(includeBackups ? [BACKUP_PREFIX] : []),
    ],
    { envOverlay: GRAPH_ENV, maxOutputBytes: 2 * 1024 * 1024 },
  );
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, sha, type, peeled, peeledType] = line.split("\0");
      if (!name || !sha || !HEX_OID.test(sha)) throw new Error("Unexpected Git reference");
      return {
        name,
        sha,
        commit: type === "commit" ? sha : peeledCommit(peeledType, peeled),
      };
    });
}

function peeledCommit(type: string | undefined, oid: string | undefined): string | null {
  return type === "commit" && oid && HEX_OID.test(oid) ? oid : null;
}

export async function listGraphRefs(input: {
  cwd: string;
  repoRoots: string[];
  includeBackups?: boolean;
}): Promise<CheckoutGitRepoRefs[]> {
  return Promise.all(
    (await resolveGraphRepos(input.cwd, input.repoRoots)).map((repo) =>
      limitGitGraphRepo(async () => {
        const result: CheckoutGitRepoRefs = {
          repoRoot: repo.root,
          localBranches: [],
          remotes: [],
          tags: [],
          backups: [],
        };
        const remotes = new Map<string, CheckoutGitRepoRefs["remotes"][number]>();
        for (const { name, sha, commit } of await readRefs(repo, input.includeBackups)) {
          if (name.startsWith(PREFIXES[0])) {
            result.localBranches.push({ name: name.slice(PREFIXES[0].length), sha });
          } else if (name.startsWith(PREFIXES[1])) {
            const path = name.slice(PREFIXES[1].length);
            const slash = path.indexOf("/");
            if (slash < 1) continue;
            const remote = path.slice(0, slash);
            let group = remotes.get(remote);
            if (!group) {
              group = { name: remote, branches: [] };
              remotes.set(remote, group);
            }
            group.branches.push({ name: path.slice(slash + 1), sha });
          } else if (name.startsWith(PREFIXES[2])) {
            result.tags.push({ name: name.slice(PREFIXES[2].length), sha: commit ?? sha });
          } else if (name.startsWith(BACKUP_PREFIX)) {
            result.backups.push({ name, sha });
          }
        }
        result.remotes = [...remotes.values()];
        return result;
      }),
    ),
  );
}

function validateFilters(input: LogRequest): void {
  for (const value of [input.branchFilter, input.authorFilter, input.textQuery]) {
    if (value !== undefined && (value.length > 1024 || value.includes("\0"))) {
      throw new Error("Invalid Git graph filter");
    }
  }
  for (const value of [input.since, input.until]) {
    if (value !== undefined && (!ISO_DATE.test(value) || !Number.isFinite(Date.parse(value)))) {
      throw new Error("Git graph dates must use ISO 8601");
    }
  }
}

interface Lane {
  repo: GitWorktree;
  tips: string[];
  shallow: string;
  offset: number;
  queue: CheckoutGitLogCommit[];
  exhausted: boolean;
}

async function getLane(repo: GitWorktree, branch?: string): Promise<Lane> {
  const includeBackup = branch?.startsWith(BACKUP_PREFIX) ?? false;
  const refs = await readRefs(repo, includeBackup);
  const qualified =
    branch !== undefined && (includeBackup || PREFIXES.some((prefix) => branch.startsWith(prefix)));
  const head = !branch || branch === "HEAD" ? await readHead(repo) : null;
  const tips = new Set(head ? [head] : []);
  for (const ref of refs) {
    if (
      ref.commit &&
      (!branch ||
        ref.name === branch ||
        (!qualified && PREFIXES.some((prefix) => ref.name === prefix + branch)))
    )
      tips.add(ref.commit);
  }
  const shallow = await readFile(join(repo.commonDir, "shallow"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  return {
    repo,
    tips: [...tips].sort(),
    shallow,
    offset: 0,
    queue: [],
    exhausted: tips.size === 0,
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function sign(value: string): Buffer {
  return createHmac("sha256", cursorKey).update(value).digest();
}

function createCursor(snapshot: string, lanes: Lane[]): string {
  const body = Buffer.from(JSON.stringify([snapshot, lanes.map((lane) => lane.offset)])).toString(
    "base64url",
  );
  return body + "." + sign(body).toString("base64url");
}

function readCursor(cursor: string, snapshot: string, lanes: Lane[]): void {
  const match = cursor.length <= 1024 && /^([\w-]+)\.([\w-]{43})$/.exec(cursor);
  const invalid = () =>
    new Error("Git graph cursor expired or does not match the current query. Refresh the graph.");
  if (!match) throw invalid();
  const [, body, signature] = match;
  const mac = Buffer.from(signature!, "base64url");
  if (mac.length !== 32 || !timingSafeEqual(mac, sign(body!))) throw invalid();
  const state: unknown = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
  if (
    !Array.isArray(state) ||
    state[0] !== snapshot ||
    !Array.isArray(state[1]) ||
    state[1].length !== lanes.length
  ) {
    throw invalid();
  }
  for (const [index, lane] of lanes.entries()) {
    const offset: unknown = state[1][index];
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw invalid();
    lane.offset = offset;
  }
}

function logFilters(input: LogRequest): string[] {
  return [
    input.regex || input.authorFilter ? "--extended-regexp" : "--fixed-strings",
    ...(!input.matchCase ? ["--regexp-ignore-case"] : []),
    ...(input.authorFilter ? [`--author=${input.authorFilter}`] : []),
    ...(input.textQuery
      ? [
          `--grep=${input.regex || !input.authorFilter ? input.textQuery : escapeRegex(input.textQuery)}`,
        ]
      : []),
    ...(input.since ? [`--since-as-filter=${input.since}`] : []),
    ...(input.until ? [`--until=${input.until}`] : []),
  ];
}

async function fillLane(lane: Lane, filters: string[], requested: number): Promise<void> {
  if (lane.exhausted || lane.queue.length) return;
  let count = Math.min(MAX_LOG_BATCH, requested);
  for (;;) {
    try {
      const { stdout } = await git(
        lane.repo,
        [
          "log",
          "--date-order",
          "-z",
          `--format=${LOG_FORMAT}`,
          "--no-notes",
          "--no-show-signature",
          `--skip=${lane.offset}`,
          `--max-count=${count}`,
          ...filters,
          "--stdin",
          "--",
        ],
        {
          input: lane.tips.join("\n") + "\n",
          envOverlay: GRAPH_ENV,
          maxOutputBytes: count > 1 ? 2 * 1024 * 1024 : 20 * 1024 * 1024,
        },
      );
      const tokens = stdout.split("\0");
      tokens.pop();
      if (tokens.length % 6 !== 0) throw new Error("Unexpected Git log output");
      for (let i = 0; i < tokens.length; i += 6) {
        const [sha, parents, subject, authorName, authorDate, committerDate] = tokens.slice(
          i,
          i + 6,
        ) as [string, string, string, string, string, string];
        const parentList = parents ? parents.split(" ") : [];
        if (!HEX_OID.test(sha) || parentList.some((parent) => !HEX_OID.test(parent))) {
          throw new Error("Unexpected Git commit identity");
        }
        lane.queue.push({
          repoRoot: lane.repo.root,
          sha,
          parents: parentList,
          subject: clip(subject, 8192),
          authorName: clip(authorName, 1024),
          authorDate,
          committerDate,
        });
      }
      lane.exhausted = lane.queue.length < count;
      return;
    } catch (error) {
      if (
        count === 1 ||
        !(error instanceof Error) ||
        error.message !== "Git output exceeds the workbench limit"
      )
        throw error;
      count = Math.floor(count / 2);
    }
  }
}

function clip(value: string, length: number): string {
  if (value.length <= length) return value;
  const last = value.charCodeAt(length - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length) + "…";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isEarlier(a: CheckoutGitLogCommit, b: CheckoutGitLogCommit): boolean {
  const dateA = Date.parse(a.committerDate) || 0;
  const dateB = Date.parse(b.committerDate) || 0;
  return dateA !== dateB ? dateA > dateB : a.repoRoot < b.repoRoot;
}

function frameBytes(response: LogResponse): number {
  return Buffer.byteLength(JSON.stringify({ type: "session", message: response }));
}

export function enforceLogBudget(response: LogResponse): LogResponse {
  // Reserve the maximum number of digits required by approxBytes itself.
  response.payload.approxBytes = CHECKOUT_GIT_LOG_MAX_BYTES;
  if (frameBytes(response) > CHECKOUT_GIT_LOG_MAX_BYTES) {
    throw new Error("Git graph response envelope exceeds the frame budget");
  }
  for (;;) {
    const bytes = frameBytes(response);
    if (bytes === response.payload.approxBytes) return response;
    response.payload.approxBytes = bytes;
  }
}

export async function queryMultiRepoLog(input: LogRequest): Promise<LogResponse> {
  validateFilters(input);
  const repos = await resolveGraphRepos(input.cwd, input.repoRoots);
  const lanes = await Promise.all(
    repos.map((repo) => limitGitGraphRepo(() => getLane(repo, input.branchFilter))),
  );
  const snapshot = digest([
    lanes.map(({ repo, tips, shallow }) => [repo.root, tips, digest(shallow)]),
    input.branchFilter,
    input.authorFilter,
    input.textQuery,
    !!input.regex,
    !!input.matchCase,
    input.since,
    input.until,
  ]);
  if (input.cursor !== undefined) readCursor(input.cursor, snapshot, lanes);
  const pageSize = input.pageSize ?? 150;
  const filters = logFilters(input);
  const response: LogResponse = {
    type: "checkout.git.log.query.response",
    payload: {
      cwd: input.cwd,
      requestId: input.requestId,
      error: null,
      commits: [],
      nextCursor: null,
      hasMore: false,
      approxBytes: CHECKOUT_GIT_LOG_MAX_BYTES,
    },
  };
  // Next cursors are much smaller, but offsets can gain digits when a row is added.
  const reservedEnvelope = frameBytes(response) + 1024;
  let rowsBytes = 0;
  await Promise.all(
    lanes.map((lane) => limitGitGraphRepo(() => fillLane(lane, filters, pageSize + 1))),
  );
  while (response.payload.commits.length < pageSize) {
    let next: Lane | undefined;
    for (const lane of lanes) {
      if (lane.queue[0] && (!next || isEarlier(lane.queue[0], next.queue[0]!))) next = lane;
    }
    if (!next) break;
    const commit = next.queue[0]!;
    const rowBytes = Buffer.byteLength(JSON.stringify(commit)) + 1;
    if (reservedEnvelope + rowsBytes + rowBytes > CHECKOUT_GIT_LOG_MAX_BYTES) {
      if (response.payload.commits.length === 0)
        throw new Error("Git graph commit exceeds the frame budget");
      break;
    }
    response.payload.commits.push(commit);
    rowsBytes += rowBytes;
    next.queue.shift();
    next.offset++;
    await limitGitGraphRepo(() =>
      fillLane(next, filters, pageSize - response.payload.commits.length + 1),
    );
  }
  response.payload.hasMore = lanes.some((lane) => lane.queue.length > 0);
  response.payload.nextCursor = response.payload.hasMore ? createCursor(snapshot, lanes) : null;
  return enforceLogBudget(response);
}

export async function getCommitDetail(
  repo: GitWorktree,
  sha: string,
): Promise<CheckoutGitCommitDetail> {
  if (!HEX_OID.test(sha)) throw new Error("Select a full commit SHA");
  const result = await git(
    repo,
    [
      "show",
      "-s",
      "--no-notes",
      "--no-show-signature",
      "--pretty=format:%H%x00%s%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%b",
      sha,
      "--",
    ],
    { envOverlay: GRAPH_ENV },
  );
  const [
    resolved,
    subject,
    parents,
    name,
    email,
    date,
    committer,
    committerEmail,
    committerDate,
    ...body
  ] = result.stdout.split("\0");
  if (
    resolved !== sha ||
    subject === undefined ||
    parents === undefined ||
    name === undefined ||
    email === undefined ||
    !date ||
    committer === undefined ||
    committerEmail === undefined ||
    !committerDate
  ) {
    throw new Error("The selected object is not a commit");
  }
  // Diff merge commits against their first parent, matching the changes a graph row introduces.
  const parentList = parents ? parents.split(" ") : [];
  const range = parentList[0] ? [parentList[0], sha] : ["--root", sha];
  const args = [
    "diff-tree",
    "--no-commit-id",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    "-r",
    "-z",
  ];
  const names = await git(repo, [...args, "--name-status", ...range, "--"], {
    envOverlay: GRAPH_ENV,
  });
  const stats = await git(repo, [...args, "--numstat", ...range, "--"], { envOverlay: GRAPH_ENV });
  const changes = parseNameStatus(names.stdout);
  const byPath = new Map<string, { additions: number | null; deletions: number | null }>();
  const records = stats.stdout.split("\0");
  for (let i = 0; i < records.length - 1; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[i]!);
    if (!match) throw new Error("Unexpected Git numstat output");
    let path = match[3];
    if (!path) {
      i++;
      path = records[++i];
    }
    if (!path) throw new Error("Git did not report a changed path");
    byPath.set(path, {
      additions: match[1] === "-" ? null : Number(match[1]),
      deletions: match[2] === "-" ? null : Number(match[2]),
    });
  }
  return {
    sha,
    subject,
    body: body.join("\0"),
    parents: parentList,
    author: { name, email, date },
    committer: { name: committer, email: committerEmail, date: committerDate },
    files: changes
      .slice(0, 500)
      .map((file) =>
        Object.assign(file, byPath.get(file.path) ?? { additions: null, deletions: null }),
      ),
    filesTruncated: changes.length > 500,
  };
}
