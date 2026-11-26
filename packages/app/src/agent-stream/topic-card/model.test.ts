import type {
  PendingSubagentInboxItem,
  TopicAnchorSummary,
  TopicThreadEntry,
  WorkspaceDurableItem,
  WorkspaceTaskSummary,
  WorkspaceTodoItem,
  WorkspaceTopicReadSnapshot,
} from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { upsertTopicAnchor } from "@/topic-threads/queries";
import { reduceStreamUpdate, type StreamItem } from "@/types/stream";
import { canDecideDurableItemInTopic, extractQuickReplyOptions, projectTopicUnits } from "./model";

function makeHumanPrompt(input: {
  id: string;
  messageId?: string;
  text: string;
  seq: number;
  ts: number;
}): StreamItem {
  return {
    kind: "user_message",
    id: input.id,
    messageId: input.messageId ?? input.id,
    text: input.text,
    timestamp: new Date(input.ts),
    timelineCursor: { epoch: "ep-1", seq: input.seq },
  };
}

function makeSubagentReport(input: {
  id: string;
  senderId: string;
  senderTitle: string;
  text: string;
  taskId?: string;
  rootMessageId?: string;
  reportStatus?: "completed" | "blocked";
  event?: "message" | "finished" | "errored" | "permission-required" | "closed";
  seq: number;
  ts: number;
}): StreamItem {
  return {
    kind: "tool_call",
    id: input.id,
    timestamp: new Date(input.ts),
    timelineCursor: { epoch: "ep-1", seq: input.seq },
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId: input.id,
        name: "agent_message",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: null, output: null },
        agentMessage: {
          event: input.event ?? "finished",
          sender: { id: input.senderId, title: input.senderTitle },
          text: input.text,
          ...(input.reportStatus ? { reportStatus: input.reportStatus } : {}),
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.rootMessageId ? { rootMessageId: input.rootMessageId } : {}),
        },
      },
    },
  };
}

function makeAssistantConclusion(input: {
  id: string;
  text: string;
  seq: number;
  ts: number;
}): StreamItem {
  return {
    kind: "assistant_message",
    id: input.id,
    messageId: input.id,
    text: input.text,
    timestamp: new Date(input.ts),
    timelineCursor: { epoch: "ep-1", seq: input.seq },
  };
}

