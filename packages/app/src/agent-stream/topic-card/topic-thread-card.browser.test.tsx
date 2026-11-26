import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings/storage";
import { PortalProvider } from "@gorhom/portal";
import { within } from "@testing-library/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { MessageImageReader } from "@/components/read-only-message-images";
import { DisclosureRow } from "@/agent-stream/disclosure";
import type { StreamViewportHandle } from "@/agent-stream/strategy";
import { type HostRuntimeSnapshot, getHostRuntimeStore } from "@/runtime/host-runtime";
import { i18n } from "@/i18n/i18next";
import { useTopicStreamViewStore } from "@/stores/topic-stream-view-store";
import type { TopicUnit } from "./model";
import { TopicThreadCard } from "./topic-thread-card";

let container: HTMLDivElement;
let root: Root;
let view: ReturnType<typeof within>;
let queryClient: QueryClient;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  useTopicStreamViewStore.setState({
    expandedProcessByTopicKey: {},
    expandedHistoryByTopicKey: {},
    expandedConflictsByTopicKey: {},
    decisionDraftByTopicKey: {},
    inlineReplyDrafts: {},
  });
  container = document.body.appendChild(document.createElement("div"));
  container.style.width = "900px";
  root = createRoot(container);
  view = within(container);
  queryClient = new QueryClient();
  queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS);
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  container.remove();
});

function makeTopic(): TopicUnit {
  return {
    topicKey: "task:T-100",
    taskId: "T-100",
    rootItemId: "u-100",
    rootMessageId: "m-100",
    rootPrompt: {
      id: "u-100",
      messageId: "m-100",
      text: "Audit the WebSocket reconnect path",
      timestampMs: 1_700_000_000_000,
      seq: 1,
      epoch: "ep-1",
      item: null,
    },
    task: null,
    leadAgentId: "lead-ws",
    leadTitle: "Network Lead",
    processSteps: [
      {
        kind: "thought",
        id: "th-1",
        text: "Dispatching network specialist to inspect reconnect backoff",
        status: "ready",
        timestampMs: 1_700_000_001_000,
        item: {
          kind: "thought",
          id: "th-1",
          text: "Dispatching network specialist to inspect reconnect backoff",
          status: "ready",
          timestamp: new Date(1_700_000_001_000),
        },
      },
    ],
    replies: [
      {
        kind: "subagent_report",
        id: "rep-1",
        senderId: "lead-ws",
        senderTitle: "Network Lead",
        status: "completed",
        text: "Found missing jitter in reconnect backoff.",
        taskId: "T-100",
        epoch: "ep-1",
        seq: 2,
        timestampMs: 1_700_000_002_000,
        isUnread: true,
      },
      {
        kind: "main_conclusion",
        id: "mc-1",
        messageId: "mc-1",
        text: "Accepted jitter fix; ready for canary.",
        epoch: "ep-1",
        seq: 3,
        timestampMs: 1_700_000_003_000,
        isUnread: true,
        item: {
          kind: "assistant_message",
          id: "mc-1",
          messageId: "mc-1",
          text: "Accepted jitter fix; ready for canary.",
          timestamp: new Date(1_700_000_003_000),
        },
      },
    ],
    pendingInboxItems: [
      {
        agentId: "lead-ws",
        title: "Network Lead",
        event: "finished",
        reportStatus: "completed",
        taskId: "T-100",
      },
    ],
    linkedTodos: [],
    linkedDurableItems: [],
    linkedPermissions: [],
    fileConflicts: [],
    activeBlockingPrompt: null,
    unreadReplyCount: 2,
    firstUnreadReplyIndex: 0,
    isMarkedUnread: false,
    hasUnread: true,
    latestSeq: 3,
    latestTimestampMs: 1_700_000_003_000,
    latestEpoch: "ep-1",
    lifecycleStatus: "aggregating",
    retryCandidate: null,
  };
}

