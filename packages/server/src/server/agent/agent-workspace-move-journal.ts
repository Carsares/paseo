import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type { AgentStorage } from "./agent-storage.js";

const PreparedMoveSchema = z.object({
  workspaceId: z.string(),
  sourceWorkspaceId: z.string(),
  // Moves prepared without this field used to publish the workspace before writing members.
  receiptKeyHash: z.string().nullable().optional(),
  members: z.array(
    z.object({
      id: z.string(),
      labels: z.record(z.string(), z.string()),
      updatedAt: z.string(),
    }),
  ),
});

const MoveJournalSchema = z.object({
  prepared: PreparedMoveSchema.optional(),
  receipts: z.array(z.object({ key: z.string(), workspaceId: z.string() })),
});

type PreparedMove = z.infer<typeof PreparedMoveSchema>;
type MoveJournalState = z.infer<typeof MoveJournalSchema>;

interface AgentWorkspaceMoveJournalOptions {
  paseoHome: string;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "remove">;
}

export class AgentWorkspaceMoveJournal {
  private readonly filePath: string;

  constructor(private readonly options: AgentWorkspaceMoveJournalOptions) {
    this.filePath = join(options.paseoHome, "agent-workspace-move.json");
  }

  private async read(): Promise<MoveJournalState> {
    try {
      return MoveJournalSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { receipts: [] };
      }
      throw error;
    }
  }

  async findReceipt(key: string): Promise<string | undefined> {
    const { prepared, receipts } = await this.read();
    const hash = hashReceiptKey(key);
    if (prepared?.receiptKeyHash === hash && (await this.wasPublished(prepared))) {
      return prepared.workspaceId;
    }
    return receipts.find((receipt) => receipt.key === hash)?.workspaceId;
  }

  // The prepared entry reaches disk before any member changes workspace.
  async prepare(prepared: Omit<PreparedMove, "receiptKeyHash">, key: string | null): Promise<void> {
    const state = await this.read();
    if (state.prepared && !(await this.wasPublished(state.prepared))) {
      throw new Error("A previous workspace move requires recovery");
    }
    await writeJsonFileAtomic(this.filePath, {
      receipts: receiptsAfterPublication(state),
      prepared: { ...prepared, receiptKeyHash: key === null ? null : hashReceiptKey(key) },
    });
  }

  // The target is saved after all members. Its presence commits the move even
  // when the daemon exits before this receipt is finalized.
  async commit(workspaceId: string): Promise<void> {
    const state = await this.read();
    if (state.prepared?.workspaceId !== workspaceId) {
      throw new Error("Workspace move journal is missing its prepared entry");
    }
    await writeJsonFileAtomic(this.filePath, { receipts: receiptsAfterPublication(state) });
  }

  async recover(storage: Pick<AgentStorage, "get" | "upsert">): Promise<void> {
    const state = await this.read();
    const { prepared } = state;
    if (!prepared) return;
    if (await this.wasPublished(prepared)) {
      await writeJsonFileAtomic(this.filePath, { receipts: receiptsAfterPublication(state) });
      return;
    }
    await this.restoreUnpublishedMembers(storage, state);
  }

  private async wasPublished(prepared: PreparedMove): Promise<boolean> {
    return (
      prepared.receiptKeyHash !== undefined &&
      Boolean(await this.options.workspaceRegistry.get(prepared.workspaceId))
    );
  }

  private async restoreUnpublishedMembers(
    storage: Pick<AgentStorage, "get" | "upsert">,
    { prepared, receipts }: MoveJournalState,
  ): Promise<void> {
    if (!prepared) return;
    for (const member of prepared.members.toReversed()) {
      const record = await storage.get(member.id);
      if (record?.workspaceId !== prepared.workspaceId) continue;
      await storage.upsert({
        ...record,
        workspaceId: prepared.sourceWorkspaceId,
        labels: member.labels,
        updatedAt: member.updatedAt,
      });
    }
    if (prepared.receiptKeyHash === undefined) {
      await this.options.workspaceRegistry.remove(prepared.workspaceId);
    }
    await writeJsonFileAtomic(this.filePath, { receipts });
  }
}

export async function recoverAgentWorkspaceMove(
  options: AgentWorkspaceMoveJournalOptions & { agentStorage: AgentStorage },
): Promise<void> {
  await new AgentWorkspaceMoveJournal(options).recover(options.agentStorage);
}

function receiptsAfterPublication({ prepared, receipts }: MoveJournalState) {
  return prepared?.receiptKeyHash
    ? [...receipts.slice(-255), { key: prepared.receiptKeyHash, workspaceId: prepared.workspaceId }]
    : receipts;
}

function hashReceiptKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
