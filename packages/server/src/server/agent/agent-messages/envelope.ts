import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentTimelineItem,
} from "../agent-sdk-types.js";
import type { UserMessageForkContext } from "@getpaseo/protocol/agent-types";

const agentIdSchema = z.string().min(1);
const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("change-request-update"),
    url: z.url({ protocol: /^https?$/ }),
  }),
  z.object({
    kind: z.literal("agent-message"),
    agentId: agentIdSchema,
    serverId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    reportStatus: z.enum(["completed", "blocked"]).optional(),
  }),
  z.object({
    kind: z.literal("agent-notification"),
    agentId: agentIdSchema,
    serverId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    event: z.enum(["finished", "errored", "permission-required", "closed"]),
  }),
]);
export type AgentPromptSource = z.infer<typeof sourceSchema>;

interface AgentMessage {
  id: string;
  source: AgentPromptSource | null;
  text: string;
}

const CONTEXT_HANDOFF_PREFIX =
  /^<paseo-context-handoff version="1">\r?\n[\s\S]*?\r?\n<\/paseo-context-handoff>(?:\r?\n){0,2}/;

export function stripContextHandoffEnvelope(text: string): string {
  for (;;) {
    const prefix = CONTEXT_HANDOFF_PREFIX.exec(text);
    if (!prefix) return text;
    text = text.slice(prefix[0].length);
  }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

function unescapeXml(value: string): string | null {
  if (/[<>]|&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) return null;
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      default:
        return "'";
    }
  });
}

export function formatAgentMessage(message: AgentMessage): string {
  const { source } = message;
  if (source?.kind === "change-request-update") {
    return `<paseo-system version="1" kind="change-request-update" source-url="${escapeXml(source.url)}" message-id="${escapeXml(message.id)}">\n${escapeXml(message.text)}\n</paseo-system>`;
  }
  const attributes = source
    ? `kind="${source.kind}" source-agent-id="${escapeXml(source.agentId)}"`
    : 'kind="user-message"';
  const server = source?.serverId ? ` source-server-id="${escapeXml(source.serverId)}"` : "";
  const title = source?.title ? ` source-agent-title="${escapeXml(source.title)}"` : "";
  const event = source?.kind === "agent-notification" ? ` event="${source.event}"` : "";
  const status =
    source?.kind === "agent-message" && source.reportStatus
      ? ` report-status="${source.reportStatus}"`
      : "";
  return `<paseo-system version="1" ${attributes} message-id="${escapeXml(message.id)}"${server}${title}${event}${status}>\n${escapeXml(message.text)}\n</paseo-system>`;
}

export function parseAgentMessage(text: string): AgentMessage | null {
  const envelope = /^<paseo-system((?:\s+[a-z-]+="[^"<>]*")+)>\n([\s\S]*)\n<\/paseo-system>$/.exec(
    text,
  );
  if (!envelope) return null;
  const attributes = new Map<string, string>();
  for (const match of envelope[1].matchAll(/\s+([a-z-]+)="([^"<>]*)"/g)) {
    const value = unescapeXml(match[2]);
    if (value === null || attributes.has(match[1])) return null;
    attributes.set(match[1], value);
  }
  if (attributes.get("version") !== "1") return null;
  const id = attributes.get("message-id");
  const body = unescapeXml(envelope[2]);
  if (!id || body === null) return null;
  if (attributes.get("kind") === "user-message") {
    if (attributes.has("source-agent-id") || attributes.has("event")) return null;
    return { id, source: null, text: body };
  }
  const source = sourceSchema.safeParse({
    kind: attributes.get("kind"),
    agentId: attributes.get("source-agent-id"),
    serverId: attributes.get("source-server-id"),
    event: attributes.get("event"),
    title: attributes.get("source-agent-title"),
    url: attributes.get("source-url"),
    ...(attributes.has("report-status") ? { reportStatus: attributes.get("report-status") } : {}),
  });
  if (!source.success) return null;
  return { id, source: source.data, text: body };
}

