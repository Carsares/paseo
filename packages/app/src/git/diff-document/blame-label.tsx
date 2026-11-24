import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DiffBlameMark } from "./types";

export function DiffBlameLabel({ mark }: { mark: DiffBlameMark }) {
  return (
    <Text accessibilityLabel={mark.detail} numberOfLines={1} style={styles.label}>
      {mark.label}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
