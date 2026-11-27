import type { TimelineTopicAttribution } from "@getpaseo/protocol/agent-types";

const TOPIC_CONTEXT_PREFIX =
  /^<paseo-topic-context(?: task-id="([^"\r\n]+)")?(?: root-message-id="([^"\r\n]+)")?>(?:\nThe previous lead is unavailable\. Answer in this topic or assign a new lead to the same task\.|\nThe lead is on another host\. Answer in this topic or coordinate with the lead via the usual tools\.)?\n<\/paseo-topic-context>(?:\n\n|$)/u;

function encodeAttribute(value: string | undefined): string | undefined {
  return value?.replace(/[&<>"']/g, (character) => "&#" + character.charCodeAt(0) + ";");
}

export function getUserMessageDisplayText(
  text: string,
  attribution?: TimelineTopicAttribution,
  messageId?: string,
): string {
  if (!attribution || !text.startsWith("<paseo-topic-context")) return text;
  const rootMessageId =
    attribution.rootMessageId ??
    (attribution.topicKey?.startsWith("msg:") ? attribution.topicKey.slice(4) : undefined);
  const taskId =
    attribution.taskId ??
    (attribution.topicKey?.startsWith("task:") ? attribution.topicKey.slice(5) : undefined);
  if (rootMessageId && rootMessageId === messageId) return text;

  const prefix = TOPIC_CONTEXT_PREFIX.exec(text);
  if (!prefix) return text;
  const [, prefixTaskId, prefixRootId] = prefix;
  // Strip one daemon-generated envelope only when it agrees with the row's topic attribution.
  if (
    (!prefixTaskId && !prefixRootId) ||
    (prefixTaskId && prefixTaskId !== encodeAttribute(taskId)) ||
    (prefixRootId && prefixRootId !== encodeAttribute(rootMessageId))
  ) {
    return text;
  }
  return text.slice(prefix[0].length);
}
