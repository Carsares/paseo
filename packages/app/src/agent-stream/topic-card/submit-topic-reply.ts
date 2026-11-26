import type { QueuedTopicReply } from "@/composer/actions";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceTaskSummary } from "@getpaseo/protocol/messages";
import type { QueryClient } from "@tanstack/react-query";
import { composePromptTextWithQuotes, createQuoteAttachment } from "@/attachments/quote";
import {
  resolveComposerAttachmentSubmitFormat,
  splitComposerAttachmentsForSubmit,
} from "@/composer/attachments/submit";
import type { MessagePayload } from "@/composer/types";
import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { ActiveTopicReplyTarget } from "@/stores/topic-stream-view-store";
import { decideWorkspaceTopicOnHost, replyToWorkspaceTopic } from "@/topic-threads/queries";
import { generateMessageId } from "@/types/stream";
import { encodeImages } from "@/utils/encode-images";

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function buildSubmissionSignature(
  trimmedText: string,
  routeMode: string,
  attachments: MessagePayload["attachments"],
): string {
  const attachmentKeys = attachments.map((item) => {
    if (item.kind === "file") return `file:${item.attachment.id}`;
    if (item.kind === "image") return `image:${item.metadata.id}`;
    if (item.kind === "quote") return `quote:${item.id}`;
    if (item.kind === "workspace_file") return `wf:${item.path}`;
    return item.kind;
  });
  return `${trimmedText}\0${routeMode}\0${attachmentKeys.join(",")}`;
}

async function encodeTopicImages(
  images: ReturnType<typeof splitComposerAttachmentsForSubmit>["images"],
) {
  const encoded = await encodeImages(images);
  // The shared encoder omits failed items. Only a complete batch preserves the source order.
  if (images.length > 0 && encoded?.length !== images.length) {
    throw new Error(i18n.t("topicWorkbench.topicStream.imageEncodingFailed"));
  }
  return encoded ?? [];
}

async function uploadInlineImagesForTopicReply(
  client: DaemonClient,
  images: ReturnType<typeof splitComposerAttachmentsForSubmit>["images"],
) {
  const uploaded = [];
  const encodedImages = await encodeTopicImages(images);
  for (const [i, encoded] of encodedImages.entries()) {
    const meta = images[i];
    const ext = encoded.mimeType.split("/")[1] ?? "png";
    const response = await client.uploadFile({
      fileName: meta?.fileName?.trim() || `image-${meta?.id ?? i}.${ext}`,
      mimeType: encoded.mimeType,
      bytes: decodeBase64ToBytes(encoded.data),
    });
    if (response.error || !response.file) {
      throw new Error(response.error ?? "Upload failed.");
    }
    uploaded.push(response.file);
  }
  return uploaded;
}

async function sendLegacyQuotedTopicReply(input: {
  client: DaemonClient;
  agentId: string;
  activeReplyTopic: ActiveTopicReplyTarget;
  payload: MessagePayload;
  format: ReturnType<typeof resolveComposerAttachmentSubmitFormat>;
  clientMessageId: string;
}): Promise<boolean> {
  const { client, agentId, activeReplyTopic, payload, format, clientMessageId } = input;
  const topicQuote = createQuoteAttachment({
    text: activeReplyTopic.promptPreview || activeReplyTopic.topicKey,
    label: activeReplyTopic.leadTitle || activeReplyTopic.topicKey,
  });
  const combinedAttachments = topicQuote.text
    ? [topicQuote, ...payload.attachments]
    : payload.attachments;
  const quotedText = composePromptTextWithQuotes(payload.text, combinedAttachments);
  const legacyWire = splitComposerAttachmentsForSubmit(combinedAttachments, { format });
  const imagesData = await encodeTopicImages(legacyWire.images);
  await client.sendAgentMessage(agentId, quotedText, {
    messageId: clientMessageId,
    images: imagesData,
    attachments: legacyWire.attachments,
  });
  return true;
}

export class TopicDecisionStaleQuestionError extends Error {
  readonly errorCode = "stale_blocking_question";
  readonly latestTask: WorkspaceTaskSummary | null;

  constructor(message: string, latestTask: WorkspaceTaskSummary | null) {
    super(message);
    this.name = "TopicDecisionStaleQuestionError";
    this.latestTask = latestTask;
  }
}

export function assertTopicDecisionAttachments(attachments: MessagePayload["attachments"]) {
  if (attachments.some((attachment) => attachment.kind !== "quote")) {
    throw new Error(i18n.t("topicWorkbench.topicStream.decisionAttachmentsUnsupported"));
  }
}

async function submitBlockingDecisionReply(input: {
  queryClient: QueryClient;
  serverId: string;
  workspaceId: string;
  agentId: string;
  activeReplyTopic: ActiveTopicReplyTarget;
  payload: MessagePayload;
  clientMessageId: string;
}): Promise<boolean> {
  assertTopicDecisionAttachments(input.payload.attachments);
  const note = composePromptTextWithQuotes(input.payload.text, input.payload.attachments).trim();
  if (!note) return false;
  const response = await decideWorkspaceTopicOnHost({
    queryClient: input.queryClient,
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    mainAgentId: input.agentId,
    topicKey: input.activeReplyTopic.topicKey,
    taskId: input.activeReplyTopic.decisionContext?.taskId ?? input.activeReplyTopic.taskId,
    rootMessageId: input.activeReplyTopic.rootMessageId,
    clientMessageId: input.clientMessageId,
    resolutionKind: "task_blocking_question",
    expectedBlockingQuestionGeneration:
      input.activeReplyTopic.decisionContext?.blockingQuestionGeneration,
    note,
  });
  if (response.errorCode === "stale_blocking_question") {
    throw new TopicDecisionStaleQuestionError(
      response.error ?? "The blocking question changed.",
      response.task,
    );
  }
  if (response.accepted === false || response.error) {
    throw new Error(response.error ?? "Failed to submit decision.");
  }
  return true;
}

