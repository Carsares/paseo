import { useCallback, useMemo, useRef, useState } from "react";
import type { DiffState } from "@getpaseo/client";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { selectableLineOrder } from "../diff-document/model";
import type { DiffLineSelection } from "../diff-document/types";
import { useGitP2Copy } from "../p2-copy";
import { buildLinePatch } from "./line-patch";
import type { StagingLayer } from "./model";

interface Selection {
  snapshot: DiffState;
  hunkIndex: number;
  anchor: number;
  picked: ReadonlySet<number>;
  beforeRange: ReadonlySet<number>;
}

const empty = new Set<number>();

export function useLineSelection({
  diff,
  file,
  layer,
  layout,
  eligible,
  canWrite,
  apply,
}: {
  diff: DiffState | undefined;
  file: ParsedDiffFile | undefined;
  layer: StagingLayer;
  layout: "unified" | "split";
  eligible: boolean;
  canWrite: boolean;
  apply: (patch: string) => Promise<boolean | undefined>;
}): DiffLineSelection | undefined {
  const copy = useGitP2Copy();
  const order = useMemo(
    () => (eligible && file ? selectableLineOrder(file, layout) : undefined),
    [eligible, file, layout],
  );
  const [stored, setStored] = useState<Selection>();
  const selection = stored?.snapshot === diff ? stored : undefined;
  const live = useRef({ selection, canWrite, apply });
  live.current = { selection, canWrite, apply };
  const pick = useCallback(
    (hunkIndex: number, lineIndex: number, extend: boolean) => {
      const lines = order?.get(hunkIndex);
      const index = lines?.indexOf(lineIndex) ?? -1;
      if (!diff || !lines || index < 0) return;
      setStored((current) => {
        const sameHunk = current?.snapshot === diff && current.hunkIndex === hunkIndex;
        if (extend && sameHunk) {
          const picked = new Set(current.beforeRange);
          const anchor = lines.indexOf(current.anchor);
          const start = Math.min(anchor, index);
          const end = Math.max(anchor, index);
          for (const pickedLine of lines.slice(start, end + 1)) picked.add(pickedLine);
          return { ...current, picked };
        }
        const picked = new Set(sameHunk ? current.picked : empty);
        if (picked.has(lineIndex)) picked.delete(lineIndex);
        else picked.add(lineIndex);
        return { snapshot: diff, hunkIndex, anchor: lineIndex, picked, beforeRange: picked };
      });
    },
    [diff, order],
  );
  const clear = useCallback(() => setStored(undefined), []);
  const patch =
    file && selection && buildLinePatch(file, selection.hunkIndex, selection.picked, layer);
  if (!eligible || !file || !diff) return;
  return {
    path: file.path,
    hunkIndex: selection?.hunkIndex,
    picked: selection?.picked ?? empty,
    pick,
    clear,
    submit: async () => {
      if (!patch || !live.current.canWrite || live.current.selection !== selection) return;
      const succeeded = await live.current.apply(patch);
      if (succeeded) setStored((current) => (current === selection ? undefined : current));
    },
    canSubmit: Boolean(patch && canWrite),
    label: copy.selectLines,
    rangeHint: copy.selectRange,
    actionLabel: layer === "staged" ? copy.unstageLines : copy.stageLines,
  };
}
