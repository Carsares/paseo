import { PortalProvider } from "@gorhom/portal";
import { within } from "@testing-library/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DisclosureRow } from "@/agent-stream/disclosure";
import type { StreamViewportHandle } from "@/agent-stream/strategy";
import { i18n } from "@/i18n/i18next";
import { useTopicStreamViewStore } from "@/stores/topic-stream-view-store";
import type { TopicUnit } from "./model";
import { TopicThreadCard } from "./topic-thread-card";

let container: HTMLDivElement;
let root: Root;
let view: ReturnType<typeof within>;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  useTopicStreamViewStore.setState({
    expandedProcessByTopicKey: {},
    expandedHistoryByTopicKey: {},
  });
  container = document.body.appendChild(document.createElement("div"));
  container.style.width = "900px";
  root = createRoot(container);
  view = within(container);
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

it("renders user prompt first, collapses process steps behind useDisclosureHold, and triggers split-open & flush", () => {
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

  act(() => {
    root.render(
      <PortalProvider>
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
        </DisclosureRow>
      </PortalProvider>,
    );
  });

  // Row 1 shows the real user question
  expect(view.getByTestId("topic-card-root-prompt").textContent).toBe(
    "Audit the WebSocket reconnect path",
  );
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
