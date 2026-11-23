import {
  getOpenAgentTabLabel,
  PARENT_AGENT_ID_LABEL,
  parentAddressLabels,
  RESIDENT_AGENT_LABEL,
  RESIDENT_ROLE_LABEL,
  WORKSPACE_MAIN_ROLE,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { describe, expect, it } from "vitest";
import {
  canAdoptTabUnderMainAgent,
  createWorkspaceHierarchyTabStateSelector,
  findWorkspaceMainAgentId,
  hasUnarchivedWorkspaceDescendants,
  type MainControlSession,
  selectMainControlWorkspaceSections,
} from "./select-tree";

type TreeAgent = NonNullable<ReturnType<MainControlSession["agents"]["get"]>>;

function agent(id: string, overrides: Partial<TreeAgent> = {}): TreeAgent {
  return {
    id,
    labels: {},
    workspaceId: "workspace",
    title: id,
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date(0),
    ...overrides,
  };
}

const main = agent("main", { labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE } });
const parent = (id: string) => ({ [PARENT_AGENT_ID_LABEL]: id });
const archivedAt = new Date(10);

function session(...agents: TreeAgent[]): MainControlSession {
  return { serverId: "host", agents: new Map(agents.map((value) => [value.id, value])) };
}

function selectSections(
  local: MainControlSession,
  options: Partial<Parameters<typeof selectMainControlWorkspaceSections>[0]> = {},
) {
  return selectMainControlWorkspaceSections({
    session: local,
    workspaceId: "workspace",
    mainAgentId: main.id,
    fallbackTitle: "Agent",
    openTabAgentIds: new Set(),
    ...options,
  });
}

