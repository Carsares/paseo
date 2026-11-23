import { isTurnBoundary } from "./turn-membership";
import type { ChatDisplay } from "@/hooks/use-settings";
import type { TimelineItemTransform } from "@/plugins/timeline/model";
import { projectPluginTimelineItems } from "@/plugins/timeline/projection";
import {
  prepareToolCallHistory,
  projectToolCallDetailLevel,
  type PreparedToolCallHistory,
  type ToolCallDetailLevel,
  type ToolCallDetailProjection,
} from "@/tool-calls/detail-level/projection";
import { getStreamItemMessageId, type StreamItem, type UserMessageItem } from "@/types/stream";
import { collapseTurns, type TurnCollapse } from "./turn-collapse/model";
import type { ReadingRowReplacements } from "./reading-anchor";
import {
  createAgentInteractionProjection,
  createAgentSourceGrouping,
  getAgentMessage,
  setAgentSourcePresentation,
  type AgentSourceGroup,
  type HiddenItemIds,
} from "./agent-interactions";

interface PresentationInput {
  tail: StreamItem[];
  head: StreamItem[];
  transform: TimelineItemTransform | undefined;
  display: ChatDisplay;
  autoExpandReasoning?: boolean;
  /** User messages whose collapsed turn the reader opened. */
  expandedTurnHostIds: ReadonlySet<string>;
  isTurnActive: boolean;
  activeTurnId?: string | null;
  /** Main chats hide agent lifecycle rows by default; detail panes pass true explicitly. */
  showAgentInteractions?: boolean;
}

export interface StreamPresentation extends ToolCallDetailProjection {
  /** Source rows after interaction filtering, before plugins and display grouping. */
  sourceTail: StreamItem[];
  sourceHead: StreamItem[];
  hiddenItemIds: HiddenItemIds;
  turns: Omit<TurnCollapse, "tail">;
  readingRowReplacements: ReadingRowReplacements;
}

function groupedRowHosts(
  rows: readonly StreamItem[],
  groups: ToolCallDetailProjection["groupsByHostId"],
): ReadonlyMap<string, string> {
  const hosts = new Map<string, string>();
  for (const row of rows) {
    const group = groups.get(row.id);
    if (!group) continue;
    for (const call of group.run.calls) {
      if (call.id !== row.id) hosts.set(call.id, row.id);
    }
  }
  return hosts;
}

interface RowIdentities {
  rowIdBySourceId: ReadonlyMap<string, string>;
  sourceIdByRowId: ReadonlyMap<string, string>;
}

interface StreamRowIdentities {
  tail: RowIdentities;
  head: RowIdentities;
}

function createRowIdentityIndex() {
  let source: StreamItem[] | undefined;
  let identities: RowIdentities | undefined;
  return (rows: StreamItem[]): RowIdentities => {
    if (source === rows && identities) return identities;
    const rowIdBySourceId = new Map<string, string>();
    const sourceIdByRowId = new Map<string, string>();
    for (const item of rows) {
      const sourceId = item.kind === "turn_summary" ? item.hostId : getStreamItemMessageId(item);
      // A plugin can split one source into several rows. Enter at the first row.
      if (!rowIdBySourceId.has(sourceId)) rowIdBySourceId.set(sourceId, item.id);
      sourceIdByRowId.set(item.id, sourceId);
    }
    source = rows;
    identities = { rowIdBySourceId, sourceIdByRowId };
    return identities;
  };
}

function sourceIdForRow(rows: StreamRowIdentities | undefined, id: string): string | undefined {
  return rows?.head.sourceIdByRowId.get(id) ?? rows?.tail.sourceIdByRowId.get(id);
}

function rowIdForSource(rows: StreamRowIdentities, id: string): string | undefined {
  return rows.head.rowIdBySourceId.get(id) ?? rows.tail.rowIdBySourceId.get(id);
}

interface ReadingProjectionInput {
  previous: StreamRowIdentities | undefined;
  displayed: StreamRowIdentities;
  beforeGrouping: StreamRowIdentities;
  interactions: ReadingRowReplacements;
  groups: ReadingRowReplacements;
  turns: StreamPresentation["turns"];
}

