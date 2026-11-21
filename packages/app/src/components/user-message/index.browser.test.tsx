import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { MessagePreview } from "./index";
import { createUserMessageExpansion, type UserMessageExpansion } from "./expansion";
import { UserMessageExpansionContext } from "./expansion-context";
import { UserMessageBody } from "./message-body";

import { createFindViewport } from "@/agent-stream/chat-find/viewport.web";
import { findMessageMatches } from "@/agent-stream/chat-find/ranges.web";
import {
  FindUserMessageExpansionContext,
  type FindUserMessageExpansion,
} from "./quote-expansion-context";

// Load translations so the toggle exposes its real accessible name.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  container.style.width = "400px";
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const longText = Array.from({ length: 60 }, (_, line) => `Line ${line + 1}`).join("\n");
const preLine = { whiteSpace: "pre-line" } as const;
const view = () => within(container);

function renderMessage(expansion: UserMessageExpansion) {
  act(() =>
    root.render(
      <UserMessageExpansionContext.Provider value={expansion}>
        <MessagePreview itemId="message-1">
          <span style={preLine}>{longText}</span>
        </MessagePreview>
      </UserMessageExpansionContext.Provider>,
    ),
  );
}

async function waitForLayout() {
  await act(async () => {
    for (let frame = 0; frame < 2; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
}

function renderFindTranscript(message: string, expansion = createUserMessageExpansion()) {
  let viewport: ReturnType<typeof createFindViewport> | undefined;
  function Transcript() {
    const [target, setTarget] = useState<FindUserMessageExpansion | null>(null);
    viewport ??= createFindViewport({
      getRoot: () => container,
      getBindings: () => ({
        viewportRef: { current: null },
        revealLoadedMessage: () => false,
        visibleMessageIds: new Set(["message-1"]),
      }),
      highlightName: "quoted-find-regression",
      setUserMessageExpansion: setTarget,
    });
    return (
      <FindUserMessageExpansionContext.Provider value={target}>
        <UserMessageExpansionContext.Provider value={expansion}>
          <div data-history-row-id="message-1" data-message-id="message-1">
            <MessagePreview itemId="message-1">
              <UserMessageBody message={message} />
            </MessagePreview>
          </div>
        </UserMessageExpansionContext.Provider>
      </FindUserMessageExpansionContext.Provider>
    );
  }

  act(() => root.render(<Transcript />));
  return viewport!;
}

describe("long user message preview", () => {
  it("preserves the Python prompt in selected text alongside a quote card", () => {
    const code = ">>> 1 + 1";
    act(() => root.render(<UserMessageBody message={`${code}\n\n> Real quote`} />));
    const range = document.createRange();
    range.selectNodeContents(view().getByText(code, { exact: true }));
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe(code);
    expect(view().getAllByTestId("user-message-quote-block")).toHaveLength(1);
    selection.removeAllRanges();
  });

  it("removes the message height limit while the quote is expanded", async () => {
    const expansion = createUserMessageExpansion();
    const message = `${longText
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}\n\nReply`;
    act(() =>
      root.render(
        <UserMessageExpansionContext.Provider value={expansion}>
          <MessagePreview itemId="message-1">
            <UserMessageBody message={message} />
          </MessagePreview>
        </UserMessageExpansionContext.Provider>,
      ),
    );
    const quote = view().getByTestId("user-message-quote-block");
    const toggle = view().getByTestId("user-message-quote-toggle");
    const previewHeight = container.getBoundingClientRect().height;
    act(() => toggle.click());
    await waitForLayout();
    expect(quote.getBoundingClientRect().height).toBeGreaterThan(240);
    expect(container.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(
      quote.getBoundingClientRect().bottom,
    );
    act(() => toggle.click());
    await waitForLayout();
    expect(container.getBoundingClientRect().height).toBe(previewHeight);
  });

  it("reveals the selected clipped quote and restores the reader's other disclosure choices", async () => {
    const expansion = createUserMessageExpansion();
    const quote = (prefix: string, last: string) =>
      [...Array.from({ length: 20 }, (_, i) => `> ${prefix} ${i}`), `> ${last}`].join("\n");
    const message = [
      quote("Manual", "Manual end"),
      quote("Folded", "Hidden needle"),
      quote("Untouched", "Untouched end"),
    ].join("\n\n");
    const viewport = renderFindTranscript(message, expansion);
    const [manual, found, untouched] = view().getAllByTestId("user-message-quote-block");
    const matchBottom = () =>
      findMessageMatches(container, "message-1", "Hidden needle")[0].getBoundingClientRect().bottom;
    expect(matchBottom()).toBeGreaterThan(found.getBoundingClientRect().bottom);
    const result = await viewport.reveal(
      "message-1",
      "Hidden needle",
      0,
      new AbortController().signal,
    );
    expect(result).toEqual({ occurrence: 0, count: 1 });
    expect(matchBottom()).toBeLessThanOrEqual(found.getBoundingClientRect().bottom);
    expect(matchBottom()).toBeLessThanOrEqual(container.getBoundingClientRect().bottom);
    expect(untouched.getBoundingClientRect().height).toBeLessThan(240);
    const highlight = CSS.highlights.get("quoted-find-regression");
    expect(Array.from(highlight ?? [], (range) => range.toString())).toEqual(["Hidden needle"]);

    act(() => within(manual).getByRole("button", { name: "Show more" }).click());
    act(() => viewport.clear());
    await waitForLayout();
    expect(manual.getBoundingClientRect().height).toBeGreaterThan(240);
    expect(matchBottom()).toBeGreaterThan(found.getBoundingClientRect().bottom);
    expect(within(untouched).getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });

  it("shows a search match covered by the ellipsis on the last preview line", async () => {
    const viewport = renderFindTranscript("> first\n> second\n> 123456789012345678X\n> fourth");
    const quoteText = container.querySelector<HTMLElement>("[data-find-quote-clipped]")!;
    // Fit the last character at the end of line three, where the ellipsis is painted.
    Object.assign(quoteText.style, { font: "16px/20px monospace", width: "19.9ch" });
    const match = findMessageMatches(container, "message-1", "X")[0];
    const preview = quoteText.getBoundingClientRect();
    const matchBounds = match.getBoundingClientRect();
    expect(quoteText.scrollHeight).toBeGreaterThan(quoteText.clientHeight);
    expect(matchBounds.bottom).toBeLessThanOrEqual(preview.bottom);
    expect(matchBounds.right).toBeLessThanOrEqual(preview.right);

    const signal = new AbortController().signal;
    await viewport.reveal("message-1", "first", 0, signal);
    expect(quoteText.hasAttribute("data-find-quote-clipped")).toBe(true);
    await viewport.reveal("message-1", "X", 0, signal);
    expect(quoteText.clientHeight).toBe(quoteText.scrollHeight);
    const highlight = CSS.highlights.get("quoted-find-regression");
    expect(Array.from(highlight ?? [], (range) => range.toString())).toEqual(["X"]);

    act(() => viewport.clear());
    expect(quoteText.scrollHeight).toBeGreaterThan(quoteText.clientHeight);
  });

  it("commits the control with the mount, so the first frame is the settled one", async () => {
    renderMessage(createUserMessageExpansion());

    // Nothing has painted yet: whatever is in the DOM now is the first frame.
    expect(view().getByRole("button", { name: "Show more" })).toBeTruthy();
    const firstFrameHeight = container.getBoundingClientRect().height;

    await waitForLayout();
    expect(view().getByRole("button", { name: "Show more" })).toBeTruthy();
    expect(container.getBoundingClientRect().height).toBe(firstFrameHeight);
  });

  it("paints the user's expanded choice when the row remounts", async () => {
    const expansion = createUserMessageExpansion();
    renderMessage(expansion);
    act(() => view().getByRole("button", { name: "Show more" }).click());
    await waitForLayout();
    const expandedHeight = container.getBoundingClientRect().height;

    act(() => root.render(null));
    renderMessage(expansion);

    expect(view().getByRole("button", { name: "Show less" })).toBeTruthy();
    expect(container.getBoundingClientRect().height).toBe(expandedHeight);
  });
});
