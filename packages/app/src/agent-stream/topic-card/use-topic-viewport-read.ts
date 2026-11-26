import { useEffect, useRef } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { useStableEvent } from "@/hooks/use-stable-event";

export const TOPIC_VIEWPORT_AUTO_READ_MS = 1500;

export interface SeenTopicWatermark {
  /** Highest seen main-timeline seq (null when only thread entries or unsequenced items were seen). */
  seq: number | null;
  /** Highest seen timestamp (ms) across actually visible unread replies. */
  timestampMs: number;
  /** IDs of actually visible unread items for legacy-host fallback. */
  fallbackItemIds: string[];
}

export interface UseTopicViewportReadInput {
  enabled: boolean;
  isPaneFocused: boolean;
  hasUnread: boolean;
  topicKey: string;
  epoch?: string | null;
  /**
   * Measured watermark covering ONLY unread content currently visible inside the viewport.
   * Must be `null` whenever the card or its unread replies have not yet been laid out or are
   * outside the viewport, preventing unmeasured/off-screen unread replies from being swallowed.
   */
  seenWatermark: SeenTopicWatermark | null;
  onAutoMarkRead: (input: {
    topicKey: string;
    epoch?: string | null;
    seq: number | null;
    timestampMs: number;
    fallbackItemIds: string[];
  }) => void;
}

/**
 * Advances a topic's read watermark only after its measured unread region remains genuinely
 * visible inside an active, focused panel for TOPIC_VIEWPORT_AUTO_READ_MS (1.5s). Stops
 * immediately whenever the retained panel hides, the app loses focus, or the region scrolls out.
 */
export function useTopicViewportRead({
  enabled,
  isPaneFocused,
  hasUnread,
  topicKey,
  epoch,
  seenWatermark,
  onAutoMarkRead,
}: UseTopicViewportReadInput): void {
  const isRetainedPanelActive = useRetainedPanelActive();
  const isAppVisible = useAppActivelyVisible();
  const markRead = useStableEvent(onAutoMarkRead);
  const lastMarkedKeyRef = useRef<string | null>(null);

  const shouldSchedule =
    enabled &&
    isPaneFocused &&
    isRetainedPanelActive &&
    isAppVisible &&
    hasUnread &&
    seenWatermark !== null;

  const seq = seenWatermark?.seq ?? null;
  const timestampMs = seenWatermark?.timestampMs ?? 0;
  const fallbackIdsKey = seenWatermark ? seenWatermark.fallbackItemIds.join(",") : "";
  const watermarkToken = `${topicKey}:${epoch ?? "none"}:${seq ?? "none"}:${timestampMs}:${fallbackIdsKey}`;

  useEffect(() => {
    if (!shouldSchedule || !seenWatermark) return;
    if (lastMarkedKeyRef.current === watermarkToken) return;
    const snapshot = seenWatermark;
    const timer = setTimeout(() => {
      lastMarkedKeyRef.current = watermarkToken;
      markRead({
        topicKey,
        ...(epoch === undefined ? {} : { epoch }),
        seq: snapshot.seq,
        timestampMs: snapshot.timestampMs,
        fallbackItemIds: snapshot.fallbackItemIds,
      });
    }, TOPIC_VIEWPORT_AUTO_READ_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [epoch, markRead, seenWatermark, shouldSchedule, topicKey, watermarkToken]);
}
