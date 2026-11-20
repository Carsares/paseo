import { X } from "lucide-react-native";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type LayoutChangeEvent, type TextLayoutEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { isWeb } from "@/constants/platform";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const PREVIEW_LINES = 2;
const LONG_QUOTE_LENGTH = 120;
const ThemedX = withUnistyles(X);
const removeIconProps = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const expandedAccessibilityState = { expanded: true };
const collapsedAccessibilityState = { expanded: false };

export interface ComposerQuoteCardEntry {
  id: string;
  text: string;
  attachmentIndex: number;
}

export interface ComposerQuoteCardListProps {
  quotes: readonly ComposerQuoteCardEntry[];
  disabled?: boolean;
  onRemove: (attachmentIndex: number) => void;
}

interface ComposerQuoteCardProps extends Pick<ComposerQuoteCardListProps, "disabled" | "onRemove"> {
  quote: ComposerQuoteCardEntry;
  quoteNumber: number;
}

export function ComposerQuoteCard({
  quote,
  quoteNumber,
  disabled,
  onRemove,
}: ComposerQuoteCardProps) {
  const { t } = useTranslation();
  const { text, attachmentIndex } = quote;
  const [expanded, setExpanded] = useState(false);
  const [measuredOverflow, setMeasuredOverflow] = useState<boolean | null>(null);
  const hasExtraLines = text.split("\n", PREVIEW_LINES + 1).length > PREVIEW_LINES;
  const isOverflowing = hasExtraLines || (measuredOverflow ?? text.length > LONG_QUOTE_LENGTH);

  const handleRemove = useCallback(() => onRemove(attachmentIndex), [attachmentIndex, onRemove]);
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { height, width } = event.nativeEvent.layout;
    if (width > 0 && height > 0) {
      setMeasuredOverflow(height > PREVIEW_LINES * styles.bodyText.lineHeight + 2);
    }
  }, []);
  const handleTextLayout = useCallback((event: TextLayoutEvent) => {
    const { lines } = event.nativeEvent;
    if (lines.length > 0) setMeasuredOverflow(lines.length > PREVIEW_LINES);
  }, []);

  return (
    <View style={styles.card} testID="composer-quote-card">
      <View style={styles.header}>
        <Text style={styles.title}>{t("composer.quoteCard.title", { index: quoteNumber })}</Text>
        <ToolbarButton
          compact
          label={t("composer.quoteCard.remove", { index: quoteNumber })}
          onPress={handleRemove}
          disabled={disabled}
          testID="composer-quote-card-remove"
        >
          <ThemedX size={ICON_SIZE.sm} uniProps={removeIconProps} />
        </ToolbarButton>
      </View>
      <View style={styles.body}>
        <Text
          numberOfLines={expanded ? undefined : PREVIEW_LINES}
          ellipsizeMode="tail"
          selectable={expanded}
          style={styles.bodyText}
        >
          {text}
        </Text>
        {/* Measure unclamped text at the preview width, including after a resize. */}
        {hasExtraLines ? null : (
          <Text
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onLayout={isWeb ? handleLayout : undefined}
            onTextLayout={isWeb ? undefined : handleTextLayout}
            selectable={false}
            style={[styles.bodyText, styles.measurement]}
          >
            {text}
          </Text>
        )}
      </View>
      {isOverflowing ? (
        <Button
          variant="ghost"
          size="sm"
          style={styles.toggleButton}
          accessibilityState={expanded ? expandedAccessibilityState : collapsedAccessibilityState}
          aria-expanded={isWeb ? expanded : undefined}
          onPress={toggleExpanded}
          disabled={disabled}
          testID="composer-quote-card-toggle"
        >
          {t(expanded ? "composer.quoteCard.collapse" : "composer.quoteCard.expand")}
        </Button>
      ) : null}
    </View>
  );
}

export function ComposerQuoteCardList({ quotes, disabled, onRemove }: ComposerQuoteCardListProps) {
  if (quotes.length === 0) return null;

  return (
    <View style={styles.list} testID="composer-quote-card-list">
      {quotes.map((quote, index) => (
        <ComposerQuoteCard
          key={quote.id}
          quote={quote}
          quoteNumber={index + 1}
          disabled={disabled}
          onRemove={onRemove}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    width: "100%",
    flexDirection: "column",
    gap: theme.spacing[2],
  },
  card: {
    width: "100%",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  title: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  body: {
    position: "relative",
    overflow: "hidden",
  },
  bodyText: {
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.5),
    color: theme.colors.foregroundMuted,
  },
  measurement: {
    position: "absolute",
    top: 0,
    right: 0,
    left: 0,
    opacity: 0,
    pointerEvents: "none",
  },
  toggleButton: {
    alignSelf: "flex-start",
    paddingHorizontal: 0,
    minHeight: 0,
    height: "auto",
    borderWidth: 0,
  },
}));
