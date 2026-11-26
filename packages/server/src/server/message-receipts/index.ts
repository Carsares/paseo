import type { AgentActiveTurnBehavior } from "@getpaseo/protocol/messages";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AgentAttachmentSchema } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentCommandOutcome } from "../agent/agent-sdk-types.js";

import { topicDelegationScopeSchema } from "../agent/tools/topic-delegation.js";

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
  activeTurnBehavior: z.enum(["steer", "interrupt", "queue"]),
  immediateSteer: z.boolean().optional(),
  heldAfterStop: z.boolean().optional(),
  topicDelegation: topicDelegationScopeSchema.optional(),
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
  waitForForegroundConfirmation?: boolean;
  begin(): Promise<void>;
  holdAfterStop?(): Promise<void>;
  releaseAfterStop?(): Promise<void>;
  rejectHeld?(
    agentId: string,
    messageId: string,
    rejectReservation: (message: RecoverableAgentMessage) => Promise<boolean>,
  ): Promise<boolean>;
  declined(): Promise<void>;
  /** Continue dispatching from the same durable queue receipt after a declined attempt. */
  retryQueued?(): Promise<void>;
  onProviderOutcome?(outcome: AgentCommandOutcome): Promise<void>;
}
export class AgentRequestOutcomeUnknownError extends Error {
  constructor(options?: ErrorOptions) {
    super("agent_request_outcome_unknown", options);
  }
}
interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  /**
   * Delivers the message. It awaits `beforeDispatch` immediately before any provider can receive
   * the message. A silent delivery can return after it has durably recorded the result.
   */
  send: (
    beforeDispatch: () => Promise<void>,
    declined: () => Promise<void>,
    onProviderOutcome: (outcome: AgentCommandOutcome) => Promise<void>,
  ) => Promise<void>;
  /** Admission was refused before the message could enter the delivery queue. */
  retryIfNotAdmitted?: (error: unknown) => boolean;
  /** Only errors that prove the provider never received the message may clear a pending receipt. */
  retryIfUnsent?: (error: unknown) => boolean;
  /**
   * For a matching pending receipt without queued content, confirm durable evidence of silent
   * delivery for this exact recipient and message. Recovery never calls `send`.
   */
  confirmPendingSilentDelivery?: () => Promise<boolean>;
  queue?: Omit<QueueMessageInput, "agentId" | "request">;
}

interface QueueAdmission {
  dispatched: Promise<unknown>;
  activeTurnBehavior?: AgentActiveTurnBehavior;
  guidance?: string;
}

interface QueueMessageInput {
  agentId: string;
  request: unknown;
  message: RecoverableAgentMessage;
  enqueue: (handoff: QueueHandoff) => Promise<QueueAdmission>;
  onQueued?: (receipt: QueueAdmission) => void;
  retainOnError?: (error: unknown) => boolean;
}

/** Owns message delivery receipts; creation is owned by CreationService. */
export class MessageReceipts {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly awaitingCommit = new Map<string, { fingerprint: string; agentId: string }>();
  private admissionTail = Promise.resolve();
  private sequence = 0;
  constructor(private readonly directory: string) {}

  async blockedReportDeferralRevision(
    workspaceId: string,
    reportId: string,
    currentRevision: string | undefined,
  ): Promise<string | undefined> {
    const key = digest(["blocked-report-wake", workspaceId, reportId]);
    const file = path.join(this.directory, `wake-${key}.json`);
    let revision: string | undefined;
    await this.serialize(key, async () => {
      try {
        const saved = z
          .object({ revision: z.string().nullable() })
          .parse(JSON.parse(await readFile(file, "utf8")));
        revision = saved.revision ?? undefined;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        await writeJsonFileAtomic(file, { revision: currentRevision ?? null });
        revision = currentRevision;
      }
    });
    return revision;
  }

  async outcome(
    agentId: string,
    messageId: string,
    expectedFingerprint?: string,
  ): Promise<"accepted" | "unknown" | "absent"> {
    const key = digest(["send", agentId, messageId]);
    const receipt = await readReceipt(path.join(this.directory, `${key}.json`));
    if (!receipt || receipt.agentId !== agentId) return "absent";
    if (expectedFingerprint !== undefined && receipt.fingerprint !== expectedFingerprint) {
      return "absent";
    }
    return receipt.state === "completed" ? "accepted" : "unknown";
  }

