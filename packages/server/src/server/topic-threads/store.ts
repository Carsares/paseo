import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TopicThreadEntrySchema, type TopicThreadEntry } from "@getpaseo/protocol/messages";
import { z } from "zod";
import { normalizePathForIdentity } from "../../utils/path.js";
import { writeJsonFileAtomic } from "../atomic-file.js";

type ThreadScope = Pick<TopicThreadEntry, "workspaceId" | "mainAgentId">;
type Followup = Pick<
  TopicThreadEntry,
  "workspaceId" | "mainAgentId" | "topicKey" | "taskId" | "rootMessageId" | "routedAgentId" | "text"
> & { sourceMessageId: string };
export type TopicAgentReply = Pick<TopicThreadEntry, "text" | "sourceMessageId" | "authorTitle">;

const storedEntrySchema = TopicThreadEntrySchema.extend({ handoffPending: z.boolean().optional() });
type StoredEntry = z.infer<typeof storedEntrySchema>;
const entriesSchema = z.array(storedEntrySchema);
const pendingByFile = new Map<string, Promise<void>>();
const activeEntries = new Set<string>();

function publicEntry({ handoffPending: _, ...entry }: StoredEntry): TopicThreadEntry {
  return entry;
}

async function readEntries(file: string): Promise<StoredEntry[]> {
  try {
    return entriesSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
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
    operation: (entries: StoredEntry[], file: string) => Promise<T> | T,
  ): Promise<T> {
    if (
      !/^[a-z\d_-]{1,128}$/i.test(workspaceId) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(workspaceId)
    )
      throw new Error("Invalid workspace ID for a topic thread file");
    const file = resolve(this.directory, `${workspaceId}.json`);
    const result = (pendingByFile.get(file) ?? Promise.resolve()).then(async () => {
      const entries = await readEntries(file);
      return operation(entries, file);
    });
    const cleanup = () => {
      if (pendingByFile.get(file) === pending) pendingByFile.delete(file);
    };
    const pending = result.then(cleanup, cleanup);
    pendingByFile.set(file, pending);
    return result;
  }

  list({ workspaceId, mainAgentId }: ThreadScope, topicKey?: string): Promise<TopicThreadEntry[]> {
    return this.run(workspaceId, (entries) =>
      entries
        .filter(
          (entry) =>
            entry.workspaceId === workspaceId &&
            entry.mainAgentId === mainAgentId &&
            (topicKey === undefined || entry.topicKey === topicKey),
        )
        .map(publicEntry),
    );
  }

  begin(
    followup: Followup,
    wasAccepted?: (entry: TopicThreadEntry) => Promise<boolean>,
  ): Promise<{ entry: TopicThreadEntry; changed: boolean; release?: () => void }> {
    return this.run(followup.workspaceId, async (entries, file) => {
      const index = entries.findIndex(
        (entry) =>
          entry.role === "user_followup" &&
          entry.mainAgentId === followup.mainAgentId &&
          entry.sourceMessageId === followup.sourceMessageId,
      );
      const previous = entries[index];
      const now = new Date().toISOString();
      if (previous) {
        if (previous.topicKey !== followup.topicKey || previous.text !== followup.text)
          throw new Error("This message ID is already used by another topic follow-up.");
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
        await writeJsonFileAtomic(file, entries);
        return { entry, changed: true, release: handedOff ? undefined : this.claim(file, entry) };
      }
      const entry = TopicThreadEntrySchema.parse({
        ...followup,
        entryId: randomUUID(),
        role: "user_followup",
        status: "queued",
        seq: (entries.at(-1)?.seq ?? 0) + 1,
        createdAt: now,
        updatedAt: now,
      });
      await writeJsonFileAtomic(file, [...entries, { ...entry, handoffPending: false }]);
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
    return this.run(workspaceId, async (entries, file) => {
      const index = entries.findIndex(
        (entry) => entry.entryId === entryId && entry.role === "user_followup",
      );
      const entry = entries[index];
      if (entry?.status !== "queued") throw new Error("The topic follow-up is no longer queued.");
      const updated = change(entry);
      entries[index] = updated;
      await writeJsonFileAtomic(file, entries);
      return publicEntry(updated);
    });
  }

  update(
    workspaceId: string,
    entryId: string,
    status: "running" | "completed" | "error",
    reply?: TopicAgentReply,
  ): Promise<TopicThreadEntry[]> {
    return this.run(workspaceId, async (entries, file) => {
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
      await writeJsonFileAtomic(file, entries);
      return changes;
    });
  }
}
