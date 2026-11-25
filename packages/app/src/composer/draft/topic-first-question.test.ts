import { describe, expect, test, vi } from "vitest";
import { WORKSPACE_ROLE_LABEL, WORKSPACE_MAIN_ROLE } from "@getpaseo/protocol/agent-labels";
import type { AgentSnapshotPayload, CreationSnapshot } from "@getpaseo/protocol/messages";
import {
  freezeTopicQuestion,
  runTopicQuestionAction,
  type TopicQuestionClient,
} from "./topic-first-question";

function fixture() {
  const question = freezeTopicQuestion({
    workspaceId: "topic-1",
    workspaceRole: "main",
    config: { provider: "codex", cwd: "/tmp/topic" },
    initialPrompt: "Review the evidence",
    clientMessageId: "device-first-question",
    images: [{ data: "YWJj", mimeType: "image/png" }],
    attachments: [{ type: "text", mimeType: "text/plain", text: "Evidence" }],
  });
  const main = {
    id: "main-other-device",
    workspaceId: question.request.workspaceId,
    labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
  } as unknown as AgentSnapshotPayload;
  const receipt: CreationSnapshot = {
    kind: "agent",
    idempotencyKey: question.request.idempotencyKey,
    agentId: question.request.agentId,
    workspaceId: question.request.workspaceId,
    revision: 2,
    phase: "failed",
    failedStage: "agent",
    outcomeUnknown: false,
    errorCode: "workspace_main_exists",
    error: "Main already exists",
  };
  const timeline = (agentId: string, clientMessageId?: string) =>
    ({
      agentId,
      error: null,
      entries: clientMessageId ? [{ item: { type: "user_message", clientMessageId } }] : [],
    }) as unknown as Awaited<ReturnType<TopicQuestionClient["fetchAgentTimeline"]>>;
  const client = {
    findWorkspace: vi.fn<TopicQuestionClient["findWorkspace"]>().mockResolvedValue({
      id: main.workspaceId,
      topic: { mainAgentId: main.id },
    } as unknown as Awaited<ReturnType<TopicQuestionClient["findWorkspace"]>>),
    fetchAgent: vi
      .fn<TopicQuestionClient["fetchAgent"]>()
      .mockResolvedValue({ agent: main, project: null }),
    getCreationSnapshot: vi
      .fn<TopicQuestionClient["getCreationSnapshot"]>()
      .mockResolvedValue(receipt),
    fetchAgentTimeline: vi
      .fn<TopicQuestionClient["fetchAgentTimeline"]>()
      .mockResolvedValue(timeline(main.id)),
    sendAgentMessage: vi.fn(),
    createAgent: vi.fn<TopicQuestionClient["createAgent"]>(),
  };
  const options = { assertAvailable: vi.fn() };
  return { question, client, main, receipt, options, timeline };
}

