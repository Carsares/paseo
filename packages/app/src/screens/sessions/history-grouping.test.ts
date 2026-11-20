import { PARENT_AGENT_ID_LABEL, parentAddressLabels } from "@getpaseo/protocol/agent-labels";
import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import {
  areAllHistoryWorkspacesCollapsed,
  buildHistoryProjectGroups,
  flattenHistoryProjectGroups,
  type HistoryRootAgentNode,
  type HistorySortOption,
  type HistoryWorkspaceGroup,
  resolveHistoryAgentTimestamp,
} from "./history-grouping";

function at(second: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, second));
}

function agent(id: string, second: number, fields: Partial<AggregatedAgent> = {}): AggregatedAgent {
  return {
    id,
    serverId: "mac",
    serverLabel: "MacBook",
    title: id,
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    provider: "codex",
    cwd: "/repos/atlas",
    workspaceId: "main",
    labels: {},
    createdAt: at(0),
    lastActivityAt: at(second),
    ...fields,
  };
}

function parent(agentId: string, serverId = "mac"): Record<string, string> {
  return parentAddressLabels({ agentId, serverId });
}

type Placement = NonNullable<AggregatedAgent["projectPlacement"]>;

function placement(
  fields: Partial<Omit<Placement, "checkout">> & { branch?: string | null } = {},
): Placement {
  const { branch, ...overrides } = fields;
  const checkout = { cwd: "/repos/atlas", remoteUrl: null, isPaseoOwnedWorktree: false } as const;
  return {
    projectKey: "atlas",
    projectName: "Atlas",
    checkout:
      branch === undefined
        ? { ...checkout, isGit: false, currentBranch: null, worktreeRoot: null, mainRepoRoot: null }
        : {
            ...checkout,
            isGit: true,
            currentBranch: branch,
            worktreeRoot: checkout.cwd,
            mainRepoRoot: null,
          },
    ...overrides,
  };
}

function sessionIds(node: HistoryRootAgentNode) {
  return [node.agent.id, node.subagents.map(({ agent: child }) => child.id)];
}

function workspaceKey(workspace: HistoryWorkspaceGroup): string {
  return workspace.key;
}

function rootKey(node: HistoryRootAgentNode): string {
  return node.key;
}

describe("resolveHistoryAgentTimestamp", () => {
  it.each([undefined, null, "", "invalid"])(
    "falls back to last activity when the workspace archive date is %s",
    (workspaceArchivedAt) => {
      const entry = agent("no-archive-date", 9, {
        archivedAt: null,
        projectPlacement: placement({ workspaceArchivedAt }),
      });
      expect(resolveHistoryAgentTimestamp(entry, "archived_at")).toBe(entry.lastActivityAt);
    },
  );

  it("skips an invalid agent archive date even when workspace placement is missing", () => {
    const entry = agent("invalid-archive-date", 9, { archivedAt: new Date(Number.NaN) });
    const workspaceArchive = at(20);

    expect(
      resolveHistoryAgentTimestamp(
        {
          ...entry,
          projectPlacement: placement({ workspaceArchivedAt: workspaceArchive.toISOString() }),
        },
        "archived_at",
      ),
    ).toEqual(workspaceArchive);
    expect(resolveHistoryAgentTimestamp(entry, "archived_at")).toBe(entry.lastActivityAt);
  });
});

