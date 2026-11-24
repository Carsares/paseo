import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerQuoteProvider } from "@/assistant-selection-copy/composer-quote";
import { i18n } from "@/i18n/i18next";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import type { TurnTiming } from "@/timeline/turn-time";
import type { StreamItem } from "@/types/stream";
import { createNativeStreamStrategy } from "./strategy-native";
import { CompletedTurnFooterRow } from "./turn-footer";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// A Sunday, so a turn that ended on Friday shows a weekday timestamp.
const NOW = new Date(2026, 10, 8, 5, 0);
const FRIDAY_NIGHT = new Date(2026, 10, 6, 23, 11);

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  host = document.createElement("div");
  host.style.width = "880px";
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  await i18n.changeLanguage("en");
  vi.unstubAllGlobals();
});

const reply: StreamItem = {
  kind: "assistant_message",
  id: "reply",
  text: "Done.",
  timestamp: FRIDAY_NIGHT,
};

// A module-level target keeps the provider's `target` prop identity stable across renders.
let quoteSink: ((quoteText: string, label?: string) => void) | undefined;
const quoteTarget = {
  addQuoteAttachment: (quoteText: string, label?: string) => quoteSink?.(quoteText, label),
};

function renderCompletedFooter(
  timing: TurnTiming,
  options: {
    item?: StreamItem;
    items?: StreamItem[];
    startIndex?: number;
    addQuoteAttachment?: (quoteText: string, label?: string) => void;
    wrapInStreamRoot?: boolean;
    streamChildren?: React.ReactNode;
  } = {},
): void {
  quoteSink = options.addQuoteAttachment;
  const items = options.items ?? [options.item ?? reply];
  const footer = (
    <CompletedTurnFooterRow
      strategy={createNativeStreamStrategy()}
      items={items}
      timing={timing}
      startIndex={options.startIndex ?? 0}
      supportsTimelineCursor={false}
    />
  );
  const content = options.addQuoteAttachment ? (
    <KeyboardActionDispatcherProvider>
      <ComposerQuoteProvider target={quoteTarget}>{footer}</ComposerQuoteProvider>
    </KeyboardActionDispatcherProvider>
  ) : (
    footer
  );
  const wrapped =
    options.wrapInStreamRoot === false ? (
      content
    ) : (
      <div data-agent-stream-root="true">
        {options.streamChildren}
        {content}
      </div>
    );
  act(() => root.render(wrapped));
}

/** How many painted lines each footer label takes. */
function paintedLinesByLabel(element: HTMLElement): Record<string, number> {
  const lines: Record<string, number> = {};
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent ?? "";
    if (!text.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    lines[text] = new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size;
  }
  return lines;
}

// The footer shows the duration and swaps to the end timestamp on hover or tap. Neither label
// may be sized by the other: a timestamp with more characters can still paint narrower.
it.each([
  {
    language: "en",
    timing: { completedAt: FRIDAY_NIGHT, durationMs: 26_000 },
    duration: "Worked for 26s",
  },
  // CJK glyphs make the shorter string paint wider in every font.
  {
    language: "ja",
    timing: { completedAt: FRIDAY_NIGHT, durationMs: 59 * 60_000 + 58_000 },
    duration: "作業時間 59m 58s",
  },
])("keeps both timing labels on one line when the chat has room ($language)", async (input) => {
  await i18n.changeLanguage(input.language);

  renderCompletedFooter(input.timing);

  expect(paintedLinesByLabel(host)).toEqual({
    [input.duration]: 1,
    "Friday 11:11 PM": 1,
  });
});

const TIMING: TurnTiming = { completedAt: FRIDAY_NIGHT, durationMs: 26_000 };

function quoteButton(): HTMLElement | null {
  return host.querySelector<HTMLElement>('[data-testid="turn-quote-reply"]');
}

it("shows the quote reply button only inside a composer that accepts quotes", () => {
  renderCompletedFooter(TIMING);
  expect(quoteButton()).toBeNull();

  renderCompletedFooter(TIMING, { addQuoteAttachment: vi.fn() });
  expect(quoteButton()?.getAttribute("aria-label")).toBe("Quote reply");
});

it("keeps the timing label on one line beside the quote button", () => {
  renderCompletedFooter(TIMING, { addQuoteAttachment: vi.fn() });

  expect(paintedLinesByLabel(host)).toEqual({
    "Worked for 26s": 1,
    "Friday 11:11 PM": 1,
  });
});

it("quotes a short reply whole and labels the card", () => {
  const addQuoteAttachment = vi.fn();
  renderCompletedFooter(TIMING, { addQuoteAttachment });

  act(() => quoteButton()?.click());

  expect(addQuoteAttachment).toHaveBeenCalledExactlyOnceWith("Done.", "Quote reply");
});

it("quotes a summary of a long reply", () => {
  const addQuoteAttachment = vi.fn();
  const sentence = `${"a".repeat(58)}. `;
  renderCompletedFooter(TIMING, {
    addQuoteAttachment,
    item: { ...reply, text: sentence.repeat(10) } as StreamItem,
  });

  act(() => quoteButton()?.click());

  const [quote, label] = addQuoteAttachment.mock.calls[0] as [string, string];
  expect(label).toBe("Quote reply");
  expect(quote.endsWith(".…")).toBe(true);
  expect(Array.from(quote).length).toBeLessThanOrEqual(200);
});

