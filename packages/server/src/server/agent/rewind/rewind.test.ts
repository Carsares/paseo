import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import type { AgentClient, AgentSession, AgentSessionConfig } from "../agent-sdk-types.js";
import { FakeRewindSession, REWIND_TEST_CAPABILITIES } from "./test-rewind-session.js";

class FakeRewindClient implements AgentClient {
  readonly provider = "claude";
  readonly capabilities = REWIND_TEST_CAPABILITIES;

  constructor(readonly session: FakeRewindSession) {}

  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    return this.session;
  }

  async resumeSession(): Promise<AgentSession> {
    return this.session;
  }

  async fetchCatalog(_options: FetchCatalogOptions) {
    return { models: [], modes: [] };
  }

  async isAvailable() {
    return true;
  }
}

class RewindHistoryGate {
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  release(): void {
    this.releaseGate?.();
    this.releaseGate = null;
    this.gate = null;
  }

  async wait(): Promise<void> {
    await this.gate;
  }
}

async function createRewindHarness(options: { historyGate?: RewindHistoryGate } = {}) {
  const session = new FakeRewindSession(options.historyGate?.wait.bind(options.historyGate));
  const manager = new AgentManager({
    clients: { claude: new FakeRewindClient(session) },
    logger: createTestLogger(),
    idFactory: () => "00000000-0000-4000-8000-000000000901",
  });
  const agent = await manager.createAgent(
    {
      provider: "claude",
      cwd: process.cwd(),
    },
    undefined,
    { workspaceId: undefined },
  );
  return { manager, session, agentId: agent.id };
}

describe("AgentManager rewind", () => {
  test("rewinds the conversation and rehydrates the timeline", async () => {
    const { manager, session, agentId } = await createRewindHarness();

    await manager.rewind(agentId, "message-1", "conversation");

    expect(session.recordedRewinds).toEqual([{ mode: "conversation", messageId: "message-1" }]);
    expect(session.historyReadCount).toBe(1);
    expect(manager.fetchTimeline(agentId, { limit: 0 }).rows.map((row) => row.item)).toEqual([
      { type: "user_message", text: "before", messageId: "message-1" },
    ]);
  });

  test("replaces the canonical epoch without replaying reconstructed parent rows", async () => {
    const { manager, session, agentId } = await createRewindHarness();
    const history = Array.from({ length: 250 }, (_, index) => ({
      type: "assistant_message" as const,
      text: `rewound ${index}`,
    }));
    session.history = history;
    const epochBefore = manager.fetchTimeline(agentId, { limit: 0 }).epoch;
    const events: string[] = [];
    const unsubscribe = manager.subscribe((event) => events.push(event.type), {
      replayState: false,
    });

    await manager.rewind(agentId, "message-1", "conversation");
    unsubscribe();

    const replacement = manager.fetchTimeline(agentId, { limit: 0 });
    expect(replacement.epoch).not.toBe(epochBefore);
    expect(replacement.rows).toEqual([
      expect.objectContaining({
        seq: 250,
        seqStart: 1,
        seqEnd: 250,
        sourceSeqRanges: [{ startSeq: 1, endSeq: 250 }],
        item: {
          type: "assistant_message",
          text: history.map((item) => item.text).join(""),
        },
      }),
    ]);
    expect(events.filter((type) => type === "agent_stream")).toEqual([]);
  });

  test.each(["files", "both"] as const)(
    "rejects legacy %s rewind before invoking the provider",
    async (mode) => {
      const { manager, session, agentId } = await createRewindHarness();

      await expect(manager.rewind(agentId, "message-1", mode)).rejects.toThrow(
        "File rewind requires the checkpoint restore operation",
      );

      expect(session.recordedRewinds).toEqual([]);
      expect(session.historyReadCount).toBe(0);
    },
  );

  test.each(["files", "both"] as const)(
    "rejects checkpoint %s rewind for an agent without a managed workspace",
    async (mode) => {
      const { manager, session, agentId } = await createRewindHarness();
      manager.configureRewindCheckpoints({
        paseoHome: process.cwd(),
        projects: { get: async () => null },
        workspaces: { get: async () => null, listActive: async () => [] },
      });

      await expect(
        manager.restoreRewindCheckpoint({
          agentId,
          messageId: "message-1",
          checkpointId: "00000000-0000-4000-8000-000000000903",
          mode,
        }),
      ).rejects.toThrow("This agent cannot restore files");

      expect(session.recordedRewinds).toEqual([]);
      expect(session.historyReadCount).toBe(0);
    },
  );

  test("aborts an in-flight turn before rewinding the conversation", async () => {
    const { manager, session, agentId } = await createRewindHarness();
    const run = manager.streamAgent(agentId, "keep working");
    await run.next();

    await manager.rewind(agentId, "message-1", "conversation");

    expect(session.aborted).toBe(true);
    expect(session.recordedRewinds).toEqual([{ mode: "conversation", messageId: "message-1" }]);
  });

  test("does not rewind the conversation when the in-flight turn rejects cancellation", async () => {
    class RejectingInterruptSession extends FakeRewindSession {
      override async interrupt(): Promise<void> {
        throw new Error("provider still owns the active turn");
      }
    }

    const session = new RejectingInterruptSession();
    const manager = new AgentManager({
      clients: { claude: new FakeRewindClient(session) },
      logger: createTestLogger(),
      idFactory: () => "00000000-0000-4000-8000-000000000902",
    });
    const agent = await manager.createAgent({ provider: "claude", cwd: process.cwd() }, undefined, {
      workspaceId: undefined,
    });
    const run = manager.streamAgent(agent.id, "keep working");
    await run.next();

    await expect(manager.rewind(agent.id, "message-1", "conversation")).rejects.toThrow(
      `Cannot rewind agent ${agent.id} because its active run cancellation was not acknowledged`,
    );
    expect(session.recordedRewinds).toEqual([]);
    expect(manager.getAgent(agent.id)).toMatchObject({
      lifecycle: "running",
      activeForegroundTurnId: "turn-1",
    });
  });

  test("blocks new prompts immediately and until the rehydrate epoch broadcasts", async () => {
    const historyGate = new RewindHistoryGate();
    historyGate.hold();
    const { manager, agentId } = await createRewindHarness({ historyGate });

    const rewind = manager.rewind(agentId, "message-1", "conversation");

    expect(() => manager.streamAgent(agentId, "too early")).toThrow(
      "Agent 00000000-0000-4000-8000-000000000901 already has an active run",
    );

    historyGate.release();
    await rewind;
  });
});
