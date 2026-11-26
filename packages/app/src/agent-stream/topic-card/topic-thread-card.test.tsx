/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DisclosureRow } from "@/agent-stream/disclosure";
import type { StreamViewportHandle } from "@/agent-stream/strategy";
import { useTopicStreamViewStore } from "@/stores/topic-stream-view-store";
import type { TopicUnit } from "./model";
import {
  computeSeenTopicWatermark,
  resolveFlushableTaskId,
  TopicThreadCard,
} from "./topic-thread-card";

vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: "en" } }),
}));

vi.mock("@/constants/layout", async (original) => ({
  ...(await original<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/utils/app-visibility", () => ({
  getIsAppVisible: () => true,
  getIsAppActivelyVisible: () => true,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    testID,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} onClick={onSelect}>
      {children}
    </button>
  ),
}));

beforeEach(() => {
  useTopicStreamViewStore.setState({
    expandedProcessByTopicKey: {},
    expandedHistoryByTopicKey: {},
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

it("renders user prompt first, toggles process via useDisclosureHold, flushes topic inbox, and opens lead beside", () => {
  const holdRow = vi.fn((_rowId: string, apply: () => void) => apply());
  const viewportRef = createViewportRef(holdRow);
  const onAutoMarkRead = vi.fn();
  const onOpenAgentBeside = vi.fn();
  const onFlushTopicInbox = vi.fn();
  const onMarkTopicMode = vi.fn();
  const onSubmitDesktopReply = vi.fn(() => true);
  const onActivateCompactReply = vi.fn();
  const onConvertToTodo = vi.fn();
  const onToggleTodoStatus = vi.fn();
  const onEditTodo = vi.fn();
  const topic = makeTopic();

  render(
    <DisclosureRow rowId="topic-row" viewportRef={viewportRef}>
      <TopicThreadCard
        agentKey="srv-1:mc-1"
        topic={topic}
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
    </DisclosureRow>,
  );

  expect(screen.getByTestId("topic-card-root-prompt").textContent).toBe(
    "Audit the WebSocket reconnect path",
  );
  expect(screen.getByTestId("topic-new-replies-divider")).toBeTruthy();
  expect(screen.getByTestId("topic-reply-subagent-rep-1").textContent).toContain(
    "Found missing jitter in reconnect backoff.",
  );
  expect(screen.queryByTestId("topic-process-steps-task:T-100")).toBeNull();

  fireEvent.click(screen.getByTestId("topic-process-toggle-task:T-100"));
  expect(holdRow).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("topic-process-steps-task:T-100").textContent).toContain(
    "Dispatching network specialist",
  );

  fireEvent.click(screen.getByTestId("topic-card-open-beside-task:T-100"));
  expect(onOpenAgentBeside).toHaveBeenCalledWith(
    expect.objectContaining({ targetAgentId: "lead-ws" }),
  );

  fireEvent.click(screen.getByTestId("topic-flush-inbox-task:T-100"));
  expect(onFlushTopicInbox).toHaveBeenCalledWith(topic);

  fireEvent.click(screen.getByTestId("topic-card-toggle-read-task:T-100"));
  expect(onMarkTopicMode).toHaveBeenCalledWith(topic, "read");

  fireEvent.click(screen.getByTestId("topic-card-convert-todo-task:T-100"));
  expect(onConvertToTodo).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Audit the WebSocket reconnect path" }),
  );
});

it("keeps unmeasured cards unread and only advances watermark to actually visible unread replies", () => {
  const topic = makeTopic();
  // Unmeasured viewport / card must never mark read.
  expect(
    computeSeenTopicWatermark({
      topic,
      viewportBounds: { scrollY: 0, height: 0, measured: false },
      cardLayout: null,
      railBodyOffsetY: 40,
      replyLayouts: new Map(),
    }),
  ).toBeNull();

  // Tall card where only rep-1 (seq 2) is inside viewport [0..300] and mc-1 (seq 3) is below fold at y=420.
  const partialSeen = computeSeenTopicWatermark({
    topic,
    viewportBounds: { scrollY: 0, height: 300, measured: true },
    cardLayout: { y: 20, height: 600 },
    railBodyOffsetY: 60,
    replyLayouts: new Map([
      ["rep-1", { y: 10, height: 100 }],
      ["mc-1", { y: 360, height: 120 }],
    ]),
  });
  expect(partialSeen).toEqual({
    seq: 2,
    timestampMs: 1_700_000_002_000,
    fallbackItemIds: ["rep-1"],
  });

  // Strict contiguous prefix: when earlier unread seq 5 is above viewport (unseen) and later
  // unread seq 6 is visible, MUST return null so seq 5 is NEVER swallowed by committing seq 6!
  const firstReply = topic.replies[0];
  const secondReply = topic.replies[1];
  if (firstReply?.kind !== "subagent_report" || secondReply?.kind !== "main_conclusion") {
    throw new Error("Expected subagent_report and main_conclusion fixture replies");
  }
  const scrolledPastEarlyTopic: TopicUnit = {
    ...topic,
    replies: [
      { ...firstReply, id: "rep-5", seq: 5, timestampMs: 1_700_000_005_000, isUnread: true },
      { ...secondReply, id: "mc-6", seq: 6, timestampMs: 1_700_000_006_000, isUnread: true },
    ],
    latestSeq: 6,
    latestTimestampMs: 1_700_000_006_000,
  };
  const skippedEarlier = computeSeenTopicWatermark({
    topic: scrolledPastEarlyTopic,
    viewportBounds: { scrollY: 300, height: 300, measured: true },
    cardLayout: { y: 0, height: 600 },
    railBodyOffsetY: 40,
    replyLayouts: new Map([
      // rep-5 sits at absY 40..140 (completely above scrollY 300 -> unseen!)
      ["rep-5", { y: 0, height: 100 }],
      // mc-6 sits at absY 340..440 (inside viewport 300..600 -> visible!)
      ["mc-6", { y: 300, height: 100 }],
    ]),
  });
  expect(skippedEarlier).toBeNull();

  const outOfSequence = computeSeenTopicWatermark({
    topic: {
      ...scrolledPastEarlyTopic,
      replies: [
        { ...secondReply, id: "mc-6", seq: 6, timestampMs: 1_700_000_005_000, isUnread: true },
        { ...firstReply, id: "rep-5", seq: 5, timestampMs: 1_700_000_006_000, isUnread: true },
      ],
    },
    viewportBounds: { scrollY: 0, height: 300, measured: true },
    cardLayout: { y: 0, height: 600 },
    railBodyOffsetY: 40,
    replyLayouts: new Map([
      ["mc-6", { y: 0, height: 100 }],
      ["rep-5", { y: 300, height: 100 }],
    ]),
  });
  expect(outOfSequence?.seq).toBeNull();
});

function makeTopicWithoutTask(): TopicUnit {
  return {
    ...makeTopic(),
    topicKey: "msg:m-no-task",
    taskId: undefined,
    pendingInboxItems: [{ agentId: "lead-ws", title: "Lead", event: "finished" }],
    lifecycleStatus: "interrupted",
    retryCandidate: { text: "Retry original question", routeMode: "auto" },
  };
}

it("hides per-topic flush button when no concrete taskId exists and preserves draft on failed reply", async () => {
  const topicWithoutTask = makeTopicWithoutTask();
  expect(resolveFlushableTaskId(topicWithoutTask)).toBeNull();

  const onSubmitDesktopReply = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(
    <TopicThreadCard
      agentKey="srv-1:mc-1"
      topic={topicWithoutTask}
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
    />,
  );

  // Flush button must NOT be rendered when taskId is absent (prevents accidental global flush).
  expect(screen.queryByTestId("topic-flush-inbox-msg:m-no-task")).toBeNull();

  // Interrupted status offers in-card retry with deterministic clientMessageId.
  fireEvent.click(screen.getByTestId("topic-card-retry-msg:m-no-task"));
  expect(onSubmitDesktopReply).toHaveBeenCalledWith(
    topicWithoutTask,
    "Retry original question",
    "auto",
    undefined,
  );

  // Expand desktop inline composer and fail send -> draft & clientMessageId stay intact across retry!
  onSubmitDesktopReply.mockReset();
  onSubmitDesktopReply.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  fireEvent.click(screen.getByTestId("topic-inline-reply-trigger-msg:m-no-task"));
  const input = screen.getByTestId("topic-inline-reply-input-msg:m-no-task");
  fireEvent.change(input, { target: { value: "Keep my draft on error" } });
  const sendBtn = screen.getByTestId("topic-inline-reply-send-msg:m-no-task");
  fireEvent.click(sendBtn);
  await vi.waitFor(() => {
    expect(onSubmitDesktopReply).toHaveBeenCalledTimes(1);
  });
  const firstClientMessageId = onSubmitDesktopReply.mock.calls[0]![3];
  expect(typeof firstClientMessageId).toBe("string");
  expect(firstClientMessageId.length).toBeGreaterThan(0);
  expect((sendBtn as HTMLButtonElement).disabled).toBe(false);

  // Retrying the same draft reuses the EXACT SAME clientMessageId for server idempotency.
  fireEvent.click(sendBtn);
  await vi.waitFor(() => {
    expect(onSubmitDesktopReply).toHaveBeenCalledTimes(2);
  });
  expect(onSubmitDesktopReply.mock.calls[1]![3]).toBe(firstClientMessageId);
});

it("persists long subagent report expansion in topic-stream-view-store across remounts", () => {
  const longText = "Detailed analysis line. ".repeat(20);
  const topicWithLongReply: TopicUnit = {
    ...makeTopic(),
    replies: [
      {
        ...(makeTopic().replies[0] as Extract<
          TopicUnit["replies"][number],
          { kind: "subagent_report" }
        >),
        id: "rep-long",
        text: longText,
      },
    ],
  };
  const props = {
    agentKey: "srv-1:mc-1",
    topic: topicWithLongReply,
    isPaneFocused: false,
    onAutoMarkRead: vi.fn(),
    onMarkTopicMode: vi.fn(),
    onFlushTopicInbox: vi.fn(),
    onOpenAgentBeside: vi.fn(),
    onSubmitDesktopReply: vi.fn(() => true),
    onActivateCompactReply: vi.fn(),
    onConvertToTodo: vi.fn(),
    onToggleTodoStatus: vi.fn(),
    onEditTodo: vi.fn(),
  };

  const firstMount = render(<TopicThreadCard {...props} />);
  fireEvent.click(screen.getByTestId("topic-reply-expand-rep-long"));
  expect(screen.getByTestId("topic-reply-subagent-rep-long").textContent).toContain(longText);
  firstMount.unmount();

  render(<TopicThreadCard {...props} />);
  expect(screen.getByTestId("topic-reply-subagent-rep-long").textContent).toContain(longText);
});
