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
  readTopicPromptReceipt,
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
};
export type TopicQuestionOutcome =
  | { stage: "confirmed"; agent: AgentSnapshotPayload }
  | { stage: "queue-unavailable" }
  | { stage: "retry" }
  | { stage: "unconfirmed" };

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

function promptStarted(receipt: CreationSnapshot | null) {
  return (
    !receipt?.outcomeUnknown &&
    (receipt?.initialPromptStarted === true || receipt?.phase === "prompt_started")
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
      (agentCreationFailedBeforeBinding(receipt) && receipt?.errorCode !== "workspace_main_exists"))
  );
}

async function reconcileContinuedQuestion(
  client: TopicQuestionClient,
  request: SavedTopicQuestion["request"],
  continuationAgentId: string,
): Promise<TopicQuestionOutcome> {
  // The send may have reached the host. Only a positive receipt for the recorded target settles it.
  if (!continuationAgentId) return { stage: "unconfirmed" };
  const { agent } = await readMainAgent(client, continuationAgentId, request.workspaceId);
  if (
    agent &&
    (await readTopicPromptReceipt(client, agent.id, request.clientMessageId)) === "recorded"
  ) {
    return { stage: "confirmed", agent };
  }
  return { stage: "unconfirmed" };
}

export async function reconcileTopicQuestion(
  client: TopicQuestionClient,
  saved: SavedTopicQuestion,
  update?: CreationSnapshot,
): Promise<TopicQuestionOutcome> {
  const { request, continuationAgentId } = saved;
  if (continuationAgentId !== undefined) {
    return reconcileContinuedQuestion(client, request, continuationAgentId);
  }
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
    const stored = matchingReceipt(
      request,
      creation.status === "fulfilled" ? creation.value : null,
    );
    const retry =
      receipt === stored &&
      isRejectedBoundTopicPrompt(stored, workspace, request.workspaceId, request.agentId);
    return reconcileBoundPrompt(
      client,
      request,
      candidate.agent,
      receipt,
      boundMainId,
      mainConflict,
      retry,
    );
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

async function reconcileBoundPrompt(
  client: TopicQuestionClient,
  request: SavedTopicQuestion["request"],
  agent: AgentSnapshotPayload,
  receipt: CreationSnapshot | null,
  boundMainId: string | null | undefined,
  mainConflict: boolean,
  retry: boolean,
): Promise<TopicQuestionOutcome> {
  if (agent.id === request.agentId && promptStarted(receipt)) return { stage: "confirmed", agent };
  const prompt = await readTopicPromptReceipt(client, agent.id, request.clientMessageId);
  if (prompt === "recorded") return { stage: "confirmed", agent };
  if (prompt === "not-found" && retry) return { stage: "retry" };
  if (
    prompt === "not-found" &&
    mainConflict &&
    agent.id === boundMainId &&
    agent.id !== request.agentId
  ) {
    // Wave 0 queues agent-originated messages. Human sends only support interrupt and steer.
    // Resume this path when the host exposes ordered admission for a human topic first question.
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
  },
): Promise<TopicQuestionOutcome> {
  const outcome = await reconcileTopicQuestion(client, saved, options.update);
  if (action === "retry" && outcome.stage === "retry") {
    options.assertAvailable();
    return submitFrozenTopicQuestion(client, saved);
  }
  return outcome;
}

export async function submitFrozenTopicQuestion(
  client: TopicQuestionClient,
  saved: SavedTopicQuestion,
): Promise<TopicQuestionOutcome> {
  let latest: CreationSnapshot | undefined;
  try {
    await client.createAgent({
      ...saved.request,
      onEvent: (snapshot) => {
        latest = snapshot;
      },
    });
  } catch {
    // The transport may have lost the response after dispatch.
  }
  return reconcileTopicQuestion(client, saved, latest);
}
