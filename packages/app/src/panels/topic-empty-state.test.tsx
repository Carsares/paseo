/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { indexedDB } from "fake-indexeddb";
import { createElement } from "react";
import { afterAll, describe, expect, test, vi } from "vitest";
import {
  clearTopicQuestion,
  freezeTopicQuestion,
  readTopicQuestion,
  writeTopicQuestion,
} from "@/composer/draft/topic-first-question";
import { resolveTopicFirstQuestionDraftId } from "@/composer/draft/workspace-main-intent";
import { en } from "@/i18n/resources/en";
import { createWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { getUnboundTopicWorkspace, TopicQuestionResume } from "./topic-empty-state";

vi.stubGlobal("indexedDB", indexedDB);
afterAll(() => vi.unstubAllGlobals());

describe("unbound topic empty state", () => {
  const unbound = {
    topic: { revision: 1, summary: null, hideFromModel: false, mainAgentId: null },
  };

  test("requires explicit null on a topic descriptor", () => {
    expect(getUnboundTopicWorkspace(undefined, false)).toBeNull();
    expect(getUnboundTopicWorkspace({ topic: undefined }, false)).toBeNull();
    expect(getUnboundTopicWorkspace(unbound, false)).toBe(unbound);
    expect(
      getUnboundTopicWorkspace({ topic: { ...unbound.topic, mainAgentId: "main" } }, false),
    ).toBeNull();
  });

  test("suppresses a cached unbound descriptor after the live catalog binds a main session", () => {
    expect(getUnboundTopicWorkspace(unbound, true)).toBeNull();
  });
});

test("reopens the same saved first question after its tab closes in a workspace with a main tab", async () => {
  const serverId = "topic-recovery-host";
  const workspaceId = "bound-topic";
  const draftId = await resolveTopicFirstQuestionDraftId(serverId, workspaceId);
  const saved = {
    ...freezeTopicQuestion({
      workspaceId,
      workspaceRole: "main",
      config: { provider: "codex", cwd: "/tmp/topic" },
      initialPrompt: "Check the evidence",
      clientMessageId: "first-question",
      attachments: [{ type: "text", mimeType: "text/plain", text: "Evidence" }],
    }),
    continuationAgentId: "main",
  };
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  if (!workspaceKey) throw new Error("Missing workspace key");
  const layout = createWorkspaceLayoutStore().getState();
  const openDraft = (id: string) =>
    layout.openTab({ workspaceKey, target: { kind: "draft", draftId: id }, intent: "reveal" });
  layout.openTab({ workspaceKey, target: { kind: "agent", agentId: "main" }, intent: "reveal" });
  const tabId = openDraft(draftId);
  if (!tabId) throw new Error("Missing draft tab");
  const renderResume = () =>
    createElement(TopicQuestionResume, {
      enabled: true,
      serverId,
      workspaceId,
      openTargets: layout.getWorkspaceTabs(workspaceKey).map((tab) => tab.target),
      onOpen: openDraft,
    });
  await writeTopicQuestion(draftId, saved);
  const view = render(renderResume());
  try {
    expect(screen.queryByText(en.topicWorkbench.resumeQuestion)).toBeNull();
    layout.closeTab(workspaceKey, tabId);
    view.rerender(renderResume());
    fireEvent.click(await screen.findByText(en.topicWorkbench.resumeQuestion));
    view.rerender(renderResume());
    expect(screen.queryByText(en.topicWorkbench.resumeQuestion)).toBeNull();
    const targets = layout.getWorkspaceTabs(workspaceKey).map((tab) => tab.target);
    expect(targets).toContainEqual({ kind: "agent", agentId: "main" });
    expect(targets.filter((target) => target.kind === "draft")).toEqual([
      { kind: "draft", draftId },
    ]);
    expect(await readTopicQuestion(draftId)).toEqual(saved);
  } finally {
    view.unmount();
    await clearTopicQuestion(draftId);
  }
});
