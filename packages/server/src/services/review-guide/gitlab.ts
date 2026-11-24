import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ReviewFiles } from "./patch.js";
import {
  assertReviewVersion,
  createReviewGuideService,
  ReviewGuideError,
  ReviewReadBudget,
  sameVersion,
  type ReviewSnapshot,
} from "./service.js";
import {
  decode,
  hasNextPage,
  readError,
  reviewHttp,
  safeProjectPath,
  writeError,
} from "./transport.js";
import type { ReviewVersion } from "./types.js";

const positive = z.number().int().positive();
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
const diffRefs = z.object({ base_sha: oid, head_sha: oid, start_sha: oid });
const mrSchema = z.object({
  id: positive,
  iid: positive,
  target_project_id: positive,
  source_project_id: positive.nullish(),
  sha: oid.nullish(),
  diff_refs: diffRefs.nullish(),
});
const projectSchema = z.object({
  id: positive,
  path_with_namespace: z.string(),
  forked_from_project: z.object({ id: positive, path_with_namespace: z.string() }).nullish(),
});
const versionSchema = z.object({
  id: positive,
  merge_request_id: positive,
  base_commit_sha: oid,
  head_commit_sha: oid,
  start_commit_sha: oid,
});
const versionDiffSchema = versionSchema.extend({
  state: z.string(),
  real_size: z.string().optional(),
  diffs: z.array(
    z.object({
      old_path: z.string().min(1),
      new_path: z.string().min(1),
      diff: z.string().nullish(),
      collapsed: z.boolean().optional(),
      too_large: z.boolean().optional(),
      generated_file: z.boolean().optional(),
      renamed_file: z.boolean().optional(),
      a_mode: z.string().optional(),
      b_mode: z.string().optional(),
    }),
  ),
});
const discussionId = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/) });
const postSchema = discussionId.extend({ notes: z.array(z.object({ id: positive })).min(1) });
const positionSchema = diffRefs.extend({
  old_path: z.string(),
  new_path: z.string(),
  old_line: positive.nullish(),
  new_line: positive.nullish(),
  position_type: z.literal("text"),
});
const discussionSchema = discussionId.extend({
  notes: z.array(z.object({ id: positive, position: positionSchema.nullish() })),
});
const PAGE_SIZE = 20;
const VERSION_PAGE_LIMIT = 4;
const projectEndpoint = (path: string) => "projects/" + encodeURIComponent(path);

function normalizeVersion(row: z.infer<typeof versionSchema>): ReviewVersion {
  return {
    baseSha: row.base_commit_sha,
    startSha: row.start_commit_sha,
    headSha: row.head_commit_sha,
  };
}

