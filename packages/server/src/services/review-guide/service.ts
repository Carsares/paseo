import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import { buildReviewStops, type ReviewFiles } from "./patch.js";
import type {
  GetReviewGuideOptions,
  PublishedReviewComment,
  ReviewGuide,
  ReviewGuideService,
  ReviewIdentity,
  ReviewStop,
  ReviewTarget,
  ReviewVersion,
  ReviewViewed,
  ReviewViewedEntry,
} from "./types.js";

export type ReviewGuideErrorCode =
  | "stale"
  | "permission"
  | "unsupported"
  | "unavailable"
  | "unknown_outcome"
  | "invalid_target"
  | "expired";

const messages: Record<ReviewGuideErrorCode, string> = {
  stale: "The review version changed. Refresh the guide before continuing.",
  permission: "The forge account does not have permission for this review operation.",
  unsupported: "The forge does not support this review operation.",
  unavailable: "The forge could not provide the review data.",
  unknown_outcome: "The forge did not confirm the write. Check the forge before trying again.",
  invalid_target: "The review target does not match the checkout or review.",
  expired: "The review stop is no longer available. Refresh the guide before continuing.",
};

export class ReviewGuideError extends Error {
  constructor(readonly code: ReviewGuideErrorCode) {
    super(messages[code]);
    this.name = "ReviewGuideError";
  }
}

export function sameVersion(left: ReviewVersion, right: ReviewVersion): boolean {
  return (
    left.headSha === right.headSha &&
    left.baseSha === right.baseSha &&
    left.startSha === right.startSha
  );
}

export function assertReviewVersion(actual: ReviewVersion, expected?: ReviewVersion): void {
  if (expected && !sameVersion(actual, expected)) throw new ReviewGuideError("stale");
}

export class ReviewDeadlineError extends ReviewGuideError {
  constructor() {
    super("unavailable");
  }
}

export class ReviewReadBudget {
  private readonly end: number;

  constructor(ms = 25_000) {
    this.end = performance.now() + ms;
  }

  portion(ms: number, reserveMs = 0): ReviewReadBudget {
    return new ReviewReadBudget(Math.min(ms, this.end - performance.now() - reserveMs));
  }

  async run<T>(read: () => Promise<T>): Promise<T> {
    const remaining = this.end - performance.now();
    if (remaining <= 0) throw new ReviewDeadlineError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ReviewDeadlineError()), remaining);
        }),
        read(),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface ReviewSnapshot {
  version: ReviewVersion;
  requestId: string;
  /** Provider-specific state needed to determine diff coverage. */
  totalFiles?: number;
  sourceProjectId?: number;
}

export interface BoundReview {
  identity: ReviewIdentity;
  current(budget: ReviewReadBudget): Promise<ReviewSnapshot>;
  files(snapshot: ReviewSnapshot, budget: ReviewReadBudget): Promise<ReviewFiles>;
  viewed?: {
    get(version: ReviewVersion): Promise<ReviewViewed>;
    set(
      version: ReviewVersion,
      path: string,
      viewed: boolean,
      expectedViewerId?: string,
    ): Promise<ReviewViewedEntry>;
  };
  publish?(
    snapshot: ReviewSnapshot,
    stop: ReviewStop,
    body: string,
  ): Promise<PublishedReviewComment>;
}

const GUIDE_TTL_MS = 2 * 60_000;
const MAX_OPERATIONS = 10_000;
const OPERATION_TTL_MS = 24 * 60 * 60_000;

interface Operation {
  fingerprint: string;
  expiresAt: number;
  result: Promise<PublishedReviewComment>;
}

function keyFor(identity: ReviewIdentity) {
  return [identity.forge, identity.host, identity.projectPath, identity.number];
}

function keyForVersion(version: ReviewVersion) {
  return [version.baseSha, version.headSha, version.startSha];
}

