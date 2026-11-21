import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AgentAttachmentSchema } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";

const AddressSchema = z.object({ agentId: z.string().min(1), serverId: z.string().min(1) });
const QueuedMessageSchema = z.object({
  messageId: z.string().min(1),
  prompt: z.union([
    z.string(),
    z.array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
        AgentAttachmentSchema,
      ]),
    ),
  ]),
  source: z.object({
    agentId: z.string().min(1),
    serverId: z.string().min(1).optional(),
    title: z.string().optional(),
  }),
  directParent: AddressSchema.optional(),
  notifyOnFinish: z.boolean().optional(),
  notifyLocalCaller: z.boolean().optional(),
  sessionMode: z.string().optional(),
  activeTurnBehavior: z.enum(["steer", "interrupt"]),
  unarchive: z.boolean(),
});
export type RecoverableAgentMessage = z.infer<typeof QueuedMessageSchema>;

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed"]),
  agentId: z.string(),
  queued: z.object({ sequence: z.number().int(), message: QueuedMessageSchema }).optional(),
});
type Receipt = z.infer<typeof ReceiptSchema>;
export type QueuedMessageReceipt = Receipt & { queued: NonNullable<Receipt["queued"]> };
export interface QueueHandoff {
  begin(): Promise<void>;
  declined(): Promise<void>;
}
export class AgentRequestOutcomeUnknownError extends Error {
  constructor() {
    super("agent_request_outcome_unknown");
  }
}
interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  /**
   * Delivers the message. It awaits `beforeDispatch` immediately before the provider can receive
   * the message; a failure before that call proves nothing was submitted and leaves no receipt.
   */
  send: (beforeDispatch: () => Promise<void>) => Promise<void>;
  /** Admission was refused before the message could enter the delivery queue. */
  retryIfNotAdmitted?: (error: unknown) => boolean;
  /** Only errors that prove the provider never received the message may clear a pending receipt. */
  retryIfUnsent?: (error: unknown) => boolean;
  queue?: Omit<QueueMessageInput, "agentId" | "request">;
}

interface QueueMessageInput {
  agentId: string;
  request: unknown;
  message: RecoverableAgentMessage;
  enqueue: (handoff: QueueHandoff) => Promise<{ dispatched: Promise<unknown> }>;
  onQueued?: () => void;
  retainOnError?: (error: unknown) => boolean;
}

/** Owns message delivery receipts; creation is owned by CreationService. */
export class MessageReceipts {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly awaitingCommit = new Map<string, { fingerprint: string; agentId: string }>();
  private admissionTail = Promise.resolve();
  private sequence = 0;
  constructor(private readonly directory: string) {}

  send(input: SendMessageInput): Promise<void> {
    if (input.queue) {
      return this.sendQueued({ ...input.queue, agentId: input.agentId, request: input.request });
    }
    // Preserve the existing on-disk identity and shape across daemon upgrades.
    const key = digest(["send", input.agentId, input.messageId]);
    return this.serialize(key, () => this.sendOnce(key, input));
  }

  sendQueued(input: QueueMessageInput): Promise<void> {
    const key = digest(["send", input.agentId, input.message.messageId]);
    return this.serialize(key, () => this.deliverQueued(key, digest(input.request), input));
  }

  resumeQueued(
    receipt: QueuedMessageReceipt,
    input: Pick<QueueMessageInput, "enqueue" | "onQueued" | "retainOnError">,
  ): Promise<void> {
    const key = digest(["send", receipt.agentId, receipt.queued.message.messageId]);
    return this.serialize(key, () =>
      this.deliverQueued(
        key,
        receipt.fingerprint,
        {
          ...input,
          agentId: receipt.agentId,
          message: receipt.queued.message,
        },
        true,
      ),
    );
  }

  async queuedMessages(onUnreadable?: () => void): Promise<QueuedMessageReceipt[]> {
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const records: QueuedMessageReceipt[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const receipt = await readReceipt(path.join(this.directory, entry.name)).catch(() => {
        onUnreadable?.();
        return null;
      });
      if (!receipt?.queued || receipt.state !== "pending") continue;
      const { queued, agentId } = receipt;
      if (entry.name !== `${digest(["send", agentId, queued.message.messageId])}.json`) continue;
      this.sequence = Math.max(this.sequence, queued.sequence);
      records.push({ ...receipt, queued });
    }
    return records.sort((a, b) => a.queued.sequence - b.queued.sequence);
  }

