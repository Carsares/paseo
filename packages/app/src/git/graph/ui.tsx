import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { Text, View } from "react-native";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { repoColor } from "./stripe-segments";
import { StyleSheet } from "react-native-unistyles";

export function GraphInput({
  value,
  ...props
}: ComponentProps<typeof EditingTextInput> & { value: string }) {
  const ref = useRef<EditingTextInputHandle>(null);
  useLayoutEffect(() => {
    if (ref.current && ref.current.getText() !== value) ref.current.replaceText(value);
  }, [value]);
  return (
    <EditingTextInput
      {...props}
      ref={ref}
      initialValue={value}
      style={[styles.input, props.style]}
    />
  );
}

export function RepoDot({ root }: { root: string }) {
  return <View style={styles.dot(repoColor(root))} />;
}

export function GraphMessage({ children, error = false }: { children: string; error?: boolean }) {
  return (
    <Text
      accessibilityRole={error ? "alert" : undefined}
      style={error ? styles.error : styles.muted}
    >
      {children}
    </Text>
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const styles = StyleSheet.create((theme) => ({
  dot: (color: string) => ({ width: 8, height: 8, borderRadius: 4, backgroundColor: color }),
  columns: { flexDirection: "row" },
  referencesColumn: { width: 296 },
  detailColumn: { width: 372 },
  fill: { flex: 1, minWidth: 0, minHeight: 0 },
  stack: { gap: theme.spacing[2], padding: theme.spacing[3] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  wrap: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[2] },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  paneBorder: { borderLeftWidth: 1, borderLeftColor: theme.colors.border },
  rowBorder: { borderTopWidth: 1, borderTopColor: theme.colors.border },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  heading: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, fontWeight: "600" },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  input: {
    color: theme.colors.foreground,
    minHeight: 44,
    minWidth: 100,
    flexShrink: 1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    fontSize: theme.fontSize.sm,
  },
}));
