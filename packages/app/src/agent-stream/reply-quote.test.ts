import { describe, expect, it } from "vitest";
import {
  extractReplyQuoteSummary,
  extractScopedWebSelection,
  extractSubagentPreviewText,
  resolveSourceDisplayTitle,
  stripReplyTemplate,
} from "./reply-quote";

const UUID = "3f2b8a1e-9c4d-4e6f-8a7b-1c2d3e4f5a6b";

describe("stripReplyTemplate", () => {
  it("removes the report prefix, status line, server line and response wrapper", () => {
    const raw = [
      "Report to parent (completed):",
      "",
      "Agent child-1 (Reviewer) finished.",
      "",
      "Server: srv-1",
      "",
      "<agent-response>",
      "All checks pass.",
      "</agent-response>",
    ].join("\n");

    expect(stripReplyTemplate(raw)).toBe("All checks pass.");
  });

  it("keeps the text that follows an inline report prefix", () => {
    expect(stripReplyTemplate("Report to parent (blocked): Which API?")).toBe("Which API?");
  });

  it("drops thinking blocks, unclosed thinking and fenced code", () => {
    const raw = [
      "<thinking>private\nreasoning</thinking>",
      "Result is ready.",
      "```ts",
      "const noisy = 1;",
      "```",
      "Done.",
      "<thinking>never closed",
    ].join("\n");

    expect(stripReplyTemplate(raw)).toBe("Result is ready.\n\nDone.");
  });

  it("drops an unterminated fence through the end of the text", () => {
    expect(stripReplyTemplate("Intro\n```\ncode that never closes")).toBe("Intro");
  });

  it("collapses runs of blank lines and trailing spaces", () => {
    expect(stripReplyTemplate("a   \n\n\n\n\nb  ")).toBe("a\n\nb");
  });

  it("drops the truncation note the daemon appends inside a report", () => {
    expect(
      stripReplyTemplate(
        [
          "Agent child-1 (Reviewer) finished.",
          "",
          "<agent-response>",
          "Body",
          "[truncated 120 chars; use get_agent_activity for the full response]",
          "</agent-response>",
        ].join("\n"),
      ),
    ).toBe("Body");
  });

  it("strips untitled server finish notifications without leaving the UUID", () => {
    const raw = [
      `Agent ${UUID} finished.`,
      "",
      "Server: srv-1",
      "",
      "<agent-response>",
      "Build succeeded.",
      "</agent-response>",
    ].join("\n");

    expect(stripReplyTemplate(raw)).toBe("Build succeeded.");
    expect(stripReplyTemplate(`Agent ${UUID} finished.\n\nServer: srv-1`)).toBe("");
    expect(stripReplyTemplate(`Agent ${UUID} was closed.\n\nServer: srv-1`)).toBe("");
    expect(stripReplyTemplate(`Agent ${UUID} is unavailable.\n\nServer: srv-1`)).toBe("");
    expect(stripReplyTemplate(`Agent ${UUID} was canceled.\n\nServer: srv-1`)).toBe("");
  });

  it("handles empty fenced code blocks without eating following prose", () => {
    const raw = ["Before.", "```", "```", "After."].join("\n");
    expect(stripReplyTemplate(raw)).toBe("Before.\n\nAfter.");
  });

  it("does not treat inline triple backticks as an opening code fence", () => {
    const raw = "Use ```code``` inline when quoting snippets.\nSecond line stays intact.";
    expect(stripReplyTemplate(raw)).toBe(raw);
  });

  it("preserves ordinary prose lines that start with Server: or look like Agent status", () => {
    const raw = "Deployment summary:\nServer: prod-us-east-1\nStatus: healthy";
    expect(stripReplyTemplate(raw)).toBe(raw);
    expect(stripReplyTemplate("Agent mode finished.")).toBe("Agent mode finished.");
  });

  it("preserves Server: and status-like lines inside explicit report_to_parent summaries", () => {
    const raw = [
      "Report to parent (completed):",
      "",
      "Server: API restored.",
      "Agent mode finished.",
    ].join("\n");
    expect(stripReplyTemplate(raw)).toBe("Server: API restored.\nAgent mode finished.");
  });

  it("strips finish notifications whose recorded title contains a newline", () => {
    const raw = [
      `Agent ${UUID} (Line one\nLine two) finished.`,
      "",
      "Server: srv-1",
      "",
      "<agent-response>",
      "Actual conclusion.",
      "</agent-response>",
    ].join("\n");
    expect(stripReplyTemplate(raw)).toBe("Actual conclusion.");
    expect(
      stripReplyTemplate(`Agent ${UUID} (Line one\nLine two) finished.\n\nServer: srv-1`),
    ).toBe("");
  });

  it("does not let a literal <thinking> tag inside a fenced code block swallow following prose", () => {
    const raw = [
      "Example:",
      "```xml",
      "<thinking>",
      "demo only",
      "```",
      "Real conclusion after code.",
    ].join("\n");
    expect(stripReplyTemplate(raw)).toBe("Example:\n\nReal conclusion after code.");
  });

  it("keeps prose after a literal </agent-response> inside a fenced code block of a finish notification", () => {
    const raw = [
      `Agent ${UUID} (Reviewer) finished.`,
      "",
      "Server: srv-1",
      "",
      "<agent-response>",
      "Parsed tag example:",
      "```xml",
      "</agent-response>",
      "```",
      "Final conclusion after fence.",
      "</agent-response>",
    ].join("\n");
    expect(stripReplyTemplate(raw)).toBe("Parsed tag example:\n\nFinal conclusion after fence.");
  });

  it("preserves trailing prose in an explicit report that begins with an inline <agent-response> example", () => {
    const raw = [
      "Report to parent (completed):",
      "",
      "<agent-response>Example.</agent-response>",
      "",
      "Remaining summary stays intact.",
    ].join("\n");
    expect(stripReplyTemplate(raw)).toBe(
      "<agent-response>Example.</agent-response>\n\nRemaining summary stays intact.",
    );
  });

  it("preserves ordinary prose combining 'Agent mode finished.' with a 'Server: ...' paragraph", () => {
    const raw = "Agent mode finished.\n\nServer: API restored.";
    expect(stripReplyTemplate(raw)).toBe(raw);
  });
});

