/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { createElement, useEffect, type ReactNode } from "react";
import {
  KeyboardActionDispatcherProvider,
  useKeyboardActionDispatcher,
} from "@/keyboard/keyboard-action-dispatcher-context";
import { describe, expect, it, vi } from "vitest";
import {
  appendQuoteToDraft,
  ComposerQuoteProvider,
  QuoteTopicProvider,
  useComposerQuote,
} from "./composer-quote";

describe("ComposerQuoteProvider", () => {
  it("offers an attachment to the active composer before focusing the input", () => {
    const calls: string[] = [];
    function ObserveFocus({ children }: { children?: ReactNode }) {
      const dispatcher = useKeyboardActionDispatcher();
      useEffect(
        () =>
          dispatcher.registerHandler({
            handlerId: "test-composer-focus",
            actions: ["message-input.focus"],
            enabled: true,
            priority: 0,
            handle: (action) => {
              calls.push(action.scope);
              return true;
            },
          }),
        [dispatcher],
      );
      return children;
    }
    const { result } = renderHook(useComposerQuote, {
      wrapper: ({ children }) =>
        createElement(
          KeyboardActionDispatcherProvider,
          null,
          createElement(
            ObserveFocus,
            null,
            createElement(
              ComposerQuoteProvider,
              {
                target: { addQuoteAttachment: (quote) => calls.push(quote) },
              },
              children,
            ),
          ),
        ),
    });
    result.current?.addQuote({ quote: "Selected text" });
    expect(calls).toEqual(["Selected text", "message-input"]);
  });

  it("merges ambient QuoteTopicProvider metadata and preserves explicit overrides", () => {
    const addQuoteAttachment = vi.fn();
    const { result } = renderHook(useComposerQuote, {
      wrapper: ({ children }) =>
        createElement(
          KeyboardActionDispatcherProvider,
          null,
          createElement(
            ComposerQuoteProvider,
            { target: { addQuoteAttachment } },
            createElement(
              QuoteTopicProvider,
              { topic: { topicKey: "task:T-1", taskId: "T-1", rootMessageId: "m-1" } },
              children,
            ),
          ),
        ),
    });

    result.current?.addQuote({ quote: "From topic card", label: "Lead" });
    expect(addQuoteAttachment).toHaveBeenLastCalledWith("From topic card", "Lead", {
      topicKey: "task:T-1",
      taskId: "T-1",
      rootMessageId: "m-1",
    });

    result.current?.addQuote({
      quote: "Specific reply",
      label: "Lead",
      sourceMessageId: "reply-9",
    });
    expect(addQuoteAttachment).toHaveBeenLastCalledWith("Specific reply", "Lead", {
      topicKey: "task:T-1",
      taskId: "T-1",
      rootMessageId: "m-1",
      sourceMessageId: "reply-9",
    });
  });
});

describe("appendQuoteToDraft", () => {
  it("starts an empty draft with the quote and the note under it", () => {
    expect(appendQuoteToDraft({ draft: "", quote: "First line", note: "Why this?" })).toBe(
      "> First line\n\nWhy this?",
    );
  });

  it("quotes every line, blank lines and fences included", () => {
    const quote = "Intro:\n\n```ts\nconst a = 1;\n```";

    expect(appendQuoteToDraft({ draft: "", quote, note: "" })).toBe(
      "> Intro:\n>\n> ```ts\n> const a = 1;\n> ```\n\n",
    );
  });

  it("puts the quote after a blank line below the existing draft", () => {
    expect(
      appendQuoteToDraft({ draft: "> Earlier\n\nFirst note\n\n", quote: "Later", note: "Second" }),
    ).toBe("> Earlier\n\nFirst note\n\n> Later\n\nSecond");
  });

  it("ends on an empty paragraph without a note, so typing does not continue the quote", () => {
    expect(appendQuoteToDraft({ draft: "Hi", quote: "Passage", note: "  \n" })).toBe(
      "Hi\n\n> Passage\n\n",
    );
  });

  it("keeps the line breaks inside the note", () => {
    expect(appendQuoteToDraft({ draft: "", quote: "Passage", note: "One\nTwo" })).toBe(
      "> Passage\n\nOne\nTwo",
    );
  });
});
