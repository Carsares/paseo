import { WORKSPACE_MAIN_ROLE, WORKSPACE_ROLE_LABEL } from "@getpaseo/protocol/agent-labels";
import type { WorkspaceDurableItem } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { createTopicInboxReadStore } from "@/stores/topic-inbox-read-store";
import type { StreamItem } from "@/types/stream";
import { selectTeamDirectoryMessages } from "./messages-model";

function makeMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: async (key: string) => map.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: async (key: string) => {
      map.delete(key);
    },
  };
}

function makeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    serverId: "srv",
    provider: "codex",
    cwd: "/repo",
    workspaceId: "ws-1",
    model: null,
    createdAt: new Date("2026-11-25T08:00:00.000Z"),
    updatedAt: new Date("2026-11-25T08:10:00.000Z"),
    lastActivityAt: new Date("2026-11-25T08:10:00.000Z"),
    lastUserMessageAt: new Date("2026-11-25T08:01:00.000Z"),
    currentModeId: null,
    availableModes: [],
    persistence: null,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    title: id,
    parentAgentId: null,
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    pendingPermissions: [],
    labels: {},
    ...overrides,
  };
}

function makeSubagentReportItem(input: {
  id: string;
  senderId: string;
  senderTitle: string;
  seq: number;
  text: string;
  reportStatus?: "completed" | "blocked";
}): StreamItem {
  return {
    kind: "tool_call",
    id: input.id,
    timestamp: new Date(1_700_000_000_000 + input.seq * 1000),
    timelineCursor: { epoch: "ep-1", seq: input.seq },
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId: input.id,
        name: "agent_message",
        status: "completed",
        detail: { type: "unknown", input: null, output: null },
        agentMessage: {
          event: "message",
          reportStatus: input.reportStatus ?? "completed",
          sender: {
            id: input.senderId,
            title: input.senderTitle,
          },
          text: input.text,
        },
      },
    },
  } as unknown as StreamItem;
}

