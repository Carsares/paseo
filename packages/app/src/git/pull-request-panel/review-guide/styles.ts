import { StyleSheet } from "react-native-unistyles";

export const styles = StyleSheet.create((theme) => ({
  hidden: { display: "none" },
  content: { gap: theme.spacing[2] },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  list: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
  },
  file: {
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  fileRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  path: {
    flexShrink: 1,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  secondary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  draft: {
    minHeight: 80,
    textAlignVertical: "top",
  },
}));
