/** @vitest-environment jsdom */
import type { TopicAnchorSummary, TopicDelegationSummary } from "@getpaseo/protocol/messages";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { expect, test, vi } from "vitest";
import {
  applyTopicAnchorToCache,
  useWorkspaceTopicEntries,
  workspaceTopicAnchorsQueryKey,
} from "./queries";

const list = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getSnapshot: () => ({
      connectionStatus: "online",
      client: { listWorkspaceTopicEntries: list },
    }),
  }),
  useHostRuntimeConnectionStatuses: (ids: string[]) => new Map(ids.map((id) => [id, "online"])),
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => true }));
vi.mock("@/hooks/use-app-visible", () => ({ useAppVisible: () => true }));

const serverId = "host";
const workspaceId = "workspace";
const mainAgentId = "main";
const updatedAt = "2026-11-26T12:00:00.000Z";
const queryKey = workspaceTopicAnchorsQueryKey(serverId, workspaceId, mainAgentId);

function delegation(messageId: string, status: TopicDelegationSummary["status"]) {
  return { messageId, status, serverId, agentId: "child", updatedAt };
}

function anchor(delegations: TopicDelegationSummary[]): TopicAnchorSummary {
  return {
    workspaceId,
    mainAgentId,
    topicKey: "msg:root",
    rootMessageId: "root",
    rootPromptText: "Review the draft",
    createdAt: updatedAt,
    updatedAt,
    delegations,
  };
}

function startFetch(initial: TopicAnchorSummary) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(queryKey, [initial]);
  const snapshot = Promise.withResolvers<{ entries: []; anchors: TopicAnchorSummary[] }>();
  list.mockReset();
  list.mockReturnValueOnce(snapshot.promise);
  const view = renderHook(
    () => useWorkspaceTopicEntries(serverId, workspaceId, mainAgentId, true),
    {
      wrapper: ({ children }: PropsWithChildren) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    },
  );
  return {
    push: (update: TopicAnchorSummary) =>
      applyTopicAnchorToCache(queryClient, serverId, { workspaceId, mainAgentId, anchor: update }),
    resolve: (fetched: TopicAnchorSummary) => snapshot.resolve({ entries: [], anchors: [fetched] }),
    view,
  };
}

test("a reconnect snapshot replaces cached running status with interruption at the same timestamp", async () => {
  const { resolve, view } = startFetch(anchor([delegation("first", "running")]));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  resolve(anchor([delegation("first", "interrupted")]));
  await waitFor(() =>
    expect(view.result.current.anchors[0]?.delegations).toEqual([
      delegation("first", "interrupted"),
    ]),
  );
  view.unmount();
});

test("a reconnect keeps only dispatch changes received during the fetch and preserves ordinary anchor metadata", async () => {
  const running = anchor([delegation("first", "running"), delegation("second", "running")]);
  const { resolve, push, view } = startFetch(running);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  const completed = { ...delegation("second", "completed"), reportIds: ["report"] };
  push(anchor([delegation("first", "running"), completed]));
  push({
    ...running,
    updatedAt: "2026-11-26T12:00:00.001Z",
    title: "Updated title",
    delegations: undefined,
  });
  await waitFor(() =>
    expect(view.result.current.anchors[0]?.delegations).toEqual([
      delegation("first", "running"),
      completed,
    ]),
  );
  resolve(anchor([delegation("first", "interrupted"), delegation("second", "interrupted")]));
  await waitFor(() =>
    expect(view.result.current.anchors[0]).toMatchObject({
      title: "Updated title",
      delegations: [delegation("first", "interrupted"), completed],
    }),
  );
  view.unmount();
});
