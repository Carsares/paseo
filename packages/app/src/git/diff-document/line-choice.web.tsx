import { useMemo, type KeyboardEvent, type MouseEvent } from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { DiffLineChoiceProps } from "./line-choice";

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
  const extendFromKeyboard = useStableEvent((event: KeyboardEvent<HTMLButtonElement>) => {
    if (!event.shiftKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const controls = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
      `[data-diff-pick-hunk="${hunkIndex}"]`,
    );
    if (!controls) return;
    const ordered = Array.from(controls);
    const adjacent =
      ordered[ordered.indexOf(event.currentTarget) + (event.key === "ArrowUp" ? -1 : 1)];
    if (!adjacent) return;
    event.preventDefault();
    event.stopPropagation();
    if (selection.hunkIndex !== hunkIndex) selection.pick(hunkIndex, lineIndex, false);
    selection.pick(hunkIndex, Number(adjacent.dataset.diffPickLine), true);
    adjacent.focus();
  });
  const pick = useStableEvent((event: MouseEvent<HTMLButtonElement>) =>
    selection.pick(hunkIndex, lineIndex, event.shiftKey),
  );
  const style = useMemo(
    () => ({
      position: "absolute" as const,
      zIndex: 4,
      top,
      left,
      height,
      width: 18,
      padding: 0,
      border: 0,
      background: "transparent",
      color: "inherit",
      cursor: "pointer",
    }),
    [top, left, height],
  );
  return (
    <button
      aria-label={`${selection.label}: ${kind === "add" ? "+" : "−"}${lineNumber}`}
      aria-pressed={picked}
      data-diff-pick-hunk={hunkIndex}
      data-diff-pick-line={lineIndex}
      data-testid={`git-diff-pick-${hunkIndex}-${lineIndex}`}
      title={selection.rangeHint}
      type="button"
      onClick={pick}
      onKeyDown={extendFromKeyboard}
      style={style}
    >
      {picked ? "☑" : "☐"}
    </button>
  );
}
