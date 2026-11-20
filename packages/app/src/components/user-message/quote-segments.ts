export type UserMessageSegment =
  | { kind: "quote"; quoteIndex: number; text: string }
  | { kind: "text"; text: string };

const QUOTE_LINE = /^ {0,3}>(?:[ \t](.*))?$/;
const FENCE_LINE = /^\s*(`{3,}|~{3,})(.*)$/;

function joinLines(lines: string[], trimStart: boolean, trimEnd: boolean): string {
  let start = 0;
  let end = lines.length;
  if (trimStart) {
    while (start < end && !lines[start].trim()) start++;
  }
  if (trimEnd) {
    while (end > start && !lines[end - 1].trim()) end--;
  }
  return lines.slice(start, end).join("\n");
}

export function parseUserMessageSegments(message: string): UserMessageSegment[] {
  const plain: UserMessageSegment = { kind: "text", text: message };
  if (!message.includes(">")) return [plain];

  const segments: UserMessageSegment[] = [];
  let textLines: string[] = [];
  const quoteLines: string[] = [];
  const rawQuoteLines: string[] = [];
  let quoteIndex = 0;
  let fence: string | undefined;

  function flushQuote() {
    if (!quoteLines.length) return;
    const quote = joinLines(quoteLines, true, true);
    if (!quote) {
      for (const line of rawQuoteLines) textLines.push(line);
    }
    quoteLines.length = 0;
    rawQuoteLines.length = 0;
    if (!quote) return;

    const text = joinLines(textLines, quoteIndex > 0, true);
    if (text) segments.push({ kind: "text", text });
    textLines = [];
    segments.push({ kind: "quote", quoteIndex: ++quoteIndex, text: quote });
  }

  for (const line of message.split(/\r\n|\r|\n/)) {
    const quoted = fence ? null : QUOTE_LINE.exec(line);
    if (quoted) {
      quoteLines.push(quoted[1] ?? "");
      rawQuoteLines.push(line);
      continue;
    }

    flushQuote();
    textLines.push(line);

    const marker = FENCE_LINE.exec(line);
    if (!marker) continue;
    const [, run, rest] = marker;
    if (fence) {
      if (run[0] === fence[0] && run.length >= fence.length && !rest.trim()) fence = undefined;
    } else if (run[0] === "~" || !rest.includes("`")) {
      fence = run;
    }
  }

  flushQuote();
  if (!quoteIndex) return [plain];

  const text = joinLines(textLines, true, false);
  if (text) segments.push({ kind: "text", text });
  return segments;
}