function createViewportRef(holdRow: StreamViewportHandle["holdRow"]) {
  return { current: { holdRow } as unknown as StreamViewportHandle };
}

function makeImageReader(read: MessageImageReader["read"]): MessageImageReader {
  return { serverId: "srv-1", workspaceId: "workspace", read };
}

it("renders user prompt first, collapses process steps behind useDisclosureHold, and triggers split-open & flush", async () => {
  const holdRow = vi.fn((_rowId: string, apply: () => void) => apply());
  const viewportRef = createViewportRef(holdRow);
  const onAutoMarkRead = vi.fn();
  const onMarkTopicMode = vi.fn();
  const onOpenAgentBeside = vi.fn();
  const onFlushTopicInbox = vi.fn();
  const onSubmitDesktopReply = vi.fn(() => true);
  const onActivateCompactReply = vi.fn();
  const onConvertToTodo = vi.fn();
  const onToggleTodoStatus = vi.fn();
  const onEditTodo = vi.fn();
  const topic = makeTopic();
  const image = { id: "image", fileName: "example.png", mimeType: "image/png", size: 68 };
  const read = vi.fn(
    async () =>
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqfQAAAAASUVORK5CYII=",
  );
  const imageReader = makeImageReader(read);
  topic.rootPrompt.imageAttachments = [image];
  topic.replies.push({
    kind: "thread_entry",
    id: "thread:followup",
    seq: null,
    threadSeq: 1,
    timestampMs: 1_700_000_004_000,
    isUnread: false,
    entry: {
      entryId: "followup",
      workspaceId: "workspace",
      mainAgentId: "main",
      routedAgentId: "main",
      topicKey: topic.topicKey,
      role: "user_followup",
      text: "Please check this image.",
      status: "completed",
      imageAttachments: [image],
      seq: 1,
      createdAt: new Date(1_700_000_004_000).toISOString(),
      updatedAt: new Date(1_700_000_004_000).toISOString(),
    },
  });
  const conclusion = topic.replies.find((reply) => reply.kind === "main_conclusion");
  if (!conclusion) throw new Error("Missing conclusion fixture.");
  topic.replies.push({
    ...conclusion,
    id: "progress",
    kind: "main_progress",
    dispatched: true,
    isUnread: true,
  });
  queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, {
    ...DEFAULT_CLIENT_SETTINGS,
    userMessageAlignment: "left",
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PortalProvider>
          <DisclosureRow rowId="topic-row" viewportRef={viewportRef}>
            <TopicThreadCard
              agentKey="srv-1:mc-1"
              topic={topic}
              imageReader={imageReader}
              isPaneFocused={false}
              isVisibleInViewport={true}
              onAutoMarkRead={onAutoMarkRead}
              onMarkTopicMode={onMarkTopicMode}
              onFlushTopicInbox={onFlushTopicInbox}
              onOpenAgentBeside={onOpenAgentBeside}
              onSubmitDesktopReply={onSubmitDesktopReply}
              onActivateCompactReply={onActivateCompactReply}
              onConvertToTodo={onConvertToTodo}
              onToggleTodoStatus={onToggleTodoStatus}
              onEditTodo={onEditTodo}
            />
          </DisclosureRow>
        </PortalProvider>
      </QueryClientProvider>,
    );
  });

  // Row 1 shows the real user question
  expect(view.getByTestId("topic-card-root-prompt").textContent).toBe(
    "Audit the WebSocket reconnect path",
  );
  const bubbles: HTMLElement[] = view.getAllByTestId("topic-user-message");
  expect(bubbles).toHaveLength(2);
  expect(bubbles.map((bubble) => getComputedStyle(bubble).alignSelf)).toEqual([
    "flex-start",
    "flex-start",
  ]);
  expect(bubbles.every((bubble) => within(bubble).getByText("You"))).toBe(true);
  const progress = within(view.getByTestId("topic-reply-progress-progress"));
  expect(progress.getByText("Dispatched")).toBeTruthy();
  expect(progress.getByTestId("topic-progress-unread")).toBeTruthy();
  await vi.waitFor(() => {
    expect(bubbles.map((bubble) => bubble.querySelectorAll("img").length)).toEqual([1, 1]);
  });
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(image);

  // New replies divider is rendered
  expect(view.getByTestId("topic-new-replies-divider")).toBeTruthy();
  // Subagent report renders inside topic card rail (never as a right-side user message bubble)
  expect(view.getByTestId("topic-reply-subagent-rep-1").textContent).toContain(
    "Found missing jitter in reconnect backoff.",
  );

  // Process steps start collapsed, and expanding runs through useDisclosureHold
  expect(view.queryByTestId("topic-process-steps-task:T-100")).toBeNull();
  act(() => {
    view.getByTestId("topic-process-toggle-task:T-100").click();
  });
  expect(holdRow).toHaveBeenCalledTimes(1);
  expect(view.getByTestId("topic-process-steps-task:T-100").textContent).toContain(
    "Dispatching network specialist",
  );

  // One-click split-open button calls onOpenAgentBeside with leadAgentId
  act(() => {
    view.getByTestId("topic-card-open-beside-task:T-100").click();
  });
  expect(onOpenAgentBeside).toHaveBeenCalledWith(
    expect.objectContaining({ targetAgentId: "lead-ws" }),
  );

  // In-card pending inbox flush button triggers scoped flush
  act(() => {
    view.getByTestId("topic-flush-inbox-task:T-100").click();
  });
  expect(onFlushTopicInbox).toHaveBeenCalledWith(topic);
});

