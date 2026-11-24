import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, onTestFinished, test, vi } from "vitest";
import { page } from "vitest/browser";
import { MergeEditor, type MergeContents } from "./editor";

const lineCount = 4096;
const columns = ["base", "ours", "theirs", "result"] as const;
const landmarkRows = [4, 2048, 4093] as const;
type Column = (typeof columns)[number];

function landmark(column: Column, lineNumber: number): string {
  return `Merge ${column} row ${lineNumber}`;
}

function sourceText(column: Column): string {
  return (
    Array.from({ length: lineCount }, (_, index) => {
      const lineNumber = index + 1;
      return landmarkRows.some((row) => row === lineNumber)
        ? landmark(column, lineNumber)
        : `Shared source row ${lineNumber}`;
    }).join("\n") + "\n"
  );
}

const contents: MergeContents = {
  base: sourceText("base"),
  ours: sourceText("ours"),
  theirs: sourceText("theirs"),
  result: sourceText("result"),
};
const labels = { base: "Base", ours: "Ours", theirs: "Theirs", result: "Result" };
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

async function sampleFrames(count: number, onFrame?: (step: number) => void) {
  const intervals: number[] = [];
  let previous = await nextFrame();
  for (let step = 1; step <= count; step += 1) {
    onFrame?.(step);
    const current = await nextFrame();
    intervals.push(current - previous);
    previous = current;
  }
  const sorted = intervals.toSorted((left, right) => left - right);
  return {
    medianMs: sorted[Math.ceil(count * 0.5) - 1]!,
    p95Ms: sorted[Math.ceil(count * 0.95) - 1]!,
    peakMs: sorted[count - 1]!,
  };
}

function findRow(scroll: HTMLElement, column: Column, lineNumber: number) {
  return scroll.querySelector(`[data-testid="git-merge-${column}-row"][data-line="${lineNumber}"]`);
}

async function expectVisibleRow(scroll: HTMLElement, lineNumber: number) {
  const viewport = scroll.getBoundingClientRect();
  await expect
    .poll(() =>
      columns.map((column) => {
        const row = findRow(scroll, column, lineNumber);
        const bounds = row?.getBoundingClientRect();
        return (
          row?.textContent?.includes(landmark(column, lineNumber)) === true &&
          bounds !== undefined &&
          bounds.height > 0 &&
          bounds.width > 0 &&
          bounds.top >= viewport.top - 1 &&
          bounds.bottom <= viewport.bottom + 1 &&
          bounds.left >= viewport.left - 1 &&
          bounds.right <= viewport.right + 1
        );
      }),
    )
    .toEqual([true, true, true, true]);

  const bounds = columns.map((column) =>
    findRow(scroll, column, lineNumber)!.getBoundingClientRect(),
  );
  for (const [index, row] of bounds.entries()) {
    expect(Math.abs(row.top - bounds[0]!.top)).toBeLessThanOrEqual(2);
    if (index > 0) expect(row.left).toBeGreaterThanOrEqual(bounds[index - 1]!.right - 1);
  }
  // Allow over twice the visible row count for overscan, and bound total DOM as well.
  const rows = scroll.querySelectorAll("[data-line]").length;
  const elements = scroll.querySelectorAll("*").length;
  expect(rows).toBeLessThan(256);
  expect(elements).toBeLessThan(640);
  return { rows, elements };
}

test("renders and scrolls four aligned merge columns for a 4,096-line file", async ({
  annotate,
}) => {
  await page.viewport(1440, 900);
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const mount = document.createElement("div");
  Object.assign(mount.style, { display: "flex", width: "1200px", height: "550px" });
  document.body.appendChild(mount);
  const root = createRoot(mount);
  onTestFinished(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => root.unmount());
    mount.remove();
    vi.unstubAllGlobals();
  });
  await act(async () =>
    root.render(
      <MergeEditor contents={contents} labels={labels} missingVersionLabel="Version absent" />,
    ),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  const locator = page.getByTestId("git-merge-scroll");
  await expect.element(locator).toBeVisible();
  const scroll = locator.element();
  if (!(scroll instanceof HTMLElement)) throw new Error("Merge editor has no scroll element");
  const maximumScrollTop = scroll.scrollHeight - scroll.clientHeight;
  expect(scroll.clientHeight).toBeGreaterThan(100);
  expect(maximumScrollTop).toBeGreaterThan(20_000);

  const start = await expectVisibleRow(scroll, landmarkRows[0]);
  expect(findRow(scroll, "base", landmarkRows[2])).toBeNull();

  const idle = await sampleFrames(20);
  const scrollSteps = 90;
  const halfway = Math.round(maximumScrollTop / 2);
  const scrolling = await sampleFrames(scrollSteps, (step) => {
    scroll.scrollTop = (halfway * step) / scrollSteps;
  });
  expect(Math.abs(scroll.scrollTop - halfway)).toBeLessThanOrEqual(1);
  const middle = await expectVisibleRow(scroll, landmarkRows[1]);

  scroll.scrollTop = maximumScrollTop;
  const end = await expectVisibleRow(scroll, landmarkRows[2]);
  expect(findRow(scroll, "base", landmarkRows[0])).toBeNull();
  await annotate(
    JSON.stringify({ idle, scrolling, samples: scrollSteps, dom: { start, middle, end } }),
    "Chromium animation callback intervals (ms) and scroll DOM",
  );
  expect(scrolling.p95Ms).toBeLessThanOrEqual(50);
}, 15_000);
