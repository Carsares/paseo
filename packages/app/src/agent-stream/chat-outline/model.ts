import type { AgentTimelinePromptIndexPayload } from "@getpaseo/client/internal/daemon-client";
import {
  getLegacyTopicPromptPreview,
  getUserMessageDisplayText,
  PROMPT_PREVIEW_MAX_LENGTH,
} from "@/components/user-message/display-text";
import type { StreamItem, UserMessageItem } from "@/types/stream";

export type ChatOutlinePrompt = AgentTimelinePromptIndexPayload["prompts"][number];

function promptPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= PROMPT_PREVIEW_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, PROMPT_PREVIEW_MAX_LENGTH - 1)}…`;
}

export function createChatOutlinePreviewResolver(index: AgentTimelinePromptIndexPayload) {
  if (index.previewsAreDisplayText === true) return () => index.prompts;

  const legacyPreviews = new Map<number, string>();
  for (const { seq, preview } of index.prompts) {
    const legacy = getLegacyTopicPromptPreview(preview);
    if (legacy !== null) legacyPreviews.set(seq, legacy);
  }
  if (legacyPreviews.size === 0) return () => index.prompts;

  return function resolve(tail: readonly StreamItem[], head: readonly StreamItem[]) {
    const loaded = new Map<number, UserMessageItem>();
    for (const items of [tail, head]) {
      for (const item of items) {
        if (item.kind !== "user_message" || item.timelineCursor?.epoch !== index.epoch) continue;
        const { seq } = item.timelineCursor;
        if (legacyPreviews.has(seq)) loaded.set(seq, item);
      }
    }

    return index.prompts.map((prompt) => {
      const legacy = legacyPreviews.get(prompt.seq);
      if (legacy === undefined) return prompt;
      const source = loaded.get(prompt.seq);
      if (!source) return { ...prompt, preview: legacy };

      const displayText = getUserMessageDisplayText(
        source.text,
        source,
        source.messageId ?? source.id,
      );
      const displayPreview = promptPreview(displayText);
      if (prompt.preview === displayPreview) return prompt;
      if (prompt.preview === promptPreview(source.text)) {
        return { ...prompt, preview: displayPreview };
      }
      return { ...prompt, preview: legacy };
    });
  };
}

export function shouldAcceptPromptIndexEpoch(timelineEpoch: string, indexEpoch: string): boolean {
  return timelineEpoch === indexEpoch;
}

/**
 * Slots further than this from the pointer keep their resting size, so a long rail
 * magnifies a local band instead of swelling the whole column.
 */
export const OUTLINE_MAGNIFY_RADIUS = 3;

/**
 * Dock-style falloff: 1 under the pointer, easing to 0 at the radius. The raised cosine
 * has no corner at either end, so sweeping the rail reads as one bulge travelling with
 * the pointer rather than a band switching on and off.
 */
export function promptTickMagnification(slotDistance: number): number {
  const distance = Math.abs(slotDistance);
  if (!Number.isFinite(distance) || distance >= OUTLINE_MAGNIFY_RADIUS) {
    return 0;
  }
  return (1 + Math.cos((Math.PI * distance) / OUTLINE_MAGNIFY_RADIUS)) / 2;
}

/**
 * The prompt whose turn the reader is inside: the last indexed prompt at or before the
 * timeline position under the top of the viewport. It reads the complete daemon index,
 * so a prompt outside the loaded window still lights up while its turn is on screen.
 */
export function resolveActivePromptSeq(
  prompts: readonly ChatOutlinePrompt[],
  anchorSeq: number | null,
): number | null {
  if (anchorSeq === null) {
    return null;
  }
  let start = 0;
  let end = prompts.length;
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2);
    if (prompts[middle].seq <= anchorSeq) {
      start = middle + 1;
    } else {
      end = middle;
    }
  }
  return prompts[start - 1]?.seq ?? null;
}

export interface ActivePromptReadingState {
  readonly activeSeq: number | null;
  readonly isPromptScrolledAbove: boolean;
}

export function resolveActivePromptReadingState(
  prompts: readonly ChatOutlinePrompt[],
  anchorSeq: number | null,
  isReadingPromptRow = false,
): ActivePromptReadingState {
  const activeSeq = resolveActivePromptSeq(prompts, anchorSeq);
  return {
    activeSeq,
    isPromptScrolledAbove: activeSeq !== null && !(isReadingPromptRow && anchorSeq === activeSeq),
  };
}

export interface ActivePromptSource {
  subscribe: (listener: () => void) => () => void;
  getActiveSeq: () => number | null;
  getReadingState: () => ActivePromptReadingState;
}

export interface ActivePromptPublisher extends ActivePromptSource {
  publish: (seq: number | null, isPromptScrolledAbove?: boolean) => void;
}

/**
 * The transcript reports its reading position on every scroll frame, far more often than
 * it re-renders. The rail and the prompt bar subscribe here so reading position updates
 * don't re-render the transcript.
 */
export function createActivePromptPublisher(): ActivePromptPublisher {
  const listeners = new Set<() => void>();
  let readingState: ActivePromptReadingState = { activeSeq: null, isPromptScrolledAbove: false };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getActiveSeq: () => readingState.activeSeq,
    getReadingState: () => readingState,
    publish(seq, isPromptScrolledAbove = false) {
      if (
        seq === readingState.activeSeq &&
        isPromptScrolledAbove === readingState.isPromptScrolledAbove
      ) {
        return;
      }
      readingState = { activeSeq: seq, isPromptScrolledAbove };
      for (const listener of listeners) {
        listener();
      }
    },
  };
}
