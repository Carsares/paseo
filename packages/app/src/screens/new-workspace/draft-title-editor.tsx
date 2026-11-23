import { Pencil } from "lucide-react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, type TextInputKeyPressEvent, type TextInputSubmitEditingEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { isNative } from "@/constants/platform";
import { useOverlayRegistration } from "@/keyboard";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";

const EditIcon = withUnistyles(Pencil, (theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.iconSize.sm,
}));

interface DraftTitleEditorProps {
  value: string;
  onCommit: (value: string) => void;
  compact?: boolean;
  disabled?: boolean;
}

export function DraftTitleEditor({ value, onCommit, compact, disabled }: DraftTitleEditorProps) {
  const { t } = useTranslation();
  const [initialValue, setInitialValue] = useState<string | null>(null);
  const input = useRef<EditingTextInputHandle>(null);
  const settled = useRef(false);
  const placeholder = t("newWorkspace.title");
  const editLabel = t("newWorkspace.editTitle");
  const typography = compact ? styles.compactTitle : styles.heroTitle;

  const finish = useCallback(
    (text?: string) => {
      // A submit or cancellation can also blur the same native input.
      if (settled.current) return;
      settled.current = true;
      setInitialValue(null);
      if (disabled || text === undefined) return;
      const title = text.trim();
      if (title !== initialValue && title !== value) onCommit(title);
    },
    [disabled, initialValue, value, onCommit],
  );
  const handleBlur = useCallback(() => finish(input.current?.getText()), [finish]);
  const handleSubmit = useCallback(
    (event: TextInputSubmitEditingEvent) => finish(event.nativeEvent.text),
    [finish],
  );
  const handleKeyPress = useCallback(
    (event: TextInputKeyPressEvent) => {
      const key: typeof event.nativeEvent & { isComposing?: boolean; keyCode?: number } =
        event.nativeEvent;
      if (key.key !== "Escape" || isImeComposingKeyboardEvent(key)) return;
      event.preventDefault();
      finish();
    },
    [finish],
  );
  const start = useCallback(() => {
    settled.current = false;
    setInitialValue(value);
  }, [value]);
  const title = value || placeholder;
  const accessibleValue = useMemo(() => ({ text: title }), [title]);

  // Native hardware Escape is delivered by the window, including while a text field is focused.
  useOverlayRegistration({
    active: isNative && initialValue !== null && !disabled,
    passive: true,
    layer: 0,
    keys: ["Escape"],
    onKeyDown(event) {
      if (event.key !== "Escape") return false;
      finish();
      return true;
    },
  });

  if (disabled && initialValue !== null) setInitialValue(null);
  if (!disabled && initialValue !== null) {
    return (
      <AdaptiveTextInput
        ref={input}
        initialValue={initialValue}
        autoFocus
        selectTextOnFocus
        returnKeyType="done"
        accessibilityLabel={editLabel}
        placeholder={placeholder}
        style={[styles.input, typography]}
        onBlur={handleBlur}
        onSubmitEditing={handleSubmit}
        onKeyPress={handleKeyPress}
      />
    );
  }

  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={editLabel}
      accessibilityValue={accessibleValue}
      disabled={disabled}
      onPress={start}
      style={styles.trigger}
      highlightStyle={styles.highlight}
    >
      <Text numberOfLines={1} style={[styles.text, typography]}>
        {title}
      </Text>
      {disabled ? null : <EditIcon />}
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 44,
    maxWidth: "100%",
    flexShrink: 1,
    borderRadius: theme.borderRadius.sm,
  },
  highlight: { backgroundColor: theme.colors.interactionHighlight },
  text: { minWidth: 0, flexShrink: 1, color: theme.colors.foreground },
  compactTitle: { fontSize: theme.fontSize.lg, fontWeight: theme.fontWeight.medium },
  heroTitle: { fontSize: theme.fontSize["2xl"], fontWeight: theme.fontWeight.normal },
  input: {
    width: "100%",
    minWidth: 0,
    flexShrink: 1,
    minHeight: 44,
    padding: 0,
    borderRadius: theme.borderRadius.sm,
    borderBottomWidth: theme.borderWidth[1],
    borderColor: theme.colors.accent,
  },
}));
