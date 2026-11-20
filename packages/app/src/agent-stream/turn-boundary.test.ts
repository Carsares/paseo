import { describe, expect, it } from "vitest";
import { parentAddressLabels } from "@getpaseo/protocol/agent-labels";
import type { StreamItem } from "@/types/stream";
import {
  resolveAssistantTurnForkBoundary,
  resolveSelectionForkBoundary,
  resolveSubagentSpawnTarget,
  type SubagentSpawnAgentEntry,
} from "./turn-boundary";

function timestamp(seed: number): Date {
  return new Date(`2026-01-01T00:00:${seed.toString().padStart(2, "0")}.000Z`);
}

function userMessage(id: string, seed: number): Extract<StreamItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp: timestamp(seed),
  };
}

function assistantMessage(
  id: string,
  seed: number,
  messageId?: string,
): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: timestamp(seed),
    ...(messageId ? { messageId } : {}),
  };
}

describe("resolveAssistantTurnForkBoundary", () => {
  it("forks a failed assistant turn from its Paseo timeline cursor without a provider message id", () => {
    const failedTurn = {
      ...assistantMessage("assistant-error", 2),
      timelineCursor: { epoch: "timeline-1", seq: 42 },
    };

    expect(
      resolveAssistantTurnForkBoundary({
        items: [userMessage("user-1", 1), failedTurn],
        startIndex: 1,
        supportsTimelineCursor: true,
      }),
    ).toEqual({
      boundaryCursor: { epoch: "timeline-1", seq: 42 },
    });
  });

  it("includes the provider message id with a supported timeline cursor", () => {
    const selected = {
      ...assistantMessage("assistant-1", 2, "msg-assistant-1"),
      timelineCursor: { epoch: "timeline-1", seq: 42 },
    };

    expect(
      resolveAssistantTurnForkBoundary({
        items: [selected],
        startIndex: 0,
        supportsTimelineCursor: true,
      }),
    ).toEqual({
      boundaryCursor: { epoch: "timeline-1", seq: 42 },
      boundaryMessageId: "msg-assistant-1",
    });
  });

  it("falls back to the provider message id when timeline cursors are unsupported", () => {
    const selected = {
      ...assistantMessage("assistant-1", 2, "msg-assistant-1"),
      timelineCursor: { epoch: "timeline-1", seq: 42 },
    };

    expect(
      resolveAssistantTurnForkBoundary({
        items: [selected],
        startIndex: 0,
        supportsTimelineCursor: false,
      }),
    ).toEqual({ boundaryMessageId: "msg-assistant-1" });
  });

  it("does not borrow a provider message id from another assistant in the same turn", () => {
    const first = assistantMessage("assistant-1", 2, "msg-assistant-1");
    const selected = assistantMessage("assistant-2", 3);

    expect(
      resolveAssistantTurnForkBoundary({
        items: [userMessage("user-1", 1), first, selected],
        startIndex: 2,
        supportsTimelineCursor: false,
      }),
    ).toBeUndefined();
  });

  it("requires the selected item to be an assistant message", () => {
    expect(
      resolveAssistantTurnForkBoundary({
        items: [userMessage("user-1", 1), assistantMessage("assistant-1", 2, "msg-assistant-1")],
        startIndex: 0,
        supportsTimelineCursor: false,
      }),
    ).toBeUndefined();
  });

  it("does not offer an unavailable boundary", () => {
    expect(
      resolveAssistantTurnForkBoundary({
        items: [assistantMessage("assistant-1", 2)],
        startIndex: 0,
        supportsTimelineCursor: false,
      }),
    ).toBeUndefined();
  });
});

