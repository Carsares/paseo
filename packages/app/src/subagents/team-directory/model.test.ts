import {
  AGENT_PROFILE_ID_LABEL,
  PARENT_AGENT_ID_LABEL,
  RESIDENT_AGENT_LABEL,
  RESIDENT_ROLE_LABEL,
  RESIDENT_SLUG_LABEL,
  SIDE_CHAT_LABEL,
  SIDE_OF_AGENT_ID_LABEL,
  WORKSPACE_MAIN_ROLE,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { AgentProfile, ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  isDirectlyCleanableTaskMember,
  selectTeamDirectoryData,
  type TeamDirectoryAgent,
} from "./model";

function makeAgent(id: string, overrides: Partial<TeamDirectoryAgent> = {}): TeamDirectoryAgent {
  return {
    id,
    workspaceId: "ws-1",
    labels: {},
    title: id,
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date(1_000),
    lastActivityAt: new Date(1_000),
    lastUserMessageAt: new Date(1_000),
    pendingPermissions: [],
    requiresAttention: false,
    attentionReason: null,
    ...overrides,
  };
}

const main = makeAgent("main", {
  title: "Long Topic Main Control Session Title",
  labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
});

function parentLabel(parentId: string) {
  return { [PARENT_AGENT_ID_LABEL]: parentId };
}

describe("selectTeamDirectoryData", () => {
  it("sorts task members by needs_input/blocked > running > unread > idle and bubbles urgent L2 branches", () => {
    const idleChild = makeAgent("idle-l1", {
      labels: parentLabel("main"),
      lastActivityAt: new Date(9_000),
    });
    const unreadChild = makeAgent("unread-l1", {
      labels: parentLabel("main"),
      requiresAttention: true,
      attentionReason: "finished",
      lastActivityAt: new Date(2_000),
    });
    const runningChild = makeAgent("running-l1", {
      labels: parentLabel("main"),
      status: "running",
      lastActivityAt: new Date(3_000),
    });
    const blockedChild = makeAgent("blocked-l1", {
      labels: parentLabel("main"),
      pendingPermissions: [
        {
          id: "p1",
          provider: "codex",
          name: "bash",
          kind: "tool",
          title: "Run cmd",
          description: "",
        },
      ],
      lastActivityAt: new Date(1_000),
    });
    const idleParentWithUrgentL2 = makeAgent("idle-parent-l1", {
      labels: parentLabel("main"),
      lastActivityAt: new Date(5_000),
    });
    const failedL2 = makeAgent("failed-l2", {
      labels: parentLabel("idle-parent-l1"),
      status: "error",
      requiresAttention: true,
      attentionReason: "error",
      lastActivityAt: new Date(4_000),
    });
    const idleL2 = makeAgent("idle-l2", {
      labels: parentLabel("idle-parent-l1"),
      lastActivityAt: new Date(8_000),
    });

    const data = selectTeamDirectoryData({
      serverId: "host",
      workspaceId: "ws-1",
      mainAgentId: "main",
      agentMaps: {
        host: new Map(
          [
            main,
            idleChild,
            unreadChild,
            runningChild,
            blockedChild,
            idleParentWithUrgentL2,
            failedL2,
            idleL2,
          ].map((agent) => [agent.id, agent]),
        ),
      },
      fallbackTitle: "Agent",
    });

    expect(data.taskTree.map((branch) => branch.node.agentId)).toEqual([
      "blocked-l1",
      "idle-parent-l1",
      "running-l1",
      "unread-l1",
      "idle-l1",
    ]);
    expect(data.taskTree[1]!.children.map((child) => child.agentId)).toEqual([
      "failed-l2",
      "idle-l2",
    ]);
  });

  it("flattens residents under a single main seat and distinguishes registered vs preset-available without duplicates", () => {
    const silentResident = makeAgent("res-review", {
      status: "closed",
      lastUserMessageAt: null,
      labels: {
        ...parentLabel("main"),
        [RESIDENT_AGENT_LABEL]: "true",
        [RESIDENT_ROLE_LABEL]: "Reviewer",
        [RESIDENT_SLUG_LABEL]: "reviewer",
        [AGENT_PROFILE_ID_LABEL]: "prof-review",
      },
    });
    const profiles: AgentProfile[] = [
      {
        id: "prof-review",
        name: "Reviewer",
        provider: "claude",
        roleSlug: "reviewer",
        defaultResident: true,
      },
      {
        id: "prof-qa",
        name: "QA Specialist",
        provider: "codex",
        roleSlug: "qa",
        defaultResident: true,
      },
      {
        id: "prof-regular",
        name: "Regular Profile",
        provider: "codex",
        defaultResident: false,
      },
    ];

    const data = selectTeamDirectoryData({
      serverId: "host",
      workspaceId: "ws-1",
      mainAgentId: "main",
      agentMaps: {
        host: new Map([
          [main.id, main],
          [silentResident.id, silentResident],
        ]),
      },
      residentProfiles: profiles,
      fallbackTitle: "Agent",
    });

    expect(data.flattenResidentGroups).toBe(true);
    expect(data.residentGroups).toHaveLength(1);
    expect(data.residentGroups[0]!.nodes[0]).toMatchObject({
      agentId: "res-review",
      residentRole: "Reviewer",
      isSilentSeat: true,
    });
    expect(data.presetResidents).toEqual([
      { profileId: "prof-qa", name: "QA Specialist", roleSlug: "qa", provider: "codex" },
    ]);
  });

  it("separates side chats and read-only native provider subruns cleanly", () => {
    const sideChat = makeAgent("side-1", {
      title: "Quick check",
      labels: { [SIDE_CHAT_LABEL]: "true", [SIDE_OF_AGENT_ID_LABEL]: "main" },
    });
    const subruns: ProviderSubagentDescriptorPayload[] = [
      {
        id: "sub-1",
        parentAgentId: "main",
        provider: "claude",
        toolCallId: null,
        title: "Explore",
        description: "Inspect startup-trace.md",
        subtitle: "read-only",
        status: "running",
        createdAt: new Date(5_000).toISOString(),
        updatedAt: new Date(5_000).toISOString(),
      },
      {
        id: "sub-foreign",
        parentAgentId: "other-ws-agent",
        provider: "claude",
        toolCallId: null,
        title: "Explore",
        description: "Other workspace",
        status: "completed",
        createdAt: new Date(6_000).toISOString(),
        updatedAt: new Date(6_000).toISOString(),
      },
    ];

    const data = selectTeamDirectoryData({
      serverId: "host",
      workspaceId: "ws-1",
      mainAgentId: "main",
      agentMaps: {
        host: new Map([
          [main.id, main],
          [sideChat.id, sideChat],
        ]),
      },
      providerSubagents: subruns,
      fallbackTitle: "Agent",
    });

    expect(data.sideChats.map((node) => node.agentId)).toEqual(["side-1"]);
    expect(data.nativeSubruns).toHaveLength(1);
    expect(data.nativeSubruns[0]).toMatchObject({
      id: "sub-1",
      title: "Inspect startup-trace.md",
      bucket: "running",
    });
    expect(data.summary.runningCount).toBe(1);
  });

  it("identifies only idle finished subagents for compact cleanup and never includes residents, running, unread, or side chats", () => {
    const cleanableIdle = makeAgent("cleanable-idle", { labels: parentLabel("main") });
    const residentIdle = makeAgent("resident-idle", {
      labels: { ...parentLabel("main"), [RESIDENT_AGENT_LABEL]: "true" },
    });
    const runningTask = makeAgent("running-task", {
      labels: parentLabel("main"),
      status: "running",
    });
    const unreadTask = makeAgent("unread-task", {
      labels: parentLabel("main"),
      requiresAttention: true,
      attentionReason: "finished",
    });
    const needsInputTask = makeAgent("needs-input-task", {
      labels: parentLabel("main"),
      pendingPermissions: [
        {
          id: "p1",
          provider: "codex",
          name: "edit",
          kind: "tool",
          title: "Edit",
          description: "",
        },
      ],
    });
    const sideChat = makeAgent("side-chat", {
      labels: { [SIDE_CHAT_LABEL]: "true", [SIDE_OF_AGENT_ID_LABEL]: "main" },
    });
    const parentOfRunning = makeAgent("parent-of-running", { labels: parentLabel("main") });
    const runningGrandchild = makeAgent("running-grandchild", {
      labels: parentLabel("parent-of-running"),
      status: "running",
    });

    expect(isDirectlyCleanableTaskMember(main, "host")).toBe(false);
    expect(isDirectlyCleanableTaskMember(residentIdle, "host")).toBe(false);
    expect(isDirectlyCleanableTaskMember(runningTask, "host")).toBe(false);
    expect(isDirectlyCleanableTaskMember(unreadTask, "host")).toBe(false);
    expect(isDirectlyCleanableTaskMember(needsInputTask, "host")).toBe(false);
    expect(isDirectlyCleanableTaskMember(sideChat, "host")).toBe(false);
    expect(isDirectlyCleanableTaskMember(cleanableIdle, "host")).toBe(true);

    const data = selectTeamDirectoryData({
      serverId: "host",
      workspaceId: "ws-1",
      mainAgentId: "main",
      agentMaps: {
        host: new Map(
          [
            main,
            cleanableIdle,
            residentIdle,
            runningTask,
            unreadTask,
            needsInputTask,
            sideChat,
            parentOfRunning,
            runningGrandchild,
          ].map((agent) => [agent.id, agent]),
        ),
      },
      fallbackTitle: "Agent",
    });

    expect(data.cleanableTaskMembers).toEqual([{ serverId: "host", agentId: "cleanable-idle" }]);
  });
});
