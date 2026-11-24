import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { normalizeHost } from "@getpaseo/protocol/git-remote";
import type { PrPaneData } from "@/git/pull-request-panel/data";
import { prPaneTimelineQueryKey } from "@/git/pull-request-panel/query-keys";
import {
  reviewFailure,
  type ReviewFailure,
  type ReviewGuideConnection,
  type ReviewIdentity,
} from "@/git/pull-request-panel/review-guide/port";
import type { UsePrPaneDataResult } from "@/git/pull-request-panel/use-data";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

function getIdentity(data: PrPaneData | null): ReviewIdentity | undefined {
  if (!data) return;
  const projectPath =
    data.projectPath ??
    (data.repoOwner && data.repoName ? `${data.repoOwner}/${data.repoName}` : "");
  if (!projectPath || !Number.isSafeInteger(data.number) || data.number < 1) return;
  try {
    const url = new URL(data.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    const host = normalizeHost(url.host);
    if (!host) return;
    return {
      forge: data.forge,
      host,
      projectPath: data.forge === "github" ? projectPath.toLowerCase() : projectPath,
      number: data.number,
    };
  } catch {
    return;
  }
}

function requestFailure(error: unknown, write = false): ReviewFailure {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "access_denied"
  ) {
    return { code: "permission" };
  }
  return reviewFailure(error, write ? "unknown_outcome" : "unavailable");
}

export function useReviewGuideConnection({
  serverId,
  cwd,
  prPane,
}: {
  serverId: string;
  cwd: string;
  prPane: UsePrPaneDataResult;
}): ReviewGuideConnection | undefined {
  const enabled = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.forgeReviewGuide === true,
  );
  const client = useHostRuntimeClient(serverId);
  const queries = useQueryClient();
  const data = prPane.data;

  return useMemo(() => {
    if (!enabled || !client) return;
    const identity = getIdentity(data);
    if (!identity) return;
    return {
      identity,
      observedHeadSha: data?.headSha,
      expectedVersion: data?.reviewVersion,
      port: {
        async getReviewGuide(input) {
          try {
            const response = await client.checkoutForgeGetReviewGuide(input);
            if (response.error) throw response.error;
            if (!response.guide) throw { code: "unavailable" };
            return response.guide;
          } catch (error) {
            throw requestFailure(error);
          }
        },
        async getReviewViewed(input) {
          try {
            const response = await client.checkoutForgeGetReviewViewed(input);
            if (response.error) throw response.error;
            if (!response.viewed) throw { code: "unavailable" };
            return response.viewed;
          } catch (error) {
            throw requestFailure(error);
          }
        },
        async setReviewViewed(input) {
          try {
            const response = await client.checkoutForgeSetReviewViewed(input);
            if (response.error) throw response.error;
            if (!response.entry) throw { code: "unknown_outcome" };
            return response.entry;
          } catch (error) {
            throw requestFailure(error, true);
          }
        },
        async publishReviewComment(input) {
          try {
            const response = await client.checkoutForgePublishReviewComment(input);
            if (response.error) throw response.error;
            if (!response.comment) throw { code: "unknown_outcome" };
          } catch (error) {
            throw requestFailure(error, true);
          }
        },
      },
      onCommentPublished: () => {
        void queries.invalidateQueries({
          queryKey: prPaneTimelineQueryKey({ serverId, cwd, prNumber: identity.number }),
          exact: true,
        });
      },
    };
  }, [client, cwd, data, enabled, queries, serverId]);
}
