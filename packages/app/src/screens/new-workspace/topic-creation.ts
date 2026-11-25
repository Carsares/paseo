import type {
  CreateWorkspaceRequestOptions,
  DaemonClient,
  FetchAgentResult,
} from "@getpaseo/client/internal/daemon-client";
import { isMainControlAgent } from "@getpaseo/protocol/agent-labels";
import type {
  AgentSnapshotPayload,
  CreationSnapshot,
  WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import type { MainDraft } from "./main-draft";
import {
  isRejectedBoundTopicPrompt,
  isUnboundTopicWorkspace,
  readTopicPromptReceipt,
} from "@/composer/draft/topic-receipts";

export type TopicPlacement = Pick<CreateWorkspaceRequestOptions, "source" | "metadata"> & {
  title: string;
  topic: NonNullable<CreateWorkspaceRequestOptions["topic"]>;
};

export function readTopicFields(text = "", direction = "", hideFromModel = false) {
  const firstLine = text
    .split(/\r\n?|\n/)
    .find((line) => line.trim())
    ?.trim();
  if (!firstLine) return null;
  const title = Array.from(firstLine).slice(0, 80).join("").trimEnd();
  const originalDirection = text.trim() === title ? null : text;
  return {
    title,
    topic: {
      summary: direction.trim() ? direction : originalDirection,
      hideFromModel,
    },
  };
}

export type TopicRequest = NonNullable<MainDraft["topicAttempt"]>;

type TopicConfig = NonNullable<CreateWorkspaceRequestOptions["mainAgent"]>["config"];
export type TopicPrompt = Pick<
  NonNullable<CreateWorkspaceRequestOptions["agent"]>,
  "initialPrompt" | "images" | "attachments" | "metadata"
> & { clientMessageId: string; agentId: string };

export function topicRequest(
  placement: TopicPlacement,
  identity: Pick<TopicRequest, "workspaceId" | "idempotencyKey">,
  main: { config: TopicConfig; prompt?: TopicPrompt } | null,
): TopicRequest {
  const { metadata, ...workspace } = placement;
  const base = {
    ...workspace,
    ...identity,
    ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
  };
  if (!main) return base;
  if (
    main.prompt &&
    (main.prompt.initialPrompt?.trim() ||
      main.prompt.images?.length ||
      main.prompt.attachments?.length)
  ) {
    return {
      ...base,
      agent: { ...main.prompt, labels: {}, config: main.config, workspaceRole: "main" },
    };
  }
  return { ...base, mainAgent: { config: main.config } };
}

export type TopicCreationClient = Pick<
  DaemonClient,
  "createWorkspace" | "getCreationSnapshot" | "findWorkspace" | "fetchAgentTimeline"
> & {
  fetchAgent: (agentId: string) => Promise<FetchAgentResult | null>;
};
interface TopicEntities {
  workspace?: WorkspaceDescriptorPayload;
  agent?: AgentSnapshotPayload;
}
export type TopicOutcome =
  | ({ stage: "succeeded"; workspace: WorkspaceDescriptorPayload } & TopicEntities)
  | ({ stage: "retryable" | "unconfirmed"; error?: string } & TopicEntities);

function matchingEntities(
  request: TopicRequest,
  workspace: WorkspaceDescriptorPayload | null | undefined,
  agent: AgentSnapshotPayload | null | undefined,
): TopicEntities {
  if (!workspace?.topic || workspace.id !== request.workspaceId) return {};
  const expectedAgentId = request.agent?.agentId ?? workspace.topic.mainAgentId;
  if (
    !expectedAgentId ||
    (workspace.topic.mainAgentId && workspace.topic.mainAgentId !== expectedAgentId) ||
    agent?.id !== expectedAgentId ||
    agent.workspaceId !== workspace.id ||
    agent.archivedAt ||
    !isMainControlAgent(agent)
  ) {
    return { workspace };
  }
  return { workspace, agent };
}

async function confirmed(
  client: TopicCreationClient,
  request: TopicRequest,
  receipt: CreationSnapshot | null | undefined,
  entities: TopicEntities,
  prompt?: Awaited<ReturnType<typeof readTopicPromptReceipt>>,
): Promise<TopicOutcome | undefined> {
  if (!entities.workspace) return;
  if (request.agent) {
    if (!entities.agent || !request.agent.clientMessageId) return;
    const started =
      !receipt?.outcomeUnknown &&
      (receipt?.initialPromptStarted === true || receipt?.phase === "prompt_started");
    if (
      !started &&
      (prompt ??
        (await readTopicPromptReceipt(
          client,
          entities.agent.id,
          request.agent.clientMessageId,
        ))) !== "recorded"
    )
      return;
  } else {
    if (
      receipt?.phase !== "completed" ||
      receipt.outcomeUnknown ||
      (request.mainAgent && !entities.agent)
    )
      return;
  }
  return { ...entities, stage: "succeeded", workspace: entities.workspace };
}

function matchingReceipt(request: TopicRequest, receipt: CreationSnapshot | null | undefined) {
  if (receipt?.kind !== "workspace") return null;
  if (
    receipt.idempotencyKey !== request.idempotencyKey ||
    receipt.workspaceId !== request.workspaceId
  )
    return null;
  if (request.agent && receipt.agentId !== request.agent.agentId) return null;
  return receipt;
}

function canRetryTopic(
  request: TopicRequest,
  snapshot: PromiseSettledResult<CreationSnapshot | null>,
  latest: CreationSnapshot | null,
  directory: PromiseSettledResult<WorkspaceDescriptorPayload | null>,
  prompt: Awaited<ReturnType<typeof readTopicPromptReceipt>> | undefined,
) {
  if (snapshot.status !== "fulfilled" || directory.status !== "fulfilled") return false;
  const workspace = directory.value;
  if (!latest) return snapshot.value === null && workspace === null;
  if (!matchingReceipt(request, snapshot.value)) return false;
  if (latest.failedStage === "prompt") {
    const agentId = request.agent?.agentId;
    return (
      latest === snapshot.value &&
      prompt === "not-found" &&
      !!agentId &&
      isRejectedBoundTopicPrompt(latest, workspace, request.workspaceId, agentId)
    );
  }
  return canRetryUnboundTopic(latest, workspace, request.workspaceId);
}

function canRetryUnboundTopic(
  receipt: CreationSnapshot,
  workspace: WorkspaceDescriptorPayload | null,
  workspaceId: string,
) {
  if (receipt.outcomeUnknown) return false;
  const unbound = isUnboundTopicWorkspace(workspace, workspaceId);
  if (receipt.phase === "workspace_ready") return unbound && !receipt.agent && !receipt.mainAgent;
  if (receipt.outcomeUnknown !== false || receipt.phase !== "failed") return false;
  if (receipt.failedStage === "workspace") return !workspace && !receipt.workspace;
  return receipt.failedStage === "agent" && unbound && !receipt.agent && !receipt.mainAgent;
}

async function reconcileTopic(
  client: TopicCreationClient,
  request: TopicRequest,
  update?: CreationSnapshot,
): Promise<TopicOutcome> {
  const [snapshot, directory] = await Promise.allSettled([
    client.getCreationSnapshot("workspace", request.idempotencyKey),
    client.findWorkspace(request.workspaceId),
  ]);
  const receipt = matchingReceipt(request, snapshot.status === "fulfilled" ? snapshot.value : null);
  const event = matchingReceipt(request, update);
  const latest = event && (!receipt || event.revision > receipt.revision) ? event : receipt;
  const workspace = directory.status === "fulfilled" ? directory.value : latest?.workspace;
  const agent = await readTopicAgent(client, request, workspace, latest);
  const entities = matchingEntities(request, workspace, agent);
  const prompt =
    latest?.failedStage === "prompt" && entities.agent && request.agent?.clientMessageId
      ? await readTopicPromptReceipt(client, entities.agent.id, request.agent.clientMessageId)
      : undefined;
  const success = await confirmed(client, request, latest, entities, prompt);
  if (success) return success;
  return {
    ...entities,
    stage: canRetryTopic(request, snapshot, latest, directory, prompt)
      ? "retryable"
      : "unconfirmed",
    error: latest?.error ?? undefined,
  };
}

async function readTopicAgent(
  client: TopicCreationClient,
  request: TopicRequest,
  workspace: WorkspaceDescriptorPayload | null | undefined,
  snapshot: CreationSnapshot | null,
) {
  const stored = snapshot?.agent ?? snapshot?.mainAgent;
  const boundId = workspace?.topic?.mainAgentId;
  if (stored || !boundId || request.agent?.agentId !== boundId) return stored;
  return (await client.fetchAgent(boundId).catch(() => null))?.agent;
}

export async function runTopicCreation(
  client: TopicCreationClient,
  request: TopicRequest,
  action: "submit" | "check" | "retry",
  update?: CreationSnapshot,
): Promise<TopicOutcome> {
  if (action !== "submit") {
    const outcome = await reconcileTopic(client, request, update);
    if (action === "check" || outcome.stage !== "retryable") return outcome;
  }
  let error: string | undefined;
  try {
    const response = await client.createWorkspace(request);
    const entities = matchingEntities(
      request,
      response.workspace,
      response.agent ?? response.mainAgent,
    );
    const success = await confirmed(
      client,
      request,
      matchingReceipt(request, response.creation),
      entities,
    );
    if (success) return success;
    error = response.error ?? undefined;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : undefined;
  }
  const outcome = await reconcileTopic(client, request);
  return outcome.stage === "succeeded" ? outcome : { ...outcome, error: outcome.error ?? error };
}
