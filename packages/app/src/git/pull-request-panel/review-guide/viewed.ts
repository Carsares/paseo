import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { localReviewViewed } from "./local-viewed";
import {
  reviewFailure,
  type ReviewFailure,
  type ReviewGuide,
  type ReviewGuidePort,
  type ReviewTarget,
  type ReviewViewed,
} from "./port";

export function useReviewViewed(
  port: ReviewGuidePort,
  guide: ReviewGuide,
  target: ReviewTarget,
  scope: string,
  queryToken: string,
  invalidateGuide: (failure: ReviewFailure) => void,
) {
  const client = useQueryClient();
  const queryKey = ["pr-review-viewed", scope, queryToken];
  const input = { ...target, version: guide.version };
  const local = guide.viewedMode === "local";
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey,
    queryFn: async ({ signal }) => {
      if (local) return localReviewViewed.load(input.identity, input.version.headSha, signal);
      const result = await port.getReviewViewed(input);
      signal.throwIfAborted();
      return result;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: guide.stops.length > 0,
  });
  const writeInFlight = useRef(false);
  const [pendingPath, setPendingPath] = useState<string>();
  const [writeFailure, setWriteFailure] = useState<ReviewFailure>();
  const failure = writeFailure ?? (query.isError ? reviewFailure(query.error) : undefined);

  async function reload() {
    if (writeInFlight.current) return;
    const result = await query.refetch();
    if (result.isSuccess) setWriteFailure(undefined);
  }

  async function setViewed(path: string, viewed: boolean) {
    if (
      writeInFlight.current ||
      query.isFetching ||
      !query.data ||
      failure?.code === "unknown_outcome"
    )
      return;
    writeInFlight.current = true;
    setPendingPath(path);
    setWriteFailure(undefined);
    try {
      const entry = local
        ? await localReviewViewed.set(input.identity, input.version.headSha, path, viewed)
        : await port.setReviewViewed({
            ...input,
            path,
            viewed,
            ...(query.data.viewerId ? { expectedViewerId: query.data.viewerId } : {}),
          });
      if (entry.path !== path) throw { code: "unknown_outcome" };
      client.setQueryData<ReviewViewed>(
        queryKey,
        (previous) =>
          previous && {
            ...previous,
            entries: [...previous.entries.filter((item) => item.path !== path), entry],
          },
      );
    } catch (error) {
      const problem = reviewFailure(error, local ? "unavailable" : "unknown_outcome");
      setWriteFailure(problem);
      invalidateGuide(problem);
    } finally {
      setPendingPath(undefined);
      writeInFlight.current = false;
    }
  }

  return {
    entries: new Map(query.data?.entries.map((entry) => [entry.path, entry.state])),
    loaded: query.data !== undefined,
    loading: query.isFetching,
    hasMore: query.data?.hasMore === true,
    canWrite:
      query.data !== undefined &&
      !query.isFetching &&
      !pendingPath &&
      failure?.code !== "unknown_outcome",
    failure,
    pendingPath,
    reload,
    setViewed,
  };
}
