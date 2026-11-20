import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed"]),
  agentId: z.string(),
});
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
}

/** Owns message delivery receipts; creation is owned by CreationService. */
export class MessageReceipts {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly awaitingCommit = new Map<string, { fingerprint: string; agentId: string }>();
  constructor(private readonly directory: string) {}

  send(input: SendMessageInput): Promise<void> {
    // Preserve the existing on-disk identity and shape across daemon upgrades.
    const key = digest(["send", input.agentId, input.messageId]);
    const previous = this.pending.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.sendOnce(key, input),
    );
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => undefined);
    return result;
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
      throw new Error("agent_request_outcome_unknown");
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
