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
  isMemberActivelyWorking,
  selectTeamActivityGroups,
  selectTeamAttributeGroups,
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

  it("projects unified activity and attribute groupings while keeping working, needs-action, and focused members expanded", () => {
    const residentIdle = makeAgent("resident-idle", {
      title: "Architecture Advisor",
      labels: {
        ...parentLabel("main"),
        [RESIDENT_AGENT_LABEL]: "true",
        [RESIDENT_ROLE_LABEL]: "Advisor",
      },
    });
    const sideChat = makeAgent("side-chat", {
      title: "Quick scratch",
      labels: { [SIDE_CHAT_LABEL]: "true", [SIDE_OF_AGENT_ID_LABEL]: "main" },
    });
    const l1Active = makeAgent("l1-active", {
      title: "Backend Lead",
      labels: parentLabel("main"),
      status: "running",
    });
    const l1Idle = makeAgent("l1-idle", {
      title: "Frontend Lead",
      labels: parentLabel("main"),
      status: "idle",
    });
    const l2Idle = makeAgent("l2-idle", {
      title: "CSS Fixer",
      labels: parentLabel("l1-idle"),
      status: "idle",
    });
    const l2NeedsPerm = makeAgent("l2-perm", {
      title: "DB Runner",
      labels: parentLabel("l1-active"),
      pendingPermissions: [
        {
          id: "perm-db",
          provider: "codex",
          name: "bash",
          kind: "tool",
          title: "Run migration",
          description: "",
        },
      ],
    });

    const data = selectTeamDirectoryData({
      serverId: "host",
      workspaceId: "ws-1",
      mainAgentId: "main",
      agentMaps: {
        host: new Map(
          [main, residentIdle, sideChat, l1Active, l1Idle, l2Idle, l2NeedsPerm].map((agent) => [
            agent.id,
            agent,
          ]),
        ),
      },
      fallbackTitle: "Agent",
    });

    const focused = { serverId: "host", agentId: "l2-idle" };
    const activity = selectTeamActivityGroups(data, focused);
    expect(activity.activeMembers.map((node) => node.agentId)).toEqual(["l2-perm", "l1-active"]);
    expect(activity.activeMembers.every((node) => isMemberActivelyWorking(node))).toBe(true);
    // Focused idle L2 stays pinned visible even while collapsible inactive rows are folded
    expect(activity.pinnedInactiveMembers.map((node) => node.agentId)).toEqual(["l2-idle"]);
    expect(activity.collapsibleInactiveMembers.map((node) => node.agentId)).toEqual([
      "main",
      "resident-idle",
      "l1-idle",
      "side-chat",
    ]);

    const attribute = selectTeamAttributeGroups(data, focused);
    expect(attribute.mainSeat?.agentId).toBe("main");
    expect(attribute.sideChats.map((node) => node.agentId)).toEqual(["side-chat"]);
    expect(attribute.levelOne.expandedMembers.map((node) => node.agentId)).toEqual(["l1-active"]);
    expect(attribute.levelOne.foldedInactiveMembers.map((node) => node.agentId)).toEqual([
      "resident-idle",
      "l1-idle",
    ]);
    expect(attribute.levelTwo.expandedMembers.map((node) => node.agentId)).toEqual([
      "l2-perm",
      "l2-idle",
    ]);
    expect(attribute.levelTwo.expandedMembers[0]?.parentTitle).toBe("Backend Lead");
    expect(attribute.levelTwo.expandedMembers[1]?.parentTitle).toBe("Frontend Lead");
  });

  it("traverses subagents spawned by a Level-1 resident specialist into Level-2 with the resident role as parentTitle", () => {
    const resident = makeAgent("res-lead", {
      title: "Resident Session",
      labels: {
        ...parentLabel("main"),
        [RESIDENT_AGENT_LABEL]: "true",
        [RESIDENT_ROLE_LABEL]: "Security Auditor",
      },
    });
    const residentChild = makeAgent("res-l2", {
      title: "Dependency Scanner",
      labels: parentLabel("res-lead"),
      status: "running",
    });

    const data = selectTeamDirectoryData({
      serverId: "host",
      workspaceId: "ws-1",
      mainAgentId: "main",
      agentMaps: {
        host: new Map([main, resident, residentChild].map((agent) => [agent.id, agent])),
      },
      fallbackTitle: "Agent",
    });

    expect(data.residentSubtasks).toHaveLength(1);
    expect(data.residentSubtasks[0]).toMatchObject({
      agentId: "res-l2",
      depth: 2,
      parentAgentId: "res-lead",
      parentTitle: "Security Auditor",
    });

    const attribute = selectTeamAttributeGroups(data, null);
    expect(attribute.levelTwo.expandedMembers.map((node) => node.agentId)).toEqual(["res-l2"]);
  });
});