function selectInside(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

it("prefers the reader's selection inside the reply over the summary", () => {
  const addQuoteAttachment = vi.fn();
  renderCompletedFooter(TIMING, {
    addQuoteAttachment,
    streamChildren: (
      <div data-message-id="reply">
        Intro <span data-testid="selected-passage"> the selected passage </span> outro
      </div>
    ),
  });
  const selected = host.querySelector<HTMLElement>('[data-testid="selected-passage"]')!;
  try {
    selectInside(selected);

    const button = quoteButton()!;
    act(() => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      window.getSelection()?.removeAllRanges();
      button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      button.click();
    });

    expect(addQuoteAttachment).toHaveBeenCalledExactlyOnceWith(
      "the selected passage",
      "Quote selection",
    );
  } finally {
    window.getSelection()?.removeAllRanges();
  }
});

it("ignores a selection that lies in another message", () => {
  const addQuoteAttachment = vi.fn();
  renderCompletedFooter(TIMING, {
    addQuoteAttachment,
    streamChildren: <div data-message-id="another-reply">Unrelated words</div>,
  });
  const other = host.querySelector<HTMLElement>('[data-message-id="another-reply"]')!;
  try {
    selectInside(other);

    act(() => quoteButton()?.click());

    expect(addQuoteAttachment).toHaveBeenCalledExactlyOnceWith("Done.", "Quote reply");
  } finally {
    window.getSelection()?.removeAllRanges();
  }
});

it("caps a quoted selection at 500 characters", () => {
  const addQuoteAttachment = vi.fn();
  renderCompletedFooter(TIMING, {
    addQuoteAttachment,
    streamChildren: <div data-message-id="reply">{"w".repeat(900)}</div>,
  });
  const message = host.querySelector<HTMLElement>('[data-message-id="reply"]')!;
  try {
    selectInside(message);

    act(() => quoteButton()?.click());

    const [quote] = addQuoteAttachment.mock.calls[0] as [string];
    expect(Array.from(quote)).toHaveLength(500);
    expect(quote.endsWith("…")).toBe(true);
  } finally {
    window.getSelection()?.removeAllRanges();
  }
});

it("captures selections spanning multiple assistant rows inside the stream root even when microtasks flush between pointerup and click", async () => {
  const first: StreamItem = {
    kind: "assistant_message",
    id: "part-1",
    turnId: "turn-multi",
    text: "First paragraph.",
    timestamp: FRIDAY_NIGHT,
  };
  const second: StreamItem = {
    kind: "assistant_message",
    id: "part-2",
    turnId: "turn-multi",
    text: "Second paragraph.",
    timestamp: FRIDAY_NIGHT,
  };
  const addQuoteAttachment = vi.fn();
  // Native strategy traverses forward (`+1`), so index 0 is the latest item (`second`).
  renderCompletedFooter(TIMING, {
    items: [second, first],
    startIndex: 0,
    addQuoteAttachment,
    streamChildren: (
      <>
        <div data-message-id="part-1">First paragraph.</div>
        <div data-message-id="part-2">Second paragraph.</div>
      </>
    ),
  });
  const row1 = host.querySelector<HTMLElement>('[data-message-id="part-1"]')!;
  const row2 = host.querySelector<HTMLElement>('[data-message-id="part-2"]')!;
  try {
    const range = document.createRange();
    range.setStart(row1.firstChild as Text, 0);
    range.setEnd(row2.firstChild as Text, "Second".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const expectedText = selection?.toString().trim() ?? "";

    const button = quoteButton()!;
    act(() => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      // Browser clears selection on pointerdown/mousedown before RNW press handlers resolve.
      window.getSelection()?.removeAllRanges();
      button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    // Flush microtasks between pointerup/mouseup and native click, matching real browsers.
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      button.click();
    });

    expect(expectedText).toContain("First paragraph.");
    expect(expectedText).toContain("Second");
    expect(addQuoteAttachment).toHaveBeenCalledExactlyOnceWith(expectedText, "Quote selection");
  } finally {
    window.getSelection()?.removeAllRanges();
  }
});

it("ignores selections when rendered outside a stream root or in a different chat stream container", () => {
  const otherStream = document.createElement("div");
  otherStream.setAttribute("data-agent-stream-root", "true");
  const otherMessage = document.createElement("div");
  otherMessage.setAttribute("data-message-id", "reply");
  otherMessage.textContent = "From another split pane";
  otherStream.append(otherMessage);
  document.body.append(otherStream);
  try {
    const addQuoteAttachment = vi.fn();
    renderCompletedFooter(TIMING, { addQuoteAttachment });
    selectInside(otherMessage);
    act(() => quoteButton()?.click());
    expect(addQuoteAttachment).toHaveBeenCalledExactlyOnceWith("Done.", "Quote reply");

    addQuoteAttachment.mockReset();
    renderCompletedFooter(TIMING, { addQuoteAttachment, wrapInStreamRoot: false });
    selectInside(otherMessage);
    act(() => quoteButton()?.click());
    expect(addQuoteAttachment).toHaveBeenCalledExactlyOnceWith("Done.", "Quote reply");
  } finally {
    window.getSelection()?.removeAllRanges();
    otherStream.remove();
  }
});
