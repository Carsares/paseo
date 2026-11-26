import type { TopicReplyRouteMode } from "@getpaseo/protocol/messages";
import { MessageSquareReply, Paperclip, Send, X } from "lucide-react-native";
import { memo, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { persistAttachmentFromBytes } from "@/attachments/service";
import { FILE_UPLOAD_MAX_BYTES } from "@/attachments/upload-limit";
import type { UserComposerAttachment } from "@/attachments/types";
import { uploadFileAttachments } from "@/composer/actions";
import { useFilePicker } from "@/hooks/use-file-picker";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  buildTopicReplyDraftKey,
  EMPTY_TOPIC_REPLY_DRAFT,
  useTopicStreamViewStore,
} from "@/stores/topic-stream-view-store";
import { finishTopicSubmission, rememberTopicSubmission } from "./submit-topic-reply";

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedReplyIcon = withUnistyles(MessageSquareReply, mutedIconMapping);
const ThemedPaperclip = withUnistyles(Paperclip, mutedIconMapping);
const ThemedRemove = withUnistyles(X, mutedIconMapping);
type InlineReplyAttachment = Extract<UserComposerAttachment, { kind: "image" | "file" }>;

function InlineAttachmentRow({
  attachment,
  disabled,
  onRemove,
}: {
  attachment: InlineReplyAttachment;
  disabled: boolean;
  onRemove: (attachment: InlineReplyAttachment) => void;
}) {
  const { t } = useTranslation();
  const name =
    attachment.kind === "image"
      ? attachment.metadata.fileName || attachment.metadata.id
      : attachment.attachment.fileName;
  const handleRemove = useCallback(() => onRemove(attachment), [attachment, onRemove]);
  return (
    <View style={styles.editorHeader}>
      <Text style={styles.targetChip} numberOfLines={1}>
        {name}
      </Text>
      <Button
        size="sm"
        variant="ghost"
        accessibilityLabel={t("topicWorkbench.topicStream.removeReplyAttachment", { name })}
        disabled={disabled}
        onPress={handleRemove}
      >
        <ThemedRemove size={13} />
      </Button>
    </View>
  );
}

const ThemedSend = withUnistyles(Send, mutedIconMapping);

export interface TopicInlineComposerProps {
  agentKey: string;
  serverId?: string;
  workspaceId?: string;
  topicKey: string;
  leadTitle?: string;
  hasLeadAgent: boolean;
  isSubmitting?: boolean;
  /** Returns true only when the message was accepted; false/reject preserves the user's draft and clientMessageId. */
  onSubmitDesktopReply: (
    text: string,
    routeMode: TopicReplyRouteMode,
    clientMessageId: string,
    attachments?: UserComposerAttachment[],
  ) => Promise<boolean> | boolean;
  onActivateCompactReply: (routeMode: TopicReplyRouteMode) => void;
}

