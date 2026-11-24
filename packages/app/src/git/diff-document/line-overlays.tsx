import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { DiffBlameLabel } from "./blame-label";
import { DiffLineChoice } from "./line-choice";
import { visibleRowRange } from "./model";
import type { DiffDocumentModel, DiffSurfaceProps } from "./types";

export function DiffLineOverlays({
  model,
  mode,
  scrollTop,
  viewportHeight,
  blameWidth,
}: {
  model: DiffDocumentModel;
  mode: DiffSurfaceProps["mode"];
  scrollTop: number;
  viewportHeight: number;
  blameWidth: number;
}) {
  if (mode.kind !== "working") return null;
  const { lineSelection, lineBlame } = mode;
  const overscan = viewportHeight;
  const top = Math.max(0, scrollTop - overscan);
  const { start, end } = visibleRowRange(model.rows, top, viewportHeight + 2 * overscan);
  if (!lineSelection && !lineBlame) return null;
  const overlays = [];
  for (let i = start; i < end; i++) {
    const row = model.rows[i];
    if (row?.kind !== "line") continue;
    const columnWidth = model.viewportWidth / row.cells.length;
    for (const [column, cell] of row.cells.entries()) {
      if (!cell) continue;
      const { hunkIndex, lineIndex } = cell.sourceIdentity;
      if (lineSelection?.path === row.path && (cell.type === "add" || cell.type === "remove")) {
        const picked = lineSelection.hunkIndex === hunkIndex && lineSelection.picked.has(lineIndex);
        overlays.push(
          <DiffLineChoice
            key={`pick:${row.index}:${column}`}
            left={column * columnWidth}
            top={row.top}
            height={model.lineHeight}
            picked={picked}
            hunkIndex={hunkIndex}
            lineIndex={lineIndex}
            lineNumber={cell.lineNumber}
            kind={cell.type}
            selection={lineSelection}
          />,
        );
      }
    }
    if (lineBlame?.path !== row.path || !blameWidth) continue;
    const cell = row.cells[1] ?? row.cells[0];
    const mark = cell && lineBlame.mark(cell);
    if (!mark) continue;
    overlays.push(
      <View
        key={`blame:${row.index}`}
        pointerEvents="box-none"
        style={[
          styles.blame,
          { top: row.top, left: model.viewportWidth, width: blameWidth, height: model.lineHeight },
        ]}
        testID={`git-diff-blame-${cell.lineNumber}`}
      >
        <DiffBlameLabel mark={mark} />
      </View>,
    );
  }
  return overlays;
}

export function DiffLineActions({ mode }: { mode: DiffSurfaceProps["mode"] }) {
  const { t } = useTranslation();
  const selection = mode.kind === "working" ? mode.lineSelection : undefined;
  if (!selection?.picked.size) return null;
  return (
    <View style={styles.actions} testID="git-diff-line-actions">
      <Button
        size="sm"
        testID="git-diff-apply-lines"
        disabled={!selection.canSubmit}
        onPress={selection.submit}
      >
        {selection.actionLabel} ({selection.picked.size})
      </Button>
      <Button size="sm" variant="ghost" onPress={selection.clear}>
        {t("common.actions.cancel")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    position: "absolute",
    bottom: theme.spacing[2],
    left: theme.spacing[2],
    zIndex: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  blame: {
    position: "absolute",
    zIndex: 4,
    paddingHorizontal: 6,
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
}));
