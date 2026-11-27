/** @vitest-environment jsdom */
import type {
  TopicAnchorSummary,
  TopicDelegationSummary,
  TopicThreadEntry,
  WorkspaceTopicListEntriesResponse,
  WorkspaceTopicReplyResponse,
} from "@getpaseo/protocol/messages";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { expect, test, vi } from "vitest";
import {
  applyTopicAnchorToCache,
  applyTopicThreadEntryToCache,
  replyToWorkspaceTopic,
  useWorkspaceTopicEntries,
  workspaceTopicAnchorsQueryKey,
  workspaceTopicEntriesQueryKey,
} from "./queries";

const list = vi.hoisted(() => vi.fn());
const reply = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getSnapshot: () => ({
      connectionStatus: "online",
      client: { listWorkspaceTopicEntries: list, replyWorkspaceTopic: reply },
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
const later = "2026-11-26T12:00:00.001Z";
const queryKey = workspaceTopicAnchorsQueryKey(serverId, workspaceId, mainAgentId);
const entriesKey = workspaceTopicEntriesQueryKey(serverId, workspaceId, mainAgentId);
const scope = { workspaceId, mainAgentId };

function entry(entryId: string, seq: number, status: TopicThreadEntry["status"]): TopicThreadEntry {
  return {
    ...scope,
    entryId,
    seq,
    topicKey: "msg:root",
    rootMessageId: "root",
    routedAgentId: mainAgentId,
    role: "user_followup",
    status,
    text: entryId,
    createdAt: updatedAt,
    updatedAt,
  };
}

function pushEntry(queryClient: QueryClient, update: TopicThreadEntry) {
  applyTopicThreadEntryToCache(queryClient, serverId, { ...scope, entry: update });
}

function listResult(entries: TopicThreadEntry[]): WorkspaceTopicListEntriesResponse["payload"] {
  return { requestId: "list", workspaceId, entries, error: null };
}

function renderEntries(queryClient: QueryClient) {
  return renderHook(() => useWorkspaceTopicEntries(serverId, workspaceId, mainAgentId, true), {
    wrapper: ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client: queryClient }, children),
  });
}

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

test("a stale list and a late reply receipt keep the completed entry and its image", async () => {
  const queryClient = new QueryClient();
  const first = entry("first", 1, "queued");
  const second = entry("second", 2, "queued");
  const running = { ...second, status: "running" as const };
  const image = { id: "uploaded-1", fileName: "diagram.png", mimeType: "image/png", size: 5 };
  const completed = { ...first, updatedAt: later, status: "completed" as const };
  const snapshot = Promise.withResolvers<WorkspaceTopicListEntriesResponse["payload"]>();
  const receipt = Promise.withResolvers<WorkspaceTopicReplyResponse["payload"]>();
  list.mockReset().mockReturnValueOnce(snapshot.promise);
  reply.mockReset().mockReturnValueOnce(receipt.promise);
  queryClient.setQueryData(entriesKey, [first, second]);
  const view = renderEntries(queryClient);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  const send = replyToWorkspaceTopic({
    ...scope,
    queryClient,
    serverId,
    topicKey: first.topicKey,
    clientMessageId: first.entryId,
    text: first.text,
  });

  act(() => {
    pushEntry(queryClient, { ...first, imageAttachments: [image] });
    pushEntry(queryClient, completed);
  });
  snapshot.resolve(listResult([first, running]));
  const expected = [{ ...completed, imageAttachments: [image] }, running];
  await waitFor(() => expect(view.result.current.entries).toEqual(expected));

  await act(async () => {
    receipt.resolve({
      requestId: "reply",
      workspaceId,
      topicKey: first.topicKey,
      routedTo: "main",
      targetAgentId: mainAgentId,
      entry: { ...first, updatedAt: later },
      error: null,
    });
    await send;
  });
  expect(queryClient.getQueryData(entriesKey)).toEqual(expected);
  view.unmount();
});

test("a list keeps an entry pushed after its response and still removes old entries absent from history", async () => {
  const queryClient = new QueryClient();
  const removed = entry("removed", 1, "completed");
  const recent = entry("recent", 2, "queued");
  const newlyPushed = entry("new", 3, "queued");
  const snapshot = Promise.withResolvers<WorkspaceTopicListEntriesResponse["payload"]>();
  list.mockReset().mockReturnValueOnce(snapshot.promise);
  queryClient.setQueryData(entriesKey, [removed]);
  const view = renderEntries(queryClient);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

  const response = listResult([recent]);
  // Reading the response's entries queues the push as the query returns, just
  // before TanStack commits the resolved promise to its cache.
  Object.defineProperty(response, "entries", {
    get() {
      queueMicrotask(() => pushEntry(queryClient, newlyPushed));
      return [recent];
    },
  });
  snapshot.resolve(response);
  await waitFor(() => expect(view.result.current.entries).toEqual([recent, newlyPushed]));

  list.mockResolvedValueOnce(listResult([recent]));
  await act(async () => {
    await view.result.current.refetch();
  });
  expect(queryClient.getQueryData(entriesKey)).toEqual([recent]);
  await waitFor(() => expect(view.result.current.entries).toEqual([recent]));
  view.unmount();
});

test("a newer recovery can return a pending entry to queued and a retry keeps its separate identity", async () => {
  const queryClient = new QueryClient();
  const running = entry("first", 1, "running");
  const recovered = { ...running, status: "queued" as const, updatedAt: later };
  const failed = { ...recovered, status: "error" as const, retryable: true };
  const retry = entry("retry", 2, "queued");
  const consumed = { ...failed, retryable: false };

  pushEntry(queryClient, running);
  pushEntry(queryClient, recovered);
  expect(queryClient.getQueryData(entriesKey)).toEqual([recovered]);
  pushEntry(queryClient, failed);
  pushEntry(queryClient, recovered);
  pushEntry(queryClient, consumed);
  pushEntry(queryClient, retry);
  expect(queryClient.getQueryData(entriesKey)).toEqual([consumed, retry]);

  const retryableAgain = { ...consumed, retryable: true };
  list.mockReset().mockResolvedValueOnce(listResult([retryableAgain, retry]));
  const view = renderEntries(queryClient);
  await waitFor(() => expect(view.result.current.entries).toEqual([retryableAgain, retry]));
  view.unmount();
});
