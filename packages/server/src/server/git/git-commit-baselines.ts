const TTL_MS = 10 * 60_000;
const MAX_BASELINES = 128;
const COMMIT_REQUEST_ID = /^paseo-git-commit:([^:]{1,160}):[^:]{1,160}$/;

interface CommitBaseline {
  cwd: string;
  repoRoot: string;
  head: string | null;
  branchRef: string | null;
  tree: string;
}

export class GitCommitBaselines {
  private readonly entries = new Map<string, { baseline: CommitBaseline; expiresAt: number }>();

  remember(statusRequestId: string, baseline: CommitBaseline): boolean {
    if (!statusRequestId || statusRequestId.length > 160 || statusRequestId.includes(":")) {
      return false;
    }
    const now = performance.now();
    const existing = this.entries.get(statusRequestId);
    if (existing && existing.expiresAt > now) {
      const previous = existing.baseline;
      return (
        previous.cwd === baseline.cwd &&
        previous.repoRoot === baseline.repoRoot &&
        previous.head === baseline.head &&
        previous.branchRef === baseline.branchRef &&
        previous.tree === baseline.tree
      );
    }
    this.entries.delete(statusRequestId);
    if (this.entries.size >= MAX_BASELINES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(statusRequestId, { baseline, expiresAt: now + TTL_MS });
    return true;
  }

  get(commitRequestId: string): CommitBaseline | undefined {
    const statusRequestId = COMMIT_REQUEST_ID.exec(commitRequestId)?.[1];
    if (!statusRequestId) return;
    const entry = this.entries.get(statusRequestId);
    if (!entry) return;
    if (entry.expiresAt <= performance.now()) {
      this.entries.delete(statusRequestId);
      return;
    }
    return entry.baseline;
  }

  clear(): void {
    this.entries.clear();
  }
}
