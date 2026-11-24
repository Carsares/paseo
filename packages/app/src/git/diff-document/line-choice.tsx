import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useStableEvent } from "@/hooks/use-stable-event";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { DiffLineSelection } from "./types";

export interface DiffLineChoiceProps {
  selection: DiffLineSelection;
  picked: boolean;
  hunkIndex: number;
  lineIndex: number;
  lineNumber: number | null;
  kind: "add" | "remove";
  left: number;
  top: number;
  height: number;
}

const checked = { checked: true };
const unchecked = { checked: false };

export function DiffLineChoice({
  selection,
  picked,
  hunkIndex,
  lineIndex,
  lineNumber,
  kind,
  left,
  top,
  height,
}: DiffLineChoiceProps) {
  const pick = useStableEvent(() => selection.pick(hunkIndex, lineIndex, false));
  return (
    <PressHighlight
      accessibilityLabel={`${selection.label}: ${kind === "add" ? "+" : "−"}${lineNumber}`}
      accessibilityRole="checkbox"
      accessibilityState={picked ? checked : unchecked}
      onPress={pick}
      style={[styles.choice, { left, top, height }]}
      testID={`git-diff-pick-${hunkIndex}-${lineIndex}`}
    >
      <Text style={styles.mark}>{picked ? "☑" : "☐"}</Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  choice: {
    position: "absolute",
    width: 18,
    zIndex: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  mark: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
