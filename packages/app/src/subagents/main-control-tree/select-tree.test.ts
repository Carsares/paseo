import {
  PARENT_AGENT_ID_LABEL,
  parentAddressLabels,
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
  selectMainControlTree,
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

describe("main control tree", () => {
  it("orders all three levels by creation time and ignores archived, background, and unrelated nodes", () => {
    const tree = selectMainControlTree({
      session: session(
        main,
        agent("later", { labels: parent("main"), createdAt: new Date(2), title: " " }),
        agent("earlier", { labels: parent("main"), createdAt: new Date(1), title: "  Earlier  " }),
        agent("second-leaf", { labels: parent("earlier"), createdAt: new Date(2) }),
        agent("first-leaf", { labels: parent("earlier"), createdAt: new Date(1) }),
        agent("too-deep", { labels: parent("first-leaf") }),
        agent("archived", { labels: parent("main"), archivedAt }),
        agent("background", { labels: parent("earlier"), background: true }),
        agent("different-host-parent", {
          labels: parentAddressLabels({ serverId: "other", agentId: "main" }),
        }),
        agent("unrelated"),
      ),
      mainAgentId: "main",
      fallbackTitle: "Agent",
    });

    expect(tree).toMatchObject({
      agentId: "main",
      depth: 0,
      children: [
        {
          agentId: "earlier",
          depth: 1,
          title: "Earlier",
          children: [
            { agentId: "first-leaf", depth: 2, children: [] },
            { agentId: "second-leaf", depth: 2, children: [] },
          ],
        },
        { agentId: "later", depth: 1, title: "Agent", children: [] },
      ],
    });
  });

  it.each([
    { name: "running", state: { status: "running" }, expected: "active" },
    { name: "initializing", state: { status: "initializing" }, expected: "active" },
    {
      name: "open turn",
      state: {
        turn: { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null },
      },
      expected: "active",
    },
    { name: "background work", state: { backgroundWork: { count: 1 } }, expected: "active" },
    { name: "idle", state: { status: "idle" }, expected: "terminated" },
    { name: "closed", state: { status: "closed" }, expected: "terminated" },
    { name: "error", state: { status: "error" }, expected: "terminated" },
    {
      name: "archived even when running",
      state: { archivedAt, status: "running" },
      expected: "terminated",
    },
  ] satisfies { name: string; state: Partial<TreeAgent>; expected: string }[])(
    "shows $name as $expected",
    ({ state, expected }) => {
      const tree = selectMainControlTree({
        session: session({ ...main, ...state }),
        mainAgentId: "main",
        fallbackTitle: "Agent",
      });
      expect(tree?.processState).toBe(expected);
    },
  );

  it("finds only the workspace's unarchived main root", () => {
    const foreign = { ...main, id: "foreign", workspaceId: "other" };
    const archived = { ...main, id: "archived", archivedAt };
    const child = { ...main, id: "child", labels: { ...main.labels, ...parent("other") } };
    expect(findWorkspaceMainAgentId(session(foreign, archived, child), "workspace")).toBeNull();
    expect(findWorkspaceMainAgentId(session(foreign, archived, child, main), "workspace")).toBe(
      "main",
    );
    expect(
      selectMainControlTree({
        session: session(child),
        mainAgentId: "child",
        fallbackTitle: "Agent",
      }),
    ).toBeNull();
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

  it("breaks malformed parent cycles so nodes never duplicate across levels", () => {
    const first = agent("first", { labels: parent("main"), createdAt: new Date(1) });
    const cyclicChild = agent("cyclic", { labels: parent("first"), createdAt: new Date(2) });
    const tree = selectMainControlTree({
      session: session(main, first, cyclicChild, {
        ...first,
        id: "self-loop",
        labels: parent("self-loop"),
      }),
      mainAgentId: "main",
      fallbackTitle: "Agent",
    });
    expect(tree?.children.map((node) => node.agentId)).toEqual(["first"]);
    expect(tree?.children[0]?.children.map((node) => node.agentId)).toEqual(["cyclic"]);
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
