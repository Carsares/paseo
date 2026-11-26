import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  TopicReadEntrySchema,
  WorkspaceTopicReadSnapshotSchema,
  type TopicReadEntry,
  type WorkspaceTopicReadMarkAllRequest,
  type WorkspaceTopicReadMarkRequest,
  type WorkspaceTopicReadSnapshot,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

const MAX_TOPIC_ENTRIES = 500;
const NO_SEQ = -1;
const TopicScopeFileSchema = WorkspaceTopicReadSnapshotSchema.extend({
  workspaceId: WorkspaceTopicReadSnapshotSchema.shape.workspaceId.optional(),
  watermarkEpoch: WorkspaceTopicReadSnapshotSchema.shape.watermarkEpoch.default(null),
  watermarkSeq: WorkspaceTopicReadSnapshotSchema.shape.watermarkSeq.default(NO_SEQ),
  watermarkTimestampMs: WorkspaceTopicReadSnapshotSchema.shape.watermarkTimestampMs.default(0),
  topics: z.array(TopicReadEntrySchema).optional(),
  revision: WorkspaceTopicReadSnapshotSchema.shape.revision.default(0),
});
const TopicFileSchema = z.union([
  z.object({ snapshots: z.array(TopicScopeFileSchema) }),
  TopicScopeFileSchema,
  z.strictObject({}),
  z.null(),
]);

export type TopicReadKey = Pick<WorkspaceTopicReadSnapshot, "workspaceId" | "mainAgentId">;
export interface TopicReadCoordinates {
  /** Current authoritative epoch, or null when the timeline has no sequence coordinates. */
  epoch: string | null;
  headSeq?: number;
  /** Resolve a legacy sequence only after the current timeline verifies its sequence and time. */
  resolveLegacySeq?: (input: {
    seq: number | undefined;
    timestampMs: number | undefined;
  }) => Promise<number | undefined>;
}

export type TopicReadScope = TopicReadKey &
  (TopicReadCoordinates | { readCoordinates: () => Promise<TopicReadCoordinates> });

type MarkInput = Omit<WorkspaceTopicReadMarkRequest, "type" | "requestId">;
export type TopicReadBounds = Pick<
  WorkspaceTopicReadMarkAllRequest,
  "epoch" | "maxSeq" | "maxTimestampMs"
>;

interface TopicReadMutation {
  snapshot: WorkspaceTopicReadSnapshot;
  changed: boolean;
  applied: boolean;
}

const writeTails = new Map<string, Promise<void>>();

function emptySnapshot(key: TopicReadKey): WorkspaceTopicReadSnapshot {
  return {
    workspaceId: key.workspaceId,
    mainAgentId: key.mainAgentId,
    watermarkEpoch: null,
    watermarkSeq: NO_SEQ,
    watermarkTimestampMs: 0,
    topics: [],
    revision: 0,
  };
}

function boundTopics(entries: TopicReadEntry[]): TopicReadEntry[] {
  const topics = new Map<string, TopicReadEntry>();
  for (const entry of entries) {
    topics.delete(entry.topicKey);
    topics.set(entry.topicKey, entry);
  }
  return Array.from(topics.values()).slice(-MAX_TOPIC_ENTRIES);
}

function alignEpoch(
  current: WorkspaceTopicReadSnapshot,
  epoch: string | null,
): WorkspaceTopicReadSnapshot {
  if (current.watermarkEpoch === epoch) return current;
  return {
    ...current,
    watermarkEpoch: epoch,
    watermarkSeq: NO_SEQ,
    topics: current.topics.map((entry) => ({ ...entry, readUpToSeq: NO_SEQ })),
  };
}

function matchesObservedEpoch(
  scope: TopicReadCoordinates,
  epoch: string | null | undefined,
): boolean {
  return typeof epoch === "string" && epoch === scope.epoch;
}

function boundObservedSeq(
  scope: TopicReadCoordinates,
  epoch: string | null | undefined,
  seq: number | undefined,
): number | undefined {
  if (!matchesObservedEpoch(scope, epoch) || scope.headSeq === undefined || seq === undefined)
    return undefined;
  return Math.max(NO_SEQ, Math.min(seq, scope.headSeq));
}

async function resolveObservedSeq(
  scope: TopicReadCoordinates,
  input: MarkInput,
): Promise<number | undefined> {
  const observedSeq = boundObservedSeq(scope, input.epoch, input.seq);
  if (
    observedSeq !== undefined ||
    scope.epoch === null ||
    input.epoch !== undefined ||
    !scope.resolveLegacySeq
  ) {
    return observedSeq;
  }
  return scope.resolveLegacySeq({ seq: input.seq, timestampMs: input.timestampMs });
}