describe("buildHistoryProjectGroups", () => {
  const sortCases: {
    sort: HistorySortOption;
    projects: [string, number][];
    workspaces: [string, number][];
    roots: [string, number][];
    children: [string, number][];
  }[] = [
    {
      sort: { field: "updated_at", direction: "desc" },
      projects: [
        ["mac:other", 52],
        ["eq:atlas", 48],
      ],
      workspaces: [
        ["mac:main", 48],
        ["mac:branch", 33],
        ["linux:main", 19],
      ],
      roots: [
        ["mac:root", 48],
        ["mac:standalone", 28],
      ],
      children: [
        ["late-child", 48],
        ["early-child", 6],
      ],
    },
    {
      sort: { field: "updated_at", direction: "asc" },
      projects: [
        ["eq:atlas", 6],
        ["mac:other", 52],
      ],
      workspaces: [
        ["mac:main", 6],
        ["linux:main", 19],
        ["mac:branch", 33],
      ],
      roots: [
        ["mac:root", 6],
        ["mac:standalone", 28],
      ],
      children: [
        ["early-child", 6],
        ["late-child", 48],
      ],
    },
    {
      sort: { field: "created_at", direction: "desc" },
      projects: [
        ["eq:atlas", 8],
        ["mac:other", 3],
      ],
      workspaces: [
        ["mac:main", 8],
        ["mac:branch", 7],
        ["linux:main", 4],
      ],
      roots: [
        ["mac:standalone", 8],
        ["mac:root", 5],
      ],
      children: [
        ["early-child", 5],
        ["late-child", 2],
      ],
    },
    {
      sort: { field: "created_at", direction: "asc" },
      projects: [
        ["eq:atlas", 1],
        ["mac:other", 3],
      ],
      workspaces: [
        ["mac:main", 1],
        ["linux:main", 4],
        ["mac:branch", 7],
      ],
      roots: [
        ["mac:root", 1],
        ["mac:standalone", 8],
      ],
      children: [
        ["late-child", 2],
        ["early-child", 5],
      ],
    },
    {
      sort: { field: "archived_at", direction: "desc" },
      projects: [
        ["eq:atlas", 45],
        ["mac:other", 16],
      ],
      workspaces: [
        ["linux:main", 45],
        ["mac:main", 35],
        ["mac:branch", 20],
      ],
      roots: [
        ["mac:root", 35],
        ["mac:standalone", 22],
      ],
      children: [
        ["early-child", 35],
        ["late-child", 18],
      ],
    },
    {
      sort: { field: "archived_at", direction: "asc" },
      projects: [
        ["mac:other", 16],
        ["eq:atlas", 18],
      ],
      workspaces: [
        ["mac:main", 18],
        ["mac:branch", 20],
        ["linux:main", 45],
      ],
      roots: [
        ["mac:root", 18],
        ["mac:standalone", 22],
      ],
      children: [
        ["late-child", 18],
        ["early-child", 35],
      ],
    },
  ];

  it.each(sortCases)(
    "sorts every level and aggregates equivalent projects with $sort.field $sort.direction",
    ({ sort, projects, workspaces, roots, children }) => {
      const main = placement({
        projectKey: "local-atlas",
        projectEquivalenceKey: "atlas",
        workspaceArchivedAt: at(35).toISOString(),
      });
      const groups = buildHistoryProjectGroups({
        sort,
        entries: [
          agent("root", 12, { createdAt: at(1), archivedAt: at(25), projectPlacement: main }),
          agent("early-child", 6, {
            createdAt: at(5),
            archivedAt: null,
            labels: parent("root"),
            projectPlacement: main,
          }),
          agent("late-child", 48, {
            createdAt: at(2),
            archivedAt: at(18),
            labels: parent("root"),
            projectPlacement: main,
          }),
          agent("standalone", 28, { createdAt: at(8), archivedAt: at(22), projectPlacement: main }),
          agent("branch", 33, {
            workspaceId: "branch",
            createdAt: at(7),
            archivedAt: at(20),
            projectPlacement: main,
          }),
          agent("linux-root", 19, {
            serverId: "linux",
            createdAt: at(4),
            archivedAt: at(45),
            projectPlacement: placement({
              projectKey: "linux-atlas",
              projectEquivalenceKey: "atlas",
            }),
          }),
          agent("other", 52, {
            workspaceId: "other",
            createdAt: at(3),
            archivedAt: at(16),
            projectPlacement: placement({ projectKey: "other" }),
          }),
        ],
      });
      const merged = groups.find(({ key }) => key === "eq:atlas");
      const mainWorkspace = merged?.workspaces.find(({ key }) => key === "mac:main");
      const family = mainWorkspace?.rootAgents.find(({ key }) => key === "mac:root");

      expect(groups.map(({ key, sortTimestamp }) => [key, sortTimestamp])).toEqual(
        projects.map(([key, second]) => [key, at(second)]),
      );
      expect(merged?.workspaces.map(({ key, sortTimestamp }) => [key, sortTimestamp])).toEqual(
        workspaces.map(([key, second]) => [key, at(second)]),
      );
      expect(
        mainWorkspace?.rootAgents.map(({ key, sortTimestamp }) => [key, sortTimestamp]),
      ).toEqual(roots.map(([key, second]) => [key, at(second)]));
      expect(
        family?.subagents.map(({ agent: child, sortTimestamp }) => [child.id, sortTimestamp]),
      ).toEqual(children.map(([id, second]) => [id, at(second)]));
      expect([
        merged?.latestActivityAt,
        mainWorkspace?.latestActivityAt,
        family?.latestActivityAt,
      ]).toEqual([at(48), at(48), at(48)]);
    },
  );

  it.each(["desc", "asc"] as const)(
    "keeps invalid creation dates from changing group timestamps in %s order",
    (direction) => {
      const invalidDate = new Date(Number.NaN);
      const groups = buildHistoryProjectGroups({
        sort: { field: "created_at", direction },
        entries: [
          agent("root", 30, { createdAt: invalidDate }),
          agent("child", 20, { labels: parent("root"), createdAt: at(10) }),
          agent("unknown", 40, {
            createdAt: invalidDate,
            workspaceId: "unknown",
            projectPlacement: placement({ projectKey: "unknown", projectName: "Aardvark" }),
          }),
        ],
      });

      expect(groups.map(({ key }) => key)).toEqual(["mac:/repos/atlas", "mac:unknown"]);
      expect(groups[0]).toMatchObject({
        sortTimestamp: at(10),
        workspaces: [{ sortTimestamp: at(10), rootAgents: [{ sortTimestamp: at(10) }] }],
      });
    },
  );

  it.each([
    { direction: "desc", ancestorSecond: 59, expectedSecond: 20 },
    { direction: "asc", ancestorSecond: 0, expectedSecond: 10 },
  ] as const)(
    "ignores ancestor shell dates when sorting $direction",
    ({ direction, ancestorSecond, expectedSecond }) => {
      const root = agent("root", 55, { createdAt: at(ancestorSecond) });
      const groups = buildHistoryProjectGroups({
        entries: [
          agent("first-match", 30, { labels: parent(root.id), createdAt: at(10) }),
          agent("second-match", 25, { labels: parent(root.id), createdAt: at(20) }),
        ],
        ancestors: [root],
        search: "match",
        sort: { field: "created_at", direction },
      });

      expect(groups).toMatchObject([
        {
          latestActivityAt: at(30),
          sortTimestamp: at(expectedSecond),
          workspaces: [
            {
              latestActivityAt: at(30),
              sortTimestamp: at(expectedSecond),
              rootAgents: [
                {
                  agent: root,
                  isAncestorShell: true,
                  latestActivityAt: at(30),
                  sortTimestamp: at(expectedSecond),
                },
              ],
            },
          ],
        },
      ]);
    },
  );

  it("groups and sorts projects, workspaces, roots and descendants by their latest visible activity", () => {
    const main = { projectPlacement: placement({ workspaceName: "Main" }) };
    const branch = {
      workspaceId: "branch",
      cwd: "/repos/atlas/.paseo/worktrees/branch",
      projectPlacement: placement({ workspaceName: "Branch", branch: "feature" }),
    };
    const root = agent("root", 5, main);
    const olderChild = agent("a-older-child", 8, { ...main, labels: parent(root.id) });
    const newerChild = agent("z-newer-child", 51, { ...main, labels: parent(root.id) });
    const otherRoot = agent("other-root", 34, main);
    const branchRoot = agent("branch-root", 43, branch);
    const quiet = agent("quiet", 12, {
      workspaceId: "aardvark",
      cwd: "/repos/aardvark",
      projectPlacement: placement({ projectKey: "aardvark", projectName: "Aardvark" }),
    });

    const groups = buildHistoryProjectGroups({
      entries: Object.freeze([olderChild, quiet, branchRoot, root, otherRoot, newerChild]),
    });

    expect(groups.map(({ key, latestActivityAt }) => [key, latestActivityAt])).toEqual([
      ["mac:atlas", at(51)],
      ["mac:aardvark", at(12)],
    ]);
    expect(
      groups[0]?.workspaces.map(({ key, latestActivityAt }) => [key, latestActivityAt]),
    ).toEqual([
      ["mac:main", at(51)],
      ["mac:branch", at(43)],
    ]);
    expect(groups[0]?.workspaces[1]?.rootAgents.map((node) => node.agent)).toEqual([branchRoot]);
    expect(groups[0]?.workspaces[0]?.rootAgents).toEqual([
      {
        key: "mac:root",
        agent: root,
        isAncestorShell: false,
        latestActivityAt: at(51),
        sortTimestamp: at(51),
        hasSearchMatchedSubagent: false,
        subagents: [
          { agent: newerChild, sortTimestamp: at(51) },
          { agent: olderChild, sortTimestamp: at(8) },
        ],
      },
      {
        key: "mac:other-root",
        agent: otherRoot,
        isAncestorShell: false,
        latestActivityAt: at(34),
        sortTimestamp: at(34),
        hasSearchMatchedSubagent: false,
        subagents: [],
      },
    ]);
  });

  it("breaks activity ties by project name and key, workspace name and key, and agent keys", () => {
    const z = agent("z", 10, { projectPlacement: placement({ workspaceName: "Zulu" }) });
    const a = agent("a", 10, { projectPlacement: z.projectPlacement });
    const c = agent("c", 10, { projectPlacement: z.projectPlacement, labels: parent(a.id) });
    const b = agent("b", 10, { projectPlacement: z.projectPlacement, labels: parent(a.id) });
    const w1 = agent("w1", 10, {
      workspaceId: "w1",
      projectPlacement: placement({ workspaceName: "Alpha" }),
    });
    const w2 = agent("w2", 10, { workspaceId: "w2", projectPlacement: w1.projectPlacement });
    const beta = agent("beta", 10, {
      workspaceId: "beta",
      projectPlacement: placement({ projectKey: "a-beta", projectName: "Beta" }),
    });
    const atlas2 = agent("atlas2", 10, {
      workspaceId: "atlas2",
      projectPlacement: placement({ projectKey: "z-atlas", projectName: "Atlas" }),
    });
    const entries = [z, c, w2, beta, atlas2, b, a, w1];
    const groups = buildHistoryProjectGroups({ entries });

    expect(groups.map(({ key }) => key)).toEqual(["mac:atlas", "mac:z-atlas", "mac:a-beta"]);
    expect(groups[0]?.workspaces.map(({ key }) => key)).toEqual(["mac:w1", "mac:w2", "mac:main"]);
    expect(groups[0]?.workspaces[2]?.rootAgents.map(({ key }) => key)).toEqual(["mac:a", "mac:z"]);
    expect(groups[0]?.workspaces[2]?.rootAgents[0]?.subagents).toEqual([
      { agent: b, sortTimestamp: at(10) },
      { agent: c, sortTimestamp: at(10) },
    ]);
    expect(buildHistoryProjectGroups({ entries: entries.toReversed() })).toEqual(groups);
    expect(
      buildHistoryProjectGroups({ entries, sort: { field: "updated_at", direction: "asc" } }),
    ).toEqual(groups);
  });

  it("flattens every level of the parent chain and prefers the matching root over its ancestor copy", () => {
    const root = agent("root", 40);
    const child = agent("child", 50, { labels: parent(root.id) });
    const grandchild = agent("grandchild", 24, { labels: parent(child.id) });
    const greatGrandchild = agent("great-grandchild", 31, { labels: parent(grandchild.id) });

    const groups = buildHistoryProjectGroups({
      entries: [grandchild, greatGrandchild, root, child],
      ancestors: [{ ...root, title: "Stale ancestor copy" }],
    });

    expect(groups[0]?.workspaces[0]?.rootAgents).toEqual([
      {
        key: "mac:root",
        agent: root,
        isAncestorShell: false,
        latestActivityAt: at(50),
        sortTimestamp: at(50),
        hasSearchMatchedSubagent: false,
        subagents: [
          { agent: child, sortTimestamp: at(50) },
          { agent: greatGrandchild, sortTimestamp: at(31) },
          { agent: grandchild, sortTimestamp: at(24) },
        ],
      },
    ]);
  });

  it("uses only the root as context when the grandchild is the sole matching entry", () => {
    const root = agent("root", 50);
    const child = agent("child", 60, { labels: parent(root.id) });
    const grandchild = agent("grandchild", 24, { labels: parent(child.id) });

    const groups = buildHistoryProjectGroups({
      entries: [grandchild],
      ancestors: [child, root],
      search: "grandchild",
    });

    expect(groups[0]?.workspaces[0]?.rootAgents).toEqual([
      {
        key: "mac:root",
        agent: root,
        isAncestorShell: true,
        latestActivityAt: at(24),
        sortTimestamp: at(24),
        hasSearchMatchedSubagent: true,
        subagents: [{ agent: grandchild, sortTimestamp: at(24) }],
      },
    ]);
  });

  it("keeps every matching entry exactly once when parent labels form a cycle", () => {
    const first = agent("first", 12, { labels: parent("second") });
    const second = agent("second", 23, { labels: parent(first.id) });
    const descendant = agent("a-descendant", 33, { labels: parent(second.id) });
    const self = agent("self", 2, { labels: parent("self") });
    const groups = buildHistoryProjectGroups({ entries: [second, self, first, descendant] });

    expect(groups[0]?.workspaces[0]?.rootAgents).toEqual([
      {
        key: "mac:first",
        agent: first,
        isAncestorShell: false,
        latestActivityAt: at(33),
        sortTimestamp: at(33),
        hasSearchMatchedSubagent: false,
        subagents: [
          { agent: descendant, sortTimestamp: at(33) },
          { agent: second, sortTimestamp: at(23) },
        ],
      },
      {
        key: "mac:self",
        agent: self,
        isAncestorShell: false,
        latestActivityAt: at(2),
        sortTimestamp: at(2),
        hasSearchMatchedSubagent: false,
        subagents: [],
      },
    ]);
  });

  it("stops parent traversal across workspaces or hosts and when a parent is missing", () => {
    const root = agent("root", 10);
    const crossWorkspaceChild = agent("cross-workspace", 23, {
      workspaceId: "child-workspace",
      labels: parent(root.id),
    });
    const sameWorkspaceGrandchild = agent("same-workspace", 25, {
      workspaceId: " child-workspace ",
      labels: parent(crossWorkspaceChild.id),
    });
    const crossHostChild = agent("cross-host", 20, {
      serverId: "linux",
      serverLabel: "Linux",
      labels: parent(root.id),
    });
    const sameHostGrandchild = agent("same-host", 21, {
      serverId: "linux",
      serverLabel: "Linux",
      labels: { [PARENT_AGENT_ID_LABEL]: crossHostChild.id },
    });
    const missingParent = agent("missing-parent", 15, { labels: parent("missing") });
    const groups = buildHistoryProjectGroups({
      entries: [
        root,
        crossWorkspaceChild,
        sameWorkspaceGrandchild,
        crossHostChild,
        sameHostGrandchild,
        missingParent,
      ],
    });
    const workspaces = groups.flatMap((group) => group.workspaces);

    expect(
      workspaces.map(({ key, rootAgents }) => ({ key, roots: rootAgents.map(sessionIds) })),
    ).toEqual([
      { key: "mac:child-workspace", roots: [["cross-workspace", ["same-workspace"]]] },
      {
        key: "mac:main",
        roots: [
          ["missing-parent", []],
          ["root", []],
        ],
      },
      { key: "linux:main", roots: [["cross-host", ["same-host"]]] },
    ]);
  });

  it("preserves ancestry without workspace IDs only when the working directory is shared", () => {
    const placementForLegacy = placement({ workspaceName: "  " });
    const legacyFields = {
      workspaceId: " ",
      cwd: String.raw`C:\repos\atlas`,
      projectPlacement: placementForLegacy,
    };
    const root = agent("root", 12, legacyFields);
    const child = agent("child", 14, { ...legacyFields, labels: parent(root.id) });
    const elsewhere = agent("elsewhere", 15, {
      workspaceId: undefined,
      cwd: "/repos/atlas/elsewhere/",
      labels: parent(root.id),
      projectPlacement: placementForLegacy,
    });

    const groups = buildHistoryProjectGroups({ entries: [root, child, elsewhere] });

    expect(
      groups[0]?.workspaces.map(({ key, workspaceId, workspaceName, rootAgents }) => ({
        key,
        workspaceId,
        workspaceName,
        roots: rootAgents.map(sessionIds),
      })),
    ).toEqual([
      {
        key: "mac:cwd:/repos/atlas/elsewhere/",
        workspaceId: undefined,
        workspaceName: "elsewhere",
        roots: [["elsewhere", []]],
      },
      {
        key: String.raw`mac:cwd:C:\repos\atlas`,
        workspaceId: undefined,
        workspaceName: "atlas",
        roots: [["root", ["child"]]],
      },
    ]);
  });

  it("brings in the active root of archived matches and excludes activity from non-matching ancestors", () => {
    const root = agent("active-root", 50, { archivedAt: null });
    const archivedChild = agent("archived-child", 4, {
      archivedAt: at(30),
      labels: parent(root.id),
    });
    const archivedGrandchild = agent("archived-grandchild", 8, {
      archivedAt: at(30),
      labels: parent(archivedChild.id),
    });
    const standalone = agent("standalone", 13, { archivedAt: at(20) });
    const otherAncestor = agent("other", 60, { workspaceId: "elsewhere", cwd: "/repos/other" });

    const groups = buildHistoryProjectGroups({
      entries: [archivedChild, archivedGrandchild, standalone],
      ancestors: [root, otherAncestor],
    });

    expect(groups.map(({ latestActivityAt }) => latestActivityAt)).toEqual([at(13)]);
    expect(groups[0]?.workspaces.map(({ key }) => key)).toEqual(["mac:main"]);
    expect(groups[0]?.workspaces[0]?.rootAgents).toMatchObject([
      { key: "mac:standalone", isAncestorShell: false, latestActivityAt: at(13), subagents: [] },
      {
        key: "mac:active-root",
        agent: root,
        isAncestorShell: true,
        latestActivityAt: at(8),
        subagents: [{ agent: archivedGrandchild }, { agent: archivedChild }],
      },
    ]);
    expect(buildHistoryProjectGroups({ entries: [], ancestors: [root] })).toEqual([]);
  });

  it("prefers explicit workspace archive status and falls back only for legacy hosts with known active IDs", () => {
    const entries = [
      agent("explicit-archived", 7, {
        workspaceId: "explicit-archived",
        projectPlacement: placement({ workspaceArchivedAt: at(5).toISOString() }),
      }),
      agent("explicit-active", 6, {
        workspaceId: "explicit-active",
        projectPlacement: placement({
          workspaceArchivedAt: null,
          workspaceName: " Active ",
          branch: "main",
        }),
      }),
      agent("empty-timestamp", 5, {
        workspaceId: "empty-timestamp",
        projectPlacement: placement({ workspaceArchivedAt: "", branch: null }),
      }),
      agent("legacy-archived", 4, {
        workspaceId: "legacy-archived",
        projectPlacement: placement(),
      }),
      agent("legacy-active", 3, { workspaceId: " legacy-active ", projectPlacement: placement() }),
      agent("legacy-missing-id", 2, { workspaceId: undefined, projectPlacement: placement() }),
      agent("unknown-host", 1, {
        serverId: "linux",
        workspaceId: "main",
        projectPlacement: placement(),
      }),
    ];
    const groups = buildHistoryProjectGroups({
      entries,
      activeWorkspaceIdsByServer: new Map([
        ["mac", new Set(["explicit-archived", "legacy-active"])],
      ]),
    });
    const workspaces = groups.flatMap((group) => group.workspaces);

    expect(workspaces.map((workspace) => [workspace.key, workspace.isWorkspaceArchived])).toEqual([
      ["mac:explicit-archived", true],
      ["mac:explicit-active", false],
      ["mac:empty-timestamp", false],
      ["mac:legacy-archived", true],
      ["mac:legacy-active", false],
      ["mac:cwd:/repos/atlas", false],
      ["linux:main", false],
    ]);
    expect(groups[0]?.workspaces[1]).toMatchObject({ workspaceName: "Active", branch: "main" });
    expect(groups[0]?.workspaces[2]?.branch).toBeNull();
    expect(groups[0]?.workspaces[3]?.branch).toBeNull();
  });

  it("merges equivalent projects across hosts while retaining host-specific workspace and session identities", () => {
    const remote = "remote:github.com/acme/atlas";
    const alpha = placement({ projectKey: "local-alpha", projectEquivalenceKey: remote });
    const beta = placement({ projectKey: "local-beta", projectEquivalenceKey: remote });
    const entries = [
      agent("same-id", 7, { projectPlacement: alpha }),
      agent("other", 8, { workspaceId: "other", projectPlacement: alpha }),
      agent("legacy-workspace", 6, {
        workspaceId: "legacy",
        projectPlacement: placement({ projectKey: "local-alpha" }),
      }),
      agent("same-id", 9, {
        serverId: "linux",
        serverLabel: "Linux",
        cwd: "/opt/atlas",
        projectPlacement: beta,
      }),
    ];

    const groups = buildHistoryProjectGroups({ entries });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: `eq:${remote}`,
      projectName: "Atlas",
      serverId: "linux",
      projectId: "local-beta",
      cwd: "/opt/atlas",
      latestActivityAt: at(9),
    });
    expect(
      groups[0]?.workspaces.map(({ key, serverLabel, rootAgents }) => [
        key,
        serverLabel,
        rootAgents.map(rootKey),
      ]),
    ).toEqual([
      ["linux:main", "Linux", ["linux:same-id"]],
      ["mac:other", "MacBook", ["mac:other"]],
      ["mac:main", "MacBook", ["mac:same-id"]],
      ["mac:legacy", "MacBook", ["mac:legacy-workspace"]],
    ]);
  });

  it("falls back to host-local projects for repeated equivalence keys on that host", () => {
    const remote = "remote:github.com/acme/atlas";
    const entries = [
      agent("first", 21, {
        projectPlacement: placement({ projectKey: "first", projectEquivalenceKey: remote }),
      }),
      agent("second", 20, {
        workspaceId: "second",
        projectPlacement: placement({ projectKey: "second", projectEquivalenceKey: remote }),
      }),
      agent("other-host", 19, {
        serverId: "linux",
        projectPlacement: placement({ projectKey: "first", projectEquivalenceKey: remote }),
      }),
      agent("legacy", 12, {
        workspaceId: "legacy",
        projectPlacement: placement({ projectKey: "legacy", projectEquivalenceKey: " " }),
      }),
      agent("legacy", 10, {
        serverId: "linux",
        workspaceId: "legacy",
        projectPlacement: placement({ projectKey: "legacy", projectEquivalenceKey: null }),
      }),
    ];

    expect(
      buildHistoryProjectGroups({ entries }).map(({ key, workspaces }) => [
        key,
        workspaces.map(workspaceKey),
      ]),
    ).toEqual([
      ["mac:first", ["mac:main"]],
      ["mac:second", ["mac:second"]],
      [`eq:${remote}`, ["linux:main"]],
      ["mac:legacy", ["mac:legacy"]],
      ["linux:legacy", ["linux:legacy"]],
    ]);
  });
});

