import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TopicReplyItem } from "./model";
import { TopicReplyRow } from "./topic-reply-row";

vi.mock("@/constants/layout", async (original) => ({
  ...(await original<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
  vi.unstubAllGlobals();
});

function report(id: string, text: string): TopicReplyItem {
  return {
    kind: "subagent_report",
    id,
    senderId: id,
    senderTitle: "Network Lead",
    status: "completed",
    text,
    epoch: null,
    seq: null,
    timestampMs: 0,
    isUnread: false,
  };
}

function selectText(start: HTMLElement, end: HTMLElement, endOffset: number) {
  const range = document.createRange();
  range.setStart(start.firstChild!, 0);
  range.setEnd(end.firstChild!, endOffset);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

it("quotes only the selected text in its own reply body and falls back to the reply summary", async () => {
  const onQuote = vi.fn();
  const props = { onQuote, onOpenAgentBeside: vi.fn(), onConvertToTodo: vi.fn() };
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <TopicReplyRow
        {...props}
        reply={report("one", "Here is **selected text**.")}
        topicKey="first"
      />
      <TopicReplyRow
        {...props}
        reply={report("two", "Here is **other text**.")}
        topicKey="second"
      />
    </QueryClientProvider>,
  );
  const first = await view.findByText("selected text", { selector: "strong" });
  const second = await view.findByText("other text", { selector: "strong" });
  const quote = view.getByTestId("topic-reply-quote-one");
  const pressQuote = () => {
    fireEvent.pointerDown(quote, { button: 0, pointerType: "mouse" });
    window.getSelection()?.removeAllRanges();
    fireEvent.click(quote);
  };

  selectText(first, first, 8);
  pressQuote();
  expect(onQuote).toHaveBeenLastCalledWith({ quote: "selected", label: "Network Lead" });

  selectText(first, second, 5);
  pressQuote();
  expect(onQuote).toHaveBeenLastCalledWith({
    quote: "[Network Lead] Here is **selected text**.",
    label: "Network Lead",
  });

  selectText(second, second, 5);
  pressQuote();
  expect(onQuote).toHaveBeenLastCalledWith({
    quote: "[Network Lead] Here is **selected text**.",
    label: "Network Lead",
  });
});

function silentReport(text: string): TopicReplyItem {
  return {
    kind: "thread_entry",
    id: "silent",
    threadSeq: 1,
    seq: null,
    timestampMs: 0,
    isUnread: false,
    entry: {
      entryId: "silent",
      workspaceId: "workspace",
      mainAgentId: "main",
      topicKey: "topic",
      routedAgentId: "main",
      authorTitle: "Reviewer",
      role: "agent_reply",
      status: "completed",
      origin: "subagent_report",
      seq: 1,
      createdAt: "2026-11-26T00:00:00.000Z",
      updatedAt: "2026-11-26T00:00:00.000Z",
      text,
    },
  };
}

it("renders a long silent report as plain preview and restores complete Markdown on expansion", async () => {
  const copy = "**Short conclusion**\n\n" + "Detail ".repeat(45) + "\n\n**Final evidence**";
  const reply = silentReport(copy);
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <TopicReplyRow reply={reply} onOpenAgentBeside={vi.fn()} onConvertToTodo={vi.fn()} />
    </QueryClientProvider>,
  );
  const row = within(view.getByTestId("topic-reply-thread-silent"));
  expect(row.getByText(/^Short conclusion Detail/).textContent?.length).toBeLessThanOrEqual(260);
  expect(row.queryByText("Final evidence")).toBeNull();
  expect(row.queryByText(/\*\*Short conclusion/)).toBeNull();

  fireEvent.click(row.getByTestId("topic-reply-expand-silent"));
  expect(await row.findByText("Final evidence", { selector: "strong" })).toBeTruthy();
});
