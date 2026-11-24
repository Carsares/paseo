import type { CheckoutGitStashEntry } from "../messages.js";
import { git, parseNameStatus, validateGitPaths } from "./git-workbench-state.js";
import type { GitWorktree } from "./repo-write-mutex.js";

export async function listStashes(repo: GitWorktree): Promise<CheckoutGitStashEntry[]> {
  const { stdout } = await git(repo, ["stash", "list", "-z", "--format=%gd%x00%H%x00%cI%x00%gs"]);
  const entries: CheckoutGitStashEntry[] = [];
  const entriesData = stdout.split("\0");
  for (let i = 0; i < entriesData.length - 1; i += 4) {
    const [stashRef, sha, createdAt, subject] = entriesData.slice(i, i + 4);
    if (!stashRef || !sha || !createdAt || subject === undefined) {
      throw new Error("Unexpected Git stash list result");
    }
    const label = /^(?:On|WIP on) ([^:]+): ?(.*)$/s.exec(subject);
    const branch = label?.[1];
    entries.push({
      stashRef,
      sha,
      createdAt,
      message: label?.[2] ?? subject,
      branch: branch && branch !== "(no branch)" ? branch : null,
    });
  }
  return entries;
}

async function resolveStash(repo: GitWorktree, sha: string) {
  const [entry, duplicate] = (await listStashes(repo)).filter((candidate) => candidate.sha === sha);
  if (!entry) throw new Error("Stash not found. Refresh and try again");
  if (duplicate)
    throw new Error(
      "Stash SHA identifies more than one entry. Resolve the duplicate before retrying",
    );
  return entry;
}

export async function showStash(repo: GitWorktree, stashRef: string) {
  const entry = await resolveStash(repo, stashRef);
  const { stdout } = await git(repo, [
    "stash",
    "show",
    "--include-untracked",
    "--name-status",
    "-z",
    "--find-renames",
    entry.sha,
  ]);
  return { entry, files: parseNameStatus(stdout) };
}

export async function createStash(
  repo: GitWorktree,
  options: {
    message?: string;
    includeUntracked?: boolean;
    keepIndex?: boolean;
    paths?: string[];
  },
) {
  const paths = options.paths === undefined ? [] : validateGitPaths(options.paths);
  await git(
    repo,
    [
      "--literal-pathspecs",
      "stash",
      "push",
      ...(options.includeUntracked ? ["--include-untracked"] : []),
      ...(options.keepIndex ? ["--keep-index"] : []),
      ...(options.message === undefined ? [] : ["-m", options.message]),
      "--",
      ...paths,
    ],
    { timeout: 120_000 },
  );
}

export async function mutateStash(input: {
  repo: GitWorktree;
  stashRef: string;
  action: "apply" | "pop" | "drop";
}): Promise<string | null> {
  const { repo, stashRef, action } = input;
  const entry = await resolveStash(repo, stashRef);
  // Git can apply by object ID, but it deletes reflog entries by position.
  // A concurrent external Git command can move the entry before deletion.
  if (action === "drop") {
    throw new Error("Stash retained: Git cannot safely delete this stash by SHA");
  }
  await git(repo, ["stash", "apply", "--index", entry.sha], { timeout: 120_000 });
  return action === "pop" ? "Stash applied and retained: Git cannot safely delete it by SHA" : null;
}