interface TopicSubmissionIntent {
  signature: string;
  clientMessageId: string;
}

const draftIntents = new Map<string, TopicSubmissionIntent>();

function describeTopicSubmission(target: ActiveTopicReplyTarget, payload: MessagePayload) {
  const trimmed = payload.text.trim();
  const directToMain = trimmed.startsWith("@主控") || trimmed.startsWith("@main");
  const route = directToMain ? "main" : target.routeMode;
  const signature = buildSubmissionSignature(
    trimmed,
    target.decisionContext
      ? `decision:${target.decisionContext.blockingQuestionGeneration ?? ""}`
      : route,
    payload.attachments,
  );
  return { route, signature };
}

function getTopicSubmissionId(target: ActiveTopicReplyTarget, signature: string) {
  return target.pendingSubmissionSignature === signature && target.pendingClientMessageId
    ? target.pendingClientMessageId
    : generateMessageId();
}

export function rememberTopicSubmission(
  draftKey: string,
  target: ActiveTopicReplyTarget,
  payload: MessagePayload,
): string {
  const { signature } = describeTopicSubmission(target, payload);
  const saved = draftIntents.get(draftKey);
  if (saved?.signature === signature) return saved.clientMessageId;
  const clientMessageId = getTopicSubmissionId(target, signature);
  draftIntents.set(draftKey, { signature, clientMessageId });
  return clientMessageId;
}

export function finishTopicSubmission(draftKey: string, clientMessageId: string) {
  if (draftIntents.get(draftKey)?.clientMessageId === clientMessageId) {
    draftIntents.delete(draftKey);
  }
}

export async function submitActiveTopicReply(input: {
  queryClient: QueryClient;
  serverId: string;
  workspaceId: string;
  agentId: string;
  activeReplyTopic: ActiveTopicReplyTarget;
  payload: MessagePayload;
  supportsTopicThreads: boolean;
  supportsButlerV1?: boolean;
  supportsForgeAttachments: boolean;
  disconnectedMessage: string;
  /** Persists the allocated idempotency key on the active draft intent so retries reuse it. */
  onPersistSubmissionIntent?: (signature: string, clientMessageId: string) => void;
  clientMessageId?: string;
}): Promise<boolean> {
  const {
    queryClient,
    serverId,
    workspaceId,
    agentId,
    activeReplyTopic,
    payload,
    supportsTopicThreads,
    supportsButlerV1 = false,
    supportsForgeAttachments,
    disconnectedMessage,
    onPersistSubmissionIntent,
  } = input;
  const format = resolveComposerAttachmentSubmitFormat({ supportsForgeAttachments });
  const composedText = composePromptTextWithQuotes(payload.text, payload.attachments).trim();
  const baseWire = splitComposerAttachmentsForSubmit(payload.attachments, { format });
  if (!composedText && baseWire.attachments.length === 0 && baseWire.images.length === 0) {
    return false;
  }

  const { route: effectiveRouteMode, signature } = describeTopicSubmission(
    activeReplyTopic,
    payload,
  );
  const clientMessageId =
    input.clientMessageId ?? getTopicSubmissionId(activeReplyTopic, signature);
  onPersistSubmissionIntent?.(signature, clientMessageId);

  if (activeReplyTopic.decisionContext && supportsButlerV1) {
    return submitBlockingDecisionReply({
      queryClient,
      serverId,
      workspaceId,
      agentId,
      activeReplyTopic,
      payload,
      clientMessageId,
    });
  }

  const runtimeSnapshot = getHostRuntimeStore().getSnapshot(serverId);
  const client = runtimeSnapshot?.connectionStatus === "online" ? runtimeSnapshot.client : null;

  if (!supportsTopicThreads) {
    if (!client) throw new Error(disconnectedMessage);
    return sendLegacyQuotedTopicReply({
      client,
      agentId,
      activeReplyTopic,
      payload,
      format,
      clientMessageId,
    });
  }

  const attachmentsToSend = [...baseWire.attachments];
  if (baseWire.images.length > 0) {
    if (!client) throw new Error(disconnectedMessage);
    const uploaded = await uploadInlineImagesForTopicReply(client, baseWire.images);
    attachmentsToSend.push(...uploaded);
  }

  await replyToWorkspaceTopic({
    queryClient,
    serverId,
    workspaceId,
    mainAgentId: agentId,
    topicKey: activeReplyTopic.topicKey,
    taskId: activeReplyTopic.taskId,
    rootMessageId: activeReplyTopic.rootMessageId,
    rootPromptPreview: activeReplyTopic.promptPreview || undefined,
    clientMessageId,
    text: composedText || "[attachment]",
    routeMode: effectiveRouteMode,
    attachments: attachmentsToSend,
  });
  return true;
}

export async function deliverQueuedTopicReply(input: {
  queryClient: QueryClient;
  serverId: string;
  agentId: string;
  topicReply: QueuedTopicReply;
  payload: MessagePayload;
  supportsTopicThreads: boolean;
  supportsButlerV1: boolean;
  supportsForgeAttachments: boolean;
}) {
  const { topicReply, ...scope } = input;
  const sent = await submitActiveTopicReply({
    ...scope,
    workspaceId: topicReply.workspaceId,
    activeReplyTopic: topicReply.target,
    clientMessageId: topicReply.clientMessageId,
    disconnectedMessage: i18n.t("workspace.terminal.hostDisconnected"),
  });
  if (!sent) throw new Error(i18n.t("composer.errors.failedToSend"));
}