describe("selectTeamDirectoryMessages", () => {
  it("splits unread above read across permissions, durable items, pending inbox, subagent reports, and main conclusions", () => {
    const main = makeAgent("main", {
      title: "Main Session",
      labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: new Date("2026-11-25T08:20:00.000Z"),
      pendingSubagentInbox: {
        count: 1,
        items: [
          {
            agentId: "sub-2",
            title: "Verifier",
            event: "report",
            summary: "All tests green",
            createdAt: "2026-11-25T08:18:00.000Z",
          },
        ],
      } as never,
    });
    const subPerm = makeAgent("sub-perm", {
      title: "Implementer",
      pendingPermissions: [
        {
          id: "perm-1",
          provider: "codex",
          name: "bash",
          kind: "tool",
          title: "Allow git status",
        },
      ],
    });
    const durablePending = {
      workspaceId: "ws-1",
      requestId: "req-1",
      revision: 1,
      kind: "decision",
      status: "pending",
      title: "Choose storage schema",
      summary: "Option A vs B",
      evidence: [],
      createdAt: "2026-11-25T08:15:00.000Z",
    } as unknown as WorkspaceDurableItem;
    const durableDecided = {
      workspaceId: "ws-1",
      requestId: "req-0",
      revision: 2,
      kind: "acceptance",
      status: "decided",
      decision: "approve",
      title: "Initial design",
      summary: "Approved",
      evidence: [],
      createdAt: "2026-11-25T08:02:00.000Z",
      decidedAt: "2026-11-25T08:05:00.000Z",
    } as unknown as WorkspaceDurableItem;

    const report1 = makeSubagentReportItem({
      id: "item-10",
      senderId: "sub-1",
      senderTitle: "Researcher",
      seq: 10,
      text: "# Summary\nCompleted codebase scan.",
    });
    const report2 = makeSubagentReportItem({
      id: "item-12",
      senderId: "sub-1",
      senderTitle: "Researcher",
      seq: 12,
      text: "Blocked on schema ambiguity",
      reportStatus: "blocked",
    });

    const readStore = createTopicInboxReadStore(makeMemoryStorage());
    readStore.getState().markItemRead("scope-1", "msg:item-10");

    const projection = selectTeamDirectoryMessages({
      workspaceId: "ws-1",
      mainAgentId: "main",
      agents: new Map([
        [main.id, main],
        [subPerm.id, subPerm],
      ]),
      mainStreamTail: [report1, report2],
      durableItems: [durablePending, durableDecided],
      readScope: readStore.getState().scopes["scope-1"],
      fallbackAgentTitle: "Agent",
    });

    expect(projection.hasPendingInboxToFlush).toBe(true);
    // While pendingSubagentInbox has queued items, Main Control is still mid-dispatch so main_conclusion is suppressed
    expect(projection.unread.map((item) => item.kind)).toEqual([
      "durable_item",
      "permission",
      "subagent_report",
      "pending_inbox",
    ]);
    expect(projection.unread[2]?.jumpTarget).toEqual({
      agentId: "main",
      itemId: "item-12",
      messageId: "item-12",
      epoch: "ep-1",
      seq: 12,
    });
    // Read: item-10 (marked read) and decided durable item
    expect(projection.read.map((item) => item.id)).toContain("msg:item-10");
    expect(projection.read.map((item) => item.id)).toContain("durable:req-0:2");

    // Once pendingSubagentInbox is drained, Main Control's own unread conclusion surfaces at rank 3
    const mainSettled = { ...main, pendingSubagentInbox: undefined };
    const settledProjection = selectTeamDirectoryMessages({
      workspaceId: "ws-1",
      mainAgentId: "main",
      agents: new Map([
        [mainSettled.id, mainSettled],
        [subPerm.id, subPerm],
      ]),
      mainStreamTail: [report1, report2],
      durableItems: [durablePending, durableDecided],
      readScope: readStore.getState().scopes["scope-1"],
      fallbackAgentTitle: "Agent",
    });
    expect(settledProjection.unread.map((item) => item.kind)).toEqual([
      "durable_item",
      "permission",
      "subagent_report",
      "main_conclusion",
    ]);

    // Mark all read moves timeline reports & main conclusion into read while keeping live pending permission & pending durable item unread
    readStore.getState().markAllRead("scope-1", settledProjection.markAllSnapshot);
    const afterMarkAll = selectTeamDirectoryMessages({
      workspaceId: "ws-1",
      mainAgentId: "main",
      agents: new Map([
        [mainSettled.id, mainSettled],
        [subPerm.id, subPerm],
      ]),
      mainStreamTail: [report1, report2],
      durableItems: [durablePending, durableDecided],
      readScope: readStore.getState().scopes["scope-1"],
      fallbackAgentTitle: "Agent",
    });
    expect(afterMarkAll.unread.map((item) => item.kind)).toEqual(["durable_item", "permission"]);
    expect(afterMarkAll.read.map((item) => item.id)).toContain("msg:item-12");
    expect(afterMarkAll.read.some((item) => item.kind === "main_conclusion")).toBe(true);
  });

  it("does not attach a previous turn's assistant message when the latest turn has no assistant output, and resets maxSeq across epochs", () => {
    const mainErrored = makeAgent("main", {
      title: "Main Session",
      labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
      status: "error",
      lastError: "Provider quota exceeded",
      lastUserMessageAt: new Date("2026-11-25T08:30:00.000Z"),
      requiresAttention: true,
      attentionReason: "error",
      attentionTimestamp: new Date("2026-11-25T08:31:00.000Z"),
    });
    const oldAssistant: StreamItem = {
      kind: "assistant_message",
      id: "old-asst",
      text: "Previous turn conclusion that must not leak",
      timestamp: new Date("2026-11-25T08:05:00.000Z"),
      timelineCursor: { epoch: "ep-1", seq: 500 },
    } as unknown as StreamItem;
    const latestUserPrompt: StreamItem = {
      kind: "user_message",
      id: "user-latest",
      text: "Run new task",
      timestamp: new Date("2026-11-25T08:30:00.000Z"),
      timelineCursor: { epoch: "ep-1", seq: 501 },
    } as unknown as StreamItem;
    const epoch1Report = {
      ...makeSubagentReportItem({
        id: "rep-ep1",
        senderId: "sub-1",
        senderTitle: "Sub",
        seq: 500,
        text: "Old epoch report",
      }),
      timelineCursor: { epoch: "ep-1", seq: 500 },
    } as StreamItem;
    const epoch2Report = {
      ...makeSubagentReportItem({
        id: "rep-ep2",
        senderId: "sub-1",
        senderTitle: "Sub",
        seq: 3,
        text: "New epoch report",
      }),
      timelineCursor: { epoch: "ep-2", seq: 3 },
    } as StreamItem;

    const projection = selectTeamDirectoryMessages({
      workspaceId: "ws-1",
      mainAgentId: "main",
      agents: new Map([[mainErrored.id, mainErrored]]),
      mainStreamTail: [oldAssistant, epoch1Report, latestUserPrompt, epoch2Report],
      readScope: undefined,
      fallbackAgentTitle: "Agent",
    });

    const conclusion = projection.unread.find((item) => item.kind === "main_conclusion");
    expect(conclusion?.preview).toBe("Provider quota exceeded");
    expect(conclusion?.jumpTarget).toEqual({
      agentId: "main",
      itemId: null,
      messageId: null,
      epoch: null,
      seq: null,
    });
    expect(projection.markAllSnapshot.epoch).toBe("ep-2");
    expect(projection.markAllSnapshot.maxSeq).toBe(3);
  });

  it("retains read main conclusion across server attention clear while unhydrated, and keeps it read when timeline hydrates later", () => {
    const readStore = createTopicInboxReadStore(makeMemoryStorage());
    const mainUnreadCold = makeAgent("main", {
      title: "Main Session",
      labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: new Date("2026-11-25T09:10:00.000Z"),
    });

    const coldProjection = selectTeamDirectoryMessages({
      workspaceId: "ws-1",
      mainAgentId: "main",
      agents: new Map([[mainUnreadCold.id, mainUnreadCold]]),
      mainStreamTail: [],
      readScope: readStore.getState().scopes["scope-cold"],
      fallbackAgentTitle: "Agent",
    });
    const coldConclusion = coldProjection.unread[0]!;
    expect(coldConclusion.kind).toBe("main_conclusion");

    // Mark single item read while timeline is still cold
    readStore
      .getState()
      .markItemRead("scope-cold", coldConclusion.id, coldConclusion.mainConclusionSnapshot);

    // 1) If server clears requiresAttention before timeline hydrates, retained snapshot stays in read
    const mainAttentionCleared = { ...mainUnreadCold, requiresAttention: false };
    const clearedWhileCold = selectTeamDirectoryMessages({
      workspaceId: "ws-1",
      mainAgentId: "main",
      agents: new Map([[mainAttentionCleared.id, mainAttentionCleared]]),
      mainStreamTail: [],
      readScope: readStore.getState().scopes["scope-cold"],
      fallbackAgentTitle: "Agent",
    });
    expect(clearedWhileCold.unread).toHaveLength(0);
    expect(clearedWhileCold.read.some((item) => item.kind === "main_conclusion")).toBe(true);

    // 2) Even if clearWorkspaceAttention failed (requiresAttention still true) and timeline hydrates later, it stays read
    const hydratedAssistant: StreamItem = {
      kind: "assistant_message",
      id: "asst-hydrated",
      turnId: "turn-9",
      text: "Hydrated conclusion body",
      timestamp: new Date("2026-11-25T09:09:58.000Z"),
      timelineCursor: { epoch: "ep-1", seq: 42 },
    } as unknown as StreamItem;
    const afterHydrate = selectTeamDirectoryMessages({
      workspaceId: "ws-1",
      mainAgentId: "main",
      agents: new Map([[mainUnreadCold.id, mainUnreadCold]]),
      mainStreamTail: [hydratedAssistant],
      readScope: readStore.getState().scopes["scope-cold"],
      fallbackAgentTitle: "Agent",
    });
    expect(afterHydrate.unread).toHaveLength(0);
    expect(afterHydrate.read[0]?.preview).toBe("Hydrated conclusion body");

    // 3) Non-human-triggered subsequent turn (turnId changed, no assistant output) must not borrow previous turn's assistant message
    const agentTriggeredTurnError = makeAgent("main", {
      title: "Main Session",
      labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
      status: "error",
      lastError: "Subagent callback turn failed",
      requiresAttention: true,
      attentionReason: "error",
      attentionTimestamp: new Date("2026-11-25T09:20:00.000Z"),
    });
    const nextTurnTrigger = {
      ...makeSubagentReportItem({
        id: "sub-trigger",
        senderId: "sub-1",
        senderTitle: "Worker",
        seq: 43,
        text: "Done",
      }),
      turnId: "turn-10",
    } as StreamItem;
    const nextTurnProjection = selectTeamDirectoryMessages({
      workspaceId: "ws-1",
      mainAgentId: "main",
      agents: new Map([[agentTriggeredTurnError.id, agentTriggeredTurnError]]),
      mainStreamTail: [hydratedAssistant, nextTurnTrigger],
      readScope: readStore.getState().scopes["scope-cold"],
      fallbackAgentTitle: "Agent",
    });
    const newConclusion = nextTurnProjection.unread.find((item) => item.kind === "main_conclusion");
    expect(newConclusion?.preview).toBe("Subagent callback turn failed");
    expect(newConclusion?.jumpTarget?.itemId).toBeNull();

    // 4) Even before nextTurnTrigger lands in mainStreamTail, an auto-turn error arriving ahead of timeline sync stays unread with lastError preview
    const unhydratedAutoErrorProjection = selectTeamDirectoryMessages({
      workspaceId: "ws-1",
      mainAgentId: "main",
      agents: new Map([[agentTriggeredTurnError.id, agentTriggeredTurnError]]),
      mainStreamTail: [hydratedAssistant],
      readScope: readStore.getState().scopes["scope-cold"],
      fallbackAgentTitle: "Agent",
    });
    const earlyAutoError = unhydratedAutoErrorProjection.unread.find(
      (item) => item.kind === "main_conclusion",
    );
    expect(earlyAutoError?.preview).toBe("Subagent callback turn failed");
    expect(earlyAutoError?.jumpTarget?.itemId).toBeNull();

    // 5) Retained read conclusion preserves jump coordinates when timeline window later evicts the assistant message
    const hydratedUnreadProjection = selectTeamDirectoryMessages({
      workspaceId: "ws-1",
      mainAgentId: "main",
      agents: new Map([[mainUnreadCold.id, mainUnreadCold]]),
      mainStreamTail: [hydratedAssistant],
      readScope: undefined,
      fallbackAgentTitle: "Agent",
    });
    const hydratedUnread = hydratedUnreadProjection.unread[0]!;
    readStore
      .getState()
      .markItemRead("scope-jump", hydratedUnread.id, hydratedUnread.mainConclusionSnapshot);
    const evictedWindowProjection = selectTeamDirectoryMessages({
      workspaceId: "ws-1",
      mainAgentId: "main",
      agents: new Map([[mainAttentionCleared.id, mainAttentionCleared]]),
      mainStreamTail: [],
      readScope: readStore.getState().scopes["scope-jump"],
      fallbackAgentTitle: "Agent",
    });
    expect(evictedWindowProjection.read[0]?.jumpTarget).toEqual({
      agentId: "main",
      itemId: "asst-hydrated",
      messageId: "asst-hydrated",
      epoch: "ep-1",
      seq: 42,
    });

    // 6) A subsequent settled error turn cleared externally must NOT inherit the previous turn's retained jumpTarget
    const externallyClearedError = { ...agentTriggeredTurnError, requiresAttention: false };
    const laterReadErrorProjection = selectTeamDirectoryMessages({
      workspaceId: "ws-1",
      mainAgentId: "main",
      agents: new Map([[externallyClearedError.id, externallyClearedError]]),
      mainStreamTail: [hydratedAssistant, nextTurnTrigger],
      readScope: readStore.getState().scopes["scope-jump"],
      fallbackAgentTitle: "Agent",
    });
    const laterReadConclusion = laterReadErrorProjection.read.find(
      (item) => item.kind === "main_conclusion",
    );
    expect(laterReadConclusion?.preview).toBe("Subagent callback turn failed");
    expect(laterReadConclusion?.jumpTarget?.itemId).toBeNull();
  });
});
