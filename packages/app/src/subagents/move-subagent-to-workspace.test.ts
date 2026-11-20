import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { deriveWorkspaceHierarchyTabState } from "./main-control-tree/select-tree";
import { WORKSPACE_MAIN_ROLE, WORKSPACE_ROLE_LABEL } from "@getpaseo/protocol/agent-labels";
import {
  canMoveSubagentToWorkspace,
  createCanMoveSubagentToWorkspaceSelector,
  hasSiblingWorkspaceRootAgent,
  requestMoveSubagentToWorkspace,
  type MovableWorkspaceAgent,
  type MoveSubagentToWorkspaceDeps,
} from "./move-subagent-to-workspace";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "workspace-1";
const AGENT_TIMESTAMP = new Date("2026-03-04T00:00:00.000Z");

class IterationCountingMap<K, V> extends Map<K, V> {
  iterations = 0;

  override values() {
    this.iterations += 1;
    return super.values();
  }

  override entries() {
    this.iterations += 1;
    return super.entries();
  }

  override [Symbol.iterator]() {
    this.iterations += 1;
    return super[Symbol.iterator]();
  }
}

function makeAgent(overrides: Partial<Agent> & Pick<Agent, "id">): Agent {
  return {
    serverId: SERVER_ID,
    provider: "codex",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: AGENT_TIMESTAMP,
    updatedAt: AGENT_TIMESTAMP,
    lastUserMessageAt: null,
    lastActivityAt: AGENT_TIMESTAMP,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: {
      provider: "codex",
      sessionId: null,
    },
    title: null,
    cwd: "/repo",
    workspaceId: WORKSPACE_ID,
    model: null,
    thinkingOptionId: null,
    parentAgentId: null,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    background: false,
    ...overrides,
  };
}

function seedSession(
  agents: Map<string, Agent>,
  options: { featureEnabled?: boolean; agentDetails?: Map<string, Agent> } = {},
): void {
  const store = useSessionStore.getState();
  store.initializeSession(SERVER_ID, null as unknown as DaemonClient);
  store.updateSessionServerInfo(SERVER_ID, {
    serverId: SERVER_ID,
    hostname: null,
    version: null,
    features: { agentMoveToWorkspace: options.featureEnabled ?? true },
  });
  store.setAgents(SERVER_ID, agents);
  if (options.agentDetails) {
    store.setAgentDetails(SERVER_ID, options.agentDetails);
  }
}

function streamTick(agentId: string, text: string): void {
  useSessionStore.getState().setAgentStreamState(SERVER_ID, agentId, {
    head: [
      {
        kind: "assistant_message",
        id: "message-1",
        text,
        timestamp: AGENT_TIMESTAMP,
      },
    ],
  });
}

