import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { DiffState } from "@getpaseo/client";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { DiffCell, DiffLineBlame } from "../diff-document/types";
import { useGitP2Copy } from "../p2-copy";
import type { StagingLayer } from "../staging/model";
import { worktreeLineForIndexLine } from "./line-map";

export function useFileBlame({
  serverId,
  cwd,
  path,
  active,
  diff,
  indexToWorktree,
  file,
  layer,
}: {
  serverId: string;
  cwd: string;
  path: string;
  active: boolean;
  diff: DiffState | undefined;
  indexToWorktree: DiffState | undefined;
  file: ParsedDiffFile | undefined;
  layer: StagingLayer;
}) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const { t } = useTranslation();
  const copy = useGitP2Copy();
  const worktreeDiff = layer === "staged" ? indexToWorktree : diff;
  const mapping =
    worktreeDiff?.phase === "ready"
      ? worktreeDiff.files.find((item) => item.path === path || item.oldPath === path)
      : undefined;
  const lineRange = useMemo(
    () => blameRange(active, file, worktreeDiff, layer, mapping),
    [active, file, layer, mapping, worktreeDiff],
  );
  const snapshot = worktreeDiff?.phase === "ready" ? worktreeDiff.resolved : undefined;
  const query = useFetchQuery({
    queryKey: [
      "git-file-blame",
      serverId,
      cwd,
      path,
      snapshot?.baseSha,
      snapshot?.headSha,
      worktreeDiff?.revision,
      lineRange,
    ],
    enabled: Boolean(connected && client && lineRange && active),
    dataShape: "value",
    staleTimeMs: 0,
    retry: false,
    queryFn: async () => {
      if (!client || !lineRange) throw new Error(t("common.loading"));
      const result = await client.checkoutGitBlameGet({
        cwd,
        targetRepoRoot: cwd,
        path,
        ...lineRange,
      });
      if (result.error) throw new Error(result.error);
      return result;
    },
  });
  const lines = useMemo(
    () => new Map(query.data?.lines.map((line) => [line.lineNumber, line])),
    [query.data],
  );
  const blame: DiffLineBlame | undefined = active
    ? { path, mark: (cell) => blameMark(cell, layer, mapping, lines, copy) }
    : undefined;
  const status = blameStatus({
    queryError: query.error?.message,
    diff: worktreeDiff,
    hasRange: Boolean(lineRange),
    truncated: query.data?.truncated,
    loading: active && query.isFetching,
    copy,
    loadingLabel: t("common.loading"),
  });
  return { blame, status };
}

function blameRange(
  active: boolean,
  file: ParsedDiffFile | undefined,
  diff: DiffState | undefined,
  layer: StagingLayer,
  mapping: ParsedDiffFile | undefined,
) {
  if (!active || !file || diff?.phase !== "ready" || diff.diffTooLarge) return;
  let startLine = Infinity;
  let endLine = 0;
  for (const hunk of file.hunks) {
    for (let line = hunk.newStart; line < hunk.newStart + hunk.newCount; line++) {
      const worktreeLine = layer === "staged" ? worktreeLineForIndexLine(mapping, line) : line;
      if (worktreeLine === null) continue;
      startLine = Math.min(startLine, worktreeLine);
      endLine = Math.max(endLine, worktreeLine);
    }
  }
  return endLine ? { startLine, endLine } : undefined;
}

type Client = NonNullable<ReturnType<typeof useHostRuntimeClient>>;
type Blame = Awaited<ReturnType<Client["checkoutGitBlameGet"]>>["lines"][number];
type Copy = ReturnType<typeof useGitP2Copy>;

function blameMark(
  cell: DiffCell,
  layer: StagingLayer,
  mapping: ParsedDiffFile | undefined,
  lines: ReadonlyMap<number, Blame>,
  copy: Copy,
) {
  if (!cell.lineNumber) return;
  const unavailable = { label: "—", detail: copy.blameUnavailable };
  if (cell.sourceIdentity.side === "old") return unavailable;
  const lineNumber =
    layer === "staged" ? worktreeLineForIndexLine(mapping, cell.lineNumber) : cell.lineNumber;
  const line = lineNumber === null ? undefined : lines.get(lineNumber);
  if (!line || !("lineText" in line) || line.lineText !== cell.content) return unavailable;
  if (!line.sha)
    return { label: copy.uncommitted, detail: `${cell.lineNumber} · ${copy.uncommitted}` };
  const shortSha = line.sha.slice(0, 8);
  return {
    label: `${shortSha} · ${line.authorName}`,
    detail: [cell.lineNumber, line.sha, line.authorName, line.authorDate, line.summary]
      .filter(Boolean)
      .join(" · "),
  };
}

function blameStatus({
  queryError,
  diff,
  hasRange,
  truncated,
  loading,
  copy,
  loadingLabel,
}: {
  queryError?: string;
  diff?: DiffState;
  hasRange: boolean;
  truncated?: boolean;
  loading: boolean;
  copy: Copy;
  loadingLabel: string;
}) {
  if (queryError) return queryError;
  if (diff?.phase === "error") return diff.error.message;
  if (truncated) return copy.blameTruncated;
  if (!diff || diff.phase === "loading" || loading) return loadingLabel;
  if (!hasRange) return copy.blameUnavailable;
  return null;
}