/** Accept only a complete sequence of envelopes; prose around them stays user text. */
export function parseAgentMessages(text: string): AgentMessage[] | null {
  // Bodies are XML escaped, so a literal closing tag unambiguously ends an entry.
  const parts = text.split(/(?<=<\/paseo-system>)\n+(?=<paseo-system )/);
  const messages = parts.map(parseAgentMessage);
  return messages.every((message) => message !== null) ? messages : null;
}

function renderMessageText(block: AgentPromptContentBlock): string[] {
  if (block.type === "image") return [];
  if (block.type === "text") return [block.text];
  return [renderPromptAttachmentAsText(block)];
}

export function prepareAgentMessage(
  prompt: AgentPromptInput,
  source?: AgentPromptSource,
  id?: string,
): { prompt: AgentPromptInput; messageId?: string } {
  const replayablePrompt =
    !source && Array.isArray(prompt) ? prompt.map(markForkAttachment) : prompt;
  if (!source) {
    const submittedText =
      typeof prompt === "string"
        ? prompt
        : prompt
            .flatMap((block) =>
              block.type === "text" && !("mimeType" in block) ? [block.text] : [],
            )
            .join("\n")
            .trim();
    // Quote reserved envelopes only when they arrived through the human send path.
    // This provenance must survive provider history, not only the accepted local row.
    if (
      !parseAgentMessages(submittedText) &&
      !isSystemInjectedEnvelope(submittedText) &&
      stripContextHandoffEnvelope(submittedText.trimStart()) === submittedText.trimStart() &&
      !submittedText.trimStart().startsWith(FORK_ATTACHMENT_OPEN)
    ) {
      return { prompt: replayablePrompt, messageId: id };
    }
  }
  const messageId = id ?? randomUUID();
  const forkAttachments =
    !source && Array.isArray(replayablePrompt) ? replayablePrompt.filter(isForkAttachment) : [];
  const text =
    typeof prompt === "string"
      ? prompt
      : prompt
          .filter((block) => source || !isForkAttachment(block))
          .flatMap(renderMessageText)
          .join("\n\n");
  // Render textual attachments before wrapping, so provider replay still contains one
  // complete envelope instead of an envelope followed by provider-rendered context.
  const envelope = formatAgentMessage({ id: messageId, source: source ?? null, text });
  return {
    messageId,
    prompt:
      typeof prompt === "string"
        ? envelope
        : [
            ...forkAttachments,
            { type: "text", text: envelope },
            ...prompt.filter((block) => block.type === "image"),
          ],
  };
}

/** The same projection owns provider echoes, acceptance, import, and replay. */
export function projectAgentMessages(
  item: AgentTimelineItem,
  options?: { submitted?: boolean },
): AgentTimelineItem[] {
  if (item.type === "user_message") {
    const cleanText = options?.submitted ? item.text : stripContextHandoffEnvelope(item.text);
    if (cleanText !== item.text && !cleanText.trim()) return [];
    const userMessage = options?.submitted
      ? item
      : withReplayForkContext({ ...item, text: cleanText });
    const messages = parseAgentMessages(userMessage.text);
    if (messages) {
      return messages.flatMap((message) => {
        const projected = projectAgentMessage({
          ...userMessage,
          text: formatAgentMessage(message),
        });
        return projected ? [projected] : [];
      });
    }
    item = userMessage;
  }
  const projected = projectAgentMessage(item);
  return projected ? [projected] : [];
}

const FORK_SUMMARY_PREFIX = "<chat-history-summary>\nChat history from a previous Paseo agent.";
const FORK_SUMMARY_CLOSE = "\n</chat-history-summary>";
const FORK_ATTACHMENT_OPEN = '<paseo-chat-history-attachment context="';
const FORK_ATTACHMENT_CLOSE = "\n</paseo-chat-history-attachment>";
const forkContextSchema = z.strictObject({
  sourceAgentId: z.string().optional(),
  sourceServerId: z.string().optional(),
  boundaryMessageId: z.string().optional(),
});

