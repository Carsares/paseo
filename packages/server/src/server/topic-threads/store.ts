import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  TopicAnchorSummarySchema,
  TopicThreadEntrySchema,
  WorkspaceDurableItemSchema,
  WorkspaceTaskSummarySchema,
  WorkspaceTopicDecideRequestSchema,
  type TopicAnchorSummary,
  type TopicThreadEntry,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import { normalizePathForIdentity } from "../../utils/path.js";
import { writeJsonFileAtomic } from "../atomic-file.js";

import {
  checkTopicAddress,
  mergeAnchor,
  requireMatchingAnchor,
  sameThreadScope,
  type TopicAnchorInput,
} from "./anchors.js";

export type ThreadScope = Pick<TopicThreadEntry, "workspaceId" | "mainAgentId">;
type Followup = Pick<
  TopicThreadEntry,
  "workspaceId" | "mainAgentId" | "topicKey" | "taskId" | "rootMessageId" | "routedAgentId" | "text"
> &
  Pick<TopicThreadEntry, "origin" | "durableItemRequestId" | "decision"> & {
    sourceMessageId: string;
  };
export type TopicReportInput = Pick<
  TopicThreadEntry,
  "workspaceId" | "mainAgentId" | "topicKey" | "taskId" | "rootMessageId" | "text" | "authorTitle"
> &
  Required<Pick<TopicThreadEntry, "authorAgentId" | "sourceMessageId" | "reportStatus">> & {
    routedAgentId?: string;
  };
interface TopicThreadSnapshot {
  entries: TopicThreadEntry[];
  anchors: TopicAnchorSummary[];
}
interface EntryWrite {
  entry: TopicThreadEntry;
  changed: boolean;
}

const decisionInputSchema = WorkspaceTopicDecideRequestSchema.omit({ type: true, requestId: true });
const storedDecisionSchema = z.object({
  input: decisionInputSchema,
  origin: z.enum(["decision_reply", "butler_dispatch"]),
  principalId: z.string().optional(),
  operationId: z.uuid(),
  taskCreatedAt: z.iso.datetime(),
  status: WorkspaceTaskSummarySchema.shape.status,
  desiredStatus: WorkspaceTaskSummarySchema.shape.status,
  taskId: z.string().min(1),
  rootMessageId: z.string().optional(),
  blockingQuestion: z.string().optional(),
  blockingQuestionGeneration: z.uuid().nullable().optional(),
  durableItem: WorkspaceDurableItemSchema.optional(),
  task: WorkspaceTaskSummarySchema.optional(),
});
export type StoredTopicDecision = z.infer<typeof storedDecisionSchema>;
type NewTopicDecision = Omit<StoredTopicDecision, "operationId" | "durableItem" | "task">;
type TopicDecisionProgress = Pick<StoredTopicDecision, "durableItem" | "task">;
export type TopicAgentReply = Pick<TopicThreadEntry, "text" | "sourceMessageId" | "authorTitle">;

function requireMatchingFollowup(previous: TopicThreadEntry, followup: Followup) {
  const promoted =
    followup.rootMessageId &&
    followup.topicKey === `msg:${followup.rootMessageId}` &&
    previous.rootMessageId === followup.rootMessageId &&
    previous.topicKey.startsWith("task:");
  const sameTopic = previous.topicKey === followup.topicKey || promoted;
  const sameOrigin = (previous.origin ?? "topic_reply") === (followup.origin ?? "topic_reply");
  if (
    previous.role !== "user_followup" ||
    !sameTopic ||
    !sameOrigin ||
    previous.text !== followup.text
  )
    throw new Error("This message ID is already used by another topic follow-up.");
}

const storedEntrySchema = TopicThreadEntrySchema.extend({ handoffPending: z.boolean().optional() });
type StoredEntry = z.infer<typeof storedEntrySchema>;
const entriesSchema = z.array(storedEntrySchema);
const topicFileSchema = z.object({
  version: z.literal(2),
  anchors: z.array(TopicAnchorSummarySchema),
  entries: entriesSchema,
  decisions: z.array(storedDecisionSchema).optional(),
});
type TopicFile = z.infer<typeof topicFileSchema>;
export type TopicTaskBinding = Pick<TopicAnchorInput, "taskId" | "rootMessageId">;

