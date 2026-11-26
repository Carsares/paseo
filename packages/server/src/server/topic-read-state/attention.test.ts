import type { TopicThreadEntry, WorkspaceTopicReadSnapshot } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import type { WorkspaceTask } from "../agent/task-ledger/index.js";
import type { ProjectedTimelineRow } from "../agent/timeline-projection.js";
import { coversFinishedAttention } from "./attention.js";

const epoch = "timeline-epoch";
const workspaceId = "workspace";
const mainAgentId = "main";
const start = Date.parse("2026-11-26T12:00:00.000Z");

function timestamp(seq: number) {
  return new Date(start + seq).toISOString();
}

function row(
  seq: number,
  item: ProjectedTimelineRow["item"],
  turnId?: string,
): ProjectedTimelineRow {
  return {
    seq,
    seqStart: seq,
    seqEnd: seq,
    sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
    collapsed: ["identity"],
    timestamp: timestamp(seq),
    item,
    turnId,
  };
}

function report(
  seq: number,
  refs: { taskId?: string; rootMessageId?: string },
  turnId?: string,
): ProjectedTimelineRow {
  return row(
    seq,
    {
      type: "tool_call",
      callId: `paseo-agent-message:report-${seq}`,
      name: "agent_message",
      status: "completed",
      error: null,
      detail: { type: "plain_text", text: "Specialist report" },
      agentMessage: { event: "message", sender: { id: "specialist" }, text: "Done", ...refs },
    },
    turnId,
  );
}

function task(taskId: string, rootMessageId: string): WorkspaceTask {
  return {
    taskId,
    rootMessageId,
    title: taskId,
    tier: "T1",
    status: "completed",
    participants: [],
    createdAt: timestamp(0),
    updatedAt: timestamp(0),
  };
}

function snapshot(
  readByTopic: Record<string, number>,
  watermarkSeq = -1,
): WorkspaceTopicReadSnapshot {
  return {
    workspaceId,
    mainAgentId,
    watermarkEpoch: epoch,
    watermarkSeq,
    watermarkTimestampMs: watermarkSeq < 0 ? 0 : start + watermarkSeq,
    revision: 1,
    topics: Object.entries(readByTopic).map(([topicKey, seq]) => ({
      topicKey,
      readUpToSeq: seq,
      readUpToTimestampMs: start + seq,
      markedUnreadAtMs: null,
      updatedAt: timestamp(seq),
    })),
  };
}

