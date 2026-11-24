import { z } from "zod";
import { REVIEW_FILE_LIMIT, type ReviewFile, type ReviewFiles } from "./patch.js";
import {
  assertReviewVersion,
  createReviewGuideService,
  ReviewGuideError,
  ReviewReadBudget,
  type ReviewSnapshot,
} from "./service.js";
import {
  decode,
  readError,
  reviewHttp,
  ReviewHttpError,
  safeProjectPath,
  writeError,
} from "./transport.js";
import type { ReviewVersion, ReviewViewed, ReviewViewedEntry } from "./types.js";

const positive = z.number().int().positive();
const count = z.number().int().nonnegative();
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
const prSchema = z.object({
  id: positive,
  number: positive,
  base: z.object({ sha: oid, repo: z.object({ full_name: z.string() }) }),
  head: z.object({ sha: oid }),
  changed_files: count,
});
const fileSchema = z.object({
  filename: z.string().min(1),
  previous_filename: z.string().min(1).optional(),
  sha: oid.optional(),
  status: z.string().optional(),
  patch: z.string().nullish(),
  additions: count,
  deletions: count,
});
const COMPARE_FILE_LIMIT = 300;
const comparisonSchema = z.object({
  base_commit: z.object({ sha: oid }),
  merge_base_commit: z.object({ sha: oid }),
  files: z.array(fileSchema).max(COMPARE_FILE_LIMIT),
});
const fileBlobSchema = z.object({ type: z.literal("file"), sha: oid });
const originSchema = z.object({ parent: z.object({ full_name: z.string() }).nullish() });
const commentId = z.object({ id: positive });
const commentSchema = commentId.extend({
  path: z.string(),
  original_commit_id: oid,
  original_line: positive,
  side: z.enum(["LEFT", "RIGHT"]),
  pull_request_url: z.url(),
});
const viewedStates = { VIEWED: "viewed", UNVIEWED: "unviewed", DISMISSED: "dismissed" } as const;
const graphFiles = z.object({
  totalCount: count,
  nodes: z.array(
    z.object({
      path: z.string(),
      viewerViewedState: z.enum(["VIEWED", "UNVIEWED", "DISMISSED"]),
    }),
  ),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
});
const graphPr = z.object({
  id: z.string().min(1),
  baseRefOid: oid,
  headRefOid: oid,
  files: graphFiles.nullish(),
});
const graphSchema = z.object({
  data: z.object({
    repository: z.object({ pullRequest: graphPr }),
    viewer: z.object({ id: z.string().min(1) }),
  }),
});
const graphErrors = z.object({
  errors: z.array(
    z.object({
      message: z.string(),
      type: z.string().optional(),
      extensions: z.object({ code: z.string().optional() }).optional(),
    }),
  ),
});