describe("resolveSubagentSpawnTarget", () => {
  const serverId = "host-1";
  const features = { agentForkContext: true, agentHierarchyControl: true };
  const agents = new Map<string, SubagentSpawnAgentEntry>([
    ["main", {}],
    ["level-1", { parentAgentId: " main " }],
    [
      "level-2",
      {
        parentAgentId: "main",
        labels: parentAddressLabels({ serverId, agentId: "level-1" }),
      },
    ],
    [
      "remote-level-2",
      {
        parentAgentId: "unloaded-remote-parent",
        labels: { "paseo.remote-hierarchy-depth": "2" },
      },
    ],
    ["child-of-remote-level-2", { parentAgentId: "remote-level-2" }],
    ["remote-depth-only", { labels: { "paseo.remote-hierarchy-depth": "2" } }],
    ["child-of-remote-depth-only", { parentAgentId: "remote-depth-only" }],
    ["archived", { archivedAt: timestamp(1) }],
    ["child-of-archived", { parentAgentId: "archived" }],
    ["child-of-missing", { parentAgentId: "missing" }],
    ["child-of-level-2", { parentAgentId: "level-2" }],
    ["cross-host", { labels: parentAddressLabels({ serverId: "host-2", agentId: "main" }) }],
    ["remote-level-1", { labels: parentAddressLabels({ serverId: "host-2", agentId: "level-1" }) }],
    ["child-of-remote-level-1", { parentAgentId: "remote-level-1" }],
  ]);

  const resolveTarget = (agentId: string, hostFeatures: Partial<typeof features> = features) =>
    resolveSubagentSpawnTarget({
      agentId,
      serverId,
      features: hostFeatures,
      getAgent: (id) => agents.get(id),
    });

  it("spawns a child from the main agent and siblings from both subagent levels", () => {
    expect(resolveTarget("main")).toEqual({ mode: "child", parentAgentId: "main" });
    expect(resolveTarget("level-1")).toEqual({ mode: "sibling", parentAgentId: "main" });
    expect(resolveTarget("level-2")).toEqual({ mode: "sibling", parentAgentId: "level-1" });
  });

  it("allows a sibling under a level-1 parent with an ancestor on another host", () => {
    expect(resolveTarget("child-of-remote-level-1")).toEqual({
      mode: "sibling",
      parentAgentId: "remote-level-1",
    });
  });

  it.each([
    "missing-source",
    "archived",
    "child-of-archived",
    "child-of-missing",
    "child-of-level-2",
    "child-of-remote-level-2",
    "child-of-remote-depth-only",
    "cross-host",
  ])("does not offer a fork from %s", (agentId) => {
    expect(resolveTarget(agentId)).toBeNull();
  });

  it.each(["agentHierarchyControl", "agentForkContext"] as const)(
    "requires %s support from the host",
    (feature) => {
      const { [feature]: _missing, ...hostFeatures } = features;
      expect(resolveTarget("main", hostFeatures)).toBeNull();
      expect(resolveTarget("main", { ...features, [feature]: false })).toBeNull();
    },
  );
});

describe("resolveSelectionForkBoundary", () => {
  const historyMessage = assistantMessage("history-row", 2, "history-message");
  const liveMessage = assistantMessage("live-row", 3, "live-message");
  const historyCursor = { epoch: "timeline-1", seq: 10 };
  const liveCursor = { epoch: "timeline-1", seq: 11 };
  const input = {
    historyItemById: new Map<string, { item: StreamItem }>([
      [historyMessage.id, { item: { ...historyMessage, timelineCursor: historyCursor } }],
      ["user-row", { item: userMessage("user-row", 1) }],
    ]),
    liveHeadItemById: new Map([
      [liveMessage.id, { item: { ...liveMessage, timelineCursor: liveCursor } }],
    ]),
    supportsTimelineCursor: true,
    isTurnActive: false,
  };

  it("uses the selected historical message even during an active turn", () => {
    expect(
      resolveSelectionForkBoundary({
        ...input,
        messageRowId: historyMessage.id,
        isTurnActive: true,
      }),
    ).toEqual({
      boundaryCursor: historyCursor,
      boundaryMessageId: "history-message",
    });
  });

  it("uses a live head message as a boundary after its turn completes", () => {
    expect(resolveSelectionForkBoundary({ ...input, messageRowId: liveMessage.id })).toEqual({
      boundaryCursor: liveCursor,
      boundaryMessageId: "live-message",
    });
  });

  it("uses the provider message ID for a historical selection on a host without cursor support", () => {
    expect(
      resolveSelectionForkBoundary({
        ...input,
        messageRowId: historyMessage.id,
        supportsTimelineCursor: false,
      }),
    ).toEqual({ boundaryMessageId: "history-message" });
  });

  it("leaves an active live head message unbounded to include its latest content", () => {
    expect(
      resolveSelectionForkBoundary({ ...input, messageRowId: liveMessage.id, isTurnActive: true }),
    ).toBeUndefined();
  });

  it("rejects the original live reply if it is withdrawn before the menu action runs", () => {
    const messageRowId = liveMessage.id;
    expect(
      resolveSelectionForkBoundary({ ...input, messageRowId, isTurnActive: true }),
    ).toBeUndefined();
    const nextReply = assistantMessage("new-live-row", 4, "new-live-message");
    expect(
      resolveSelectionForkBoundary({
        ...input,
        messageRowId,
        isTurnActive: true,
        liveHeadItemById: new Map([
          [nextReply.id, { item: nextReply, timelineCursor: liveCursor }],
        ]),
      }),
    ).toBeNull();
  });

  it("rejects a historical row without a safe provider message or timeline boundary", () => {
    expect(
      resolveSelectionForkBoundary({
        ...input,
        messageRowId: historyMessage.id,
        historyItemById: new Map([
          [historyMessage.id, { item: { ...historyMessage, messageId: undefined } }],
        ]),
      }),
    ).toBeNull();
  });

  it.each(["missing-row", "user-row", "", null, undefined])(
    "rejects a selection whose original assistant row cannot be resolved (%s)",
    (messageRowId) => {
      expect(
        resolveSelectionForkBoundary({ ...input, messageRowId, isTurnActive: true }),
      ).toBeNull();
    },
  );
});
