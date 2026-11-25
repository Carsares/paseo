import { randomUUID } from "node:crypto";
import { TimelineProjection, type ProjectedTimelineRow } from "./timeline-projection.js";
import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";
import type { AgentMetric, AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineWindow,
} from "./agent-timeline-store-types.js";

export interface SeedAgentTimelineOptions {
  items?: readonly AgentTimelineItem[];
  rows?: readonly AgentTimelineRow[];
  epoch?: string;
  nextSeq?: number;
  sealedThrough?: number;
  timestamp?: string;
}

interface AgentTimelineState {
  epoch: string;
  projection: TimelineProjection;
  minSeq: number;
  earliestCoveredSeq: number | null;
  nextSeq: number;
  sealedThrough: number;
  prefixToolIds: ReadonlySet<string>;
}
const DEFAULT_TIMELINE_FETCH_LIMIT = 200;
function cloneRow<T extends AgentTimelineRow>(row: T): T {
  return { ...row };
}

function toolIdentity(callId: string, turnId?: string): string {
  return JSON.stringify([turnId, callId]);
}

function getPrefixToolIds(rows: readonly AgentTimelineRow[], sealedThrough: number): Set<string> {
  const ids = new Set<string>();
  if (!sealedThrough) return ids;
  for (const { item, seq, turnId } of rows) {
    if (seq <= sealedThrough && item.type === "tool_call") {
      ids.add(toolIdentity(item.callId, turnId));
    }
  }
  return ids;
}

function distinguishToolFromPrefix(
  state: AgentTimelineState,
  item: AgentTimelineItem,
  turnId?: string,
): AgentTimelineItem {
  if (item.type !== "tool_call" || !state.prefixToolIds.size) return item;
  let { callId } = item;
  // Preserve the retained call ID. Clients key tool updates by turn and call
  // ID, so a provider replay with neither a new turn ID nor a new call ID
  // would otherwise replace the earlier call.
  while (state.prefixToolIds.has(toolIdentity(callId, turnId))) {
    callId = `paseo-context:${callId}`;
  }
  return callId === item.callId ? item : { ...item, callId };
}

export class InMemoryAgentTimelineStore {
  private readonly states = new Map<string, AgentTimelineState>();

  has(agentId: string): boolean {
    return this.states.has(agentId);
  }

  initialize(agentId: string, options?: SeedAgentTimelineOptions): void {
    const timestamp = options?.timestamp ?? new Date().toISOString();
    const rows = options?.rows?.length
      ? options.rows.map(cloneRow)
      : this.buildRowsFromItems(options?.items ?? [], options?.nextSeq ?? 1, timestamp);
    const nextSeq = rows.reduce((next, row) => Math.max(next, row.seq + 1), options?.nextSeq ?? 1);
    const sealedThrough = options?.sealedThrough ?? 0;
    const projection = new TimelineProjection(rows, sealedThrough);
    const firstSeq = projection.getRows()[0]?.seqStart ?? null;
    this.states.set(agentId, {
      epoch: options?.epoch ?? randomUUID(),
      projection,
      minSeq: firstSeq ?? 0,
      earliestCoveredSeq: firstSeq,
      nextSeq,
      sealedThrough,
      prefixToolIds: getPrefixToolIds(rows, sealedThrough),
    });
  }

  delete(agentId: string): void {
    this.states.delete(agentId);
  }

  sealPrefix(agentId: string): void {
    const state = this.requireState(agentId);
    state.sealedThrough = state.nextSeq - 1;
    state.prefixToolIds = getPrefixToolIds(state.projection.getRows(), state.sealedThrough);
    state.projection.seal();
  }

  getSealedThrough(agentId: string): number {
    return this.requireState(agentId).sealedThrough;
  }

  removeAssistantMessages(agentId: string, turnId: string, messageIds: readonly string[]): boolean {
    const state = this.requireState(agentId);
    const ids = new Set(messageIds);
    const previous = state.projection.getRows();
    const rows = previous.filter(
      (row) =>
        !(
          row.turnId === turnId &&
          row.item.type === "assistant_message" &&
          row.item.messageId !== undefined &&
          ids.has(row.item.messageId)
        ),
    );
    if (rows.length === previous.length) return false;
    // Keep sequence numbers monotonic; a new epoch invalidates clients' old rows and cursors.
    this.initialize(agentId, { rows, nextSeq: state.nextSeq, sealedThrough: state.sealedThrough });
    // A deleted prefix still belongs to the covered range, unlike truncated history.
    this.requireState(agentId).earliestCoveredSeq = state.earliestCoveredSeq;
    return true;
  }

