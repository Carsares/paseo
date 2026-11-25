import type { Logger } from "pino";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  CreationSnapshotSchema,
  type AgentSnapshotPayload,
  type CreationSnapshot,
  type WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { writeFileAtomic } from "../atomic-file.js";
import { generateWorkspaceId } from "../workspace-registry-model.js";
import { isMainControlAgentLabels } from "@getpaseo/protocol/agent-labels";

type Observer = (snapshot: CreationSnapshot) => void;
export interface CreatedAgent {
  agent: AgentSnapshotPayload;
  initialPromptStarted: boolean;
}
export interface TopicPromptRetry {
  agentId: string;
  workspaceId: string;
  messageId: string;
  fingerprint: string;
}
interface CreationRecovery {
  isTopicPromptBound?: (agentId: string, workspaceId: string) => Promise<boolean>;
  readTopicWorkspace?: (workspaceId: string) => Promise<{
    workspace: WorkspaceDescriptorPayload;
    setupSkippedReason?: string;
  } | null>;
  readMainAgent?: (agentId: string, workspaceId: string) => Promise<AgentSnapshotPayload | null>;
  readPromptOutcome?: (
    agentId: string,
    messageId: string,
    expectedFingerprint: string,
  ) => Promise<"accepted" | "unknown" | "absent">;
}
interface CreationRequest extends CreationRecovery {
  key: string;
  request: { [key: string]: unknown };
  workspaceId?: string;
  agentId?: string;
  hasAgent: boolean;
  hasPrompt: boolean;
  promptMessageId?: string;
  promptReceiptFingerprint?: string;
  exists: (kind: "workspace" | "agent", id: string) => Promise<boolean>;
  provision?: (
    workspaceId: string,
  ) => Promise<{ workspace: WorkspaceDescriptorPayload; setupSkippedReason?: string }>;
  createMainAgent?: (
    workspace: WorkspaceDescriptorPayload,
    agentId: string,
  ) => Promise<AgentSnapshotPayload>;
  createAgent?: (
    agentId: string,
    workspace: WorkspaceDescriptorPayload | undefined,
    onReady: (agent: AgentSnapshotPayload) => Promise<void>,
    mainAgent: AgentSnapshotPayload | null | undefined,
  ) => Promise<CreatedAgent>;
  retryPromptRevision?: number;
  retryTopicPrompt?: (target: TopicPromptRetry) => Promise<void>;
}
export type CreationInput = CreationRequest &
  (
    | { kind: "workspace" }
    | { kind: "agent"; readAgent: (id: string) => Promise<AgentSnapshotPayload | null> }
  );
const RecordSchema = z.object({
  fingerprint: z.string(),
  snapshot: CreationSnapshotSchema,
  mainAgentId: z.string().optional(),
  promptMessageId: z.string().optional(),
  promptReceiptFingerprint: z.string().optional(),
  inFlight: z.enum(["workspace", "agent", "mainAgent", "prompt"]).nullable(),
});
type Record = z.infer<typeof RecordSchema>;

/** Owns creation across socket lifetimes. Resource owners perform work; this module commits its milestones. */
export class CreationService {
  private admission: Promise<unknown> = Promise.resolve();
  private readonly active = new Map<string, Promise<CreationSnapshot>>();
  private readonly receiptOperations = new Map<string, Promise<void>>();
  private readonly observers = new Map<string, Set<Observer>>();
  constructor(
    private readonly directory: string,
    private readonly logger: Logger,
    private readonly validateCompleted: (
      snapshot: CreationSnapshot,
    ) => Promise<void> = async () => {},
    private readonly legacyDirectory?: string,
    private readonly writeReceipt: (
      path: string,
      contents: string,
    ) => Promise<void> = writeFileAtomic,
  ) {}