describe("canMoveSubagentToWorkspace", () => {
  const agent = {
    id: "child",
    parentAgentId: "parent",
    workspaceId: WORKSPACE_ID,
    archivedAt: null,
    background: false,
  };
  const input = {
    featureEnabled: true,
    workspaceId: WORKSPACE_ID,
    agent,
    parentAgent: { workspaceId: WORKSPACE_ID, archivedAt: null },
  };

  it("allows a Paseo subagent in its parent's workspace even without sibling roots", () => {
    expect(canMoveSubagentToWorkspace({ ...input, hasOtherWorkspaceRootAgent: false })).toBe(true);
  });

  it("allows a workspace root agent when another active root agent exists in the workspace", () => {
    expect(
      canMoveSubagentToWorkspace({
        featureEnabled: true,
        workspaceId: WORKSPACE_ID,
        agent: { ...agent, parentAgentId: null },
        parentAgent: undefined,
        hasOtherWorkspaceRootAgent: true,
      }),
    ).toBe(true);
  });

  it("allows a cross-workspace subagent when another active root agent shares its workspace", () => {
    expect(
      canMoveSubagentToWorkspace({
        featureEnabled: true,
        workspaceId: WORKSPACE_ID,
        agent,
        parentAgent: { workspaceId: "ws-parent", archivedAt: null },
        hasOtherWorkspaceRootAgent: true,
      }),
    ).toBe(true);
  });

  it.each([undefined, { workspaceId: WORKSPACE_ID, archivedAt: AGENT_TIMESTAMP }])(
    "requires another root when the parent is absent or archived (%j)",
    (parentAgent) => {
      expect(canMoveSubagentToWorkspace({ ...input, parentAgent })).toBe(false);
      expect(
        canMoveSubagentToWorkspace({ ...input, parentAgent, hasOtherWorkspaceRootAgent: true }),
      ).toBe(true);
    },
  );

  it.each([
    ["the feature is disabled", { featureEnabled: false }],
    ["the agent is unavailable", { agent: null }],
    ["the agent is a sole workspace root", { agent: { ...agent, parentAgentId: null } }],
    ["the agent is archived", { agent: { ...agent, archivedAt: new Date(0) } }],
    ["the agent is a background agent", { agent: { ...agent, background: true } }],
    [
      "the agent is a background root even with sibling roots",
      {
        agent: { ...agent, parentAgentId: null, background: true },
        parentAgent: undefined,
        hasOtherWorkspaceRootAgent: true,
      },
    ],
    [
      "the agent is a cross-workspace subagent alone in its workspace",
      {
        agent: { ...agent, workspaceId: "ws-2" },
        workspaceId: "ws-2",
        hasOtherWorkspaceRootAgent: false,
      },
    ],
    [
      "the agent already belongs to a different workspace",
      {
        agent: { ...agent, workspaceId: "ws-2" },
        hasOtherWorkspaceRootAgent: true,
      },
    ],
  ])("blocks moving when %s", (_reason, overrides) => {
    expect(canMoveSubagentToWorkspace({ ...input, ...overrides })).toBe(false);
  });
});

describe("hasSiblingWorkspaceRootAgent", () => {
  it("returns false for a sole root agent despite subagents, archived, background, or foreign agents", () => {
    const soleRoot: MovableWorkspaceAgent = {
      id: "root-1",
      parentAgentId: null,
      workspaceId: WORKSPACE_ID,
      archivedAt: null,
      background: false,
    };
    const sameWorkspaceChild: MovableWorkspaceAgent = {
      id: "child-1",
      parentAgentId: "root-1",
      workspaceId: WORKSPACE_ID,
      archivedAt: null,
      background: false,
    };
    const archivedSibling: MovableWorkspaceAgent = {
      id: "root-archived",
      parentAgentId: null,
      workspaceId: WORKSPACE_ID,
      archivedAt: AGENT_TIMESTAMP,
      background: false,
    };
    const backgroundSibling: MovableWorkspaceAgent = {
      id: "root-background",
      parentAgentId: null,
      workspaceId: WORKSPACE_ID,
      archivedAt: null,
      background: true,
    };
    const otherWorkspaceRoot: MovableWorkspaceAgent = {
      id: "root-other-ws",
      parentAgentId: null,
      workspaceId: "workspace-2",
      archivedAt: null,
      background: false,
    };
    const agents = new Map([
      [soleRoot.id, soleRoot],
      [sameWorkspaceChild.id, sameWorkspaceChild],
      [archivedSibling.id, archivedSibling],
      [backgroundSibling.id, backgroundSibling],
      [otherWorkspaceRoot.id, otherWorkspaceRoot],
    ]);

    expect(
      hasSiblingWorkspaceRootAgent({
        workspaceId: WORKSPACE_ID,
        agentId: soleRoot.id,
        agents,
      }),
    ).toBe(false);
  });

  it("returns true for both active non-background root agents in the same workspace", () => {
    const rootA: MovableWorkspaceAgent = {
      id: "root-a",
      parentAgentId: null,
      workspaceId: WORKSPACE_ID,
      archivedAt: null,
      background: false,
    };
    const rootB: MovableWorkspaceAgent = {
      id: "root-b",
      parentAgentId: null,
      workspaceId: WORKSPACE_ID,
      archivedAt: null,
      background: false,
    };
    const agents = new Map([
      [rootA.id, rootA],
      [rootB.id, rootB],
    ]);

    expect(
      hasSiblingWorkspaceRootAgent({
        workspaceId: WORKSPACE_ID,
        agentId: rootA.id,
        agents,
      }),
    ).toBe(true);
    expect(
      hasSiblingWorkspaceRootAgent({
        workspaceId: WORKSPACE_ID,
        agentId: rootB.id,
        agents,
      }),
    ).toBe(true);
  });

  it("treats a cross-workspace subagent as a sibling workspace root using agentDetails parent lookup", () => {
    const root: MovableWorkspaceAgent = {
      id: "root-a",
      parentAgentId: null,
      workspaceId: WORKSPACE_ID,
      archivedAt: null,
      background: false,
    };
    const crossWorkspaceChild: MovableWorkspaceAgent = {
      id: "cross-child",
      parentAgentId: "foreign-parent",
      workspaceId: WORKSPACE_ID,
      archivedAt: null,
      background: false,
    };
    const agents = new Map([
      [root.id, root],
      [crossWorkspaceChild.id, crossWorkspaceChild],
    ]);
    const agentDetails = new Map([
      ["foreign-parent", { workspaceId: "workspace-parent", archivedAt: null }],
    ]);

    expect(
      hasSiblingWorkspaceRootAgent({
        workspaceId: WORKSPACE_ID,
        agentId: root.id,
        agents,
        agentDetails,
      }),
    ).toBe(true);
    expect(
      hasSiblingWorkspaceRootAgent({
        workspaceId: WORKSPACE_ID,
        agentId: crossWorkspaceChild.id,
        agents,
        agentDetails,
      }),
    ).toBe(true);
  });
});

