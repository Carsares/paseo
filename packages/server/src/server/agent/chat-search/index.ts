import MarkdownIt from "markdown-it";
import { setImmediate } from "node:timers/promises";
import {
  getPaseoToolLeafName,
  normalizeToolName,
} from "@getpaseo/protocol/tool-name-normalization";
import { parseUserMessageSegments } from "@getpaseo/protocol/user-message-segments";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { projectTimelineRows, type TimelineProjectionEntry } from "../timeline-projection.js";

const markdown = new MarkdownIt({ html: false });
const PAGE_SIZE = 200;
interface SearchLocation {
  seq: number;
  role: "user" | "assistant";
  count: number;
}
interface SearchInput {
  rows: readonly AgentTimelineRow[];
  query: string;
  cursor?: number;
  hideAgentInteractions?: boolean;
  includeAgentSourceBodies?: boolean;
  provider?: string;
}

// The app also handles local interaction rows that never enter the retained timeline.
// Keep its persisted tool classification in agent-stream/agent-interactions.ts in sync.
const PASEO_INTERACTION_TOOLS = new Set([
  "create_agent",
  "send_agent_prompt",
  "get_agent_status",
  "get_agent_activity",
  "list_agents",
  "cancel_agent",
  "archive_agent",
  "kill_agent",
  "update_agent",
  "set_agent_mode",
]);

function isHiddenInteraction(item: AgentTimelineItem, provider: string | undefined): boolean {
  if (item.type !== "tool_call") return false;
  if (item.agentMessage || item.detail.type === "sub_agent") return true;
  if (provider === "claude" && (item.name === "Task" || item.name === "Agent")) return true;
  const leaf = getPaseoToolLeafName(item.name);
  if (leaf !== null) return PASEO_INTERACTION_TOOLS.has(leaf);
  const normalized = normalizeToolName(item.name);
  return normalized.startsWith("paseo_") && PASEO_INTERACTION_TOOLS.has(normalized.slice(6));
}

function* hideInteractionRows(
  entries: TimelineProjectionEntry[],
  provider: string | undefined,
  includeAgentSourceBodies: boolean,
) {
  let previous: TimelineProjectionEntry | undefined;
  for (const entry of entries) {
    const { item } = entry;
    const isVisibleSource =
      includeAgentSourceBodies && item.type === "tool_call" && item.agentMessage;
    if (!isVisibleSource && isHiddenInteraction(item, provider)) continue;
    // A tool update can fold into a row before both fragments, leaving a sequence
    // gap between otherwise adjacent fragments that the client hydrates together.
    if (
      previous?.item.type === "assistant_message" &&
      item.type === "assistant_message" &&
      item.messageId &&
      entry.turnId &&
      previous.item.messageId === item.messageId &&
      previous.turnId === entry.turnId
    ) {
      previous = { ...entry, item: { ...item, text: previous.item.text + item.text } };
    } else {
      if (previous) yield previous;
      previous = entry;
    }
  }
  if (previous) yield previous;
}

// Discovery is deliberately approximate. Only the client can verify displayed text, so
// `count` estimates rendered occurrences and the client replaces it with the rendered
// count once the message is on screen. Blocks are counted separately, and the Markdown
// source is never searched whole, because a match the client cannot highlight — across
// a block boundary, or on syntax the reader never sees — still inflates the total until
// navigation reaches that message and drops it.
function searchableBlocks(text: string): string[] {
  return markdown
    .parse(text, {})
    .map((token) => {
      if (token.type === "inline") {
        return (token.children ?? [])
          .map((child) => {
            if (child.type === "text" || child.type === "code_inline") return child.content;
            if (child.type === "softbreak" || child.type === "hardbreak") return "\n";
            return "";
          })
          .join("");
      }
      if (token.type === "fence" || token.type === "code_block") return token.content;
      return "";
    })
    .filter(Boolean);
}

function searchPattern(query: string): RegExp {
  const source = query
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(source, "giu");
}

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  for (const _ of text.matchAll(pattern)) count += 1;
  return count;
}

function searchEntry(
  item: AgentTimelineItem,
  includeAgentSourceBodies: boolean,
): { role: SearchLocation["role"]; blocks: string[] } | undefined {
  if (item.type === "assistant_message") {
    return { role: "assistant", blocks: searchableBlocks(item.text.replace(/\r/g, "")) };
  }
  const text =
    item.type === "user_message" ? item.text : visibleSourceBody(item, includeAgentSourceBodies);
  if (text === undefined) return undefined;
  return { role: "user", blocks: parseUserMessageSegments(text).map((segment) => segment.text) };
}

function visibleSourceBody(item: AgentTimelineItem, includeAgentSourceBodies: boolean) {
  if (includeAgentSourceBodies && item.type === "tool_call") return item.agentMessage?.text;
  return undefined;
}

export async function searchTimeline({
  rows,
  query,
  cursor = 0,
  hideAgentInteractions,
  includeAgentSourceBodies = false,
  provider,
}: SearchInput) {
  const locations: SearchLocation[] = [];
  if (!query.trim()) return { locations, nextCursor: null };
  const pattern = searchPattern(query);
  let lastYield = performance.now();
  const entries = projectTimelineRows({ rows, mode: "projected" });
  const visibleEntries = hideAgentInteractions
    ? hideInteractionRows(entries, provider, includeAgentSourceBodies)
    : entries;
  for (const entry of visibleEntries) {
    if (entry.seqEnd <= cursor) continue;
    const searchable = searchEntry(entry.item, includeAgentSourceBodies);
    if (!searchable) continue;
    const { blocks, role } = searchable;
    const count = blocks.reduce((sum, block) => sum + countMatches(block, pattern), 0);
    if (count) {
      if (locations.length === PAGE_SIZE) {
        return { locations, nextCursor: locations[PAGE_SIZE - 1]!.seq };
      }
      locations.push({
        seq: entry.seqEnd,
        role,
        count,
      });
    }
    if (performance.now() - lastYield >= 8) {
      await setImmediate();
      lastYield = performance.now();
    }
  }
  return { locations, nextCursor: null };
}