export const TopicInlineComposer = memo(function TopicInlineComposer({
  agentKey,
  serverId,
  workspaceId,
  topicKey,
  leadTitle,
  hasLeadAgent,
  isSubmitting = false,
  onSubmitDesktopReply,
  onActivateCompactReply,
}: TopicInlineComposerProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [expanded, setExpanded] = useState(false);
  const draftKey = buildTopicReplyDraftKey({
    serverId: serverId ?? "",
    workspaceId: workspaceId ?? "",
    agentId: agentKey,
    topicKey,
  });
  const draft = useTopicStreamViewStore(
    (state) => state.inlineReplyDrafts[draftKey] ?? EMPTY_TOPIC_REPLY_DRAFT,
  );
  const updateDraft = useTopicStreamViewStore((state) => state.updateInlineReplyDraft);
  const { text, routeMode, attachments } = draft;
  const [inputResetKey, setInputResetKey] = useState(0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isPicking, setIsPicking] = useState(false);
  const submitting = useRef(false);
  const [isSending, setIsSending] = useState(false);
  const isEditorLocked = isSubmitting || isSending;
  const { pickFiles } = useFilePicker();
  const client = useHostRuntimeClient(serverId ?? "");
  const hasContent = text.trim().length > 0 || attachments.length > 0;

  const effectiveTargetLabel =
    routeMode === "main" || !hasLeadAgent
      ? t("topicWorkbench.topicStream.replyToMain")
      : t("topicWorkbench.topicStream.replyToLead", {
          name: leadTitle?.trim() || t("topicWorkbench.topicStream.leadFallbackName"),
        });

  const handleChangeText = useCallback(
    (next: string) => {
      if (isSubmitting || submitting.current) return;
      updateDraft(draftKey, (current) => ({ ...current, text: next }));
    },
    [draftKey, isSubmitting, updateDraft],
  );

  const toggleRouteMode = useCallback(() => {
    if (isSubmitting || submitting.current) return;
    updateDraft(draftKey, (current) => ({
      ...current,
      routeMode: current.routeMode === "main" ? "auto" : "main",
    }));
  }, [draftKey, isSubmitting, updateDraft]);

  const addAttachments = useCallback(async () => {
    if (isSubmitting || isPicking || submitting.current) return;
    setIsPicking(true);
    setAttachmentError(null);
    try {
      const files = await pickFiles();
      if (!files?.length) return;
      for (const file of files) {
        let attachment: UserComposerAttachment;
        if (file.mimeType.startsWith("image/")) {
          const bytes = await file.readBytes();
          if (bytes.byteLength > FILE_UPLOAD_MAX_BYTES) {
            throw new Error(
              t("composer.errors.fileTooLarge", { size: "50MB", fileName: file.fileName }),
            );
          }
          const metadata = await persistAttachmentFromBytes({
            bytes,
            mimeType: file.mimeType,
            fileName: file.fileName,
          });
          attachment = { kind: "image", metadata };
        } else {
          if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
          const [uploaded] = await uploadFileAttachments({ client, files: [file] });
          if (!uploaded) continue;
          attachment = uploaded;
        }
        updateDraft(draftKey, (current) => ({
          ...current,
          attachments: [...current.attachments, attachment],
        }));
      }
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : t("composer.errors.uploadFailed"),
      );
    } finally {
      setIsPicking(false);
    }
  }, [client, draftKey, isPicking, isSubmitting, pickFiles, t, updateDraft]);

  const handleOpenCompact = useCallback(() => {
    onActivateCompactReply(routeMode);
  }, [onActivateCompactReply, routeMode]);

  const handleExpandDesktop = useCallback(() => {
    setExpanded(true);
  }, []);

  const handleSend = useCallback(async () => {
    if (!hasContent || isSubmitting || isPicking || submitting.current) return;
    const trimmed = text.trim();
    const explicitMain = trimmed.startsWith("@主控") || trimmed.startsWith("@main");
    const effectiveMode: TopicReplyRouteMode = explicitMain ? "main" : routeMode;
    const clientMessageId = rememberTopicSubmission(
      draftKey,
      { topicKey, routeMode: effectiveMode, promptPreview: "" },
      { text: trimmed, attachments, cwd: "" },
    );
    submitting.current = true;
    setIsSending(true);
    try {
      const succeeded = await onSubmitDesktopReply(
        trimmed,
        effectiveMode,
        clientMessageId,
        attachments,
      );
      if (succeeded) {
        finishTopicSubmission(draftKey, clientMessageId);
        updateDraft(draftKey, (current) =>
          current === draft ? { ...current, text: "", attachments: [] } : current,
        );
        setInputResetKey((key) => key + 1);
      }
    } catch {
      // The submit owner reports the failure. Keep the original draft and submission ID.
    } finally {
      submitting.current = false;
      setIsSending(false);
    }
  }, [
    attachments,
    draft,
    draftKey,
    hasContent,
    isPicking,
    isSubmitting,
    onSubmitDesktopReply,
    routeMode,
    text,
    topicKey,
    updateDraft,
  ]);

  const removeAttachment = useCallback(
    (attachment: InlineReplyAttachment) => {
      if (isSubmitting || submitting.current) return;
      const keepAttachment = (item: UserComposerAttachment) => item !== attachment;
      updateDraft(draftKey, (current) => ({
        ...current,
        attachments: current.attachments.filter(keepAttachment),
      }));
    },
    [draftKey, isSubmitting, updateDraft],
  );

  const handleTriggerSend = useCallback(() => {
    void handleSend();
  }, [handleSend]);

  if (isCompact) {
    return (
      <PressHighlight
        accessibilityRole="button"
        onPress={handleOpenCompact}
        style={styles.compactTrigger}
        testID={`topic-inline-reply-compact-${topicKey}`}
      >
        <ThemedReplyIcon size={14} />
        <Text style={styles.compactPlaceholder} numberOfLines={1}>
          {t("topicWorkbench.topicStream.replyPlaceholder")}
        </Text>
        <Text style={styles.targetChip} numberOfLines={1}>
          {effectiveTargetLabel}
        </Text>
      </PressHighlight>
    );
  }

  if (!expanded && !hasContent) {
    return (
      <View style={styles.collapsedRow}>
        <PressHighlight
          accessibilityRole="button"
          onPress={handleExpandDesktop}
          style={styles.compactTrigger}
          testID={`topic-inline-reply-trigger-${topicKey}`}
        >
          <ThemedReplyIcon size={14} />
          <Text style={styles.compactPlaceholder} numberOfLines={1}>
            {t("topicWorkbench.topicStream.replyPlaceholder")}
          </Text>
          <Text style={styles.targetChip} numberOfLines={1}>
            {effectiveTargetLabel}
          </Text>
        </PressHighlight>
      </View>
    );
  }

  return (
    <View style={styles.expandedBox} testID={`topic-inline-reply-editor-${topicKey}`}>
      <View style={styles.editorHeader}>
        <Text style={styles.targetChip}>{effectiveTargetLabel}</Text>
        {hasLeadAgent ? (
          <PressHighlight
            accessibilityRole="button"
            disabled={isEditorLocked}
            onPress={toggleRouteMode}
            style={styles.routeToggle}
            testID={`topic-inline-route-toggle-${topicKey}`}
          >
            <Text style={styles.routeToggleText}>
              {routeMode === "main"
                ? t("topicWorkbench.topicStream.switchToAuto")
                : t("topicWorkbench.topicStream.switchToMain")}
            </Text>
          </PressHighlight>
        ) : null}
      </View>
      {attachments.map((attachment) => {
        if (attachment.kind !== "image" && attachment.kind !== "file") return null;
        const id = attachment.kind === "image" ? attachment.metadata.id : attachment.attachment.id;
        return (
          <InlineAttachmentRow
            key={id}
            attachment={attachment}
            disabled={isEditorLocked || isPicking}
            onRemove={removeAttachment}
          />
        );
      })}
      {attachmentError ? (
        <Text accessibilityRole="alert" style={styles.targetChip}>
          {attachmentError}
        </Text>
      ) : null}
      <View style={styles.inputRow}>
        <AdaptiveTextInput
          initialValue={text}
          resetKey={inputResetKey}
          onChangeText={handleChangeText}
          placeholder={t("topicWorkbench.topicStream.replyPlaceholder")}
          style={styles.textInput}
          onSubmitEditing={handleTriggerSend}
          returnKeyType="send"
          editable={!isEditorLocked}
          testID={`topic-inline-reply-input-${topicKey}`}
        />
        <Button
          size="sm"
          variant="ghost"
          accessibilityLabel={t("composer.attachments.addFile")}
          disabled={isEditorLocked || isPicking}
          onPress={addAttachments}
          testID={`topic-inline-reply-attach-${topicKey}`}
        >
          <ThemedPaperclip size={15} />
        </Button>
        <Button
          size="sm"
          variant="default"
          disabled={isEditorLocked || isPicking || !hasContent}
          onPress={handleTriggerSend}
          testID={`topic-inline-reply-send-${topicKey}`}
        >
          <ThemedSend size={13} />
          {t("topicWorkbench.topicStream.sendReply")}
        </Button>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  collapsedRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  compactTrigger: {
    flex: 1,
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  compactPlaceholder: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  targetChip: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  expandedBox: {
    gap: theme.spacing[1.5],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  editorHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  routeToggle: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  routeToggleText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  textInput: {
    flex: 1,
    minHeight: 32,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
}));