function advanceTimestamp(previous: number | undefined, observed: number | undefined) {
  return observed === undefined ? previous : Math.max(previous ?? 0, observed);
}

function explicitCardReadTime(input: MarkInput, observedSeq: number | undefined) {
  if (observedSeq !== undefined) return undefined;
  // COMPAT(topicReadLegacyTime): added in v0.18.0, remove once pre-epoch clients are unsupported.
  // Older card marks omitted the epoch. A modern mark with only a timestamp and an explicit
  // epoch (including null) can address a thread reply, whose time cannot cover timeline rows.
  if (input.epoch === undefined || input.seq !== undefined) return input.timestampMs;
  return undefined;
}

function clearCoveredUnread(entry: TopicReadEntry, bounds: TopicReadBounds): TopicReadEntry {
  if (entry.markedUnreadAtMs === null) return entry;
  // A manual unread entry stores one less than the observed sequence.
  const anchorSeq = entry.readUpToSeq + 1;
  const anchorTimestampMs = entry.readUpToTimestampMs;
  // -1 can represent either sequence zero or a time-only override.
  const compareSeq =
    bounds.maxSeq !== undefined && (entry.readUpToSeq !== NO_SEQ || anchorTimestampMs === 0);
  const timestampBound = anchorTimestampMs > 0 ? bounds.maxTimestampMs : undefined;
  const compareTimestamp = timestampBound !== undefined;
  if (!compareSeq && !compareTimestamp) return entry;
  if (bounds.maxSeq !== undefined && anchorSeq > bounds.maxSeq) return entry;
  if (timestampBound !== undefined && anchorTimestampMs > timestampBound) return entry;
  return { ...entry, markedUnreadAtMs: null };
}