describe("topic first question recovery", () => {
  test("preserves the frozen question when the host cannot queue a human follow-up after a binding conflict", async () => {
    const { question, client, options } = fixture();
    const frozen = structuredClone(question);
    for (const action of ["check", "retry"] as const) {
      expect(await runTopicQuestionAction(client, question, action, options)).toEqual({
        stage: "queue-unavailable",
      });
    }
    expect(client.sendAgentMessage).not.toHaveBeenCalled();
    expect(client.createAgent).not.toHaveBeenCalled();
    expect(options.assertAvailable).not.toHaveBeenCalled();
    expect(question).toEqual(frozen);
  });

  test("reconciles a lost continuation response against the saved agent and message only", async () => {
    const { question, client, main, options, timeline } = fixture();
    const continued = { ...question, continuationAgentId: main.id };
    const frozen = structuredClone(continued);
    for (const action of ["check", "retry"] as const) {
      expect(await runTopicQuestionAction(client, continued, action, options)).toEqual({
        stage: "unconfirmed",
      });
    }
    client.fetchAgentTimeline.mockResolvedValueOnce(timeline(main.id, "different-id"));
    expect(await runTopicQuestionAction(client, continued, "check", options)).toEqual({
      stage: "unconfirmed",
    });
    client.fetchAgentTimeline.mockResolvedValueOnce(
      timeline(main.id, question.request.clientMessageId),
    );
    expect(await runTopicQuestionAction(client, continued, "check", options)).toEqual({
      stage: "confirmed",
      agent: main,
    });
    expect(client.fetchAgent).toHaveBeenLastCalledWith({ agentId: main.id });
    expect(client.getCreationSnapshot).not.toHaveBeenCalled();
    expect(client.findWorkspace).not.toHaveBeenCalled();
    expect(client.sendAgentMessage).not.toHaveBeenCalled();
    expect(client.createAgent).not.toHaveBeenCalled();
    expect(options.assertAvailable).not.toHaveBeenCalled();
    expect(continued).toEqual(frozen);
  });

  test("keeps a saved continuation if its receipt cannot be read", async () => {
    const { question, client, main, options } = fixture();
    client.fetchAgentTimeline.mockRejectedValueOnce(new Error("Connection lost"));
    const continued = { ...question, continuationAgentId: main.id };
    expect(await runTopicQuestionAction(client, continued, "retry", options)).toEqual({
      stage: "unconfirmed",
    });
    expect(client.sendAgentMessage).not.toHaveBeenCalled();
    expect(client.createAgent).not.toHaveBeenCalled();
  });

  test("keeps an unknown prompt and refuses create or continuation until its own message is recorded", async () => {
    const { question, client, main, receipt, options, timeline } = fixture();
    const ownAgent = { ...main, id: question.request.agentId };
    client.getCreationSnapshot.mockResolvedValue({
      ...receipt,
      agent: ownAgent,
      failedStage: "prompt",
      errorCode: undefined,
      outcomeUnknown: true,
    });
    client.fetchAgentTimeline.mockResolvedValue(timeline(ownAgent.id, "somebody-elses-message"));
    expect(await runTopicQuestionAction(client, question, "retry", options)).toEqual({
      stage: "unconfirmed",
    });
    expect(await runTopicQuestionAction(client, question, "check", options)).toEqual({
      stage: "unconfirmed",
    });
    client.fetchAgentTimeline.mockResolvedValue(
      timeline(ownAgent.id, question.request.clientMessageId),
    );
    expect(await runTopicQuestionAction(client, question, "check", options)).toEqual({
      stage: "confirmed",
      agent: ownAgent,
    });
    expect(client.createAgent).not.toHaveBeenCalled();
    expect(client.sendAgentMessage).not.toHaveBeenCalled();
    expect(options.assertAvailable).not.toHaveBeenCalled();
  });

  test.each(["rejected", "receipt-unavailable", "timeline-unavailable", "rebound"] as const)(
    "retries a bound first question only after confirming rejection (%s)",
    async (state) => {
      const { question, client, main, receipt, options, timeline } = fixture();
      const ownAgent = { ...main, id: question.request.agentId };
      const failed = {
        ...receipt,
        agent: ownAgent,
        failedStage: "prompt" as const,
        errorCode: undefined,
      };
      client.findWorkspace.mockResolvedValue({
        id: question.request.workspaceId,
        topic: { mainAgentId: state === "rebound" ? main.id : ownAgent.id },
      } as Awaited<ReturnType<TopicQuestionClient["findWorkspace"]>>);
      client.getCreationSnapshot.mockResolvedValue(failed);
      if (state === "receipt-unavailable") {
        client.getCreationSnapshot.mockRejectedValue(new Error("Receipt unavailable"));
      }
      client.fetchAgentTimeline.mockResolvedValue(timeline(ownAgent.id));
      if (state === "timeline-unavailable") {
        client.fetchAgentTimeline.mockRejectedValue(new Error("Timeline unavailable"));
      }
      client.createAgent.mockImplementation(async () => {
        client.getCreationSnapshot.mockResolvedValue({
          ...failed,
          phase: "completed",
          failedStage: undefined,
          initialPromptStarted: true,
          outcomeUnknown: undefined,
          error: null,
        });
        return ownAgent;
      });
      expect(
        await runTopicQuestionAction(client, question, "check", { ...options, update: failed }),
      ).toEqual({ stage: state === "rejected" ? "retry" : "unconfirmed" });
      expect(client.createAgent).not.toHaveBeenCalled();
      const result = await runTopicQuestionAction(client, question, "retry", {
        ...options,
        update: failed,
      });
      if (state === "rejected") {
        expect(result).toEqual({ stage: "confirmed", agent: ownAgent });
        expect(client.createAgent).toHaveBeenCalledExactlyOnceWith({
          ...question.request,
          onEvent: expect.any(Function),
        });
      } else {
        expect(result).toEqual({ stage: "unconfirmed" });
        expect(client.createAgent).not.toHaveBeenCalled();
      }
      expect(client.sendAgentMessage).not.toHaveBeenCalled();
    },
  );

  test("retries a known unbound failure using the identical saved create request", async () => {
    const { question, client, receipt, options } = fixture();
    client.findWorkspace.mockResolvedValue({
      id: question.request.workspaceId,
      hasActiveMainAgent: false,
      topic: { mainAgentId: null },
    } as unknown as Awaited<ReturnType<TopicQuestionClient["findWorkspace"]>>);
    client.fetchAgent.mockResolvedValue(null);
    client.getCreationSnapshot.mockResolvedValue({ ...receipt, errorCode: undefined });
    client.createAgent.mockRejectedValue(new Error("Connection lost"));
    await runTopicQuestionAction(client, question, "retry", options);
    expect(client.createAgent).toHaveBeenCalledExactlyOnceWith({
      ...question.request,
      onEvent: expect.any(Function),
    });
    expect(client.sendAgentMessage).not.toHaveBeenCalled();
  });

  test.each(["missing", "read-failed"] as const)(
    "only retries an unbound saved first question after checking the creation receipt (%s)",
    async (state) => {
      const { question, client, options } = fixture();
      client.findWorkspace.mockResolvedValue({
        id: question.request.workspaceId,
        hasActiveMainAgent: false,
        topic: { mainAgentId: null },
      } as unknown as Awaited<ReturnType<TopicQuestionClient["findWorkspace"]>>);
      client.fetchAgent.mockResolvedValue(null);
      if (state === "missing") client.getCreationSnapshot.mockResolvedValue(null);
      else client.getCreationSnapshot.mockRejectedValue(new Error("Receipt unavailable"));
      expect(await runTopicQuestionAction(client, question, "check", options)).toEqual({
        stage: state === "missing" ? "retry" : "unconfirmed",
      });
      expect(client.createAgent).not.toHaveBeenCalled();
      await runTopicQuestionAction(client, question, "retry", options);
      if (state === "missing") {
        expect(client.createAgent).toHaveBeenCalledExactlyOnceWith({
          ...question.request,
          onEvent: expect.any(Function),
        });
      } else expect(client.createAgent).not.toHaveBeenCalled();
    },
  );
});