function migrateLegacyReplies(
  data: TopicFile,
  anchor: TopicAnchorSummary,
  messageKey: string,
  knownTasks: readonly TopicTaskBinding[],
): StoredEntry[] {
  const { taskId, rootMessageId } = anchor;
  if (!taskId || !rootMessageId) return data.entries;

  const matchesRoot = (entry: TopicThreadEntry | TopicAnchorSummary) =>
    sameThreadScope(entry, anchor) &&
    (entry.rootMessageId === rootMessageId ||
      (!entry.rootMessageId && entry.topicKey === messageKey));
  const owners = new Set([taskId]);
  for (const binding of [...data.anchors.filter(matchesRoot), ...knownTasks]) {
    if (binding.rootMessageId === rootMessageId && binding.taskId) owners.add(binding.taskId);
  }
  for (const entry of data.entries) {
    if (matchesRoot(entry) && entry.taskId) owners.add(entry.taskId);
  }

  return data.entries.map((entry) => {
    if (entry.topicKey !== messageKey || !matchesRoot(entry)) return entry;
    if (entry.taskId ? entry.taskId !== taskId : owners.size !== 1) return entry;
    return { ...entry, topicKey: anchor.topicKey, taskId, rootMessageId };
  });
}

function requireDecisionClaim(data: TopicFile, followup: Followup) {
  const record = data.decisions?.find(
    ({ input }) =>
      sameThreadScope(input, followup) && input.clientMessageId === followup.sourceMessageId,
  );
  const isDecision = followup.origin === "decision_reply" || followup.origin === "butler_dispatch";
  if (!isDecision) {
    if (record) throw new Error("This message ID is already used by a topic decision.");
    return;
  }
  if (!record?.task || record.origin !== followup.origin || record.taskId !== followup.taskId)
    throw new Error("The topic decision has not been applied to this task.");
  if (record.input.resolutionKind === "durable_item" && !record.durableItem)
    throw new Error("The durable item decision has not been recorded.");
}

const pendingByFile = new Map<string, Promise<void>>();
const activeEntries = new Set<string>();

function publicEntry({ handoffPending: _, ...entry }: StoredEntry): TopicThreadEntry {
  return entry;
}

async function readTopicFile(file: string): Promise<TopicFile> {
  try {
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    if (Array.isArray(data)) return { version: 2, anchors: [], entries: entriesSchema.parse(data) };
    return topicFileSchema.parse(data);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { version: 2, anchors: [], entries: [] };
    throw error;
  }
}

export class TopicThreadStore {
  private readonly directory: string;

  constructor(paseoHome: string) {
    this.directory = resolve(normalizePathForIdentity(resolve(paseoHome)), "topic-threads");
  }

  private run<T>(
    workspaceId: string,
    operation: (data: TopicFile, file: string) => Promise<T> | T,
  ): Promise<T> {
    if (
      !/^[a-z\d_-]{1,128}$/i.test(workspaceId) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(workspaceId)
    )
      throw new Error("Invalid workspace ID for a topic thread file");
    const file = resolve(this.directory, `${workspaceId}.json`);
    const result = (pendingByFile.get(file) ?? Promise.resolve()).then(async () => {
      return operation(await readTopicFile(file), file);
    });
    const cleanup = () => {
      if (pendingByFile.get(file) === pending) pendingByFile.delete(file);
    };
    const pending = result.then(cleanup, cleanup);
    pendingByFile.set(file, pending);
    return result;
  }

  async list(scope: ThreadScope, topicKey?: string): Promise<TopicThreadEntry[]> {
    return (await this.listWithAnchors(scope, topicKey)).entries;
  }

  listWithAnchors(scope: ThreadScope, topicKey?: string): Promise<TopicThreadSnapshot> {
    return this.run(scope.workspaceId, (data) => {
      const matches = (item: TopicThreadEntry | TopicAnchorSummary) =>
        sameThreadScope(item, scope) && (topicKey === undefined || item.topicKey === topicKey);
      return {
        entries: data.entries.filter(matches).map(publicEntry),
        anchors: data.anchors.filter(matches),
      };
    });
  }

  upsertAnchor(
    input: TopicAnchorInput,
    assertCurrent?: () => void,
    knownTasks: readonly TopicTaskBinding[] = [],
  ): Promise<TopicAnchorSummary> {
    return this.run(input.workspaceId, async (data, file) => {
      const { anchor, anchors, removedMessageKey } = mergeAnchor(data.anchors, input);
      if (removedMessageKey)
        data.entries = migrateLegacyReplies(data, anchor, removedMessageKey, knownTasks);
      data.anchors = anchors;
      assertCurrent?.();
      await writeJsonFileAtomic(file, data);
      return anchor;
    });
  }

