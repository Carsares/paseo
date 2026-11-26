import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  WorkspaceDurableItemDecideRequestSchema,
  WorkspaceDurableItemListRequestSchema,
  WorkspaceDurableItemSchema,
  type WorkspaceDurableItem,
} from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import {
  captureDurableItemEvidence,
  DurableItemEvidenceError,
  type DurableEvidenceTarget,
} from "./evidence.js";

const ItemKeySchema = z.object({ workspaceId: z.string().min(1), requestId: z.string().min(1) });
const CreateInputSchema = ItemKeySchema.extend({
  sourceAgentId: z.string().min(1),
  sourceTurnId: z.string().min(1),
  kind: z.enum(["authorization", "decision", "acceptance"]),
  title: z.string().trim().min(1),
  summary: z.string().optional(),
  taskId: z.string().min(1).optional(),
  topicKey: z.string().min(1).optional(),
  rootMessageId: z.string().min(1).optional(),
});
const ListInputSchema = WorkspaceDurableItemListRequestSchema.omit({ type: true, requestId: true });
const DecideInputSchema = WorkspaceDurableItemDecideRequestSchema.omit({
  type: true,
  requestId: true,
}).extend({
  principalId: z.string().min(1),
  topicDecisionOperationId: z.string().min(1).optional(),
});
const StoreFileSchema = z.object({
  version: z.literal(1),
  serverId: z.string().min(1),
  items: z.array(
    z.object({
      item: WorkspaceDurableItemSchema,
      decidedByPrincipalId: z.string().min(1).optional(),
      topicDecisionOperationId: z.string().min(1).optional(),
    }),
  ),
});

type StoreFile = z.infer<typeof StoreFileSchema>;
type StoredItem = StoreFile["items"][number];
type ItemKey = z.infer<typeof ItemKeySchema>;

interface StoreOptions {
  filePath: string;
  serverId: string;
  getWorkspace(id: string): Promise<PersistedWorkspaceRecord | null>;
  getSourceAgent(id: string): Promise<StoredAgentRecord | null>;
  now?: () => number;
}

type CreateInput = z.input<typeof CreateInputSchema> & {
  serverId: string;
  evidence: readonly DurableEvidenceTarget[];
};
type ListInput = z.input<typeof ListInputSchema> & { serverId: string };
type DecideInput = z.input<typeof DecideInputSchema> & { serverId: string };
type DurableItemChangeListener = (item: WorkspaceDurableItem) => void;

export class DurableItemConflictError extends Error {
  constructor(readonly item: WorkspaceDurableItem) {
    super("This item has changed. Refresh it before deciding.");
    this.name = "DurableItemConflictError";
  }
}

// Store instances in the daemon share the same serial write lane for this file.
const writeTails = new Map<string, Promise<unknown>>();
const listenersByFile = new Map<string, Set<DurableItemChangeListener>>();

function publishChange(filePath: string, item: WorkspaceDurableItem): void {
  const listeners = Array.from(listenersByFile.get(filePath) ?? []);
  for (const listener of listeners) {
    try {
      listener(structuredClone(item));
    } catch {
      // An observer failure must not turn a committed change into a failed mutation.
      process.emitWarning("Durable item change listener failed");
    }
  }
}

function findItem(data: StoreFile, key: ItemKey) {
  return data.items.find(
    ({ item }) => item.workspaceId === key.workspaceId && item.requestId === key.requestId,
  );
}

function normalizeDecisionNote(note: string | undefined): string | undefined {
  return note?.trim() || undefined;
}

function isTopicDecisionReplay(
  entry: StoredItem,
  decision: z.output<typeof DecideInputSchema>,
): boolean {
  const { item } = entry;
  return (
    decision.topicDecisionOperationId !== undefined &&
    decision.topicDecisionOperationId === entry.topicDecisionOperationId &&
    decision.principalId === entry.decidedByPrincipalId &&
    item.status === "decided" &&
    item.revision === decision.expectedRevision + 1 &&
    item.decision === decision.decision &&
    normalizeDecisionNote(item.note) === normalizeDecisionNote(decision.note)
  );
}

function isAvailable(
  workspace: PersistedWorkspaceRecord | null,
): workspace is PersistedWorkspaceRecord {
  return workspace !== null && !workspace.archivedAt && !workspace.background;
}

/** Local per-daemon storage. Callers authorize routed requests before entering this store. */
export class DurableItemStore {
  private readonly filePath: string;

  constructor(private readonly options: StoreOptions) {
    this.filePath = resolve(options.filePath);
  }

