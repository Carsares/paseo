import { promises as fs } from "node:fs";
import { join } from "node:path";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";
import { writeFileAtomic } from "../atomic-file.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import type { ProjectedTimelineRow } from "./timeline-projection.js";

export interface PersistedTimelinePrefix {
  version: 1;
  rows: AgentTimelineRow[];
  pendingContextHandoff?: { olderSummary?: string | null } | null;
}

const suffix = ".timeline-prefix.json";
const prefixSchema = z.object({
  version: z.literal(1),
  rows: z.array(
    z.looseObject({
      seq: z.number().int().positive(),
      timestamp: z.string(),
      item: AgentTimelineItemPayloadSchema,
      turnId: z.string().optional(),
      providerMessageId: z.string().optional(),
      topicKey: z.string().min(1).optional(),
      taskId: z.string().min(1).optional(),
      rootMessageId: z.string().min(1).optional(),
    }),
  ),
  pendingContextHandoff: z.object({ olderSummary: z.string().nullish() }).nullish(),
});
const stagedPrefixSchema = z.object({
  switchId: z.string(),
  previous: prefixSchema.nullable(),
  next: prefixSchema,
});

export function isTimelinePrefixFilename(name: string): boolean {
  return name.endsWith(suffix);
}

export function retainTimelinePrefixRows(rows: readonly AgentTimelineRow[]): AgentTimelineRow[] {
  return rows.filter((row) => row.item.type !== "compaction" || row.item.status !== "loading");
}

export class TimelinePrefixStore {
  private readonly memory = new Map<string, PersistedTimelinePrefix>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    private readonly agentsDir?: string,
    private readonly readCommittedSwitch?: (agentId: string) => Promise<string | null | undefined>,
  ) {}

  async load(agentId: string): Promise<PersistedTimelinePrefix | null> {
    await this.writes.get(agentId)?.catch(() => undefined);
    if (!this.agentsDir) return structuredClone(this.memory.get(agentId) ?? null);
    try {
      const data = await fs.readFile(this.pathFor(agentId), "utf8");
      const value: unknown = JSON.parse(data);
      const staged = stagedPrefixSchema.safeParse(value);
      if (!staged.success) return prefixSchema.parse(value);
      return (await this.readCommittedSwitch?.(agentId)) === staged.data.switchId
        ? staged.data.next
        : staged.data.previous;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(agentId: string, prefix: PersistedTimelinePrefix): Promise<void> {
    const value = { ...prefix, rows: retainTimelinePrefixRows(prefix.rows) };
    if (this.agentsDir) {
      const data = JSON.stringify(value);
      await this.write(agentId, () => writeFileAtomic(this.pathFor(agentId), data));
    } else {
      this.memory.set(agentId, structuredClone(value));
    }
  }

  /** Publish both versions in one rename. The agent record selects the committed version. */
  stageSwitch(
    agentId: string,
    switchId: string,
    previous: PersistedTimelinePrefix | null,
    next: PersistedTimelinePrefix,
  ): Promise<void> {
    if (!this.agentsDir) return this.save(agentId, next);
    const data = JSON.stringify({ switchId, previous, next });
    return this.write(agentId, () => writeFileAtomic(this.pathFor(agentId), data));
  }

  async delete(agentId: string): Promise<void> {
    if (this.agentsDir) {
      await this.write(agentId, () => fs.rm(this.pathFor(agentId), { force: true }));
    } else this.memory.delete(agentId);
  }

  private async write(agentId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.writes.set(agentId, next);
    try {
      await next;
    } finally {
      if (this.writes.get(agentId) === next) this.writes.delete(agentId);
    }
  }

  private pathFor(agentId: string): string {
    return join(this.agentsDir!, encodeURIComponent(agentId) + suffix);
  }
}

export function sliceTimelineRowsAtBoundary(
  rows: readonly AgentTimelineRow[],
  options: {
    boundaryCursor?: { epoch: string; seq: number };
    boundaryMessageId?: string;
    timelineEpoch?: string;
  },
): AgentTimelineRow[] {
  const { boundaryCursor, boundaryMessageId } = options;
  const copyable = retainTimelinePrefixRows(rows).filter(({ item }) => item.type !== "plugin");
  if (!boundaryCursor && boundaryMessageId === undefined) return copyable;
  const boundary = boundaryCursor
    ? rows.find(
        (row) => boundaryCursor.epoch === options.timelineEpoch && row.seq === boundaryCursor.seq,
      )
    : rows.findLast((row) => matchesBoundaryMessage(row, boundaryMessageId?.trim() ?? ""));
  if (!boundary) {
    throw new Error(
      boundaryCursor
        ? "Selected timeline position is no longer available."
        : "Selected message is no longer available.",
    );
  }
  return copyable.flatMap((row) => {
    if (row.seq <= boundary.seq) return [row];
    const checkpoint = toolRowAtBoundary(row, boundary.seq);
    return checkpoint ? [checkpoint] : [];
  });
}

function toolRowAtBoundary(row: AgentTimelineRow, boundary: number): ProjectedTimelineRow | null {
  if (row.item.type !== "tool_call" || !("seqStart" in row)) return null;
  const projected = row as ProjectedTimelineRow;
  if (projected.seqStart > boundary) return null;
  const sourceSeqRanges = projected.sourceSeqRanges
    .filter((range) => range.startSeq <= boundary)
    .map(({ startSeq, endSeq }) => ({ startSeq, endSeq: Math.min(endSeq, boundary) }));
  const seqEnd = sourceSeqRanges.at(-1)?.endSeq ?? projected.seqStart;
  return {
    ...projected,
    seq: seqEnd,
    seqEnd,
    sourceSeqRanges,
    item: { ...row.item, status: "running", error: null },
  };
}

function matchesBoundaryMessage(row: AgentTimelineRow, messageId: string): boolean {
  if ("id" in row && row.id === messageId) return true;
  const { item } = row;
  switch (item.type) {
    case "user_message":
      return item.clientMessageId === messageId || item.messageId === messageId;
    case "assistant_message":
      return item.messageId === messageId;
    default:
      return false;
  }
}
