import type { CheckoutGitRepoRefs } from "@getpaseo/protocol/messages";

const BACKUP_PREFIX = "refs/paseo/backup/";

export function referenceGroups(refs: CheckoutGitRepoRefs) {
  const group = (entries: CheckoutGitRepoRefs["tags"], prefix: string) =>
    entries.map(({ name, sha }) => ({ name, sha, ref: prefix + name }));
  return [
    { kind: "branches", label: null, entries: group(refs.localBranches, "refs/heads/") },
    ...refs.remotes.map(({ name, branches }) => ({
      kind: "remotes",
      label: name,
      entries: group(branches, "refs/remotes/" + name + "/"),
    })),
    { kind: "tags", label: null, entries: group(refs.tags, "refs/tags/") },
    {
      kind: "backups",
      label: null,
      entries: refs.backups.map(({ name, sha }) => ({
        name: name.startsWith(BACKUP_PREFIX) ? name.slice(BACKUP_PREFIX.length) : name,
        sha,
        ref: name,
      })),
    },
  ] as const;
}
