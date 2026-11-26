import { describe, expect, it } from "vitest";
import {
  appendQuoteAttachment,
  composePromptTextWithQuotes,
  createQuoteAttachment,
  formatQuoteAsMarkdownBlockquote,
  normalizeQuoteText,
} from "./quote";
import type { UserComposerAttachment } from "./types";

describe("quote attachments", () => {
  it("normalizes line endings and removes blank edge lines while keeping indentation", () => {
    expect(normalizeQuoteText(" \r\n\t\r  first  \r\n\r\n\tsecond\r  ")).toBe(
      "  first  \n\n\tsecond",
    );
    expect(normalizeQuoteText("\r\n  \t\r")).toBe("");
    expect(createQuoteAttachment({ id: "quote-1", text: "\n  example\n" })).toEqual({
      kind: "quote",
      id: "quote-1",
      text: "  example",
    });
  });

  it("appends each selection independently and ignores blank selections", () => {
    const current: readonly UserComposerAttachment[] = Object.freeze([
      createQuoteAttachment({ id: "first", text: "same passage" }),
    ]);
    expect(appendQuoteAttachment(current, " \n\t ")).toEqual(current);
    const second = appendQuoteAttachment(current, "\r\nsame passage\n");
    expect(second).toEqual([
      current[0],
      { kind: "quote", id: expect.any(String), text: "same passage" },
    ]);
    expect(second[1]).not.toHaveProperty("id", "first");
    expect(appendQuoteAttachment(second, "same passage")[2]).not.toEqual(second[1]);
  });

  it("quotes every line including empty lines and fenced code", () => {
    const text = ["Intro:", "", "```ts", "  const a = 1;", "```"].join("\n");
    expect(formatQuoteAsMarkdownBlockquote(text)).toBe(
      "> Intro:\n>\n> ```ts\n>   const a = 1;\n> ```",
    );
  });

  it("places ordered quotes before the prompt and supports quote-only messages", () => {
    const attachments: UserComposerAttachment[] = [
      createQuoteAttachment({ id: "first", text: "First" }),
      { kind: "workspace_file", path: "a.ts", selection: { kind: "whole_file" } },
      { kind: "quote", id: "blank", text: "\r\n\t " },
      createQuoteAttachment({ id: "second", text: "Second\n\n  line" }),
    ];
    const block = "> First\n\n> Second\n>\n>   line";
    expect(composePromptTextWithQuotes("  Compare these. \n", attachments)).toBe(
      block + "\n\nCompare these.",
    );
    expect(composePromptTextWithQuotes(" \t ", attachments)).toBe(block);
    expect(composePromptTextWithQuotes("  Unchanged. \n", attachments.slice(1, 3))).toBe(
      "  Unchanged. \n",
    );
  });
});

describe("quote attachment label", () => {
  it("stores a trimmed label and omits the field when there is none", () => {
    expect(createQuoteAttachment({ id: "a", text: "x", label: " Reviewer " })).toEqual({
      kind: "quote",
      id: "a",
      text: "x",
      label: "Reviewer",
    });
    expect("label" in createQuoteAttachment({ id: "b", text: "x" })).toBe(false);
    expect("label" in createQuoteAttachment({ id: "c", text: "x", label: "  " })).toBe(false);
  });

  it("appends a labeled quote", () => {
    const [quote] = appendQuoteAttachment([], "text", "Quote reply");
    expect(quote).toMatchObject({ kind: "quote", text: "text", label: "Quote reply" });
  });

  it("preserves optional topic source metadata and omits blank fields for backward compatibility", () => {
    expect(
      createQuoteAttachment({
        id: "t1",
        text: "Investigate timeout",
        label: "Network Lead",
        topicKey: " task:T-12 ",
        rootMessageId: " msg-root-1 ",
        taskId: " T-12 ",
        sourceMessageId: " rep-1 ",
      }),
    ).toEqual({
      kind: "quote",
      id: "t1",
      text: "Investigate timeout",
      label: "Network Lead",
      topicKey: "task:T-12",
      rootMessageId: "msg-root-1",
      taskId: "T-12",
      sourceMessageId: "rep-1",
    });

    const plain = createQuoteAttachment({
      id: "t2",
      text: "Plain quote",
      topicKey: "   ",
      taskId: "",
    });
    expect(plain).toEqual({ kind: "quote", id: "t2", text: "Plain quote" });
    expect("topicKey" in plain).toBe(false);
    expect("taskId" in plain).toBe(false);
    expect("rootMessageId" in plain).toBe(false);
    expect("sourceMessageId" in plain).toBe(false);

    const [appended] = appendQuoteAttachment([], "From topic", "Lead", {
      topicKey: "msg:m-42",
      rootMessageId: "m-42",
      sourceMessageId: "a-42",
    });
    expect(appended).toMatchObject({
      kind: "quote",
      text: "From topic",
      label: "Lead",
      topicKey: "msg:m-42",
      rootMessageId: "m-42",
      sourceMessageId: "a-42",
    });
  });
});
