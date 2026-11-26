import type { ProjectedTimelineRow } from "./timeline-projection.js";
import type { AgentMetric, AgentTimelineItem } from "./agent-sdk-types.js";

export interface AgentTimelineRow {
  seq: number;
  timestamp: string;
  item: AgentTimelineItem;
  readonly turnId?: string;
  readonly providerMessageId?: string;
  readonly topicKey?: string;
  readonly taskId?: string;
  readonly rootMessageId?: string;
  /** Metrics of the turn this row carries the footer for. */
  readonly turnMetrics?: AgentMetric[];
}

export interface AgentTimelineCursor {
  epoch: string;
  seq: number;
}

export type AgentTimelineFetchDirection = "tail" | "before" | "after";

export interface AgentTimelineFetchOptions {
  wholeTurns?: boolean;
  direction?: AgentTimelineFetchDirection;
  cursor?: AgentTimelineCursor;
  /**
   * Number of projected items to return.
   * - undefined: store default
   * - 0: all rows in the selected window
   */
  limit?: number;
}

export interface AgentTimelineWindow {
  minSeq: number;
  /** Highest allocated sequence, which can belong to a retracted row. */
  maxSeq: number;
  nextSeq: number;
}

export interface AgentTimelineFetchResult {
  epoch: string;
  direction: AgentTimelineFetchDirection;
  reset: boolean;
  staleCursor: boolean;
  gap: boolean;
  window: AgentTimelineWindow;
  hasOlder: boolean;
  hasNewer: boolean;
  startSeq: number | null;
  /** Coverage cursor, including retracted sequences before the next retained row. */
  endSeq: number | null;
  rows: ProjectedTimelineRow[];
}

export interface AgentTimelineStore {
  appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: {
      timestamp?: string;
      turnId?: string;
      topicKey?: string;
      taskId?: string;
      rootMessageId?: string;
    },
  ): Promise<AgentTimelineRow>;
  fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult>;
  getLatestCommittedSeq(agentId: string): Promise<number>;
  getCommittedRows(agentId: string): Promise<AgentTimelineRow[]>;
  getLastItem(agentId: string): Promise<AgentTimelineItem | null>;
  getLastAssistantMessage(agentId: string): Promise<string | null>;
  deleteAgent(agentId: string): Promise<void>;
  removeAssistantMessages(
    agentId: string,
    turnId: string,
    messageIds: readonly string[],
  ): Promise<void>;
  bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void>;
  updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void>;
}
