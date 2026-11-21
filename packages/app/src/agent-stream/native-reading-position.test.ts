import { describe, expect, it, vi } from "vitest";
import type { PluginTimelineStreamItem, UserMessageItem } from "@/types/stream";
import {
  createNativeReadingPositionTracker,
  findNativeMessageRowIndex,
  findNativeReadingStartIndex,
  resolveNativeReadingRowId,
} from "./native-reading-position";

function message(id: string): UserMessageItem {
  return { kind: "user_message", id, text: id, timestamp: new Date(0) };
}

function messagePart(id: string, sourceId: string): PluginTimelineStreamItem {
  return {
    kind: "plugin",
    id,
    sourceId,
    timestamp: new Date(0),
    pluginId: "test-plugin",
    pluginItemId: id,
    itemKind: "block",
    version: 1,
    data: null,
  };
}

describe("native reading position", () => {
  const rows = [message("first"), message("second"), message("third")];

  it("moves to the next row once the previous row clears the reading line", () => {
    const positions = [0, 100, 112];
    const sizes = [100, 12, 20];
    const input = {
      startIndex: 0,
      endIndex: 2,
      positionAtIndex: (index: number) => positions[index],
      sizeAtIndex: (index: number) => sizes[index],
    };
    expect(findNativeReadingStartIndex({ ...input, visibleTop: 90, readingLine: 98 })).toBe(0);
    expect(findNativeReadingStartIndex({ ...input, visibleTop: 91.5, readingLine: 99.5 })).toBe(1);
    expect(findNativeReadingStartIndex({ ...input, visibleTop: 105, readingLine: 113 })).toBe(2);
  });

  it("skips a row covered by the toolbar even when the next row starts below the reading line", () => {
    const positions = [0, 90];
    const sizes = [60, 70];
    expect(
      findNativeReadingStartIndex({
        startIndex: 0,
        endIndex: 1,
        visibleTop: 64,
        readingLine: 72,
        positionAtIndex: (index) => positions[index],
        sizeAtIndex: (index) => sizes[index],
      }),
    ).toBe(1);
  });

  it("only reports the last row when some of it clears the toolbar", () => {
    const input = {
      startIndex: 1,
      endIndex: 1,
      positionAtIndex: () => 50,
      sizeAtIndex: () => 14,
    };
    expect(findNativeReadingStartIndex({ ...input, visibleTop: 64, readingLine: 72 })).toBeNull();
    expect(findNativeReadingStartIndex({ ...input, visibleTop: 62, readingLine: 70 })).toBe(1);
  });

  it("chooses the earliest valid visible row from unordered results", () => {
    expect(
      resolveNativeReadingRowId({
        rows,
        startIndex: 0,
        viewableItems: [
          { index: 2, isViewable: true },
          { index: 0, isViewable: false },
          { index: null },
          { index: -1 },
          { index: rows.length },
          { index: 1 },
        ],
      }),
    ).toBe("second");
  });

  it("uses the visible start index when no viewable items are supplied", () => {
    expect(resolveNativeReadingRowId({ rows, startIndex: 1, viewableItems: [] })).toBe("second");
    expect(resolveNativeReadingRowId({ rows, startIndex: 0 })).toBe("first");
  });

  it("reports no row when the start or every viewable item is invalid", () => {
    expect(resolveNativeReadingRowId({ rows, startIndex: -1 })).toBeNull();
    expect(resolveNativeReadingRowId({ rows, startIndex: rows.length })).toBeNull();
    expect(resolveNativeReadingRowId({ rows: [], startIndex: 0 })).toBeNull();
    expect(
      resolveNativeReadingRowId({
        rows,
        startIndex: 0,
        viewableItems: [{ index: 0, isViewable: false }],
      }),
    ).toBeNull();
  });

  it("reports the replacement ID for a folded row", () => {
    expect(
      resolveNativeReadingRowId({
        rows,
        viewableItems: [{ index: 1 }],
        readingRowReplacements: new Map([["second", "folded-row"]]),
      }),
    ).toBe("folded-row");
  });

  it("reports each position once until it changes or the tracker is reset", () => {
    const tracker = createNativeReadingPositionTracker();
    const onChange = vi.fn();
    tracker.report("first", onChange);
    tracker.report("first", onChange);
    tracker.report(null, onChange);
    tracker.report(null, onChange);
    tracker.report("second", onChange);
    tracker.reset();
    tracker.report("second", onChange);
    expect(onChange.mock.calls).toEqual([["first"], [null], ["second"], ["second"]]);
  });

  it("clears a previous reading position when a reset panel returns with no rows", () => {
    const tracker = createNativeReadingPositionTracker();
    const onChange = vi.fn();
    tracker.report("first", onChange);
    tracker.reset();
    tracker.report(null, onChange);
    tracker.report(null, onChange);
    expect(onChange.mock.calls).toEqual([["first"], [null]]);
  });
});

describe("native message row lookup", () => {
  it("finds the first row of a message split across multiple parts", () => {
    const rows = [
      message("first"),
      messagePart("part-1", "target"),
      messagePart("part-2", "target"),
    ];
    expect(findNativeMessageRowIndex(rows, "target")).toBe(1);
    expect(findNativeMessageRowIndex(rows, "first")).toBe(0);
    expect(findNativeMessageRowIndex(rows, "missing")).toBe(-1);
  });
});
