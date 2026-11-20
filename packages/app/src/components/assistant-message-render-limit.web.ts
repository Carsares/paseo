import type {
  CapAssistantMessageOptions,
  CappedAssistantMessage,
} from "./assistant-message-render-limit.shared";
export {
  getUtf8ByteLength,
  type CapAssistantMessageOptions,
  type CappedAssistantMessage,
} from "./assistant-message-render-limit.shared";

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export const ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT = 32_000;
const LINE_BOUNDARY_LOOKBACK = 1_024;

export function capAssistantMessageForRender(
  message: string,
  options?: CapAssistantMessageOptions,
): CappedAssistantMessage {
  const expandedSteps = Math.max(0, Math.trunc(options?.expandedSteps ?? 0));
  const characterLimit = ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT * (expandedSteps + 1);
  if (message.length <= characterLimit) {
    return { text: message, capped: false };
  }

  const preferLineBoundary = options?.preferLineBoundary ?? true;
  if (preferLineBoundary && message.charCodeAt(characterLimit - 1) !== 0x0a) {
    const minLineEnd = Math.max(1, characterLimit - LINE_BOUNDARY_LOOKBACK);
    const lastNewline = message.lastIndexOf("\n", characterLimit - 1);
    if (lastNewline >= minLineEnd) {
      const lineEnd = message.charCodeAt(lastNewline - 1) === 0x0d ? lastNewline - 1 : lastNewline;
      if (lineEnd > 0) {
        return { text: message.slice(0, lineEnd), capped: true };
      }
    }
  }

  let end = characterLimit;
  if (graphemeSegmenter) {
    end = graphemeSegmenter.segment(message).containing(end)!.index;
  }
  // A single cluster can cover several steps. In that case, advance by whole code points.
  if (!graphemeSegmenter || end <= characterLimit - ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT) {
    end = characterLimit;
    const finalCodeUnit = message.charCodeAt(end - 1);
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
      end -= 1;
    }
  }

  return { text: message.slice(0, end), capped: true };
}
