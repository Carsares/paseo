import { expect, it } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { InMemoryAgentTimelineStore } from "../agent-timeline-store.js";
import { searchTimeline } from "./index.js";

function rows(items: AgentTimelineItem[]) {
  return items.map((item, index) => ({ item, seq: index + 1, timestamp: "2026-09-12T00:00:00Z" }));
}

it("returns source locations for formatted assistant text and literal user text", async () => {
  const result = await searchTimeline({
    rows: rows([
      { type: "user_message", text: "hello **world**" },
      { type: "assistant_message", text: "İ😀hello **world** and hello *world*" },
      {
        type: "assistant_message",
        text: "[hello &amp; world](https://example.com)",
        messageId: "separate",
      },
    ]),
    query: "hello world",
  });
  expect(result).toEqual({
    locations: [{ seq: 2, role: "assistant", count: 2 }],
    nextCursor: null,
  });
});

it("finds phrases across quoted lines without joining quotes and body text", async () => {
  const source = rows([
    { type: "user_message", text: "start\r\n\t> alpha\r> beta\nend" },
    { type: "user_message", text: "> alpha\n\n> beta" },
  ]);
  expect((await searchTimeline({ rows: source, query: "alpha beta" })).locations).toEqual([
    { seq: 1, role: "user", count: 1 },
  ]);
  expect((await searchTimeline({ rows: source, query: "beta end" })).locations).toEqual([]);
  expect((await searchTimeline({ rows: source, query: "start alpha" })).locations).toEqual([]);
});

it.each(["```", "~~~"])("keeps quote markers literal inside %s fences", async (fence) => {
  const outerFence = fence + fence[0];
  const text = [outerFence + "txt", fence, "> alpha", "> beta", outerFence, "> gamma", "> delta"];
  const source = rows([{ type: "user_message", text: text.join("\n") }]);
  expect((await searchTimeline({ rows: source, query: "alpha beta" })).locations).toEqual([]);
  expect((await searchTimeline({ rows: source, query: "alpha > beta" })).locations).toEqual([
    { seq: 1, role: "user", count: 1 },
  ]);
  expect((await searchTimeline({ rows: source, query: "gamma delta" })).locations).toEqual([
    { seq: 1, role: "user", count: 1 },
  ]);
});

it("finds code and literal punctuation without searching tools, reasoning, or task state", async () => {
  const result = await searchTimeline({
    rows: rows([
      { type: "assistant_message", text: "```ts\nconst value = 'a.b';\n```" },
      { type: "reasoning", text: "a.b" },
      { type: "todo", items: [{ text: "a.b", completed: false }] },
      { type: "user_message", text: "axb" },
      { type: "user_message", text: "a.b" },
    ]),
    query: "a.b",
  });
  expect(result.locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
    { seq: 5, role: "user", count: 1 },
  ]);
});

it("matches literal text across carriage-return line breaks in fences without quotes", async () => {
  const source = rows([{ type: "user_message", text: "```\r> alpha\r> beta\r```" }]);
  expect((await searchTimeline({ rows: source, query: "alpha > beta" })).locations).toEqual([
    { seq: 1, role: "user", count: 1 },
  ]);
  expect((await searchTimeline({ rows: source, query: "alpha> beta" })).locations).toEqual([]);
});

it("bounds results and resumes without losing locations", async () => {
  const source = rows(
    Array.from({ length: 202 }, () => ({ type: "user_message", text: "target" })),
  );
  const first = await searchTimeline({ rows: source, query: "target" });
  expect(first.locations).toHaveLength(200);
  expect(first.nextCursor).toBe(200);
  const second = await searchTimeline({ rows: source, query: "target", cursor: first.nextCursor! });
  expect(second).toEqual({
    locations: [
      { seq: 201, role: "user", count: 1 },
      { seq: 202, role: "user", count: 1 },
    ],
    nextCursor: null,
  });
});

