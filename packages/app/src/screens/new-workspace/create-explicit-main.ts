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
}): Promise<MainCreationResult> {
  const { client, attempt, agent, workspace, failedMessage } = input;
  const { workspaceId, agentId, placement } = attempt;
  const request = { workspaceId, idempotencyKey: agentId };
  if (workspace) {
    const created = await client.createAgent({
      ...agent,
      ...request,
      config: { ...agent.config!, cwd: workspace.workspaceDirectory! },
      agentId,
    });
    return { workspace, agent: created };
  }
  const payload = await client.createWorkspace({
    ...placement,
    ...request,
    agent: { ...agent, agentId },
  });
  if (payload.error || !payload.workspace || !payload.agent) {
    throw Object.assign(new Error(payload.error ?? failedMessage), {
      code: payload.errorCode ?? payload.creation?.errorCode,
    });
  }
  return { workspace: payload.workspace, agent: payload.agent };
}

export async function createOrRetryWorkspaceMain(input: {
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
}): Promise<MainCreationResult> {
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
