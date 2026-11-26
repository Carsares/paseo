import {
  TopicAnchorSummarySchema,
  type TopicAnchorSummary,
  type TopicMessageAttribution,
} from "@getpaseo/protocol/messages";
import { createHash } from "node:crypto";
import { projectAgentMessages } from "../agent/agent-messages/envelope.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import type { WorkspaceTask } from "../agent/task-ledger/index.js";

export type TopicAnchorInput = Omit<TopicAnchorSummary, "createdAt" | "updatedAt">;
export const TOPIC_ANCHOR_LIMIT = 500;

type TopicAddress = Pick<
  TopicAnchorInput,
  "workspaceId" | "mainAgentId" | "topicKey" | "rootMessageId" | "taskId"
>;

export function sameThreadScope(
  a: TopicAddress,
  b: Pick<TopicAddress, "workspaceId" | "mainAgentId">,
) {
  return a.workspaceId === b.workspaceId && a.mainAgentId === b.mainAgentId;
}

export function checkTopicAddress({ topicKey, taskId, rootMessageId }: TopicAddress): void {
  if (topicKey.startsWith("task:") && (!taskId || topicKey !== `task:${taskId}`))
    throw new Error("The task does not belong to this topic.");
  if (
    topicKey.startsWith("msg:") &&
    (!rootMessageId || taskId || topicKey !== `msg:${rootMessageId}`)
  )
    throw new Error("The first message does not belong to this topic.");
}

export function mergeAnchor(anchors: TopicAnchorSummary[], input: TopicAnchorInput) {
  const parsed = TopicAnchorSummarySchema.omit({ createdAt: true, updatedAt: true }).parse(input);
  checkTopicAddress(parsed);
  const inScope = anchors.filter((anchor) => sameThreadScope(anchor, parsed));
  const existing = inScope.find(({ topicKey }) => topicKey === parsed.topicKey);
  requireMatchingAnchor(existing, parsed);

  const rootMessageId = existing?.rootMessageId ?? parsed.rootMessageId;
  const messageKey = rootMessageId ? `msg:${rootMessageId}` : undefined;
  const firstMessage = inScope.find(({ topicKey }) => topicKey === messageKey);
  const now = new Date().toISOString();
  if (parsed.topicKey === messageKey) {
    const refreshed = refreshBoundAnchors(anchors, inScope, parsed, now);
    if (refreshed) return refreshed;
  }
  const rootSource = firstMessage ?? findBoundRoot(inScope, rootMessageId);
  const anchor = buildAnchor(parsed, existing, rootSource, now);
  const removedMessageKey = parsed.topicKey.startsWith("task:") ? messageKey : undefined;
  const retained = anchors.filter(
    (item) => item !== existing && (!removedMessageKey || item !== firstMessage),
  );
  return { anchor, removedMessageKey, anchors: retainAnchors([...retained, anchor]) };
}

export function requireMatchingAnchor(
  existing: TopicAnchorSummary | undefined,
  parsed: TopicAddress,
) {
  if (
    existing?.rootMessageId &&
    parsed.rootMessageId &&
    existing.rootMessageId !== parsed.rootMessageId
  )
    throw new Error("This topic already has a different first message.");
  if (existing?.taskId && parsed.taskId && existing.taskId !== parsed.taskId)
    throw new Error("This topic already belongs to a different task.");
}

function refreshBoundAnchors(
  anchors: TopicAnchorSummary[],
  inScope: TopicAnchorSummary[],
  input: TopicAnchorInput,
  now: string,
) {
  const bound = inScope.filter(
    (anchor) => anchor.taskId && anchor.rootMessageId === input.rootMessageId,
  );
  if (!bound.length) return;
  const refreshed = bound.map((anchor) => ({
    ...anchor,
    rootPromptText: input.rootPromptText || anchor.rootPromptText,
    imageAttachments: input.imageAttachments ?? anchor.imageAttachments,
    updatedAt: now,
  }));
  return {
    anchor: refreshed.at(-1)!,
    removedMessageKey: undefined,
    anchors: retainAnchors([...anchors.filter((anchor) => !bound.includes(anchor)), ...refreshed]),
  };
}

function findBoundRoot(inScope: TopicAnchorSummary[], rootMessageId: string | undefined) {
  if (!rootMessageId) return;
  return inScope.find(
    (anchor) =>
      anchor.rootMessageId === rootMessageId &&
      (anchor.imageAttachments?.length ||
        (anchor.rootPromptText && anchor.rootPromptText !== anchor.title)),
  );
}

function mergeAttributedMessages(
  ...lists: readonly (readonly TopicMessageAttribution[] | undefined)[]
): TopicMessageAttribution[] | undefined {
  const byId = new Map<string, TopicMessageAttribution>();
  for (const list of lists) {
    if (!list) continue;
    for (const entry of list) {
      byId.set(entry.sourceMessageId, entry);
    }
  }
  return byId.size > 0 ? [...byId.values()] : undefined;
}

function pickAnchorMetadata(
  parsed: TopicAnchorInput,
  existing: TopicAnchorSummary | undefined,
  firstMessage: TopicAnchorSummary | undefined,
  now: string,
) {
  return {
    rootMessageId: existing?.rootMessageId ?? parsed.rootMessageId,
    rootPromptText: selectRootPrompt(parsed, existing, firstMessage),
    imageAttachments:
      firstMessage?.imageAttachments ?? parsed.imageAttachments ?? existing?.imageAttachments,
    title: parsed.title ?? existing?.title,
    leadAgentId: parsed.leadAgentId ?? existing?.leadAgentId,
    leadServerId: parsed.leadServerId ?? existing?.leadServerId,
    leadTitle: parsed.leadTitle ?? existing?.leadTitle,
    createdAt: existing?.createdAt ?? firstMessage?.createdAt ?? now,
    updatedAt: now,
  };
}

