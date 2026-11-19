import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

export interface AssistantSelectionCopySurfaceProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onSpawnSubagentFromSelection?: (selectedMarkdown: string) => void;
}

export function AssistantSelectionCopySurface({
  children,
  style,
}: AssistantSelectionCopySurfaceProps) {
  return <View style={style}>{children}</View>;
}
