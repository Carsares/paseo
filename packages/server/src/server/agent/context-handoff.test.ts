import { expect, test, vi } from "vitest";
import {
  buildContextHandoffEnvelope,
  fallbackContextSummary,
  injectContextHandoffIntoPrompt,
  RECENT_VERBATIM_BUDGET_CHARS,
  splitContextHandoff,
  summarizeContextHandoff,
  waitForContextSummary,
} from "./context-handoff.js";
import {
  formatAgentMessage,
  prepareAgentMessage,
  projectAgentMessages,
  stripContextHandoffEnvelope,
} from "./agent-messages/envelope.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

function rows(...items: AgentTimelineItem[]) {
  return items.map((item, i) => ({ item, seq: i + 1, timestamp: new Date(0).toISOString() }));
}

const early = { type: "user_message", text: "Keep the early requirement" } as const;
const latest = { type: "user_message", text: "Most recent request" } as const;
const longReply = { type: "assistant_message", text: "x".repeat(35_980) + " last line" } as const;

test("renders short turns verbatim and leaves compaction out of context", () => {
  const context = splitContextHandoff(
    rows({ type: "assistant_message", text: "Opening" }, early, {
      type: "compaction",
      status: "completed",
      trigger: "auto",
    }),
  );
  expect(context.olderTurns).toEqual([]);
  expect(context.recentTurns).toEqual(["Assistant:\nOpening\n\nUser:\nKeep the early requirement"]);
  expect(buildContextHandoffEnvelope(context)).toContain("## Recent Conversation (Verbatim)");
  expect(buildContextHandoffEnvelope(splitContextHandoff([]))).toBeNull();
});

test("selects whole recent turns and preserves the ends of oversized prompts and replies", () => {
  const context = splitContextHandoff(rows(early, latest, longReply));
  expect(context.olderTurns).toEqual([[early]]);
  expect(context.recentTurns).toHaveLength(1);
  expect(context.recentTurns[0]).toContain(latest.text);
  expect(context.recentTurns[0]).toMatch(/last line$/);
  expect(context.recentTurns[0].length).toBeLessThanOrEqual(RECENT_VERBATIM_BUDGET_CHARS);
  expect(
    splitContextHandoff(
      rows(early, latest, longReply, {
        type: "compaction",
        status: "completed",
        trigger: "auto",
      }),
    ).olderDigest,
  ).toBe(context.olderDigest);
});

test("a steer stays in its canonical turn when calculating the recent budget", () => {
  const timeline = rows(early, latest, longReply).map((row) =>
    Object.assign(row, { turnId: "one" }),
  );
  const context = splitContextHandoff(timeline);
  expect(context.olderTurns).toEqual([]);
  expect(context.recentTurns[0]).toContain(early.text);
  expect(context.recentTurns[0]).toContain(latest.text);
});

test("summarizes earlier turns and uses the same fallback for errors, empty replies and timeouts", async () => {
  const context = splitContextHandoff(rows(early, latest, longReply));
  const summary = vi.fn(async () => "Condensed earlier requirement");
  const make = (run: Parameters<typeof summarizeContextHandoff>[1]) =>
    summarizeContextHandoff(context, run, new AbortController());
  await expect(make(summary)).resolves.toBe("Condensed earlier requirement");
  expect(summary).toHaveBeenCalledWith(
    expect.stringContaining(early.text),
    expect.any(AbortSignal),
  );
  expect(summary.mock.calls[0]?.[0]).not.toContain(latest.text);
  const fallback = fallbackContextSummary(context);
  expect(fallback).toContain(early.text);
  await expect(
    make(async () => {
      throw new Error("offline");
    }),
  ).resolves.toBe(fallback);
  await expect(make(async () => " ")).resolves.toBe(fallback);

  vi.useFakeTimers();
  try {
    const blocked = vi.fn((_prompt: string, _signal: AbortSignal) => new Promise<string>(() => {}));
    const summarizing = make(blocked);
    const sendWait = waitForContextSummary(summarizing);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(sendWait).resolves.toBeUndefined();
    expect(blocked.mock.calls[0]?.[1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(summarizing).resolves.toBe(fallback);
    expect(blocked.mock.calls[0]?.[1].aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("strips stacked handoffs before parsing provider replay and keeps literal human input", () => {
  const envelope = buildContextHandoffEnvelope(splitContextHandoff(rows(early)))!;
  const wrapped = formatAgentMessage({ id: "clean", source: null, text: "Next prompt" });
  const text = injectContextHandoffIntoPrompt(envelope + "\n\n" + wrapped, envelope);
  expect(typeof text).toBe("string");
  expect(stripContextHandoffEnvelope(text as string)).toBe(wrapped);
  expect(projectAgentMessages({ type: "user_message", text: text as string })).toEqual([
    { type: "user_message", text: "Next prompt", clientMessageId: "clean" },
  ]);
  expect(projectAgentMessages({ type: "user_message", text: envelope })).toEqual([]);
  const scheduled = "<paseo-system>\nScheduled task\n</paseo-system>";
  expect(
    projectAgentMessages({ type: "user_message", text: envelope + "\n\n" + scheduled }),
  ).toEqual(projectAgentMessages({ type: "user_message", text: scheduled }));
  const literal = prepareAgentMessage(envelope + "\n\nliteral", undefined, "literal");
  expect(projectAgentMessages({ type: "user_message", text: literal.prompt as string })).toEqual([
    { type: "user_message", text: envelope + "\n\nliteral", clientMessageId: "literal" },
  ]);
  const prompt = [{ type: "image", mimeType: "image/png", data: "image" }] as const;
  expect(injectContextHandoffIntoPrompt([...prompt], envelope)).toEqual([
    { type: "text", text: envelope + "\n\n" },
    ...prompt,
  ]);
});