function makeConflictDecisionTopic(): TopicUnit {
  return {
    ...makeTopic(),
    lifecycleStatus: "blocked",
    fileConflicts: [
      {
        path: "packages/app/src/panels/agent-panel.tsx",
        peers: [
          {
            taskId: "T-200",
            title: "Parallel panel cleanup",
            leadTitle: "Frontend Lead",
            status: "in_progress",
          },
        ],
      },
    ],
    activeBlockingPrompt: {
      kind: "task_blocking_question",
      taskId: "T-100",
      question: "Pick rollout order:\n1. Canary first\n2. Direct prod",
      options: ["Canary first", "Direct prod"],
    },
  };
}

it("renders conflict banner and blocking decision slot in browser layout", () => {
  const onJumpToPeerTopic = vi.fn();
  const topic = makeConflictDecisionTopic();

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PortalProvider>
          <TopicThreadCard
            agentKey="srv-1:mc-1"
            topic={topic}
            isPaneFocused={false}
            supportsButlerV1={true}
            onJumpToPeerTopic={onJumpToPeerTopic}
            onAutoMarkRead={vi.fn()}
            onMarkTopicMode={vi.fn()}
            onFlushTopicInbox={vi.fn()}
            onOpenAgentBeside={vi.fn()}
            onSubmitDesktopReply={vi.fn(() => true)}
            onActivateCompactReply={vi.fn()}
            onConvertToTodo={vi.fn()}
            onToggleTodoStatus={vi.fn()}
            onEditTodo={vi.fn()}
          />
        </PortalProvider>
      </QueryClientProvider>,
    );
  });

  expect(view.getByTestId("topic-conflict-banner-task:T-100")).toBeTruthy();
  expect(view.getByTestId("topic-decision-slot-task:T-100")).toBeTruthy();
  act(() => {
    view.getByTestId("topic-conflict-jump-T-200").click();
  });
  expect(onJumpToPeerTopic).toHaveBeenCalledWith("T-200");
});