  subscribe(listener: DurableItemChangeListener): () => void {
    const filePath = this.filePath;
    const listeners = listenersByFile.get(filePath) ?? new Set<DurableItemChangeListener>();
    const registration: DurableItemChangeListener = (item) => listener(item);
    listeners.add(registration);
    listenersByFile.set(filePath, listeners);
    return () => {
      if (listeners.delete(registration) && !listeners.size) listenersByFile.delete(filePath);
    };
  }

  async create(input: CreateInput, validateSource?: () => void): Promise<WorkspaceDurableItem> {
    this.assertLocalHost(input.serverId);
    const itemInput = CreateInputSchema.parse(input);
    const targets = structuredClone(input.evidence);
    return this.write(async (data) => {
      const workspace = await this.requireWorkspace(itemInput.workspaceId);
      const source = await this.options.getSourceAgent(itemInput.sourceAgentId);
      if (
        !source ||
        source.workspaceId !== workspace.workspaceId ||
        source.archivedAt ||
        source.internal
      ) {
        throw new Error("Durable item source is unavailable in this workspace.");
      }
      const existing = findItem(data, itemInput);
      if (existing) throw new DurableItemConflictError(existing.item);
      const evidence: WorkspaceDurableItem["evidence"] = [];
      for (const target of targets) {
        evidence.push(await captureDurableItemEvidence(workspace.cwd, target));
      }
      validateSource?.();
      const item = WorkspaceDurableItemSchema.parse({
        ...itemInput,
        evidence,
        revision: 0,
        status: "pending",
        createdAt: this.timestamp(),
      });
      data.items.push({ item });
      return item;
    });
  }

  async list(
    input: ListInput,
  ): Promise<{ items: WorkspaceDurableItem[]; nextCursor: string | null }> {
    this.assertLocalHost(input.serverId);
    const { workspaceId, statusFilter, cursor, limit = 50 } = ListInputSchema.parse(input);
    const data = await this.read();
    let start = 0;
    if (cursor !== undefined) {
      const key = ItemKeySchema.parse(
        JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
      );
      if (workspaceId && key.workspaceId !== workspaceId)
        throw new Error("Invalid durable item cursor.");
      const previous = findItem(data, key);
      if (!previous) throw new Error("Invalid durable item cursor.");
      start = data.items.indexOf(previous) + 1;
    }

    const pageSize = Math.min(limit, 100);
    const items: WorkspaceDurableItem[] = [];
    const visibility = new Map<string, boolean>();
    for (const { item } of data.items.slice(start)) {
      if (
        (workspaceId && item.workspaceId !== workspaceId) ||
        (statusFilter && item.status !== statusFilter)
      ) {
        continue;
      }
      let visible = visibility.get(item.workspaceId);
      if (visible === undefined) {
        visible = isAvailable(await this.options.getWorkspace(item.workspaceId));
        visibility.set(item.workspaceId, visible);
      }
      if (!visible) continue;
      if (items.length === pageSize) {
        const key = ItemKeySchema.parse(items[items.length - 1]);
        return { items, nextCursor: Buffer.from(JSON.stringify(key)).toString("base64url") };
      }
      items.push(item);
    }
    return { items, nextCursor: null };
  }

  async listPendingWorkspaceItems(input: {
    serverId: string;
    workspaceId: string;
  }): Promise<WorkspaceDurableItem[]> {
    this.assertLocalHost(input.serverId);
    const [workspace, data] = await Promise.all([
      this.options.getWorkspace(input.workspaceId),
      this.read(),
    ]);
    if (!isAvailable(workspace)) return [];
    return data.items
      .map(({ item }) => item)
      .filter((item) => item.workspaceId === input.workspaceId && item.status === "pending");
  }

  // The caller holds the task ledger lane first. The reader must not re-enter either lane.
  withPendingWorkspaceItems<T>(
    input: { serverId: string; workspaceId: string },
    use: (items: readonly WorkspaceDurableItem[]) => Promise<T>,
  ): Promise<T> {
    return this.withWriteLane(async () => use(await this.listPendingWorkspaceItems(input)));
  }

  async get(input: ItemKey & { serverId: string }): Promise<WorkspaceDurableItem | null> {
    this.assertLocalHost(input.serverId);
    const workspace = await this.options.getWorkspace(input.workspaceId);
    if (!isAvailable(workspace)) return null;
    return findItem(await this.read(), input)?.item ?? null;
  }

  async getCommittedTopicDecision(input: DecideInput): Promise<WorkspaceDurableItem | undefined> {
    this.assertLocalHost(input.serverId);
    const decision = DecideInputSchema.parse(input);
    await this.requireWorkspace(decision.workspaceId);
    const entry = findItem(await this.read(), {
      workspaceId: decision.workspaceId,
      requestId: decision.durableItemRequestId,
    });
    // The item and its operation ID are committed in the same atomic file write.
    if (entry && entry.item.kind !== "authorization" && isTopicDecisionReplay(entry, decision))
      return entry.item;
  }