describe("projectTopicUnits", () => {
  it("routes out-of-order concurrent subagent reports to their matching topic card by taskId", () => {
    const tasks: WorkspaceTaskSummary[] = [
      {
        taskId: "T-1",
        title: "Refactor auth",
        tier: "T2",
        status: "in_progress",
        participants: [{ agentId: "lead-1" }],
        rootMessageId: "msg-1",
        leadAgentId: "lead-1",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
      {
        taskId: "T-2",
        title: "Fix sidebar layout",
        tier: "T1",
        status: "in_progress",
        participants: [{ agentId: "lead-2" }],
        rootMessageId: "msg-2",
        leadAgentId: "lead-2",
        createdAt: "2026-06-01T00:01:00.000Z",
        updatedAt: "2026-06-01T00:01:00.000Z",
      },
    ];

    const items: StreamItem[] = [
      makeHumanPrompt({
        id: "u-1",
        messageId: "msg-1",
        text: "Question 1: auth",
        seq: 1,
        ts: 1000,
      }),
      makeHumanPrompt({
        id: "u-2",
        messageId: "msg-2",
        text: "Question 2: sidebar",
        seq: 2,
        ts: 2000,
      }),
      // Out-of-order report for T-1 arriving AFTER Question 2!
      makeSubagentReport({
        id: "rep-1",
        senderId: "lead-1",
        senderTitle: "Backend Lead",
        text: "Auth refactor complete",
        taskId: "T-1",
        rootMessageId: "msg-1",
        reportStatus: "completed",
        seq: 3,
        ts: 3000,
      }),
      makeAssistantConclusion({ id: "main-2", text: "Sidebar fixed", seq: 4, ts: 4000 }),
    ];

    const result = projectTopicUnits({ items, tasks });
    expect(result.topics).toHaveLength(2);
    expect(result.topics[0]!.topicKey).toBe("task:T-1");
    expect(result.topics[0]!.replies).toHaveLength(1);
    expect(result.topics[0]!.replies[0]!.kind).toBe("subagent_report");
    expect(result.topics[1]!.topicKey).toBe("task:T-2");
    expect(result.topics[1]!.replies.map(({ id }) => id)).toEqual(["main-2"]);
  });

  it("smoothly degrades for legacy timeline items without taskId or rootMessageId", () => {
    const items: StreamItem[] = [
      makeHumanPrompt({ id: "u-old-1", text: "Legacy question 1", seq: 1, ts: 1000 }),
      {
        kind: "user_message",
        id: "legacy-sub-1",
        sender: { id: "worker-a", title: "Worker A" },
        text: "Legacy report text",
        timestamp: new Date(1500),
        timelineCursor: { epoch: "ep-1", seq: 2 },
      },
      makeAssistantConclusion({ id: "a-old-1", text: "Legacy conclusion", seq: 3, ts: 2000 }),
    ];

    const result = projectTopicUnits({ items });
    expect(result.topics).toHaveLength(1);
    expect(result.topics[0]!.topicKey).toBe("msg:u-old-1");
    expect(result.topics[0]!.rootPrompt.text).toBe("Legacy question 1");
    expect(result.topics[0]!.replies.map((r) => r.kind)).toEqual([
      "subagent_report",
      "main_conclusion",
    ]);
  });

  it("computes unread divider position, manual unread override, and client watermark snapshot", () => {
    const items: StreamItem[] = [
      makeHumanPrompt({ id: "u-1", messageId: "m-1", text: "Investigate leak", seq: 10, ts: 1000 }),
      makeSubagentReport({
        id: "r-1",
        senderId: "lead-1",
        senderTitle: "Lead 1",
        text: "Initial findings",
        reportStatus: "completed",
        seq: 11,
        ts: 2000,
      }),
      makeAssistantConclusion({ id: "a-1", text: "Final summary", seq: 12, ts: 3000 }),
    ];

    const threadEntries: TopicThreadEntry[] = [
      {
        entryId: "e-user",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "msg:m-1",
        role: "user_followup",
        routedAgentId: "lead-1",
        text: "Can we verify memory drop?",
        status: "completed",
        seq: 13,
        createdAt: "2026-06-01T00:00:04.000Z",
        updatedAt: "2026-06-01T00:00:04.000Z",
      },
      {
        entryId: "e-reply",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "msg:m-1",
        role: "agent_reply",
        authorAgentId: "lead-1",
        authorTitle: "Lead 1",
        routedAgentId: "lead-1",
        text: "Verified: RSS dropped by 40MB",
        status: "completed",
        seq: 14,
        createdAt: "2026-06-01T00:00:05.000Z",
        updatedAt: "2026-06-01T00:00:05.000Z",
      },
    ];

    const readSnapshot: WorkspaceTopicReadSnapshot = {
      workspaceId: "ws-1",
      mainAgentId: "mc-1",
      watermarkEpoch: "ep-1",
      watermarkSeq: 11,
      watermarkTimestampMs: 2000,
      topics: [],
      revision: 1,
    };

    const result = projectTopicUnits({ items, threadEntries, readSnapshot });
    const topic = result.topics[0]!;
    // Replies: r-1 (seq 11 -> read), a-1 (seq 12 -> unread), e-user (user_followup -> read), e-reply (ts > 2000 -> unread)
    expect(topic.unreadReplyCount).toBe(2);
    expect(topic.firstUnreadReplyIndex).toBe(1);
    expect(topic.hasUnread).toBe(true);
    expect(topic.lifecycleStatus).toBe("unread");
    // Main-timeline watermark seq must NOT be polluted by thread_entry seq (14).
    expect(result.watermark.maxSeq).toBe(12);
    expect(result.watermark.maxTimestampMs).toBe(Date.parse("2026-06-01T00:00:05.000Z"));
    expect(result.watermark.epoch).toBe("ep-1");
  });

  it("keeps thread_entry seq isolated from main-timeline seq so new mirrored replies are never swallowed", () => {
    const items: StreamItem[] = [
      makeHumanPrompt({ id: "u-1", messageId: "m-1", text: "Deploy check", seq: 99, ts: 9_000 }),
      makeAssistantConclusion({ id: "a-1", text: "Dispatched", seq: 100, ts: 10_000 }),
    ];
    // Independent thread_entry seq=1 (much smaller than main watermarkSeq=100), newer timestamp 20_000.
    const threadEntries: TopicThreadEntry[] = [
      {
        entryId: "e-new",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "msg:m-1",
        role: "agent_reply",
        authorAgentId: "lead-1",
        authorTitle: "Release Lead",
        routedAgentId: "lead-1",
        text: "Canary is green",
        status: "completed",
        seq: 1,
        createdAt: new Date(20_000).toISOString(),
        updatedAt: new Date(20_000).toISOString(),
      },
    ];
    const readSnapshot: WorkspaceTopicReadSnapshot = {
      workspaceId: "ws-1",
      mainAgentId: "mc-1",
      watermarkEpoch: "ep-1",
      watermarkSeq: 100,
      watermarkTimestampMs: 10_000,
      topics: [],
      revision: 2,
    };

    const unreadProjection = projectTopicUnits({ items, threadEntries, readSnapshot });
    expect(unreadProjection.topics[0]!.unreadReplyCount).toBe(1);
    expect(unreadProjection.topics[0]!.hasUnread).toBe(true);
    expect(unreadProjection.watermark.maxSeq).toBe(100);
    expect(unreadProjection.watermark.maxTimestampMs).toBe(20_000);

    const readProjection = projectTopicUnits({
      items,
      threadEntries,
      readSnapshot: { ...readSnapshot, watermarkTimestampMs: 20_000 },
    });
    expect(readProjection.topics[0]!.unreadReplyCount).toBe(0);
    expect(readProjection.topics[0]!.hasUnread).toBe(false);
  });

  it("combines explicit timeline times with only the current generation's sequence", () => {
    const items = [
      makeHumanPrompt({ id: "root", text: "Check rollout", seq: 1, ts: 1_000 }),
      makeAssistantConclusion({ id: "seen-by-seq", text: "Started", seq: 2, ts: 2_000 }),
      makeAssistantConclusion({ id: "seen-by-time", text: "Verified", seq: 3, ts: 3_000 }),
      makeAssistantConclusion({ id: "new", text: "Finished", seq: 4, ts: 4_000 }),
    ];
    const readSnapshot: WorkspaceTopicReadSnapshot = {
      workspaceId: "ws-1",
      mainAgentId: "mc-1",
      watermarkEpoch: "ep-1",
      watermarkSeq: 2,
      watermarkTimestampMs: 4_000,
      topics: [],
      revision: 1,
    };
    const unread = (snapshot: WorkspaceTopicReadSnapshot) =>
      projectTopicUnits({ items, readSnapshot: snapshot }).topics[0]!.replies.map(
        ({ isUnread }) => isUnread,
      );

    expect(unread(readSnapshot)).toEqual([false, true, true]);
    expect(unread({ ...readSnapshot, watermarkTimelineTimestampMs: 3_000 })).toEqual([
      false,
      false,
      true,
    ]);
    expect(
      unread({
        ...readSnapshot,
        watermarkEpoch: "previous",
        watermarkSeq: 100,
        topics: [
          {
            topicKey: "msg:root",
            readUpToSeq: 100,
            readUpToTimestampMs: 4_000,
            readUpToTimelineTimestampMs: 3_000,
            markedUnreadAtMs: null,
            updatedAt: new Date(4_000).toISOString(),
          },
        ],
      }),
    ).toEqual([false, false, true]);
  });

  it("merges fallback-to-main follow-ups into the originating topic without creating duplicate root cards or replies", () => {
    const items: StreamItem[] = [
      makeHumanPrompt({ id: "u-1", messageId: "m-1", text: "Root question", seq: 1, ts: 1_000 }),
      makeAssistantConclusion({ id: "a-1", text: "Initial answer", seq: 2, ts: 2_000 }),
      // Fallback-to-main follow-up landed on main timeline with messageId matching entry.sourceMessageId.
      makeHumanPrompt({
        id: "u-followup",
        messageId: "srv-followup-1",
        text: "@主控 please re-check",
        seq: 3,
        ts: 3_000,
      }),
      makeAssistantConclusion({
        id: "srv-reply-1",
        text: "Re-checked on main",
        seq: 4,
        ts: 4_000,
      }),
    ];
    const threadEntries: TopicThreadEntry[] = [
      {
        entryId: "te-u",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "msg:m-1",
        rootMessageId: "m-1",
        role: "user_followup",
        routedAgentId: "mc-1",
        sourceMessageId: "srv-followup-1",
        text: "@主控 please re-check",
        status: "completed",
        seq: 1,
        createdAt: new Date(3_000).toISOString(),
        updatedAt: new Date(3_000).toISOString(),
      },
      {
        entryId: "te-a",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "msg:m-1",
        rootMessageId: "m-1",
        role: "agent_reply",
        authorAgentId: "mc-1",
        authorTitle: "Main",
        routedAgentId: "mc-1",
        sourceMessageId: "srv-reply-1",
        text: "Re-checked on main",
        status: "completed",
        seq: 2,
        createdAt: new Date(4_000).toISOString(),
        updatedAt: new Date(4_000).toISOString(),
      },
    ];

    const result = projectTopicUnits({ items, threadEntries });
    expect(result.topics).toHaveLength(1);
    expect(result.topics[0]!.topicKey).toBe("msg:m-1");
    // Replies: a-1 (initial conclusion), te-u (followup), te-a (deduplicated mirrored reply) — no duplicate srv-reply-1!
    expect(result.topics[0]!.replies.map((reply) => reply.id)).toEqual([
      "a-1",
      "thread:te-u",
      "thread:te-a",
    ]);
  });

  it("never cross-attaches explicit unmatched refs onto an unrelated latest topic card", () => {
    const items: StreamItem[] = [
      makeHumanPrompt({
        id: "u-new",
        messageId: "m-new",
        text: "Current topic",
        seq: 50,
        ts: 5_000,
      }),
      makeSubagentReport({
        id: "rep-old-out-of-window",
        senderId: "lead-old",
        senderTitle: "Old Lead",
        text: "Report for old out-of-window task",
        taskId: "T-OLD",
        rootMessageId: "m-old",
        seq: 51,
        ts: 5_100,
      }),
    ];
    const threadEntries: TopicThreadEntry[] = [
      {
        entryId: "e-old",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "task:T-OLD",
        taskId: "T-OLD",
        role: "agent_reply",
        routedAgentId: "lead-old",
        text: "Old thread reply",
        status: "completed",
        seq: 1,
        createdAt: new Date(5_200).toISOString(),
        updatedAt: new Date(5_200).toISOString(),
      },
    ];
    const pendingInboxItems: PendingSubagentInboxItem[] = [
      {
        agentId: "lead-old",
        title: "Old Lead",
        event: "finished",
        taskId: "T-OLD",
        rootMessageId: "m-old",
      },
    ];

    const result = projectTopicUnits({ items, threadEntries, pendingInboxItems });
    expect(result.topics).toHaveLength(1);
    expect(result.topics[0]!.topicKey).toBe("msg:m-new");
    expect(result.topics[0]!.replies).toHaveLength(0);
    expect(result.topics[0]!.pendingInboxItems).toHaveLength(0);
    expect(result.unmatchedExplicitRefs.length).toBeGreaterThan(0);
  });

  it("preserves interrupted lifecycle without advertising an unconfirmed root retry", () => {
    const tasks: WorkspaceTaskSummary[] = [
      {
        taskId: "T-cancel",
        title: "Canceled migration",
        tier: "T2",
        status: "canceled",
        participants: [{ agentId: "lead-db" }],
        rootMessageId: "m-cancel",
        leadAgentId: "lead-db",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:01:00.000Z",
      },
    ];
    const items: StreamItem[] = [
      makeHumanPrompt({
        id: "u-cancel",
        messageId: "m-cancel",
        text: "Run DB migration check",
        seq: 1,
        ts: 1_000,
      }),
    ];

    const result = projectTopicUnits({ items, tasks });
    expect(result.topics[0]!.lifecycleStatus).toBe("interrupted");
    expect(result.topics[0]!.retryCandidate).toBeNull();
  });

  it("keeps a same-text independent root when the thread follow-up has a different client ID", () => {
    const result = projectTopicUnits({
      items: [
        makeHumanPrompt({ id: "u-a", messageId: "m-a", text: "Topic A", seq: 1, ts: 1000 }),
        makeHumanPrompt({ id: "u-b", messageId: "m-b", text: "Same text", seq: 2, ts: 2000 }),
        makeHumanPrompt({
          id: "u-mirror",
          messageId: "id-followup",
          text: "Same text",
          seq: 3,
          ts: 2100,
        }),
      ],
      threadEntries: [
        {
          entryId: "followup",
          workspaceId: "ws-1",
          mainAgentId: "mc-1",
          topicKey: "msg:m-a",
          rootMessageId: "m-a",
          sourceMessageId: "id-followup",
          routedAgentId: "mc-1",
          role: "user_followup",
          text: "Same text",
          status: "completed",
          seq: 1,
          createdAt: new Date(2100).toISOString(),
          updatedAt: new Date(2100).toISOString(),
        },
      ],
    });
    expect(result.topics.map((topic) => topic.topicKey)).toEqual(["msg:m-a", "msg:m-b"]);
    expect(result.topics[0]?.replies.map((reply) => reply.id)).toEqual(["thread:followup"]);
  });

  it("deduplicates fallback-to-main replies even when provider omits optional messageId and sourceMessageId", () => {
    const items: StreamItem[] = [
      makeHumanPrompt({
        id: "u-root",
        messageId: "m-root",
        text: "Check billing",
        seq: 1,
        ts: 1_000,
      }),
      {
        kind: "assistant_message",
        id: "original-answer",
        text: "Invoice totals match ledger.",
        timestamp: new Date(4_000),
        timelineCursor: { epoch: "ep-1", seq: 2 },
      },
      // Provider timeline rows without optional messageId matching a fallback-to-main thread turn:
      {
        kind: "user_message",
        id: "local-u-2",
        text: "@主控 verify invoice totals",
        timestamp: new Date(5_000),
        timelineCursor: { epoch: "ep-1", seq: 3 },
      },
      {
        kind: "assistant_message",
        id: "local-a-2",
        text: "Invoice totals match ledger.",
        timestamp: new Date(6_000),
        timelineCursor: { epoch: "ep-1", seq: 4 },
      },
    ];
    const threadEntries: TopicThreadEntry[] = [
      {
        entryId: "te-u-no-src",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "msg:m-root",
        rootMessageId: "m-root",
        role: "user_followup",
        routedAgentId: "mc-1",
        text: "@主控 verify invoice totals",
        status: "completed",
        seq: 1,
        createdAt: new Date(5_000).toISOString(),
        updatedAt: new Date(5_000).toISOString(),
      },
      {
        entryId: "te-a-no-src",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "msg:m-root",
        rootMessageId: "m-root",
        role: "agent_reply",
        authorAgentId: "mc-1",
        authorTitle: "Main",
        routedAgentId: "mc-1",
        text: "Invoice totals match ledger.",
        status: "completed",
        seq: 2,
        createdAt: new Date(6_000).toISOString(),
        updatedAt: new Date(6_000).toISOString(),
      },
    ];

    const result = projectTopicUnits({ items, threadEntries });
    expect(result.topics).toHaveLength(1);
    expect(result.topics[0]!.topicKey).toBe("msg:m-root");
    expect(result.topics[0]!.replies.map((reply) => reply.id)).toEqual([
      "original-answer",
      "thread:te-u-no-src",
      "thread:te-a-no-src",
    ]);

    const repeatedText = makeAssistantConclusion({
      id: "separate-answer",
      text: "Invoice totals match ledger.",
      seq: 4,
      ts: 5_500,
    });
    const exactMirror = projectTopicUnits({
      items: [...items.slice(0, -1), repeatedText, items.at(-1)!],
      threadEntries: [threadEntries[0]!, { ...threadEntries[1]!, sourceMessageId: "local-a-2" }],
    });
    expect(exactMirror.topics[0]!.replies.map(({ id }) => id)).toEqual([
      "original-answer",
      "thread:te-u-no-src",
      "separate-answer",
      "thread:te-a-no-src",
    ]);
  });

  it("recovers from historical error thread entries once a later retry succeeds, and preserves taskless turn_canceled", () => {
    // 1) Historical error entry superseded by a newer completed entry -> recovered (no sticky error).
    const baseItems: StreamItem[] = [
      makeHumanPrompt({ id: "u-err", messageId: "m-err", text: "Run check", seq: 1, ts: 1_000 }),
    ];
    const recoveredEntries: TopicThreadEntry[] = [
      {
        entryId: "te-old-err",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "msg:m-err",
        role: "agent_reply",
        routedAgentId: "lead-1",
        text: "Timed out",
        status: "error",
        seq: 1,
        createdAt: new Date(2_000).toISOString(),
        updatedAt: new Date(2_000).toISOString(),
      },
      {
        entryId: "te-new-ok",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "msg:m-err",
        role: "agent_reply",
        routedAgentId: "lead-1",
        text: "Retry succeeded",
        status: "completed",
        seq: 2,
        createdAt: new Date(4_000).toISOString(),
        updatedAt: new Date(4_000).toISOString(),
      },
    ];
    const recovered = projectTopicUnits({
      items: baseItems,
      threadEntries: recoveredEntries,
      readSnapshot: {
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        watermarkEpoch: "ep-1",
        watermarkSeq: 1,
        watermarkTimestampMs: 4_000,
        topics: [],
        revision: 1,
      },
    });
    expect(recovered.topics[0]!.lifecycleStatus).toBe("settled");
    expect(recovered.topics[0]!.retryCandidate).toBeNull();
    const failedFollowup = {
      ...recoveredEntries[0]!,
      role: "user_followup" as const,
      sourceMessageId: "used-message-id",
      text: "Retry my follow-up",
      retryable: true,
    };
    const failed = projectTopicUnits({ items: baseItems, threadEntries: [failedFollowup] });
    expect(failed.topics[0]!.retryCandidate).toMatchObject({
      text: "Retry my follow-up",
      entryId: "te-old-err",
    });

    // 2) Legacy taskless main turn canceled via reduceStreamUpdate -> projected as interrupted!
    let stream: StreamItem[] = [];
    stream = reduceStreamUpdate(
      stream,
      {
        type: "timeline",
        provider: "claude",
        turnId: "turn-legacy-1",
        item: { type: "user_message", messageId: "m-legacy", text: "Explain trace" },
      },
      new Date(10_000),
    );
    stream = reduceStreamUpdate(
      stream,
      { type: "turn_canceled", provider: "claude", turnId: "turn-legacy-1", reason: "canceled" },
      new Date(11_000),
    );
    const canceledProjection = projectTopicUnits({ items: stream });
    expect(canceledProjection.topics[0]!.lifecycleStatus).toBe("interrupted");
    expect(canceledProjection.topics[0]!.retryCandidate).toBeNull();
  });

  it("maps task-scoped pending inbox items, todos, and durable items onto their topic card", () => {
    const tasks: WorkspaceTaskSummary[] = [
      {
        taskId: "T-agg",
        title: "Parallel build",
        tier: "T2",
        status: "in_progress",
        participants: [{ agentId: "lead-a" }],
        rootMessageId: "m-agg",
        leadAgentId: "lead-a",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
    ];
    const items: StreamItem[] = [
      makeHumanPrompt({
        id: "u-agg",
        messageId: "m-agg",
        text: "Run parallel checks",
        seq: 1,
        ts: 1000,
      }),
    ];
    const pendingInboxItems: PendingSubagentInboxItem[] = [
      {
        agentId: "lead-a",
        title: "Lead A",
        event: "finished",
        reportStatus: "completed",
        taskId: "T-agg",
        rootMessageId: "m-agg",
      },
    ];
    const todos: WorkspaceTodoItem[] = [
      {
        todoId: "todo-1",
        workspaceId: "ws-1",
        title: "Verify canary",
        status: "pending",
        checklist: [],
        dueAt: "2026-06-02T10:00:00.000Z",
        remindBeforeMinutes: 15,
        snoozedUntil: null,
        lastDueNotifiedAt: null,
        source: {
          mainAgentId: "mc-1",
          topicKey: "task:T-agg",
          taskId: "T-agg",
          topicTitlePreview: "Run parallel checks",
        },
        assignedAgentId: null,
        revision: 1,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        completedAt: null,
      },
    ];
    const durableItems: WorkspaceDurableItem[] = [
      {
        workspaceId: "ws-1",
        requestId: "req-1",
        sourceAgentId: "lead-a",
        sourceTurnId: "turn-1",
        kind: "acceptance",
        title: "Approve release",
        evidence: [],
        createdAt: "2026-06-01T00:00:00.000Z",
        revision: 1,
        status: "pending",
      },
    ];

    const result = projectTopicUnits({
      items,
      tasks,
      pendingInboxItems,
      todos,
      durableItems,
    });
    const topic = result.topics[0]!;
    expect(topic.pendingInboxItems).toHaveLength(1);
    expect(topic.linkedTodos).toHaveLength(1);
    expect(topic.linkedDurableItems).toHaveLength(1);
    // Pending durable item elevates status to blocked so approvals are never buried.
    expect(topic.lifecycleStatus).toBe("blocked");
  });

  it("restores full historical topic cards from topicAnchors after reset_agent_session empties the main timeline", () => {
    const topicAnchors: TopicAnchorSummary[] = [
      {
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "task:T-hist",
        taskId: "T-hist",
        rootMessageId: "m-hist",
        rootPromptText: "Refactor payment webhook retries",
        title: "Payment webhook retries",
        leadAgentId: "lead-pay",
        leadTitle: "Payments Lead",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:05:00.000Z",
      },
    ];
    const tasks: WorkspaceTaskSummary[] = [
      {
        taskId: "T-hist",
        title: "Payment webhook retries",
        tier: "T2",
        status: "completed",
        participants: [{ agentId: "lead-pay" }],
        rootMessageId: "m-hist",
        leadAgentId: "lead-pay",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:05:00.000Z",
      },
    ];
    const threadEntries: TopicThreadEntry[] = [
      {
        entryId: "te-hist-1",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "task:T-hist",
        taskId: "T-hist",
        rootMessageId: "m-hist",
        role: "agent_reply",
        origin: "subagent_report",
        reportStatus: "completed",
        authorAgentId: "lead-pay",
        authorTitle: "Payments Lead",
        routedAgentId: "lead-pay",
        text: "Added exponential backoff with jitter and verified webhook tests.",
        status: "completed",
        seq: 1,
        createdAt: "2026-06-01T00:04:00.000Z",
        updatedAt: "2026-06-01T00:04:00.000Z",
      },
    ];

    const result = projectTopicUnits({
      items: [],
      tasks,
      threadEntries,
      topicAnchors,
    });
    expect(result.unmatchedExplicitRefs).toHaveLength(0);
    expect(result.topics).toHaveLength(1);
    expect(result.topics[0]!.topicKey).toBe("task:T-hist");
    expect(result.topics[0]!.rootPrompt.text).toBe("Refactor payment webhook retries");
    expect(result.topics[0]!.leadAgentId).toBe("lead-pay");
    expect(result.topics[0]!.leadTitle).toBe("Payments Lead");
    expect(result.topics[0]!.replies).toHaveLength(1);
    expect(result.topics[0]!.replies[0]!.kind).toBe("thread_entry");
  });

  it("attaches resident specialist DurableItems to explicit topic refs or the latest participating topic instead of the oldest card", () => {
    const tasks: WorkspaceTaskSummary[] = [
      {
        taskId: "T-old",
        title: "Old topic",
        tier: "T1",
        status: "completed",
        participants: [{ agentId: "resident-qa" }],
        rootMessageId: "m-old",
        leadAgentId: "resident-qa",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:01:00.000Z",
      },
      {
        taskId: "T-new",
        title: "New topic",
        tier: "T2",
        status: "in_progress",
        participants: [{ agentId: "resident-qa" }],
        rootMessageId: "m-new",
        leadAgentId: "resident-qa",
        createdAt: "2026-06-01T00:10:00.000Z",
        updatedAt: "2026-06-01T00:11:00.000Z",
      },
    ];
    const items: StreamItem[] = [
      makeHumanPrompt({ id: "u-old", messageId: "m-old", text: "Old QA run", seq: 1, ts: 1_000 }),
      makeHumanPrompt({ id: "u-new", messageId: "m-new", text: "New QA run", seq: 2, ts: 2_000 }),
    ];
    const durableItems: WorkspaceDurableItem[] = [
      {
        workspaceId: "ws-1",
        requestId: "req-legacy",
        sourceAgentId: "resident-qa",
        sourceTurnId: "turn-new",
        kind: "acceptance",
        title: "Approve latest QA deliverable",
        evidence: [],
        createdAt: "2026-06-01T00:12:00.000Z",
        revision: 1,
        status: "pending",
      },
      {
        workspaceId: "ws-1",
        requestId: "req-explicit-old",
        sourceAgentId: "resident-qa",
        sourceTurnId: "turn-old",
        taskId: "T-old",
        topicKey: "task:T-old",
        kind: "decision",
        title: "Explicitly scoped to old topic",
        evidence: [],
        createdAt: "2026-06-01T00:02:00.000Z",
        revision: 1,
        status: "pending",
      },
    ];

    const result = projectTopicUnits({ items, tasks, durableItems });
    expect(result.topics[0]!.topicKey).toBe("task:T-old");
    expect(result.topics[0]!.linkedDurableItems.map((d) => d.requestId)).toEqual([
      "req-explicit-old",
    ]);
    expect(result.topics[0]!.activeBlockingPrompt).toEqual({
      kind: "durable_item",
      item: durableItems[1],
      canDecideInTopic: true,
    });
    expect(result.topics[1]!.topicKey).toBe("task:T-new");
    expect(result.topics[1]!.linkedDurableItems.map((d) => d.requestId)).toEqual(["req-legacy"]);
    expect(result.topics[1]!.activeBlockingPrompt).toEqual({
      kind: "durable_item",
      item: durableItems[0],
      canDecideInTopic: false,
    });
    expect(canDecideDurableItemInTopic(durableItems[0]!, "T-new")).toBe(false);
    expect(canDecideDurableItemInTopic(durableItems[1]!, "T-old")).toBe(true);
    expect(
      canDecideDurableItemInTopic({ ...durableItems[1]!, kind: "authorization" }, "T-old"),
    ).toBe(false);
  });

  it("deduplicates subagent_report thread entries when main timeline already contains the same sourceMessageId", () => {
    const tasks: WorkspaceTaskSummary[] = [
      {
        taskId: "T-dup",
        title: "Multi-track merge",
        tier: "T2",
        status: "in_progress",
        participants: [{ agentId: "lead-1" }],
        rootMessageId: "m-dup",
        leadAgentId: "lead-1",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
    ];
    const items: StreamItem[] = [
      makeHumanPrompt({ id: "u-dup", messageId: "m-dup", text: "Merge tracks", seq: 1, ts: 1_000 }),
      makeSubagentReport({
        id: "msg-report-1",
        senderId: "lead-1",
        senderTitle: "Lead 1",
        text: "Track A finished",
        taskId: "T-dup",
        rootMessageId: "m-dup",
        reportStatus: "completed",
        seq: 2,
        ts: 2_000,
      }),
    ];
    const threadEntries: TopicThreadEntry[] = [
      {
        entryId: "te-dup-1",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "task:T-dup",
        taskId: "T-dup",
        role: "agent_reply",
        origin: "subagent_report",
        reportStatus: "completed",
        sourceMessageId: "msg-report-1",
        authorAgentId: "lead-1",
        authorTitle: "Lead 1",
        routedAgentId: "lead-1",
        text: "Track A finished",
        status: "completed",
        seq: 1,
        createdAt: new Date(2_000).toISOString(),
        updatedAt: new Date(2_000).toISOString(),
      },
      {
        entryId: "te-silent-2",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "task:T-dup",
        taskId: "T-dup",
        role: "agent_reply",
        origin: "subagent_report",
        reportStatus: "completed",
        sourceMessageId: "msg-silent-only",
        authorAgentId: "lead-1",
        authorTitle: "Lead 1",
        routedAgentId: "lead-1",
        text: "Silent completion report",
        status: "completed",
        seq: 2,
        createdAt: new Date(3_000).toISOString(),
        updatedAt: new Date(3_000).toISOString(),
      },
    ];

    const result = projectTopicUnits({ items, tasks, threadEntries });
    expect(result.topics[0]!.replies.map((reply) => reply.id)).toEqual([
      "msg-report-1",
      "thread:te-silent-2",
    ]);
  });

  it("projects fileConflicts for active tasks only, suppresses them for completed tasks, and extracts quick options for blockingQuestion", () => {
    const conflict = {
      path: "packages/app/src/panels/agent-panel.tsx",
      peers: [
        {
          taskId: "T-peer",
          title: "Composer layout tweak",
          leadAgentId: "lead-2",
          leadTitle: "UI Lead",
          status: "in_progress",
        },
      ],
    };
    const tasks: WorkspaceTaskSummary[] = [
      {
        taskId: "T-active",
        title: "Active conflict topic",
        tier: "T2",
        status: "awaiting_decision",
        participants: [{ agentId: "lead-1" }],
        rootMessageId: "m-active",
        leadAgentId: "lead-1",
        blockingQuestion:
          "Choose migration strategy:\n1. Keep legacy column\n2. Drop legacy column",
        fileConflicts: [conflict],
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:01:00.000Z",
      },
      {
        taskId: "T-done",
        title: "Completed topic",
        tier: "T1",
        status: "completed",
        participants: [{ agentId: "lead-3" }],
        rootMessageId: "m-done",
        leadAgentId: "lead-3",
        fileConflicts: [conflict],
        createdAt: "2026-06-01T00:02:00.000Z",
        updatedAt: "2026-06-01T00:03:00.000Z",
      },
    ];
    const items: StreamItem[] = [
      makeHumanPrompt({ id: "u-a", messageId: "m-active", text: "Migrate DB", seq: 1, ts: 1_000 }),
      makeHumanPrompt({ id: "u-d", messageId: "m-done", text: "Already done", seq: 2, ts: 2_000 }),
    ];

    const result = projectTopicUnits({ items, tasks });
    expect(result.topics[0]!.fileConflicts).toEqual([conflict]);
    expect(result.topics[0]!.lifecycleStatus).toBe("blocked");
    expect(result.topics[0]!.activeBlockingPrompt).toEqual({
      kind: "task_blocking_question",
      taskId: "T-active",
      question: "Choose migration strategy:\n1. Keep legacy column\n2. Drop legacy column",
      blockingQuestionGeneration: undefined,
      options: ["Keep legacy column", "Drop legacy column"],
    });
    expect(result.topics[1]!.fileConflicts).toEqual([]);
    expect(result.topics[1]!.activeBlockingPrompt).toBeNull();
    expect(extractQuickReplyOptions("Only a plain question without bullets?")).toEqual([]);
  });

  it("isolates multiple sibling tasks under the same rootMessageId across live anchor cache and cold-load projection", () => {
    const genA = "11111111-1111-4111-8111-111111111111";
    const genB = "22222222-2222-4222-8222-222222222222";
    const msgAnchor: TopicAnchorSummary = {
      workspaceId: "ws-1",
      mainAgentId: "mc-1",
      topicKey: "msg:m-shared",
      rootMessageId: "m-shared",
      rootPromptText: "Ship API and UI changes in parallel",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const anchorA: TopicAnchorSummary = {
      workspaceId: "ws-1",
      mainAgentId: "mc-1",
      topicKey: "task:T-A",
      taskId: "T-A",
      rootMessageId: "m-shared",
      rootPromptText: "Ship API and UI changes in parallel",
      title: "API track",
      leadAgentId: "lead-api",
      leadTitle: "API Lead",
      createdAt: "2026-06-01T00:00:01.000Z",
      updatedAt: "2026-06-01T00:00:01.000Z",
    };
    const anchorB: TopicAnchorSummary = {
      workspaceId: "ws-1",
      mainAgentId: "mc-1",
      topicKey: "task:T-B",
      taskId: "T-B",
      rootMessageId: "m-shared",
      rootPromptText: "",
      title: "UI track",
      leadAgentId: "lead-ui",
      leadTitle: "UI Lead",
      createdAt: "2026-06-01T00:00:02.000Z",
      updatedAt: "2026-06-01T00:00:02.000Z",
    };

    // Live cache path: msg:m-shared migrates to task:T-A, task:T-B stays isolated and borrows prompt text,
    // and a late msg:m-shared refresh never collapses or duplicates cards.
    let anchors = upsertTopicAnchor([], msgAnchor);
    anchors = upsertTopicAnchor(anchors, anchorA);
    anchors = upsertTopicAnchor(anchors, anchorB);
    anchors = upsertTopicAnchor(anchors, msgAnchor);
    expect(anchors.map((a) => a.topicKey)).toEqual(["task:T-A", "task:T-B"]);
    expect(anchors[1]!.rootPromptText).toBe("Ship API and UI changes in parallel");

    const tasks: WorkspaceTaskSummary[] = [
      {
        taskId: "T-A",
        title: "API track",
        tier: "T2",
        status: "awaiting_decision",
        participants: [{ agentId: "lead-api" }],
        rootMessageId: "m-shared",
        leadAgentId: "lead-api",
        blockingQuestion: "Approve API v2?",
        blockingQuestionGeneration: genA,
        createdAt: "2026-06-01T00:00:01.000Z",
        updatedAt: "2026-06-01T00:00:05.000Z",
      },
      {
        taskId: "T-B",
        title: "UI track",
        tier: "T2",
        status: "awaiting_decision",
        participants: [{ agentId: "lead-ui" }],
        rootMessageId: "m-shared",
        leadAgentId: "lead-ui",
        blockingQuestion: "Approve UI theme?",
        blockingQuestionGeneration: genB,
        createdAt: "2026-06-01T00:00:02.000Z",
        updatedAt: "2026-06-01T00:00:06.000Z",
      },
    ];
    const items: StreamItem[] = [
      makeHumanPrompt({
        id: "u-shared",
        messageId: "m-shared",
        text: "Ship API and UI changes in parallel",
        seq: 1,
        ts: 1_000,
      }),
      makeSubagentReport({
        id: "rep-a",
        senderId: "lead-api",
        senderTitle: "API Lead",
        text: "API update",
        taskId: "T-A",
        rootMessageId: "m-shared",
        seq: 2,
        ts: 2_000,
      }),
      makeSubagentReport({
        id: "rep-b",
        senderId: "lead-ui",
        senderTitle: "UI Lead",
        text: "UI update",
        taskId: "T-B",
        rootMessageId: "m-shared",
        seq: 3,
        ts: 3_000,
      }),
    ];

    // 1) Cold load WITH anchors + live timeline items: both cards stay distinct and keep independent replies.
    const withAnchors = projectTopicUnits({ items, tasks, topicAnchors: anchors });
    expect(withAnchors.topics.map((t) => t.topicKey)).toEqual(["task:T-A", "task:T-B"]);
    expect(withAnchors.topics[0]!.replies.map((r) => r.id)).toEqual(["rep-a"]);
    expect(withAnchors.topics[1]!.replies.map((r) => r.id)).toEqual(["rep-b"]);
    expect(withAnchors.topics[0]!.activeBlockingPrompt).toMatchObject({
      kind: "task_blocking_question",
      taskId: "T-A",
      blockingQuestionGeneration: genA,
    });
    expect(withAnchors.topics[1]!.activeBlockingPrompt).toMatchObject({
      kind: "task_blocking_question",
      taskId: "T-B",
      blockingQuestionGeneration: genB,
    });

    // 2) Cold load WITHOUT anchors (items + tasks only): still projects both sibling task cards cleanly!
    const withoutAnchors = projectTopicUnits({ items, tasks });
    expect(withoutAnchors.topics.map((t) => t.topicKey)).toEqual(["task:T-A", "task:T-B"]);
    expect(withoutAnchors.topics[0]!.replies.map((r) => r.id)).toEqual(["rep-a"]);
    expect(withoutAnchors.topics[1]!.replies.map((r) => r.id)).toEqual(["rep-b"]);

    // 3) Reset timeline (items: []) with [msg:m-shared, task:T-A, task:T-B] anchors: msg: migrates only once.
    const resetLoad = projectTopicUnits({
      items: [],
      tasks,
      topicAnchors: [msgAnchor, anchorA, anchorB],
    });
    expect(resetLoad.topics.map((t) => t.topicKey)).toEqual(["task:T-A", "task:T-B"]);
  });

  it("attributes replies accurately on cold load after backfilling task A then task B with retained msg: entries", () => {
    const msgAnchor: TopicAnchorSummary = {
      workspaceId: "ws-1",
      mainAgentId: "mc-1",
      topicKey: "msg:m-shared",
      rootMessageId: "m-shared",
      rootPromptText: "Run backend and frontend tracks",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const anchorA: TopicAnchorSummary = {
      workspaceId: "ws-1",
      mainAgentId: "mc-1",
      topicKey: "task:T-A",
      taskId: "T-A",
      rootMessageId: "m-shared",
      rootPromptText: "Run backend and frontend tracks",
      title: "Track A",
      leadAgentId: "lead-a",
      createdAt: "2026-06-01T00:00:01.000Z",
      updatedAt: "2026-06-01T00:00:01.000Z",
    };
    const anchorB: TopicAnchorSummary = {
      workspaceId: "ws-1",
      mainAgentId: "mc-1",
      topicKey: "task:T-B",
      taskId: "T-B",
      rootMessageId: "m-shared",
      rootPromptText: "Run backend and frontend tracks",
      title: "Track B",
      leadAgentId: "lead-b",
      createdAt: "2026-06-01T00:00:02.000Z",
      updatedAt: "2026-06-01T00:00:02.000Z",
    };

    // Simulate backend backfill order: msg:m-shared -> backfill A -> backfill B.
    let anchors = upsertTopicAnchor([], msgAnchor);
    anchors = upsertTopicAnchor(anchors, anchorA);
    anchors = upsertTopicAnchor(anchors, anchorB);

    const tasks: WorkspaceTaskSummary[] = [
      {
        taskId: "T-A",
        title: "Track A",
        tier: "T2",
        status: "in_progress",
        participants: [{ agentId: "lead-a" }],
        rootMessageId: "m-shared",
        leadAgentId: "lead-a",
        createdAt: "2026-06-01T00:00:01.000Z",
        updatedAt: "2026-06-01T00:00:04.000Z",
      },
      {
        taskId: "T-B",
        title: "Track B",
        tier: "T2",
        status: "in_progress",
        participants: [{ agentId: "lead-b" }],
        rootMessageId: "m-shared",
        leadAgentId: "lead-b",
        createdAt: "2026-06-01T00:00:02.000Z",
        updatedAt: "2026-06-01T00:00:05.000Z",
      },
    ];

    const threadEntries: TopicThreadEntry[] = [
      {
        entryId: "e-a-promoted",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "task:T-A",
        taskId: "T-A",
        rootMessageId: "m-shared",
        seq: 1,
        role: "agent_reply",
        origin: "subagent_report",
        routedAgentId: "lead-a",
        authorAgentId: "lead-a",
        authorTitle: "Lead A",
        text: "Track A progress",
        status: "completed",
        createdAt: "2026-06-01T00:00:03.000Z",
        updatedAt: "2026-06-01T00:00:03.000Z",
      },
      {
        // Legacy msg: topicKey carrying explicit taskId: T-B (must stay attributed to T-B even after A backfilled first).
        entryId: "e-b-legacy-msg-key",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "msg:m-shared",
        taskId: "T-B",
        rootMessageId: "m-shared",
        seq: 2,
        role: "agent_reply",
        origin: "subagent_report",
        routedAgentId: "lead-b",
        authorAgentId: "lead-b",
        authorTitle: "Lead B",
        text: "Track B early update",
        status: "completed",
        createdAt: "2026-06-01T00:00:04.000Z",
        updatedAt: "2026-06-01T00:00:04.000Z",
      },
      {
        entryId: "e-b-promoted",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "task:T-B",
        taskId: "T-B",
        rootMessageId: "m-shared",
        seq: 3,
        role: "agent_reply",
        origin: "topic_reply",
        routedAgentId: "lead-b",
        authorAgentId: "lead-b",
        authorTitle: "Lead B",
        text: "Track B promoted update",
        status: "completed",
        createdAt: "2026-06-01T00:00:05.000Z",
        updatedAt: "2026-06-01T00:00:05.000Z",
      },
      {
        // Ambiguous entry without taskId whose msg: reference was retained by backend store.ts.
        entryId: "e-msg-retained",
        workspaceId: "ws-1",
        mainAgentId: "mc-1",
        topicKey: "msg:m-shared",
        rootMessageId: "m-shared",
        seq: 4,
        role: "user_followup",
        origin: "topic_reply",
        routedAgentId: "mc-1",
        authorTitle: "User",
        text: "General follow-up before split",
        status: "completed",
        createdAt: "2026-06-01T00:00:06.000Z",
        updatedAt: "2026-06-01T00:00:06.000Z",
      },
    ];

    const liveItems: StreamItem[] = [
      makeHumanPrompt({
        id: "u-shared",
        messageId: "m-shared",
        text: "Run backend and frontend tracks",
        seq: 1,
        ts: 1_000,
      }),
    ];

    for (const items of [liveItems, [] as StreamItem[]]) {
      const projected = projectTopicUnits({
        items,
        tasks,
        topicAnchors: anchors,
        threadEntries,
      });
      expect(projected.topics.map((t) => t.topicKey)).toEqual(["task:T-A", "task:T-B"]);
      expect(projected.unmatchedExplicitRefs).toEqual([]);
      expect(projected.topics[0]!.replies.map((r) => r.id)).toEqual([
        "thread:e-a-promoted",
        "thread:e-msg-retained",
      ]);
      expect(projected.topics[1]!.replies.map((r) => r.id)).toEqual([
        "thread:e-b-legacy-msg-key",
        "thread:e-b-promoted",
      ]);
    }
  });
});
