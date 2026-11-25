import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  DaemonClient,
  FetchAgentOptions,
  FetchAgentResult,
} from "@getpaseo/client/internal/daemon-client";
import { isMainControlAgent } from "@getpaseo/protocol/agent-labels";
import {
  AgentCreateRequestSchema,
  type AgentSnapshotPayload,
  type CreationSnapshot,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import { isWeb } from "@/constants/platform";
import {
  creationSnapshotMatches,
  isRejectedBoundTopicPrompt,
  isUnboundTopicWorkspace,
  isTopicPromptAccepted,
} from "./topic-receipts";

const requestSchema = AgentCreateRequestSchema.pick({
  agentId: true,
  idempotencyKey: true,
  workspaceId: true,
  workspaceRole: true,
  config: true,
  initialPrompt: true,
  clientMessageId: true,
  attachments: true,
  images: true,
  metadata: true,
}).required({
  agentId: true,
  idempotencyKey: true,
  workspaceId: true,
  workspaceRole: true,
  initialPrompt: true,
  clientMessageId: true,
});
const savedQuestionSchema = z.object({
  request: requestSchema,
  continuationAgentId: z.string().optional(),
});
export type SavedTopicQuestion = z.infer<typeof savedQuestionSchema>;
export type TopicQuestionClient = Pick<
  DaemonClient,
  "getCreationSnapshot" | "findWorkspace" | "fetchAgentTimeline" | "createAgent"
> & {
  fetchAgent: (input: FetchAgentOptions) => Promise<FetchAgentResult | null>;
  supportsTopicPromptRetry?: DaemonClient["supportsTopicPromptRetry"];
};
export type TopicQuestionOutcome =
  | { stage: "confirmed"; agent: AgentSnapshotPayload }
  | { stage: "queue-unavailable" }
  | { stage: "retry"; retryPromptRevision?: number }
  | { stage: "unconfirmed" }
  | { stage: "update-host" };

const storageKey = (draftId: string) => `paseo:topic-first-question:${draftId}`;
const operations = new Map<string, Promise<unknown>>();

export function withTopicQuestionOperation<T>(draftId: string, run: () => Promise<T>): Promise<T> {
  const key = storageKey(draftId);
  const locks = isWeb ? globalThis.navigator?.locks : undefined;
  const current = (operations.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => (locks ? locks.request(key, run) : run()));
  operations.set(key, current);
  void current
    .finally(() => {
      if (operations.get(key) === current) operations.delete(key);
    })
    .catch(() => undefined);
  return current;
}

export async function readTopicQuestion(draftId: string): Promise<SavedTopicQuestion | null> {
  const raw = await AsyncStorage.getItem(storageKey(draftId));
  return raw === null ? null : savedQuestionSchema.parse(JSON.parse(raw));
}

export async function writeTopicQuestion(draftId: string, question: SavedTopicQuestion) {
  await AsyncStorage.setItem(storageKey(draftId), JSON.stringify(question));
}

export function clearTopicQuestion(draftId: string) {
  return AsyncStorage.removeItem(storageKey(draftId));
}

function matchingAgent(
  agent: AgentSnapshotPayload | null | undefined,
  id: string,
  workspaceId: string,
): agent is AgentSnapshotPayload {
  return (
    agent?.id === id &&
    agent.workspaceId === workspaceId &&
    !agent.archivedAt &&
    isMainControlAgent(agent)
  );
}

function matchingReceipt(
  request: SavedTopicQuestion["request"],
  receipt?: CreationSnapshot | null,
) {
  return creationSnapshotMatches(receipt, {
    kind: "agent",
    idempotencyKey: request.idempotencyKey,
  }) &&
    receipt.agentId === request.agentId &&
    (receipt.workspaceId === request.workspaceId || receipt.workspaceId === null)
    ? receipt
    : null;
}

function agentCreationFailedBeforeBinding(receipt: CreationSnapshot | null) {
  return (
    receipt?.phase === "failed" &&
    receipt.failedStage === "agent" &&
    receipt.outcomeUnknown === false &&
    !receipt.agent
  );
}

async function readMainAgent(client: TopicQuestionClient, id: string, workspaceId: string) {
  const result = await client.fetchAgent({ agentId: id }).catch(() => undefined);
  if (result === undefined) return { available: false, agent: null };
  const agent = result?.agent;
  return { available: true, agent: matchingAgent(agent, id, workspaceId) ? agent : null };
}

function latestQuestionReceipt(
  request: SavedTopicQuestion["request"],
  creation: PromiseSettledResult<CreationSnapshot | null>,
  update?: CreationSnapshot,
) {
  const stored = matchingReceipt(request, creation.status === "fulfilled" ? creation.value : null);
  const event = matchingReceipt(request, update);
  return event && (!stored || event.revision > stored.revision) ? event : stored;
}

function canRetryUnboundQuestion(
  creation: PromiseSettledResult<CreationSnapshot | null>,
  receipt: CreationSnapshot | null,
) {
  return (
    creation.status === "fulfilled" &&
    ((creation.value === null && !receipt) ||
      (receipt?.phase === "accepted" && receipt.canResume === true) ||
      (agentCreationFailedBeforeBinding(receipt) && receipt?.errorCode !== "workspace_main_exists"))
  );
}

export async function reconcileTopicQuestion(
  client: TopicQuestionClient,
  saved: SavedTopicQuestion,
  update?: CreationSnapshot,
): Promise<TopicQuestionOutcome> {
  const { request, continuationAgentId } = saved;
  // Legacy continuations have no identity-matched creation receipt. Preserve the draft.
  if (continuationAgentId !== undefined) return { stage: "unconfirmed" };
  const [creation, directory] = await Promise.allSettled([
    client.getCreationSnapshot("agent", request.idempotencyKey),
    client.findWorkspace(request.workspaceId),
  ]);
  const receipt = latestQuestionReceipt(request, creation, update);
  const workspace = directory.status === "fulfilled" ? directory.value : null;
  const topic = workspace?.id === request.workspaceId ? workspace.topic : undefined;
  const boundMainId = topic?.mainAgentId;
  const rejected = agentCreationFailedBeforeBinding(receipt);
  const mainConflict = rejected && receipt?.errorCode === "workspace_main_exists";
  const agentId = mainConflict ? boundMainId : request.agentId;
  if (!agentId) return { stage: "unconfirmed" };
  const candidate = matchingAgent(receipt?.agent, agentId, request.workspaceId)
    ? { available: true, agent: receipt.agent }
    : await readMainAgent(client, agentId, request.workspaceId);
  if (candidate.agent) {
    return boundQuestionOutcome({
      client,
      agent: candidate.agent,
      receipt,
      workspace,
      request,
      mainConflict,
      stored: creation.status === "fulfilled" ? matchingReceipt(request, creation.value) : null,
    });
  }
  if (
    isUnboundTopicWorkspace(workspace, request.workspaceId) &&
    canRetryUnboundQuestion(creation, receipt) &&
    candidate.available
  ) {
    return { stage: "retry" };
  }
  return { stage: "unconfirmed" };
}

function boundQuestionOutcome(input: {
  client: TopicQuestionClient;
  agent: AgentSnapshotPayload;
  receipt: CreationSnapshot | null;
  stored: CreationSnapshot | null;
  workspace: Awaited<ReturnType<TopicQuestionClient["findWorkspace"]>>;
  request: SavedTopicQuestion["request"];
  mainConflict: boolean;
}): TopicQuestionOutcome {
  const { agent, receipt, stored, workspace, request, client } = input;
  if (agent.id === request.agentId && isTopicPromptAccepted(receipt)) {
    return { stage: "confirmed", agent };
  }
  if (
    stored &&
    receipt === stored &&
    isRejectedBoundTopicPrompt(stored, workspace, request.workspaceId, request.agentId)
  ) {
    return client.supportsTopicPromptRetry?.()
      ? { stage: "retry", retryPromptRevision: stored.revision }
      : { stage: "update-host" };
  }
  if (
    input.mainConflict &&
    agent.id === workspace?.topic?.mainAgentId &&
    agent.id !== request.agentId
  ) {
    return { stage: "queue-unavailable" };
  }
  return { stage: "unconfirmed" };
}

export function freezeTopicQuestion(
  input: Omit<SavedTopicQuestion["request"], "agentId" | "idempotencyKey">,
) {
  const agentId = globalThis.crypto.randomUUID();
  return savedQuestionSchema.parse({ request: { ...input, agentId, idempotencyKey: agentId } });
}

export async function runTopicQuestionAction(
  client: TopicQuestionClient,
  saved: SavedTopicQuestion,
  action: "check" | "retry",
  options: {
    update?: CreationSnapshot;
    assertAvailable: () => void;
    expectedPromptRevision?: number | null;
  },
): Promise<TopicQuestionOutcome> {
  const outcome = await reconcileTopicQuestion(client, saved, options.update);
  if (action === "retry" && outcome.stage === "retry") {
    if (
      options.expectedPromptRevision !== undefined &&
      options.expectedPromptRevision !== (outcome.retryPromptRevision ?? null)
    )
      return outcome;
    options.assertAvailable();
    return submitFrozenTopicQuestion(client, saved, outcome.retryPromptRevision);
  }
  return outcome;
}

export async function submitFrozenTopicQuestion(
  client: TopicQuestionClient,
  saved: SavedTopicQuestion,
  retryPromptRevision?: number,
): Promise<TopicQuestionOutcome> {
  let latest: CreationSnapshot | undefined;
  try {
    await client.createAgent({
      ...saved.request,
      ...(retryPromptRevision !== undefined ? { retryPromptRevision } : {}),
      onEvent: (snapshot) => {
        latest = snapshot;
      },
    });
  } catch {
    // The transport may have lost the response after dispatch.
  }
  return reconcileTopicQuestion(client, saved, latest);
}