  async decide(
    input: DecideInput,
    assertCurrent?: () => void,
    options?: { deferNotification?: boolean },
  ): Promise<WorkspaceDurableItem> {
    this.assertLocalHost(input.serverId);
    const decision = DecideInputSchema.parse(input);
    return this.write(async (data, skipPersist) => {
      const workspace = await this.requireWorkspace(decision.workspaceId);
      const entry = findItem(data, {
        workspaceId: decision.workspaceId,
        requestId: decision.durableItemRequestId,
      });
      if (!entry) throw new Error("Durable item does not exist in this workspace.");
      const { item } = entry;
      if (decision.topicDecisionOperationId && item.kind === "authorization")
        throw new Error("System authorizations cannot be decided through a topic.");
      assertCurrent?.();
      if (isTopicDecisionReplay(entry, decision)) {
        skipPersist();
        return item;
      }
      if (item.status !== "pending" || item.revision !== decision.expectedRevision) {
        throw new DurableItemConflictError(item);
      }
      if (decision.decision === "approve") {
        if (item.kind === "acceptance" && item.evidence.length === 0)
          throw new DurableItemEvidenceError();
        for (const expected of item.evidence) {
          const current = await captureDurableItemEvidence(workspace.cwd, expected);
          if (!isDeepStrictEqual(expected, current)) throw new DurableItemEvidenceError();
        }
        const latest = await this.requireWorkspace(item.workspaceId);
        if (latest.cwd !== workspace.cwd) throw new DurableItemEvidenceError();
      }
      assertCurrent?.();
      entry.item = {
        ...item,
        status: "decided",
        decision: decision.decision,
        note: decision.note,
        decidedAt: this.timestamp(),
        revision: item.revision + 1,
      };
      entry.decidedByPrincipalId = decision.principalId;
      entry.topicDecisionOperationId = decision.topicDecisionOperationId;
      return entry.item;
    }, !options?.deferNotification);
  }

  /** A daemon producer can invalidate a pending item when its originating action expires. */
  async expire(
    input: ItemKey & { serverId: string; expectedRevision: number },
  ): Promise<WorkspaceDurableItem> {
    this.assertLocalHost(input.serverId);
    const key = ItemKeySchema.parse(input);
    const expectedRevision = input.expectedRevision;
    return this.write(async (data) => {
      const entry = findItem(data, key);
      if (!entry) throw new Error("Durable item does not exist in this workspace.");
      const { item } = entry;
      if (item.status !== "pending" || item.revision !== expectedRevision)
        throw new DurableItemConflictError(item);
      entry.item = {
        ...item,
        status: "expired",
        expiredAt: this.timestamp(),
        revision: item.revision + 1,
      };
      return entry.item;
    });
  }

  private assertLocalHost(serverId: string): void {
    if (!serverId || serverId !== this.options.serverId) throw new DurableItemEvidenceError();
  }

  private timestamp(): string {
    return new Date((this.options.now ?? Date.now)()).toISOString();
  }

  private async requireWorkspace(id: string): Promise<PersistedWorkspaceRecord> {
    const workspace = await this.options.getWorkspace(id);
    if (!isAvailable(workspace) || workspace.workspaceId !== id) {
      throw new Error("Workspace is unavailable.");
    }
    return workspace;
  }

  private async read(): Promise<StoreFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      return { version: 1, serverId: this.options.serverId, items: [] };
    }
    const data = StoreFileSchema.parse(JSON.parse(raw));
    this.assertLocalHost(data.serverId);
    return data;
  }

  private write(
    update: (data: StoreFile, skipPersist: () => void) => Promise<WorkspaceDurableItem>,
    notify = true,
  ): Promise<WorkspaceDurableItem> {
    return this.withWriteLane(async () => {
      const data = await this.read();
      let changed = true;
      const value = await update(data, () => {
        changed = false;
      });
      if (changed) {
        await writeJsonFileAtomic(this.filePath, data);
        if (notify) publishChange(this.filePath, value);
      }
      return value;
    });
  }

  private withWriteLane<T>(operation: () => Promise<T>): Promise<T> {
    const prior = writeTails.get(this.filePath) ?? Promise.resolve();
    const result = prior.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    writeTails.set(this.filePath, tail);
    void tail.then(() => {
      if (writeTails.get(this.filePath) === tail) writeTails.delete(this.filePath);
      return undefined;
    });
    return result;
  }
}
