import { describe, expect, it } from "vitest";
import { displayedNodeLane, laneDisplay, layoutCommitLanes } from "./lanes";

function commit(repoRoot: string, sha: string, ...parents: string[]) {
  return { repoRoot, sha, parents };
}

describe("layoutCommitLanes", () => {
  it("shows all 16 interleaved repository tips and marks overflow without hiding nodes", () => {
    const tips = Array.from({ length: 16 }, (_, index) => commit(`/${index}`, "tip", "parent"));
    const parents = tips.map(({ repoRoot }) => commit(repoRoot, "parent"));
    const regular = layoutCommitLanes([...tips, ...parents]);
    expect(laneDisplay(regular)).toEqual({ count: 16, hasOverflow: false });
    expect(regular.slice(0, 16).map(({ lane }) => displayedNodeLane(lane, 16))).toEqual(
      Array.from({ length: 16 }, (_, index) => index),
    );
    const extra = layoutCommitLanes([...tips, commit("/0", "other"), ...parents]);
    expect(laneDisplay(extra)).toEqual({ count: 16, hasOverflow: true });
    expect(displayedNodeLane(extra[16]!.lane, 16)).toBe(16);
  });

  it("keeps both merge parents connected through an interleaved repository and a page boundary", () => {
    const firstPage = [
      commit("/a", "merge", "left", "right"),
      commit("/b", "left"),
      commit("/a", "left", "base"),
    ];
    const firstLayout = layoutCommitLanes(firstPage, true);
    const fullLayout = layoutCommitLanes([
      ...firstPage,
      commit("/a", "right", "base"),
      commit("/a", "base"),
    ]);
    expect(fullLayout.slice(0, firstPage.length)).toEqual(firstLayout);
    expect(fullLayout[0].parents).toEqual([
      { from: 0, to: 0, repoRoot: "/a" },
      { from: 0, to: 1, repoRoot: "/a" },
    ]);
    expect(fullLayout[1]).toMatchObject({
      incoming: false,
      through: [
        { lane: 0, repoRoot: "/a" },
        { lane: 1, repoRoot: "/a" },
      ],
    });
    expect(fullLayout[3]).toMatchObject({
      lane: 1,
      incoming: true,
      parents: [{ from: 1, to: 0, repoRoot: "/a" }],
    });
    expect(fullLayout[4]).toMatchObject({ lane: 0, incoming: true, parents: [] });
  });

  it("drops absent parents for completed filtered histories", () => {
    expect(
      layoutCommitLanes([commit("/repo", "new", "unmatched"), commit("/repo", "old")]),
    ).toEqual([
      { lane: 0, incoming: false, through: [], parents: [] },
      { lane: 0, incoming: false, through: [], parents: [] },
    ]);
  });
});
