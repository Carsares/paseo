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
});
const ListInputSchema = WorkspaceDurableItemListRequestSchema.omit({ type: true, requestId: true });
const DecideInputSchema = WorkspaceDurableItemDecideRequestSchema.omit({
  type: true,
  requestId: true,
}).extend({
  principalId: z.string().min(1),
});
const StoreFileSchema = z.object({
  version: z.literal(1),
  serverId: z.string().min(1),
  items: z.array(
    z.object({
      item: WorkspaceDurableItemSchema,
      decidedByPrincipalId: z.string().min(1).optional(),
    }),
  ),
});

type StoreFile = z.infer<typeof StoreFileSchema>;
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

export class DurableItemConflictError extends Error {
  constructor(readonly item: WorkspaceDurableItem) {
    super("This item has changed. Refresh it before deciding.");
    this.name = "DurableItemConflictError";
  }
}

// Store instances in the daemon share the same serial write lane for this file.
const writeTails = new Map<string, Promise<unknown>>();

function findItem(data: StoreFile, key: ItemKey) {
  return data.items.find(
    ({ item }) => item.workspaceId === key.workspaceId && item.requestId === key.requestId,
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

  async create(input: CreateInput): Promise<WorkspaceDurableItem> {
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

  async decide(input: DecideInput): Promise<WorkspaceDurableItem> {
    this.assertLocalHost(input.serverId);
    const decision = DecideInputSchema.parse(input);
    return this.write(async (data) => {
      const workspace = await this.requireWorkspace(decision.workspaceId);
      const entry = findItem(data, {
        workspaceId: decision.workspaceId,
        requestId: decision.durableItemRequestId,
      });
      if (!entry) throw new Error("Durable item does not exist in this workspace.");
      const { item } = entry;
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
      entry.item = {
        ...item,
        status: "decided",
        decision: decision.decision,
        note: decision.note,
        decidedAt: this.timestamp(),
        revision: item.revision + 1,
      };
      entry.decidedByPrincipalId = decision.principalId;
      return entry.item;
    });
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

  private write<T>(update: (data: StoreFile) => Promise<T>): Promise<T> {
    const prior = writeTails.get(this.filePath) ?? Promise.resolve();
    const result = prior.then(async () => {
      const data = await this.read();
      const value = await update(data);
      await writeJsonFileAtomic(this.filePath, data);
      return value;
    });
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
