import type { AgentMetric } from "@getpaseo/protocol/agent-types";
import React, { memo, useCallback, useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { QuoteTopicProvider } from "@/assistant-selection-copy/composer-quote";
import type { QuoteTopicSourceMetadata } from "@/attachments/types";
import { SPACING, type Theme } from "@/styles/theme";
import type { TurnTiming } from "@/timeline/turn-time";
import { getStreamItemMessageId, type StreamItem } from "@/types/stream";
import { getAgentMessage } from "./agent-interactions";
import {
  collectAssistantResponseContentForStreamRenderStrategy,
  collectAssistantResponseMessageIdsForStreamRenderStrategy,
  type StreamStrategy,
} from "./strategy";
import { resolveAssistantTurnForkBoundary, type AssistantTurnForkBoundary } from "./turn-boundary";
import { continuesResponse } from "./turn-membership";
import {
  AssistantTurnFooter,
  LiveElapsed,
  STREAM_METADATA_FONT_SIZE,
  type AssistantForkTarget,
} from "@/components/message";
import type { TurnFooterHost } from "./layout";
import { AssistantForkMenu } from "@/components/assistant-fork-menu";
import { SyncedLoader } from "@/components/synced-loader";
import { useRetainedPanelActive } from "@/components/retained-panel";

const ThemedSyncedLoader = withUnistyles(SyncedLoader);
const workingIndicatorColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
export const TURN_FOOTER_BOTTOM_SPACING = SPACING[8];
// Every footer variant (running, completed with Copy, completed with only its duration) gets
// this content height, so a turn ending swaps the footer's controls without moving the rows
// above it.
const TURN_FOOTER_CONTENT_HEIGHT = 24;

export type TurnContentStrategy = StreamStrategy;
export type AssistantTurnForkHandler = (input: {
  target: AssistantForkTarget;
  boundary: AssistantTurnForkBoundary;
}) => Promise<void> | void;
/**
 * Fork handler for the turn that is still streaming. It deliberately takes no
 * boundary: `selectForkContextRows` projects the entire timeline when neither
 * boundary field is given, which is what captures the partially streamed text
 * the user is watching. Pinning a boundary here would silently drop the live
 * response — the opposite of what a fork button next to the loader promises.
 *
 * Kept separate from `AssistantTurnForkHandler` (whose `boundary` stays
 * required) so the compiler keeps enforcing that completed turns always pin one.
 */
export type InFlightTurnForkHandler = (target: AssistantForkTarget) => Promise<void> | void;

export const TurnFooter = memo(function TurnFooter({
  isRunning,
  inFlightTurnStartedAt,
  host,
  strategy,
  supportsTimelineCursor,
  onForkAssistantTurn,
  onForkInFlightTurn,
}: {
  isRunning: boolean;
  inFlightTurnStartedAt: Date | null;
  host: TurnFooterHost | null;
  strategy: TurnContentStrategy;
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  if (isRunning) {
    return (
      <TurnFooterRow>
        <RunningTurnFooter
          inFlightTurnStartedAt={inFlightTurnStartedAt}
          onForkInFlightTurn={onForkInFlightTurn}
        />
      </TurnFooterRow>
    );
  }
  if (!host) {
    return null;
  }
  return (
    <CompletedTurnFooterRow
      strategy={strategy}
      items={host.items}
      timing={host.timing}
      startIndex={host.startIndex}
      turnMetrics={host.turnMetrics}
      supportsTimelineCursor={supportsTimelineCursor}
      onForkAssistantTurn={onForkAssistantTurn}
    />
  );
});

export const CompletedTurnFooterRow = memo(function CompletedTurnFooterRow({
  strategy,
  items,
  timing,
  startIndex,
  turnMetrics,
  supportsTimelineCursor,
  onForkAssistantTurn,
}: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
  turnMetrics?: AgentMetric[];
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}) {
  return (
    <TurnFooterRow>
      <CompletedTurnFooter
        strategy={strategy}
        items={items}
        timing={timing}
        startIndex={startIndex}
        turnMetrics={turnMetrics}
        supportsTimelineCursor={supportsTimelineCursor}
        onForkAssistantTurn={onForkAssistantTurn}
      />
    </TurnFooterRow>
  );
});

const WorkingIndicator = memo(function WorkingIndicator({
  inFlightTurnStartedAt = null,
  onForkInFlightTurn,
}: {
  inFlightTurnStartedAt?: Date | null;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  const active = useRetainedPanelActive();
  return (
    <View style={stylesheet.turnFooterContent}>
      <View style={stylesheet.workingLoader}>
        <ThemedSyncedLoader size={14} uniProps={workingIndicatorColorMapping} />
      </View>
      {/* Match the completed-turn footer: actions precede timing metadata. */}
      {onForkInFlightTurn ? <AssistantForkMenu onFork={onForkInFlightTurn} /> : null}
      {inFlightTurnStartedAt ? (
        <LiveElapsed
          startedAt={inFlightTurnStartedAt}
          active={active}
          style={stylesheet.workingElapsed}
          testID="turn-working-elapsed"
        />
      ) : null}
    </View>
  );
});

function RunningTurnFooter({
  inFlightTurnStartedAt,
  onForkInFlightTurn,
}: {
  inFlightTurnStartedAt: Date | null;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}) {
  return (
    <View style={stylesheet.turnFooterSlot} testID="turn-working-indicator">
      <WorkingIndicator
        inFlightTurnStartedAt={inFlightTurnStartedAt}
        onForkInFlightTurn={onForkInFlightTurn}
      />
    </View>
  );
}

interface TurnTopicHints {
  taskIds: Set<string>;
  rootMessageIds: Set<string>;
  humanRootMessageId?: string;
}

function collectTurnTopicHints(params: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  startIndex: number;
}): TurnTopicHints {
  const { strategy, items, startIndex } = params;
  const taskIds = new Set<string>();
  const rootMessageIds = new Set<string>();
  let humanRootMessageId: string | undefined;
  let laterItem: StreamItem | null = null;

  for (
    let index = startIndex;
    index >= 0 && index < items.length;
    index = strategy.getNeighborIndex(index, "above")
  ) {
    const currentItem = items[index];
    if (!currentItem || (laterItem && !continuesResponse(currentItem, laterItem))) {
      break;
    }
    const agentMessage = getAgentMessage(currentItem);
    if (agentMessage) {
      const taskId = agentMessage.taskId?.trim();
      const rootMessageId = agentMessage.rootMessageId?.trim();
      if (taskId) taskIds.add(taskId);
      if (rootMessageId) rootMessageIds.add(rootMessageId);
    } else if (currentItem.kind === "user_message" && !currentItem.sender) {
      humanRootMessageId ||= (currentItem.messageId ?? currentItem.clientMessageId)?.trim();
    }
    laterItem = currentItem;
  }

  return { taskIds, rootMessageIds, humanRootMessageId };
}

function resolveTurnQuoteTopicMetadata(params: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  startIndex: number;
}): QuoteTopicSourceMetadata | null {
  const hostItem = params.items[params.startIndex];
  if (!hostItem) return null;

  const { taskIds, rootMessageIds, humanRootMessageId } = collectTurnTopicHints(params);
  // Batched multi-topic turn: never attribute blindly to one topic.
  if (taskIds.size > 1 || (taskIds.size === 0 && rootMessageIds.size > 1)) {
    return null;
  }

  const taskId = taskIds.size === 1 ? [...taskIds][0] : undefined;
  const singleAgentRoot = rootMessageIds.size === 1 ? [...rootMessageIds][0] : undefined;
  const rootMessageId =
    singleAgentRoot ?? (rootMessageIds.size === 0 ? humanRootMessageId : undefined);
  let topicKey: string | undefined;
  if (taskId) {
    topicKey = `task:${taskId}`;
  } else if (rootMessageId) {
    topicKey = `msg:${rootMessageId}`;
  }
  if (!topicKey) return null;

  const sourceMessageId =
    hostItem.kind === "assistant_message" ? (hostItem.messageId ?? hostItem.id) : undefined;
  return {
    topicKey,
    ...(rootMessageId ? { rootMessageId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
  };
}

function CompletedTurnFooter({
  strategy,
  items,
  timing,
  startIndex,
  turnMetrics,
  supportsTimelineCursor,
  onForkAssistantTurn,
}: {
  strategy: TurnContentStrategy;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
  turnMetrics?: AgentMetric[];
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}) {
  const getContent = useCallback(
    () =>
      collectAssistantResponseContentForStreamRenderStrategy({
        strategy,
        items,
        startIndex,
      }),
    [strategy, items, startIndex],
  );
  const messageIds = useMemo(
    () =>
      items[startIndex]?.kind === "assistant_message"
        ? collectAssistantResponseMessageIdsForStreamRenderStrategy({
            strategy,
            items,
            startIndex,
          })
        : [],
    [strategy, items, startIndex],
  );
  const hostItem = items[startIndex];
  const fallbackMessageId = hostItem ? getStreamItemMessageId(hostItem) : undefined;
  const resolvedMessageIds = useMemo(() => {
    if (messageIds.length > 0) return messageIds;
    return fallbackMessageId ? [fallbackMessageId] : [];
  }, [fallbackMessageId, messageIds]);
  const turnQuoteTopic = useMemo(
    () => resolveTurnQuoteTopicMetadata({ strategy, items, startIndex }),
    [items, startIndex, strategy],
  );
  const boundary = resolveAssistantTurnForkBoundary({
    items,
    startIndex,
    supportsTimelineCursor,
  });
  const handleFork = useCallback(
    (target: AssistantForkTarget) => {
      if (!boundary) {
        return;
      }
      return onForkAssistantTurn?.({ target, boundary });
    },
    [boundary, onForkAssistantTurn],
  );
  return (
    <View style={stylesheet.turnFooterSlot}>
      <QuoteTopicProvider topic={turnQuoteTopic}>
        <AssistantTurnFooter
          getContent={items[startIndex]?.kind === "assistant_message" ? getContent : undefined}
          messageIds={resolvedMessageIds}
          completedAt={timing?.completedAt}
          durationMs={timing?.durationMs}
          onFork={boundary && onForkAssistantTurn ? handleFork : undefined}
          metrics={turnMetrics}
        />
      </QuoteTopicProvider>
    </View>
  );
}

function TurnFooterRow({ children }: { children: ReactNode }) {
  const rowStyle = useMemo(() => [stylesheet.streamItemWrapper, stylesheet.turnFooterRow], []);
  return (
    <View style={rowStyle} testID="turn-footer">
      {children}
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  streamItemWrapper: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
  // The message above drops its bottom padding for the footer (compactBottom), so this margin
  // alone sets the gap. 20 puts the footer as far below the text as the text sits below a
  // tool row: 12 message padding + 4 stream gap + 5 badge padding/border, less the footer's
  // 1px taller row.
  turnFooterRow: {
    marginTop: theme.spacing[4] + theme.spacing[1],
  },
  turnFooterSlot: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    minHeight: TURN_FOOTER_CONTENT_HEIGHT + TURN_FOOTER_BOTTOM_SPACING,
    paddingBottom: TURN_FOOTER_BOTTOM_SPACING,
  },
  turnFooterContent: {
    height: TURN_FOOTER_CONTENT_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: theme.spacing[3],
  },
  workingElapsed: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    fontVariant: ["tabular-nums"],
  },
  workingLoader: {
    marginLeft: -2,
  },
}));
