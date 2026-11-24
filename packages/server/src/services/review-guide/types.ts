export interface ReviewIdentity {
  forge: string;
  host: string;
  projectPath: string;
  number: number;
}

export interface ReviewVersion {
  baseSha: string;
  headSha: string;
  startSha?: string;
}

const hostedSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function parseHostedReviewVersion(
  baseSha: string | null | undefined,
  headSha: string | null | undefined,
  startSha?: string,
): ReviewVersion | undefined {
  if (!baseSha || !headSha || !hostedSha.test(baseSha) || !hostedSha.test(headSha)) return;
  if (startSha !== undefined && !hostedSha.test(startSha)) return;
  return startSha === undefined ? { baseSha, headSha } : { baseSha, headSha, startSha };
}

export interface ReviewLine {
  oldLine?: number;
  newLine?: number;
}

export interface ReviewHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  patch: string;
}

export interface ReviewStop {
  id: string;
  path: string;
  oldPath?: string;
  priority: "attention" | "normal" | "mechanical";
  reason:
    | "sensitive"
    | "substantial"
    | "source"
    | "rename"
    | "lockfile"
    | "generated"
    | "unavailable";
  hunk?: ReviewHunk;
  line?: ReviewLine;
}

export interface ReviewCoverage {
  filesLoaded: number;
  totalFiles?: number;
  hasMore: boolean;
  missingPatches: number;
  reason?: string;
}

export interface ReviewGuide {
  identity: ReviewIdentity;
  version: ReviewVersion;
  diffBaseSha?: string;
  stops: ReviewStop[];
  coverage: ReviewCoverage;
  commentMode: "remote" | "chat";
  viewedMode: "remote" | "local";
}

export interface ReviewTarget {
  /** Trusted checkout path, already authorized by the caller. */
  cwd: string;
  identity: ReviewIdentity;
}

export interface GetReviewGuideOptions extends ReviewTarget {
  expectedVersion?: ReviewVersion;
  refresh?: boolean;
}

export interface GetReviewViewedOptions extends ReviewTarget {
  version: ReviewVersion;
}

export interface SetReviewViewedOptions extends GetReviewViewedOptions {
  path: string;
  viewed: boolean;
  expectedViewerId?: string;
}

export interface PublishReviewCommentOptions extends GetReviewViewedOptions {
  stopId: string;
  body: string;
  operationId: string;
}

export interface ReviewViewedEntry {
  path: string;
  state: "viewed" | "unviewed" | "dismissed";
}

export interface ReviewViewed {
  entries: ReviewViewedEntry[];
  hasMore?: boolean;
  viewerId?: string;
}

export interface PublishedReviewComment {
  /** Provider ID from a separate read after creating the comment. */
  id: string;
}

export interface ReviewGuideService {
  getReviewGuide(options: GetReviewGuideOptions): Promise<ReviewGuide>;
  getReviewViewed?(options: GetReviewViewedOptions): Promise<ReviewViewed>;
  setReviewViewed?(options: SetReviewViewedOptions): Promise<ReviewViewedEntry>;
  publishReviewComment?(options: PublishReviewCommentOptions): Promise<PublishedReviewComment>;
}
