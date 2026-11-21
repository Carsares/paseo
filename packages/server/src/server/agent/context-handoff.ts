import { createHash } from "node:crypto";
import { continuesTimelineTurn, isTimelineTurnTrigger } from "@getpaseo/protocol/timeline-turn";
import type { AgentPromptInput, AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { curateAgentActivity } from "./activity-curator.js";

export const RECENT_VERBATIM_BUDGET_CHARS = 36_000;
const SUMMARIZATION_TIMEOUT_MS = 30_000;
const SEND_WAIT_MS = 15_000;

type Turn = AgentTimelineItem[];

function renderTool(item: Extract<AgentTimelineItem, { type: "tool_call" }>): string {
  const { detail } = item;
  const description =
    item.error ??
    (detail && "filePath" in detail ? detail.filePath : undefined) ??
    (detail && "command" in detail ? detail.command : undefined) ??
    (detail && "query" in detail ? detail.query : undefined) ??
    (detail && "url" in detail ? detail.url : undefined);
  const title = item.name.replace(/\s+/g, " ").slice(0, 100);
  const brief =
    typeof description === "string" ? description.slice(0, 400).replace(/\s+/g, " ") : "";
  return [`[Tool ${title}: ${item.status}]`, brief].filter(Boolean).join("\n");
}

function render(item: AgentTimelineItem): string {
  switch (item.type) {
    case "user_message":
      return `User:\n${item.text}`;
    case "assistant_message":
      return `Assistant:\n${item.text}`;
    case "tool_call":
      return renderTool(item);
    default:
      return "";
  }
}

function groupTurns(rows: readonly AgentTimelineRow[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn = [];
  let turnId: string | undefined;
  let started = false;
  for (const row of rows) {
    const { item } = row;
    if (item.type === "compaction") continue;
    const startsTurn = isTimelineTurnTrigger(item);
    if (started && !continuesTimelineTurn(turnId, row.turnId, startsTurn)) {
      turns.push(current);
      current = [];
      turnId = undefined;
      started = false;
    }
    // An opening preamble belongs to the first turn. A provider turn ID can
    // become available on a later row.
    turnId ??= row.turnId;
    started ||= startsTurn || row.turnId !== undefined;
    current.push(item);
  }
  turns.push(current);
  return turns.filter((turn) => turn.some(render));
}

function clipMiddle(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const marker = "\n[...truncated...]\n";
  if (budget <= marker.length) return "";
  const start = Math.floor((budget - marker.length) / 2);
  const end = budget - marker.length - start;
  // Avoid cutting a UTF-16 surrogate pair at either boundary.
  return (
    text.slice(0, start).replace(/[\uD800-\uDBFF]$/u, "") +
    marker +
    text.slice(-end).replace(/^[\uDC00-\uDFFF]/u, "")
  );
}

function renderLatestTurn(blocks: string[]): string {
  const separator = "\n\n";
  const selected: string[] = [];
  let remaining = RECENT_VERBATIM_BUDGET_CHARS;
  const latestUser = blocks.findLastIndex((block) => block.startsWith("User:\n"));
  const latestReply = blocks.findLastIndex((block) => block.startsWith("Assistant:\n"));
  const reserved = new Map(
    [latestUser, latestReply]
      .filter((index) => index >= 0)
      .map((index) => [
        index,
        clipMiddle(blocks[index], Math.floor(remaining / 2) - separator.length),
      ]),
  );
  for (const block of reserved.values()) remaining -= block.length + separator.length;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const protectedBlock = reserved.get(index);
    if (protectedBlock) {
      selected.push(protectedBlock);
      continue;
    }
    const block = clipMiddle(blocks[index], remaining - separator.length);
    if (!block) continue;
    selected.push(block);
    remaining -= block.length + separator.length;
  }
  return selected.toReversed().join(separator);
}

export function splitContextHandoff(rows: readonly AgentTimelineRow[]) {
  const turns = groupTurns(rows);
  const recentTurns: string[] = [];
  let used = 0;
  let split = turns.length;
  while (split > 0) {
    const blocks = turns[split - 1].map(render).filter(Boolean);
    const turn = blocks.join("\n\n");
    const length = turn.length + (recentTurns.length ? 2 : 0);
    if (recentTurns.length && used + length > RECENT_VERBATIM_BUDGET_CHARS) break;
    recentTurns.push(length > RECENT_VERBATIM_BUDGET_CHARS ? renderLatestTurn(blocks) : turn);
    used += length;
    split--;
  }
  const olderTurns = turns.slice(0, split);
  return {
    olderTurns,
    recentTurns: recentTurns.toReversed(),
    olderDigest: olderTurns.length
      ? createHash("sha256").update(JSON.stringify(olderTurns)).digest("hex")
      : null,
  };
}

export type ContextHandoff = ReturnType<typeof splitContextHandoff>;

export function buildContextHandoffEnvelope(
  handoff: ContextHandoff,
  olderSummary?: string | null,
): string | null {
  if (!handoff.recentTurns.length) return null;
  const sections = [
    "Context from the prior conversation. Use it as background for the prompt that follows.",
    ...(olderSummary ? [`## Earlier Conversation (Summary)\n${olderSummary}`] : []),
    `## Recent Conversation (Verbatim)\n${handoff.recentTurns.join("\n\n")}`,
  ];
  const body = sections
    .join("\n\n")
    .replaceAll("</paseo-context-handoff>", "&lt;/paseo-context-handoff>");
  return `<paseo-context-handoff version="1">\n${body}\n</paseo-context-handoff>`;
}

export function fallbackContextSummary(handoff: ContextHandoff): string {
  return curateEarlierTurns(handoff, 16_000);
}

function curateEarlierTurns(handoff: ContextHandoff, budget: number): string {
  const text = curateAgentActivity(handoff.olderTurns.flat(), {
    labelAssistantMessages: true,
    includeExternalToolInput: false,
  });
  return clipMiddle(text, budget);
}

export async function summarizeContextHandoff(
  handoff: ContextHandoff,
  summarize: (prompt: string, signal: AbortSignal) => Promise<string>,
  controller: AbortController,
): Promise<string> {
  const instruction =
    "Summarize the following earlier conversation history concisely in the same language used by the user. Preserve user goals, key technical decisions, file paths, constraints, errors resolved, and unfinished tasks. Output ONLY the structured summary text. Do NOT call any tools or modify any files.";
  const history = curateEarlierTurns(handoff, 48_000);
  const timeout = setTimeout(() => controller.abort(), SUMMARIZATION_TIMEOUT_MS);
  try {
    const result = await waitForAbort(
      summarize(`${instruction}\n\n${history}`, controller.signal),
      controller.signal,
    );
    if (result?.trim()) return result.trim().slice(0, 16_000);
  } catch {
    // A summary is optional. The deterministic version also works offline.
  } finally {
    clearTimeout(timeout);
  }
  return fallbackContextSummary(handoff);
}

export async function waitForAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T | undefined> {
  let aborted!: () => void;
  const abort = new Promise<undefined>((resolve) => {
    aborted = () => resolve(undefined);
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
  try {
    return await Promise.race([work, abort]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}

export async function waitForContextSummary(summary: Promise<string>): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_WAIT_MS);
  try {
    return await waitForAbort(summary, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function injectContextHandoffIntoPrompt(
  prompt: AgentPromptInput,
  handoffEnvelope: string,
): AgentPromptInput {
  const text = `${handoffEnvelope}\n\n`;
  if (typeof prompt === "string") return text + prompt;
  const [first, ...rest] = prompt;
  return first?.type === "text" && !("mimeType" in first)
    ? [{ ...first, text: text + first.text }, ...rest]
    : [{ type: "text", text }, ...prompt];
}
