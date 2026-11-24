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

export interface ReviewLine {
  oldLine?: number;
  newLine?: number;
}

export interface ReviewStop {
  id: string;
  path: string;
  diffBaseSha?: string;
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
  hunk?: {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    patch: string;
  };
  line?: ReviewLine;
}

export interface ReviewGuide {
  identity: ReviewIdentity;
  version: ReviewVersion;
  diffBaseSha?: string;
  stops: ReviewStop[];
  coverage: {
    filesLoaded: number;
    totalFiles?: number;
    hasMore: boolean;
    missingPatches: number;
    reason?: string;
  };
  commentMode: "remote" | "chat";
  viewedMode: "remote" | "local";
}

export interface ReviewTarget {
  cwd: string;
  identity: ReviewIdentity;
}

export interface ReviewGuideRequest extends ReviewTarget {
  expectedVersion?: ReviewVersion;
  refresh?: boolean;
}

export interface ReviewVersionRequest extends ReviewTarget {
  version: ReviewVersion;
}

export interface ReviewCommentRequest extends ReviewVersionRequest {
  stopId: string;
  body: string;
  operationId: string;
}

export interface ReviewViewedRequest extends ReviewVersionRequest {
  path: string;
  viewed: boolean;
  expectedViewerId?: string;
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

export type ReviewErrorCode =
  | "stale"
  | "permission"
  | "unsupported"
  | "unavailable"
  | "unknown_outcome"
  | "invalid_target"
  | "expired";

export interface ReviewFailure {
  code: ReviewErrorCode;
  message?: string;
}

export interface ReviewGuidePort {
  getReviewGuide(input: ReviewGuideRequest): Promise<ReviewGuide>;
  getReviewViewed(input: ReviewVersionRequest): Promise<ReviewViewed>;
  /** Resolve with the authoritative state after reading back the write. */
  setReviewViewed(input: ReviewViewedRequest): Promise<ReviewViewedEntry>;
  /** Resolve after read-back confirms publication. Reject with ReviewFailure for domain errors.
   * A transport interruption after dispatch must be treated as unknown_outcome. */
  publishReviewComment(input: ReviewCommentRequest): Promise<void>;
}

/** Supply this only for a connected host advertising forgeReviewGuide. */
export interface ReviewGuideConnection {
  port: ReviewGuidePort;
  identity: ReviewIdentity;
  expectedVersion?: ReviewVersion;
  /** A change in the observed hosted head invalidates the current guide selection. */
  observedHeadSha?: string;
  /** Re-read the existing activity timeline after confirmed publication. */
  onCommentPublished?: (input: ReviewCommentRequest) => void;
}

export function reviewIdentityKey({ forge, host, projectPath, number }: ReviewIdentity): string {
  return JSON.stringify([forge, host, projectPath, number]);
}

export function reviewVersionKey({ baseSha, headSha, startSha }: ReviewVersion): string {
  return JSON.stringify([baseSha, headSha, startSha]);
}

function isReviewErrorCode(code: unknown): code is ReviewErrorCode {
  return (
    code === "stale" ||
    code === "permission" ||
    code === "unsupported" ||
    code === "unavailable" ||
    code === "unknown_outcome" ||
    code === "invalid_target" ||
    code === "expired"
  );
}

export function reviewFailure(
  error: unknown,
  fallback: ReviewErrorCode = "unavailable",
): ReviewFailure {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    isReviewErrorCode(error.code)
  ) {
    return {
      code: error.code,
      message: "message" in error && typeof error.message === "string" ? error.message : undefined,
    };
  }
  return { code: fallback };
}
