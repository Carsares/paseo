import { useMemo, useRef, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useFetchQuery } from "@/data/query";
import { useStableEvent } from "@/hooks/use-stable-event";
import { commitKey } from "./lanes";
import type { compileFilters } from "./model";

type LogPage = Awaited<ReturnType<DaemonClient["checkoutGitLogQuery"]>>;
const EMPTY_PAGES: LogPage[] = [];

export function useGraphLog(input: {
  client: DaemonClient;
  serverId: string;
  cwd: string;
  roots: string[];
  filters: NonNullable<ReturnType<typeof compileFilters>> | null;
  revision: number;
  enabled: boolean;
}) {
  const { client, serverId, cwd, roots, filters, revision, enabled } = input;
  const loadPage = async (cursor?: string) => {
    const result = await client.checkoutGitLogQuery({
      cwd,
      repoRoots: roots,
      ...filters,
      cursor,
      pageSize: 120,
    });
    if (result.error !== null) throw new Error(result.error);
    return result;
  };
  const first = useFetchQuery({
    queryKey: ["git-graph-log", serverId, cwd, roots, filters, revision],
    enabled: enabled && roots.length > 0 && filters !== null,
    queryFn: () => loadPage(),
    dataShape: "value",
    staleTimeMs: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const firstId = first.data?.requestId;
  const [extra, setExtra] = useState<{ firstId: string; pages: LogPage[]; cursors: string[] }>();
  const [failure, setFailure] = useState<{ firstId: string; error: Error }>();
  const pending = useRef<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const current = extra?.firstId === firstId ? extra : undefined;
  const pages = useMemo(() => {
    if (!first.data) return EMPTY_PAGES;
    return [first.data, ...(current?.pages ?? EMPTY_PAGES)];
  }, [current, first.data]);
  const last = pages.at(-1);
  const cursor = last?.hasMore ? last.nextCursor : null;
  const hasNextPage = !!cursor && !current?.cursors.includes(cursor);
  const commits = useMemo(() => {
    const seen = new Set<string>();
    return pages
      .flatMap((page) => page.commits)
      .filter((commit) => {
        const key = commitKey(commit);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [pages]);
  const fetchNextPage = useStableEvent(async () => {
    if (
      !enabled ||
      !firstId ||
      !cursor ||
      !hasNextPage ||
      first.isFetching ||
      pending.current !== null
    )
      return;
    pending.current = firstId;
    setLoadingId(firstId);
    setFailure(undefined);
    try {
      const page = await loadPage(cursor);
      setExtra({
        firstId,
        pages: [...(current?.pages ?? EMPTY_PAGES), page],
        cursors: [...(current?.cursors ?? []), cursor],
      });
    } catch (error) {
      setFailure({ firstId, error: error instanceof Error ? error : new Error(String(error)) });
    } finally {
      pending.current = null;
      setLoadingId(null);
    }
  });
  return {
    commits,
    last,
    hasNextPage,
    fetchNextPage,
    isFetching: first.isFetching || (firstId !== undefined && loadingId === firstId),
    error: first.error ?? (failure?.firstId === firstId ? failure?.error : null),
  };
}