  async create(input: CreationInput, observer?: Observer): Promise<CreationSnapshot> {
    const identity = identityFor(input.kind, input.key);
    const pending = this.active.get(identity);
    const admitted = this.admit(async () => {
      await mkdir(this.directory, { recursive: true });
      const fingerprint = digest(input.request);
      const activeOnRead = this.active.get(identity);
      let record = await this.read(identity);
      if (!record) record = await this.readLegacyAgent(input, fingerprint);
      if (record && record.fingerprint !== fingerprint)
        throw new Error(`${input.kind}_request_key_conflict`);
      const running = pending ?? activeOnRead ?? this.active.get(identity);
      if (running && record) return { completion: running, snapshot: record.snapshot };
      if (record) {
        await this.reconcileAdmission(identity, record, input);
        if (isSettled(record) || input.retryPromptRevision !== undefined) {
          const snapshot = record.snapshot;
          const retry = await this.prepareTopicPromptRetry(record, input);
          const settled = record;
          return {
            snapshot,
            completion: retry
              ? this.start(identity, () => this.retryTopicPrompt(identity, settled, input, retry))
              : Promise.resolve(snapshot),
          };
        }
      }
      if (!record) {
        // A retry only authorizes the named refusal, never a new creation.
        if (input.retryPromptRevision !== undefined) {
          throw new Error("The first question has no saved creation receipt.");
        }
        record = initialRecord(input, fingerprint);
        // Persist identity before claiming resources. A failed admission can only retry these IDs.
        await this.write(identity, record);
      }
      await this.claimResources(identity, record, input);
      if (record.snapshot.phase === "failed") {
        await this.publish(identity, record, {
          phase: record.snapshot.workspace ? "workspace_ready" : "accepted",
          error: null,
          errorCode: undefined,
          failedStage: undefined,
          outcomeUnknown: undefined,
        });
      }
      const snapshot = record.snapshot;
      const completion = this.start(identity, () => this.run(identity, record, input));
      return { completion, snapshot };
    });
    // Install before admission starts, so even a fast local provision cannot outrun observation.
    const unsubscribe = observer ? this.observe(identity, observer) : () => {};
    try {
      const { completion, snapshot } = await admitted;
      if (observer) this.notify(observer, snapshot);
      return await completion;
    } finally {
      unsubscribe();
    }
  }

  private async reconcileAdmission(identity: string, record: Record, input: CreationInput) {
    if (record.snapshot.phase === "completed") await this.validateCompleted(record.snapshot);
    await this.reconcileTopic(identity, record, input);
    if (record.inFlight === "mainAgent" && input.retryPromptRevision === undefined) {
      await this.recoverMainAgent(identity, record, input);
    }
    await this.markInterruptedUnknown(identity, record);
  }

