import { expect, it } from "vitest";
import { buildConflictQuote } from "./delegation";

it("quotes only the selected file with bounded three-way evidence and no write fingerprint", () => {
  const quote = buildConflictQuote({
    targetRepoRoot: "/repo",
    branch: "topic",
    rebaseId: "rebase-A",
    backupRef: "refs/paseo/backup/rebase-a",
    plannedSteps: 5,
    file: {
      path: "src/main.ts",
      status: "UU",
      conflictFingerprint: "opaque-snapshot",
      base: null,
      ours: null,
      theirs: null,
      hunks: Array.from({ length: 12 }, (_, index) => ({
        index,
        base: null,
        ours: "x".repeat(900),
        theirs: "incoming",
      })),
    },
  });
  const payload = JSON.parse(quote);
  expect(payload).toMatchObject({
    targetRepoRoot: "/repo",
    path: "src/main.ts",
    branch: "topic",
    rebaseId: "rebase-A",
    backupRef: "refs/paseo/backup/rebase-a",
    plannedSteps: 5,
    omittedHunks: 4,
  });
  expect(payload.hunks).toHaveLength(8);
  expect(payload.hunks[0]).toEqual({
    index: 0,
    base: null,
    ours: "x".repeat(500) + "…",
    theirs: "incoming",
  });
  expect(quote).not.toContain("opaque-snapshot");
});
