import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AgentTimelinePromptIndexPayload } from "@getpaseo/client/internal/daemon-client";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "../strategy";
import {
  createActivePromptPublisher,
  resolveActivePromptReadingState,
  shouldAcceptPromptIndexEpoch,
  type ActivePromptSource,
  type ChatOutlinePrompt,
} from "./model";

const NO_PROMPTS: ChatOutlinePrompt[] = [];
const NO_STREAM_ITEMS: StreamItem[] = [];

interface PendingPromptJump {
  requestId: number;
  seq: number;
  fetchSettled: boolean;
  hasScrolled: boolean;
}

export interface UseChatOutlineInput {
  agentId: string;
  serverId: string;
  timelineEpoch: string | null;
  tail: StreamItem[];
  head: StreamItem[] | undefined;
  enabled: boolean;
  viewportRef: RefObject<StreamViewportHandle | null>;
  onJumpError: () => void;
  // Message ids of the history the viewport has mounted. Live head messages are always mounted.
  mountedHistoryMessageIds?: ReadonlySet<string>;
  revealLoadedMessage?: (messageId: string) => boolean;
}

export interface ChatOutline {
  prompts: ChatOutlinePrompt[];
  activePrompt: ActivePromptSource;
  jumpToPrompt: (seq: number) => void;
  reportReadingPosition: (seq: number | null, isReadingPromptRow?: boolean) => void;
}

function latestPromptSeqIn(items: StreamItem[], timelineEpoch: string | null): number {
  let latest = -1;
  for (const item of items) {
    if (item.kind === "user_message" && item.timelineCursor?.epoch === timelineEpoch) {
      latest = Math.max(latest, item.timelineCursor.seq);
    }
  }
  return latest;
}

function findLoadedItem(
  tail: StreamItem[],
  head: StreamItem[],
  predicate: (item: StreamItem) => boolean,
): StreamItem | undefined {
  return tail.find(predicate) ?? head.find(predicate);
}

