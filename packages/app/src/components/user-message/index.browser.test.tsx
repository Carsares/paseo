import React, { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor, within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { MessagePreview } from "./index";
import { createUserMessageExpansion, type UserMessageExpansion } from "./expansion";
import { UserMessageExpansionContext } from "./expansion-context";
import { UserMessageBody } from "./message-body";

import { createFindViewport } from "@/agent-stream/chat-find/viewport.web";
import { findMessageMatches } from "@/agent-stream/chat-find/ranges.web";
import { DisclosureRow } from "@/agent-stream/disclosure";
import { createWebStreamStrategy } from "@/agent-stream/strategy-web";
import type { StreamViewportHandle } from "@/agent-stream/strategy";
import type { StreamItem } from "@/types/stream";
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
const fillerRowStyle = { height: 48 };
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

function renderFindTranscript(
  message: string,
  expansion = createUserMessageExpansion(),
  virtualized = false,
) {
  let viewport: ReturnType<typeof createFindViewport> | undefined;
  const viewportRef = createRef<StreamViewportHandle>();
  const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
  const renderMessageRow = (id: string) => (
    <DisclosureRow rowId={id} viewportRef={viewportRef}>
      <MessagePreview itemId={id}>
        <UserMessageBody message={message} />
      </MessagePreview>
    </DisclosureRow>
  );
  const history: StreamItem[] = virtualized
    ? Array.from({ length: 80 }, (_, index) => ({
        kind: "user_message",
        id: `message-${index}`,
        text: index === 1 || index === 50 ? message : `Prompt ${index}`,
        timestamp: new Date(index * 1000),
      }))
    : [];
  const renderRow = (item: StreamItem) =>
    item.id === "message-1" || item.id === "message-50" ? (
      renderMessageRow(item.id)
    ) : (
      <div style={fillerRowStyle}>{item.id}</div>
    );
  if (virtualized) container.style.cssText += "; display:flex; flex-direction:column; height:560px";
  const transcript = virtualized ? (
    strategy.render({
      agentId: "agent",
      segments: { historyVirtualized: history, historyMounted: [], liveHead: [] },
      boundary: { hasVirtualizedHistory: true, hasMountedHistory: false, hasLiveHead: false },
      renderers: {
        renderHistoryVirtualizedRow: renderRow,
        renderHistoryMountedRow: renderRow,
        renderLiveHeadRow: renderRow,
        renderLiveAuxiliary: () => null,
      },
      listEmptyComponent: null,
      viewportRef,
      routeBottomAnchorRequest: null,
      isAuthoritativeHistoryReady: true,
      onNearBottomChange: () => {},
      onNearHistoryStart: async () => false,
      isLoadingOlderHistory: false,
      hasOlderHistory: false,
      olderHistoryProgressKey: null,
      scrollEnabled: true,
      listStyle: null,
      baseListContentContainerStyle: null,
      forwardListContentContainerStyle: null,
      contentMaxWidth: 400,
    })
  ) : (
    <div data-history-row-id="message-1" data-message-id="message-1">
      {renderMessageRow("message-1")}
    </div>
  );
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
          {transcript}
        </UserMessageExpansionContext.Provider>
      </FindUserMessageExpansionContext.Provider>
    );
  }

  act(() => root.render(<Transcript />));
  return Object.assign(viewport!, {
    jumpTo: (messageId: string) => act(() => viewportRef.current!.scrollToMessage!(messageId)),
  });
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

  it("counts and locates occurrences within each user message segment", async () => {
    const viewport = renderFindTranscript(
      "> type\n\ncheck the typecheck step\norchid bridge\n\n> Run typecheck\n> next\n\n> reminder",
    );
    const messageId = "message-1";
    const signal = new AbortController().signal;
    const highlight = () => Array.from(CSS.highlights.get("quoted-find-regression") ?? [])[0];

    expect(await viewport.reveal(messageId, "typecheck", 0, signal)).toEqual({
      occurrence: 0,
      count: 2,
    });
    expect(highlight()?.startContainer.textContent).toBe("check the typecheck step\norchid bridge");
    expect(highlight()?.startContainer).toBe(highlight()?.endContainer);
    expect(await viewport.reveal(messageId, "typecheck", 1, signal)).toEqual({
      occurrence: 1,
      count: 2,
    });
    expect(highlight()?.startContainer.textContent).toBe("Run typecheck\nnext");
    expect(findMessageMatches(container, messageId, "nextreminder")).toEqual([]);
    expect(findMessageMatches(container, messageId, "bridgeRun")).toEqual([]);
    expect(findMessageMatches(container, messageId, "reminder").map(String)).toEqual(["reminder"]);
    expect(findMessageMatches(container, messageId, "typecheck next").map(String)).toEqual([
      "typecheck\nnext",
    ]);
    expect(findMessageMatches(container, messageId, "step orchid").map(String)).toEqual([
      "step\norchid",
    ]);
    act(() => viewport.clear());
  });

  it("restores only manually opened quotes when a history row remounts", async () => {
    const quote = (label: string) =>
      Array.from({ length: 20 }, (_, index) => `> ${label} line ${index}`).join("\n");
    const viewport = renderFindTranscript(
      `${quote("Search")}\n\n${quote("Manual")}\n\n${longText}`,
      createUserMessageExpansion(),
      true,
    );
    const readRow = (id = "message-1") =>
      container.querySelector<HTMLElement>(`[data-history-row-id="${id}"]`);
    const readQuotes = (id?: string) =>
      within(readRow(id)!).getAllByTestId("user-message-quote-block");
    const toggle = (card: HTMLElement) => within(card).getByTestId("user-message-quote-toggle");
    const expanded = (card: HTMLElement) => toggle(card).getAttribute("aria-expanded");
    const outerClamp = () => readRow()?.querySelector("[data-find-message-clipped]") ?? null;
    const quoteClamp = (card: HTMLElement) => card.querySelector("[data-find-quote-clipped]");

    await waitForLayout();
    viewport.jumpTo("message-1");
    await waitFor(() => expect(outerClamp()).not.toBeNull());
    const original = readQuotes();
    act(() => toggle(original[1]).click());
    await waitForLayout();
    viewport.jumpTo("message-50");
    await waitFor(() => expect(readRow()).toBeNull());
    expect(original[1].isConnected).toBe(false);
    await waitFor(() => expect(readQuotes("message-50").map(expanded)).toEqual(["false", "false"]));
    viewport.jumpTo("message-1");
    await waitFor(() => expect(readQuotes()).toHaveLength(2));
    await waitForLayout();

    const [searched, manual] = readQuotes();
    expect(manual).not.toBe(original[1]);
    expect(expanded(manual)).toBe("true");
    expect(quoteClamp(manual)).toBeNull();
    expect(quoteClamp(searched)).not.toBeNull();
    expect(outerClamp()).toBeNull();
    expect(
      await viewport.reveal("message-1", "Search line 19", 0, new AbortController().signal),
    ).toEqual({ occurrence: 0, count: 1 });
    expect(quoteClamp(searched)).toBeNull();
    expect(expanded(searched)).toBe("false");
    expect(findMessageMatches(container, "message-1", "Show more")).toEqual([]);

    act(() => viewport.clear());
    expect(quoteClamp(searched)).not.toBeNull();
    expect(quoteClamp(manual)).toBeNull();
    expect(outerClamp()).toBeNull();
    viewport.jumpTo("message-50");
    await waitFor(() => expect(readRow()).toBeNull());
    viewport.jumpTo("message-1");
    await waitFor(() => expect(readQuotes()).toHaveLength(2));
    const [searchedAfterClear, manualAfterClear] = readQuotes();
    expect(quoteClamp(searchedAfterClear)).not.toBeNull();
    expect(quoteClamp(manualAfterClear)).toBeNull();
    act(() => toggle(manualAfterClear).click());
    expect(outerClamp()).not.toBeNull();
    expect(
      await viewport.reveal("message-1", "Search line 19", 0, new AbortController().signal),
    ).toEqual({ occurrence: 0, count: 1 });
    expect(outerClamp()).toBeNull();
    act(() => viewport.clear());
    expect(outerClamp()).not.toBeNull();
    expect(quoteClamp(searchedAfterClear)).not.toBeNull();
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
