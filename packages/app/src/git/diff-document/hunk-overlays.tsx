import { View, type ViewStyle } from "react-native";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { visibleRowRange } from "./model";
import type { DiffDocumentModel, DiffSurfaceProps } from "./types";

export function DiffHunkOverlays({
  model,
  mode,
  scrollTop,
  viewportHeight,
}: {
  model: DiffDocumentModel;
  mode: DiffSurfaceProps["mode"];
  scrollTop: number;
  viewportHeight: number;
}) {
  if (mode.kind !== "working" || !mode.renderHunkActions) return null;
  const render = mode.renderHunkActions;
  const overscan = viewportHeight * 2;
  const from = Math.max(0, scrollTop - overscan);
  const { start, end } = visibleRowRange(model.rows, from, viewportHeight + overscan * 2);
  return model.rows.slice(start, end).map((row) => {
    if (row.kind !== "line" || !row.hunkActionsHeight || !row.cells[0]) return null;
    const file = model.files[row.fileIndex]?.file;
    if (!file) return null;
    const { hunkIndex } = row.cells[0].sourceIdentity;
    return (
      <View
        key={JSON.stringify([file.path, hunkIndex])}
        style={inlineUnistylesStyle<ViewStyle>({
          position: "absolute",
          top: row.top + row.height - row.hunkActionsHeight,
          left: 0,
          right: 0,
          height: row.hunkActionsHeight,
          justifyContent: "center",
          zIndex: 4,
        })}
      >
        {render(file, hunkIndex)}
      </View>
    );
  });
}
