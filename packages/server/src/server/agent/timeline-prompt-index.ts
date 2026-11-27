import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const PROMPT_PREVIEW_MAX_LENGTH = 120;
// Match the envelope written by topic-threads/reply-router.ts.
const TOPIC_CONTEXT_PREFIX =
  /^<paseo-topic-context(?: task-id="([^"\r\n]+)")?(?: root-message-id="([^"\r\n]+)")?>(?:\nThe previous lead is unavailable\. Answer in this topic or assign a new lead to the same task\.|\nThe lead is on another host\. Answer in this topic or coordinate with the lead via the usual tools\.)?\n<\/paseo-topic-context>(?:\n\n|$)/u;

export interface TimelinePromptIndexEntry {
  seq: number;
  timestamp: string;
  preview: string;
}

export interface TimelinePromptIndex {
  epoch: string;
  previewsAreDisplayText: true;
  prompts: TimelinePromptIndexEntry[];
}

function encodeAttribute(value: string | undefined): string | undefined {
  return value?.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function promptText(
  row: AgentTimelineRow,
  item: Extract<AgentTimelineRow["item"], { type: "user_message" }>,
): string {
  const { text } = item;
  const prefix = TOPIC_CONTEXT_PREFIX.exec(text);
  if (!prefix) return text;
  const [envelope, prefixTaskId, prefixRootId] = prefix;
  const { topicKey, taskId, rootMessageId } = row;
  const task = taskId ?? (topicKey?.startsWith("task:") ? topicKey.slice(5) : undefined);
  const root = rootMessageId ?? (topicKey?.startsWith("msg:") ? topicKey.slice(4) : undefined);
  const isRoot = root && (root === item.clientMessageId || root === item.messageId);
  if (
    isRoot ||
    (!prefixTaskId && !prefixRootId) ||
    (prefixTaskId && prefixTaskId !== encodeAttribute(task)) ||
    (prefixRootId && prefixRootId !== encodeAttribute(root))
  ) {
    return text;
  }
  return text.slice(envelope.length);
}

function promptPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= PROMPT_PREVIEW_MAX_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, PROMPT_PREVIEW_MAX_LENGTH - 1)}…`;
}

export function buildTimelinePromptIndex(
  epoch: string,
  rows: readonly AgentTimelineRow[],
): TimelinePromptIndex {
  return {
    epoch,
    previewsAreDisplayText: true,
    prompts: rows.flatMap((row) =>
      row.item.type === "user_message"
        ? [
            {
              seq: row.seq,
              timestamp: row.timestamp,
              preview: promptPreview(promptText(row, row.item)),
            },
          ]
        : [],
    ),
  };
}
