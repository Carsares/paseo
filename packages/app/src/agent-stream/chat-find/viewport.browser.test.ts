import { afterEach, expect, it } from "vitest";
import { createFindViewport } from "./viewport.web";
import type { ChatFindProps } from "./types";
import type { StreamViewportHandle } from "../strategy";
import { createStreamPresentation } from "../presentation";
import type { ToolCallItem } from "@/types/stream";

interface Capture {
  occurrence?: { signal: AbortSignal; targetTop(): number | null };
}

function transcript(messageId: string, blocks: string[]): HTMLElement {
  const root = document.createElement("div");
  for (const [index, text] of blocks.entries()) {
    const row = document.createElement("div");
    row.setAttribute("data-history-row-id", `${messageId}:block:${index}`);
    row.setAttribute("data-message-id", messageId);
    row.innerHTML = `<div data-message-text="true"><div data-paseo-markdown-tag="p">${text}</div></div>`;
    root.append(row);
  }
  document.body.append(root);
  return root;
}

function viewport(root: HTMLElement, capture: Capture) {
  const handle: StreamViewportHandle = {
    scrollToBottom() {},
    prepareForViewportChange() {},
    holdRow(_rowId, apply) {
      apply();
    },
    scrollToMessage(_messageId, occurrence) {
      if (occurrence) capture.occurrence = occurrence;
    },
  };
  const bindings: Pick<ChatFindProps, "viewportRef" | "revealLoadedMessage" | "visibleMessageIds"> =
    {
      viewportRef: { current: handle },
      revealLoadedMessage: () => false,
      visibleMessageIds: new Set(["message-1"]),
    };
  return createFindViewport({
    getBindings: () => bindings,
    getRoot: () => root,
    highlightName: "paseo-chat-find-test",
  });
}

afterEach(() => {
  CSS.highlights.delete("paseo-chat-find-test");
  document.body.replaceChildren();
});

it("counts occurrences across every block row of the message", async () => {
  const root = transcript("message-1", ["needle one needle", "no hits", "needle three"]);
  const capture: Capture = {};
  const found = await viewport(root, capture).reveal(
    "message-1",
    "needle",
    2,
    new AbortController().signal,
  );
  expect(found).toEqual({ occurrence: 2, count: 3 });
});

// The settle loop asks for the target position every frame while the viewport moves,
// and rows mount and unmount as it does. A flat index into the message would name a
// different occurrence each time the row set changed; the chosen row owns it instead.
it("keeps the chosen occurrence when an earlier row unmounts mid-scroll", async () => {
  const root = transcript("message-1", ["needle one needle", "needle three"]);
  const capture: Capture = {};
  const found = await viewport(root, capture).reveal(
    "message-1",
    "needle",
    2,
    new AbortController().signal,
  );
  expect(found).toEqual({ occurrence: 2, count: 3 });

  const settled = capture.occurrence?.targetTop();
  expect(settled).toBeTypeOf("number");
  expect(highlightedText()).toEqual(["needle"]);
  expect(highlightedRow()).toBe("message-1:block:1");

  root.firstElementChild?.remove();
  expect(capture.occurrence?.targetTop()).toBeTypeOf("number");
  expect(highlightedRow()).toBe("message-1:block:1");
});

function highlightedRanges(): Range[] {
  const highlight = CSS.highlights.get("paseo-chat-find-test");
  return highlight ? Array.from(highlight).filter((range) => range instanceof Range) : [];
}

function highlightedText(): string[] {
  return highlightedRanges().map((range) => range.toString());
}

function highlightedRow(): string | undefined {
  const row =
    highlightedRanges()[0]?.startContainer.parentElement?.closest<HTMLElement>(
      "[data-history-row-id]",
    );
  return row?.dataset.historyRowId;
}

it("waits for an asynchronous renderer before counting its matches", async () => {
  const root = transcript("message-1", ["needle"]);
  const content = root.querySelector('[data-message-text="true"]')!;
  content.setAttribute("aria-busy", "true");
  let settled = false;
  const reveal = viewport(root, {})
    .reveal("message-1", "needle", 0, new AbortController().signal)
    .then((result) => {
      settled = true;
      return result;
    });
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  expect(settled).toBe(false);
  content.textContent = "needle and another needle";
  content.removeAttribute("aria-busy");
  expect(await reveal).toEqual({ occurrence: 0, count: 2 });
});

it("opens a settled source block and highlights the exact occurrence in its second report", async () => {
  const items = ["reviewer", "tester"].map(
    (id): ToolCallItem => ({
      kind: "tool_call",
      id,
      timestamp: new Date(0),
      turnId: "reports",
      payload: {
        source: "agent",
        data: {
          provider: "codex",
          callId: id,
          name: "agent_message",
          status: "completed",
          error: null,
          detail: { type: "unknown", input: null, output: null },
          agentMessage: {
            event: "message",
            reportStatus: "completed",
            sender: { id },
            text: `Report from ${id}, containing a needle.`,
          },
        },
      },
    }),
  );
  const present = createStreamPresentation();
  const input = {
    tail: items,
    head: [],
    transform: undefined,
    display: "collapseTurns" as const,
    isTurnActive: false,
  };
  let projected = present({ ...input, expandedTurnHostIds: new Set() });
  expect(projected.tail.map((item) => item.id)).toEqual(["turn-summary:reviewer"]);
  const viewportRef = { current: null };
  const root = document.createElement("div");
  document.body.append(root);
  const find = createFindViewport({
    getBindings: () => ({
      viewportRef,
      visibleMessageIds: new Set(projected.tail.map((item) => item.id)),
      revealLoadedMessage(messageId) {
        const host = projected.turns.hostIdByFoldedMessageId.get(messageId);
        if (!host) return false;
        projected = present({ ...input, expandedTurnHostIds: new Set([host]) });
        for (const item of projected.tail) {
          if (item.kind !== "user_message") continue;
          const message = transcript(item.id, [item.text]);
          root.append(...message.children);
          message.remove();
        }
        return true;
      },
    }),
    getRoot: () => root,
    highlightName: "paseo-chat-find-test",
  });
  const found = await find.reveal("tester", "needle", 0, new AbortController().signal);
  expect(found).toEqual({ occurrence: 0, count: 1 });
  expect(highlightedText()).toEqual(["needle"]);
  expect(highlightedRow()).toBe("tester:block:0");
});
