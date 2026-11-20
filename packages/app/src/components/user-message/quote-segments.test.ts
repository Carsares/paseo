import { describe, expect, it } from "vitest";
import { parseUserMessageSegments } from "./quote-segments";

describe("parseUserMessageSegments", () => {
  it.each(["", "  Plain text\r\n\r\nWith 2 > 1.  \r", ">", "> \n\t>"])(
    "preserves the original text when there is no non-empty quote (%j)",
    (message) => {
      expect(parseUserMessageSegments(message)).toEqual([{ kind: "text", text: message }]);
    },
  );

  it("reads a historical inline reply with no blank lines around its quote", () => {
    expect(
      parseUserMessageSegments(
        "这个\n> 增加“展开全文 / 收起”按钮\n这个可以保证看到完整的输出内容吗",
      ),
    ).toEqual([
      { kind: "text", text: "这个" },
      { kind: "quote", quoteIndex: 1, text: "增加“展开全文 / 收起”按钮" },
      { kind: "text", text: "这个可以保证看到完整的输出内容吗" },
    ]);
  });

  it("preserves unformatted Python prompts even beside a genuine quote", () => {
    const code = ">>> 1 + 1\n2";
    expect(parseUserMessageSegments(`${code}\n\n> Real quote`)).toEqual([
      { kind: "text", text: code },
      { kind: "quote", quoteIndex: 1, text: "Real quote" },
    ]);
  });

  it("trims outer quote blanks and preserves quoted paragraph breaks", () => {
    expect(parseUserMessageSegments(">\n> first paragraph\n>\n> second paragraph\n>  ")).toEqual([
      { kind: "quote", quoteIndex: 1, text: "first paragraph\n\nsecond paragraph" },
    ]);
  });

  it.each([">", ">\n  > "])("preserves empty quote runs as text (%j)", (emptyQuote) => {
    expect(
      parseUserMessageSegments("> first quote\n \n" + emptyQuote + "\n\n> real quote"),
    ).toEqual([
      { kind: "quote", quoteIndex: 1, text: "first quote" },
      { kind: "text", text: emptyQuote },
      { kind: "quote", quoteIndex: 2, text: "real quote" },
    ]);
  });

  it.each(["    > output.log", "\t> output.log"])("preserves indented code (%j)", (code) => {
    expect(parseUserMessageSegments(code)).toEqual([{ kind: "text", text: code }]);
    expect(parseUserMessageSegments(code + "\n\n> real quote")).toEqual([
      { kind: "text", text: code },
      { kind: "quote", quoteIndex: 1, text: "real quote" },
    ]);
  });

  it("trims only text blanks next to quotes and normalizes mixed line endings", () => {
    expect(parseUserMessageSegments("\r\nFirst\r\n\r\nSecond\r \r   > Quote\n\nThird\r\n")).toEqual(
      [
        { kind: "text", text: "\nFirst\n\nSecond" },
        { kind: "quote", quoteIndex: 1, text: "Quote" },
        { kind: "text", text: "Third\n" },
      ],
    );
  });

  it.each([
    ["~~~", "```"],
    ["```", "~~~"],
  ])("ignores quote markers inside matching %s fences", (fence, otherFence) => {
    const code = ["  " + fence + "js", "> code", otherFence, "> still code", "  " + fence];
    const message = code.join("\r\n");
    expect(parseUserMessageSegments(message)).toEqual([{ kind: "text", text: message }]);
    expect(parseUserMessageSegments(message + "\r\n> real quote")).toEqual([
      { kind: "text", text: code.join("\n") },
      { kind: "quote", quoteIndex: 1, text: "real quote" },
    ]);
  });

  it("keeps an open fence until a fence of sufficient length closes it", () => {
    const message = "~~~~\n~~~\n> code";
    expect(parseUserMessageSegments(message)).toEqual([{ kind: "text", text: message }]);
  });
});