/** File-backed read state only. Workspace access and attention are owned by the request caller. */
export class TopicReadStateStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  async getState(key: TopicReadKey): Promise<WorkspaceTopicReadSnapshot> {
    const snapshots = await this.read(key.workspaceId);
    return (
      snapshots.find((snapshot) => snapshot.mainAgentId === key.mainAgentId) ?? emptySnapshot(key)
    );
  }

  withState<T>(
    key: TopicReadKey,
    operation: (state: WorkspaceTopicReadSnapshot) => Promise<T>,
  ): Promise<T> {
    return this.serialize(key.workspaceId, () => this.getState(key).then(operation));
  }

  mark(scope: TopicReadScope, input: MarkInput): Promise<TopicReadMutation> {
    return this.mutate(scope, async (current, coordinates) => {
      if (typeof input.epoch === "string" && !matchesObservedEpoch(coordinates, input.epoch))
        return null;
      const observedSeq = await resolveObservedSeq(coordinates, input);
      // An old sender can still mark by time. A sequence alone cannot identify its generation.
      if (observedSeq === undefined && input.timestampMs === undefined) return null;
      const aligned = coordinates.epoch === null ? current : alignEpoch(current, coordinates.epoch);
      const previous = aligned.topics.find((entry) => entry.topicKey === input.topicKey);
      const seq = Math.max(NO_SEQ, observedSeq ?? NO_SEQ);
      const now = this.now();
      const isRead = input.mode === "read";
      const readUpToSeq = isRead
        ? Math.max(previous?.readUpToSeq ?? NO_SEQ, seq)
        : Math.max(NO_SEQ, seq - 1);
      const timestampMs = input.timestampMs ?? previous?.readUpToTimestampMs ?? 0;
      const readUpToTimestampMs = isRead
        ? Math.max(previous?.readUpToTimestampMs ?? 0, timestampMs)
        : timestampMs;
      const readUpToTimelineTimestampMs = isRead
        ? advanceTimestamp(
            previous?.readUpToTimelineTimestampMs,
            explicitCardReadTime(input, observedSeq),
          )
        : undefined;
      const entry: TopicReadEntry = {
        topicKey: input.topicKey,
        readUpToSeq,
        readUpToTimestampMs,
        ...(readUpToTimelineTimestampMs === undefined ? {} : { readUpToTimelineTimestampMs }),
        markedUnreadAtMs: isRead ? null : now,
        updatedAt: new Date(now).toISOString(),
      };
      const otherTopics = aligned.topics.filter((topic) => topic.topicKey !== entry.topicKey);
      return { ...aligned, topics: boundTopics([...otherTopics, entry]) };
    });
  }

  markAll(scope: TopicReadScope, bounds: TopicReadBounds): Promise<TopicReadMutation> {
    return this.mutate(scope, (current, coordinates) => {
      if (typeof bounds.epoch === "string" && !matchesObservedEpoch(coordinates, bounds.epoch))
        return null;
      const maxSeq = boundObservedSeq(coordinates, bounds.epoch, bounds.maxSeq);
      const maxTimestampMs = bounds.maxTimestampMs;
      if (maxSeq === undefined && maxTimestampMs === undefined) return null;

      const aligned = coordinates.epoch === null ? current : alignEpoch(current, coordinates.epoch);
      // Previous watermarks may be higher. Unread overrides are cleared only by this request's bounds.
      const topics = aligned.topics.map((entry) => {
        return clearCoveredUnread(entry, {
          maxSeq: aligned === current ? maxSeq : undefined,
          maxTimestampMs,
        });
      });
      const watermarkSeq = Math.max(aligned.watermarkSeq, maxSeq ?? NO_SEQ);
      const watermarkTimestampMs = Math.max(aligned.watermarkTimestampMs, maxTimestampMs ?? 0);
      const watermarkTimelineTimestampMs = advanceTimestamp(
        aligned.watermarkTimelineTimestampMs,
        maxSeq === undefined ? maxTimestampMs : undefined,
      );
      if (
        aligned === current &&
        watermarkSeq === current.watermarkSeq &&
        watermarkTimestampMs === current.watermarkTimestampMs &&
        watermarkTimelineTimestampMs === current.watermarkTimelineTimestampMs &&
        topics.every((topic, index) => topic === current.topics[index])
      ) {
        return current;
      }
      return {
        ...aligned,
        watermarkSeq,
        watermarkTimestampMs,
        ...(watermarkTimelineTimestampMs === undefined ? {} : { watermarkTimelineTimestampMs }),
        topics,
      };
    });
  }

  private filePath(workspaceId: string): string {
    const safeId = z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .parse(workspaceId);
    return resolve(this.dir, `${safeId}.json`);
  }

  private async read(workspaceId: string): Promise<WorkspaceTopicReadSnapshot[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(workspaceId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    if (!raw.trim()) return [];
    const parsed = TopicFileSchema.parse(JSON.parse(raw));
    if (!parsed) return [];
    let snapshots: z.output<typeof TopicScopeFileSchema>[];
    if ("snapshots" in parsed) snapshots = parsed.snapshots;
    else if (typeof parsed.mainAgentId === "string")
      snapshots = [TopicScopeFileSchema.parse(parsed)];
    else return [];
    const normalized: WorkspaceTopicReadSnapshot[] = [];
    for (const { workspaceId: storedWorkspaceId, topics, ...snapshot } of snapshots) {
      if (storedWorkspaceId !== undefined && storedWorkspaceId !== workspaceId) {
        throw new Error("Topic read state belongs to a different workspace");
      }
      normalized.push({ ...snapshot, workspaceId, topics: boundTopics(topics ?? []) });
    }
    return normalized;
  }

  private mutate(
    key: TopicReadScope,
    update: (
      current: WorkspaceTopicReadSnapshot,
      coordinates: TopicReadCoordinates,
    ) => Promise<WorkspaceTopicReadSnapshot | null> | WorkspaceTopicReadSnapshot | null,
  ): Promise<TopicReadMutation> {
    const filePath = this.filePath(key.workspaceId);
    return this.serialize(key.workspaceId, async () => {
      const snapshots = await this.read(key.workspaceId);
      const index = snapshots.findIndex((snapshot) => snapshot.mainAgentId === key.mainAgentId);
      const current = snapshots[index] ?? emptySnapshot(key);
      const coordinates = "readCoordinates" in key ? await key.readCoordinates() : key;
      const next = await update(current, coordinates);
      if (next === null) return { snapshot: current, changed: false, applied: false };
      if (next === current) return { snapshot: current, changed: false, applied: true };

      const snapshot = WorkspaceTopicReadSnapshotSchema.parse({
        ...next,
        revision: current.revision + 1,
      });
      if (index < 0) snapshots.push(snapshot);
      else snapshots[index] = snapshot;
      await writeJsonFileAtomic(filePath, { snapshots });
      return { snapshot, changed: true, applied: true };
    });
  }

  private async serialize<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
    const filePath = this.filePath(workspaceId);
    const prior = writeTails.get(filePath) ?? Promise.resolve();
    const operation = prior.then(run);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    writeTails.set(filePath, tail);
    try {
      return await operation;
    } finally {
      if (writeTails.get(filePath) === tail) writeTails.delete(filePath);
    }
  }
}