describe("flattenHistoryProjectGroups", () => {
  const root = agent("root", 40);
  const titledChild = agent("titled-child", 20, {
    title: "Analysis of history",
    labels: parent(root.id),
  });
  const branchChild = agent("branch-child", 30, {
    title: null,
    labels: parent(root.id),
    projectPlacement: placement({ branch: "feature/history" }),
  });

  it("emits the headers and roots in order and folds descendants by default", () => {
    const groups = buildHistoryProjectGroups({
      entries: [root, titledChild, branchChild],
      search: "  ",
    });
    const items = flattenHistoryProjectGroups({
      groups,
      expandedOverrides: new Map(),
      isSearching: false,
    });

    expect(items).toMatchObject([
      { type: "project-header", project: { key: "mac:/repos/atlas" }, expanded: true },
      {
        type: "workspace-header",
        workspace: { key: "mac:main" },
        expanded: true,
        showProjectBadge: false,
      },
      {
        type: "root-agent",
        node: { key: "mac:root", hasSearchMatchedSubagent: false },
        expanded: false,
      },
    ]);
    expect(
      flattenHistoryProjectGroups({ groups: [], expandedOverrides: new Map(), isSearching: true }),
    ).toEqual([]);
  });

  it("folds one workspace without hiding its siblings and folds all rows under a closed project", () => {
    const sibling = agent("sibling", 35, {
      workspaceId: "sibling",
      projectPlacement: placement({ projectKey: "/repos/atlas" }),
    });
    const otherProjectRoot = agent("other-project", 25, {
      workspaceId: "other",
      projectPlacement: placement({ projectKey: "other", projectName: "Other" }),
    });
    const groups = buildHistoryProjectGroups({
      entries: [root, titledChild, sibling, otherProjectRoot],
    });
    const input = {
      groups,
      expandedOverrides: new Map([["mac:root", true]]),
      isSearching: false,
    };

    expect(flattenHistoryProjectGroups(input).map(({ key }) => key)).toEqual([
      "project:mac:/repos/atlas",
      "workspace:mac:main",
      "root-agent:mac:root",
      "subagent:mac:titled-child",
      "workspace:mac:sibling",
      "root-agent:mac:sibling",
      "project:mac:other",
      "workspace:mac:other",
      "root-agent:mac:other-project",
    ]);
    expect(
      flattenHistoryProjectGroups({
        ...input,
        workspaceExpandedOverrides: new Map([["mac:main", false]]),
      }),
    ).toMatchObject([
      { key: "project:mac:/repos/atlas", expanded: true },
      { key: "workspace:mac:main", expanded: false },
      { key: "workspace:mac:sibling", expanded: true },
      { key: "root-agent:mac:sibling" },
      { key: "project:mac:other", expanded: true },
      { key: "workspace:mac:other", expanded: true },
      { key: "root-agent:mac:other-project" },
    ]);
    expect(
      flattenHistoryProjectGroups({
        ...input,
        projectExpandedOverrides: new Map([["mac:/repos/atlas", false]]),
        workspaceExpandedOverrides: new Map([["mac:main", true]]),
      }),
    ).toMatchObject([
      { key: "project:mac:/repos/atlas", expanded: false },
      { key: "project:mac:other", expanded: true },
      { key: "workspace:mac:other", expanded: true },
      { key: "root-agent:mac:other-project" },
    ]);
  });

  it.each([
    { direction: "desc", workspaceIds: ["main", "other", "branch"] },
    { direction: "asc", workspaceIds: ["branch", "other", "main"] },
  ] as const)(
    "streams workspaces across projects in $direction order",
    ({ direction, workspaceIds }) => {
      const atlas = placement();
      const sort = { field: "created_at", direction } as const;
      const groups = buildHistoryProjectGroups({
        sort,
        entries: [
          { ...root, createdAt: at(30), projectPlacement: atlas },
          { ...titledChild, createdAt: at(29), projectPlacement: atlas },
          agent("branch", 50, {
            workspaceId: "branch",
            createdAt: at(10),
            projectPlacement: atlas,
          }),
          agent("other", 10, {
            workspaceId: "other",
            createdAt: at(20),
            projectPlacement: placement({ projectKey: "other", projectName: "Other" }),
          }),
        ],
      });
      const items = flattenHistoryProjectGroups({
        groups,
        groupMode: "workspace",
        sort,
        expandedOverrides: new Map([["mac:root", true]]),
        projectExpandedOverrides: new Map([["mac:atlas", false]]),
        workspaceExpandedOverrides: new Map([["mac:branch", false]]),
        isSearching: false,
      });

      const headers = items.filter((item) => item.type === "workspace-header");
      expect(
        headers.map(({ workspace, showProjectBadge, expanded }) => [
          workspace.workspaceId,
          showProjectBadge,
          expanded,
        ]),
      ).toEqual(workspaceIds.map((id) => [id, true, id !== "branch"]));
      for (const { project, workspace } of headers) {
        expect(project).toBe(groups.find((group) => group.workspaces.includes(workspace)));
      }

      const rowsByWorkspace = {
        main: ["workspace:mac:main", "root-agent:mac:root", "subagent:mac:titled-child"],
        other: ["workspace:mac:other", "root-agent:mac:other"],
        branch: ["workspace:mac:branch"],
      };
      expect(items.map(({ key }) => key)).toEqual(
        workspaceIds.flatMap((id) => rowsByWorkspace[id]),
      );
    },
  );

  it("breaks workspace stream ties by workspace name, project name, then workspace key", () => {
    const atlas = placement({ workspaceName: "Shared" });
    const groups = buildHistoryProjectGroups({
      entries: [
        agent("first", 10, { workspaceId: "c", projectPlacement: atlas }),
        agent("second", 10, { workspaceId: "b", projectPlacement: atlas }),
        agent("third", 10, {
          workspaceId: "a",
          projectPlacement: placement({
            projectKey: "beta",
            projectName: "Beta",
            workspaceName: "Shared",
          }),
        }),
        agent("fourth", 10, {
          workspaceId: "z",
          projectPlacement: placement({
            projectKey: "beta",
            projectName: "Beta",
            workspaceName: "First",
          }),
        }),
        agent("latest", 11, {
          workspaceId: "latest",
          projectPlacement: placement({ workspaceName: "Zulu" }),
        }),
      ],
    });

    const items = flattenHistoryProjectGroups({
      groups,
      groupMode: "workspace",
      expandedOverrides: new Map(),
      isSearching: false,
    });

    expect(
      items
        .filter((item) => item.type === "workspace-header")
        .map(({ workspace }) => workspace.key),
    ).toEqual(["mac:latest", "mac:z", "mac:b", "mac:c", "mac:a"]);
  });

  it("breaks workspace stream ties when distinct keys collate as equal", () => {
    const groups = buildHistoryProjectGroups({
      entries: [
        agent("composed", 10, {
          workspaceId: "caf\u00e9",
          projectPlacement: placement({ projectKey: "one", workspaceName: "Shared" }),
        }),
        agent("decomposed", 10, {
          workspaceId: "cafe\u0301",
          projectPlacement: placement({ projectKey: "two", workspaceName: "Shared" }),
        }),
      ],
    });
    const input = {
      groupMode: "workspace",
      expandedOverrides: new Map(),
      isSearching: false,
    } as const;

    for (const projects of [groups, groups.toReversed()]) {
      const keys = flattenHistoryProjectGroups({ ...input, groups: projects })
        .filter((item) => item.type === "workspace-header")
        .map(({ workspace }) => workspace.key);

      expect(keys).toEqual(["mac:cafe\u0301", "mac:caf\u00e9"]);
    }
  });

  it.each([
    { search: "  analysys ", child: titledChild },
    { search: "feature/history", child: branchChild },
  ])(
    "auto-expands a child returned by the host for $search and respects manual collapse",
    ({ search, child }) => {
      const other = agent("matching-root-only", 50, {
        title: search.trim(),
        projectPlacement: child.projectPlacement,
      });
      const groups = buildHistoryProjectGroups({
        entries: [child, other],
        ancestors: [root],
        search,
      });
      const items = flattenHistoryProjectGroups({
        groups,
        expandedOverrides: new Map(),
        isSearching: true,
      });

      expect(items).toMatchObject([
        { type: "project-header" },
        { type: "workspace-header" },
        {
          type: "root-agent",
          node: { key: "mac:matching-root-only", hasSearchMatchedSubagent: false },
          expanded: false,
        },
        {
          type: "root-agent",
          node: { key: "mac:root", isAncestorShell: true, hasSearchMatchedSubagent: true },
          expanded: true,
        },
        { type: "subagent", agent: child, parentKey: "mac:root" },
      ]);
      expect(new Set(items.map(({ key }) => key)).size).toBe(items.length);
      expect(
        flattenHistoryProjectGroups({
          groups,
          expandedOverrides: new Map([["mac:root", false]]),
          isSearching: true,
        }),
      ).toMatchObject([
        { type: "project-header" },
        { type: "workspace-header" },
        { type: "root-agent", node: { key: "mac:matching-root-only" }, expanded: false },
        { type: "root-agent", node: { key: "mac:root" }, expanded: false },
      ]);
    },
  );

  it("expands descendants in activity order when manually opened outside search", () => {
    const groups = buildHistoryProjectGroups({ entries: [root, titledChild, branchChild] });

    expect(
      flattenHistoryProjectGroups({
        groups,
        expandedOverrides: new Map([["mac:root", true]]),
        isSearching: false,
      }),
    ).toMatchObject([
      { type: "project-header" },
      { type: "workspace-header" },
      { type: "root-agent", node: { key: "mac:root" }, expanded: true },
      { type: "subagent", agent: branchChild, parentKey: "mac:root" },
      { type: "subagent", agent: titledChild, parentKey: "mac:root" },
    ]);
  });
});

