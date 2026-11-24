/**
 * Pure text helpers for subagent report cards and quote-reply.
 *
 * Subagent reports reach the parent as prompts wrapped in a template
 * (`Report to parent (...)`, `Agent <id> (...) finished.`, `<agent-response>`). The helpers here
 * remove that wrapper and the bulky parts (thinking, fenced code) so a card or a composer quote
 * carries the conclusion rather than the plumbing.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_LENGTH = 8;

const DEFAULT_PREVIEW_LENGTH = 160;
const DEFAULT_QUOTE_LENGTH = 200;
const QUOTE_WINDOW_MIN = 160;
const DEFAULT_SELECTION_LENGTH = 500;
const ELLIPSIS = "…";

const THINKING_BLOCK = /<thinking>[\s\S]*?<\/thinking>/gi;
const UNCLOSED_THINKING = /<thinking>[\s\S]*$/i;
const PERMISSION_BLOCK = /<permission-request>[\s\S]*?<\/permission-request>/gi;
const AGENT_RESPONSE_OUTER =
  /^[ \t]*<agent-response>[ \t]*\n([\s\S]*)\n[ \t]*<\/agent-response>[ \t]*$/i;
const AGENT_RESPONSE_OPEN = /^[ \t]*<agent-response>[ \t]*$/i;
const AGENT_RESPONSE_CLOSE = /^[ \t]*<\/agent-response>[ \t]*$/i;
const AGENT_RESPONSE_TAG = /<\/?agent-response>/gi;
const REPORT_PREFIX = /^[ \t]*Report to parent[ \t]*(?:\((?:completed|blocked)\))?[ \t]*:[ \t]*/i;
const FINISH_REASON_PATTERN =
  "(?:finished|errored|needs permission|is unavailable|was closed|was canceled)";
const AGENT_STATUS_WITH_TITLE_LINE = new RegExp(
  `^[ \\t]*Agent[ \\t]+\\S+[ \\t]+\\([\\s\\S]*?\\)[ \\t]+${FINISH_REASON_PATTERN}\\.?[ \\t]*$`,
  "i",
);
const AGENT_STATUS_UNTITLED_LINE = new RegExp(
  `^[ \\t]*Agent[ \\t]+(\\S+)[ \\t]+${FINISH_REASON_PATTERN}\\.?[ \\t]*$`,
  "i",
);
const HOST_UNAVAILABLE_LINE =
  /^[ \t]*(?:Host[ \t]+\S+[ \t]+was removed or is unavailable\.|Could not observe child agent[ \t]+\S+[ \t]+on host[ \t]+\S+[ \t]+after three failed attempts\.)[ \t]*$/i;
const STATUS_UNKNOWN_LINE =
  /^[ \t]*Status of child agent[ \t]+\S+(?:[ \t]+\([\s\S]*?\))?[ \t]+is unknown\.[ \t]*$/i;
const SUBSCRIPTION_ENDED_LINE = /^[ \t]*This finish subscription has ended\.[^\n]*$/i;
const PERMISSION_INSTRUCTION_LINE = /^[ \t]*Respond with `respond_to_permission`[^\n]*$/i;
const SERVER_LINE = /^[ \t]*Server:[ \t]*\S+[ \t]*$/i;
const TRUNCATION_NOTE = /^[ \t]*\[truncated \d+ chars;[^\]\n]*\][ \t]*$/i;
const HEADING_LINE = /^#{1,3}[ \t]+\S/;
const FENCE_OPEN_LINE = /^[ \t]*(`{3,}|~{3,})(.*)$/;

function stripFencedCodeBlocks(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let activeFence: { char: "`" | "~"; length: number } | null = null;

  for (const line of lines) {
    if (activeFence) {
      const closeMatch = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (
        closeMatch &&
        closeMatch[1]![0] === activeFence.char &&
        closeMatch[1]!.length >= activeFence.length
      ) {
        activeFence = null;
        output.push("");
      }
      continue;
    }
    const openMatch = FENCE_OPEN_LINE.exec(line);
    if (openMatch) {
      const marker = openMatch[1]!;
      const info = openMatch[2] ?? "";
      const char = marker[0] as "`" | "~";
      // CommonMark: backtick info strings cannot contain backticks (prevents inline ```code```).
      if (char === "~" || !info.includes("`")) {
        activeFence = { char, length: marker.length };
        continue;
      }
    }
    output.push(line);
  }
  return output.join("\n");
}