export function createReviewGuideService(
  resolve: (target: ReviewTarget, budget: ReviewReadBudget) => Promise<BoundReview>,
  now: () => number = Date.now,
): Required<Pick<ReviewGuideService, "getReviewGuide">> &
  Omit<ReviewGuideService, "getReviewGuide"> {
  const cache = new LRUCache<string, { expiresAt: number; guide: Promise<ReviewGuide> }>({
    max: 24,
  });
  const operations = new Map<string, Operation>();

  async function bind(input: ReviewTarget, budget = new ReviewReadBudget()) {
    if (!Number.isSafeInteger(input.identity.number) || input.identity.number < 1) {
      throw new ReviewGuideError("invalid_target");
    }
    return resolve(input, budget);
  }

  function cacheKey(cwd: string, bound: BoundReview, snapshot: ReviewSnapshot) {
    return JSON.stringify([
      cwd,
      ...keyFor(bound.identity),
      ...keyForVersion(snapshot.version),
      snapshot.requestId,
      snapshot.totalFiles,
      snapshot.sourceProjectId,
    ]);
  }

  function readCachedGuide(key: string) {
    const entry = cache.get(key);
    if (entry && entry.expiresAt > now()) return entry.guide;
    if (entry) cache.delete(key);
  }

  function getGuide(
    input: GetReviewGuideOptions,
    bound: BoundReview,
    snapshot: ReviewSnapshot,
    budget: ReviewReadBudget,
  ) {
    const key = cacheKey(input.cwd, bound, snapshot);
    const cached = input.refresh ? undefined : readCachedGuide(key);
    if (cached) return cached;
    const entry = { expiresAt: Infinity, guide: Promise.resolve().then(loadGuide) };
    cache.set(key, entry);
    return entry.guide;

    function loadGuide() {
      return bound
        .files(snapshot, budget)
        .then(
          (files): ReviewGuide => ({
            identity: bound.identity,
            version: snapshot.version,
            ...(files.diffBaseSha ? { diffBaseSha: files.diffBaseSha } : {}),
            ...buildReviewStops(bound.identity, snapshot.version, files),
            commentMode: bound.publish ? "remote" : "chat",
            viewedMode: bound.viewed ? "remote" : "local",
          }),
        )
        .then((guide) => {
          entry.expiresAt = now() + GUIDE_TTL_MS;
          return guide;
        })
        .catch((error: unknown) => {
          if (cache.peek(key) === entry) cache.delete(key);
          throw error;
        });
    }
  }

  return {
    async getReviewGuide(input) {
      const budget = new ReviewReadBudget();
      const bound = await bind(input, budget);
      const snapshot = await bound.current(budget);
      assertReviewVersion(snapshot.version, input.expectedVersion);
      const guide = await getGuide(input, bound, snapshot, budget);
      // The app correlates by the exact request tuple. GitHub accepts repository
      // names case-insensitively, so preserve the verified caller spelling.
      return { ...guide, identity: input.identity };
    },
    async getReviewViewed(input) {
      const bound = await bind(input);
      if (!bound.viewed) throw new ReviewGuideError("unsupported");
      return bound.viewed.get(input.version);
    },
    async setReviewViewed(input) {
      const bound = await bind(input);
      if (!bound.viewed) throw new ReviewGuideError("unsupported");
      if (!input.path || input.path.length > 4096 || input.path.includes("\0")) {
        throw new ReviewGuideError("invalid_target");
      }
      return bound.viewed.set(input.version, input.path, input.viewed, input.expectedViewerId);
    },
    async publishReviewComment(input) {
      if (
        !input.body.trim() ||
        Buffer.byteLength(input.body) > 32_768 ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(input.operationId) ||
        !/^[a-f0-9]{64}$/.test(input.stopId)
      ) {
        throw new ReviewGuideError("invalid_target");
      }
      const budget = new ReviewReadBudget();
      const bound = await bind(input, budget);
      const publish = bound.publish;
      if (!publish) throw new ReviewGuideError("unsupported");
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            input.cwd,
            ...keyFor(bound.identity),
            ...keyForVersion(input.version),
            input.stopId,
            input.body,
          ]),
        )
        .digest("hex");
      // Retain completed and ambiguous writes for the lifetime of this entry.
      // In-flight writes never expire, and reaching the limit cannot evict one.
      const time = now();
      for (const [key, operation] of operations) {
        if (operation.expiresAt <= time) operations.delete(key);
      }
      const existing = operations.get(input.operationId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ReviewGuideError("invalid_target");
        return existing.result;
      }
      if (operations.size >= MAX_OPERATIONS) throw new ReviewGuideError("unavailable");

      let attempted = false;
      const operation: Operation = {
        fingerprint,
        expiresAt: Infinity,
        result: Promise.resolve()
          .then(async () => {
            const snapshot = await bound.current(budget);
            assertReviewVersion(snapshot.version, input.version);
            const key = cacheKey(input.cwd, bound, snapshot);
            const issued = readCachedGuide(key);
            if (!issued) throw new ReviewGuideError("expired");
            const guide = await issued;
            const stop = guide.stops.find((candidate) => candidate.id === input.stopId);
            if (!stop?.line) throw new ReviewGuideError("expired");
            const current = await bound.current(budget);
            assertReviewVersion(current.version, input.version);
            if (current.requestId !== snapshot.requestId) throw new ReviewGuideError("stale");
            if (readCachedGuide(key) !== issued) throw new ReviewGuideError("expired");
            attempted = true;
            return publish(current, stop, input.body);
          })
          .finally(() => {
            if (attempted) operation.expiresAt = now() + OPERATION_TTL_MS;
            else operations.delete(input.operationId);
          }),
      };
      operations.set(input.operationId, operation);
      return operation.result;
    },
  };
}
