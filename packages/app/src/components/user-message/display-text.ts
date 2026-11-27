import type { TimelineTopicAttribution } from "@getpaseo/protocol/agent-types";

interface DisplayTopicAttribution extends TimelineTopicAttribution {
  clientMessageId?: string;
}

const TOPIC_CONTEXT_ATTRIBUTES =
  /^<paseo-topic-context(?: task-id="([^"<>\r\n]+)")?(?: root-message-id="([^"<>\r\n]+)")?/u;
const TOPIC_CONTEXT_CLOSE = "</paseo-topic-context>";
const TOPIC_CONTEXT_NOTES = [
  "",
  "The previous lead is unavailable. Answer in this topic or assign a new lead to the same task.",
  "The lead is on another host. Answer in this topic or coordinate with the lead via the usual tools.",
];
const TOPIC_CONTEXT_ENDINGS = TOPIC_CONTEXT_NOTES.map((note) =>
  note ? `>\n${note}\n${TOPIC_CONTEXT_CLOSE}` : `>\n${TOPIC_CONTEXT_CLOSE}`,
);
const COLLAPSED_TOPIC_CONTEXT_ENDINGS = TOPIC_CONTEXT_ENDINGS.map((ending) =>
  ending.replaceAll("\n", " "),
);

export const PROMPT_PREVIEW_MAX_LENGTH = 120;

function encodeAttribute(value: string | undefined): string | undefined {
  return value?.replace(/[&<>"']/g, (character) => "&#" + character.charCodeAt(0) + ";");
}

function getBodyAfterTopicContext(
  rest: string,
  endings: readonly string[],
  separator: string,
): string | null {
  for (const ending of endings) {
    if (rest === ending) return "";
    if (rest.startsWith(ending + separator)) return rest.slice(ending.length + separator.length);
  }
  return null;
}

export function getUserMessageDisplayText(
  text: string,
  attribution?: DisplayTopicAttribution,
  messageId?: string,
): string {
  if (!attribution) return text;
  const attributes = TOPIC_CONTEXT_ATTRIBUTES.exec(text);
  if (!attributes) return text;
  const rootMessageId =
    attribution.rootMessageId ??
    (attribution.topicKey?.startsWith("msg:") ? attribution.topicKey.slice(4) : undefined);
  const taskId =
    attribution.taskId ??
    (attribution.topicKey?.startsWith("task:") ? attribution.topicKey.slice(5) : undefined);
  if (
    rootMessageId &&
    (rootMessageId === messageId || rootMessageId === attribution.clientMessageId)
  )
    return text;
  const [opening, prefixTaskId, prefixRootId] = attributes;
  // Strip one daemon-generated envelope only when it agrees with the row's topic attribution.
  if (
    (!prefixTaskId && !prefixRootId) ||
    (prefixTaskId && prefixTaskId !== encodeAttribute(taskId)) ||
    (prefixRootId && prefixRootId !== encodeAttribute(rootMessageId))
  ) {
    return text;
  }
  const rest = text.slice(opening.length);
  return getBodyAfterTopicContext(rest, TOPIC_CONTEXT_ENDINGS, "\n\n") ?? text;
}

function isPartialAttribute(text: string, prefix: string): boolean {
  if (prefix.startsWith(text)) return true;
  return text.startsWith(prefix) && /^[^"<>]*$/u.test(text.slice(prefix.length));
}

// COMPAT(timelineTopicPromptPreview): added in v0.19.0, remove after 2027-06-01.
// Older hosts collapse whitespace and cap the entire message before we can use its topic attribution.
export function getLegacyTopicPromptPreview(preview: string): string | null {
  const attributes = TOPIC_CONTEXT_ATTRIBUTES.exec(preview);
  if (!attributes) return null;
  const [opening, taskId, rootId] = attributes;
  const rest = preview.slice(opening.length);
  if (taskId || rootId) {
    const body = getBodyAfterTopicContext(rest, COLLAPSED_TOPIC_CONTEXT_ENDINGS, " ");
    if (body !== null) return body;
  }

  if (preview.length !== PROMPT_PREVIEW_MAX_LENGTH || !rest.endsWith("…")) return null;
  const visible = rest.slice(0, -1);
  if (taskId || rootId) {
    if (COLLAPSED_TOPIC_CONTEXT_ENDINGS.some((ending) => ending.startsWith(visible))) return "…";
  }
  if (rootId) return null;
  if (isPartialAttribute(visible, ' root-message-id="')) return "…";
  return !taskId && isPartialAttribute(visible, ' task-id="') ? "…" : null;
}