function graphError(json: unknown): ReviewGuideError | undefined {
  const parsed = graphErrors.safeParse(json);
  if (!parsed.success || !parsed.data.errors.length) return undefined;
  const { errors } = parsed.data;
  if (
    errors.every(
      (error) =>
        (error.type === "undefinedField" ||
          error.extensions?.code === "undefinedField" ||
          /^(?:Cannot query field |Field .+ (?:doesn't|does not) exist on type )/.test(
            error.message,
          )) &&
        /\b(?:viewerViewedState|markFileAsViewed|unmarkFileAsViewed)\b/.test(error.message),
    )
  ) {
    return new ReviewGuideError("unsupported");
  }
  if (
    errors.some((error) => error.type === "FORBIDDEN" || error.extensions?.code === "FORBIDDEN")
  ) {
    return new ReviewGuideError("permission");
  }
  return new ReviewGuideError("unavailable");
}

const PAGE_SIZE = 100;
const PAGE_LIMIT = REVIEW_FILE_LIMIT / PAGE_SIZE;
const repoEndpoint = (path: string) => "repos/" + path.split("/").map(encodeURIComponent).join("/");

export function createGitHubReviewGuide(options: {
  origin: (cwd: string) => Promise<{ host: string; path: string } | null>;
  run: (args: string[], cwd: string, host: string, env?: Record<string, string>) => Promise<string>;
  now: () => number;
}) {
  return createReviewGuideService(async (target, budget) => {
    const { cwd, identity } = target;
    if (
      identity.forge !== "github" ||
      !safeProjectPath(identity.projectPath) ||
      identity.projectPath.split("/").length !== 2
    )
      throw new ReviewGuideError("invalid_target");
    const origin = await budget
      .run(() => options.origin(cwd))
      .catch((error: unknown) => {
        throw readError(error);
      });
    if (!origin || origin.host !== identity.host.toLowerCase() || !safeProjectPath(origin.path)) {
      throw new ReviewGuideError("invalid_target");
    }
    const host = origin.host;
    const request = (args: string[], env?: Record<string, string>) =>
      reviewHttp(
        (apiArgs) => options.run(["api", "--hostname", host, "-i", ...apiArgs], cwd, host, env),
        args,
      );
    const read = (scope: ReviewReadBudget, endpoint: string) =>
      scope
        .run(() => request([endpoint]))
        .catch((error: unknown) => {
          throw readError(error);
        });

    let projectPath = origin.path;
    if (projectPath.toLowerCase() !== identity.projectPath.toLowerCase()) {
      const repo = decode(originSchema, (await read(budget, repoEndpoint(origin.path))).json);
      if (
        !repo.parent ||
        repo.parent.full_name.toLowerCase() !== identity.projectPath.toLowerCase()
      ) {
        throw new ReviewGuideError("invalid_target");
      }
      projectPath = repo.parent.full_name;
    }
    const endpoint = repoEndpoint(projectPath) + "/pulls/" + identity.number;
    const [owner, name] = projectPath.split("/");
    const canonicalIdentity = {
      ...identity,
      host: origin.host,
      projectPath: projectPath.toLowerCase(),
    };

    async function current(scope: ReviewReadBudget): Promise<ReviewSnapshot> {
      const pr = decode(prSchema, (await read(scope, endpoint)).json);
      if (
        pr.number !== identity.number ||
        pr.base.repo.full_name.toLowerCase() !== projectPath.toLowerCase()
      ) {
        throw new ReviewGuideError("invalid_target");
      }
      return {
        version: { baseSha: pr.base.sha, headSha: pr.head.sha },
        requestId: String(pr.id),
        totalFiles: pr.changed_files,
      };
    }

    async function graph(query: string, scope: ReviewReadBudget, env?: Record<string, string>) {
      try {
        const { json } = await scope.run(() => request(["graphql", "-f", "query=" + query], env));
        const error = graphError(json);
        if (error) throw error;
        return json;
      } catch (error) {
        if (
          error instanceof ReviewHttpError &&
          (error.status === null || error.status === 200 || error.status === 400)
        ) {
          const reported = graphError(error.response);
          if (reported) throw reported;
        }
        throw readError(error);
      }
    }

    const graphTarget =
      "repository(owner: " +
      JSON.stringify(owner) +
      ", name: " +
      JSON.stringify(name) +
      ") { pullRequest(number: " +
      identity.number +
      ") { id baseRefOid headRefOid";
    async function graphSnapshot(
      scope: ReviewReadBudget,
      version: ReviewVersion,
      cursor?: string | null,
      env?: Record<string, string>,
    ) {
      const files =
        cursor === undefined
          ? ""
          : " files(first: 100, after: " +
            JSON.stringify(cursor) +
            ") { totalCount nodes { path viewerViewedState } pageInfo { hasNextPage endCursor } }";
      const { repository, viewer } = decode(
        graphSchema,
        await graph("query { viewer { id } " + graphTarget + files + " } } }", scope, env),
      ).data;
      const pr = repository.pullRequest;
      assertReviewVersion({ baseSha: pr.baseRefOid, headSha: pr.headRefOid }, version);
      return { ...pr, viewerId: viewer.id };
    }

    async function viewed(
      version: ReviewVersion,
      findPath?: string,
      env?: Record<string, string>,
    ): Promise<ReviewViewed & { nodeId: string; viewerId: string }> {
      const entries = new Map<string, ReviewViewedEntry>();
      const scope = new ReviewReadBudget(12_000);
      let cursor: string | null = null;
      let nodeId = "";
      let viewerId = "";
      let hasMore = false;
      let totalCount: number | undefined;
      for (let page = 0; page < PAGE_LIMIT; page++) {
        const pr = await graphSnapshot(scope, version, cursor, env);
        if (!pr.files) throw new ReviewGuideError("unavailable");
        if (nodeId && (nodeId !== pr.id || viewerId !== pr.viewerId)) {
          throw new ReviewGuideError("stale");
        }
        if (totalCount !== undefined && totalCount !== pr.files.totalCount) {
          throw new ReviewGuideError("stale");
        }
        totalCount = pr.files.totalCount;
        nodeId = pr.id;
        viewerId = pr.viewerId;
        for (const file of pr.files.nodes) {
          if (entries.has(file.path)) throw new ReviewGuideError("unavailable");
          entries.set(file.path, { path: file.path, state: viewedStates[file.viewerViewedState] });
        }
        if (entries.size > totalCount) throw new ReviewGuideError("unavailable");
        const nextPage = pr.files.pageInfo.hasNextPage;
        hasMore = nextPage || entries.size < totalCount;
        if (!nextPage || (findPath && entries.has(findPath))) break;
        const next = pr.files.pageInfo.endCursor;
        if (!next || next === cursor) throw new ReviewGuideError("unavailable");
        cursor = next;
      }
      const after = await graphSnapshot(new ReviewReadBudget(5_000), version, undefined, env);
      if (after.id !== nodeId || after.viewerId !== viewerId) {
        throw new ReviewGuideError("stale");
      }
      return { entries: [...entries.values()], hasMore, nodeId, viewerId };
    }

    async function setViewedState(
      nodeId: string,
      path: string,
      mutation: "markFileAsViewed" | "unmarkFileAsViewed",
      env: Record<string, string>,
    ) {
      try {
        const { json } = await request(
          [
            "graphql",
            "-f",
            "query=mutation { " +
              mutation +
              "(input: { pullRequestId: " +
              JSON.stringify(nodeId) +
              ", path: " +
              JSON.stringify(path) +
              " }) { clientMutationId } }",
          ],
          env,
        );
        const error = graphError(json);
        if (error?.code === "unsupported" || error?.code === "permission") throw error;
        if (
          error ||
          !z
            .object({
              data: z.object({
                [mutation]: z.object({ clientMutationId: z.string().nullable() }),
              }),
            })
            .safeParse(json).success
        )
          throw new ReviewGuideError("unknown_outcome");
      } catch (error) {
        const reported =
          error instanceof ReviewHttpError &&
          !error.rateLimited &&
          (error.status === null || error.status === 200 || error.status === 400)
            ? graphError(error.response)
            : undefined;
        if (reported?.code === "unsupported" || reported?.code === "permission") throw reported;
        if (error instanceof ReviewGuideError && error.code === "unsupported") throw error;
        throw writeError(error);
      }
    }

    return {
      identity: canonicalIdentity,
      current,
      async files(snapshot, readBudget): Promise<ReviewFiles> {
        const scope = readBudget.portion(12_000, 4_000);
        const repo = repoEndpoint(projectPath);
        const { baseSha, headSha } = snapshot.version;
        // GitHub renders PRs as a three-dot comparison from the merge base.
        // The PR files endpoint cannot take SHAs; even checking the PR before
        // and after it cannot detect a force push away and back between reads.
        const comparison = decode(
          comparisonSchema,
          (await read(scope, repo + "/compare/" + baseSha + "..." + headSha + "?per_page=1&page=1"))
            .json,
        );
        const totalFiles = snapshot.totalFiles ?? 0;
        const paths = new Set(comparison.files.map((row) => row.filename));
        if (
          comparison.base_commit.sha !== baseSha ||
          paths.size !== comparison.files.length ||
          paths.size > totalFiles
        ) {
          throw new ReviewGuideError("unavailable");
        }
        const mergeBase = comparison.merge_base_commit.sha;
        const files: ReviewFile[] = [];
        const renameScope = scope.portion(2_000);
        let renameChecks = 0;
        for (const row of comparison.files) {
          let pureRename = false;
          // A binary change can have zero additions/deletions. Compare blob
          // IDs at the immutable left and right sides before ranking a rename.
          if (
            row.status === "renamed" &&
            row.previous_filename &&
            row.sha &&
            !row.patch &&
            row.additions === 0 &&
            row.deletions === 0 &&
            renameChecks < 20
          ) {
            const segments = row.previous_filename.split("/");
            if (segments.every((segment) => segment && segment !== "." && segment !== "..")) {
              renameChecks++;
              try {
                const old = decode(
                  fileBlobSchema,
                  (
                    await read(
                      renameScope,
                      repo +
                        "/contents/" +
                        segments.map(encodeURIComponent).join("/") +
                        "?ref=" +
                        mergeBase,
                    )
                  ).json,
                );
                pureRename = old.sha === row.sha;
              } catch {
                // The file remains reviewable as a rename with an unavailable patch.
              }
            }
          }
          files.push({
            path: row.filename,
            oldPath: row.previous_filename,
            patch: row.patch,
            additions: row.additions,
            deletions: row.deletions,
            pureRename,
          });
        }

        const after = await current(readBudget.portion(5_000));
        assertReviewVersion(after.version, snapshot.version);
        if (after.requestId !== snapshot.requestId || after.totalFiles !== snapshot.totalFiles) {
          throw new ReviewGuideError("stale");
        }
        const hasMore = files.length < totalFiles;
        return {
          files,
          diffBaseSha: mergeBase,
          totalFiles,
          hasMore,
          reason: hasMore ? "forge_diff_limit" : undefined,
        };
      },
      async publish(snapshot, stop, body) {
        const line = stop.line?.newLine ?? stop.line?.oldLine;
        if (!line) throw new ReviewGuideError("invalid_target");
        const side = stop.line?.newLine !== undefined ? "RIGHT" : "LEFT";
        let id: number;
        try {
          id = decode(
            commentId,
            (
              await request([
                "-X",
                "POST",
                endpoint + "/comments",
                "-f",
                "body=" + body,
                "-f",
                "commit_id=" + snapshot.version.headSha,
                "-f",
                "path=" + stop.path,
                "-F",
                "line=" + line,
                "-f",
                "side=" + side,
              ])
            ).json,
          ).id;
        } catch (error) {
          throw writeError(error);
        }
        try {
          const scope = new ReviewReadBudget(8_000);
          const confirmed = decode(
            commentSchema,
            (await read(scope, repoEndpoint(projectPath) + "/pulls/comments/" + id)).json,
          );
          if (
            confirmed.id !== id ||
            !new URL(confirmed.pull_request_url).pathname
              .toLowerCase()
              .endsWith("/" + endpoint.toLowerCase()) ||
            confirmed.path !== stop.path ||
            confirmed.original_commit_id !== snapshot.version.headSha ||
            confirmed.original_line !== line ||
            confirmed.side !== side
          )
            throw new ReviewGuideError("unknown_outcome");
          const after = await current(scope);
          assertReviewVersion(after.version, snapshot.version);
          if (after.requestId !== snapshot.requestId) throw new ReviewGuideError("unknown_outcome");
          return { id: String(id) };
        } catch {
          throw new ReviewGuideError("unknown_outcome");
        }
      },
      viewed: {
        async get(version) {
          const { entries, hasMore, viewerId } = await viewed(version);
          return { entries, hasMore, viewerId };
        },
        async set(version, path, mark, expectedViewerId) {
          // Pin the same credential across CLI processes. An account switch between
          // the preflight and the mutation must not write to the newly active account.
          const token = await new ReviewReadBudget(5_000)
            .run(() => options.run(["auth", "token", "--hostname", host], cwd, host))
            .catch((error: unknown) => {
              throw readError(error);
            });
          if (!token || /\s/.test(token)) throw new ReviewGuideError("permission");
          const env = { GH_TOKEN: token, GH_ENTERPRISE_TOKEN: token };
          const before = await viewed(version, path, env);
          if (expectedViewerId !== undefined && expectedViewerId !== before.viewerId) {
            throw new ReviewGuideError("stale");
          }
          const prior = before.entries.find((entry) => entry.path === path);
          if (!prior) throw new ReviewGuideError(before.hasMore ? "unavailable" : "invalid_target");
          const desired = mark ? "viewed" : "unviewed";
          if (prior.state === desired) return prior;

          await setViewedState(
            before.nodeId,
            path,
            mark ? "markFileAsViewed" : "unmarkFileAsViewed",
            env,
          );
          // The mutation accepts a PR node ID and a path, without any head
          // condition. A version change or failed read-back leaves it unknown.
          try {
            const after = await viewed(version, path, env);
            const active = await graphSnapshot(new ReviewReadBudget(5_000), version);
            const entry = after.entries.find((candidate) => candidate.path === path);
            if (
              after.nodeId === before.nodeId &&
              after.viewerId === before.viewerId &&
              active.id === before.nodeId &&
              active.viewerId === before.viewerId &&
              entry?.state === desired
            )
              return entry;
          } catch {
            throw new ReviewGuideError("unknown_outcome");
          }
          throw new ReviewGuideError("unknown_outcome");
        },
      },
    };
  }, options.now);
}
