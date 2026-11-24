interface Commit {
  repoRoot: string;
  sha: string;
  parents: readonly string[];
}

export function commitKey(commit: Pick<Commit, "repoRoot" | "sha">): string {
  return JSON.stringify([commit.repoRoot, commit.sha]);
}

type Lane = Pick<Commit, "repoRoot" | "sha">;

export interface LaneEdge {
  from: number;
  to: number;
  repoRoot: string;
}

export interface LaneRow {
  lane: number;
  incoming: boolean;
  through: { lane: number; repoRoot: string }[];
  parents: LaneEdge[];
  omittedParents?: boolean;
}

export const MAX_DISPLAY_LANES = 16;

export function laneDisplay(rows: readonly LaneRow[]) {
  let count = 1;
  let hasOverflow = false;
  for (const row of rows) {
    count = Math.max(count, row.lane + 1);
    for (const edge of row.parents) count = Math.max(count, edge.to + 1);
    if (row.omittedParents || count > MAX_DISPLAY_LANES) hasOverflow = true;
  }
  return { count: Math.min(count, MAX_DISPLAY_LANES), hasOverflow };
}

export function displayedNodeLane(lane: number, count: number) {
  return Math.min(lane, count);
}

/** The frontier holds a slot until its commit arrives, including across page boundaries. */
export function layoutCommitLanes(commits: readonly Commit[], hasMore = false): LaneRow[] {
  const visible = new Set(commits.map(commitKey));
  const frontier: (Lane | undefined)[] = [];
  const positions = new Map<string, number>();
  const seen = new Set<string>();
  const unresolved = new Set<string>();
  const firstFree = () => {
    const free = frontier.indexOf(undefined);
    return free < 0 ? frontier.length : free;
  };

  return commits.map((commit) => {
    const key = commitKey(commit);
    const previous = positions.get(key);
    const lane = previous ?? firstFree();
    const through = frontier.flatMap((entry, slot) =>
      entry && slot !== lane ? [{ lane: slot, repoRoot: entry.repoRoot }] : [],
    );
    frontier[lane] = undefined;
    positions.delete(key);
    seen.add(key);
    unresolved.delete(key);

    const parents: LaneEdge[] = [];
    let omittedParents = false;
    for (const sha of new Set(commit.parents)) {
      const parent = { repoRoot: commit.repoRoot, sha };
      const parentKey = commitKey(parent);
      if (seen.has(parentKey)) continue;
      if (!visible.has(parentKey)) {
        // Unmatched parents are common in filtered histories. Keep a small frontier
        // for page continuation without accumulating a lane for each filtered row.
        if (!hasMore) continue;
        if (!unresolved.has(parentKey) && unresolved.size >= MAX_DISPLAY_LANES) {
          omittedParents = true;
          continue;
        }
        unresolved.add(parentKey);
      }
      const slot = positions.get(parentKey) ?? firstFree();
      frontier[slot] = parent;
      positions.set(parentKey, slot);
      parents.push({ from: lane, to: slot, repoRoot: commit.repoRoot });
    }
    while (frontier.length > 0 && frontier.at(-1) === undefined) frontier.pop();
    return {
      lane,
      incoming: previous !== undefined,
      through,
      parents,
      ...(omittedParents ? { omittedParents } : {}),
    };
  });
}
