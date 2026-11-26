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
    expandedConflictsByTopicKey: {},
    decisionDraftByTopicKey: {},
    decisionDraftMetaByTopicKey: {},
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
    retryCandidate: { entryId: "retry-entry", text: "Retry original reply" },
  };
}

it("hides per-topic flush button when no concrete taskId exists and preserves draft on failed reply", async () => {
  const topicWithoutTask = makeTopicWithoutTask();
  expect(resolveFlushableTaskId(topicWithoutTask)).toBeNull();

  const onSubmitDesktopReply = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const onRetryTopic = vi.fn();
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
      onRetryTopic={onRetryTopic}
      onActivateCompactReply={vi.fn()}
      onConvertToTodo={vi.fn()}
      onToggleTodoStatus={vi.fn()}
      onEditTodo={vi.fn()}
    />,
  );

  // Flush button must NOT be rendered when taskId is absent (prevents accidental global flush).
  expect(screen.queryByTestId("topic-flush-inbox-msg:m-no-task")).toBeNull();

  fireEvent.click(screen.getByTestId("topic-card-retry-msg:m-no-task"));
  expect(onRetryTopic).toHaveBeenCalledExactlyOnceWith(topicWithoutTask, {
    entryId: "retry-entry",
    text: "Retry original reply",
  });
  expect(onSubmitDesktopReply).not.toHaveBeenCalled();

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

function makeTopicWithConflicts(): TopicUnit {
  return {
    ...makeTopic(),
    fileConflicts: [
      {
        path: "packages/app/src/panels/agent-panel.tsx",
        peers: [
          {
            taskId: "T-PEER-1",
            title: "Composer refactor",
            leadAgentId: "lead-ui",
            leadTitle: "UI Lead",
            status: "in_progress",
          },
        ],
      },
    ],
  };
}

function makeTopicWithQuestion(
  generation = "11111111-1111-4111-8111-111111111111",
  question = "Which transport?\n1. Keep WebSocket\n2. Switch to SSE",
): TopicUnit {
  return {
    ...makeTopic(),
    lifecycleStatus: "blocked",
    activeBlockingPrompt: {
      kind: "task_blocking_question",
      taskId: "T-100",
      question,
      blockingQuestionGeneration: generation,
      options: ["Keep WebSocket", "Switch to SSE"],
    },
  };
}

function makeTopicWithLegacyDurableItem(): TopicUnit {
  return {
    ...makeTopic(),
    lifecycleStatus: "blocked",
    activeBlockingPrompt: {
      kind: "durable_item",
      canDecideInTopic: false,
      item: {
        workspaceId: "ws-1",
        requestId: "dur-legacy",
        sourceAgentId: "lead-ws",
        sourceTurnId: "turn-old",
        kind: "decision",
        title: "Legacy unbound approval",
        summary: "Created before exact task binding existed",
        evidence: [],
        createdAt: "2026-06-01T00:00:00.000Z",
        revision: 1,
        status: "pending",
      },
    },
  };
}

function makeTopicWithDurableAndSilentReport(): TopicUnit {
  return {
    ...makeTopic(),
    lifecycleStatus: "blocked",
    replies: [
      {
        kind: "thread_entry",
        id: "thread:te-silent",
        entry: {
          entryId: "te-silent",
          workspaceId: "ws-1",
          mainAgentId: "mc-1",
          topicKey: "task:T-100",
          taskId: "T-100",
          role: "agent_reply",
          origin: "subagent_report",
          reportStatus: "completed",
          authorAgentId: "lead-ws",
          authorTitle: "Network Lead",
          routedAgentId: "lead-ws",
          text: "Silent report summary.",
          status: "completed",
          seq: 1,
          createdAt: new Date(1_700_000_005_000).toISOString(),
          updatedAt: new Date(1_700_000_005_000).toISOString(),
        },
        threadSeq: 1,
        seq: null,
        timestampMs: 1_700_000_005_000,
        isUnread: true,
      },
    ],
    activeBlockingPrompt: {
      kind: "durable_item",
      canDecideInTopic: true,
      item: {
        workspaceId: "ws-1",
        requestId: "dur-1",
        sourceAgentId: "lead-ws",
        sourceTurnId: "turn-1",
        taskId: "T-100",
        kind: "acceptance",
        title: "Accept reconnect fix",
        summary: "Verified backoff jitter tests",
        evidence: [{ type: "file", path: "reconnect.ts", fingerprint: "sha256:abc" }],
        createdAt: "2026-06-01T00:00:00.000Z",
        revision: 2,
        status: "pending",
      },
    },
  };
}

it("renders TopicConflictBanner, expands conflicting files via useDisclosureHold, and jumps to peer topic", () => {
  const holdRow = vi.fn((_rowId: string, apply: () => void) => apply());
  const viewportRef = createViewportRef(holdRow);
  const onJumpToPeerTopic = vi.fn();
  const topicWithConflicts = makeTopicWithConflicts();

  render(
    <DisclosureRow rowId="conflict-row" viewportRef={viewportRef}>
      <TopicThreadCard
        agentKey="srv-1:mc-1"
        topic={topicWithConflicts}
        isPaneFocused={false}
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
    </DisclosureRow>,
  );

  expect(screen.getByTestId("topic-conflict-banner-task:T-100")).toBeTruthy();
  expect(screen.queryByTestId("topic-conflict-files-task:T-100")).toBeNull();

  fireEvent.click(screen.getByTestId("topic-conflict-toggle-task:T-100"));
  expect(holdRow).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("topic-conflict-files-task:T-100").textContent).toContain(
    "packages/app/src/panels/agent-panel.tsx",
  );

  fireEvent.click(screen.getByTestId("topic-conflict-jump-T-PEER-1"));
  expect(onJumpToPeerTopic).toHaveBeenCalledWith("T-PEER-1");
});

