import { describe, expect, it } from "vitest";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { buildTimelinePromptIndex } from "./timeline-prompt-index.js";

describe("buildTimelinePromptIndex", () => {
  it("indexes every canonical user prompt with a stable timeline position", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 3,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "user_message", text: "  First\n\n   prompt  " },
      },
      {
        seq: 4,
        timestamp: "2026-01-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "response" },
      },
      {
        seq: 8,
        timestamp: "2026-01-01T00:00:02.000Z",
        item: { type: "user_message", text: "Second prompt" },
      },
    ];

    expect(buildTimelinePromptIndex("epoch-1", rows)).toEqual({
      epoch: "epoch-1",
      previewsAreDisplayText: true,
      prompts: [
        { seq: 3, timestamp: "2026-01-01T00:00:00.000Z", preview: "First prompt" },
        { seq: 8, timestamp: "2026-01-01T00:00:02.000Z", preview: "Second prompt" },
      ],
    });
  });

  it("bounds previews without indexing assistant rows", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "user_message", text: "x".repeat(200) },
      },
      {
        seq: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "ignored" },
      },
    ];

    const result = buildTimelinePromptIndex("epoch-1", rows);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]?.preview).toHaveLength(120);
    expect(result.prompts[0]?.preview.endsWith("…")).toBe(true);
  });

  it("spends the entire preview budget on the question after a routed topic envelope", () => {
    const question = `What is next? ${"x".repeat(120)}`;
    const timestamp = "2026-01-01T00:00:00.000Z";
    const rows: AgentTimelineRow[] = [
      {
        seq: 2,
        timestamp,
        topicKey: "task:task&1",
        rootMessageId: "root",
        item: {
          type: "user_message",
          clientMessageId: "followup",
          text:
            '<paseo-topic-context task-id="task&#38;1" root-message-id="root">\n' +
            "The lead is on another host. Answer in this topic or coordinate with the lead via the usual tools.\n" +
            `</paseo-topic-context>\n\n  ${question.replace(" is ", "\n  is ")}`,
        },
      },
    ];

    expect(buildTimelinePromptIndex("epoch-1", rows)).toEqual({
      epoch: "epoch-1",
      previewsAreDisplayText: true,
      prompts: [{ seq: 2, timestamp, preview: `${question.slice(0, 119)}…` }],
    });
  });

  it("preserves envelope-shaped user text without matching follow-up attribution", () => {
    const text =
      '<paseo-topic-context root-message-id="root">\n</paseo-topic-context>\n\nExplain this';
    const timestamp = "2026-01-01T00:00:00.000Z";
    const rows: AgentTimelineRow[] = [
      { seq: 1, timestamp, item: { type: "user_message", text } },
      { seq: 2, timestamp, rootMessageId: "other", item: { type: "user_message", text } },
      {
        seq: 3,
        timestamp,
        rootMessageId: "root",
        item: { type: "user_message", messageId: "provider-id", clientMessageId: "root", text },
      },
    ];

    expect(buildTimelinePromptIndex("epoch-1", rows).prompts.map(({ preview }) => preview)).toEqual(
      rows.map(() => text.replace(/\s+/g, " ")),
    );
  });
});