  appendReportEntry(input: TopicReportInput): Promise<EntryWrite> {
    return this.appendCompleted({
      ...input,
      routedAgentId: input.routedAgentId ?? input.authorAgentId,
      role: "agent_reply",
      origin: "subagent_report",
    });
  }

  appendDecisionEntry(input: Followup, assertCurrent?: () => void): Promise<EntryWrite> {
    return this.appendCompleted({ ...input, role: "system_note" }, assertCurrent);
  }

  private appendCompleted(
    input: Followup &
      Pick<TopicThreadEntry, "role" | "reportStatus" | "authorAgentId" | "authorTitle">,
    assertCurrent?: () => void,
  ): Promise<EntryWrite> {
    return this.run(input.workspaceId, async (data, file) => {
      checkTopicAddress(input);
      if (input.role === "system_note") requireDecisionClaim(data, input);
      const anchor = data.anchors.find(
        (item) => sameThreadScope(item, input) && item.topicKey === input.topicKey,
      );
      requireMatchingAnchor(anchor, input);
      const previous = data.entries.find(
        (entry) =>
          sameThreadScope(entry, input) &&
          entry.sourceMessageId === input.sourceMessageId &&
          (input.origin === "subagent_report"
            ? entry.origin === input.origin
            : entry.role !== "agent_reply"),
      );
      if (previous) {
        if (
          previous.role !== input.role ||
          previous.origin !== input.origin ||
          previous.topicKey !== input.topicKey
        )
          throw new Error("This message ID is already used by another topic entry.");
        return { entry: publicEntry(previous), changed: false };
      }
      const entry = this.newEntry(data, input, "completed");
      data.entries.push(entry);
      assertCurrent?.();
      await writeJsonFileAtomic(file, data);
      return { entry, changed: true };
    });
  }

  getDecision(
    scope: ThreadScope,
    clientMessageId: string,
  ): Promise<StoredTopicDecision | undefined> {
    return this.run(scope.workspaceId, ({ decisions }) =>
      decisions?.find(
        ({ input }) => sameThreadScope(input, scope) && input.clientMessageId === clientMessageId,
      ),
    );
  }

  reserveDecision(
    decision: NewTopicDecision,
    assertCurrent?: () => void,
  ): Promise<StoredTopicDecision> {
    const { input } = decision;
    return this.run(input.workspaceId, async (data, file) => {
      const decisions = (data.decisions ??= []);
      const existing = decisions.find(
        (record) =>
          sameThreadScope(record.input, input) &&
          record.input.clientMessageId === input.clientMessageId,
      );
      if (existing) return existing;
      const usedEntry = data.entries.find(
        (entry) =>
          sameThreadScope(entry, input) &&
          entry.role !== "agent_reply" &&
          entry.sourceMessageId === input.clientMessageId,
      );
      if (usedEntry) throw new Error("This message ID is already used by another topic entry.");
      const stored = storedDecisionSchema.parse({ ...decision, operationId: randomUUID() });
      decisions.push(stored);
      assertCurrent?.();
      await writeJsonFileAtomic(file, data);
      return stored;
    });
  }

  saveDecisionProgress(
    record: StoredTopicDecision,
    progress: TopicDecisionProgress,
  ): Promise<StoredTopicDecision> {
    return this.run(record.input.workspaceId, async (data, file) => {
      const current = data.decisions?.find(({ operationId }) => operationId === record.operationId);
      if (!current) throw new Error("Topic decision is no longer recorded.");
      Object.assign(current, progress);
      await writeJsonFileAtomic(file, data);
      return current;
    });
  }