describe("coversFinishedAttention", () => {
  it("clears only when both cards cover their own conclusions after A reports during B's turn", () => {
    const input = {
      epoch,
      tasks: [task("A", "request-a"), task("B", "request-b")],
      thread: [],
      rows: [
        row(1, { type: "user_message", text: "Start A", clientMessageId: "request-a" }, "turn-a"),
        row(2, { type: "assistant_message", text: "A is underway" }, "turn-a"),
        row(3, { type: "user_message", text: "Start B", clientMessageId: "request-b" }, "turn-b"),
        report(4, { taskId: "A", rootMessageId: "request-a" }, "turn-b"),
        row(5, { type: "assistant_message", text: "B is done" }, "turn-b"),
      ],
      attentionAt: start + 5,
      completedTurnId: "turn-b",
    };

    expect(
      coversFinishedAttention({ ...input, snapshot: snapshot({ "task:A": 2, "task:B": 5 }) }),
    ).toBe(false);
    expect(
      coversFinishedAttention({ ...input, snapshot: snapshot({ "task:A": 4, "task:B": 3 }) }),
    ).toBe(false);
    expect(
      coversFinishedAttention({ ...input, snapshot: snapshot({ "task:A": 4, "task:B": 5 }) }),
    ).toBe(true);
  });

  it("covers a late assistant conclusion using the original prompt's turn", () => {
    const input = {
      epoch,
      tasks: [],
      thread: [],
      rows: [
        row(1, { type: "user_message", text: "Start A", messageId: "request-a" }, "turn-a"),
        row(2, { type: "user_message", text: "Start B", messageId: "request-b" }, "turn-b"),
        row(3, { type: "assistant_message", text: "B is done" }, "turn-b"),
        row(4, { type: "assistant_message", text: "A is done" }, "turn-a"),
      ],
      attentionAt: start + 4,
      completedTurnId: "turn-a",
    };

    expect(coversFinishedAttention({ ...input, snapshot: snapshot({ "msg:request-b": 4 }) })).toBe(
      false,
    );
    expect(
      coversFinishedAttention({
        ...input,
        snapshot: snapshot({ "msg:request-a": 4, "msg:request-b": 3 }),
      }),
    ).toBe(true);
  });

  it.each([
    {},
    { taskId: "unknown-task" },
    { rootMessageId: "unknown-root" },
    { taskId: "B", rootMessageId: "request-a" },
    { taskId: "B", rootMessageId: "unknown-root" },
    { taskId: "unknown-task", rootMessageId: "request-b" },
  ])("requires workspace read coverage for an unbound report with refs %j", (refs) => {
    const input = {
      epoch,
      tasks: [task("A", "request-a"), task("B", "request-b")],
      thread: [],
      rows: [
        row(1, { type: "user_message", text: "Start B", messageId: "request-b" }, "turn-b"),
        report(2, refs, "turn-b"),
        row(3, { type: "assistant_message", text: "B is done" }, "turn-b"),
      ],
      attentionAt: start + 3,
      completedTurnId: "turn-b",
    };

    expect(coversFinishedAttention({ ...input, snapshot: snapshot({ "task:B": 3 }) })).toBe(false);
    expect(coversFinishedAttention({ ...input, snapshot: snapshot({ "task:B": 3 }, 2) })).toBe(
      true,
    );
  });

  it("uses the ledger for root-only reports even when the prompt is absent", () => {
    expect(
      coversFinishedAttention({
        epoch,
        tasks: [task("A", "request-a")],
        thread: [],
        rows: [report(4, { rootMessageId: "request-a" })],
        attentionAt: start + 4,
        snapshot: snapshot({ "task:A": 4 }),
      }),
    ).toBe(true);
  });

  it("keeps a late root alias independent of the current turn", () => {
    const input = {
      epoch,
      tasks: [task("A", "request-a"), task("B", "request-b")],
      thread: [],
      rows: [
        row(1, { type: "user_message", text: "Start B", messageId: "request-b" }, "turn-b"),
        report(2, { rootMessageId: "provider-a" }, "turn-b"),
        {
          ...row(3, { type: "user_message", text: "Start A", messageId: "request-a" }, "turn-a"),
          providerMessageId: "provider-a",
        },
      ],
      attentionAt: start + 3,
      completedTurnId: "turn-b",
    };
    expect(coversFinishedAttention({ ...input, snapshot: snapshot({ "task:B": 3 }) })).toBe(false);
    expect(coversFinishedAttention({ ...input, snapshot: snapshot({ "task:A": 2 }) })).toBe(false);
    expect(coversFinishedAttention({ ...input, snapshot: snapshot({ "task:A": 3 }) })).toBe(true);
  });

  it("keeps legacy prompts and mirrored follow-up conclusions on their cards", () => {
    const followup: TopicThreadEntry = {
      workspaceId,
      mainAgentId,
      topicKey: "msg:legacy-a",
      taskId: "legacy-task",
      rootMessageId: "legacy-a",
      entryId: "followup",
      role: "user_followup",
      routedAgentId: mainAgentId,
      text: "Follow up on A",
      sourceMessageId: "followup-prompt",
      status: "completed",
      seq: 1,
      createdAt: timestamp(4),
      updatedAt: timestamp(4),
    };
    const reply: TopicThreadEntry = {
      ...followup,
      entryId: "reply",
      role: "agent_reply",
      text: "Follow-up done",
      sourceMessageId: "followup-reply",
      seq: 2,
      createdAt: timestamp(6),
      updatedAt: timestamp(6),
    };
    const input = {
      epoch,
      tasks: [],
      thread: [followup, reply],
      rows: [
        row(1, { type: "user_message", text: "Start A", messageId: "legacy-a" }),
        row(2, { type: "assistant_message", text: "Initial A conclusion" }),
        row(3, { type: "user_message", text: "Start B", messageId: "legacy-b" }),
        row(4, { type: "user_message", text: "Follow up", clientMessageId: "followup-prompt" }),
        report(5, { taskId: "legacy-task" }),
        row(6, { type: "assistant_message", text: "Follow-up progress" }),
        {
          ...row(7, { type: "assistant_message", text: "Mirrored reply" }),
          providerMessageId: "followup-reply",
        },
      ],
      attentionAt: start + 6,
    };

    expect(coversFinishedAttention({ ...input, snapshot: snapshot({ "msg:legacy-a": 5 }) })).toBe(
      false,
    );
    expect(coversFinishedAttention({ ...input, snapshot: snapshot({ "msg:legacy-a": 6 }) })).toBe(
      true,
    );
    const conflictingInput = {
      ...input,
      thread: [followup, reply, { ...followup, entryId: "conflict", topicKey: "msg:legacy-b" }],
      rows: [report(5, { taskId: "legacy-task" })],
    };
    expect(
      coversFinishedAttention({
        ...conflictingInput,
        snapshot: snapshot({ "msg:legacy-a": 6, "msg:legacy-b": 6 }),
      }),
    ).toBe(false);
    expect(
      coversFinishedAttention({
        ...conflictingInput,
        snapshot: snapshot({ "msg:legacy-a": 6 }, 5),
      }),
    ).toBe(true);
  });

  it("uses the upgraded task key and a synthetic mirror without requiring the hidden timeline row", () => {
    const followup: TopicThreadEntry = {
      workspaceId,
      mainAgentId,
      topicKey: "msg:request-a",
      rootMessageId: "request-a",
      entryId: "followup",
      role: "user_followup",
      routedAgentId: mainAgentId,
      text: "Follow up on A",
      sourceMessageId: "followup-prompt",
      status: "completed",
      seq: 1,
      createdAt: timestamp(3),
      updatedAt: timestamp(3),
    };
    const input = {
      epoch,
      tasks: [task("A", "request-a")],
      thread: [
        {
          ...followup,
          entryId: "reply",
          role: "agent_reply" as const,
          text: "Done",
          sourceMessageId: "topic-reply:followup",
          seq: 2,
          createdAt: timestamp(5),
          updatedAt: timestamp(5),
        },
        followup,
      ],
      rows: [
        row(1, { type: "user_message", text: "Start A", messageId: "request-a" }, "first"),
        row(2, { type: "assistant_message", text: "Done" }, "first"),
        row(
          3,
          { type: "user_message", text: "Follow up on A", clientMessageId: "followup-prompt" },
          "retry",
        ),
        row(4, { type: "assistant_message", text: "Done" }, "retry"),
      ],
      attentionAt: start + 4,
      completedTurnId: "retry",
    };
    const mark = snapshot({ "task:A": 2 });
    const readReply = {
      ...mark,
      topics: mark.topics.map((topic) => ({ ...topic, readUpToTimestampMs: start + 5 })),
    };
    expect(coversFinishedAttention({ ...input, snapshot: mark })).toBe(false);
    expect(coversFinishedAttention({ ...input, snapshot: readReply })).toBe(true);
  });
});
