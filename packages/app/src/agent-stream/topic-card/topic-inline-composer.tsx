import type { TopicReplyRouteMode } from "@getpaseo/protocol/messages";
import { MessageSquareReply, Send } from "lucide-react-native";
import { memo, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { generateMessageId } from "@/types/stream";

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedReplyIcon = withUnistyles(MessageSquareReply, mutedIconMapping);
const ThemedSend = withUnistyles(Send, mutedIconMapping);

export interface TopicInlineComposerProps {
  topicKey: string;
  leadTitle?: string;
  hasLeadAgent: boolean;
  isSubmitting?: boolean;
  /** Returns true only when the message was accepted; false/reject preserves the user's draft and clientMessageId. */
  onSubmitDesktopReply: (
    text: string,
    routeMode: TopicReplyRouteMode,
    clientMessageId: string,
  ) => Promise<boolean> | boolean;
  onActivateCompactReply: (routeMode: TopicReplyRouteMode) => void;
}

export const TopicInlineComposer = memo(function TopicInlineComposer({
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
  const [text, setText] = useState("");
  const [inputResetKey, setInputResetKey] = useState(0);
  const [routeMode, setRouteMode] = useState<TopicReplyRouteMode>("auto");
  const pendingClientMessageIdRef = useRef<string | null>(null);
  const pendingSubmissionKeyRef = useRef<string | null>(null);

  const effectiveTargetLabel =
    routeMode === "main" || !hasLeadAgent
      ? t("topicWorkbench.topicStream.replyToMain")
      : t("topicWorkbench.topicStream.replyToLead", {
          name: leadTitle?.trim() || t("topicWorkbench.topicStream.leadFallbackName"),
        });

  const handleChangeText = useCallback((next: string) => {
    setText(next);
    if (pendingSubmissionKeyRef.current !== null) {
      const currentTrimmed = next.trim();
      if (!pendingSubmissionKeyRef.current.startsWith(`${currentTrimmed}\0`)) {
        pendingClientMessageIdRef.current = null;
        pendingSubmissionKeyRef.current = null;
      }
    }
  }, []);

  const toggleRouteMode = useCallback(() => {
    pendingClientMessageIdRef.current = null;
    pendingSubmissionKeyRef.current = null;
    setRouteMode((current) => (current === "main" ? "auto" : "main"));
  }, []);

  const handleOpenCompact = useCallback(() => {
    onActivateCompactReply(routeMode);
  }, [onActivateCompactReply, routeMode]);

  const handleExpandDesktop = useCallback(() => {
    setExpanded(true);
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || isSubmitting) return;
    const explicitMain = trimmed.startsWith("@主控") || trimmed.startsWith("@main");
    const effectiveMode: TopicReplyRouteMode = explicitMain ? "main" : routeMode;
    const submissionKey = `${trimmed}\0${effectiveMode}`;
    if (!pendingClientMessageIdRef.current || pendingSubmissionKeyRef.current !== submissionKey) {
      pendingClientMessageIdRef.current = generateMessageId();
      pendingSubmissionKeyRef.current = submissionKey;
    }
    const clientMessageId = pendingClientMessageIdRef.current;
    let succeeded = false;
    try {
      succeeded = (await onSubmitDesktopReply(trimmed, effectiveMode, clientMessageId)) === true;
    } catch {
      succeeded = false;
    }
    if (succeeded) {
      pendingClientMessageIdRef.current = null;
      pendingSubmissionKeyRef.current = null;
      setText("");
      setInputResetKey((k) => k + 1);
    }
  }, [isSubmitting, onSubmitDesktopReply, routeMode, text]);

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

  if (!expanded) {
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
      <View style={styles.inputRow}>
        <AdaptiveTextInput
          initialValue=""
          resetKey={inputResetKey}
          onChangeText={handleChangeText}
          placeholder={t("topicWorkbench.topicStream.replyPlaceholder")}
          style={styles.textInput}
          onSubmitEditing={handleTriggerSend}
          returnKeyType="send"
          editable={!isSubmitting}
          testID={`topic-inline-reply-input-${topicKey}`}
        />
        <Button
          size="sm"
          variant="default"
          disabled={isSubmitting || text.trim().length === 0}
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
