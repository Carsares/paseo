import type { ComposerAttachment, QuoteComposerAttachment, UserComposerAttachment } from "./types";

export type { QuoteComposerAttachment } from "./types";

export function normalizeQuoteText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim().length > 0);
  if (start === -1) return "";
  const end = lines.findLastIndex((line) => line.trim().length > 0);
  return lines.slice(start, end + 1).join("\n");
}

export function createQuoteAttachment(input: {
  text: string;
  id?: string;
}): QuoteComposerAttachment {
  return {
    kind: "quote",
    id: input.id ?? `quote_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    text: normalizeQuoteText(input.text),
  };
}

export function appendQuoteAttachment(
  current: readonly UserComposerAttachment[],
  quoteText: string,
): UserComposerAttachment[] {
  if (!normalizeQuoteText(quoteText)) return [...current];
  return [...current, createQuoteAttachment({ text: quoteText })];
}

export function formatQuoteAsMarkdownBlockquote(quoteText: string): string {
  return normalizeQuoteText(quoteText)
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

export function hasSlashCommandWithQuotes(
  text: string,
  attachments: readonly ComposerAttachment[],
): boolean {
  // Match the providers' command token. Paths such as /usr/bin are ordinary prompts.
  return (
    /^\/[^/\s]+(?:\s|$)/.test(text.trim()) &&
    attachments.some((attachment) => attachment.kind === "quote" && attachment.text.trim())
  );
}

export function providerRequiresUnquotedSlashCommand(provider: string | null | undefined): boolean {
  return (
    provider === "claude" || provider === "codex" || provider === "opencode" || provider === "pi"
  );
}

export function composePromptTextWithQuotes(
  text: string,
  attachments: readonly ComposerAttachment[],
): string {
  const quotes = attachments
    .filter((attachment) => attachment.kind === "quote")
    .filter((attachment) => attachment.text.trim().length > 0)
    .map((attachment) => formatQuoteAsMarkdownBlockquote(attachment.text));
  if (quotes.length === 0) return text;
  const quotedBlock = quotes.join("\n\n");
  const prompt = text.trim();
  return prompt ? `${quotedBlock}\n\n${prompt}` : quotedBlock;
}
