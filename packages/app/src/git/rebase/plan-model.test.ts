import { describe, expect, it } from "vitest";
import { compilePlan, createPlanRows } from "./plan-model";

const a = "a".repeat(40);
const b = "b".repeat(40);
const c = "c".repeat(64);
const [first, second, third] = createPlanRows([
  { sha: a, subject: "A" },
  { sha: b, subject: "B" },
  { sha: c, subject: "C" },
]);

describe("compilePlan", () => {
  it("submits the reordered commits with only the fields accepted by the RPC", () => {
    expect(
      compilePlan([
        { ...second, type: "reword", message: " Changed " },
        { ...third, type: "fixup" },
        { ...first, type: "drop" },
      ]),
    ).toEqual({
      steps: [
        { type: "reword", sha: b, message: "Changed" },
        { type: "fixup", sha: c },
        { type: "drop", sha: a },
      ],
    });
  });

  it("blocks a fold that moves before the first kept commit", () => {
    expect(
      compilePlan([
        { ...first, type: "drop" },
        { ...second, type: "squash" },
      ]),
    ).toEqual({ issue: "missingParent" });
  });

  it("rejects blank reword messages, repeated SHAs and unrecognized commit IDs", () => {
    expect(compilePlan([{ ...first, type: "reword", message: "\n  " }])).toEqual({
      issue: "missingMessage",
    });
    expect(compilePlan([first, first])).toEqual({ issue: "invalidCommit" });
    expect(compilePlan([{ ...first, sha: "HEAD" }])).toEqual({ issue: "invalidCommit" });
  });
});