  private newEntry(
    { entries }: TopicFile,
    input: Followup & Pick<TopicThreadEntry, "role">,
    status: "queued" | "completed",
  ): TopicThreadEntry {
    const now = new Date().toISOString();
    return TopicThreadEntrySchema.parse({
      ...input,
      entryId: randomUUID(),
      status,
      seq: (entries.at(-1)?.seq ?? 0) + 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  begin(
    followup: Followup,
    wasAccepted?: (entry: TopicThreadEntry) => Promise<boolean>,
    assertCurrent?: () => void,
  ): Promise<{ entry: TopicThreadEntry; changed: boolean; release?: () => void }> {
    return this.run(followup.workspaceId, async (data, file) => {
      const { entries } = data;
      requireDecisionClaim(data, followup);
      const index = entries.findIndex(
        (entry) =>
          entry.role !== "agent_reply" &&
          sameThreadScope(entry, followup) &&
          entry.sourceMessageId === followup.sourceMessageId,
      );
      const previous = entries[index];
      const now = new Date().toISOString();
      if (previous) {
        requireMatchingFollowup(previous, followup);
        const key = `${file}:${previous.entryId}`;
        if (
          previous.status === "completed" ||
          previous.status === "error" ||
          activeEntries.has(key)
        )
          return { entry: publicEntry(previous), changed: false };

        // A restarted router has no live claim. Recover when the client resends the request
        // so attachments are available. A past provider handoff may already have executed.
        // Before the handoff marker existed, running was only written after the turn started.
        const handedOff =
          previous.handoffPending === true ||
          (previous.handoffPending === undefined && previous.status === "running") ||
          (await wasAccepted?.(publicEntry(previous))) === true;
        const entry = publicEntry({
          ...previous,
          ...(handedOff
            ? { status: "error" }
            : { status: "queued", routedAgentId: followup.routedAgentId }),
          updatedAt: now,
        });
        entries[index] = { ...entry, handoffPending: handedOff ? undefined : false };
        assertCurrent?.();
        await writeJsonFileAtomic(file, data);
        return { entry, changed: true, release: handedOff ? undefined : this.claim(file, entry) };
      }
      const entry = this.newEntry(data, { ...followup, role: "user_followup" }, "queued");
      entries.push({ ...entry, handoffPending: false });
      assertCurrent?.();
      await writeJsonFileAtomic(file, data);
      return { entry, changed: true, release: this.claim(file, entry) };
    });
  }

  private claim(file: string, entry: TopicThreadEntry): () => void {
    const key = `${file}:${entry.entryId}`;
    activeEntries.add(key);
    return () => void activeEntries.delete(key);
  }

  reroute(workspaceId: string, entryId: string, routedAgentId: string): Promise<TopicThreadEntry> {
    return this.changeQueued(workspaceId, entryId, (entry) => {
      if (entry.handoffPending) throw new Error("Cannot reroute a submitted topic follow-up.");
      return { ...entry, routedAgentId, updatedAt: new Date().toISOString() };
    });
  }

  async setHandoffPending(workspaceId: string, entryId: string, pending: boolean): Promise<void> {
    await this.changeQueued(workspaceId, entryId, (entry) => ({
      ...entry,
      handoffPending: pending,
    }));
  }

  private changeQueued(
    workspaceId: string,
    entryId: string,
    change: (entry: StoredEntry) => StoredEntry,
  ): Promise<TopicThreadEntry> {
    return this.run(workspaceId, async (data, file) => {
      const { entries } = data;
      const index = entries.findIndex(
        (entry) => entry.entryId === entryId && entry.role === "user_followup",
      );
      const entry = entries[index];
      if (entry?.status !== "queued") throw new Error("The topic follow-up is no longer queued.");
      const updated = change(entry);
      entries[index] = updated;
      await writeJsonFileAtomic(file, data);
      return publicEntry(updated);
    });
  }

  update(
    workspaceId: string,
    entryId: string,
    status: "running" | "completed" | "error",
    reply?: TopicAgentReply,
  ): Promise<TopicThreadEntry[]> {
    return this.run(workspaceId, async (data, file) => {
      const { entries } = data;
      const index = entries.findIndex(
        (entry) => entry.entryId === entryId && entry.role === "user_followup",
      );
      const user = entries[index];
      if (!user || user.status === status || user.status === "completed" || user.status === "error")
        return [];
      const now = new Date().toISOString();
      const updated = {
        ...user,
        status,
        updatedAt: now,
        handoffPending: status === "running" ? user.handoffPending : undefined,
      };
      entries[index] = updated;
      const changes: TopicThreadEntry[] = [publicEntry(updated)];
      if (reply) {
        const entry = TopicThreadEntrySchema.parse({
          workspaceId: user.workspaceId,
          mainAgentId: user.mainAgentId,
          topicKey: user.topicKey,
          taskId: user.taskId,
          rootMessageId: user.rootMessageId,
          routedAgentId: user.routedAgentId,
          origin: user.origin,
          ...reply,
          sourceMessageId: reply.sourceMessageId || `topic-reply:${user.entryId}`,
          entryId: randomUUID(),
          role: "agent_reply",
          authorAgentId: user.routedAgentId,
          status: "completed",
          seq: (entries.at(-1)?.seq ?? 0) + 1,
          createdAt: now,
          updatedAt: now,
        });
        entries.push(entry);
        changes.push(entry);
      }
      await writeJsonFileAtomic(file, data);
      return changes;
    });
  }
}
