import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

export type SelectionSubagentSpawnMode = "child" | "sibling";

export interface SelectionSubagentSpawnContext {
  messageRowId: string | null;
}

export interface AssistantSelectionCopySurfaceProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  subagentSpawnMode?: SelectionSubagentSpawnMode;
  onSpawnSubagentFromSelection?: (
    selectedMarkdown: string,
    context?: SelectionSubagentSpawnContext,
  ) => void;
}

export function AssistantSelectionCopySurface({
  children,
  style,
}: AssistantSelectionCopySurfaceProps) {
  return <View style={style}>{children}</View>;
}