function readingRowReplacements(input: ReadingProjectionInput): ReadingRowReplacements {
  return {
    get(id) {
      if (sourceIdForRow(input.displayed, id) !== undefined) return undefined;
      const sourceId =
        sourceIdForRow(input.previous, id) ?? sourceIdForRow(input.beforeGrouping, id) ?? id;
      const interactionHost = input.interactions.get(sourceId) ?? sourceId;
      const currentRow = rowIdForSource(input.beforeGrouping, interactionHost) ?? interactionHost;
      // Expanded turns render individual calls; their earlier group must not capture them.
      const groupHost = input.turns.nestedItemIds.has(currentRow)
        ? currentRow
        : (input.groups.get(currentRow) ?? currentRow);
      const foldedHost = input.turns.hostIdByHiddenRowId.get(groupHost) ?? groupHost;
      const target = rowIdForSource(input.displayed, foldedHost) ?? foldedHost;
      const targetExists = sourceIdForRow(input.displayed, target) !== undefined;
      return target !== id && targetExists ? target : undefined;
    },
  };
}

function latestRetainedTurnIsOpen(
  projection: ToolCallDetailProjection,
  input: PresentationInput,
): boolean {
  const last = projection.tail.at(-1) ?? null;
  const first = projection.head[0] ?? null;
  // Without head rows, the latest retained turn is live only while the active run is that
  // turn. A run that has not opened yet carries no id and belongs to the next turn.
  if (!first) {
    return input.isTurnActive && (last?.turnId === undefined || input.activeTurnId === last.turnId);
  }
  const activeTurnIsAnother =
    input.activeTurnId && last?.turnId && input.activeTurnId !== last.turnId;
  return !isTurnBoundary(last, first) && !activeTurnIsAnother;
}

const NO_COLLAPSED_TURNS: StreamPresentation["turns"] = collapseTurns({
  tail: [],
  isLatestTurnOpen: false,
  expandedHostIds: new Set(),
  getGroupedCalls: () => undefined,
  previousSummaryRowsByHostId: new Map(),
});