describe("bulk workspace expansion", () => {
  const groups = buildHistoryProjectGroups({
    entries: [
      agent("main-root", 30, { projectPlacement: placement() }),
      agent("branch-root", 20, { workspaceId: "branch", projectPlacement: placement() }),
      agent("other-root", 10, {
        workspaceId: "other",
        projectPlacement: placement({ projectKey: "other" }),
      }),
    ],
  });

  it("uses the bulk default for each workspace without an explicit override", () => {
    expect(areAllHistoryWorkspacesCollapsed({ groups, workspaceExpandedByDefault: false })).toBe(
      true,
    );
    expect(areAllHistoryWorkspacesCollapsed({ groups, workspaceExpandedByDefault: true })).toBe(
      false,
    );
    expect(
      areAllHistoryWorkspacesCollapsed({ groups: [], workspaceExpandedByDefault: false }),
    ).toBe(false);
    expect(
      areAllHistoryWorkspacesCollapsed({
        groups,
        workspaceExpandedByDefault: false,
        workspaceExpandedOverrides: new Map([["mac:branch", true]]),
      }),
    ).toBe(false);
  });

  it("counts workspaces hidden by project collapse only in project mode", () => {
    const projectExpandedOverrides = new Map([["mac:atlas", false]]);
    const workspaceExpandedOverrides = new Map([["mac:other", false]]);
    const input = { groups, projectExpandedOverrides, workspaceExpandedOverrides };

    expect(areAllHistoryWorkspacesCollapsed({ groups: [] })).toBe(false);
    expect(areAllHistoryWorkspacesCollapsed({ groups, projectExpandedOverrides })).toBe(false);
    expect(areAllHistoryWorkspacesCollapsed(input)).toBe(true);
    expect(areAllHistoryWorkspacesCollapsed({ ...input, groupMode: "workspace" })).toBe(false);
    expect(
      areAllHistoryWorkspacesCollapsed({
        ...input,
        groupMode: "workspace",
        workspaceExpandedByDefault: false,
      }),
    ).toBe(true);
  });

  it("shows every workspace and root after expanding all clears both sets of overrides", () => {
    const input = { groups, expandedOverrides: new Map(), isSearching: false };
    const projectExpandedOverrides = new Map([["mac:atlas", false]]);
    const workspaceExpandedOverrides = new Map([["mac:other", false]]);
    expect(
      flattenHistoryProjectGroups({
        ...input,
        projectExpandedOverrides,
        workspaceExpandedOverrides,
      }).map(({ key }) => key),
    ).toEqual(["project:mac:atlas", "project:mac:other", "workspace:mac:other"]);

    const expanded = flattenHistoryProjectGroups({
      ...input,
      projectExpandedOverrides: new Map(),
      workspaceExpandedOverrides: new Map(),
    });
    expect(expanded.map(({ key }) => key)).toEqual([
      "project:mac:atlas",
      "workspace:mac:main",
      "root-agent:mac:main-root",
      "workspace:mac:branch",
      "root-agent:mac:branch-root",
      "project:mac:other",
      "workspace:mac:other",
      "root-agent:mac:other-root",
    ]);
  });
});