it("locks the wide reply recipient during send and retains attachments only on failure", async () => {
  await page.viewport(1000, 760);
  const uploadFile = vi.fn(
    async ({
      fileName,
      mimeType,
      bytes,
    }: {
      fileName: string;
      mimeType: string;
      bytes: Uint8Array;
    }) => ({
      error: null,
      file: {
        type: "uploaded_file",
        id: fileName,
        mimeType,
        fileName,
        size: bytes.length,
        path: `/tmp/${fileName}`,
      },
    }),
  );
  const runtime = getHostRuntimeStore();
  const getSnapshot = runtime.getSnapshot.bind(runtime);
  const snapshot = {
    connectionStatus: "online",
    client: { uploadFile },
  } as unknown as HostRuntimeSnapshot;
  vi.spyOn(runtime, "getSnapshot").mockImplementation((id) =>
    id === "inline-host" ? snapshot : getSnapshot(id),
  );
  const accepted = Promise.withResolvers<boolean>();
  const onSubmitDesktopReply = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockReturnValueOnce(accepted.promise);
  const topic = makeTopic();
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <PortalProvider>
          <TopicThreadCard
            agentKey="inline:main"
            serverId="inline-host"
            workspaceId="inline-workspace"
            topic={topic}
            isPaneFocused={false}
            onAutoMarkRead={vi.fn()}
            onMarkTopicMode={vi.fn()}
            onFlushTopicInbox={vi.fn()}
            onOpenAgentBeside={vi.fn()}
            onSubmitDesktopReply={onSubmitDesktopReply}
            onActivateCompactReply={vi.fn()}
            onConvertToTodo={vi.fn()}
            onToggleTodoStatus={vi.fn()}
            onEditTodo={vi.fn()}
          />
        </PortalProvider>
      </QueryClientProvider>,
    ),
  );
  act(() => view.getByTestId("topic-inline-reply-trigger-task:T-100").click());
  const originalClick = HTMLInputElement.prototype.click;
  const pickLocalFiles = vi
    .spyOn(HTMLInputElement.prototype, "click")
    .mockImplementation(function (this: HTMLInputElement) {
      if (this.type !== "file") return originalClick.call(this);
      const selected = new DataTransfer();
      selected.items.add(new File([new Uint8Array([1, 2, 3])], "trace.png", { type: "image/png" }));
      selected.items.add(new File(["trace data"], "trace.txt", { type: "text/plain" }));
      this.files = selected.files;
      this.dispatchEvent(new Event("change"));
      this.remove();
    });
  await act(async () => {
    view.getByTestId("topic-inline-reply-attach-task:T-100").click();
  });
  pickLocalFiles.mockRestore();
  await vi.waitFor(() => {
    expect(view.getByText("trace.png")).toBeTruthy();
    expect(view.getByText("trace.txt")).toBeTruthy();
  });
  const send = view.getByTestId("topic-inline-reply-send-task:T-100");
  await act(async () => {
    send.click();
  });
  const [first] = onSubmitDesktopReply.mock.calls;
  expect(first).toEqual([
    topic,
    "",
    "auto",
    expect.any(String),
    [
      expect.objectContaining({
        kind: "image",
        metadata: expect.objectContaining({ fileName: "trace.png" }),
      }),
      expect.objectContaining({
        kind: "file",
        attachment: expect.objectContaining({ fileName: "trace.txt" }),
      }),
    ],
  ]);
  expect(view.getByText("trace.png")).toBeTruthy();
  expect(view.getByText("trace.txt")).toBeTruthy();
  const routeToggle = page.getByTestId("topic-inline-route-toggle-task:T-100");
  await expect.element(routeToggle).toBeEnabled();
  act(() => {
    send.click();
    // A click in the same React batch still reaches the old enabled button.
    (routeToggle.element() as HTMLElement).click();
  });
  await expect.element(routeToggle).toBeDisabled();
  expect(onSubmitDesktopReply.mock.calls[1]).toEqual(first);
  await act(async () => accepted.resolve(true));
  await expect.element(routeToggle).toBeEnabled();
  expect(view.queryByText("trace.png")).toBeNull();
  expect(view.queryByText("trace.txt")).toBeNull();
});
