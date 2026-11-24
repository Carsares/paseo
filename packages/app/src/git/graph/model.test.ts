import { expect, it } from "vitest";
import { referenceGroups } from "./ref-model";
import { compileFilters, emptyFilters, graphLayout } from "./model";

it.each([
  [719, "narrow"],
  [720, "medium"],
  [1039, "medium"],
  [1040, "wide"],
] as const)("uses the measured panel width %i", (width, layout) =>
  expect(graphLayout(width)).toBe(layout),
);

it("qualifies refs-prefixed short names and keeps complete backup references", () => {
  const sha = "a".repeat(40);
  const short = { name: "refs/heads/topic", sha };
  const backup = { name: "refs/paseo/backup/rebase-saved", sha };
  const groups = referenceGroups({
    repoRoot: "/repo",
    localBranches: [short],
    remotes: [{ name: "origin", branches: [short] }],
    tags: [short],
    backups: [backup],
  });
  expect(groups.flatMap(({ entries }) => entries)).toEqual([
    { ...short, ref: "refs/heads/refs/heads/topic" },
    { ...short, ref: "refs/remotes/origin/refs/heads/topic" },
    { ...short, ref: "refs/tags/refs/heads/topic" },
    { name: "rebase-saved", ref: backup.name, sha },
  ]);
});

it("includes both selected dates and keeps all four filter dimensions independent", () => {
  expect(
    compileFilters({
      branchFilter: " main ",
      authorFilter: " A ",
      textQuery: "^Fix ",
      regex: true,
      matchCase: true,
      since: "2024-02-29",
      until: "2024-03-01",
    }),
  ).toEqual({
    branchFilter: "main",
    authorFilter: "A",
    textQuery: "^Fix ",
    regex: true,
    matchCase: true,
    since: "2024-02-29T00:00:00.000Z",
    until: "2024-03-01T23:59:59.999Z",
  });
  expect(compileFilters({ ...emptyFilters, since: "2025-02-29" })).toBeNull();
  expect(compileFilters({ ...emptyFilters, since: "2025-01-10", until: "2025-01-09" })).toBeNull();
});
