import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TopicBlockingPrompt, TopicUnit } from "./model";
import { TopicDecisionSlot } from "./topic-decision-slot";

vi.mock("@/constants/layout", async (original) => ({
  ...(await original<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const topic: TopicUnit = {
  topicKey: "task:decision",
  taskId: "decision",
  rootItemId: "root",
  rootPrompt: {
    id: "root",
    text: "Check release",
    timestampMs: 0,
    seq: null,
    epoch: null,
    item: null,
  },
  task: null,
  processSteps: [],
  replies: [],
  pendingInboxItems: [],
  linkedTodos: [],
  linkedDurableItems: [],
  linkedPermissions: [],
  fileConflicts: [],
  activeBlockingPrompt: null,
  unreadReplyCount: 0,
  firstUnreadReplyIndex: null,
  isMarkedUnread: false,
  hasUnread: false,
  latestSeq: null,
  latestTimestampMs: 0,
  latestEpoch: null,
  lifecycleStatus: "blocked",
  retryCandidate: null,
};

function renderDecision(prompt: TopicBlockingPrompt) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TopicDecisionSlot agentKey="controller" topic={topic} prompt={prompt} supportsButlerV1 />
    </QueryClientProvider>,
  );
}

it("renders the blocking question as Markdown and leaves option text literal", async () => {
  const decision = renderDecision({
    kind: "task_blocking_question",
    taskId: "decision",
    question: "**Approve release?**",
    options: ["**Review again**"],
  });

  expect(await decision.findByText("Approve release?", { selector: "strong" })).toBeTruthy();
  expect(decision.getByTestId("topic-decision-option-0").textContent).toBe("**Review again**");
});

it.each([true, false])(
  "renders a decision summary as Markdown (in topic: %s)",
  async (canDecideInTopic) => {
    const decision = renderDecision({
      kind: "durable_item",
      canDecideInTopic,
      item: {
        status: "pending",
        workspaceId: "workspace",
        requestId: "request",
        sourceAgentId: "controller",
        sourceTurnId: "turn",
        kind: "decision",
        title: "**Release review**",
        summary: "**Two changes need review.**",
        evidence: [],
        revision: 1,
        createdAt: "2026-11-26T00:00:00.000Z",
      },
    });

    expect(
      await decision.findByText("Two changes need review.", { selector: "strong" }),
    ).toBeTruthy();
    expect(decision.getByText("**Release review**")).toBeTruthy();
  },
);