it("renders TopicDecisionSlot for blockingQuestion with quick options, preserves draft on failure, and degrades on legacy host", async () => {
  const topicWithQuestion = makeTopicWithQuestion();

  const legacyRender = render(
    <TopicThreadCard
      agentKey="srv-1:mc-1"
      topic={topicWithQuestion}
      isPaneFocused={false}
      supportsButlerV1={false}
      onAutoMarkRead={vi.fn()}
      onMarkTopicMode={vi.fn()}
      onFlushTopicInbox={vi.fn()}
      onOpenAgentBeside={vi.fn()}
      onSubmitDesktopReply={vi.fn(() => true)}
      onActivateCompactReply={vi.fn()}
      onConvertToTodo={vi.fn()}
      onToggleTodoStatus={vi.fn()}
      onEditTodo={vi.fn()}
    />,
  );
  expect(screen.getByTestId("topic-decision-legacy-notice-task:T-100")).toBeTruthy();
  legacyRender.unmount();

  const onSubmitTopicDecision = vi
    .fn()
    .mockResolvedValueOnce({ outcome: "error" as const, message: "Temporary error" })
    .mockResolvedValueOnce({ outcome: "saved" as const });

  render(
    <TopicThreadCard
      agentKey="srv-1:mc-1"
      topic={topicWithQuestion}
      isPaneFocused={false}
      supportsButlerV1={true}
      onSubmitTopicDecision={onSubmitTopicDecision}
      onAutoMarkRead={vi.fn()}
      onMarkTopicMode={vi.fn()}
      onFlushTopicInbox={vi.fn()}
      onOpenAgentBeside={vi.fn()}
      onSubmitDesktopReply={vi.fn(() => true)}
      onActivateCompactReply={vi.fn()}
      onConvertToTodo={vi.fn()}
      onToggleTodoStatus={vi.fn()}
      onEditTodo={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByTestId("topic-decision-option-0"));
  fireEvent.click(screen.getByTestId("topic-decision-submit-task:T-100"));

  await vi.waitFor(() => {
    expect(onSubmitTopicDecision).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("topic-decision-feedback-task:T-100").textContent).toBe(
      "Temporary error",
    );
  });
  const firstClientMessageId = onSubmitTopicDecision.mock.calls[0]![0].clientMessageId;
  expect(onSubmitTopicDecision.mock.calls[0]![0]).toMatchObject({
    resolutionKind: "task_blocking_question",
    note: "Keep WebSocket",
  });

  // Draft preserved after error; retrying sends the exact same clientMessageId.
  fireEvent.click(screen.getByTestId("topic-decision-submit-task:T-100"));
  await vi.waitFor(() => {
    expect(onSubmitTopicDecision).toHaveBeenCalledTimes(2);
  });
  expect(onSubmitTopicDecision.mock.calls[1]![0].clientMessageId).toBe(firstClientMessageId);
});