/** Source messages reach plugins before display projection. */
export function createStreamPresentation() {
  const projectAgentInteractions = createAgentInteractionProjection();
  const groupAgentSources = createAgentSourceGrouping();
  const userMessageCache = new WeakMap<UserMessageItem, UserMessageItem>();

  function presentUserMessage(item: UserMessageItem): UserMessageItem {
    const cached = userMessageCache.get(item);
    if (cached) return cached;

    // Recognize the complete voice envelope, including older messages without the
    // instruction suffix. Leave quoted examples and unrelated XML untouched.
    const spokenInput =
      /^\s*<spoken-input>([\s\S]*?)<\/spoken-input>(?:\s*<instruction>This message was spoken by the user\.[\s\S]*?<\/instruction>)?\s*$/.exec(
        item.text,
      );
    const projected = spokenInput ? { ...item, text: spokenInput[1].trim() } : item;
    userMessageCache.set(item, projected);
    return projected;
  }

  let historySource: StreamItem[] | undefined;
  let historyTransform: TimelineItemTransform | undefined;
  let historyShowInteractions: boolean | undefined;
  let historySourceBoundary: ReadonlyMap<string, AgentSourceGroup> | undefined;
  let historyRows: StreamItem[] = [];
  let hasHistorySources = false;
  let preparedTail: StreamItem[] | undefined;
  let preparedAutoExpandReasoning: boolean | undefined;
  let preparedLevel: ToolCallDetailLevel | undefined;
  let preparedHistory: PreparedToolCallHistory | null = null;
  let historyGroupHosts: ReadonlyMap<string, string> = new Map();
  let collapsedSource: StreamItem[] | undefined;
  let collapsedIsLatestTurnOpen = false;
  let collapsedRegularTurns = false;
  let collapsedExpandedHostIds: ReadonlySet<string> | undefined;
  let collapsed: TurnCollapse | undefined;
  const indexHistory = createRowIdentityIndex();
  const indexHead = createRowIdentityIndex();
  const indexDisplayedTail = createRowIdentityIndex();
  const indexDisplayedHead = createRowIdentityIndex();
  let previousDisplayedRows: StreamRowIdentities | undefined;
  let originalTransform: TimelineItemTransform | undefined;
  let simplifiedTransform: TimelineItemTransform | undefined;

  function withoutSourceTransform(transform: TimelineItemTransform | undefined) {
    if (originalTransform !== transform) {
      originalTransform = transform;
      simplifiedTransform = transform
        ? (input) => {
            if (input.item.type === "tool_call" && input.item.agentMessage) return undefined;
            return transform(input);
          }
        : undefined;
    }
    return simplifiedTransform;
  }

  function presentRows(
    item: StreamItem,
    group: AgentSourceGroup | undefined,
    showAgentInteractions: boolean,
  ): StreamItem[] {
    const message = getAgentMessage(item);
    if (!message || (showAgentInteractions && message.event !== "message")) {
      return [item.kind === "user_message" ? presentUserMessage(item) : item];
    }
    const projected: UserMessageItem = {
      kind: "user_message",
      id: item.id,
      turnId: item.turnId,
      timelineCursor: item.timelineCursor,
      timestamp: item.timestamp,
      text: message.text,
      sender: message.sender,
    };
    if (group) {
      setAgentSourcePresentation(projected, {
        group,
        isGroupStart: group.firstItemId === item.id,
      });
    }
    return [projected];
  }

  function projectRows(
    items: StreamItem[],
    transform: TimelineItemTransform | undefined,
    showInteractions: boolean,
    getSourceGroup: (id: string) => AgentSourceGroup | undefined,
    streaming = false,
  ): StreamItem[] {
    // In simplified mode an incoming event is a prompt. Preserve provenance even
    // if an installed plugin handles the underlying tool type.
    const transformable = projectPluginTimelineItems(
      items,
      showInteractions ? transform : withoutSourceTransform(transform),
      streaming ? "streaming" : "complete",
    );
    return transformable.flatMap((item) =>
      presentRows(item, getSourceGroup(item.id), showInteractions),
    );
  }

  function collapse(
    projection: ToolCallDetailProjection,
    input: PresentationInput,
  ): Omit<
    StreamPresentation,
    "readingRowReplacements" | "sourceTail" | "sourceHead" | "hiddenItemIds"
  > {
    const collapseRegularTurns = input.display === "collapseTurns";
    if (!collapseRegularTurns && (input.showAgentInteractions || !hasHistorySources)) {
      return { ...projection, turns: NO_COLLAPSED_TURNS };
    }
    // Live text updates reach the head only, so the folded history is reused until the
    // retained rows, the latest turn's liveness, or the reader's expanded turns change.
    const isLatestTurnOpen = latestRetainedTurnIsOpen(projection, input);
    if (
      !collapsed ||
      collapsedSource !== projection.tail ||
      collapsedIsLatestTurnOpen !== isLatestTurnOpen ||
      collapsedRegularTurns !== collapseRegularTurns ||
      collapsedExpandedHostIds !== input.expandedTurnHostIds
    ) {
      collapsed = collapseTurns({
        tail: projection.tail,
        isLatestTurnOpen,
        collapseRegularTurns,
        expandedHostIds: input.expandedTurnHostIds,
        getGroupedCalls: (itemId) => projection.groupsByHostId.get(itemId)?.run.calls,
        previousSummaryRowsByHostId:
          collapsed?.summaryRowsByHostId ?? NO_COLLAPSED_TURNS.summaryRowsByHostId,
      });
      collapsedSource = projection.tail;
      collapsedIsLatestTurnOpen = isLatestTurnOpen;
      collapsedRegularTurns = collapseRegularTurns;
      collapsedExpandedHostIds = input.expandedTurnHostIds;
    }
    const { tail, ...turns } = collapsed;
    if (turns.nestedItemIds.size === 0) return { ...projection, tail, turns };
    // Opening a turn reveals its raw calls; those rows must not become group hosts again.
    const withoutExpandedRows = (groups: StreamPresentation["groupsByHostId"]) => ({
      size: groups.size - [...turns.nestedItemIds].filter((id) => groups.has(id)).length,
      get: (id: string) => (turns.nestedItemIds.has(id) ? undefined : groups.get(id)),
      has: (id: string) => !turns.nestedItemIds.has(id) && groups.has(id),
    });
    return {
      ...projection,
      tail,
      turns,
      groupsByHostId: withoutExpandedRows(projection.groupsByHostId),
      historyGroupUpdatesByHostId: withoutExpandedRows(projection.historyGroupUpdatesByHostId),
    };
  }

  return (input: PresentationInput): StreamPresentation => {
    // Interaction rows are removed before plugin transforms, tool grouping, and turn folding.
    // Keep the source projection alongside the display projection so search and the outline
    // use the same ungrouped filtered timeline.
    const interactionProjection = projectAgentInteractions({
      tail: input.tail,
      head: input.head,
      showAgentInteractions: input.showAgentInteractions,
    });
    const sourceTail = interactionProjection.tail;
    const sourceHead = interactionProjection.head;
    const showInteractions = input.showAgentInteractions === true;
    const sources = showInteractions ? undefined : groupAgentSources(sourceTail, sourceHead);
    const level: ToolCallDetailLevel = input.display === "full" ? "detailed" : "overview";
    // Retained history is not reprojected or regrouped on each live text update.
    if (
      historySource !== sourceTail ||
      historyTransform !== input.transform ||
      historyShowInteractions !== showInteractions ||
      historySourceBoundary !== sources?.boundary
    ) {
      historyRows = projectRows(
        sourceTail,
        input.transform,
        showInteractions,
        (id) => sources?.boundary.get(id) ?? sources?.history.get(id),
      );
      historySource = sourceTail;
      historyTransform = input.transform;
      historyShowInteractions = showInteractions;
      historySourceBoundary = sources?.boundary;
      hasHistorySources = historyRows.some((item) => sources?.history.has(item.id));
    }
    const head = projectRows(
      sourceHead,
      input.transform,
      showInteractions,
      (id) => sources?.boundary.get(id) ?? sources?.live.get(id),
      true,
    );
    if (
      preparedTail !== historyRows ||
      preparedLevel !== level ||
      preparedAutoExpandReasoning !== input.autoExpandReasoning
    ) {
      preparedHistory = prepareToolCallHistory(level, historyRows, input.autoExpandReasoning);
      historyGroupHosts = preparedHistory
        ? groupedRowHosts(preparedHistory.grouped.tail, preparedHistory.grouped.groupsByHostId)
        : new Map();
      preparedTail = historyRows;
      preparedLevel = level;
      preparedAutoExpandReasoning = input.autoExpandReasoning;
    }
    const projection = projectToolCallDetailLevel({
      level,
      tail: historyRows,
      head,
      preparedHistory,
      isTurnActive: input.isTurnActive,
    });
    const result = collapse(projection, input);
    // Only the trailing retained group can absorb head rows. Reuse the retained
    // index across streaming updates rather than walking the full history again.
    const last = projection.tail.at(-1);
    const liveGroupHosts = groupedRowHosts(
      last ? [last, ...projection.head] : projection.head,
      projection.groupsByHostId,
    );
    const retainedGroupHosts = historyGroupHosts;
    const beforeGrouping = { tail: indexHistory(historyRows), head: indexHead(head) };
    const displayed = {
      tail: indexDisplayedTail(result.tail),
      head: indexDisplayedHead(result.head),
    };
    const replacements = readingRowReplacements({
      previous: previousDisplayedRows,
      displayed,
      beforeGrouping,
      interactions: interactionProjection.readingRowReplacements,
      groups: { get: (id) => liveGroupHosts.get(id) ?? retainedGroupHosts.get(id) },
      turns: result.turns,
    });
    previousDisplayedRows = displayed;
    return {
      ...result,
      sourceTail,
      sourceHead,
      hiddenItemIds: interactionProjection.hiddenItemIds,
      readingRowReplacements: replacements,
    };
  };
}
