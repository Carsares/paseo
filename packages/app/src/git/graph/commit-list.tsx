import { PressHighlight } from "@/components/ui/press-highlight";
import { TOUCH_TARGET } from "@/components/ui/control-geometry";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useMemo } from "react";
import { FlatList, Text, View, type ListRenderItemInfo } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { StyleSheet } from "react-native-unistyles";
import type { CheckoutGitLogCommit } from "@getpaseo/protocol/messages";
import {
  commitKey,
  displayedNodeLane,
  laneDisplay,
  layoutCommitLanes,
  type LaneRow,
} from "./lanes";
import { repoColor, stripeSegments } from "./stripe-segments";
import { styles as ui } from "./ui";

const ROW_HEIGHT = TOUCH_TARGET;
const CENTER = ROW_HEIGHT / 2;
const LANE_WIDTH = 10;

function Lanes({
  row,
  repoRoot,
  laneCount,
  hasOverflow,
}: {
  row: LaneRow;
  repoRoot: string;
  laneCount: number;
  hasOverflow: boolean;
}) {
  const x = (lane: number) => (lane + 1) * LANE_WIDTH;
  const here = x(displayedNodeLane(row.lane, laneCount));
  const hiddenConnections =
    row.omittedParents ||
    row.through.some(({ lane }) => lane >= laneCount) ||
    row.parents.some(({ to }) => to >= laneCount);
  return (
    <Svg
      width={(laneCount + (hasOverflow ? 2 : 1)) * LANE_WIDTH}
      height={ROW_HEIGHT}
      pointerEvents="none"
    >
      {row.through
        .filter(({ lane }) => lane < laneCount)
        .map(({ lane, repoRoot: root }) => (
          <Path
            key={lane}
            d={`M${x(lane)},0 V${ROW_HEIGHT}`}
            stroke={repoColor(root)}
            strokeWidth={1.5}
          />
        ))}
      {row.lane < laneCount && (
        <>
          {row.incoming ? (
            <Path d={`M${here},0 V${CENTER}`} stroke={repoColor(repoRoot)} strokeWidth={1.5} />
          ) : null}
          {row.parents
            .filter(({ to }) => to < laneCount)
            .map(({ to, repoRoot: root }) => (
              <Path
                key={to}
                d={`M${here},${CENTER} C${here},${CENTER + 12} ${x(to)},${CENTER + 10} ${x(to)},${ROW_HEIGHT}`}
                stroke={repoColor(root)}
                strokeWidth={1.5}
                fill="none"
              />
            ))}
        </>
      )}
      {hasOverflow && (hiddenConnections || row.lane >= laneCount) ? (
        <Path
          d={`M${x(laneCount)},0 V${ROW_HEIGHT}`}
          stroke={repoColor(repoRoot)}
          strokeWidth={1.5}
          strokeDasharray="2 3"
        />
      ) : null}
      <Circle cx={here} cy={CENTER} r={3} fill={repoColor(repoRoot)} />
    </Svg>
  );
}

export function CommitList({
  commits,
  selectedKey,
  onSelect,
  hasMore,
  narrow,
  refLabels,
}: {
  commits: CheckoutGitLogCommit[];
  selectedKey: string | null;
  onSelect: (commit: CheckoutGitLogCommit) => void;
  hasMore: boolean;
  narrow: boolean;
  refLabels: ReadonlyMap<string, string>;
}) {
  const lanes = useMemo(() => layoutCommitLanes(commits, hasMore), [commits, hasMore]);
  const { count: laneCount, hasOverflow } = useMemo(() => laneDisplay(lanes), [lanes]);
  const stripes = useMemo(() => {
    const colors: string[] = [];
    for (const { start, end, color } of stripeSegments(commits)) {
      for (let i = start; i < end; i++) colors[i] = color;
    }
    return colors;
  }, [commits]);
  const extraData = useMemo(
    () => ({ selectedKey, narrow, refLabels, lanes }),
    [selectedKey, narrow, refLabels, lanes],
  );
  const renderItem = useStableEvent(({ item, index }: ListRenderItemInfo<CheckoutGitLogCommit>) => {
    const key = commitKey(item);
    return (
      <CommitRow
        item={item}
        selected={key === selectedKey}
        refs={refLabels.get(key)}
        narrow={narrow}
        color={stripes[index]}
        lane={lanes[index]}
        laneCount={laneCount}
        hasOverflow={hasOverflow}
        onSelect={onSelect}
      />
    );
  });
  return (
    <FlatList
      style={ui.fill}
      data={commits}
      keyExtractor={commitKey}
      getItemLayout={getItemLayout}
      renderItem={renderItem}
      extraData={extraData}
    />
  );
}

function getItemLayout(_: unknown, index: number) {
  return { index, length: ROW_HEIGHT, offset: index * ROW_HEIGHT };
}

const selectionStates = { selected: { selected: true }, idle: { selected: false } };

function CommitRow({
  item,
  selected,
  refs,
  narrow,
  color,
  lane,
  laneCount,
  hasOverflow,
  onSelect,
}: {
  item: CheckoutGitLogCommit;
  selected: boolean;
  refs?: string;
  narrow: boolean;
  color: string;
  lane: LaneRow;
  laneCount: number;
  hasOverflow: boolean;
  onSelect: (item: CheckoutGitLogCommit) => void;
}) {
  const press = useStableEvent(() => onSelect(item));
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityState={selected ? selectionStates.selected : selectionStates.idle}
      style={[styles.commit, selected && styles.selected]}
      highlightStyle={styles.selected}
      onPress={press}
    >
      <View style={styles.stripe(narrow, color)} />
      {narrow ? null : (
        <Lanes
          row={lane}
          laneCount={laneCount}
          hasOverflow={hasOverflow}
          repoRoot={item.repoRoot}
        />
      )}
      <View style={styles.subject}>
        <Text style={ui.heading} numberOfLines={1}>
          {item.subject || item.sha.slice(0, 8)}
        </Text>
        <Text style={ui.muted} numberOfLines={1}>
          {[item.authorName, item.authorDate.slice(0, 10), refs].filter(Boolean).join(" · ")}
        </Text>
      </View>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  commit: { height: ROW_HEIGHT, flexDirection: "row", alignItems: "center" },
  stripe: (narrow: boolean, color: string) => ({
    width: narrow ? 3 : 4,
    height: ROW_HEIGHT,
    backgroundColor: color,
  }),
  selected: { backgroundColor: theme.colors.surface2 },
  subject: { flex: 1, minWidth: 0, paddingHorizontal: theme.spacing[2] },
}));