  getItems(agentId: string): AgentTimelineItem[] {
    return this.requireState(agentId)
      .projection.getRows()
      .map((row) => row.item);
  }

  getRows(agentId: string): ProjectedTimelineRow[] {
    return this.requireState(agentId).projection.getRows().map(cloneRow);
  }

  getSubmittedUserMessage(agentId: string, clientMessageId: string): AgentTimelineRow | null {
    const row = this.requireState(agentId)
      .projection.getRows()
      .find(
        (candidate) =>
          candidate.item.type === "user_message" &&
          candidate.item.clientMessageId === clientMessageId,
      );
    return row ? cloneRow(row) : null;
  }

  enrichSubmittedUserMessage(
    agentId: string,
    clientMessageId: string,
    providerMessageId: string,
  ): AgentTimelineRow | null {
    return this.requireState(agentId).projection.enrichSubmittedUserMessage(
      clientMessageId,
      providerMessageId,
    );
  }

  /** Records a completed turn's metrics on its footer row. Null when the turn has none. */
  stampTurnMetrics(
    agentId: string,
    metrics: AgentMetric[],
    options?: { turnId?: string },
  ): AgentTimelineRow | null {
    return this.requireState(agentId).projection.stampTurnMetrics(metrics, options?.turnId);
  }

  getEpoch(agentId: string): string {
    return this.requireState(agentId).epoch;
  }

  getHead(agentId: string): { epoch: string; seq: number } {
    const state = this.requireState(agentId);
    return { epoch: state.epoch, seq: state.nextSeq - 1 };
  }

  fetch(agentId: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    const state = this.requireState(agentId);
    const direction = options?.direction ?? "tail";
    const cursor = options?.cursor;
    const window: AgentTimelineWindow = {
      minSeq: state.minSeq,
      maxSeq: state.nextSeq - 1,
      nextSeq: state.nextSeq,
    };
    const staleCursor = cursor !== undefined && cursor.epoch !== state.epoch;
    const gap =
      !staleCursor &&
      direction === "after" &&
      cursor !== undefined &&
      state.earliestCoveredSeq !== null &&
      cursor.seq < state.earliestCoveredSeq - 1;
    const reset = staleCursor || gap;
    const page = state.projection.selectPage({
      bounds: window,
      afterCoverageStart: state.earliestCoveredSeq ?? undefined,
      direction: reset ? "tail" : direction,
      cursorSeq: cursor?.seq,
      limit: options?.limit ?? DEFAULT_TIMELINE_FETCH_LIMIT,
      wholeTurns: options?.wholeTurns,
    });
    return {
      epoch: state.epoch,
      direction,
      reset,
      staleCursor,
      gap,
      window,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      // Stored rows are already within budget; this bounds assistant and reasoning merges.
      rows: page.entries.map((entry) =>
        Object.assign({ seq: entry.seqEnd }, entry, {
          item: limitAgentTimelineItemContent(entry.item),
        }),
      ),
    };
  }

  append(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; providerMessageId?: string; turnId?: string },
  ): AgentTimelineRow {
    const state = this.requireState(agentId);
    const row: AgentTimelineRow = {
      seq: state.nextSeq,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item: distinguishToolFromPrefix(state, item, options?.turnId),
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
    };
    state.nextSeq += 1;
    if (state.minSeq === 0) state.minSeq = row.seq;
    state.earliestCoveredSeq ??= row.seq;
    state.projection.append(row);
    return cloneRow(row);
  }

  getLastItem(agentId: string): AgentTimelineItem | null {
    const state = this.requireState(agentId);
    return state.projection.getLastItem(state.nextSeq - 1);
  }

  getLastAssistantMessage(agentId: string): string | null {
    return this.requireState(agentId).projection.getLastAssistantMessage();
  }

  private requireState(agentId: string): AgentTimelineState {
    const state = this.states.get(agentId);
    if (!state) {
      throw new Error(`Unknown agent '${agentId}'`);
    }
    return state;
  }

  private buildRowsFromItems(
    items: readonly AgentTimelineItem[],
    startSeq: number,
    timestamp: string,
  ): AgentTimelineRow[] {
    let nextSeq = startSeq;
    return items.map((item) => {
      const row: AgentTimelineRow = {
        seq: nextSeq,
        timestamp,
        item,
      };
      nextSeq += 1;
      return row;
    });
  }
}
