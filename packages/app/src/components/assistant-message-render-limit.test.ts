import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT,
  capAssistantMessageForRender,
  getUtf8ByteLength,
} from "./assistant-message-render-limit";

describe("assistant message render limit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("leaves messages at the limit unchanged", () => {
    const message = "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT);

    expect(capAssistantMessageForRender(message)).toEqual({ text: message, capped: false });
  });

  it("caps oversized messages before markdown rendering", () => {
    const message = "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT + 1);

    expect(capAssistantMessageForRender(message)).toEqual({
      text: "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT),
      capped: true,
    });
  });

  it.each(["😀", "é", "👨‍👩‍👧‍👦", "👍🏽", "❤️", "🇺🇸", "가", "कः"])(
    "does not split %s at the render limit",
    (cluster) => {
      for (let offset = 1; offset < cluster.length; offset++) {
        const prefix = "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT - offset);
        expect(capAssistantMessageForRender(`${prefix}${cluster}tail`)).toEqual({
          text: prefix,
          capped: true,
        });
      }
    },
  );

  it("counts the complete message size in UTF-8 bytes", () => {
    expect(getUtf8ByteLength("aé😀")).toBe(7);
  });

  it("keeps a bounded prefix when grapheme segmentation is unavailable", async () => {
    vi.resetModules();
    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    const { capAssistantMessageForRender: capWithoutSegmenter } =
      await import("./assistant-message-render-limit");
    const message = "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT + 1);

    expect(capWithoutSegmenter(message)).toEqual({
      text: "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT),
      capped: true,
    });
  });

  it("advances the cap by 32,000 characters per expanded step until complete", () => {
    const message = "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT * 2 + 500);

    expect(capAssistantMessageForRender(message, { expandedSteps: 1 })).toEqual({
      text: "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT * 2),
      capped: true,
    });
    expect(capAssistantMessageForRender(message, { expandedSteps: 2 })).toEqual({
      text: message,
      capped: false,
    });
  });

  it("snaps back to the preceding line break instead of splitting an inline link", () => {
    const leading = `${"a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT - 40)}\n`;
    const brokenLine = "• P2-29 [codex-app-server-agent.ts](file:///workspace/agent.ts#L10)\n";
    const message = `${leading}${brokenLine}tail`;

    expect(capAssistantMessageForRender(message)).toEqual({
      text: leading.slice(0, -1),
      capped: true,
    });
    expect(capAssistantMessageForRender(message, { preferLineBoundary: false })).toEqual({
      text: message.slice(0, ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT),
      capped: true,
    });
  });

  it("strips carriage return when snapping to a CRLF line break", () => {
    const prefix = "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT - 20);
    const message = `${prefix}\r\n${"b".repeat(80)}`;

    expect(capAssistantMessageForRender(message)).toEqual({
      text: prefix,
      capped: true,
    });
  });
});

it("preserves complete native multi-paragraph messages and the newline-heavy repro", async () => {
  const native = await import("./assistant-message-render-limit.native");
  const message = "Paragraph.\n\n".repeat(3000) + "Section 60";
  expect(native.capAssistantMessageForRender(message)).toEqual({ text: message, capped: false });
  const lines = "x\n".repeat(16_000) + "HIDDEN_OVERSIZED_MESSAGE_TAIL";
  expect(native.capAssistantMessageForRender(lines)).toEqual({ text: lines, capped: false });
});