  /** Legacy peer history may identify the request by fingerprint, without its queue ID. */
  async findCompletedFingerprints(candidates: ReadonlyMap<string, string>): Promise<Set<string>> {
    const accepted = new Set<string>();
    if (!candidates.size) return accepted;
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const receipt = await readReceipt(path.join(this.directory, name)).catch(() => null);
      if (receipt?.state === "completed" && candidates.get(receipt.fingerprint) === receipt.agentId)
        accepted.add(receipt.fingerprint);
      if (accepted.size === candidates.size) break;
    }
    return accepted;
  }

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
    return this.serialize(key, () =>
      this.deliverQueued(key, fingerprintMessageRequest(input.request), input),
    );
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
      let declinedAndRestored = false;
      let heldRejectionCommitted = false;
      let providerOutcome: AgentCommandOutcome | undefined;
      const saveQueued = () => this.writeQueued(file, { ...receipt, state: "pending", queued });
      if (!existing) await saveQueued();
      let receiptWrites = Promise.resolve();
      const write = <T>(operation: () => Promise<T>): Promise<T> => {
        const pending = receiptWrites.then(operation);
        receiptWrites = pending.then(
          () => undefined,
          () => undefined,
        );
        return pending;
      };
      const writeTerminalReceipt = () =>
        writeJsonFileAtomic(file, { ...receipt, state: "pending" });
      const handoff: QueueHandoff = {
        holdAfterStop: () =>
          write(async () => {
            if (heldRejectionCommitted) return;
            queued.message = { ...queued.message, heldAfterStop: true };
            if (!handedOff) await saveQueued();
          }),
        releaseAfterStop: () =>
          write(async () => {
            if (heldRejectionCommitted) return;
            queued.message = {
              ...queued.message,
              heldAfterStop: undefined,
              activeTurnBehavior: "queue",
              immediateSteer: undefined,
            };
            if (!handedOff) await saveQueued();
          }),
        rejectHeld: (agentId, messageId, rejectReservation) =>
          write(async () => {
            if (
              heldRejectionCommitted ||
              handedOff ||
              providerOutcome ||
              agentId !== receipt.agentId
            )
              return false;
            const stored = await readReceipt(file);
            if (
              stored?.state !== "pending" ||
              stored.agentId !== agentId ||
              stored.fingerprint !== fingerprint ||
              !stored.queued?.message.heldAfterStop ||
              stored.queued.message.messageId !== messageId ||
              digest(stored.queued) !== digest(queued)
            )
              return false;
            if (!(await rejectReservation(stored.queued.message))) return false;
            // Keep the queue recoverable until the reservation cleanup is durable.
            await writeTerminalReceipt();
            heldRejectionCommitted = true;
            return true;
          }),
        begin: () =>
          write(async () => {
            if (heldRejectionCommitted) throw new Error("Queued recipient is no longer available");
            if (handedOff) return;
            declinedAndRestored = false;
            await writeTerminalReceipt();
            handedOff = true;
          }),
        declined: () =>
          write(async () => {
            if (!handedOff || providerOutcome) return;
            await saveQueued();
            handedOff = false;
            declinedAndRestored = true;
          }),
        retryQueued: () =>
          write(async () => {
            if (!handedOff) declinedAndRestored = false;
          }),
        onProviderOutcome: (outcome: AgentCommandOutcome) =>
          write(async () => {
            if (!handedOff || providerOutcome === "accepted") return;
            if (outcome === "accepted") {
              this.awaitingCommit.set(key, receipt);
              await this.commit(file, key, receipt);
            }
            providerOutcome = outcome;
            if (outcome === "unknown") {
              handedOff = true;
              await writeTerminalReceipt();
            }
          }),
      };
      try {
        const queuedDelivery = await input.enqueue(handoff);
        input.onQueued?.(queuedDelivery);
        return {
          completed: queuedDelivery.dispatched.then(
            () =>
              write(async () => {
                if (providerOutcome || heldRejectionCommitted) return;
                this.awaitingCommit.set(key, receipt);
                await this.commit(file, key, receipt);
              }),
            async (error) => {
              if (input.retainOnError?.(error)) {
                await handoff.declined();
              } else {
                await write(async () => {
                  if (!handedOff && !declinedAndRestored && !heldRejectionCommitted)
                    await writeTerminalReceipt();
                });
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
    const fingerprint = fingerprintMessageRequest(input.request);
    const accepted = this.awaitingCommit.get(key);
    if (accepted) {
      if (accepted.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
      await this.commit(file, key, accepted);
      return;
    }
    const existing = await readReceipt(file);
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.agentId !== input.agentId) {
        throw new Error("agent_request_key_conflict");
      }
      if (existing.state === "completed") return;
      if (!existing.queued && (await input.confirmPendingSilentDelivery?.())) {
        await this.commit(file, key, { fingerprint, agentId: input.agentId });
        return;
      }
      // A provider may have accepted the message before its receipt was committed.
      throw new AgentRequestOutcomeUnknownError();
    }
    const receipt = { fingerprint, agentId: input.agentId };
    let pending: Promise<void> | null = null;
    const declined = async () => {
      if (!pending) return;
      await pending.catch(() => undefined);
      await rm(file, { force: true });
      pending = null;
    };
    let providerOutcome: AgentCommandOutcome | undefined;
    try {
      await input.send(
        () => {
          pending ??= writeJsonFileAtomic(file, { ...receipt, state: "pending" });
          return pending;
        },
        declined,
        async (outcome) => {
          providerOutcome = outcome;
        },
      );
    } catch (error) {
      if (input.retryIfNotAdmitted?.(error) || input.retryIfUnsent?.(error)) await declined();
      throw error;
    }
    if (providerOutcome === "unknown") return;
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

export function fingerprintMessageRequest(request: unknown): string {
  return digest(request);
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
