import { SPACING } from "@/styles/theme";
import { summarizeToolCalls } from "@/tool-calls/detail-level/overview/model";
import type { StreamItem } from "@/types/stream";
import { describe, expect, it } from "vitest";
import { getAssistantMessageSpacing, getGapBetweenStreamItems } from "./spacing";

const message: StreamItem = {
  kind: "assistant_message",
  id: "m",
  text: "First\n\nSecond",
  timestamp: new Date(0),
};
const prompt: StreamItem = {
  kind: "user_message",
  id: "p",
  text: "Fix it",
  timestamp: new Date(0),
};
const thought: StreamItem = {
  kind: "thought",
  id: "t",
  text: "Reading",
  timestamp: new Date(0),
  status: "ready",
};
const summary: StreamItem = {
  kind: "turn_summary",
  id: "turn-summary:p",
  hostId: "p",
  expanded: false,
  timestamp: new Date(0),
  tools: summarizeToolCalls([]),
};
describe("whole-message spacing", () => {
  it("compacts only the gap to its turn footer", () => {
    expect(getAssistantMessageSpacing({ item: message })).toBe("default");
    expect(getAssistantMessageSpacing({ item: message, hasFooterBelow: true })).toBe(
      "compactBottom",
    );
  });
  it("adds no gap at the edges of the stream", () => {
    expect(getGapBetweenStreamItems(null, prompt)).toBe(0);
    expect(getGapBetweenStreamItems(prompt, null)).toBe(0);
  });
  it("keeps separate assistant messages separated by the regular gap", () => {
    expect(getGapBetweenStreamItems(message, { ...message, id: "next" })).toBe(SPACING[4]);
  });
  it("sets a prompt the same distance above whatever answers it", () => {
    const belowPrompt = getGapBetweenStreamItems(prompt, thought);
    expect(belowPrompt).toBe(SPACING[4]);
    expect(getGapBetweenStreamItems(prompt, message)).toBe(belowPrompt);
    expect(getGapBetweenStreamItems(prompt, summary)).toBe(belowPrompt);
  });
  it("keeps consecutive prompts close together", () => {
    expect(getGapBetweenStreamItems(prompt, { ...prompt, id: "next" })).toBe(SPACING[1]);
  });
  it("adds a larger gap before a prompt that starts a new turn", () => {
    expect(getGapBetweenStreamItems(message, prompt)).toBe(SPACING[8]);
    expect(getGapBetweenStreamItems(thought, prompt)).toBe(SPACING[8]);
    expect(getGapBetweenStreamItems(summary, prompt)).toBe(SPACING[8]);
  });
  it("spaces a turn's summary row like the work rows it stands for", () => {
    expect(getGapBetweenStreamItems(message, summary)).toBe(SPACING[1]);
    expect(getGapBetweenStreamItems(summary, message)).toBe(SPACING[1]);
    expect(getGapBetweenStreamItems(thought, summary)).toBe(0);
  });
});
