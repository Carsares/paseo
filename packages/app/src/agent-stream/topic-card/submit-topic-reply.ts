import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceTaskSummary } from "@getpaseo/protocol/messages";
import type { QueryClient } from "@tanstack/react-query";
import { composePromptTextWithQuotes, createQuoteAttachment } from "@/attachments/quote";
import {
  resolveComposerAttachmentSubmitFormat,
  splitComposerAttachmentsForSubmit,
} from "@/composer/attachments/submit";
import type { MessagePayload } from "@/composer/types";
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

async function uploadInlineImagesForTopicReply(
  client: DaemonClient,
  images: ReturnType<typeof splitComposerAttachmentsForSubmit>["images"],
) {
  const uploaded = [];
  const encodedImages = await encodeImages(images);
  for (let i = 0; i < images.length; i += 1) {
    const encoded = encodedImages?.[i];
    if (!encoded) continue;
    const meta = images[i];
    const ext = encoded.mimeType.split("/")[1] ?? "png";
    const response = await client.uploadFile({
      fileName: `image-${meta?.id ?? i}.${ext}`,
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
  const imagesData = await encodeImages(legacyWire.images);
  await client.sendAgentMessage(agentId, quotedText, {
    messageId: clientMessageId,
    images: imagesData ?? [],
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

async function submitBlockingDecisionReply(input: {
  queryClient: QueryClient;
  serverId: string;
  workspaceId: string;
  agentId: string;
  activeReplyTopic: ActiveTopicReplyTarget;
  payload: MessagePayload;
  clientMessageId: string;
}): Promise<boolean> {
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

function resolveSubmissionClientMessageId(
  activeReplyTopic: ActiveTopicReplyTarget,
  signature: string,
  onPersistSubmissionIntent?: (signature: string, clientMessageId: string) => void,
): string {
  const clientMessageId =
    activeReplyTopic.pendingClientMessageId &&
    activeReplyTopic.pendingSubmissionSignature === signature
      ? activeReplyTopic.pendingClientMessageId
      : generateMessageId();
  onPersistSubmissionIntent?.(signature, clientMessageId);
  return clientMessageId;
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
  const trimmed = payload.text.trim();
  const baseWire = splitComposerAttachmentsForSubmit(payload.attachments, { format });
  if (!trimmed && baseWire.attachments.length === 0 && baseWire.images.length === 0) {
    return false;
  }

  const isDecisionReply = Boolean(activeReplyTopic.decisionContext);
  const explicitMain = trimmed.startsWith("@主控") || trimmed.startsWith("@main");
  const effectiveRouteMode = explicitMain ? "main" : activeReplyTopic.routeMode;
  const decisionRouteKey = `decision:${activeReplyTopic.decisionContext?.blockingQuestionGeneration ?? ""}`;
  const signature = buildSubmissionSignature(
    trimmed,
    isDecisionReply ? decisionRouteKey : effectiveRouteMode,
    payload.attachments,
  );
  const clientMessageId = resolveSubmissionClientMessageId(
    activeReplyTopic,
    signature,
    onPersistSubmissionIntent,
  );

  if (isDecisionReply && supportsButlerV1) {
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

  const composedText = composePromptTextWithQuotes(payload.text, payload.attachments).trim();
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