describe("createCanMoveSubagentToWorkspaceSelector", () => {
  afterEach(() => {
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  it("returns cached eligibility without walking agents across stream ticks", () => {
    const rootA = makeAgent({ id: "root-a", workspaceId: WORKSPACE_ID });
    const rootB = makeAgent({ id: "root-b", workspaceId: WORKSPACE_ID });
    const agents = new IterationCountingMap<string, Agent>([
      [rootA.id, rootA],
      [rootB.id, rootB],
    ]);
    seedSession(agents);

    const select = createCanMoveSubagentToWorkspaceSelector({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: rootA.id,
    });

    expect(select(useSessionStore.getState())).toBe(true);
    const iterationsAfterFirstSelect = agents.iterations;

    for (let tick = 0; tick < 100; tick += 1) {
      streamTick(rootA.id, `token ${tick}`);
      expect(select(useSessionStore.getState())).toBe(true);
    }

    expect(useSessionStore.getState().sessions[SERVER_ID]?.agents).toBe(agents);
    expect(agents.iterations).toBe(iterationsAfterFirstSelect);
  });

  it("updates sole vs sibling root eligibility when agents, agentDetails, or feature flags change", () => {
    const soleRoot = makeAgent({ id: "root-a", workspaceId: WORKSPACE_ID });
    const sameWorkspaceChild = makeAgent({
      id: "child-1",
      workspaceId: WORKSPACE_ID,
      parentAgentId: soleRoot.id,
    });
    const archivedSibling = makeAgent({
      id: "root-archived",
      workspaceId: WORKSPACE_ID,
      archivedAt: AGENT_TIMESTAMP,
    });
    const backgroundSibling = makeAgent({
      id: "root-bg",
      workspaceId: WORKSPACE_ID,
      background: true,
    });
    const foreignRoot = makeAgent({ id: "root-other", workspaceId: "workspace-2" });

    const initialAgents = new Map([
      [soleRoot.id, soleRoot],
      [sameWorkspaceChild.id, sameWorkspaceChild],
      [archivedSibling.id, archivedSibling],
      [backgroundSibling.id, backgroundSibling],
      [foreignRoot.id, foreignRoot],
    ]);
    seedSession(initialAgents, { featureEnabled: false });

    const selectRoot = createCanMoveSubagentToWorkspaceSelector({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: soleRoot.id,
    });
    const selectChild = createCanMoveSubagentToWorkspaceSelector({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: sameWorkspaceChild.id,
    });
    const selectBackground = createCanMoveSubagentToWorkspaceSelector({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: backgroundSibling.id,
    });

    expect(selectRoot(useSessionStore.getState())).toBe(false);
    expect(selectChild(useSessionStore.getState())).toBe(false);
    expect(selectBackground(useSessionStore.getState())).toBe(false);

    useSessionStore.getState().updateSessionServerInfo(SERVER_ID, {
      serverId: SERVER_ID,
      hostname: null,
      version: null,
      features: { agentMoveToWorkspace: true },
    });

    expect(selectRoot(useSessionStore.getState())).toBe(false);
    expect(selectChild(useSessionStore.getState())).toBe(true);
    expect(selectBackground(useSessionStore.getState())).toBe(false);

    const siblingRoot = makeAgent({ id: "root-b", workspaceId: WORKSPACE_ID });
    useSessionStore
      .getState()
      .setAgents(SERVER_ID, new Map(initialAgents).set(siblingRoot.id, siblingRoot));

    const selectSiblingRoot = createCanMoveSubagentToWorkspaceSelector({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: siblingRoot.id,
    });

    expect(selectRoot(useSessionStore.getState())).toBe(true);
    expect(selectSiblingRoot(useSessionStore.getState())).toBe(true);
    expect(selectBackground(useSessionStore.getState())).toBe(false);

    const crossChild = makeAgent({
      id: "cross-child",
      workspaceId: WORKSPACE_ID,
      parentAgentId: "foreign-parent",
    });
    useSessionStore
      .getState()
      .setAgents(SERVER_ID, new Map(initialAgents).set(crossChild.id, crossChild));

    expect(selectRoot(useSessionStore.getState())).toBe(false);

    useSessionStore
      .getState()
      .setAgentDetails(
        SERVER_ID,
        new Map([
          ["foreign-parent", makeAgent({ id: "foreign-parent", workspaceId: "ws-parent" })],
        ]),
      );

    const selectCrossChild = createCanMoveSubagentToWorkspaceSelector({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: crossChild.id,
    });

    expect(selectRoot(useSessionStore.getState())).toBe(true);
    expect(selectCrossChild(useSessionStore.getState())).toBe(true);
  });

  it("handles cross-workspace subagents alone in their workspace and invalid selector inputs", () => {
    const parent = makeAgent({ id: "parent", workspaceId: "workspace-parent" });
    const soleCrossChild = makeAgent({
      id: "cross-child",
      workspaceId: WORKSPACE_ID,
      parentAgentId: parent.id,
    });
    seedSession(
      new Map([
        [parent.id, parent],
        [soleCrossChild.id, soleCrossChild],
      ]),
    );

    const selectSoleCrossChild = createCanMoveSubagentToWorkspaceSelector({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: soleCrossChild.id,
    });
    const selectNullAgent = createCanMoveSubagentToWorkspaceSelector({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      agentId: null,
    });
    const selectEmptyWorkspace = createCanMoveSubagentToWorkspaceSelector({
      serverId: SERVER_ID,
      workspaceId: " ",
      agentId: soleCrossChild.id,
    });

    expect(selectSoleCrossChild(useSessionStore.getState())).toBe(false);
    expect(selectNullAgent(useSessionStore.getState())).toBe(false);
    expect(selectEmptyWorkspace(useSessionStore.getState())).toBe(false);
  });
});

it("excludes background sessions from main control and adoptable roots", () => {
  const labels = { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE };
  const backgroundMain = makeAgent({ id: "background-main", background: true, labels });
  const main = makeAgent({ id: "main", labels });
  const backgroundRoot = makeAgent({ id: "background-root", background: true });
  const root = makeAgent({ id: "root" });
  const agents = new Map(
    [backgroundMain, main, backgroundRoot, root].map((agent) => [agent.id, agent]),
  );
  expect(deriveWorkspaceHierarchyTabState({ serverId: SERVER_ID, agents }, WORKSPACE_ID)).toEqual({
    mainAgentId: main.id,
    rootAgentIds: new Set([main.id, root.id]),
    adoptableAgentIds: new Set([root.id]),
  });
});

const input = { serverId: "server-1", subagentId: "child-agent" };

function createDeps() {
  return {
    createIdempotencyKey: vi.fn(() => "move-key"),
    moveAgentToWorkspace: vi
      .fn<MoveSubagentToWorkspaceDeps["moveAgentToWorkspace"]>()
      .mockResolvedValue({ workspaceId: "new-workspace" }),
    openMovedWorkspace: vi.fn(),
    reportError: vi.fn(),
  };
}

describe("requestMoveSubagentToWorkspace", () => {
  it("moves immediately without confirmation and opens the returned workspace", async () => {
    const deps = createDeps();

    await requestMoveSubagentToWorkspace(input, deps);

    expect(deps.createIdempotencyKey).toHaveBeenCalledExactlyOnceWith();
    expect(deps.moveAgentToWorkspace).toHaveBeenCalledExactlyOnceWith({
      serverId: input.serverId,
      agentId: input.subagentId,
      idempotencyKey: "move-key",
    });
    expect(deps.openMovedWorkspace).toHaveBeenCalledExactlyOnceWith({
      serverId: input.serverId,
      workspaceId: "new-workspace",
      agentId: input.subagentId,
    });
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it("reports move failures, skips navigation, and allows retrying", async () => {
    const deps = createDeps();
    const error = new Error("Host disconnected");
    deps.moveAgentToWorkspace.mockRejectedValueOnce(error);

    await requestMoveSubagentToWorkspace(input, deps);

    expect(deps.reportError).toHaveBeenCalledExactlyOnceWith(error);
    expect(deps.openMovedWorkspace).not.toHaveBeenCalled();

    await requestMoveSubagentToWorkspace(input, deps);
    expect(deps.moveAgentToWorkspace).toHaveBeenCalledTimes(2);
    expect(deps.openMovedWorkspace).toHaveBeenCalledTimes(1);
  });

  it("keeps the move pending and reports failures while opening the workspace", async () => {
    const deps = createDeps();
    const navigation = Promise.withResolvers<void>();
    const navigationStarted = Promise.withResolvers<void>();
    deps.openMovedWorkspace.mockImplementationOnce(() => {
      navigationStarted.resolve();
      return navigation.promise;
    });

    const moving = requestMoveSubagentToWorkspace(input, deps);
    await navigationStarted.promise;
    await requestMoveSubagentToWorkspace(input, deps);
    expect(deps.moveAgentToWorkspace).toHaveBeenCalledTimes(1);

    const error = new Error("Could not open workspace");
    navigation.reject(error);
    await moving;
    expect(deps.reportError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("suppresses concurrent duplicates while the move is in flight", async () => {
    const deps = createDeps();
    const move = Promise.withResolvers<{ workspaceId: string }>();
    deps.moveAgentToWorkspace.mockReturnValueOnce(move.promise);

    const moving = requestMoveSubagentToWorkspace(input, deps);
    const duplicateDuringMove = requestMoveSubagentToWorkspace(input, deps);
    expect(deps.moveAgentToWorkspace).toHaveBeenCalledTimes(1);
    expect(deps.openMovedWorkspace).not.toHaveBeenCalled();
    await duplicateDuringMove;

    move.resolve({ workspaceId: "new-workspace" });
    await moving;
    expect(deps.openMovedWorkspace).toHaveBeenCalledTimes(1);
  });
});
it("requires a visible sibling root after the parent disappears or is archived", () => {
  const child = makeAgent({ id: "child", parentAgentId: "parent" });
  const parent = makeAgent({ id: "parent" });
  const sibling = makeAgent({ id: "sibling" });
  seedSession(new Map([[child.id, child]]));
  const selectCanMove = createCanMoveSubagentToWorkspaceSelector({
    serverId: SERVER_ID,
    workspaceId: WORKSPACE_ID,
    agentId: child.id,
  });
  expect(selectCanMove(useSessionStore.getState())).toBe(false);
  const sessionStore = useSessionStore.getState();
  sessionStore.setAgentDetails(
    SERVER_ID,
    new Map([[parent.id, { ...parent, archivedAt: AGENT_TIMESTAMP }]]),
  );
  expect(selectCanMove(useSessionStore.getState())).toBe(false);
  sessionStore.setAgents(
    SERVER_ID,
    new Map([
      [child.id, child],
      [sibling.id, sibling],
    ]),
  );
  expect(selectCanMove(useSessionStore.getState())).toBe(true);
});