describe("main control sessions", () => {
  it("groups unarchived residents by their actual parent even after their tabs close", () => {
    const resident = (id: string, parentId: string, archived?: Date) =>
      agent(id, {
        labels: { ...parent(parentId), [RESIDENT_AGENT_LABEL]: "true", [RESIDENT_ROLE_LABEL]: id },
        archivedAt: archived,
      });
    const sections = selectSections(
      session(
        main,
        agent("lead", { labels: parent("main") }),
        resident("review", "main"),
        resident("search", "lead"),
        resident("archived resident", "main", archivedAt),
        agent("detached", {
          status: "closed",
          labels: { [RESIDENT_AGENT_LABEL]: "true", [RESIDENT_ROLE_LABEL]: "Independent review" },
        }),
      ),
    );

    expect(sections?.residentGroups).toMatchObject([
      {
        parent: { serverId: "host", agentId: "main" },
        nodes: [{ agentId: "review", depth: 1, processState: "closed" }],
      },
      {
        parent: { serverId: "host", agentId: "lead" },
        nodes: [{ agentId: "search", depth: 2, residentRole: "search" }],
      },
      {
        parent: null,
        nodes: [
          { agentId: "detached", residentRole: "Independent review", processState: "closed" },
        ],
      },
    ]);
    expect(sections?.active.map((node) => node.agentId)).toEqual(["main"]);
    expect(sections?.closed.map((node) => node.agentId)).toEqual(["archived resident", "lead"]);
  });

  it("groups workspace sessions with the main first and preserves descendant order and depth", () => {
    const sections = selectSections(
      session(
        main,
        agent("later", { labels: parent("main"), createdAt: new Date(2), title: " " }),
        agent("earlier", { labels: parent("main"), createdAt: new Date(1), title: "  Earlier  " }),
        agent("second-leaf", { labels: parent("earlier"), createdAt: new Date(2) }),
        agent("first-leaf", {
          labels: parent("earlier"),
          status: "running",
          createdAt: new Date(1),
        }),
        agent("too-deep", { labels: parent("first-leaf") }),
        agent("archived", { labels: parent("main"), archivedAt }),
        agent("background", { labels: parent("earlier"), background: true }),
        agent("standalone"),
        agent("foreign", { workspaceId: "elsewhere", status: "running" }),
      ),
      { openTabAgentIds: new Set(["earlier", "later", "standalone"]) },
    );

    expect(sections?.active).toMatchObject([
      { agentId: "main", depth: 0, roleBadge: "main", processState: "idle" },
      { agentId: "earlier", depth: 1, title: "Earlier", processState: "idle" },
      { agentId: "first-leaf", depth: 2, processState: "running" },
      { agentId: "later", depth: 1, title: "Agent" },
      { agentId: "standalone", depth: 0, roleBadge: "standalone" },
    ]);
    expect(sections?.closed).toMatchObject([
      { agentId: "archived", isArchived: true, depth: 1 },
      { agentId: "second-leaf", isArchived: false, depth: 2 },
      { agentId: "too-deep", isArchived: false, depth: 2 },
    ]);
  });

  it("keeps cross-host and cross-workspace descendants without confusing repeated ids", () => {
    const local = session(
      main,
      agent("lead", { labels: parent("main"), createdAt: new Date(1) }),
      agent("sibling-workspace", { labels: parent("main"), workspaceId: "elsewhere" }),
    );
    const remote = session(
      agent("lead", {
        labels: parentAddressLabels({ serverId: "host", agentId: "main" }),
        createdAt: new Date(2),
      }),
      agent("worker", { labels: parent("lead") }),
      agent("deep-remote", { labels: parent("worker"), status: "running" }),
      agent("pending", { labels: parent("lead"), status: "running" }),
      agent("unrelated", { status: "running" }),
    );
    const sections = selectSections(local, {
      agentMaps: { remote: remote.agents },
      openTabAgentIds: new Set(["lead"]),
      pendingArchiveIds: new Set(["remote:pending"]),
    });
    expect(sections?.active).toMatchObject([
      { serverId: "host", agentId: "main" },
      { serverId: "host", agentId: "lead", depth: 1 },
      { serverId: "remote", agentId: "deep-remote", depth: 2 },
    ]);
    expect(sections?.closed).toMatchObject([
      { serverId: "remote", agentId: "lead", depth: 1 },
      { serverId: "host", agentId: "sibling-workspace", depth: 1 },
      { serverId: "remote", agentId: "worker", depth: 2 },
    ]);
  });

  it("moves an idle session to Closed as soon as this workspace's tab closes", () => {
    const label = getOpenAgentTabLabel("local");
    const child = agent("child", {
      labels: { ...parent("main"), [label]: "true", [getOpenAgentTabLabel("remote")]: "true" },
    });
    const otherWorkspace = agent("other-workspace", {
      workspaceId: "elsewhere",
      labels: { ...parent("main"), [label]: "true" },
    });
    const local = session(main, child, otherWorkspace);
    expect(
      selectSections(local, {
        openTabAgentIds: new Set(["child"]),
      })?.active.map((node) => node.agentId),
    ).toEqual(["main", "child", "other-workspace"]);

    const closedTab = selectSections(local);
    expect(closedTab?.active.map((node) => node.agentId)).toEqual(["main", "other-workspace"]);
    expect(closedTab?.closed).toMatchObject([{ agentId: "child", isArchived: false }]);
  });

  it("deduplicates archived history against live state and sorts all closed sessions by activity", () => {
    const live = agent("unarchived", { status: "running" });
    const archived = agent("archive", { archivedAt, labels: parent("main") });
    const sections = selectSections(
      session(
        main,
        live,
        { ...archived, title: "Stale live title" },
        agent("newly-archived", { archivedAt: new Date(40) }),
        agent("closed-tab", { updatedAt: new Date(35) }),
      ),
      {
        archivedAgents: [
          { ...live, archivedAt },
          { ...archived, lastActivityAt: new Date(50), status: "running" },
          { ...main, archivedAt },
          agent("background", { archivedAt, background: true }),
          agent("foreign", { archivedAt, workspaceId: "another-workspace" }),
          agent("recent", { archivedAt: new Date(25), updatedAt: new Date(60) }),
        ],
      },
    );

    expect(sections?.active.map((node) => node.agentId)).toEqual(["main", "unarchived"]);
    expect(sections?.closed).toMatchObject([
      { agentId: "recent", isArchived: true },
      { agentId: "archive", title: "archive", depth: 1, isArchived: true, processState: "closed" },
      { agentId: "newly-archived", roleBadge: "standalone", isArchived: true },
      { agentId: "closed-tab", roleBadge: "standalone", isArchived: false },
    ]);
  });

  it.each([
    { name: "running", state: { status: "running" } },
    { name: "initializing", state: { status: "initializing" } },
    {
      name: "open turn",
      state: {
        turn: { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null },
      },
    },
    { name: "background work", state: { backgroundWork: { count: 1 } } },
  ] satisfies { name: string; state: Partial<TreeAgent> }[])(
    "keeps $name sessions active even without an open tab",
    ({ state }) => {
      const sections = selectSections(session(main, agent("child", state)));
      expect(sections?.active[1]).toMatchObject({ agentId: "child", processState: "running" });
    },
  );

  it("finds only the workspace's unarchived main root", () => {
    const foreign = { ...main, id: "foreign", workspaceId: "other" };
    const archived = { ...main, id: "archived", archivedAt };
    const background = { ...main, id: "background", background: true };
    const child = { ...main, id: "child", labels: { ...main.labels, ...parent("other") } };
    expect(
      findWorkspaceMainAgentId(session(foreign, archived, background, child), "workspace"),
    ).toBeNull();
    expect(
      findWorkspaceMainAgentId(session(foreign, archived, background, child, main), "workspace"),
    ).toBe("main");
    expect(selectSections(session(child), { mainAgentId: "child" })).toBeNull();
    expect(selectSections(session(archived), { mainAgentId: "archived" })).toBeNull();
  });

  it("only attaches unarchived roots in the same workspace without exceeding three levels", () => {
    const root = agent("root");
    const child = agent("child", { labels: parent("root") });
    const grandchild = agent("grandchild", { labels: parent("child") });
    const check = (
      state: MainControlSession,
      agentId = "root",
      mainAgentId: string | null = "main",
    ) => canAdoptTabUnderMainAgent({ session: state, agentId, mainAgentId });
    const state = session(
      main,
      root,
      child,
      { ...grandchild, archivedAt },
      agent("foreign", { workspaceId: "other" }),
    );
    expect(check(state)).toBe(true);
    expect(check(state, "child")).toBe(false);
    expect(check(state, "grandchild")).toBe(false);
    expect(check(state, "main")).toBe(false);
    expect(check(state, "foreign")).toBe(false);
    expect(check(state, "root", null)).toBe(false);
    expect(check(session({ ...main, archivedAt }, root))).toBe(false);
    expect(check(session({ ...main, background: true }, root))).toBe(false);
    expect(check(session(main, { ...root, background: true }))).toBe(false);
    expect(check(session(main, root, child, grandchild))).toBe(false);
  });

  it("warns about unarchived workspace descendants beyond the visible tree", () => {
    const child = agent("child", { labels: parent("main"), archivedAt });
    const grandchild = agent("grandchild", { labels: parent("child"), background: true });
    expect(hasUnarchivedWorkspaceDescendants(session(main, child), "main", "workspace")).toBe(
      false,
    );
    expect(
      hasUnarchivedWorkspaceDescendants(session(main, child, grandchild), "main", "workspace"),
    ).toBe(true);
    expect(
      hasUnarchivedWorkspaceDescendants(
        session(main, child, { ...grandchild, workspaceId: "elsewhere" }),
        "main",
        "workspace",
      ),
    ).toBe(false);
  });

  it("memoizes workspace hierarchy tab state across unrelated agent updates", () => {
    const selector = createWorkspaceHierarchyTabStateSelector({
      serverId: "host",
      workspaceId: "workspace",
    });
    const root = agent("root");
    const foreign = agent("foreign", { workspaceId: "other" });
    const firstState = selector({
      sessions: { host: session(main, root, foreign) },
    });
    expect(firstState.mainAgentId).toBe("main");
    expect([...firstState.rootAgentIds]).toEqual(["main", "root"]);
    expect([...firstState.adoptableAgentIds]).toEqual(["root"]);

    // Updating an unrelated field or another workspace returns the exact same reference.
    const unchangedState = selector({
      sessions: {
        host: session(
          { ...main, status: "running", title: "Updated" },
          { ...root, status: "running" },
          { ...foreign, status: "running" },
        ),
      },
    });
    expect(unchangedState).toBe(firstState);

    // Adding a grandchild under root makes root no longer adoptable and yields a new state.
    const child = agent("child", { labels: parent("root") });
    const grandchild = agent("grandchild", { labels: parent("child") });
    const updatedState = selector({
      sessions: { host: session(main, root, child, grandchild) },
    });
    expect(updatedState).not.toBe(firstState);
    expect([...updatedState.adoptableAgentIds]).toEqual([]);
  });
});