  async subscribe(
    kind: CreationSnapshot["kind"],
    key: string,
    observer: Observer,
    recovery?: CreationRecovery,
  ): Promise<{ snapshot: CreationSnapshot | null; unsubscribe: () => void }> {
    const identity = identityFor(kind, key);
    const unsubscribe = this.observe(identity, observer);
    try {
      const observation = await this.admit(async () => {
        const record = await this.read(identity);
        if (record?.snapshot.phase === "completed") {
          await this.validateCompleted(record.snapshot);
        } else if (record && !this.active.has(identity)) {
          await this.reconcileTopic(identity, record, recovery);
          await this.markInterruptedUnknown(identity, record);
        }
        if (!record) return null;
        const { snapshot } = record;
        if (
          !this.active.has(identity) &&
          !record.inFlight &&
          !snapshot.agent &&
          !snapshot.mainAgent &&
          (snapshot.phase === "accepted" ||
            (snapshot.phase === "workspace_ready" &&
              snapshot.workspace?.topic?.mainAgentId === null))
        ) {
          return { ...snapshot, canResume: true };
        }
        return snapshot;
      });
      return { snapshot: observation, unsubscribe };
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  private async markInterruptedUnknown(identity: string, record: Record): Promise<void> {
    const { inFlight, snapshot } = record;
    if (!inFlight || inFlight === "mainAgent" || snapshot.outcomeUnknown) return;
    await this.publish(identity, record, {
      phase: "failed",
      failedStage: inFlight,
      outcomeUnknown: true,
      ...(inFlight === "prompt" ? { initialPromptStarted: undefined } : {}),
      error: `${snapshot.kind}_request_outcome_unknown`,
    });
  }

  private admit<T>(operation: () => Promise<T>): Promise<T> {
    const admitted = this.admission.then(operation);
    this.admission = admitted.then(
      () => undefined,
      () => undefined,
    );
    return admitted;
  }

  private start(identity: string, run: () => Promise<CreationSnapshot>) {
    const completion = Promise.resolve().then(run);
    this.active.set(identity, completion);
    void completion.finally(() => this.active.delete(identity)).catch(() => undefined);
    return completion;
  }

  private async prepareTopicPromptRetry(record: Record, input: CreationInput) {
    const retry = input.retryTopicPrompt;
    if (!retry || input.retryPromptRevision !== record.snapshot.revision) return;
    const target = rejectedTopicPromptTarget(record);
    if (
      target &&
      (await this.isTopicPromptBound(record.snapshot, input)) &&
      (await this.readPromptOutcome(record, input)) === "absent"
    ) {
      return () => retry(target);
    }
  }

  private async retryTopicPrompt(
    identity: string,
    record: Record,
    input: CreationInput,
    send: () => Promise<void>,
  ): Promise<CreationSnapshot> {
    const agent = record.snapshot.agent!;
    await this.publish(
      identity,
      record,
      {
        phase: "agent_ready",
        error: null,
        errorCode: undefined,
        failedStage: undefined,
        outcomeUnknown: undefined,
      },
      "prompt",
    );
    const result = await send().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      const outcome = await this.readPromptOutcome(record, input);
      if (outcome !== "accepted" && outcome !== "absent" && !result.ok) throw result.error;
      await this.recordTopicPrompt(identity, record, agent, outcome);
      if (record.snapshot.initialPromptStarted) {
        await this.publish(identity, record, { phase: "completed" }, null);
      }
    } catch (error) {
      if (record.snapshot.initialPromptStarted) throw error;
      await this.recordFailure(identity, record, input.exists, error);
    }
    return record.snapshot;
  }

  private async run(
    identity: string,
    record: Record,
    input: CreationInput,
  ): Promise<CreationSnapshot> {
    try {
      if (input.provision && !record.snapshot.workspace) {
        record.inFlight = "workspace";
        await this.write(identity, record);
        const { workspace, setupSkippedReason } = await input.provision(
          record.snapshot.workspaceId!,
        );
        await this.publish(
          identity,
          record,
          {
            phase: "workspace_ready",
            workspace,
            workspaceId: workspace.id,
            setupSkippedReason,
          },
          null,
        );
      }
      await this.createMainAgent(identity, record, input.createMainAgent);
      if (input.hasAgent && input.createAgent && !record.snapshot.agent) {
        record.inFlight = "agent";
        await this.write(identity, record);
        const { agent, initialPromptStarted } = await input.createAgent(
          record.snapshot.agentId!,
          record.snapshot.workspace,
          async (readyAgent) => {
            await this.publish(
              identity,
              record,
              { phase: "agent_ready", ...withReadyAgent(record.snapshot, readyAgent) },
              input.hasPrompt ? "prompt" : null,
            );
          },
          record.snapshot.mainAgent,
        );
        if (isTopicPrompt(record) && input.hasPrompt) {
          const outcome = await this.readPromptOutcome(record, input, initialPromptStarted);
          await this.recordTopicPrompt(identity, record, agent, outcome);
          if (!record.snapshot.initialPromptStarted) return record.snapshot;
        } else {
          record.inFlight = null;
          if (initialPromptStarted) {
            await this.publish(identity, record, {
              phase: "prompt_started",
              agent,
              initialPromptStarted: true,
            });
          } else {
            record.snapshot = { ...record.snapshot, agent };
          }
        }
      }
      await this.publish(identity, record, { phase: "completed" }, null);
    } catch (error) {
      // Keep the committed acceptance checkpoint if validation or the final write failed.
      if (isTopicPrompt(record) && record.snapshot.initialPromptStarted) throw error;
      await this.recordFailure(identity, record, input.exists, error);
    }
    return record.snapshot;
  }

  private async recordTopicPrompt(
    identity: string,
    record: Record,
    agent: AgentSnapshotPayload,
    outcome: Awaited<ReturnType<CreationService["readPromptOutcome"]>>,
  ): Promise<void> {
    if (outcome === "accepted") {
      // Keep the prompt in flight until completion is also durable.
      await this.publish(identity, record, {
        phase: "prompt_started",
        agent,
        initialPromptStarted: true,
      });
      return;
    }
    if (outcome !== "absent") throw new Error(`${record.snapshot.kind}_request_outcome_unknown`);
    await this.publish(
      identity,
      record,
      {
        phase: "failed",
        agent,
        initialPromptStarted: false,
        failedStage: "prompt",
        outcomeUnknown: false,
        error: "The first question was not accepted.",
      },
      null,
    );
  }

  private async recordFailure(
    identity: string,
    record: Record,
    exists: CreationInput["exists"],
    error: unknown,
  ): Promise<void> {
    const { inFlight, snapshot } = record;
    const stage = inFlight === "mainAgent" ? "agent" : (inFlight ?? "agent");
    let resourceId = stage === "workspace" ? snapshot.workspaceId : snapshot.agentId;
    if (inFlight === "mainAgent") resourceId = record.mainAgentId ?? null;
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    const rejectedBeforeProvision = code === "directory_not_found" || code === "source_required";
    const unknown =
      stage === "prompt" ||
      (stage === "workspace" && !rejectedBeforeProvision) ||
      (resourceId !== null && (await exists(stage, resourceId)));
    // A partially provisioned resource or an attempted prompt needs reconciliation.
    if (!unknown) record.inFlight = null;
    await this.publish(identity, record, {
      phase: "failed",
      error: error instanceof Error ? error.message : String(error),
      errorCode: code,
      failedStage: stage,
      outcomeUnknown: unknown,
    });
  }

  private async createMainAgent(
    identity: string,
    record: Record,
    create: CreationInput["createMainAgent"],
  ): Promise<void> {
    if (!create || !record.snapshot.workspace || !record.mainAgentId || record.snapshot.mainAgent)
      return;
    record.inFlight = "mainAgent";
    await this.write(identity, record);
    const mainAgent = await create(record.snapshot.workspace, record.mainAgentId);
    await this.publish(
      identity,
      record,
      {
        mainAgent,
        workspace: withMainAgent(record.snapshot.workspace, mainAgent.id),
      },
      null,
    );
  }

  // COMPAT(agentRequestReceipts): added in v0.8.0, remove after 2027-03-11 once old creation receipts can expire.
  // Import the previous receipt format; it is never a second execution path.
  private async readLegacyAgent(input: CreationInput, fingerprint: string): Promise<Record | null> {
    if (input.kind !== "agent" || !this.legacyDirectory) return null;
    const text = await readOptional(
      join(this.legacyDirectory, `${digest(["create", input.key])}.json`),
    );
    if (text === null) return null;
    const receipt = z
      .object({
        fingerprint: z.string(),
        state: z.enum(["pending", "completed"]),
        agentId: z.string(),
      })
      .parse(JSON.parse(text));
    if (receipt.fingerprint !== digest({ type: "create_agent_request", ...input.request }))
      throw new Error("agent_request_key_conflict");
    const agent = await input.readAgent(receipt.agentId);
    if (!agent && receipt.state === "completed")
      throw new Error("Previously created agent no longer exists");
    const record = initialRecord({ ...input, agentId: receipt.agentId }, fingerprint);
    record.snapshot = {
      ...record.snapshot,
      phase: agent ? "completed" : "failed",
      agent: agent ?? undefined,
      workspaceId: agent?.workspaceId ?? record.snapshot.workspaceId,
      error: agent ? null : "agent_request_outcome_unknown",
      ...(agent ? {} : { failedStage: "agent", outcomeUnknown: true }),
    };
    await this.write(identityFor(input.kind, input.key), record);
    return record;
  }

  private async recoverMainAgent(
    identity: string,
    record: Record,
    input: CreationInput,
  ): Promise<void> {
    const { mainAgentId, snapshot } = record;
    if (!mainAgentId || !snapshot.workspaceId || !input.readMainAgent || !input.createMainAgent) {
      throw new Error("Unable to recover the default Main Session.");
    }
    const mainAgent = await input.readMainAgent(mainAgentId, snapshot.workspaceId);
    record.inFlight = null;
    await this.publish(identity, record, {
      phase: "workspace_ready",
      error: null,
      errorCode: undefined,
      failedStage: undefined,
      outcomeUnknown: undefined,
      ...(mainAgent && snapshot.workspace
        ? { mainAgent, workspace: withMainAgent(snapshot.workspace, mainAgent.id) }
        : {}),
    });
  }

  private async reconcileTopic(
    identity: string,
    record: Record,
    recovery?: CreationRecovery,
  ): Promise<void> {
    if (record.snapshot.phase === "completed") return;

    await this.recoverTopicWorkspace(identity, record, recovery);
    if (await this.recoverTopicPromptAgent(identity, record, recovery)) return;
    if (shouldReconcileTopicPrompt(record)) {
      return this.reconcileTopicPrompt(identity, record, recovery);
    }
    await this.reconcileSilentTopic(identity, record, recovery);
  }

  private async recoverTopicWorkspace(
    identity: string,
    record: Record,
    recovery?: CreationRecovery,
  ): Promise<void> {
    const { kind, workspaceId, workspace } = record.snapshot;
    if (kind !== "workspace" || record.inFlight !== "workspace" || workspace || !workspaceId)
      return;
    const saved = await recovery?.readTopicWorkspace?.(workspaceId);
    if (saved?.workspace.id !== workspaceId || !saved.workspace.topic) return;
    await this.publish(
      identity,
      record,
      {
        ...saved,
        phase: "workspace_ready",
        error: null,
        errorCode: undefined,
        failedStage: undefined,
        outcomeUnknown: undefined,
      },
      null,
    );
  }

  private async reconcileSilentTopic(
    identity: string,
    record: Record,
    recovery?: CreationRecovery,
  ): Promise<void> {
    const { snapshot, mainAgentId } = record;
    const workspace = snapshot.workspace;
    // Only silent topic creation can finish without a separate agent and first prompt.
    if (snapshot.kind !== "workspace" || !workspace?.topic) return;
    if (snapshot.agentId || (record.inFlight && record.inFlight !== "mainAgent")) return;
    if (snapshot.phase === "failed" && !record.inFlight) return;
    const readMainAgent = recovery?.readMainAgent;
    const mainAgent =
      snapshot.mainAgent ??
      (mainAgentId && readMainAgent ? await readMainAgent(mainAgentId, workspace.id) : null);
    if (mainAgentId && !mainAgent) {
      if (record.inFlight !== "mainAgent" || !readMainAgent) return;
      await this.publish(
        identity,
        record,
        {
          phase: "failed",
          failedStage: "agent",
          outcomeUnknown: false,
          error: "Main Session registration did not complete.",
        },
        null,
      );
      return;
    }
    await this.publish(
      identity,
      record,
      {
        phase: "completed",
        error: null,
        errorCode: undefined,
        failedStage: undefined,
        outcomeUnknown: undefined,
        ...(mainAgent ? { mainAgent, workspace: withMainAgent(workspace, mainAgent.id) } : {}),
      },
      null,
    );
  }

  private async recoverTopicPromptAgent(
    identity: string,
    record: Record,
    recovery?: CreationRecovery,
  ): Promise<boolean> {
    const { agentId, workspaceId, agent: knownAgent } = record.snapshot;
    const { promptMessageId, promptReceiptFingerprint } = record;
    if (
      record.inFlight !== "agent" ||
      knownAgent ||
      !agentId ||
      !workspaceId ||
      !promptMessageId ||
      !promptReceiptFingerprint
    )
      return false;
    const agent = await recovery?.readMainAgent?.(agentId, workspaceId).catch(() => null);
    if (!agent) return false;
    const outcome = await recovery?.readPromptOutcome?.(
      agentId,
      promptMessageId,
      promptReceiptFingerprint,
    );
    if (outcome === "accepted") {
      await this.publish(
        identity,
        record,
        {
          ...withReadyAgent(record.snapshot, agent),
          phase: "completed",
          initialPromptStarted: true,
          error: null,
          errorCode: undefined,
          failedStage: undefined,
          outcomeUnknown: undefined,
        },
        null,
      );
      return true;
    }
    // The runner waits for the agent-ready checkpoint before attempting the prompt.
    const unknown =
      outcome !== "absent" ||
      !(await this.isTopicPromptBound(withReadyAgent(record.snapshot, agent), recovery));
    await this.publish(
      identity,
      record,
      {
        ...withReadyAgent(record.snapshot, agent),
        phase: "failed",
        failedStage: "prompt",
        initialPromptStarted: unknown ? undefined : false,
        outcomeUnknown: unknown,
        error: unknown
          ? `${record.snapshot.kind}_request_outcome_unknown`
          : "The first question was not accepted.",
        errorCode: undefined,
      },
      unknown ? "prompt" : null,
    );
    return true;
  }

  private async reconcileTopicPrompt(
    identity: string,
    record: Record,
    recovery?: CreationRecovery,
  ): Promise<void> {
    const outcome = await this.readPromptOutcome(
      record,
      recovery,
      record.snapshot.initialPromptStarted,
    );
    if (outcome !== "accepted") {
      const bound =
        outcome === "absent" && (await this.isTopicPromptBound(record.snapshot, recovery));
      if (bound && !isRejectedTopicPrompt(record)) {
        await this.recordTopicPrompt(identity, record, record.snapshot.agent!, "absent");
      } else if (!bound && isRejectedTopicPrompt(record)) {
        await this.publish(
          identity,
          record,
          {
            initialPromptStarted: undefined,
            outcomeUnknown: true,
            error: `${record.snapshot.kind}_request_outcome_unknown`,
          },
          "prompt",
        );
      }
      return;
    }
    await this.publish(
      identity,
      record,
      {
        phase: "completed",
        initialPromptStarted: true,
        error: null,
        errorCode: undefined,
        failedStage: undefined,
        outcomeUnknown: undefined,
      },
      null,
    );
  }

  private async isTopicPromptBound(
    snapshot: Pick<CreationSnapshot, "agent" | "workspaceId">,
    recovery?: CreationRecovery,
  ) {
    const { agent, workspaceId } = snapshot;
    if (
      !agent ||
      !workspaceId ||
      agent.workspaceId !== workspaceId ||
      agent.archivedAt ||
      !isMainControlAgentLabels(agent.labels)
    )
      return false;
    return recovery?.isTopicPromptBound
      ? recovery.isTopicPromptBound(agent.id, workspaceId).catch(() => false)
      : true;
  }

  private async readPromptOutcome(
    record: Record,
    recovery?: CreationRecovery,
    legacyAccepted?: boolean,
  ) {
    const { snapshot, promptMessageId, promptReceiptFingerprint } = record;
    if (
      isTopicPrompt(record) &&
      snapshot.agent &&
      promptMessageId &&
      promptReceiptFingerprint &&
      recovery?.readPromptOutcome
    ) {
      return recovery
        .readPromptOutcome(snapshot.agent.id, promptMessageId, promptReceiptFingerprint)
        .catch(() => "unknown" as const);
    }
    return legacyAccepted ? "accepted" : undefined;
  }

  private async claimResources(
    identity: string,
    record: Record,
    input: CreationInput,
  ): Promise<void> {
    const { snapshot, mainAgentId } = record;
    if (input.kind === "workspace" && snapshot.workspaceId)
      await this.claim(identity, "workspace", snapshot.workspaceId, input.exists);
    if (snapshot.agentId) await this.claim(identity, "agent", snapshot.agentId, input.exists);
    if (mainAgentId) await this.claim(identity, "agent", mainAgentId, input.exists);
  }

  private async claim(
    identity: string,
    kind: "workspace" | "agent",
    id: string,
    exists: CreationInput["exists"],
  ): Promise<void> {
    const file = join(this.directory, `${digest([kind, id])}.claim`);
    const owner = await readOptional(file);
    if (owner !== null) {
      if (owner !== identity) throw new Error(`${kind}_id_conflict`);
      return;
    }
    if (await exists(kind, id)) throw new Error(`${kind}_id_conflict`);
    await writeFile(file, identity, { flag: "wx", mode: 0o600 });
  }
  private observe(identity: string, observer: Observer): () => void {
    const observers = this.observers.get(identity) ?? new Set<Observer>();
    observers.add(observer);
    this.observers.set(identity, observers);
    return () => {
      observers.delete(observer);
      if (!observers.size) this.observers.delete(identity);
    };
  }
  private notify(observer: Observer, snapshot: CreationSnapshot): void {
    try {
      observer(snapshot);
    } catch (err) {
      this.logger.warn(
        {
          err,
          kind: snapshot.kind,
          idempotencyKey: snapshot.idempotencyKey,
          phase: snapshot.phase,
        },
        "Creation observer failed",
      );
    }
  }
  private async publish(
    identity: string,
    record: Record,
    update: Partial<CreationSnapshot>,
    inFlight = record.inFlight,
  ): Promise<void> {
    const snapshot = { ...record.snapshot, ...update, revision: record.snapshot.revision + 1 };
    if (snapshot.phase === "completed" && isTopicPrompt(record))
      await this.validateCompleted(snapshot);
    await this.write(identity, { ...record, snapshot, inFlight });
    record.snapshot = snapshot;
    record.inFlight = inFlight;
    for (const observer of this.observers.get(identity) ?? []) this.notify(observer, snapshot);
  }
  private write(identity: string, record: Record): Promise<void> {
    // Serialize now: the runner mutates the record after queueing this write.
    const contents = JSON.stringify(record, null, 2);
    return this.accessReceipt(identity, () =>
      this.writeReceipt(join(this.directory, `${identity}.json`), contents),
    );
  }
  private read(identity: string): Promise<Record | null> {
    return this.accessReceipt(identity, async () => {
      const text = await readOptional(join(this.directory, `${identity}.json`));
      return text === null ? null : RecordSchema.parse(JSON.parse(text));
    });
  }
  private accessReceipt<T>(identity: string, access: () => Promise<T>): Promise<T> {
    // Admission and the runner progress independently. Keep this owner from
    // holding a receipt read open while atomically replacing the same file.
    const previous = this.receiptOperations.get(identity) ?? Promise.resolve();
    const result = previous.then(access);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.receiptOperations.set(identity, settled);
    void settled.finally(() => {
      if (this.receiptOperations.get(identity) === settled) this.receiptOperations.delete(identity);
    });
    return result;
  }
}
function isSettled(record: Record): boolean {
  const { snapshot } = record;
  return (
    snapshot.phase === "completed" ||
    snapshot.outcomeUnknown === true ||
    isRejectedTopicPrompt(record)
  );
}
function isTopicPrompt({ snapshot, promptMessageId, promptReceiptFingerprint }: Record): boolean {
  return Boolean(snapshot.workspace?.topic || (promptMessageId && promptReceiptFingerprint));
}
function isRejectedTopicPrompt(record: Record): boolean {
  const { snapshot } = record;
  return (
    isTopicPrompt(record) &&
    snapshot.phase === "failed" &&
    snapshot.failedStage === "prompt" &&
    snapshot.outcomeUnknown === false
  );
}
function rejectedTopicPromptTarget(record: Record): TopicPromptRetry | undefined {
  const { snapshot, promptMessageId, promptReceiptFingerprint } = record;
  if (
    isRejectedTopicPrompt(record) &&
    !record.inFlight &&
    !snapshot.initialPromptStarted &&
    snapshot.agentId &&
    snapshot.agent?.id === snapshot.agentId &&
    snapshot.workspaceId &&
    snapshot.agent.workspaceId === snapshot.workspaceId &&
    isMainControlAgentLabels(snapshot.agent.labels) &&
    promptMessageId &&
    promptReceiptFingerprint
  ) {
    return {
      agentId: snapshot.agentId,
      workspaceId: snapshot.workspaceId,
      messageId: promptMessageId,
      fingerprint: promptReceiptFingerprint,
    };
  }
}
function shouldReconcileTopicPrompt(record: Record): boolean {
  const { inFlight, snapshot } = record;
  return (
    isTopicPrompt(record) &&
    (inFlight === "prompt" ||
      snapshot.initialPromptStarted === true ||
      isRejectedTopicPrompt(record))
  );
}
function initialRecord(input: CreationInput, fingerprint: string): Record {
  return {
    fingerprint,
    inFlight: null,
    ...(input.createMainAgent ? { mainAgentId: randomUUID() } : {}),
    ...(input.promptMessageId ? { promptMessageId: input.promptMessageId } : {}),
    ...(input.promptReceiptFingerprint
      ? { promptReceiptFingerprint: input.promptReceiptFingerprint }
      : {}),
    snapshot: {
      kind: input.kind,
      idempotencyKey: input.key,
      revision: 0,
      phase: "accepted",
      error: null,
      workspaceId: input.workspaceId ?? (input.kind === "workspace" ? generateWorkspaceId() : null),
      agentId: input.hasAgent ? (input.agentId ?? randomUUID()) : null,
    },
  };
}
function withMainAgent(workspace: WorkspaceDescriptorPayload, agentId: string) {
  return {
    ...workspace,
    hasActiveMainAgent: true,
    ...(workspace.topic ? { topic: { ...workspace.topic, mainAgentId: agentId } } : {}),
  };
}
function withReadyAgent(snapshot: CreationSnapshot, agent: AgentSnapshotPayload) {
  return {
    agent,
    workspaceId: agent.workspaceId ?? snapshot.workspaceId,
    ...(snapshot.workspace && isMainControlAgentLabels(agent.labels)
      ? { workspace: withMainAgent(snapshot.workspace, agent.id) }
      : {}),
  };
}
function identityFor(kind: string, key: string): string {
  return digest([kind, key]);
}
function digest(input: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(input, (_key, value: unknown) => {
        if (value && typeof value === "object" && !Array.isArray(value))
          return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
        return value;
      }),
    )
    .digest("hex");
}
async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
