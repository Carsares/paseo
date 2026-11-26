import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TopicAnchorSummary, TopicDelegationSummary } from "@getpaseo/protocol/messages";
import { z } from "zod";
import { writeJsonFileAtomic } from "../../atomic-file.js";

export const topicDelegationScopeSchema = z.object({
  workspaceId: z.string().min(1),
  mainAgentId: z.string().min(1),
  rootMessageId: z.string().min(1),
  rootPromptText: z.string(),
  taskId: z.string().min(1).optional(),
  explicitlyAssigned: z.literal(true).optional(),
});
export type TopicDelegationScope = z.infer<typeof topicDelegationScopeSchema>;

const recordSchema = topicDelegationScopeSchema.extend({
  messageId: z.string().min(1),
  agentId: z.string().min(1),
  serverId: z.string().min(1),
  title: z.string().optional(),
  turnId: z.string().optional(),
  runToken: z.string().optional(),
  recoverable: z.boolean().optional(),
  runOwner: z.string().optional(),
  reportIds: z.array(z.string()).optional(),
  status: z.enum(["queued", "starting", "running", "ended", "completed", "interrupted", "error"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
type Record = z.infer<typeof recordSchema>;
type Scope = Pick<Record, "workspaceId" | "mainAgentId">;
type Recipient = Pick<Record, "workspaceId" | "agentId" | "serverId">;
type Dispatch = Recipient & Pick<Record, "messageId">;
type Turn = Recipient & { turnId: string };
export const topicDelegationTurnSchema = recordSchema
  .pick({
    workspaceId: true,
    agentId: true,
    serverId: true,
    messageId: true,
    turnId: true,
  })
  .required();
export type TopicDelegationTurn = z.infer<typeof topicDelegationTurnSchema>;
type NewDispatch = TopicDelegationScope &
  Omit<Dispatch, "workspaceId"> &
  Pick<Record, "title" | "recoverable">;
type TerminalStatus = "ended" | "interrupted" | "error";

function sameRecipient(entry: Record, recipient: Recipient) {
  return (
    entry.workspaceId === recipient.workspaceId &&
    entry.agentId === recipient.agentId &&
    entry.serverId === recipient.serverId
  );
}

function sameDispatch(entry: Record, dispatch: Dispatch) {
  return sameRecipient(entry, dispatch) && entry.messageId === dispatch.messageId;
}

function topicKey(entry: TopicDelegationScope) {
  return entry.taskId ? `task:${entry.taskId}` : `msg:${entry.rootMessageId}`;
}

/** Records admitted delegations independently of conversation loading and provider transcripts. */
export class TopicDelegationStore {
  private readonly runOwner = randomUUID();
  private readonly directory: string;
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<(scope: Scope) => void>();

  constructor(paseoHome: string) {
    this.directory = join(paseoHome, "topic-delegations");
  }

  subscribe(listener: (scope: Scope) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async read(file: string): Promise<Record[]> {
    try {
      return z.array(recordSchema).parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private run<T>(
    workspaceId: string,
    operation: (records: Record[], file: string) => Promise<T> | T,
  ): Promise<T> {
    const file = join(
      this.directory,
      `${createHash("sha256").update(workspaceId).digest("hex")}.json`,
    );
    const previous = this.pending.get(file) ?? Promise.resolve();
    const next = previous.then(async () => operation(await this.read(file), file));
    const settled = next.catch(() => undefined);
    this.pending.set(file, settled);
    void settled.then(() => {
      if (this.pending.get(file) === settled) this.pending.delete(file);
      return undefined;
    });
    return next;
  }

  private async write(records: Record[], file: string, changed: Record) {
    await mkdir(this.directory, { recursive: true });
    await writeJsonFileAtomic(file, records);
    for (const listener of this.listeners) {
      listener({ workspaceId: changed.workspaceId, mainAgentId: changed.mainAgentId });
    }
  }

  admit(dispatch: NewDispatch, restoring = false): Promise<void> {
    return this.run(dispatch.workspaceId, (records, file) => {
      const existing = records.find((entry) => sameDispatch(entry, dispatch));
      if (existing) {
        if (
          existing.mainAgentId !== dispatch.mainAgentId ||
          existing.rootMessageId !== dispatch.rootMessageId
        )
          throw new Error("A delegation message cannot be reused for another topic.");
        if (restoring && existing.status === "starting") {
          existing.status = "queued";
          existing.updatedAt = new Date().toISOString();
          return this.write(records, file, existing);
        }
        return;
      }
      const now = new Date().toISOString();
      const entry: Record = {
        ...dispatch,
        runOwner: this.runOwner,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      };
      records.push(entry);
      return this.write(records, file, entry);
    });
  }

  private update(
    workspaceId: string,
    select: (entry: Record) => boolean,
    change: (entry: Record) => void,
  ): Promise<void> {
    return this.run(workspaceId, (records, file) => {
      const matching = records.filter(select);
      if (matching.length !== 1) return;
      const entry = matching[0]!;
      change(entry);
      entry.updatedAt = new Date(
        Math.max(Date.now(), Date.parse(entry.updatedAt) + 1),
      ).toISOString();
      return this.write(records, file, entry);
    });
  }

  submitting(dispatch: Dispatch) {
    return this.update(
      dispatch.workspaceId,
      (entry) => sameDispatch(entry, dispatch) && entry.status === "queued",
      (entry) => {
        entry.status = "starting";
        entry.runOwner = this.runOwner;
      },
    );
  }

  returnToQueue(dispatch: Dispatch) {
    return this.update(
      dispatch.workspaceId,
      (entry) => sameDispatch(entry, dispatch) && entry.status === "starting",
      (entry) => {
        entry.status = "queued";
        entry.runToken = undefined;
      },
    );
  }

  associateRun(dispatch: Dispatch, runToken: string) {
    let associated = false;
    return this.update(
      dispatch.workspaceId,
      (entry) =>
        sameDispatch(entry, dispatch) && (entry.status === "starting" || entry.status === "queued"),
      (entry) => {
        entry.runToken = runToken;
        associated = true;
      },
    ).then(() => associated);
  }

  readDispatch(dispatch: Dispatch): Promise<TopicDelegationScope | undefined> {
    return this.run(dispatch.workspaceId, (records) => {
      const found = records.find((entry) => sameDispatch(entry, dispatch));
      if (!found) return undefined;
      return {
        workspaceId: found.workspaceId,
        mainAgentId: found.mainAgentId,
        rootMessageId: found.rootMessageId,
        rootPromptText: found.rootPromptText,
        ...(found.taskId ? { taskId: found.taskId } : {}),
      };
    });
  }

  private matchesRecovery(entry: Record, original: TopicDelegationTurn) {
    return (
      sameDispatch(entry, original) &&
      entry.turnId === original.turnId &&
      entry.runOwner !== this.runOwner &&
      (entry.status === "running" || entry.status === "interrupted" || entry.status === "completed")
    );
  }

  associateRecoveryRun(original: TopicDelegationTurn, runToken: string) {
    let associated = false;
    return this.update(
      original.workspaceId,
      (entry) => this.matchesRecovery(entry, original),
      (entry) => {
        // A provider may report before acknowledging the continuation. Keep the
        // old accepted turn until the replacement actually starts.
        entry.runToken = runToken;
        associated = true;
      },
    ).then(() => associated);
  }

  confirmRecoveryRun(original: TopicDelegationTurn, runToken: string, turnId: string) {
    return this.update(
      original.workspaceId,
      (entry) => this.matchesRecovery(entry, original) && entry.runToken === runToken,
      (entry) => {
        entry.turnId = turnId;
        entry.runOwner = this.runOwner;
        if (entry.status !== "completed") entry.status = "running";
      },
    );
  }

  start(dispatch: TopicDelegationTurn): Promise<void> {
    return this.update(
      dispatch.workspaceId,
      (entry) =>
        sameDispatch(entry, dispatch) &&
        !entry.turnId &&
        (entry.status === "queued" || entry.status === "starting" || entry.status === "completed"),
      (entry) => {
        entry.turnId = dispatch.turnId;
        entry.runOwner = this.runOwner;
        if (entry.status !== "completed") entry.status = "running";
      },
    );
  }

  reject(dispatch: Dispatch): Promise<void> {
    return this.update(
      dispatch.workspaceId,
      (entry) =>
        sameDispatch(entry, dispatch) && (entry.status === "queued" || entry.status === "starting"),
      (entry) => {
        entry.status = "error";
      },
    );
  }

  finish(turn: TopicDelegationTurn, status: TerminalStatus): Promise<void> {
    return this.update(
      turn.workspaceId,
      (entry) =>
        sameDispatch(entry, turn) &&
        entry.turnId === turn.turnId &&
        entry.runOwner === this.runOwner &&
        entry.status === "running",
      (entry) => {
        entry.status = status;
      },
    );
  }

  async forReport(
    turn: Turn & Pick<Scope, "mainAgentId"> & { messageId?: string },
  ): Promise<Record | undefined> {
    return this.run(turn.workspaceId, (records) => {
      const matches = records.filter(
        (entry) =>
          sameRecipient(entry, turn) &&
          (entry.turnId === turn.turnId || entry.runToken === turn.turnId) &&
          (!turn.messageId || entry.messageId === turn.messageId) &&
          entry.mainAgentId === turn.mainAgentId,
      );
      return matches.length === 1 ? matches[0] : undefined;
    });
  }

  bindTask(dispatch: Dispatch, taskId: string) {
    return this.update(
      dispatch.workspaceId,
      (entry) => sameDispatch(entry, dispatch) && !entry.taskId,
      (entry) => {
        entry.taskId = taskId;
      },
    );
  }

  recordReport(
    dispatch: Dispatch & Pick<Scope, "mainAgentId"> & Pick<Turn, "turnId">,
    reportId: string,
    status: "completed" | "blocked",
  ) {
    return this.update(
      dispatch.workspaceId,
      (entry) =>
        sameDispatch(entry, dispatch) &&
        entry.mainAgentId === dispatch.mainAgentId &&
        (entry.turnId === dispatch.turnId || entry.runToken === dispatch.turnId) &&
        !entry.reportIds?.includes(reportId),
      (entry) => {
        (entry.reportIds ??= []).push(reportId);
        if (status === "completed") entry.status = "completed";
      },
    );
  }

  private projectStatus(entry: Record): TopicDelegationSummary["status"] {
    if (
      (entry.status === "running" ||
        entry.status === "starting" ||
        (entry.status === "queued" && entry.recoverable === false)) &&
      entry.runOwner !== this.runOwner
    )
      return "interrupted";
    return entry.status === "starting" ? "queued" : entry.status;
  }

  hasOtherTopicParticipant(reporting: Scope & Recipient & Pick<Record, "rootMessageId">) {
    return this.run(reporting.workspaceId, (records) =>
      records.some(
        (entry) =>
          entry.mainAgentId === reporting.mainAgentId &&
          entry.rootMessageId === reporting.rootMessageId &&
          !sameRecipient(entry, reporting),
      ),
    );
  }

  anchors(scope: Scope): Promise<TopicAnchorSummary[]> {
    return this.run(scope.workspaceId, (records) => {
      const anchors = new Map<string, TopicAnchorSummary>();
      for (const entry of records) {
        if (entry.mainAgentId !== scope.mainAgentId) continue;
        const key = topicKey(entry);
        const record: TopicDelegationSummary = {
          messageId: entry.messageId,
          agentId: entry.agentId,
          serverId: entry.serverId,
          title: entry.title,
          turnId: entry.turnId,
          reportIds: entry.reportIds,
          taskId: entry.taskId,
          updatedAt: entry.updatedAt,
          status: this.projectStatus(entry),
        };
        const anchor = anchors.get(key);
        if (anchor) {
          anchor.delegations!.push(record);
          if (entry.updatedAt > anchor.updatedAt) anchor.updatedAt = entry.updatedAt;
        } else {
          anchors.set(key, {
            ...scope,
            topicKey: key,
            taskId: entry.taskId,
            rootMessageId: entry.rootMessageId,
            rootPromptText: entry.rootPromptText,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            delegations: [record],
          });
        }
      }
      return [...anchors.values()];
    });
  }
}

/** Apply the same message-anchor promotion used by the topic thread store. */
export function mergeTopicDelegationAnchors(
  anchors: readonly TopicAnchorSummary[],
  delegations: readonly TopicAnchorSummary[],
) {
  const result = new Map(anchors.map((anchor) => [anchor.topicKey, anchor]));
  for (const incoming of delegations) {
    const promoted = incoming.taskId
      ? undefined
      : anchors.find((anchor) => anchor.taskId && anchor.rootMessageId === incoming.rootMessageId);
    const key = promoted?.topicKey ?? incoming.topicKey;
    const existing = result.get(key);
    if (!existing) {
      result.set(key, incoming);
      continue;
    }
    result.set(key, {
      ...existing,
      rootMessageId: existing.rootMessageId ?? incoming.rootMessageId,
      rootPromptText: existing.rootPromptText.trim()
        ? existing.rootPromptText
        : incoming.rootPromptText,
      delegations: [...(existing.delegations ?? []), ...(incoming.delegations ?? [])],
      createdAt: existing.createdAt < incoming.createdAt ? existing.createdAt : incoming.createdAt,
      updatedAt: existing.updatedAt > incoming.updatedAt ? existing.updatedAt : incoming.updatedAt,
    });
  }
  return [...result.values()];
}
