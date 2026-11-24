import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type UIEvent,
} from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { MergeContents, MergeEditorProps } from "./editor";

const columns = [
  "base",
  "ours",
  "theirs",
  "result",
] as const satisfies readonly (keyof MergeContents)[];
type Column = (typeof columns)[number];
const rowHeight = 22;
const overscan = 12;
const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const shellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
};
const scrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  direction: "ltr",
  fontFamily: mono,
  fontSize: 12,
};
const rowStyle: CSSProperties = {
  height: rowHeight,
  lineHeight: `${rowHeight}px`,
  whiteSpace: "pre",
  overflow: "hidden",
  textOverflow: "ellipsis",
  paddingInline: 6,
};
const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
};
const headerStyle: CSSProperties = { padding: "6px 12px", borderBottom: "1px solid currentColor" };
const columnStyle: CSSProperties = {
  position: "relative",
  minWidth: 0,
  boxShadow: "inset -1px 0 0 color-mix(in srgb, currentColor 18%, transparent)",
};
const textAreaStyle: CSSProperties = {
  position: "absolute",
  insetInline: 0,
  top: 0,
  width: "100%",
  fontFamily: mono,
  fontSize: "inherit",
  lineHeight: `${rowHeight}px`,
  boxSizing: "border-box",
  padding: "0 6px 0 44px",
  margin: 0,
  border: 0,
  resize: "none",
  color: "inherit",
  background: "transparent",
};
const gutterStyle: CSSProperties = { display: "inline-block", opacity: 0.65, width: 38 };

function sourceLines(content: string | null) {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

export function MergeEditor({
  contents,
  labels,
  missingVersionLabel,
  editing = false,
  onChangeResult,
  foreground,
}: MergeEditorProps) {
  const root = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollRow, setScrollRow] = useState(0);
  const base = useMemo(() => sourceLines(contents.base), [contents.base]);
  const ours = useMemo(() => sourceLines(contents.ours), [contents.ours]);
  const theirs = useMemo(() => sourceLines(contents.theirs), [contents.theirs]);
  const result = useMemo(() => sourceLines(contents.result), [contents.result]);
  const versions = { base, ours, theirs, result };
  const resultRows = editing ? result.length + 2 : result.length;
  const rowCount = Math.max(base.length, ours.length, theirs.length, resultRows, 1);
  const top = Math.min(rowCount - 1, scrollRow);
  const first = Math.max(0, top - overscan);
  const last = Math.min(rowCount, top + Math.ceil(viewportHeight / rowHeight) + overscan);
  const visibleRows = useMemo(
    () => Array.from({ length: last - first }, (_, offset) => first + offset),
    [first, last],
  );
  const columnsStyle = useMemo(() => ({ ...gridStyle, height: rowCount * rowHeight }), [rowCount]);
  const editorStyle = useMemo(() => ({ ...shellStyle, color: foreground }), [foreground]);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      if (element.clientHeight > 0) setViewportHeight(element.clientHeight);
    };
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrollRow(Math.floor(event.currentTarget.scrollTop / rowHeight));
  }, []);
  return (
    <div style={editorStyle}>
      <div style={gridStyle}>
        {columns.map((column) => (
          <div key={column} style={headerStyle}>
            <strong>{labels[column]}</strong>
            {contents[column] === null ? <div>{missingVersionLabel}</div> : null}
          </div>
        ))}
      </div>
      <div
        ref={root}
        tabIndex={0}
        onScroll={scroll}
        data-testid="git-merge-scroll"
        style={scrollStyle}
      >
        <div style={columnsStyle}>
          {columns.map((column) => (
            <div key={column} style={columnStyle}>
              {column === "result" && editing ? (
                <ResultInput
                  text={contents.result}
                  onChangeResult={onChangeResult}
                  label={labels.result}
                  height={rowCount * rowHeight}
                />
              ) : null}
              <ColumnRows
                column={column}
                lines={versions[column]}
                rows={visibleRows}
                top={first * rowHeight}
                hideSource={column === "result" && editing}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ColumnRows({
  column,
  lines,
  rows,
  top,
  hideSource,
}: {
  column: Column;
  lines: string[];
  rows: number[];
  top: number;
  hideSource: boolean;
}) {
  const style = useMemo<CSSProperties>(
    () => ({
      position: "absolute",
      insetInline: 0,
      top,
      pointerEvents: hideSource ? "none" : undefined,
    }),
    [top, hideSource],
  );
  return (
    <div style={style}>
      {rows.map((index) => {
        const source = lines[index];
        return (
          <div
            key={index}
            data-testid={`git-merge-${column}-row`}
            data-line={index + 1}
            title={hideSource ? undefined : source}
            style={rowStyle}
          >
            {source !== undefined ? (
              <span aria-hidden="true" style={gutterStyle}>
                {index + 1}
              </span>
            ) : null}
            {hideSource ? null : source}
          </div>
        );
      })}
    </div>
  );
}

function ResultInput({
  label,
  text,
  height,
  onChangeResult,
}: {
  label: string;
  text: string | null;
  height: number;
  onChangeResult?: (result: string) => void;
}) {
  const style = useMemo(() => ({ ...textAreaStyle, height }), [height]);
  const change = useStableEvent((event: ChangeEvent<HTMLTextAreaElement>) => {
    onChangeResult?.(event.currentTarget.value);
  });
  return (
    <textarea
      aria-label={label}
      value={text ?? ""}
      wrap="off"
      spellCheck={false}
      onChange={change}
      style={style}
    />
  );
}