it("renders TopicDecisionSlot for DurableItem, locks approve on evidenceStale, and renders silent subagent_report entries", async () => {
  const onSubmitTopicDecision = vi
    .fn()
    .mockResolvedValueOnce({ outcome: "evidenceStale" as const })
    .mockResolvedValueOnce({ outcome: "saved" as const });
  const onRefreshDurableItems = vi.fn();
  const onOpenAgentBeside = vi.fn();
  const topicWithDurableAndSilentReport = makeTopicWithDurableAndSilentReport();

  render(
    <TopicThreadCard
      agentKey="srv-1:mc-1"
      serverId="srv-1"
      workspaceId="ws-1"
      topic={topicWithDurableAndSilentReport}
      isPaneFocused={false}
      supportsButlerV1={true}
      durableItemsOnline={true}
      durableItemsConfirmed={true}
      onRefreshDurableItems={onRefreshDurableItems}
      onSubmitTopicDecision={onSubmitTopicDecision}
      onAutoMarkRead={vi.fn()}
      onMarkTopicMode={vi.fn()}
      onFlushTopicInbox={vi.fn()}
      onOpenAgentBeside={onOpenAgentBeside}
      onSubmitDesktopReply={vi.fn(() => true)}
      onActivateCompactReply={vi.fn()}
      onConvertToTodo={vi.fn()}
      onToggleTodoStatus={vi.fn()}
      onEditTodo={vi.fn()}
    />,
  );

  expect(screen.getByTestId("topic-reply-thread-te-silent").textContent).toContain(
    "Silent report summary.",
  );
  fireEvent.click(screen.getByTestId("topic-reply-open-beside-te-silent"));
  expect(onOpenAgentBeside).toHaveBeenCalledWith(
    expect.objectContaining({ targetAgentId: "lead-ws" }),
  );

  // Type optional note and approve -> evidenceStale locks approve but preserves draft & allows request_changes.
  fireEvent.change(screen.getByTestId("topic-decision-note-input-task:T-100"), {
    target: { value: "Please rebase first" },
  });
  fireEvent.click(screen.getByTestId("topic-decision-action-approve-task:T-100"));

  await vi.waitFor(() => {
    expect(screen.getByTestId("topic-decision-refresh-task:T-100")).toBeTruthy();
    expect(
      (screen.getByTestId("topic-decision-action-approve-task:T-100") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  fireEvent.click(screen.getByTestId("topic-decision-refresh-task:T-100"));
  expect(onRefreshDurableItems).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByTestId("topic-decision-action-request_changes-task:T-100"));
  await vi.waitFor(() => {
    expect(onSubmitTopicDecision).toHaveBeenCalledTimes(2);
  });
  expect(onSubmitTopicDecision.mock.calls[1]![0]).toMatchObject({
    resolutionKind: "durable_item",
    decision: "request_changes",
    note: "Please rebase first",
  });
});

it("forwards expectedBlockingQuestionGeneration, preserves draft on stale_blocking_question, and retries against refreshed generation", async () => {
  const gen1 = "11111111-1111-4111-8111-111111111111";
  const gen2 = "22222222-2222-4222-8222-222222222222";
  const onSubmitTopicDecision = vi
    .fn()
    .mockResolvedValueOnce({ outcome: "staleBlockingQuestion" as const })
    .mockResolvedValueOnce({ outcome: "saved" as const });
  const topicV1 = makeTopicWithQuestion(gen1, "Question v1?");
  const topicV2 = makeTopicWithQuestion(gen2, "Question v2 updated?");

  const view = render(
    <TopicThreadCard
      agentKey="srv-1:mc-1"
      topic={topicV1}
      isPaneFocused={false}
      supportsButlerV1={true}
      onSubmitTopicDecision={onSubmitTopicDecision}
      onAutoMarkRead={vi.fn()}
      onMarkTopicMode={vi.fn()}
      onFlushTopicInbox={vi.fn()}
      onOpenAgentBeside={vi.fn()}
      onSubmitDesktopReply={vi.fn(() => true)}
      onActivateCompactReply={vi.fn()}
      onConvertToTodo={vi.fn()}
      onToggleTodoStatus={vi.fn()}
      onEditTodo={vi.fn()}
    />,
  );

  fireEvent.change(screen.getByTestId("topic-decision-input-task:T-100"), {
    target: { value: "Use option 1" },
  });
  fireEvent.click(screen.getByTestId("topic-decision-submit-task:T-100"));

  await vi.waitFor(() => {
    expect(screen.getByTestId("topic-decision-feedback-task:T-100").textContent).toBe(
      "topicWorkbench.topicStream.decisionBlockingQuestionStale",
    );
  });
  expect(onSubmitTopicDecision.mock.calls[0]![0]).toMatchObject({
    resolutionKind: "task_blocking_question",
    expectedBlockingQuestionGeneration: gen1,
    note: "Use option 1",
  });
  // Draft must remain preserved in store after stale rejection.
  expect(useTopicStreamViewStore.getState().decisionDraftByTopicKey["srv-1:mc-1\0task:T-100"]).toBe(
    "Use option 1",
  );

  // Re-render with server-refreshed generation v2 and submit again -> sends new generation & fresh clientMessageId.
  view.rerender(
    <TopicThreadCard
      agentKey="srv-1:mc-1"
      topic={topicV2}
      isPaneFocused={false}
      supportsButlerV1={true}
      onSubmitTopicDecision={onSubmitTopicDecision}
      onAutoMarkRead={vi.fn()}
      onMarkTopicMode={vi.fn()}
      onFlushTopicInbox={vi.fn()}
      onOpenAgentBeside={vi.fn()}
      onSubmitDesktopReply={vi.fn(() => true)}
      onActivateCompactReply={vi.fn()}
      onConvertToTodo={vi.fn()}
      onToggleTodoStatus={vi.fn()}
      onEditTodo={vi.fn()}
    />,
  );

  expect(screen.getByTestId("topic-decision-question-task:T-100").textContent).toBe(
    "Question v2 updated?",
  );
  fireEvent.click(screen.getByTestId("topic-decision-submit-task:T-100"));
  await vi.waitFor(() => {
    expect(onSubmitTopicDecision).toHaveBeenCalledTimes(2);
  });
  expect(onSubmitTopicDecision.mock.calls[1]![0]).toMatchObject({
    expectedBlockingQuestionGeneration: gen2,
    note: "Use option 1",
  });
  expect(onSubmitTopicDecision.mock.calls[1]![0].clientMessageId).not.toBe(
    onSubmitTopicDecision.mock.calls[0]![0].clientMessageId,
  );
});

it("routes legacy DurableItem without exact task binding to standalone approval view instead of in-card topic decide", () => {
  const onOpenStandaloneDurableItem = vi.fn();
  const onSubmitTopicDecision = vi.fn();
  const legacyTopic = makeTopicWithLegacyDurableItem();

  render(
    <TopicThreadCard
      agentKey="srv-1:mc-1"
      topic={legacyTopic}
      isPaneFocused={false}
      supportsButlerV1={true}
      onOpenStandaloneDurableItem={onOpenStandaloneDurableItem}
      onSubmitTopicDecision={onSubmitTopicDecision}
      onAutoMarkRead={vi.fn()}
      onMarkTopicMode={vi.fn()}
      onFlushTopicInbox={vi.fn()}
      onOpenAgentBeside={vi.fn()}
      onSubmitDesktopReply={vi.fn(() => true)}
      onActivateCompactReply={vi.fn()}
      onConvertToTodo={vi.fn()}
      onToggleTodoStatus={vi.fn()}
      onEditTodo={vi.fn()}
    />,
  );

  expect(screen.queryByTestId("topic-decision-action-approve-task:T-100")).toBeNull();
  expect(screen.getByTestId("topic-decision-standalone-hint-task:T-100")).toBeTruthy();
  fireEvent.click(screen.getByTestId("topic-decision-open-standalone-task:T-100"));
  expect(onOpenStandaloneDurableItem).toHaveBeenCalledWith(
    expect.objectContaining({ requestId: "dur-legacy" }),
  );
  expect(onSubmitTopicDecision).not.toHaveBeenCalled();
});

it("preserves original generation across unmount/remount on desktop and never downgrades when stale response lacks a next generation", async () => {
  const gen1 = "11111111-1111-4111-8111-111111111111";
  const gen2 = "22222222-2222-4222-8222-222222222222";
  const onSubmitTopicDecision = vi
    .fn()
    .mockResolvedValueOnce({
      outcome: "staleBlockingQuestion" as const,
      hasLatestTask: true,
      latestBlockingQuestionGeneration: undefined,
    })
    .mockResolvedValueOnce({
      outcome: "staleBlockingQuestion" as const,
      hasLatestTask: true,
      latestBlockingQuestionGeneration: gen2,
    })
    .mockResolvedValueOnce({ outcome: "saved" as const });

  const topicV1 = makeTopicWithQuestion(gen1, "Question v1?");
  const topicV2 = makeTopicWithQuestion(gen2, "Question v2 updated?");

  const firstRender = render(
    <TopicThreadCard
      agentKey="srv-1:mc-1"
      topic={topicV1}
      isPaneFocused={false}
      supportsButlerV1={true}
      onSubmitTopicDecision={onSubmitTopicDecision}
      onAutoMarkRead={vi.fn()}
      onMarkTopicMode={vi.fn()}
      onFlushTopicInbox={vi.fn()}
      onOpenAgentBeside={vi.fn()}
      onSubmitDesktopReply={vi.fn(() => true)}
      onActivateCompactReply={vi.fn()}
      onConvertToTodo={vi.fn()}
      onToggleTodoStatus={vi.fn()}
      onEditTodo={vi.fn()}
    />,
  );

  fireEvent.change(screen.getByTestId("topic-decision-input-task:T-100"), {
    target: { value: "Answer written under v1" },
  });
  firstRender.unmount();

  // Remount with v2 without user editing the persisted draft -> must still send v1!
  render(
    <TopicThreadCard
      agentKey="srv-1:mc-1"
      topic={topicV2}
      isPaneFocused={false}
      supportsButlerV1={true}
      onSubmitTopicDecision={onSubmitTopicDecision}
      onAutoMarkRead={vi.fn()}
      onMarkTopicMode={vi.fn()}
      onFlushTopicInbox={vi.fn()}
      onOpenAgentBeside={vi.fn()}
      onSubmitDesktopReply={vi.fn(() => true)}
      onActivateCompactReply={vi.fn()}
      onConvertToTodo={vi.fn()}
      onToggleTodoStatus={vi.fn()}
      onEditTodo={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByTestId("topic-decision-submit-task:T-100"));
  await vi.waitFor(() => expect(onSubmitTopicDecision).toHaveBeenCalledTimes(1));
  expect(onSubmitTopicDecision.mock.calls[0]![0]).toMatchObject({
    expectedBlockingQuestionGeneration: gen1,
    note: "Answer written under v1",
  });

  // First stale response carried hasLatestTask: true without a new generation -> must NOT downgrade
  // to versionless or auto-adopt gen2; retrying still sends gen1!
  await vi.waitFor(() => {
    expect(screen.getByTestId("topic-decision-feedback-task:T-100").textContent).toBe(
      "topicWorkbench.topicStream.decisionBlockingQuestionStale",
    );
  });
  fireEvent.click(screen.getByTestId("topic-decision-submit-task:T-100"));
  await vi.waitFor(() => expect(onSubmitTopicDecision).toHaveBeenCalledTimes(2));
  expect(onSubmitTopicDecision.mock.calls[1]![0]).toMatchObject({
    expectedBlockingQuestionGeneration: gen1,
    note: "Answer written under v1",
  });

  // Second stale response carried valid latestBlockingQuestionGeneration: gen2 -> wait for
  // submission to settle and confirm next submit uses gen2 with a fresh clientMessageId.
  await vi.waitFor(() => {
    expect(
      (screen.getByTestId("topic-decision-submit-task:T-100") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      useTopicStreamViewStore.getState().decisionDraftMetaByTopicKey["srv-1:mc-1\0task:T-100"]
        ?.blockingQuestionGeneration,
    ).toBe(gen2);
  });
  fireEvent.click(screen.getByTestId("topic-decision-submit-task:T-100"));
  await vi.waitFor(() => expect(onSubmitTopicDecision).toHaveBeenCalledTimes(3));
  expect(onSubmitTopicDecision.mock.calls[2]![0]).toMatchObject({
    expectedBlockingQuestionGeneration: gen2,
    note: "Answer written under v1",
  });
  expect(onSubmitTopicDecision.mock.calls[2]![0].clientMessageId).not.toBe(
    onSubmitTopicDecision.mock.calls[1]![0].clientMessageId,
  );
});