  private serialize(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.pending.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      operation(),
    );
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  private async deliverQueued(
    key: string,
    fingerprint: string,
    input: Omit<QueueMessageInput, "request">,
    resume = false,
  ): Promise<void> {
    const file = path.join(this.directory, `${key}.json`);
    const receipt = { fingerprint, agentId: input.agentId };
    const accepted = this.awaitingCommit.get(key);
    const existing = await readReceipt(file);
    const previous = accepted ?? existing;
    if (previous && previous.fingerprint !== fingerprint) {
      throw new Error("agent_request_key_conflict");
    }
    if (accepted) return this.commit(file, key, accepted);
    if (existing?.state === "completed" || (resume && !existing?.queued)) return;
    if (existing && !existing.queued) throw new AgentRequestOutcomeUnknownError();
    const admission = this.admissionTail.then(async () => {
      const queued = existing?.queued ?? { message: input.message, sequence: ++this.sequence };
      let handedOff = false;
      const saveQueued = () => this.writeQueued(file, { ...receipt, state: "pending", queued });
      if (!existing) await saveQueued();
      const handoff = {
        begin: async () => {
          if (handedOff) return;
          await writeJsonFileAtomic(file, { ...receipt, state: "pending" });
          handedOff = true;
        },
        declined: async () => {
          if (!handedOff) return;
          await saveQueued();
          handedOff = false;
        },
      };
      try {
        const queuedDelivery = await input.enqueue(handoff);
        input.onQueued?.();
        return {
          completed: queuedDelivery.dispatched.then(
            async () => {
              this.awaitingCommit.set(key, receipt);
              return this.commit(file, key, receipt);
            },
            async (error) => {
              if (!handedOff && !input.retainOnError?.(error)) {
                await writeJsonFileAtomic(file, { ...receipt, state: "pending" });
              }
              throw error;
            },
          ),
        };
      } catch (error) {
        await rm(file, { force: true });
        throw error;
      }
    });
    this.admissionTail = admission.then(
      () => undefined,
      () => undefined,
    );
    await (
      await admission
    ).completed;
  }

  private async writeQueued(file: string, receipt: QueuedMessageReceipt): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = await mkdtemp(path.join(this.directory, ".queued-"));
    try {
      const privateFile = path.join(temporary, "receipt.json");
      await writeFile(privateFile, JSON.stringify(receipt), { mode: 0o600 });
      await rename(privateFile, file);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async sendOnce(key: string, input: SendMessageInput): Promise<void> {
    const file = path.join(this.directory, `${key}.json`);
    const fingerprint = digest(input.request);
    const accepted = this.awaitingCommit.get(key);
    if (accepted) {
      if (accepted.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
      await this.commit(file, key, accepted);
      return;
    }
    const existing = await readReceipt(file);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
      if (existing.state === "completed") return;
      // A provider may have accepted the message before its receipt was committed.
      throw new AgentRequestOutcomeUnknownError();
    }
    const receipt = { fingerprint, agentId: input.agentId };
    let pending: Promise<void> | null = null;
    try {
      await input.send(() => {
        pending ??= writeJsonFileAtomic(file, { ...receipt, state: "pending" });
        return pending;
      });
    } catch (error) {
      if (pending && (input.retryIfNotAdmitted?.(error) || input.retryIfUnsent?.(error)))
        await rm(file, { force: true });
      throw error;
    }
    if (input.retryIfUnsent) this.awaitingCommit.set(key, receipt);
    await this.commit(file, key, receipt);
  }

  private async commit(
    file: string,
    key: string,
    receipt: { fingerprint: string; agentId: string },
  ): Promise<void> {
    await writeJsonFileAtomic(file, { ...receipt, state: "completed" });
    this.awaitingCommit.delete(key);
  }
}

async function readReceipt(file: string): Promise<z.infer<typeof ReceiptSchema> | null> {
  try {
    return ReceiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, candidate: unknown) => {
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
          return Object.fromEntries(
            Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)),
          );
        }
        return candidate;
      }),
    )
    .digest("hex");
}
