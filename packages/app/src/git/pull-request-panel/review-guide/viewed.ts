import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { localReviewViewed, type LocalReviewHead, type LocalReviewRequest } from "./local-viewed";
import {
  reviewFailure,
  reviewIdentityKey,
  reviewVersionKey,
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
  localRequest: LocalReviewRequest | undefined,
  invalidateGuide: (failure: ReviewFailure) => void,
) {
  const client = useQueryClient();
  const queryKey = ["pr-review-viewed", scope, queryToken];
  const input = { ...target, version: guide.version };
  const local = guide.viewedMode === "local";
  const localHead = useRef<LocalReviewHead>(undefined);
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey,
    queryFn: async ({ signal }) => {
      if (local) {
        if (localHead.current) {
          return localReviewViewed.load(localHead.current, signal);
        }
        if (!localRequest) throw { code: "unavailable" };
        const confirmed = await localReviewViewed.confirmHead(
          localRequest,
          input.version.headSha,
          signal,
          async () => {
            const current = await port.getReviewGuide({
              ...target,
              expectedVersion: input.version,
            });
            if (reviewIdentityKey(current.identity) !== reviewIdentityKey(target.identity)) {
              throw { code: "invalid_target" };
            }
            if (reviewVersionKey(current.version) !== reviewVersionKey(input.version)) {
              throw { code: "stale" };
            }
          },
        );
        localHead.current = confirmed.head;
        return confirmed.viewed;
      }
      const result = await port.getReviewViewed(input);
      signal.throwIfAborted();
      return result;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: local || guide.stops.length > 0,
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
      if (local && !localHead.current) throw { code: "stale" };
      const entry =
        local && localHead.current
          ? await localReviewViewed.set(localHead.current, path, viewed)
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