export function useChatOutline({
  agentId,
  serverId,
  timelineEpoch,
  tail,
  head,
  enabled,
  viewportRef,
  onJumpError,
  mountedHistoryMessageIds,
  revealLoadedMessage,
}: UseChatOutlineInput): ChatOutline {
  const timeline = useMemo(
    () => ({ agentId, serverId, timelineEpoch }),
    [agentId, serverId, timelineEpoch],
  );
  const [indexedTimeline, setIndexedTimeline] = useState<{
    timeline: typeof timeline;
    index: AgentTimelinePromptIndexPayload;
  } | null>(null);
  const [pendingJump, setPendingJump] = useState<PendingPromptJump | null>(null);
  const [activePrompt] = useState(createActivePromptPublisher);
  const readingPosition = useRef<{
    timeline: typeof timeline;
    seq: number | null;
    isPromptRow: boolean;
  } | null>(null);
  const nextJumpRequestIdRef = useRef(0);
  const nextIndexRequestIdRef = useRef(0);
  // A disabled outline skips the timeline scan on each delta.
  const loadedTail = enabled ? tail : NO_STREAM_ITEMS;
  const loadedHead = enabled ? (head ?? NO_STREAM_ITEMS) : NO_STREAM_ITEMS;
  const index = enabled && indexedTimeline?.timeline === timeline ? indexedTimeline.index : null;
  const prompts = index?.prompts ?? NO_PROMPTS;

  // The viewed timeline already owns live delivery and reconnect catch-up. Its complete
  // loaded items (including rows outside the mounted window) invalidate the prompt index.
  // Only the head changes per streamed delta, so the tail's contribution is memoized.
  const tailPromptSeq = useMemo(
    () => latestPromptSeqIn(loadedTail, timelineEpoch),
    [loadedTail, timelineEpoch],
  );
  const latestPromptSeq = Math.max(tailPromptSeq, latestPromptSeqIn(loadedHead, timelineEpoch));

  // Only a timeline the daemon has served can be indexed. A draft's optimistic stream has no
  // epoch, and its id names no agent the daemon knows.
  useEffect(() => {
    const epoch = timeline.timelineEpoch;
    if (!enabled || epoch === null) {
      setIndexedTimeline(null);
      return;
    }
    const client = getHostRuntimeStore().getClient(timeline.serverId);
    if (!client) return;
    let active = true;
    const refresh = () => {
      const requestId = ++nextIndexRequestIdRef.current;
      void client
        .listAgentTimelinePrompts(timeline.agentId)
        .then((payload) => {
          if (
            active &&
            requestId === nextIndexRequestIdRef.current &&
            shouldAcceptPromptIndexEpoch(epoch, payload.epoch)
          ) {
            setIndexedTimeline({ timeline, index: payload });
          }
          return undefined;
        })
        .catch(() => undefined);
    };
    refresh();
    return () => {
      active = false;
    };
  }, [enabled, latestPromptSeq, timeline]);

  // The transcript resolves display rows (including Markdown blocks and plugin cards) to
  // timeline positions. The outline uses the complete index, including unloaded prompts.
  const publishActivePrompt = useStableEvent(() => {
    const reading = readingPosition.current;
    if (reading?.timeline !== timeline) {
      activePrompt.publish(null);
      return;
    }
    const { activeSeq, isPromptScrolledAbove } = resolveActivePromptReadingState(
      prompts,
      reading.seq,
      reading.isPromptRow,
    );
    activePrompt.publish(activeSeq, isPromptScrolledAbove);
  });

  const reportReadingPosition = useStableEvent(
    (seq: number | null, isPromptRow: boolean = false) => {
      const current = readingPosition.current;
      if (
        current?.timeline === timeline &&
        current.seq === seq &&
        current.isPromptRow === isPromptRow
      ) {
        return;
      }
      readingPosition.current = { timeline, seq, isPromptRow };
      publishActivePrompt();
    },
  );

  useEffect(() => {
    nextJumpRequestIdRef.current += 1;
    setPendingJump(null);
  }, [timeline]);

  // The transcript reports its reading position long before the index arrives, and a reader
  // who never scrolls would otherwise sit on an unmarked rail.
  useEffect(() => {
    publishActivePrompt();
  }, [prompts, publishActivePrompt, timeline]);

  useEffect(() => {
    if (pendingJump === null) return;
    const target = findLoadedItem(
      loadedTail,
      loadedHead,
      (item) => item.timelineCursor?.seq === pendingJump.seq,
    );
    if (target) {
      if (pendingJump.hasScrolled) return;
      const isMounted =
        mountedHistoryMessageIds === undefined ||
        mountedHistoryMessageIds.has(target.id) ||
        loadedHead.includes(target);
      if (!isMounted) {
        revealLoadedMessage?.(target.id);
        return;
      }
      viewportRef.current?.scrollToMessage?.(target.id);
      setPendingJump((current) => {
        if (current?.requestId !== pendingJump.requestId) return current;
        return { ...current, hasScrolled: true };
      });
      return;
    }
    if (pendingJump.fetchSettled) setPendingJump(null);
  }, [
    loadedHead,
    loadedTail,
    mountedHistoryMessageIds,
    pendingJump,
    revealLoadedMessage,
    viewportRef,
  ]);

  const jumpToPrompt = useStableEvent((seq: number) => {
    nextJumpRequestIdRef.current += 1;
    setPendingJump(null);
    const loaded = findLoadedItem(
      loadedTail,
      loadedHead,
      (item) => item.timelineCursor?.seq === seq,
    );
    if (loaded) {
      if (revealLoadedMessage?.(loaded.id)) {
        const requestId = nextJumpRequestIdRef.current;
        setPendingJump({ requestId, seq, fetchSettled: true, hasScrolled: false });
        return;
      }
      viewportRef.current?.scrollToMessage?.(loaded.id);
      return;
    }
    if (!index) return;
    const requestId = nextJumpRequestIdRef.current;
    setPendingJump({ requestId, seq, fetchSettled: false, hasScrolled: false });
    void getHostRuntimeStore()
      .fetchAgentTimeline(serverId, agentId, planTimelinePromptJump({ epoch: index.epoch, seq }))
      .catch((error: unknown) => {
        console.warn("Failed to load a Chat outline window", error);
        onJumpError();
      })
      .finally(() => {
        setPendingJump((current) => {
          if (current?.requestId !== requestId) return current;
          return { ...current, fetchSettled: true };
        });
      });
  });

  return { prompts, activePrompt, jumpToPrompt, reportReadingPosition };
}
