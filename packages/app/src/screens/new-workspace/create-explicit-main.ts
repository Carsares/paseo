import type {
  CreateWorkspaceRequestOptions,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import type {
  AgentSnapshotPayload,
  CreationSnapshot,
  WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { isMainControlAgent } from "@getpaseo/protocol/agent-labels";
import {
  sameMainDraftTarget,
  type MainDraft,
  type MainDraftAttempt,
  type MainDraftBatchItem,
  type MainDraftTarget,
} from "./main-draft";

type InitialAgent = NonNullable<CreateWorkspaceRequestOptions["agent"]>;

function hasFirstMessage(agent: InitialAgent): boolean {
  return Boolean(agent.initialPrompt?.trim() || agent.images?.length || agent.attachments?.length);
}

function asExplicitWorkspaceMain(input: InitialAgent): InitialAgent {
  const { initialPrompt, clientMessageId, ...agent } = input;
  return {
    ...agent,
    workspaceRole: "main",
    ...(hasFirstMessage(input) ? { initialPrompt, clientMessageId } : {}),
  };
}

type MainCreationClient = Pick<
  DaemonClient,
  "createWorkspace" | "createAgent" | "findWorkspace" | "getCreationSnapshot"
> & {
  fetchAgent: (agentId: string) => ReturnType<DaemonClient["fetchAgent"]>;
};

interface MainCreationResult {
  workspace: WorkspaceDescriptorPayload;
  agent: AgentSnapshotPayload;
}

async function readMainAttempt(
  client: MainCreationClient,
  attempt: MainDraftAttempt,
  messages: { unavailableMessage: string; inProgressMessage: string },
) {
  const { workspaceId, agentId, kind } = attempt;
  const { unavailableMessage, inProgressMessage } = messages;
  const receipt = await client.getCreationSnapshot(kind, agentId);
  if (!receipt || !matchesReceipt(receipt, attempt)) {
    throw new Error(unavailableMessage);
  }
  if (receipt.phase !== "completed" && receipt.phase !== "failed") {
    throw new Error(inProgressMessage);
  }
  if (
    receipt.phase === "failed" &&
    (receipt.outcomeUnknown !== false || receipt.failedStage === "prompt" || receipt.agent)
  ) {
    throw Object.assign(new Error(receipt.error ?? unavailableMessage), {
      code: receipt.errorCode,
    });
  }
  const [workspace, found] = await Promise.all([
    client.findWorkspace(workspaceId),
    client.fetchAgent(agentId),
  ]);
  const agent = found?.agent;
  if (receipt.phase === "completed") {
    if (workspace && agent && matchesAttempt({ workspace, agent }, attempt)) {
      return { workspace, agent };
    }
    throw new Error(unavailableMessage);
  }
  if (agent || !canRetryMainReceipt(receipt, workspace)) {
    throw new Error(unavailableMessage);
  }
  return { workspace, agent: null };
}

function matchesReceipt(receipt: CreationSnapshot, attempt: MainDraftAttempt) {
  return (
    receipt.idempotencyKey === attempt.agentId &&
    receipt.workspaceId === attempt.workspaceId &&
    receipt.agentId === attempt.agentId &&
    receipt.kind === attempt.kind
  );
}

function canRetryMainReceipt(
  receipt: CreationSnapshot,
  workspace: WorkspaceDescriptorPayload | null,
) {
  if (workspace) return workspace.id === receipt.workspaceId && receipt.failedStage === "agent";
  // If provisioning happened, a missing workspace must not be provisioned again.
  return receipt.kind === "workspace" && receipt.failedStage === "workspace" && !receipt.workspace;
}

function matchesAttempt({ workspace, agent }: MainCreationResult, attempt: MainDraftAttempt) {
  return (
    workspace.id === attempt.workspaceId &&
    agent.id === attempt.agentId &&
    agent.workspaceId === workspace.id &&
    !agent.archivedAt &&
    isMainControlAgent(agent)
  );
}

async function sendMainRequest(input: {
  client: MainCreationClient;
  attempt: MainDraftAttempt;
  agent: InitialAgent;
  workspace: WorkspaceDescriptorPayload | null;
  failedMessage: string;
  onEvent?: (snapshot: CreationSnapshot) => void;
}): Promise<MainCreationResult> {
  const { client, attempt, agent, workspace, failedMessage, onEvent } = input;
  const { workspaceId, agentId, placement } = attempt;
  const request = { workspaceId, idempotencyKey: agentId };
  if (workspace) {
    const created = await client.createAgent({
      ...agent,
      ...request,
      config: { ...agent.config!, cwd: workspace.workspaceDirectory! },
      agentId,
      ...(onEvent ? { onEvent } : {}),
    });
    return { workspace, agent: created };
  }
  const payload = await client.createWorkspace({
    ...placement,
    ...request,
    agent: { ...agent, agentId },
    ...(onEvent ? { onEvent } : {}),
  });
  if (payload.creation) onEvent?.(payload.creation);
  if (payload.error || !payload.workspace || !payload.agent) {
    throw Object.assign(new Error(payload.error ?? failedMessage), {
      code: payload.errorCode ?? payload.creation?.errorCode,
    });
  }
  return { workspace: payload.workspace, agent: payload.agent };
}

interface ExplicitMainInput {
  client: MainCreationClient;
  target: MainDraftTarget;
  prepareAgent: () => Promise<InitialAgent>;
  previous: MainDraft | null;
  save: (draft: MainDraft) => Promise<void>;
  prepareWorkspace: () => Promise<MainDraftAttempt["placement"]>;
  canCreateWorkspace: boolean;
  assertSupported: () => void;
  unavailableMessage: string;
  inProgressMessage: string;
  failedMessage: string;
}

export interface FixedMainInput {
  client: MainCreationClient;
  fixedAttempt: MainDraftBatchItem;
  agent: InitialAgent;
  action: "resume" | "check" | "retry";
  saveItem: (item: MainDraftBatchItem) => Promise<void>;
  acceptSnapshots: (workspace: WorkspaceDescriptorPayload, agent?: AgentSnapshotPayload) => void;
  assertSupported: () => void;
  failedMessage: string;
}

type FixedReceipt =
  | { state: "succeeded"; result: MainCreationResult }
  | {
      state: "unconfirmed";
      error?: string;
      workspace?: WorkspaceDescriptorPayload;
      agent?: AgentSnapshotPayload;
    }
  | { state: "retryable"; error?: string; workspace: WorkspaceDescriptorPayload | null };

function attemptForItem(item: MainDraftBatchItem): MainDraftAttempt {
  return {
    workspaceId: item.workspaceId,
    agentId: item.attemptKind === "agent" ? item.recoveryAgentId : item.agentId,
    kind: item.attemptKind,
    placement: item.placement,
  };
}

function confirmsInitialPrompt(receipt: CreationSnapshot): boolean {
  // Completed also means the agent was registered even when its first send failed.
  // A live event or a durable marker on the receipt confirms the send.
  return receipt.phase === "prompt_started" || receipt.initialPromptStarted === true;
}

function readFixedEntities(client: MainCreationClient, attempt: MainDraftAttempt) {
  return Promise.all([
    client.findWorkspace(attempt.workspaceId),
    client.fetchAgent(attempt.agentId),
  ]);
}

function isSafeFixedFailure(receipt: CreationSnapshot | null): receipt is CreationSnapshot {
  return (
    receipt?.phase === "failed" &&
    receipt.outcomeUnknown === false &&
    receipt.failedStage !== "prompt" &&
    !receipt.agent
  );
}

function readRegisteredMain(
  workspace: WorkspaceDescriptorPayload | null,
  agent: AgentSnapshotPayload | undefined,
  attempt: MainDraftAttempt,
  confirmed: boolean,
  error?: string,
): FixedReceipt | undefined {
  if (!workspace || !agent || !matchesAttempt({ workspace, agent }, attempt)) return;
  if (confirmed) return { state: "succeeded", result: { workspace, agent } };
  return { state: "unconfirmed", workspace, agent, error };
}

function confirmsSavedPrompt(receipt: CreationSnapshot | null): boolean {
  return Boolean(receipt && confirmsInitialPrompt(receipt));
}

function unknownFixedReceipt(
  receipt: CreationSnapshot | null,
  attempt: MainDraftAttempt,
): FixedReceipt {
  const workspace = receipt?.workspace;
  return {
    state: "unconfirmed",
    workspace: workspace?.id === attempt.workspaceId ? workspace : undefined,
    error: receipt?.error ?? undefined,
  };
}

async function readFixedReceipt(
  client: MainCreationClient,
  attempt: MainDraftAttempt,
  promptConfirmed = false,
): Promise<FixedReceipt> {
  const receipt = await client.getCreationSnapshot(attempt.kind, attempt.agentId);
  if (receipt && !matchesReceipt(receipt, attempt)) return { state: "unconfirmed" };

  const confirmed = promptConfirmed || confirmsSavedPrompt(receipt);
  if (!receipt || confirmed || receipt.agent) {
    const [workspace, found] = await readFixedEntities(client, attempt);
    const result = readRegisteredMain(
      workspace,
      found?.agent,
      attempt,
      confirmed,
      receipt?.error ?? undefined,
    );
    if (result) return result;
  }

  if (isSafeFixedFailure(receipt)) {
    const [workspace, found] = await readFixedEntities(client, attempt);
    if (!found?.agent && canRetryMainReceipt(receipt, workspace)) {
      return { state: "retryable", workspace, error: receipt.error ?? undefined };
    }
  }

  return unknownFixedReceipt(receipt, attempt);
}

async function runFixedMainAttempt(input: FixedMainInput): Promise<void> {
  const { client, fixedAttempt, action, saveItem, acceptSnapshots, failedMessage } = input;
  if (fixedAttempt.stage === "succeeded") return;
  const saveSuccess = async (item: MainDraftBatchItem, result: MainCreationResult) => {
    acceptSnapshots(result.workspace, result.agent);
    await saveItem({ ...item, stage: "succeeded", agentReady: true, error: undefined });
  };
  const readReceipt = async (item: MainDraftBatchItem): Promise<FixedReceipt> => {
    try {
      return await readFixedReceipt(client, attemptForItem(item), item.promptConfirmed);
    } catch {
      return { state: "unconfirmed" };
    }
  };
  const storeReceipt = async (item: MainDraftBatchItem, receipt: FixedReceipt) => {
    if (receipt.state === "succeeded") {
      await saveSuccess(item, receipt.result);
      return;
    }
    const agent = receipt.state === "unconfirmed" ? receipt.agent : undefined;
    if (receipt.workspace) acceptSnapshots(receipt.workspace, agent);
    await saveItem({
      ...item,
      stage: receipt.state,
      agentReady: Boolean(agent) || item.agentReady,
      error: receipt.error ?? item.error,
    });
  };

  let item = fixedAttempt;
  let workspace: WorkspaceDescriptorPayload | null = null;
  if (item.stage === "queued") {
    if (action === "check") return;
  } else {
    const receipt = await readReceipt(item);
    if (action !== "retry" || receipt.state !== "retryable") {
      await storeReceipt(item, receipt);
      return;
    }
    workspace = receipt.workspace;
    if (workspace) {
      acceptSnapshots(workspace);
      // The original receipt owns its claimed agent ID. The separate agent request
      // uses its own reserved ID in the same, already-created workspace.
      item = { ...item, attemptKind: "agent" };
    }
  }

  input.assertSupported();
  if (workspace && !workspace.workspaceDirectory) throw new Error(failedMessage);
  item = { ...item, stage: "sending", error: undefined };
  await saveItem(item);
  const attempt = attemptForItem(item);
  let confirmationWrite: Promise<void> | undefined;
  let result: MainCreationResult;
  try {
    result = await sendMainRequest({
      client,
      attempt,
      workspace,
      agent: asExplicitWorkspaceMain(input.agent),
      failedMessage,
      onEvent: (receipt) => {
        if (
          item.promptConfirmed ||
          !matchesReceipt(receipt, attempt) ||
          !confirmsInitialPrompt(receipt)
        ) {
          return;
        }
        item = { ...item, promptConfirmed: true };
        // Preserve the positive evidence even if the final response is lost.
        confirmationWrite = saveItem(item);
        void confirmationWrite.catch(() => undefined);
      },
    });
    if (!matchesAttempt(result, attempt)) throw new Error(failedMessage);
  } catch (error) {
    await confirmationWrite;
    await storeReceipt(
      { ...item, error: error instanceof Error ? error.message : undefined },
      await readReceipt(item),
    );
    return;
  }
  await confirmationWrite;
  if (item.promptConfirmed) {
    await saveSuccess(item, result);
  } else {
    const receipt = await readReceipt(item);
    await storeReceipt(item, receipt.state === "unconfirmed" ? { ...receipt, ...result } : receipt);
  }
}

export function createOrRetryWorkspaceMain(input: FixedMainInput): Promise<void>;
export function createOrRetryWorkspaceMain(input: ExplicitMainInput): Promise<MainCreationResult>;
export function createOrRetryWorkspaceMain(input: ExplicitMainInput | FixedMainInput) {
  return "fixedAttempt" in input ? runFixedMainAttempt(input) : runExplicitMainAttempt(input);
}

async function runExplicitMainAttempt(input: ExplicitMainInput): Promise<MainCreationResult> {
  const { client, target, previous, save, unavailableMessage, failedMessage } = input;
  if (previous && !sameMainDraftTarget(previous.target, target))
    throw new Error(unavailableMessage);
  const prior = previous?.attempt;
  const recovery = prior ? await readMainAttempt(client, prior, input) : null;
  if (recovery?.agent) return { workspace: recovery.workspace, agent: recovery.agent };

  const workspace = recovery?.workspace ?? null;
  if (!workspace && !input.canCreateWorkspace) throw new Error(unavailableMessage);
  input.assertSupported();
  const agent = asExplicitWorkspaceMain(await input.prepareAgent());
  if (!agent.config || (workspace && !workspace.workspaceDirectory)) throw new Error(failedMessage);
  const attempt: MainDraftAttempt = {
    // A rejected request still owns its allocated ID on the host.
    workspaceId: workspace?.id ?? `wks_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    agentId: crypto.randomUUID(),
    kind: workspace ? "agent" : "workspace",
    placement: prior?.placement ?? (await input.prepareWorkspace()),
  };
  input.assertSupported();
  await save({ target, attempt });
  const result = await sendMainRequest({ client, attempt, agent, workspace, failedMessage });
  if (!matchesAttempt(result, attempt)) throw new Error(unavailableMessage);
  return result;
}