function buildAnchor(
  parsed: TopicAnchorInput,
  existing: TopicAnchorSummary | undefined,
  firstMessage: TopicAnchorSummary | undefined,
  now: string,
): TopicAnchorSummary {
  const attributedMessages = mergeAttributedMessages(
    firstMessage?.attributedMessages,
    existing?.attributedMessages,
    parsed.attributedMessages,
  );
  const anchor: TopicAnchorSummary = {
    ...existing,
    ...parsed,
    taskId: parsed.taskId,
    ...pickAnchorMetadata(parsed, existing, firstMessage, now),
  };
  if (attributedMessages) anchor.attributedMessages = attributedMessages;
  return anchor;
}

function selectRootPrompt(
  input: TopicAnchorInput,
  existing: TopicAnchorSummary | undefined,
  firstMessage: TopicAnchorSummary | undefined,
): string {
  if (firstMessage?.rootPromptText) return firstMessage.rootPromptText;
  if (existing?.rootPromptText && existing.rootPromptText !== existing.title)
    return existing.rootPromptText;
  return input.rootPromptText || existing?.rootPromptText || "";
}

function retainAnchors(anchors: TopicAnchorSummary[]): TopicAnchorSummary[] {
  return anchors.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(-TOPIC_ANCHOR_LIMIT);
}

export function topicAnchorInput(
  address: TopicAddress,
  task?: Pick<TopicAnchorInput, "title" | "leadAgentId" | "leadServerId">,
  rootPromptPreview?: string,
  imageAttachments?: TopicAnchorInput["imageAttachments"],
): TopicAnchorInput {
  return {
    workspaceId: address.workspaceId,
    mainAgentId: address.mainAgentId,
    topicKey: address.topicKey,
    taskId: address.taskId,
    rootMessageId: address.rootMessageId,
    rootPromptText: rootPromptPreview?.trim() || task?.title || "",
    ...(imageAttachments?.length ? { imageAttachments } : {}),
    title: task?.title,
    leadAgentId: task?.leadAgentId,
    leadServerId: task?.leadServerId,
  };
}

function indexVisibleQuestions(
  rows: readonly AgentTimelineRow[],
  followupMessageIds: ReadonlySet<string>,
) {
  const questions = new Map<
    string,
    Pick<Extract<AgentTimelineRow["item"], { type: "user_message" }>, "text" | "imageAttachments">
  >();
  const questionRootsByAlias = new Map<string, string>();
  for (const row of rows) {
    if (row.item.type !== "user_message") continue;
    for (const item of projectAgentMessages(row.item)) {
      if (
        item.type !== "user_message" ||
        (!item.text.trim() && !item.forkContext && !item.imageAttachments?.length)
      )
        continue;
      const ids = [item.messageId, item.clientMessageId, row.providerMessageId];
      if (ids.some((id) => id && followupMessageIds.has(id))) continue;
      const root = item.messageId || item.clientMessageId || legacyQuestionId(row);
      if (!questions.has(root)) questions.set(root, item);
      for (const id of ids) {
        if (id && !questionRootsByAlias.has(id)) questionRootsByAlias.set(id, root);
      }
    }
  }
  return { questions, questionRootsByAlias };
}

export function topicAnchorsBeforeReset(
  scope: Pick<TopicAddress, "workspaceId" | "mainAgentId">,
  rows: readonly AgentTimelineRow[],
  tasks: readonly WorkspaceTask[],
  existing: readonly TopicAnchorSummary[],
  followupMessageIds: ReadonlySet<string>,
): TopicAnchorInput[] {
  const { questions, questionRootsByAlias } = indexVisibleQuestions(rows, followupMessageIds);
  const anchoredRoots = new Set(existing.map((anchor) => anchor.rootMessageId));
  const required = new Map<string, TopicAnchorInput>();
  const boundRoots = new Set<string>();
  for (const task of tasks) {
    const { rootMessageId, taskId } = task;
    if (!rootMessageId) continue;
    const visibleRoot = questions.has(rootMessageId)
      ? rootMessageId
      : questionRootsByAlias.get(rootMessageId);
    if (
      !visibleRoot &&
      !anchoredRoots.has(rootMessageId) &&
      !task.participants.some((participant) => participant.boundBy === scope.mainAgentId)
    )
      continue;
    if (visibleRoot) boundRoots.add(visibleRoot);
    const address = { ...scope, topicKey: `task:${taskId}`, taskId, rootMessageId };
    const question = visibleRoot ? questions.get(visibleRoot) : undefined;
    required.set(
      address.topicKey,
      topicAnchorInput(address, task, question?.text, question?.imageAttachments),
    );
  }
  for (const [rootMessageId, { text, imageAttachments }] of questions) {
    if (boundRoots.has(rootMessageId)) continue;
    const bound = existing.filter(
      (anchor) => anchor.taskId && anchor.rootMessageId === rootMessageId,
    );
    if (bound.length) {
      for (const anchor of bound) {
        required.set(
          anchor.topicKey,
          topicAnchorInput(anchor, anchor, text || anchor.rootPromptText, imageAttachments),
        );
      }
      continue;
    }
    const address = { ...scope, topicKey: `msg:${rootMessageId}`, rootMessageId };
    required.set(address.topicKey, topicAnchorInput(address, undefined, text, imageAttachments));
  }
  return [...required.values()];
}

function legacyQuestionId(row: AgentTimelineRow): string {
  // Some legacy providers never emitted a message ID. The original row provides
  // an identity that survives a rejected reset and its retry.
  const digest = createHash("sha256")
    .update(row.timestamp)
    .update(JSON.stringify(row.item))
    .digest("hex");
  return `legacy-question:${row.seq}:${digest}`;
}