export function createGitLabReviewGuide(options: {
  origin: (cwd: string) => Promise<{ host: string; path: string } | null>;
  run: (args: string[], cwd: string, host: string) => Promise<string>;
  authorizeHost: (host: string, cwd: string) => Promise<void>;
  now?: () => number;
}) {
  return createReviewGuideService(async (target, budget) => {
    const { identity, cwd } = target;
    if (identity.forge !== "gitlab" || !safeProjectPath(identity.projectPath)) {
      throw new ReviewGuideError("invalid_target");
    }
    const origin = await budget
      .run(() => options.origin(cwd))
      .catch((error: unknown) => {
        throw readError(error);
      });
    if (!origin || origin.host !== identity.host.toLowerCase() || !safeProjectPath(origin.path)) {
      throw new ReviewGuideError("invalid_target");
    }
    await budget
      .run(() => options.authorizeHost(origin.host, cwd))
      .catch((error: unknown) => {
        throw readError(error);
      });
    const command = (args: string[]) =>
      options.run(
        ["api", ...(origin.host.includes(":") ? [] : ["--hostname", origin.host]), "-i", ...args],
        cwd,
        origin.host,
      );
    const request = (args: string[]) => reviewHttp(command, args);
    const read = (scope: ReviewReadBudget, endpoint: string) =>
      scope
        .run(() => request([endpoint]))
        .catch((error: unknown) => {
          throw readError(error);
        });
    const project = decode(projectSchema, (await read(budget, projectEndpoint(origin.path))).json);
    const owner =
      project.path_with_namespace === identity.projectPath ? project : project.forked_from_project;
    if (!owner || owner.path_with_namespace !== identity.projectPath) {
      throw new ReviewGuideError("invalid_target");
    }
    const targetProjectId = owner.id;
    const endpoint = "projects/" + targetProjectId + "/merge_requests/" + identity.number;

    async function current(scope: ReviewReadBudget): Promise<ReviewSnapshot> {
      const mr = decode(mrSchema, (await read(scope, endpoint)).json);
      if (mr.iid !== identity.number || mr.target_project_id !== targetProjectId) {
        throw new ReviewGuideError("invalid_target");
      }
      if (!mr.diff_refs || (mr.sha && mr.sha !== mr.diff_refs.head_sha)) {
        throw new ReviewGuideError("unavailable");
      }
      return {
        requestId: String(mr.id),
        sourceProjectId: mr.source_project_id ?? undefined,
        version: {
          baseSha: mr.diff_refs.base_sha,
          headSha: mr.diff_refs.head_sha,
          startSha: mr.diff_refs.start_sha,
        },
      };
    }

    async function readFiles(
      rows: z.infer<typeof versionDiffSchema>["diffs"],
      version: ReviewVersion,
      sourceProjectId: number | undefined,
      renameScope: ReviewReadBudget,
    ) {
      const files: ReviewFiles["files"] = [];
      let renameChecks = 0;
      async function blobId(projectId: number, path: string, ref: string) {
        const fileEndpoint =
          "projects/" + projectId + "/repository/files/" + encodeURIComponent(path) + "?ref=" + ref;
        const result = await renameScope.run(() => request(["-X", "HEAD", fileEndpoint]));
        return oid.parse(result.headers.get("x-gitlab-blob-id"));
      }
      for (const row of rows) {
        let pureRename = false;
        if (
          row.renamed_file &&
          row.old_path !== row.new_path &&
          row.diff === "" &&
          !row.collapsed &&
          !row.too_large &&
          row.a_mode !== undefined &&
          row.a_mode === row.b_mode &&
          sourceProjectId &&
          renameChecks < 20
        ) {
          renameChecks++;
          try {
            const [oldBlob, newBlob] = await Promise.all([
              blobId(targetProjectId, row.old_path, version.baseSha),
              blobId(sourceProjectId, row.new_path, version.headSha),
            ]);
            pureRename = oldBlob === newBlob;
          } catch {
            // Missing blob metadata cannot prove a content-identical rename.
          }
        }
        files.push({
          path: row.new_path,
          oldPath: row.old_path,
          patch: row.collapsed || row.too_large ? undefined : row.diff,
          generated: row.generated_file,
          pureRename,
        });
      }
      return files;
    }

    return {
      identity: { ...identity, host: origin.host, projectPath: owner.path_with_namespace },
      current,
      async files(snapshot, readBudget): Promise<ReviewFiles> {
        const scope = readBudget.portion(12_000, 4_000);
        let version: z.infer<typeof versionSchema> | undefined;
        for (let page = 1; page <= VERSION_PAGE_LIMIT; page++) {
          const response = await read(
            scope,
            endpoint + "/versions?per_page=" + PAGE_SIZE + "&page=" + page,
          );
          const rows = decode(z.array(versionSchema).max(PAGE_SIZE), response.json);
          version = rows.find(
            (row) =>
              String(row.merge_request_id) === snapshot.requestId &&
              sameVersion(normalizeVersion(row), snapshot.version),
          );
          if (version || (!hasNextPage(response.headers) && rows.length < PAGE_SIZE)) break;
        }
        if (!version) {
          const latest = await current(readBudget.portion(5_000));
          assertReviewVersion(latest.version, snapshot.version);
          throw new ReviewGuideError("unavailable");
        }
        const diff = decode(
          versionDiffSchema,
          (await read(scope, endpoint + "/versions/" + version.id + "?unidiff=true")).json,
        );
        if (
          diff.id !== version.id ||
          String(diff.merge_request_id) !== snapshot.requestId ||
          !sameVersion(normalizeVersion(diff), snapshot.version)
        ) {
          throw new ReviewGuideError("stale");
        }
        const uniquePaths = new Set(diff.diffs.map((row) => row.new_path));
        if (uniquePaths.size !== diff.diffs.length) throw new ReviewGuideError("unavailable");
        // real_size can be a lower bound such as "1000+" on an overflowing version.
        const reported =
          diff.real_size && /^\d+$/.test(diff.real_size) ? Number(diff.real_size) : undefined;
        const totalFiles =
          reported !== undefined && Number.isSafeInteger(reported) && reported >= diff.diffs.length
            ? reported
            : undefined;
        const complete =
          diff.state === "collected" &&
          (diff.real_size === undefined || totalFiles === diff.diffs.length);
        const files = await readFiles(
          diff.diffs,
          snapshot.version,
          snapshot.sourceProjectId,
          scope.portion(2_000),
        );
        const after = await current(readBudget.portion(5_000));
        assertReviewVersion(after.version, snapshot.version);
        if (after.requestId !== snapshot.requestId) throw new ReviewGuideError("stale");
        return {
          files,
          totalFiles,
          hasMore: !complete,
          ...(!complete ? { reason: "forge_diff_limit" } : {}),
        };
      },
      async publish(snapshot, stop, body) {
        const { version } = snapshot;
        if (!version.startSha || !stop.line) throw new ReviewGuideError("invalid_target");
        const position = {
          position_type: "text" as const,
          base_sha: version.baseSha,
          start_sha: version.startSha,
          head_sha: version.headSha,
          old_path: stop.oldPath ?? stop.path,
          new_path: stop.path,
          old_line: stop.line.oldLine,
          new_line: stop.line.newLine,
        };
        // Use glab's JSON input for nested positions. Body and paths are data,
        // and never interpreted as form uploads or interpolated into a command.
        const directory = await mkdtemp(join(tmpdir(), "paseo-review-")).catch(() => {
          throw new ReviewGuideError("unavailable");
        });
        const input = join(directory, "comment.json");
        let posted: z.infer<typeof postSchema>;
        try {
          await writeFile(input, JSON.stringify({ body, position }), { mode: 0o600 }).catch(() => {
            throw new ReviewGuideError("unavailable");
          });
          try {
            posted = decode(
              postSchema,
              (await request(["-X", "POST", endpoint + "/discussions", "--input", input])).json,
            );
          } catch (error) {
            throw writeError(error);
          }
        } finally {
          await rm(directory, { recursive: true, force: true }).catch(() => {});
        }
        try {
          const scope = new ReviewReadBudget(8_000);
          const confirmed = decode(
            discussionSchema,
            (await read(scope, endpoint + "/discussions/" + posted.id)).json,
          );
          const note = confirmed.notes.find((candidate) => candidate.id === posted.notes[0].id);
          const actual = note?.position;
          if (
            confirmed.id !== posted.id ||
            !note ||
            !actual ||
            actual.base_sha !== position.base_sha ||
            actual.head_sha !== position.head_sha ||
            actual.start_sha !== position.start_sha ||
            actual.new_path !== position.new_path ||
            actual.old_path !== position.old_path ||
            (actual.new_line ?? undefined) !== position.new_line ||
            (actual.old_line ?? undefined) !== position.old_line
          )
            throw new ReviewGuideError("unknown_outcome");
          const after = await current(scope);
          assertReviewVersion(after.version, snapshot.version);
          if (after.requestId !== snapshot.requestId) throw new ReviewGuideError("unknown_outcome");
          return { id: String(note.id) };
        } catch {
          throw new ReviewGuideError("unknown_outcome");
        }
      },
    };
  }, options.now);
}
