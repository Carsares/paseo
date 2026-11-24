import { describe, expect, it } from "vitest";
import {
  resolveWorkingDiffComparisonFromState,
  selectCheckpointDiffInState,
  selectWorkingDiffComparisonInState,
  type WorkingDiffComparisonState,
  workingDiffComparisonKey,
} from "./state";

const checkout = { serverId: "server-1", workspaceId: "workspace-1", cwd: "/repo" };

function emptyState(): WorkingDiffComparisonState {
  return { overrides: {} };
}

describe("working diff comparison", () => {
  it("scopes selection to the workspace checkout rather than a panel", () => {
    expect(workingDiffComparisonKey(checkout)).toBe(
      "working-diff:server=server-1:workspace=workspace-1",
    );
    expect(workingDiffComparisonKey({ ...checkout, workspaceId: "workspace-2" })).not.toBe(
      workingDiffComparisonKey(checkout),
    );
    expect(workingDiffComparisonKey({ ...checkout, workspaceId: null, cwd: "/repo/" })).toBe(
      "working-diff:server=server-1:cwd=%2Frepo",
    );
  });

  it.each([true, false])("defaults to All changes when checkout dirtiness is %s", (isDirty) => {
    const status = { ...checkout, isDirty };
    expect(resolveWorkingDiffComparisonFromState(emptyState(), status)).toBe("all");
  });

  it.each(["all", "base", "uncommitted"] as const)(
    "keeps the selected %s comparison",
    (comparison) => {
      const selected = selectWorkingDiffComparisonInState(emptyState(), {
        ...checkout,
        comparison,
      });
      expect(resolveWorkingDiffComparisonFromState(selected, checkout)).toBe(comparison);
      expect(
        resolveWorkingDiffComparisonFromState(selected, { ...checkout, workspaceId: "other" }),
      ).toBe("all");
    },
  );

  it("keeps the live comparison when opening, switching and closing historical ranges", () => {
    const live = selectWorkingDiffComparisonInState(emptyState(), {
      ...checkout,
      comparison: "uncommitted",
    });
    const target = { agentId: "agent-1", messageId: "turn-1" };
    const turn = selectCheckpointDiffInState(live, {
      ...checkout,
      selection: { target, range: "turn" },
    });
    const baseline = selectCheckpointDiffInState(turn, {
      ...checkout,
      selection: { target, range: "baseline" },
    });
    const backToLive = selectCheckpointDiffInState(baseline, {
      ...checkout,
      selection: { target, range: null },
    });

    expect(baseline.overrides[workingDiffComparisonKey(checkout)]?.checkpoint).toEqual({
      target,
      range: "baseline",
    });
    expect(backToLive.overrides[workingDiffComparisonKey(checkout)]?.checkpoint).toEqual({
      target,
      range: null,
    });
    expect(resolveWorkingDiffComparisonFromState(backToLive, checkout)).toBe("uncommitted");
    expect(
      baseline.overrides[workingDiffComparisonKey({ ...checkout, workspaceId: "other" })],
    ).toBeUndefined();
  });
});
