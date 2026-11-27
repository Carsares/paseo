import { memo, useCallback, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { EdgeFade } from "@/components/ui/edge-fade";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isWeb } from "@/constants/platform";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { useStreamTopOverlayInset } from "../top-overlay";
import type { ActivePromptSource, ChatOutlinePrompt } from "./model";

const ThemedChevronUp = withUnistyles(ChevronUp, (theme) => ({
  color: theme.colors.foreground,
  size: theme.iconSize.sm,
}));
const ThemedChevronDown = withUnistyles(ChevronDown, (theme) => ({
  color: theme.colors.foreground,
  size: theme.iconSize.sm,
}));

const OVERLAY_DATASET = { activePromptOverlay: "true" };
// On web the prompt bar and the find widget share the same transcript wrapper.
const HIDE_DURING_CHAT_FIND =
  "[data-active-prompt-overlay]:has(~ [data-chat-find-widget]) { display: none; }";

interface ActivePromptBarProps {
  prompts: readonly ChatOutlinePrompt[];
  activePrompt: ActivePromptSource;
  contentMaxWidth: number | undefined;
  onJumpToPrompt: (seq: number) => void;
}

export const ActivePromptBar = memo(function ActivePromptBar({
  prompts,
  activePrompt,
  contentMaxWidth,
  onJumpToPrompt,
}: ActivePromptBarProps) {
  const readingState = useSyncExternalStore(activePrompt.subscribe, activePrompt.getReadingState);
  const topOverlayInset = useStreamTopOverlayInset();
  const { i18n } = useTranslation();

  const activeIndex = readingState.isPromptScrolledAbove
    ? prompts.findIndex((prompt) => prompt.seq === readingState.activeSeq)
    : -1;
  const currentPrompt = prompts[activeIndex];
  const currentSeq = currentPrompt?.seq;
  const previousSeq = prompts[activeIndex - 1]?.seq;
  const nextSeq = prompts[activeIndex + 1]?.seq;
  const jumpCurrent = useCallback(() => {
    if (currentSeq !== undefined) onJumpToPrompt(currentSeq);
  }, [currentSeq, onJumpToPrompt]);
  const jumpPrevious = useCallback(() => {
    if (previousSeq !== undefined) onJumpToPrompt(previousSeq);
  }, [previousSeq, onJumpToPrompt]);
  const jumpNext = useCallback(() => {
    if (nextSeq !== undefined) onJumpToPrompt(nextSeq);
  }, [nextSeq, onJumpToPrompt]);

  if (!currentPrompt) return null;
  const isChinese = i18n.language?.startsWith("zh");
  const count = `${activeIndex + 1}/${prompts.length}`;
  const countLabel = isChinese ? `第 ${count} 问` : `Prompt ${count}`;

  return (
    <View
      pointerEvents="box-none"
      dataSet={isWeb ? OVERLAY_DATASET : undefined}
      style={[styles.overlay, inlineUnistylesStyle({ top: topOverlayInset })]}
    >
      {isWeb ? <style>{HIDE_DURING_CHAT_FIND}</style> : null}
      {isWeb ? (
        <>
          <View pointerEvents="none" style={styles.backdrop} />
          <EdgeFade edge="top" solidFraction={0} backdrop="surface0" style={styles.backdropFade} />
        </>
      ) : null}
      <View
        testID="active-prompt-bar"
        style={[styles.card, inlineUnistylesStyle({ maxWidth: contentMaxWidth })]}
      >
        <PressHighlight
          testID="active-prompt-bar-jump-current"
          accessibilityRole="button"
          accessibilityLabel={`${countLabel}: ${currentPrompt.preview}`}
          accessibilityHint={isChinese ? "跳到当前提问" : "Jump to current prompt"}
          style={styles.jump}
          highlightStyle={styles.highlight}
          onPress={jumpCurrent}
        >
          <Text style={styles.count}>{countLabel}</Text>
          <Text style={styles.preview} numberOfLines={1} ellipsizeMode="tail">
            {currentPrompt.preview}
          </Text>
        </PressHighlight>
        <ToolbarButton
          compact
          testID="active-prompt-bar-prev"
          label={isChinese ? "上一问" : "Previous prompt"}
          disabled={previousSeq === undefined}
          onPress={jumpPrevious}
        >
          <ThemedChevronUp />
        </ToolbarButton>
        <ToolbarButton
          compact
          testID="active-prompt-bar-next"
          label={isChinese ? "下一问" : "Next prompt"}
          disabled={nextSeq === undefined}
          onPress={jumpNext}
        >
          <ThemedChevronDown />
        </ToolbarButton>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    paddingTop: theme.spacing[2],
    paddingBottom: isWeb ? theme.spacing[2] : 0,
    paddingHorizontal: theme.spacing[3],
    zIndex: 3,
  },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.colors.surface0,
  },
  backdropFade: {
    position: "absolute",
    top: "100%",
    left: 0,
    right: 0,
    height: theme.spacing[6],
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.accentBright,
    borderRadius: theme.borderRadius.lg,
    paddingRight: theme.spacing[1],
    overflow: "hidden",
    ...theme.shadow.sm,
  },
  jump: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  highlight: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  count: {
    color: theme.colors.accentBright,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 0,
  },
  preview: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flex: 1,
    minWidth: 0,
  },
}));
