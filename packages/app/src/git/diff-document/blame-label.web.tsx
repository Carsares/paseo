import { withUnistyles } from "react-native-unistyles";
import { useMemo, type CSSProperties } from "react";
import type { DiffBlameMark } from "./types";

const style: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function BlameLabel({ mark, color, size }: { mark: DiffBlameMark; color: string; size: number }) {
  const labelStyle = useMemo(() => ({ ...style, fontSize: size, color }), [color, size]);
  return (
    <span style={labelStyle} title={mark.detail} aria-label={mark.detail}>
      {mark.label}
    </span>
  );
}

export const DiffBlameLabel = withUnistyles(BlameLabel, (theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.fontSize.sm,
}));