function parseForkSummaryHeader(content: string): UserMessageForkContext {
  const headerEnd = content.indexOf("\n\n");
  const header = headerEnd < 0 ? content : content.slice(0, headerEnd);
  const sourceAgentId = /^Source agent ID: (.+)$/m.exec(header)?.[1]?.trim();
  const sourceServerId = /^Source server ID: (.+)$/m.exec(header)?.[1]?.trim();
  const boundaryMessageId = /^Source boundary message ID: (.+)$/m.exec(header)?.[1]?.trim();
  return {
    ...(sourceAgentId ? { sourceAgentId } : {}),
    ...(sourceServerId ? { sourceServerId } : {}),
    ...(boundaryMessageId ? { boundaryMessageId } : {}),
  };
}

function readLegacyForkSummary(text: string) {
  if (!text.startsWith(`${FORK_SUMMARY_PREFIX}\n`)) return null;
  const closeIndex = text.indexOf(FORK_SUMMARY_CLOSE, FORK_SUMMARY_PREFIX.length);
  if (closeIndex < 0) return null;
  return {
    text: text.slice(closeIndex + FORK_SUMMARY_CLOSE.length).replace(/^(?:\r?\n)+/, ""),
    forkContext: parseForkSummaryHeader(text.slice(FORK_SUMMARY_PREFIX.length, closeIndex)),
  };
}

type ForkAttachment = Extract<AgentPromptContentBlock, { type: "text"; mimeType: string }>;

function isForkAttachment(block: AgentPromptContentBlock): block is ForkAttachment {
  return block.type === "text" && "mimeType" in block && block.contextKind === "chat_history";
}

function getForkAttachmentContext(block: ForkAttachment): UserMessageForkContext {
  const fromText = readLegacyForkSummary(block.text)?.forkContext;
  const sourceAgentId = block.forkContext?.sourceAgentId?.trim() || fromText?.sourceAgentId;
  const sourceServerId = block.forkContext?.sourceServerId?.trim() || fromText?.sourceServerId;
  const boundaryMessageId =
    block.forkContext?.boundaryMessageId?.trim() || fromText?.boundaryMessageId;
  return {
    ...(sourceAgentId ? { sourceAgentId } : {}),
    ...(sourceServerId ? { sourceServerId } : {}),
    ...(boundaryMessageId ? { boundaryMessageId } : {}),
  };
}

export function extractSubmittedPromptForkContext(
  prompt: AgentPromptInput,
): UserMessageForkContext | undefined {
  const block = Array.isArray(prompt) ? prompt.find(isForkAttachment) : undefined;
  return block ? getForkAttachmentContext(block) : undefined;
}

function markForkAttachment(block: AgentPromptContentBlock): AgentPromptContentBlock {
  if (!isForkAttachment(block)) return block;
  const forkContext = getForkAttachmentContext(block);
  const metadata = escapeXml(JSON.stringify(forkContext));
  const text = block.text.replaceAll(
    FORK_ATTACHMENT_CLOSE,
    "\n&lt;/paseo-chat-history-attachment>",
  );
  return {
    ...block,
    forkContext,
    text: `${FORK_ATTACHMENT_OPEN}${metadata}">\n${text}${FORK_ATTACHMENT_CLOSE}`,
  };
}

function readMarkedForkAttachment(text: string) {
  if (!text.startsWith(FORK_ATTACHMENT_OPEN)) return null;
  const headerEnd = text.indexOf('">\n', FORK_ATTACHMENT_OPEN.length);
  if (headerEnd < 0) return null;
  const closeIndex = text.indexOf(FORK_ATTACHMENT_CLOSE, headerEnd + 3);
  if (closeIndex < 0) return null;
  const metadata = unescapeXml(text.slice(FORK_ATTACHMENT_OPEN.length, headerEnd));
  if (metadata === null) return null;
  try {
    const parsed = forkContextSchema.safeParse(JSON.parse(metadata));
    if (!parsed.success) return null;
    return {
      text: text.slice(closeIndex + FORK_ATTACHMENT_CLOSE.length).replace(/^(?:\r?\n)+/, ""),
      forkContext: parsed.data,
    };
  } catch {
    return null;
  }
}

