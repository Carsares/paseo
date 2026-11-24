import { Quote } from "lucide-react-native";
import { memo, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { extractReplyQuoteSummary, extractScopedWebSelection } from "@/agent-stream/reply-quote";
import { useComposerQuote } from "@/assistant-selection-copy/composer-quote";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { isNative, isWeb } from "@/constants/platform";
import { ICON_SIZE, SPACING, type Theme } from "@/styles/theme";

const ThemedQuote = withUnistyles(Quote);
const mutedIconProps = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const TOUCH_HIT_SLOP = SPACING[2];
const STREAM_ROOT_SELECTOR = "[data-agent-stream-root]";

function resolveStreamScope(anchor: View | null): Element | null {
  if (!isWeb || typeof document === "undefined") return null;
  const element = anchor as unknown as Element | null;
  if (element && typeof element.closest === "function") {
    return element.closest(STREAM_ROOT_SELECTOR);
  }
  return null;
}

/**
 * The browser selection that lies inside the rows of this assistant turn within its own chat
 * stream container. Every row of a turn's reply carries its `data-message-id`, and a selection
 * across rows has all of them as its scope. Returns `null` if no stream root contains this button
 * so a selection in another pane or outside the chat is never accidentally captured.
 */
function readReplySelection(
  messageIds: readonly string[] | undefined,
  anchor: View | null,
): string | null {
  if (!isWeb || !messageIds || messageIds.length === 0) return null;
  const scope = resolveStreamScope(anchor);
  if (!scope) return null;
  const rows: HTMLElement[] = [];
  for (const messageId of messageIds) {
    if (!messageId) continue;
    rows.push(
      ...Array.from(
        scope.querySelectorAll<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`),
      ),
    );
  }
  if (rows.length === 0) return null;
  return extractScopedWebSelection(rows);
}

/**
 * Quotes an assistant reply into the composer: the selected text when the reader selected some
 * of the reply (web), otherwise a short summary of the whole reply. Renders nothing where no
 * composer accepts quotes, such as read-only panels.
 */
export const TurnQuoteReplyButton = memo(function TurnQuoteReplyButton({
  getContent,
  messageIds,
}: {
  getContent: () => string;
  /** The `data-message-id` values of the reply's rows, used to scope a web selection. */
  messageIds?: readonly string[];
}) {
  const { t } = useTranslation();
  const composerQuote = useComposerQuote();
  const hasText = useMemo(() => getContent().trim().length > 0, [getContent]);
  const anchorRef = useRef<View | null>(null);
  // Pressing the button can collapse the browser selection before `onPressIn` or `onPress`
  // fires. Capture once on pointerdown, ignore `onPressIn` during that same pointer press so an
  // empty post-collapse read never overwrites the captured selection, and keep the captured value
  // until the matching `onPress` consumes it, `onPointerCancel` cancels it, or a subsequent press
  // starts. Never clear via microtask in `onPressOut`: browsers flush microtasks between
  // `pointerup`/`mouseup` and `click`.
  const selectionAtPressStart = useRef<string | null>(null);
  const pointerCaptureActive = useRef(false);

  const captureOnPointerDown = useCallback(() => {
    pointerCaptureActive.current = true;
    selectionAtPressStart.current = readReplySelection(messageIds, anchorRef.current);
  }, [messageIds]);
  const captureOnPressIn = useCallback(() => {
    if (pointerCaptureActive.current) return;
    selectionAtPressStart.current = readReplySelection(messageIds, anchorRef.current);
  }, [messageIds]);
  const clearCapture = useCallback(() => {
    pointerCaptureActive.current = false;
    selectionAtPressStart.current = null;
  }, []);
  const handlePressOut = useCallback(() => {
    pointerCaptureActive.current = false;
  }, []);
  const handlePress = useCallback(() => {
    if (!composerQuote) return;
    const selection =
      selectionAtPressStart.current ?? readReplySelection(messageIds, anchorRef.current);
    clearCapture();
    if (selection) {
      composerQuote.addQuote({ quote: selection, label: t("message.actions.quoteSelection") });
      return;
    }
    const quote = extractReplyQuoteSummary(getContent());
    if (quote) composerQuote.addQuote({ quote, label: t("message.actions.quoteReply") });
  }, [clearCapture, composerQuote, getContent, messageIds, t]);

  if (!composerQuote || !hasText) return null;
  return (
    <View
      ref={anchorRef}
      onPointerDown={isWeb ? captureOnPointerDown : undefined}
      onPointerCancel={isWeb ? clearCapture : undefined}
    >
      <ToolbarButton
        compact
        label={t("message.actions.quoteReply")}
        onPress={handlePress}
        onPressIn={isWeb ? captureOnPressIn : undefined}
        onPressOut={isWeb ? handlePressOut : undefined}
        hitSlop={isNative ? TOUCH_HIT_SLOP : undefined}
        style={styles.button}
        testID="turn-quote-reply"
      >
        <ThemedQuote size={ICON_SIZE.sm} uniProps={mutedIconProps} />
      </ToolbarButton>
    </View>
  );
});

const styles = StyleSheet.create(() => ({
  // The same footprint as the copy button beside it, so the footer row keeps its height.
  button: {
    width: 24,
    height: 24,
  },
}));
