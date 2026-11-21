import { getStreamItemMessageId, type StreamItem } from "@/types/stream";
import type { ReadingRowReplacements } from "./reading-anchor";

export function findNativeReadingStartIndex(input: {
  startIndex: number;
  endIndex: number;
  visibleTop: number;
  readingLine: number;
  positionAtIndex: (index: number) => number | undefined;
  sizeAtIndex: (index: number) => number | undefined;
}): number | null {
  const { startIndex, endIndex, visibleTop, readingLine, positionAtIndex, sizeAtIndex } = input;
  for (let index = startIndex; index <= endIndex; index += 1) {
    const nextPosition = index < endIndex ? positionAtIndex(index + 1) : undefined;
    // Native scroll offsets can round the jump's landing by a fraction of a pixel.
    if (nextPosition !== undefined && nextPosition <= readingLine + 1) continue;
    const position = positionAtIndex(index);
    const size = sizeAtIndex(index);
    if (position !== undefined && size !== undefined && position + size <= visibleTop) continue;
    return index;
  }
  return null;
}

export function resolveNativeReadingRowId(input: {
  rows: readonly StreamItem[];
  startIndex?: number;
  viewableItems?: ReadonlyArray<{ index: number | null; item?: StreamItem; isViewable?: boolean }>;
  readingRowReplacements?: ReadingRowReplacements;
}): string | null {
  const { rows, startIndex, viewableItems, readingRowReplacements } = input;
  let firstIndex = rows.length;
  if (viewableItems?.length) {
    for (const { index, isViewable } of viewableItems) {
      if (isViewable !== false && typeof index === "number" && index >= 0 && index < firstIndex) {
        firstIndex = index;
      }
    }
  } else if (startIndex !== undefined && startIndex >= 0 && startIndex < rows.length) {
    firstIndex = startIndex;
  }
  const row = rows[firstIndex];
  return row ? (readingRowReplacements?.get(row.id) ?? row.id) : null;
}

export function findNativeMessageRowIndex(rows: readonly StreamItem[], messageId: string): number {
  return rows.findIndex((row) => getStreamItemMessageId(row) === messageId);
}

export function createNativeReadingPositionTracker() {
  let lastReportedRowId: string | null | undefined = null;
  return {
    report(rowId: string | null, onChange: (id: string | null) => void) {
      if (rowId === lastReportedRowId) return;
      lastReportedRowId = rowId;
      onChange(rowId);
    },
    reset() {
      lastReportedRowId = undefined;
    },
  };
}