function withReplayForkContext(
  item: Extract<AgentTimelineItem, { type: "user_message" }>,
): Extract<AgentTimelineItem, { type: "user_message" }> {
  const marked = readMarkedForkAttachment(item.text);
  if (marked) {
    let text = marked.text;
    for (let next = readMarkedForkAttachment(text); next; next = readMarkedForkAttachment(text)) {
      text = next.text;
    }
    return { ...item, text, forkContext: { ...marked.forkContext, ...item.forkContext } };
  }
  // COMPAT(unmarkedForkSummary): added in v0.16.0 for replay with recorded provenance.
  // Remove after 2027-05-20 once supported stored history no longer needs this path.
  const recorded = item.forkContext;
  const legacy = recorded?.sourceAgentId ? readLegacyForkSummary(item.text) : null;
  if (!legacy || legacy.forkContext.sourceAgentId !== recorded?.sourceAgentId) return item;
  const contextAgrees = (["sourceServerId", "boundaryMessageId"] as const).every((key) => {
    const value = legacy.forkContext[key];
    return !value || !recorded?.[key] || value === recorded[key];
  });
  return contextAgrees
    ? { ...item, text: legacy.text, forkContext: { ...legacy.forkContext, ...recorded } }
    : item;
}

function projectAgentMessage(item: AgentTimelineItem): AgentTimelineItem | null {
  if (item.type !== "user_message") return item;
  const message = parseAgentMessage(item.text);
  if (!message) {
    if (!isSystemInjectedEnvelope(item.text)) return item;
    // Schedule bodies include the run ID, keeping identity stable across replay.
    const text = item.text.slice("<paseo-system>\n".length, -"\n</paseo-system>".length);
    return {
      type: "tool_call",
      callId: `paseo-system:${createHash("sha256").update(item.text).digest("hex")}`,
      name: "heartbeat",
      status: "completed",
      error: null,
      detail: { type: "plain_text", text, icon: "sparkles" },
    };
  }
  const { source } = message;
  if (!source) {
    return {
      ...item,
      text: message.text,
      clientMessageId: message.id,
    };
  }
  if (source.kind === "change-request-update") {
    return {
      type: "tool_call",
      callId: `paseo-change-request:${message.id}`,
      name: "change_request_update",
      status: "completed",
      error: null,
      detail: { type: "plain_text", text: message.text },
    };
  }
  return {
    type: "tool_call",
    callId: `paseo-agent-message:${message.id}`,
    agentMessage: {
      event: source.kind === "agent-message" ? "message" : source.event,
      sender: {
        id: source.agentId,
        ...(source.serverId ? { serverId: source.serverId } : {}),
        ...(source.title ? { title: source.title } : {}),
      },
      text: message.text,
      ...(source.kind === "agent-message" && source.reportStatus
        ? { reportStatus: source.reportStatus }
        : {}),
    },
    // COMPAT(agentMessageToolEnvelope): added in v0.11.1; remove after 2027-04-08
    // once clients can accept a dedicated timeline variant. Older clients still
    // parse this existing shape and can expand the delivered body.
    name: "agent_message",
    status: "completed",
    error: null,
    detail: { type: "plain_text", text: message.text, icon: "bot" },
  };
}

/**
 * Wrap a body in <paseo-system>…</paseo-system> so the receiving agent
 * recognizes the prompt as system-injected context — not a user turn.
 * Used by schedule fires; agent messages use the versioned envelope.
 */
export function formatSystemNotificationPrompt(reason: string): string {
  return `<paseo-system>\n${reason}\n</paseo-system>`;
}

const SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

export function isSystemInjectedEnvelope(text: string): boolean {
  return SYSTEM_ENVELOPE_PATTERN.test(text);
}
