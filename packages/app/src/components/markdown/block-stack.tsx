import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { markdownCopyImageSourcesDataSet } from "@/assistant-selection-copy/markup";
import { isWeb } from "@/constants/platform";
import { density, resolveDensity } from "@/styles/density";

/** Stacks Markdown blocks rendered as separate views with the same gap the text puts between its blocks. */
export function MarkdownBlockStack({
  imageSources,
  children,
}: {
  imageSources?: Record<string, string>;
  children: ReactNode;
}) {
  return (
    <View
      style={styles.stack}
      dataSet={isWeb && imageSources ? markdownCopyImageSourcesDataSet(imageSources) : undefined}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  stack: {
    gap:
      theme.contentBlockGap ??
      resolveDensity(rt ? { breakpoint: rt.breakpoint } : {}, density.blockGap),
  },
}));