function looksLikeAgentIdToken(token: string): boolean {
  return isUuidLike(token) || /[\d_-]/.test(token);
}

function isUntitledAgentStatusLine(line: string): boolean {
  const match = AGENT_STATUS_UNTITLED_LINE.exec(line);
  if (!match) return false;
  return looksLikeAgentIdToken(match[1] ?? "");
}

function isFinishNotificationHeaderParagraph(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  if (!trimmed) return true;
  return (
    AGENT_STATUS_WITH_TITLE_LINE.test(trimmed) ||
    isUntitledAgentStatusLine(trimmed) ||
    HOST_UNAVAILABLE_LINE.test(trimmed) ||
    STATUS_UNKNOWN_LINE.test(trimmed) ||
    SUBSCRIPTION_ENDED_LINE.test(trimmed) ||
    PERMISSION_INSTRUCTION_LINE.test(trimmed) ||
    SERVER_LINE.test(trimmed)
  );
}

function stripBodyNoise(text: string): string {
  // Isolate fenced code blocks BEFORE stripping XML tags so a literal `<thinking>` inside
  // a code example never swallows prose that follows the code block.
  return stripFencedCodeBlocks(text)
    .replace(THINKING_BLOCK, "")
    .replace(UNCLOSED_THINKING, "")
    .replace(PERMISSION_BLOCK, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTruncationNotes(text: string): string {
  return text
    .split("\n")
    .filter((line) => !TRUNCATION_NOTE.test(line))
    .join("\n");
}

/**
 * Extracts the inner response when `normalized` is a full `<agent-response>` wrapper (optionally
 * preceded only by finish-notification header paragraphs). Uses the outer start/end tags anchored
 * to the end of the message so a literal `</agent-response>` inside a fenced code block does not
 * truncate the real conclusion that follows it.
 */
function extractResponseBlockFromFinishShell(normalized: string): string | null {
  const trimmed = normalized.trim();
  if (!trimmed) return null;

  const openMatch = /(?:^|\n)[ \t]*<agent-response>[ \t]*\n/i.exec(trimmed);
  if (!openMatch) return null;

  const openIndex = openMatch.index + (openMatch[0].startsWith("\n") ? 1 : 0);
  const before = trimmed.slice(0, openIndex).trim();
  const responseSection = trimmed.slice(openIndex);
  const outerMatch = AGENT_RESPONSE_OUTER.exec(responseSection);
  if (!outerMatch) return null;

  const beforeParagraphs = before ? before.split(/\n{2,}/) : [];
  if (beforeParagraphs.every((p) => isFinishNotificationHeaderParagraph(p))) {
    return stripTruncationNotes(outerMatch[1] ?? "");
  }
  return null;
}

function unwrapReportShell(normalized: string): { text: string; isFinishNotification: boolean } {
  const leading = normalized.trimStart();
  // 1. Explicit `report_to_parent` message: strip only its leading prefix, preserving all
  //    caller-authored summary content verbatim (including lines like `Server: API restored.` or
  //    leading `<agent-response>...</agent-response>` examples with trailing prose). Only unwrap
  //    when the entire post-prefix payload is a complete finish-notification `<agent-response>`
  //    shell.
  if (REPORT_PREFIX.test(leading)) {
    const afterPrefix = leading.replace(REPORT_PREFIX, "");
    const nestedResponse = extractResponseBlockFromFinishShell(afterPrefix);
    return {
      text: nestedResponse ?? afterPrefix,
      isFinishNotification: nestedResponse !== null,
    };
  }

  // 2. Automatic finish notification with a trailing `<agent-response>...</agent-response>` block.
  const directResponse = extractResponseBlockFromFinishShell(normalized);
  if (directResponse !== null) {
    return {
      text: directResponse,
      isFinishNotification: true,
    };
  }

  // 3. Automatic finish notification without `<agent-response>` (e.g., status-only, closed,
  //    or permission request). Never treat ordinary prose such as "Agent mode finished." as a
  //    status header, even if followed by a "Server: ..." paragraph.
  const paragraphs = normalized.split(/\n{2,}/);
  const firstParagraph = paragraphs[0]?.trim() ?? "";
  const startsWithFinishHeader =
    AGENT_STATUS_WITH_TITLE_LINE.test(firstParagraph) ||
    isUntitledAgentStatusLine(firstParagraph) ||
    HOST_UNAVAILABLE_LINE.test(firstParagraph) ||
    AGENT_RESPONSE_OPEN.test(firstParagraph);

  if (startsWithFinishHeader) {
    const remaining: string[] = [];
    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim();
      if (
        !trimmed ||
        isFinishNotificationHeaderParagraph(trimmed) ||
        AGENT_RESPONSE_OPEN.test(trimmed) ||
        AGENT_RESPONSE_CLOSE.test(trimmed)
      ) {
        continue;
      }
      remaining.push(stripTruncationNotes(paragraph.replace(AGENT_RESPONSE_TAG, "")));
    }
    return {
      text: remaining.join("\n\n"),
      isFinishNotification: true,
    };
  }

  // 4. Ordinary assistant or user prose.
  return { text: normalized, isFinishNotification: false };
}

function takeChars(text: string, count: number): string {
  const chars = Array.from(text);
  return chars.length <= count ? text : chars.slice(0, count).join("");
}

function charLength(text: string): number {
  return Array.from(text).length;
}

export function isUuidLike(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * The title a source card shows: the live agent title, then the title recorded in the message,
 * skipping empty values and ones that are only the agent's id (older reports stored the id).
 * Falls back to the first 8 characters of the id.
 */
export function resolveSourceDisplayTitle(input: {
  liveTitle?: string | null;
  senderTitle?: string | null;
  id: string;
}): string {
  const { id } = input;
  for (const candidate of [input.liveTitle, input.senderTitle]) {
    const title = candidate?.trim();
    if (!title || title === id || isUuidLike(title)) continue;
    return title;
  }
  return id.slice(0, SHORT_ID_LENGTH);
}

/** Removes the report template, thinking blocks and fenced code; normalizes whitespace. */
export function stripReplyTemplate(rawText: string): string {
  const normalized = rawText.replace(/\r\n?/g, "\n");
  const { text } = unwrapReportShell(normalized);
  return stripBodyNoise(text);
}

function stripMarkdownMarks(line: string): string {
  return line
    .replace(/^[ \t]*#{1,6}[ \t]+/, "")
    .replace(/^[ \t]*>[ \t]?/, "")
    .replace(/^[ \t]*[-*+][ \t]+/, "")
    .replace(/^[ \t]*\d+[.)][ \t]+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/, "");
}

function truncateWithEllipsis(text: string, maxLength: number): string {
  if (charLength(text) <= maxLength) return text;
  return `${takeChars(text, Math.max(0, maxLength - 1)).trimEnd()}${ELLIPSIS}`;
}

/** One or two lines of plain conclusion text for a collapsed subagent report card. */
export function extractSubagentPreviewText(
  rawText: string,
  maxLength: number = DEFAULT_PREVIEW_LENGTH,
): string {
  const compact = stripReplyTemplate(rawText)
    .split("\n")
    .map(stripMarkdownMarks)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateWithEllipsis(compact, maxLength);
}

function isSentenceEnd(chars: readonly string[], index: number): boolean {
  const char = chars[index];
  if (char === "。" || char === "！" || char === "？") return true;
  // Treat a blank-line paragraph break (`\n\n`) as a sentence boundary, but not a single
  // hard-wrapped line break inside a Markdown paragraph.
  if (char === "\n") {
    return chars[index + 1] === "\n";
  }
  if (char === "." || char === "!" || char === "?") {
    const next = chars[index + 1];
    return next === undefined || /\s/.test(next);
  }
  return false;
}

function cutAtNaturalBoundary(text: string, maxLength: number): string {
  const chars = Array.from(text);
  // Leave one slot for the ellipsis so the result never exceeds `maxLength`.
  const limit = maxLength - 1;
  const windowStart = Math.min(QUOTE_WINDOW_MIN, limit) - 1;
  for (let index = limit - 1; index >= windowStart; index--) {
    if (isSentenceEnd(chars, index)) {
      return `${chars
        .slice(0, index + 1)
        .join("")
        .trimEnd()}${ELLIPSIS}`;
    }
  }
  for (let index = limit; index > windowStart; index--) {
    if (/\s/.test(chars[index] ?? "")) {
      return `${chars.slice(0, index).join("").trimEnd()}${ELLIPSIS}`;
    }
  }
  return `${chars.slice(0, limit).join("").trimEnd()}${ELLIPSIS}`;
}

function findFirstSentenceEnd(chars: readonly string[], startIndex: number): number {
  for (let index = startIndex; index < chars.length; index++) {
    if (isSentenceEnd(chars, index)) return index;
  }
  return -1;
}

/**
 * A 160–200 character quote of a reply.
 *
 * A short reply is kept whole. When a longer reply opens with a heading (`#`/`##`/`###`), it
 * prefers keeping that heading plus the first sentence under it when they fit within `maxLength`,
 * otherwise it cuts at a sentence end inside the 160–200 window.
 */
export function extractReplyQuoteSummary(
  rawText: string,
  options: { sourceTitle?: string; maxLength?: number } = {},
): string {
  const maxLength = Math.max(2, options.maxLength ?? DEFAULT_QUOTE_LENGTH);
  const cleaned = stripReplyTemplate(rawText);
  if (!cleaned) return "";
  let body = cleaned;
  if (charLength(cleaned) > maxLength) {
    const firstLine = cleaned.split("\n", 1)[0] ?? "";
    if (HEADING_LINE.test(firstLine)) {
      const candidate = cleaned.replace(/^([^\n]*)\n+/, "$1\n");
      const headingLength = charLength(firstLine);
      const chars = Array.from(candidate);
      const bodyStart = headingLength + 1;
      const firstSentenceEnd =
        bodyStart < chars.length ? findFirstSentenceEnd(chars, bodyStart) : -1;
      if (firstSentenceEnd !== -1 && firstSentenceEnd + 1 <= maxLength - 1) {
        const leading = chars
          .slice(0, firstSentenceEnd + 1)
          .join("")
          .trimEnd();
        const hasMore =
          chars
            .slice(firstSentenceEnd + 1)
            .join("")
            .trim().length > 0;
        body = hasMore ? `${leading}${ELLIPSIS}` : leading;
      } else {
        body = cutAtNaturalBoundary(candidate, maxLength);
      }
    } else {
      body = cutAtNaturalBoundary(cleaned, maxLength);
    }
  }
  const title = options.sourceTitle?.trim();
  return title ? `[${title}] ${body}` : body;
}

/**
 * The browser's non-empty selection when both of its ends lie inside `container`, trimmed to
 * `maxLength`; otherwise `null`. A list of containers (the rows of one message) counts as one
 * scope when each end of the selection is inside any of them. Callers gate on `isWeb`; outside a
 * browser this returns `null`.
 */
export function extractScopedWebSelection(
  container: HTMLElement | readonly HTMLElement[] | null,
  maxLength: number = DEFAULT_SELECTION_LENGTH,
): string | null {
  if (!container || typeof window === "undefined" || typeof window.getSelection !== "function") {
    return null;
  }
  const containers = "length" in container ? container : [container];
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const within = (node: Node) => containers.some((element) => element.contains(node));
  if (!within(range.startContainer) || !within(range.endContainer)) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  return charLength(text) > maxLength
    ? `${takeChars(text, maxLength - 1).trimEnd()}${ELLIPSIS}`
    : text;
}
