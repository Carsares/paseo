import {
  getOpenAgentTabLabel,
  PARENT_AGENT_ID_LABEL,
  WORKSPACE_ROLE_LABEL,
  WORKSPACE_MAIN_ROLE,
} from "@getpaseo/protocol/agent-labels";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createPersistedWorkspaceRecord } from "../workspace-registry.js";
import { AgentManager } from "./agent-manager.js";
import { formatAgentMessage } from "./agent-messages/envelope.js";
import type { AgentStreamEvent, AgentTimelineItem } from "./agent-sdk-types.js";
import { AgentStorage, type StoredAgentRecord } from "./agent-storage.js";
import { summarizeWorkspaceAgents } from "./workspace-agents-summary.js";

test("summarizes only the selected workspace and releases successful and failed cold readers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workspace-summary-"));
  const logger = pino({ level: "silent" });
  const agentStorage = new AgentStorage(join(cwd, "agents"), logger);
  const createdAt = "2026-01-01T00:00:00.000Z";
  const archivedAt = "2026-01-04T00:00:00.000Z";
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "wks_1234567890abcdef",
    projectId: "prj_1234567890abcdef",
    cwd,
    kind: "directory",
    displayName: "Summary workspace",
    createdAt,
    updatedAt: createdAt,
  });
  const workspaceId = workspace.workspaceId;
  const base: Omit<StoredAgentRecord, "id"> = {
    provider: "codex",
    cwd,
    workspaceId,
    labels: {},
    metadata: {},
    createdAt,
    updatedAt: createdAt,
    lastStatus: "closed",
  };
  const items: AgentTimelineItem[] = [
    { type: "user_message", text: "  Add coverage  " },
    { type: "assistant_message", text: "Added coverage" },
    { type: "assistant_message", text: "  " },
    { type: "todo", items: [{ text: "Old task", completed: false }] },
    { type: "todo", items: [{ text: "Run tests", completed: true }] },
    {
      type: "tool_call",
      name: "Edit",
      callId: "edit",
      status: "completed",
      error: null,
      detail: { type: "edit", filePath: "src/example.ts" },
    },
    {
      type: "tool_call",
      name: "Write",
      callId: "write",
      status: "completed",
      error: null,
      detail: { type: "write", filePath: "src/example.ts" },
    },
    {
      type: "tool_call",
      name: "Read",
      callId: "read",
      status: "completed",
      error: null,
      detail: { type: "read", filePath: "src/untouched.ts" },
    },
    {
      type: "tool_call",
      name: "Write",
      callId: "failed",
      status: "failed",
      error: "denied",
      detail: { type: "write", filePath: "src/denied.ts" },
    },
  ];
  let createdSessions = 0;
  const resumed: Array<[string, string | undefined]> = [];
  const closed: string[] = [];
  const agentClient = createTestAgentClient("codex", {
    beforeCreateSession: async () => {
      createdSessions++;
    },
  });
  const resume = agentClient.resumeSession.bind(agentClient);
  agentClient.resumeSession = async (handle, config, launchContext, options) => {
    resumed.push([handle.sessionId, options?.purpose]);
    const reader = await resume(handle, config, launchContext, options);
    const close = reader.close.bind(reader);
    reader.close = async () => {
      closed.push(handle.sessionId);
      return close();
    };
    reader.streamHistory = async function* (): AsyncGenerator<AgentStreamEvent> {
      if (handle.sessionId === "unsupported") throw new Error("history unavailable");
      for (const item of items) yield { type: "timeline", provider: "codex", item };
    };
    return reader;
  };
  const agentManager = new AgentManager({
    clients: { codex: agentClient },
    registry: agentStorage,
    logger,
  });
  try {
    const main = await agentManager.createSilentWorkspaceMainAgent({
      workspaceId,
      config: { provider: "codex", cwd, model: "default", modeId: "full-access" },
    });
    expect(createdSessions).toBe(0);
    expect(main).toMatchObject({
      lastStatus: "closed",
      lastModeId: "read-only",
      labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
    });
    await expect(
      agentManager.createSilentWorkspaceMainAgent({
        workspaceId,
        config: { provider: "codex", cwd },
      }),
    ).rejects.toThrow("Workspace already has a Main Control agent.");
    const live = await agentManager.createAgent({ provider: "codex", cwd }, undefined, {
      workspaceId,
      labels: {
        [PARENT_AGENT_ID_LABEL]: main.id,
        [getOpenAgentTabLabel("desktop")]: "true",
      },
    });
    for (const [id, source, text] of [
      [
        "notice",
        { kind: "agent-notification", agentId: main.id, event: "permission-required" },
        "Permission report",
      ],
      [
        "completion",
        { kind: "agent-notification", agentId: main.id, event: "finished" },
        "Completion report",
      ],
      ["delegate", { kind: "agent-message", agentId: main.id }, "Implement the delegated task"],
    ] as const) {
      for await (const _event of agentManager.streamAgent(
        live.id,
        formatAgentMessage({ id, source, text }),
        { clientMessageId: id },
      )) {
        // Wait for the turn to commit its timeline.
      }
    }
    for await (const _event of agentManager.streamAgent(live.id, "Still working", {
      clientMessageId: "live-prompt",
    })) {
      // Wait for the live turn to commit its timeline.
    }
    await agentStorage.upsert({
      ...base,
      id: "archived",
      title: "Finished work",
      archivedAt,
      updatedAt: archivedAt,
      labels: { [PARENT_AGENT_ID_LABEL]: live.id },
      persistence: { provider: "codex", sessionId: "archived-history" },
    });
    await agentStorage.upsert({
      ...base,
      id: "closed",
      title: "Incomplete history",
      updatedAt: "2026-01-02T00:00:00.000Z",
      persistence: { provider: "codex", sessionId: "unsupported" },
    });
    await agentStorage.upsert({ ...base, id: "same-cwd", workspaceId: "other-workspace" });
    await agentStorage.upsert({ ...base, id: "background", background: true });
    await agentStorage.upsert({ ...base, id: "private", internal: true });
    const result = await summarizeWorkspaceAgents({
      workspaceId,
      agentManager,
      agentStorage,
      workspaceRegistry: { get: async (id) => (id === workspaceId ? workspace : null) },
      logger,
    });
    expect(
      result.entries.map(({ agentId, stateGroup, relationship }) => [
        agentId,
        stateGroup,
        relationship,
      ]),
    ).toEqual([
      [live.id, "active", "level1"],
      ["archived", "closed", "level2"],
      ["closed", "closed", "standalone"],
    ]);
    expect(result.entries[0]?.firstUserPrompt).toBe("Implement the delegated task");
    expect(result.entries[1]).toMatchObject({
      firstUserPrompt: "Add coverage",
      lastAssistantSummary: "Added coverage",
      todos: [{ text: "Run tests", completed: true }],
      touchedFiles: ["src/example.ts"],
    });
    expect(result.entries[2]).toMatchObject({ title: "Incomplete history", firstUserPrompt: null });
    expect(result.summaryText).toContain("## Active Sessions");
    expect(result.summaryText).toContain("## Closed Sessions");
    expect(result.attachment.text).toBe(
      "<workspace-agents-summary>\n" + result.summaryText + "\n</workspace-agents-summary>",
    );
    expect(resumed).toEqual([
      ["archived-history", "history"],
      ["unsupported", "history"],
    ]);
    expect(closed).toEqual(["archived-history", "unsupported"]);
    expect(agentManager.listAgents().map(({ id }) => id)).toEqual([live.id]);
    expect((await agentStorage.get("archived"))?.archivedAt).toBe(archivedAt);
    expect(createdSessions).toBe(1);
  } finally {
    await Promise.all(agentManager.listAgents().map(({ id }) => agentManager.closeAgent(id)));
    await rm(cwd, { recursive: true, force: true });
  }
});
