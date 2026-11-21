import { useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { useDisclosureHold } from "@/agent-stream/disclosure";
import { ExpandedQuoteCountContext, FindQuoteIndexContext } from "./quote-expansion-context";
import { parseUserMessageSegments } from "./quote-segments";

const MESSAGE_TEXT_DATASET = { messageText: "true" };
const QUOTE_PREVIEW_LINES = 3;
const QUOTE_PREVIEW_CHARACTERS = 160;

export interface UserMessageBodyProps {
  message: string;
}

export function UserMessageBody({ message }: UserMessageBodyProps) {
  const segments = useMemo(() => parseUserMessageSegments(message), [message]);

  if (segments.length === 1 && segments[0].kind === "text") {
    return (
      <Text selectable style={styles.text} dataSet={MESSAGE_TEXT_DATASET}>
        {message}
      </Text>
    );
  }

  return (
    <View style={styles.stack} dataSet={MESSAGE_TEXT_DATASET}>
      {segments.map((segment, index) => {
        if (segment.kind === "quote") {
          return (
            <UserMessageQuoteBlock
              key={segment.quoteIndex}
              quoteIndex={segment.quoteIndex}
              text={segment.text}
            />
          );
        }
        const previous = segments[index - 1];
        return (
          <Text
            key={previous?.kind === "quote" ? `text-after-${previous.quoteIndex}` : "text-start"}
            selectable
            style={styles.text}
          >
            {segment.text}
          </Text>
        );
      })}
    </View>
  );
}

function UserMessageQuoteBlock({ text, quoteIndex }: { text: string; quoteIndex: number }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const expandedForFind = useContext(FindQuoteIndexContext) === quoteIndex;
  const showFullQuote = expanded || expandedForFind;
  const clipMarker = useMemo(() => ({ findQuoteClipped: String(quoteIndex) }), [quoteIndex]);
  const adjustExpandedQuoteCount = useContext(ExpandedQuoteCountContext);
  useLayoutEffect(() => {
    if (!expanded || !adjustExpandedQuoteCount) return;
    adjustExpandedQuoteCount(1);
    return () => adjustExpandedQuoteCount(-1);
  }, [adjustExpandedQuoteCount, expanded]);
  const [previewHeight, setPreviewHeight] = useState(0);
  const [fullHeight, setFullHeight] = useState(0);
  const longSource =
    text.length > QUOTE_PREVIEW_CHARACTERS || text.split("\n").length > QUOTE_PREVIEW_LINES;
  const showToggle = expanded || longSource || (previewHeight > 0 && fullHeight > previewHeight);

  const onPreviewLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (height > 0) setPreviewHeight(height);
  }, []);
  const onFullLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (height > 0) setFullHeight(height);
  }, []);
  const hold = useDisclosureHold();
  const toggleExpanded = useCallback(
    () => hold(() => setExpanded((value) => !value), { triggerEdge: "bottom" }),
    [hold],
  );
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);

  return (
    <View style={styles.quote} testID="user-message-quote-block">
      <View>
        <Text
          selectable
          numberOfLines={showFullQuote ? undefined : QUOTE_PREVIEW_LINES}
          dataSet={showFullQuote ? undefined : clipMarker}
          ellipsizeMode="tail"
          style={styles.quoteText}
          onLayout={showFullQuote || longSource ? undefined : onPreviewLayout}
        >
          {text}
        </Text>
        {!longSource ? (
          // Short text can still wrap past three lines in a narrow pane.
          <Text
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            selectable={false}
            style={[styles.quoteText, styles.measurement]}
            onLayout={onFullLayout}
          >
            {text}
          </Text>
        ) : null}
      </View>
      {showToggle ? (
        <Button
          variant="ghost"
          size="sm"
          style={styles.toggle}
          accessibilityState={accessibilityState}
          aria-expanded={expanded}
          onPress={toggleExpanded}
          testID="user-message-quote-toggle"
        >
          {t(expanded ? "turnSummary.showLess" : "turnSummary.showMore")}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    lineHeight: theme.lineHeight.content,
    letterSpacing: theme.contentLetterSpacing,
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
  },
  stack: {
    gap: theme.spacing[2],
    minWidth: 0,
  },
  quote: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.borderAccent,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
  quoteText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.5),
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
  },
  measurement: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    opacity: 0,
    ...(isWeb ? { visibility: "hidden" as const } : {}),
  },
  toggle: {
    alignSelf: "flex-start",
    paddingHorizontal: 0,
    minHeight: 0,
    height: "auto",
    borderWidth: 0,
  },
}));