it("only joins fragments across hidden tools in the same reply and returns the last fragment cursor", async () => {
  const fragment = (text: string, messageId = "reply"): AgentTimelineItem => ({
    type: "assistant_message",
    text,
    messageId,
  });
  const tool = (name: string, callId: string): AgentTimelineItem => ({
    type: "tool_call",
    name,
    callId,
    status: "completed",
    detail: { type: "plain_text", text: "" },
    error: null,
  });
  const source = rows([
    fragment("**proto"),
    tool("mcp__paseo__send_agent_prompt", "hidden-1"),
    tool("Agent", "hidden-2"),
    fragment("col**"),
    fragment("proto", "other"),
    tool("paseo_create_agent", "hidden-3"),
    fragment("col"), // Different message.
    fragment("proto", "visible-break"),
    tool("mcp__paseo__request_permission", "visible"),
    fragment("col", "visible-break"),
    fragment("proto", "turn-break"),
    tool("paseo_list_agents", "hidden-4"),
    fragment("col", "turn-break"), // Different turn.
  ]).map((row) => Object.assign(row, { turnId: row.seq < 13 ? "turn-1" : "turn-2" }));
  const input = { rows: source, query: "protocol", provider: "claude" };
  await expect(searchTimeline(input)).resolves.toMatchObject({ locations: [] });
  await expect(searchTimeline({ ...input, hideAgentInteractions: true })).resolves.toEqual({
    locations: [{ seq: 4, role: "assistant", count: 1 }],
    nextCursor: null,
  });
  await expect(
    searchTimeline({ ...input, hideAgentInteractions: true, cursor: 4 }),
  ).resolves.toEqual({
    locations: [],
    nextCursor: null,
  });
});

it("finds adjacent displayed fragments when the hidden tool update folds into an earlier row", async () => {
  const tool = {
    type: "tool_call" as const,
    name: "mcp__paseo__send_agent_prompt",
    callId: "interaction",
    detail: { type: "plain_text" as const, text: "" },
    error: null,
  };
  const source = rows([
    { ...tool, status: "running" },
    { type: "assistant_message", text: "proto", messageId: "reply" },
    { ...tool, status: "completed" },
    { type: "assistant_message", text: "col", messageId: "reply" },
  ]).map((row) => Object.assign(row, { turnId: "turn" }));

  await expect(
    searchTimeline({ rows: source, query: "protocol", hideAgentInteractions: true }),
  ).resolves.toEqual({
    locations: [{ seq: 4, role: "assistant", count: 1 }],
    nextCursor: null,
  });
});

it("uses the final fragment sequence to load a whole old reply longer than a timeline page", async () => {
  const source = rows([
    { type: "assistant_message", text: "proto", messageId: "reply" },
    ...Array.from(
      { length: 50 },
      (_, index): AgentTimelineItem => ({
        type: "tool_call",
        name: "mcp__paseo__send_agent_prompt",
        callId: `interaction-${index}`,
        detail: { type: "plain_text", text: "" },
        status: "completed",
        error: null,
      }),
    ),
    { type: "assistant_message", text: "col", messageId: "reply" },
    ...Array.from(
      { length: 70 },
      (_, index): AgentTimelineItem => ({
        type: "user_message",
        text: `Newer prompt ${index}`,
      }),
    ),
  ]).map((row) => Object.assign(row, { turnId: row.seq <= 52 ? "old" : `new-${row.seq}` }));
  const store = new InMemoryAgentTimelineStore();
  store.initialize("agent", { rows: source, epoch: "epoch" });
  const tail = store.fetch("agent", { limit: 40, wholeTurns: true });
  expect(tail.startSeq).toBe(83);
  const result = await searchTimeline({
    rows: store.getRows("agent"),
    query: "protocol",
    hideAgentInteractions: true,
  });
  expect(result.locations).toEqual([{ seq: 52, role: "assistant", count: 1 }]);

  const jump = store.fetch("agent", {
    direction: "before",
    cursor: { epoch: "epoch", seq: result.locations[0]!.seq + 21 },
    limit: 40,
    wholeTurns: true,
  });
  expect(
    jump.rows.flatMap(({ item }) => (item.type === "assistant_message" ? [item.text] : [])),
  ).toEqual(["proto", "col"]);
});

it("finds ordinary Markdown entities and line breaks without requiring identical parsers", async () => {
  const source = rows([{ type: "assistant_message", text: "hello &amp; **world**\nnext line" }]);
  expect((await searchTimeline({ rows: source, query: "hello & world" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
  expect((await searchTimeline({ rows: source, query: "world next" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
});

it("counts occurrences per rendered block rather than across block boundaries", async () => {
  const source = rows([
    { type: "assistant_message", text: "target one\n\ntarget two\n\n- target three\n- end target" },
    { type: "user_message", text: "TARGET target" },
  ]);
  expect((await searchTimeline({ rows: source, query: "target" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 4 },
    { seq: 2, role: "user", count: 2 },
  ]);
  expect((await searchTimeline({ rows: source, query: "end target" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
  expect((await searchTimeline({ rows: source, query: "two target" })).locations).toEqual([]);
  // Rendered text never runs from the end of one block into the start of the next, so
  // neither does a match, however contiguous the Markdown source looks.
  expect((await searchTimeline({ rows: source, query: "one target" })).locations).toEqual([]);
});