describe("resolveSourceDisplayTitle", () => {
  it("prefers the live title over the sender title", () => {
    expect(
      resolveSourceDisplayTitle({ liveTitle: " Live ", senderTitle: "Old", id: "child-12345" }),
    ).toBe("Live");
  });

  it("falls back to the sender title when there is no live title", () => {
    expect(
      resolveSourceDisplayTitle({ liveTitle: null, senderTitle: "Old", id: "child-12345" }),
    ).toBe("Old");
  });

  it("ignores titles that equal the id or look like a UUID", () => {
    expect(
      resolveSourceDisplayTitle({ liveTitle: "child-12345", senderTitle: UUID, id: "child-12345" }),
    ).toBe("child-12");
    expect(resolveSourceDisplayTitle({ liveTitle: UUID.toUpperCase(), id: UUID })).toBe("3f2b8a1e");
  });

  it("falls back to an 8 character short id", () => {
    expect(resolveSourceDisplayTitle({ id: "abcdef0123456789" })).toBe("abcdef01");
    expect(resolveSourceDisplayTitle({ liveTitle: "  ", senderTitle: "", id: "xyz" })).toBe("xyz");
  });
});

describe("extractSubagentPreviewText", () => {
  it("returns compact plain text without template, markdown marks or code", () => {
    const raw = [
      "Report to parent (completed):",
      "",
      "## Summary",
      "- **Fixed** the `parser` bug",
      "- See [docs](https://example.com)",
      "```",
      "noise",
      "```",
    ].join("\n");

    expect(extractSubagentPreviewText(raw)).toBe("Summary Fixed the parser bug See docs");
  });

  it("truncates long text with an ellipsis within maxLength", () => {
    const preview = extractSubagentPreviewText("word ".repeat(100), 40);
    expect(Array.from(preview).length).toBeLessThanOrEqual(40);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("returns an empty string for template-only text", () => {
    expect(extractSubagentPreviewText("Agent a (b) finished.\n\nServer: s")).toBe("");
  });
});

describe("extractReplyQuoteSummary", () => {
  it("keeps a reply of 200 characters or fewer as written", () => {
    const text = "x".repeat(200);
    expect(extractReplyQuoteSummary(text)).toBe(text);
  });

  it("strips the template before measuring length", () => {
    const text = `<agent-response>\n${"y".repeat(150)}\n</agent-response>`;
    expect(extractReplyQuoteSummary(text)).toBe("y".repeat(150));
  });

  it("cuts a long reply at a sentence end inside the 160–200 window", () => {
    const sentence = `${"a".repeat(58)}. `;
    const result = extractReplyQuoteSummary(sentence.repeat(8));

    expect(result.endsWith(".…")).toBe(true);
    expect(Array.from(result).length).toBeGreaterThanOrEqual(160);
    expect(Array.from(result).length).toBeLessThanOrEqual(200);
  });

  it("cuts at a Chinese sentence end", () => {
    const sentence = `${"字".repeat(59)}。`;
    const result = extractReplyQuoteSummary(sentence.repeat(8));

    expect(result.endsWith("。…")).toBe(true);
    expect(Array.from(result)).toHaveLength(181);
  });

  it("keeps the leading heading and first sentence when they fit within maxLength", () => {
    const text = `## Findings\n\nRoot cause confirmed in router. ${"c".repeat(110)}. ${"d".repeat(120)}`;
    const result = extractReplyQuoteSummary(text);

    expect(result).toBe("## Findings\nRoot cause confirmed in router.…");
  });

  it("does not cut a hard-wrapped Markdown first sentence in half at a single newline", () => {
    const text = [
      "## Findings",
      "",
      "First clause of the sentence",
      "continues on the next line.",
      "",
      "d".repeat(220),
    ].join("\n");
    const result = extractReplyQuoteSummary(text);

    expect(result).toBe("## Findings\nFirst clause of the sentence\ncontinues on the next line.…");
  });

  it("cuts a heading with an overlong first sentence at a natural boundary inside 160–200", () => {
    const text = `## Findings\n\n${"b".repeat(190)} ${"d".repeat(80)}`;
    const result = extractReplyQuoteSummary(text);

    expect(result.startsWith("## Findings\n")).toBe(true);
    expect(result.endsWith("…")).toBe(true);
    expect(Array.from(result).length).toBeLessThanOrEqual(200);
  });

  it("falls back to a character boundary when there is no sentence end", () => {
    const result = extractReplyQuoteSummary("z".repeat(500));
    expect(Array.from(result)).toHaveLength(200);
    expect(result.endsWith("…")).toBe(true);
  });

  it("cuts at whitespace when the window has no sentence end", () => {
    const result = extractReplyQuoteSummary("lorem ".repeat(100));
    expect(result.endsWith("lorem…")).toBe(true);
    expect(Array.from(result).length).toBeLessThanOrEqual(200);
  });

  it("does not treat a decimal point as a sentence end", () => {
    const text = `${"n".repeat(170)}3.14${"m".repeat(100)}`;
    const result = extractReplyQuoteSummary(text);
    expect(result).not.toMatch(/3\.…$/);
  });

  it("prefixes the source title", () => {
    expect(extractReplyQuoteSummary("Done.", { sourceTitle: " Reviewer " })).toBe(
      "[Reviewer] Done.",
    );
  });

  it("returns an empty string when nothing is quotable, even with a title", () => {
    expect(extractReplyQuoteSummary("<thinking>x</thinking>", { sourceTitle: "T" })).toBe("");
  });
});

describe("extractScopedWebSelection", () => {
  it("returns null without a container or in a non-browser environment", () => {
    expect(extractScopedWebSelection(null)).toBeNull();
  });
});
